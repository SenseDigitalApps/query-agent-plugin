import { afterEach, describe, expect, it } from "vitest";
import {
  createActivityGate,
  kindForTool,
  parseActivityMode,
  resolveActivityMode,
  sanitizeActivityDetail,
  sanitizeToolName,
  type ActivityCandidate,
  type QueryActivityMode,
} from "./activity-policy.js";

afterEach(() => {
  delete process.env.QUERY_AGENT_ACTIVITY_MODE;
});

const T0 = 1_000_000;

function gateFor(mode: QueryActivityMode, startedAt = T0) {
  return createActivityGate({ mode, startedAt });
}

/** Recoge solo lo que la persona llegaria a ver. */
function emit(
  gate: ReturnType<typeof gateFor>,
  candidate: ActivityCandidate,
  now: number,
) {
  const decision = gate.evaluate(candidate, now);
  return decision.emit ? decision.activity : undefined;
}

describe("modo de actividad", () => {
  it("acepta los modos conocidos y descarta cualquier otro", () => {
    expect(parseActivityMode("smart")).toBe("smart");
    expect(parseActivityMode(" VERBOSE ")).toBe("verbose");
    expect(parseActivityMode("debug-internal")).toBe("debug-internal");
    expect(parseActivityMode("ruidoso")).toBeUndefined();
    expect(parseActivityMode(undefined)).toBeUndefined();
  });

  it("usa smart por defecto y deja que la configuracion gane al entorno", () => {
    expect(resolveActivityMode(undefined)).toBe("smart");
    process.env.QUERY_AGENT_ACTIVITY_MODE = "verbose";
    expect(resolveActivityMode(undefined)).toBe("verbose");
    expect(resolveActivityMode("lite")).toBe("lite");
  });

  it("no se cae con una cuenta sin modo resuelto", () => {
    const gate = createActivityGate({
      mode: undefined as unknown as QueryActivityMode,
      startedAt: T0,
    });
    expect(gate.mode).toBe("smart");
    expect(emit(gate, { kind: "received" }, T0)).toMatchObject({ kind: "received" });
  });
});

describe("modo smart", () => {
  it("acusa recibo de inmediato, sin esperar al silencio inicial", () => {
    const gate = gateFor("smart");
    const ack = emit(gate, { kind: "received" }, T0);
    expect(ack).toMatchObject({
      kind: "received",
      label: "El agente recibió el mensaje",
      visibility: "public",
    });
  });

  it("calla la cronologia mientras el turno pueda resolverse rapido", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    expect(gate.evaluate({ kind: "searching" }, T0 + 1_500)).toMatchObject({
      emit: false,
      reason: "quiet_window",
    });
    expect(gate.evaluate({ kind: "tool_started" }, T0 + 3_900)).toMatchObject({
      emit: false,
      reason: "quiet_window",
    });
  });

  it("libera el paso retenido en cuanto el turno se pasa de lento", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    gate.evaluate({ kind: "searching" }, T0 + 2_000);
    expect(gate.takeHeld(T0 + 3_000)).toBeUndefined();
    expect(gate.takeHeld(T0 + 4_100)).toMatchObject({
      kind: "searching",
      label: "Consultando registros",
    });
    // Ya se entrego: no vuelve a salir el mismo paso.
    expect(gate.takeHeld(T0 + 9_000)).toBeUndefined();
  });

  it("retiene solo el paso mas reciente del silencio inicial", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    gate.evaluate({ kind: "routing" }, T0 + 500);
    gate.evaluate({ kind: "searching" }, T0 + 1_000);
    gate.evaluate({ kind: "validating" }, T0 + 2_000);
    expect(gate.takeHeld(T0 + 4_500)).toMatchObject({ kind: "validating" });
  });

  it("deja pasar un evento util una vez abierta la ventana", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    expect(emit(gate, { kind: "searching" }, T0 + 6_000)).toMatchObject({
      kind: "searching",
      stage: "search",
      progress: 35,
    });
  });
});

