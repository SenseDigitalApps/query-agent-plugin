/**
 * Que ve una persona mientras el agente trabaja, y que no.
 *
 * El agente ya emite telemetria suficiente para contar una historia de
 * progreso; el problema nunca fue generarla sino decidir cual de esos eventos
 * merece la pantalla de alguien que solo quiere saber si su mensaje sigue vivo.
 * Aqui no se llama al modelo ni se resume nada: se traduce cada evento tecnico
 * a una plantilla fija y se descarta lo que sobra. Un segundo paso de LLM para
 * "explicar el progreso" costaria justo lo que este archivo intenta ahorrar.
 *
 * La regla de oro es que el texto que sale de aqui lo escribio una persona en
 * este archivo. Lo que venga del agente solo puede rellenar huecos acotados
 * (nombre de herramienta, detalle corto) y siempre pasa por el saneador.
 */

export const QUERY_ACTIVITY_MODES = [
  "off",
  "lite",
  "smart",
  "verbose",
  "debug-internal",
] as const;

export type QueryActivityMode = (typeof QUERY_ACTIVITY_MODES)[number];

/**
 * Para quien es el evento.
 *
 * `public` llega al chat de la persona. `admin` solo al dashboard interno.
 * `internal` no se muestra en ningun sitio: existe para que el turno siga
 * teniendo pulso (lease) sin ensuciar ninguna vista.
 */
export type QueryActivityVisibility = "public" | "admin" | "internal";

export type QueryActivityKind =
  | "received"
  | "routing"
  | "reasoning_summary"
  | "module_detected"
  | "searching"
  | "tool_started"
  | "tool_completed"
  | "validating"
  | "proposal_preparing"
  | "waiting_for_user"
  | "retrying"
  | "finalizing"
  | "working"
  | "context";

type ActivityTemplate = {
  label: string;
  stage: string;
  visibility: QueryActivityVisibility;
  progress?: number;
  /** Un cambio importante se salta el throttle: la espera cambio de naturaleza. */
  important?: boolean;
  /** Estos pasos nunca llevan detalle libre por mas que el evento lo traiga. */
  detailAllowed?: boolean;
};

/**
 * El catalogo entero de texto visible. Si una etiqueta no esta aqui, no sale.
 */
const ACTIVITY_CATALOG: Record<QueryActivityKind, ActivityTemplate> = {
  received: {
    label: "El agente recibió el mensaje",
    stage: "received",
    visibility: "public",
    progress: 0,
    important: true,
  },
  routing: {
    label: "Identificando la solicitud",
    stage: "routing",
    visibility: "public",
    progress: 5,
  },
  reasoning_summary: {
    label: "Revisando el enfoque",
    stage: "reasoning",
    visibility: "public",
    important: true,
  },
  module_detected: {
    label: "Módulo detectado",
    stage: "module",
    visibility: "public",
    progress: 15,
    detailAllowed: true,
  },
  searching: {
    label: "Consultando registros",
    stage: "search",
    visibility: "public",
    progress: 35,
    detailAllowed: true,
  },
  tool_started: {
    label: "Consultando el sistema",
    stage: "tool",
    visibility: "public",
    progress: 45,
    detailAllowed: true,
  },
  tool_completed: {
    label: "Consulta finalizada",
    stage: "tool",
    visibility: "public",
    progress: 60,
    detailAllowed: true,
  },
  validating: {
    label: "Validando datos y permisos",
    stage: "validation",
    visibility: "public",
    progress: 70,
  },
  proposal_preparing: {
    label: "Preparando la propuesta",
    stage: "proposal",
    visibility: "public",
    progress: 80,
  },
  waiting_for_user: {
    label: "Requiere tu confirmación",
    stage: "waiting",
    visibility: "public",
    important: true,
  },
  retrying: {
    label: "Reintentando el servicio",
    stage: "retry",
    visibility: "public",
    important: true,
  },
  finalizing: {
    label: "Preparando la respuesta",
    stage: "response",
    visibility: "public",
    progress: 90,
    important: true,
  },
  working: {
    label: "El agente sigue procesando el mensaje",
    stage: "agent",
    visibility: "public",
  },
  // Mantenimiento del propio agente. Sirve para diagnosticar una espera larga
  // en el dashboard, pero a la persona del chat no le dice nada que pueda usar.
  context: {
    label: "Organizando el contexto",
    stage: "context",
    visibility: "admin",
  },
};

