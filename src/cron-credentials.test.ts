import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerQueryCronSync } from "./cron-sync.js";
import {
  forgetDelegatedAuth,
  getDelegatedAuth,
  rememberDelegatedAuth,
} from "./delegated-store.js";
import { evaluateGoogleToolCall } from "./google-guard.js";
import { forgetQuerySession } from "./query-session-store.js";

const SOCKET = "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x";
const THREAD = "private-42";
const SESSION = "query:agente:private-42";

let stateDirectory: string;
let previousStateFile: string | undefined;
let previousSessionFile: string | undefined;

const requestQueryScheduleAuth = vi.fn();

// El hook importa socket.js de forma perezosa; se intercepta el modulo entero
// para no levantar un WebSocket real en las pruebas.
vi.mock("./socket.js", () => ({
  sendQueryOutboundEvent: vi.fn(),
  requestQueryScheduleAuth: (...args: unknown[]) =>
    requestQueryScheduleAuth(...args),
}));

beforeAll(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), "query-cron-cred-"));
  previousStateFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(
    stateDirectory,
    "delegated.json",
  );
  previousSessionFile = process.env.QUERY_SESSION_BINDING_STATE_FILE;
  process.env.QUERY_SESSION_BINDING_STATE_FILE = join(
    stateDirectory,
    "sessions.json",
  );
});

afterAll(() => {
  if (previousStateFile === undefined) {
    delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  } else {
    process.env.QUERY_DELEGATED_AUTH_STATE_FILE = previousStateFile;
  }
  if (previousSessionFile === undefined) {
    delete process.env.QUERY_SESSION_BINDING_STATE_FILE;
  } else {
    process.env.QUERY_SESSION_BINDING_STATE_FILE = previousSessionFile;
  }
  rmSync(stateDirectory, { recursive: true, force: true });
});

afterEach(() => {
  forgetDelegatedAuth(THREAD);
  forgetQuerySession(SESSION);
  requestQueryScheduleAuth.mockReset();
});

type Hook = (...args: any[]) => unknown;

function fakeApi() {
  const hooks = new Map<string, Hook>();
  const api = {
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((name: string, handler: Hook) => {
      hooks.set(name, handler);
    }),
  };
  return { api, hooks };
}

function cronAdded(jobId = "cron-1") {
  return {
    action: "added",
    jobId,
    job: {
      delivery: { channel: "query", accountId: "sales", threadId: THREAD },
    },
  };
}

describe("registro de la tarea", () => {
  it("adjunta la credencial del turno para probar de quien es", () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    rememberDelegatedAuth(THREAD, { token: "de-julian", expires_in: 900 }, SOCKET);

    hooks.get("cron_changed")?.(cronAdded());

    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        data: expect.objectContaining({ delegated_token: "de-julian" }),
      }),
    );
  });

  it("registra la tarea sin token y avisa cuando no hay credencial", () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);

    hooks.get("cron_changed")?.(cronAdded());

    const [, event] = send.mock.calls.at(-1) as [string, { data: object }];
    expect(event.data).not.toHaveProperty("delegated_token");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("sin credencial"),
    );
  });
});