describe("throttle y dedupe", () => {
  it("no repite un estado equivalente", () => {
    const gate = gateFor("verbose");
    expect(emit(gate, { kind: "searching" }, T0)).toBeDefined();
    expect(gate.evaluate({ kind: "searching" }, T0 + 5_000)).toMatchObject({
      emit: false,
      reason: "duplicate",
    });
  });

  it("distingue dos pasos iguales con detalle distinto", () => {
    const gate = gateFor("verbose");
    emit(gate, { kind: "searching", detail: "clientes" }, T0);
    expect(emit(gate, { kind: "searching", detail: "facturas" }, T0 + 5_000)).toMatchObject({
      detail: "facturas",
    });
  });

  it("limita los pasos visibles seguidos", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    expect(emit(gate, { kind: "searching" }, T0 + 5_000)).toBeDefined();
    expect(gate.evaluate({ kind: "module_detected" }, T0 + 6_000)).toMatchObject({
      emit: false,
      reason: "throttled",
    });
    expect(emit(gate, { kind: "module_detected" }, T0 + 9_000)).toBeDefined();
  });

  it("deja pasar un cambio importante aunque el throttle este cerrado", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    emit(gate, { kind: "searching" }, T0 + 5_000);
    // Que el turno pase a esperar a la persona no puede llegar tarde.
    expect(emit(gate, { kind: "waiting_for_user" }, T0 + 5_500)).toMatchObject({
      kind: "waiting_for_user",
      label: "Requiere tu confirmación",
    });
  });

  it("el latido repite el ultimo estado sin contar como paso nuevo", () => {
    const gate = gateFor("smart");
    emit(gate, { kind: "received" }, T0);
    emit(gate, { kind: "searching" }, T0 + 5_000);
    const beat = emit(gate, { kind: "working", keepalive: true }, T0 + 25_000);
    expect(beat).toMatchObject({
      heartbeat: true,
      label: "Consultando registros",
      stage: "heartbeat",
    });
    // El latido no consumio el hueco del throttle del siguiente paso real.
    expect(emit(gate, { kind: "finalizing" }, T0 + 25_100)).toBeDefined();
  });
});

describe("modos off, lite y verbose", () => {
  it("off no muestra nada pero conserva el pulso del turno", () => {
    const gate = gateFor("off");
    expect(gate.evaluate({ kind: "received" }, T0)).toMatchObject({
      emit: false,
      reason: "mode_off",
    });
    expect(gate.evaluate({ kind: "searching" }, T0 + 9_000)).toMatchObject({
      emit: false,
      reason: "mode_off",
    });
    // El latido sigue saliendo, marcado para que nadie lo pinte.
    expect(emit(gate, { kind: "working", keepalive: true }, T0 + 20_000)).toMatchObject({
      heartbeat: true,
      visibility: "internal",
    });
  });

  it("lite se queda en el acuse", () => {
    const gate = gateFor("lite");
    expect(emit(gate, { kind: "received" }, T0)).toBeDefined();
    expect(gate.evaluate({ kind: "searching" }, T0 + 9_000)).toMatchObject({
      emit: false,
      reason: "mode_lite",
    });
  });

  it("verbose no espera al silencio inicial", () => {
    const gate = gateFor("verbose");
    emit(gate, { kind: "received" }, T0);
    expect(emit(gate, { kind: "searching" }, T0 + 1_600)).toBeDefined();
  });

  it("guarda los pasos de mantenimiento para quien mira por dentro", () => {
    const publico = gateFor("smart");
    expect(publico.evaluate({ kind: "context" }, T0 + 9_000)).toMatchObject({
      emit: false,
      reason: "not_visible",
    });
    const interno = gateFor("verbose");
    expect(emit(interno, { kind: "context" }, T0 + 9_000)).toMatchObject({
      kind: "context",
      visibility: "admin",
    });
  });
});