export function activityTemplate(kind: QueryActivityKind) {
  return ACTIVITY_CATALOG[kind];
}

export function parseActivityMode(value: unknown): QueryActivityMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (QUERY_ACTIVITY_MODES as readonly string[]).includes(normalized)
    ? (normalized as QueryActivityMode)
    : undefined;
}

export const DEFAULT_ACTIVITY_MODE: QueryActivityMode = "smart";

/**
 * La configuracion del canal manda sobre el entorno, igual que con el token:
 * quien escribe la cuenta sabe mas que la variable heredada del proceso.
 */
export function resolveActivityMode(configured?: unknown): QueryActivityMode {
  return (
    parseActivityMode(configured) ??
    parseActivityMode(process.env.QUERY_AGENT_ACTIVITY_MODE) ??
    DEFAULT_ACTIVITY_MODE
  );
}

/** Hasta donde llega cada modo. Nadie por debajo ve lo del escalon de arriba. */
const MODE_AUDIENCE: Record<QueryActivityMode, QueryActivityVisibility[]> = {
  off: [],
  lite: ["public"],
  smart: ["public"],
  verbose: ["public", "admin"],
  "debug-internal": ["public", "admin", "internal"],
};

/**
 * Texto que jamas debe cruzar hacia un chat.
 *
 * Se descarta el detalle entero, no se enmascara el fragmento: un detalle que
 * menciona una credencial rara vez sigue siendo util despues de taparla, y un
 * enmascarado a medias es la forma habitual de filtrar la mitad de un secreto.
 */