describe("arranque del turno de un cron", () => {
  it("pide credencial y la guarda para que las tools la encuentren", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { token: "del-autor", expires_in: 900 },
      socketUrl: SOCKET,
    });

    // Una tarea que este proceso no sincronizo: es lo que pasa tras reiniciar
    // OpenClaw, y entonces no se conoce la cuenta de la que salio.
    await hooks.get("before_agent_start")?.(
      { prompt: "resumen diario" },
      { jobId: "cron-sin-sincronizar", channel: "query", chatId: THREAD },
    );

    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(
      THREAD,
      "cron-sin-sincronizar",
      undefined,
    );
    expect(getDelegatedAuth(THREAD)?.auth.token).toBe("del-autor");
  });

  it("usa la cuenta con la que se sincronizo la tarea", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    hooks.get("cron_changed")?.(cronAdded());
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { token: "del-autor", expires_in: 900 },
      socketUrl: SOCKET,
    });

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD },
    );

    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(THREAD, "cron-1", "sales");
  });

  it("no toca nada en un turno normal, que ya trae su credencial", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());

    await hooks.get("before_agent_start")?.(
      {},
      { channel: "query", chatId: THREAD },
    );

    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
  });

  it("ignora los turnos de otros canales", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "discord", chatId: "otro" },
    );

    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
  });

  it("reusa la credencial viva en lugar de pedir otra", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    rememberDelegatedAuth(THREAD, { token: "aun-viva", expires_in: 900 }, SOCKET);

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD },
    );

    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
    expect(getDelegatedAuth(THREAD)?.auth.token).toBe("aun-viva");
  });

  it("avisa con instrucciones cuando Query niega la credencial", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockResolvedValue(undefined);

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD },
    );

    expect(getDelegatedAuth(THREAD)).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Vuelve a crear la tarea"),
    );
  });

  it("reconoce una tarea que ya existia al arrancar el gateway", async () => {
    // El caso del deploy: la tarea se creo hace meses, este proceso nunca vio
    // su ``cron_changed`` y su turno no se identifica como de Query. Sin la
    // adopcion del arranque pasaria de largo por el control de cuentas.
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    const list = vi.fn().mockResolvedValue([
      {
        id: "cron-viejo",
        delivery: { channel: "query", accountId: "sales", threadId: THREAD },
      },
      { id: "cron-de-discord", delivery: { channel: "discord", to: "otro" } },
    ]);
    await hooks.get("gateway_start")?.({}, { getCron: () => ({ list }) });
    requestQueryScheduleAuth.mockResolvedValue(undefined);

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-viejo", chatId: THREAD, sessionKey: SESSION },
    );

    // Recupera ademas la cuenta con la que hay que pedir la credencial, que en
    // una instalacion con varios tenants es el tenant correcto o el de al lado.
    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(
      THREAD,
      "cron-viejo",
      "sales",
    );
    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: { accountId: "jcvargas" } },
      { toolName: "google_gmail_search", sessionKey: SESSION },
    );
    expect(decision?.block).toBe(true);
  });

  it("no adopta los crones de otros canales", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    const list = vi.fn().mockResolvedValue([
      { id: "cron-de-discord", delivery: { channel: "discord", to: "otro" } },
    ]);
    await hooks.get("gateway_start")?.({}, { getCron: () => ({ list }) });
    requestQueryScheduleAuth.mockResolvedValue(undefined);

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-de-discord", chatId: THREAD, sessionKey: SESSION },
    );

    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: { accountId: "jcvargas" } },
      { toolName: "google_gmail_search", sessionKey: SESSION },
    );
    expect(decision).toBeUndefined();
  });

  it("un fallo enumerando tareas no impide arrancar", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    const list = vi.fn().mockRejectedValue(new Error("cron store caido"));

    await expect(
      hooks.get("gateway_start")?.({}, { getCron: () => ({ list }) }),
    ).resolves.not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no pudo enumerar"),
    );
  });

  it("un cron sin autor deja el turno sin acceso a Google", async () => {
    // El encadenado completo: Query no entrega credencial porque la tarea no
    // tiene ``run_as`` con acceso, y el guard lo convierte en un bloqueo antes
    // de que exista un cliente de Google. Sin la sesion apuntada aqui, el turno
    // pasaria de largo por no parecer de Query.
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockResolvedValue(undefined);

    await hooks.get("before_agent_start")?.(
      {},
      {
        jobId: "cron-sin-autor",
        channel: "query",
        chatId: THREAD,
        sessionKey: SESSION,
      },
    );

    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: { accountId: "jcvargas" } },
      { toolName: "google_gmail_search", sessionKey: SESSION },
    );
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("cron-sin-autor");
  });

  it("un fallo pidiendo credencial no tumba el turno", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockRejectedValue(new Error("socket caido"));

    await expect(
      hooks.get("before_agent_start")?.(
        {},
        { jobId: "cron-1", channel: "query", chatId: THREAD },
      ),
    ).resolves.not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("socket caido"),
    );
  });
});