describe("saneado del texto visible", () => {
  it("bloquea credenciales, secretos y cabeceras de autorizacion", () => {
    for (const sensitive of [
      "Authorization: Bearer abc123def",
      "token=sk-live-9f8a7b6c5d4e",
      "api_key aVeryLongValue",
      "password: correcthorse",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0",
      "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "QUERY_OPENCLAW_TOKEN=abc",
    ]) {
      expect(sanitizeActivityDetail(sensitive)).toBeUndefined();
    }
  });

  it("bloquea rutas internas del servidor y de la maquina local", () => {
    expect(sanitizeActivityDetail("leyendo /home/query/.openclaw/state.json")).toBeUndefined();
    expect(sanitizeActivityDetail("abriendo C:\\Users\\julia\\secreto.txt")).toBeUndefined();
    expect(sanitizeActivityDetail("/etc/passwd")).toBeUndefined();
    expect(sanitizeActivityDetail("file:///var/data")).toBeUndefined();
  });

  it("bloquea trazas y prompts internos", () => {
    expect(
      sanitizeActivityDetail('Error\n    at handler (server.js:12)'),
    ).toBeUndefined();
    expect(
      sanitizeActivityDetail("Traceback (most recent call last): ..."),
    ).toBeUndefined();
    expect(sanitizeActivityDetail("segun el system prompt debo...")).toBeUndefined();
    expect(sanitizeActivityDetail("<thinking>el usuario quiere</thinking>")).toBeUndefined();
  });

  it("descarta un payload crudo largo aunque no tenga nada sensible", () => {
    const payload = JSON.stringify({ results: Array.from({ length: 40 }, (_, i) => i) });
    expect(payload.length).toBeGreaterThan(80);
    expect(sanitizeActivityDetail(payload)).toBeUndefined();
    // Un objeto corto sigue siendo legible y no molesta.
    expect(sanitizeActivityDetail('{"total": 3}')).toBe('{"total": 3}');
  });

  it("conserva una frase normal, recortada y sin saltos de linea", () => {
    expect(sanitizeActivityDetail("  3 registros   en  clientes \n")).toBe(
      "3 registros en clientes",
    );
    const largo = "registro ".repeat(40);
    const recortado = sanitizeActivityDetail(largo);
    expect(recortado).toHaveLength(120);
    expect(recortado?.endsWith("…")).toBe(true);
  });

  it("solo acepta un nombre de herramienta con forma de identificador", () => {
    expect(sanitizeToolName("query_records_search")).toBe("query_records_search");
    expect(sanitizeToolName("  query.module-describe ")).toBe("query.module-describe");
    expect(sanitizeToolName("/usr/bin/curl")).toBeUndefined();
    expect(sanitizeToolName("herramienta con espacios")).toBeUndefined();
    expect(sanitizeToolName("x".repeat(60))).toBeUndefined();
  });

  it("nunca deja que el agente escriba la etiqueta con texto sensible", () => {
    const gate = gateFor("verbose");
    const activity = emit(
      gate,
      { kind: "searching", label: "Bearer abc123 en /home/query" },
      T0 + 9_000,
    );
    expect(activity?.label).toBe("Consultando registros");
  });

  it("ignora el detalle en los pasos que no lo admiten", () => {
    const gate = gateFor("verbose");
    const activity = emit(
      gate,
      { kind: "finalizing", detail: "redactando el cierre" },
      T0 + 9_000,
    );
    expect(activity?.detail).toBeUndefined();
  });
});

describe("paso derivado de la herramienta", () => {
  it("traduce las herramientas de Query al paso que la persona entiende", () => {
    expect(kindForTool("query_modules_list", false)).toBe("module_detected");
    expect(kindForTool("query_records_search", false)).toBe("searching");
    expect(kindForTool("query_record_get", false)).toBe("searching");
    expect(kindForTool("query_record_propose", false)).toBe("proposal_preparing");
    expect(kindForTool("herramienta_desconocida", false)).toBe("tool_started");
  });

  it("una propuesta terminada devuelve la conversacion a la persona", () => {
    expect(kindForTool("query_record_propose", true)).toBe("waiting_for_user");
    expect(kindForTool("query_records_search", true)).toBe("tool_completed");
  });
});