const BLOCKED_DETAIL_PATTERNS: RegExp[] = [
  /\b(authorization|bearer|api[-_]?key|apikey|secret|password|passwd|credential|cookie)\b/i,
  /\btokens?\b\s*[:=]/i,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Z][A-Z0-9_]{4,}\s*=\s*\S/,
  /(^|[\s"'(])\/(home|Users|root|etc|var|usr|opt|proc|tmp)\//,
  /(^|[\s"'(])[A-Za-z]:[\\/]/,
  /\bfile:\/\//i,
  /\n\s*at\s+\S+\s*\(/,
  /\bTraceback \(most recent call last\)/i,
  /\b(system prompt|prompt del sistema|instrucciones del sistema)\b/i,
  /<\/?(thinking|scratchpad)\b/i,
];

/** Un identificador de herramienta y nada mas: sin rutas, URLs ni espacios. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

const MAX_PUBLIC_DETAIL = 120;
const MAX_ADMIN_DETAIL = 240;

/**
 * Devuelve el detalle si es publicable, o `undefined` si hay cualquier duda.
 *
 * Un JSON crudo largo se descarta aunque no contenga nada sensible: es el
 * sintoma de que alguien esta volcando el payload de una herramienta en un
 * campo pensado para una frase.
 */
export function sanitizeActivityDetail(
  value: unknown,
  maxLength: number = MAX_PUBLIC_DETAIL,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (BLOCKED_DETAIL_PATTERNS.some((pattern) => pattern.test(value))) return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // Un payload serializado no es una frase de progreso.
  if (/^[[{]/.test(collapsed) && collapsed.length > 80) return undefined;
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

export function sanitizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || !SAFE_TOOL_NAME.test(trimmed)) return undefined;
  if (BLOCKED_DETAIL_PATTERNS.some((pattern) => pattern.test(trimmed))) return undefined;
  return trimmed;
}

/**
 * De que herramienta viene y, por tanto, que esta pasando de verdad.
 *
 * Las herramientas de Query ya dicen su intencion en el nombre, asi que el
 * paso visible sale de ahi sin que nadie tenga que anotarlo aparte.
 */
export function kindForTool(
  toolName: string | undefined,
  finished: boolean,
): QueryActivityKind {
  const name = toolName?.toLowerCase() ?? "";
  if (name.includes("propose")) {
    // Una propuesta terminada es exactamente el momento en que la conversacion
    // vuelve a manos de la persona.
    return finished ? "waiting_for_user" : "proposal_preparing";
  }
  if (name.includes("module")) return finished ? "tool_completed" : "module_detected";
  if (name.includes("search") || name.includes("record")) {
    return finished ? "tool_completed" : "searching";
  }
  return finished ? "tool_completed" : "tool_started";
}

export type ActivityCandidate = {
  kind: QueryActivityKind;
  /** Solo se usa si sobrevive al saneador; si no, manda la plantilla. */
  label?: string;
  detail?: string;
  toolName?: string;
  progress?: number;
  runId?: string;
  /**
   * Latido: repite el ultimo estado para que el turno conserve el lease. No
   * cuenta como paso nuevo ni reinicia el throttle.
   */
  keepalive?: boolean;
};

export type NormalizedActivity = {
  kind: QueryActivityKind;
  label: string;
  detail?: string;
  stage: string;
  toolName?: string;
  progress?: number;
  runId?: string;
  visibility: QueryActivityVisibility;
  heartbeat: boolean;
};

export type ActivityDropReason =
  | "mode_off"
  | "mode_lite"
  | "quiet_window"
  | "duplicate"
  | "throttled"
  | "not_visible";

export type ActivityDecision =
  | { emit: true; activity: NormalizedActivity }
  | { emit: false; reason: ActivityDropReason };

export type ActivityGateOptions = {
  mode: QueryActivityMode;
  /** Cuando empezo el turno; el silencio inicial se mide contra esto. */
  startedAt: number;
  /** Antes de esto un turno rapido no merece cronologia. */
  quietMs?: number;
  /** Distancia minima entre dos pasos visibles seguidos. */
  throttleMs?: number;
};

export const DEFAULT_QUIET_MS = 4_000;
export const DEFAULT_THROTTLE_MS = 3_500;
/** En verbose quien mira quiere ver el detalle, no una version comoda. */
export const VERBOSE_THROTTLE_MS = 1_500;

export type ActivityGate = {
  readonly mode: QueryActivityMode;
  evaluate(candidate: ActivityCandidate, now: number): ActivityDecision;
  /**
   * El paso que se retuvo durante el silencio inicial o el throttle, si sigue
   * siendo el ultimo que se sabe. Lo consume quien vigila el reloj del turno.
   */
  takeHeld(now: number): NormalizedActivity | undefined;
  lastLabel(): string;
  stats(): { emitted: number; dropped: number };
};

function normalize(
  candidate: ActivityCandidate,
  mode: QueryActivityMode,
  lastLabel: string,
): NormalizedActivity {
  const template = ACTIVITY_CATALOG[candidate.kind] ?? ACTIVITY_CATALOG.working;
  const maxDetail = mode === "smart" || mode === "lite" ? MAX_PUBLIC_DETAIL : MAX_ADMIN_DETAIL;
  const overrideLabel = sanitizeActivityDetail(
    candidate.label,
    candidate.kind === "reasoning_summary" ? 180 : 80,
  );
  const detail = template.detailAllowed
    ? sanitizeActivityDetail(candidate.detail, maxDetail)
    : undefined;
  const toolName = sanitizeToolName(candidate.toolName);
  const progress =
    typeof candidate.progress === "number" && Number.isFinite(candidate.progress)
      ? Math.max(0, Math.min(100, candidate.progress))
      : template.progress;
  return {
    kind: candidate.kind,
    label: candidate.keepalive ? lastLabel : (overrideLabel ?? template.label),
    detail,
    stage: candidate.keepalive ? "heartbeat" : template.stage,
    toolName,
    progress: candidate.keepalive ? undefined : progress,
    runId: candidate.runId,
    visibility: template.visibility,
    heartbeat: Boolean(candidate.keepalive),
  };
}

function signature(activity: NormalizedActivity): string {
  return [
    activity.kind,
    activity.label,
    activity.detail ?? "",
    activity.toolName ?? "",
  ].join(" ");
}

/**
 * El filtro de un turno: decide, para cada evento, si merece la pantalla.
 *
 * Guarda estado por turno a proposito. Dos turnos distintos no comparten ni
 * dedupe ni throttle: lo que ya se dijo en el mensaje anterior no dice nada
 * sobre lo que hace falta contar en este.
 */
export function createActivityGate(options: ActivityGateOptions): ActivityGate {
  // Una cuenta resuelta por una version anterior no trae modo. Caer al modo por
  // defecto es preferible a que la telemetria tumbe el turno que decoraba.
  const mode = parseActivityMode(options.mode) ?? DEFAULT_ACTIVITY_MODE;
  const audience = MODE_AUDIENCE[mode];
  const quietMs =
    mode === "smart" || mode === "lite"
      ? (options.quietMs ?? DEFAULT_QUIET_MS)
      : 0;
  const throttleMs =
    options.throttleMs ??
    (mode === "verbose" || mode === "debug-internal"
      ? VERBOSE_THROTTLE_MS
      : DEFAULT_THROTTLE_MS);

  let lastLabel = ACTIVITY_CATALOG.working.label;
  let lastSignature: string | undefined;
  let lastEmitAt = 0;
  let held: NormalizedActivity | undefined;
  let emitted = 0;
  let dropped = 0;

  const drop = (reason: ActivityDropReason): ActivityDecision => {
    dropped += 1;
    return { emit: false, reason };
  };

  const accept = (activity: NormalizedActivity, now: number): ActivityDecision => {
    emitted += 1;
    if (!activity.heartbeat) {
      lastSignature = signature(activity);
      held = undefined;
      // Ni el acuse ni el latido son pasos de progreso, asi que no arrancan el
      // throttle: si lo hicieran, el primer paso real del turno —el unico que
      // de verdad cuenta algo— llegaria siempre tarde o se perderia.
      if (activity.kind !== "received") lastEmitAt = now;
    }
    lastLabel = activity.label || lastLabel;
    return { emit: true, activity };
  };

  return {
    mode,
    lastLabel: () => lastLabel,
    stats: () => ({ emitted, dropped }),

    takeHeld(now: number) {
      if (!held) return undefined;
      if (now - options.startedAt < quietMs) return undefined;
      if (lastEmitAt > 0 && now - lastEmitAt < throttleMs) return undefined;
      const pending = held;
      held = undefined;
      lastSignature = signature(pending);
      lastEmitAt = now;
      lastLabel = pending.label || lastLabel;
      emitted += 1;
      return pending;
    },

    evaluate(candidate, now) {
      const activity = normalize(candidate, mode, lastLabel);

      // El latido sostiene el lease del turno aunque no haya nada que contar,
      // asi que sobrevive a todos los modos. En `off` viaja como interno: el
      // servidor lo usa para saber que el turno vive, nadie lo pinta.
      if (activity.heartbeat) {
        return mode === "off"
          ? accept({ ...activity, visibility: "internal" }, now)
          : accept(activity, now);
      }

      if (mode === "off") return drop("mode_off");
      if (!audience.includes(activity.visibility)) return drop("not_visible");

      // El acuse es la unica senal que importa para la velocidad percibida:
      // sale siempre y sin esperar, que es justo lo que se le pide.
      if (activity.kind === "received") return accept(activity, now);

      // Lite sigue silencioso en turnos rapidos, pero si el propio agente
      // publico una explicacion concreta y la espera ya se nota, esa frase es
      // mas util que mantener un spinner mudo.
      if (mode === "lite" && activity.kind !== "reasoning_summary") {
        return drop("mode_lite");
      }

      if (signature(activity) === lastSignature) return drop("duplicate");

      // Un turno que termina antes del silencio inicial no llega a mostrar
      // cronologia: la persona ve la respuesta, no el andamio.
      if (now - options.startedAt < quietMs) {
        // El comentario escrito por el agente explica el porqué del siguiente
        // tool call. No dejar que el evento técnico que ocurre milisegundos
        // después lo reemplace antes de que la persona alcance a verlo.
        if (held?.kind !== "reasoning_summary" || activity.kind === "reasoning_summary") {
          held = activity;
        }
        return drop("quiet_window");
      }

      const important = ACTIVITY_CATALOG[activity.kind]?.important ?? false;
      if (!important && lastEmitAt > 0 && now - lastEmitAt < throttleMs) {
        if (held?.kind !== "reasoning_summary" || activity.kind === "reasoning_summary") {
          held = activity;
        }
        return drop("throttled");
      }

      return accept(activity, now);
    },
  };
}
