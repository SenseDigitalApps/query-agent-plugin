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
import { evaluateGoogleToolCall, registerQueryGoogleGuard } from "./google-guard.js";
import { rememberExternalContext } from "./external-context.js";
import {
  getQuerySession,
  forgetQuerySession,
  rememberQuerySession,
} from "./query-session-store.js";

const SOCKET = "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x";
const THREAD = "private-42";
const ORIGIN_THREAD = "private-admin";
const SESSION = "query:agente:private-42";

let stateDirectory: string;
let previousStateFile: string | undefined;
let previousSessionFile: string | undefined;
let previousExternalContextDir: string | undefined;

const requestQueryScheduleAuth = vi.fn();

// El hook importa socket.js de forma perezosa; se intercepta el modulo entero
// para no levantar un WebSocket real en las pruebas.
vi.mock("./socket.js", () => ({
  sendQueryOutboundEvent: vi.fn(),
  queryAccountIdForSocketUrl: vi.fn(() => "sales"),
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
  previousExternalContextDir = process.env.QUERY_EXTERNAL_CONTEXT_DIR;
  process.env.QUERY_EXTERNAL_CONTEXT_DIR = join(stateDirectory, "external");
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
  if (previousExternalContextDir === undefined) {
    delete process.env.QUERY_EXTERNAL_CONTEXT_DIR;
  } else {
    process.env.QUERY_EXTERNAL_CONTEXT_DIR = previousExternalContextDir;
  }
  rmSync(stateDirectory, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetDelegatedAuth(THREAD);
  forgetDelegatedAuth(ORIGIN_THREAD);
  const scheduleAuthKey = getQuerySession(SESSION)?.authKey;
  if (scheduleAuthKey) forgetDelegatedAuth(scheduleAuthKey);
  forgetQuerySession(SESSION);
  requestQueryScheduleAuth.mockReset();
});

type Hook = (...args: any[]) => unknown;

function fakeApi() {
  const hooks = new Map<string, Hook>();
  const tools: Array<(context: Record<string, unknown>) => any> = [];
  const api = {
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((name: string, handler: Hook) => {
      hooks.set(name, handler);
    }),
    registerTool: vi.fn((factory: (context: Record<string, unknown>) => any) => {
      tools.push(factory);
    }),
  };
  return { api, hooks, tools };
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
  it("expone un gestor propio en Query y repara el ID existente con el actor delegado", async () => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    const update = vi.fn().mockResolvedValue({ id: "cron-existing" });
    const job = {
      id: "cron-existing",
      agentId: "query",
      name: "Seguimiento",
      delivery: {
        mode: "announce",
        channel: "query",
        accountId: "sales",
        to: "channel:86",
      },
    };
    const list = vi.fn().mockResolvedValue([job]);
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, {
      getCron: () => ({ list, update, add: vi.fn(), remove: vi.fn() }),
    });
    rememberQuerySession(SESSION, {
      threadId: ORIGIN_THREAD,
      accountId: "sales",
    });
    rememberExternalContext({
      sessionKey: SESSION,
      senderId: "7",
      threadId: ORIGIN_THREAD,
      queryAccountId: "sales",
      socketUrl: SOCKET,
      agentToken: "agent-token",
      clientMsgId: "message-1",
      auth: {
        token: "delegated-creator",
        expires_in: 900,
        identity: { id: 7, username: "creator" },
        external_account_identity: { id: 77, username: "JCVARGAS" },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ targets: [{ thread_id: "86" }] }),
    }));

    const tool = tools[0]({
      messageChannel: "query",
      sessionKey: SESSION,
      requesterSenderId: "7",
      agentAccountId: "sales",
      agentId: "query",
    });
    expect(tool.name).toBe("query_cron_manage");
    const result = await tool.execute("call-1", {
      action: "update",
      job_id: "cron-existing",
      patch: {},
    });

    expect(update).toHaveBeenCalledWith("cron-existing", {
      sessionTarget: "isolated",
    });
    expect(send).toHaveBeenLastCalledWith("sales", expect.objectContaining({
      type: "schedule.sync",
      data: expect.objectContaining({
        external_id: "cron-existing",
        delegated_token: "delegated-creator",
        creator_user_id: 7,
        run_as_user_id: 77,
        origin_thread_id: ORIGIN_THREAD,
      }),
    }));
    expect(result.details).toMatchObject({
      ok: true,
      job_id: "cron-existing",
      session_target: "isolated",
    });
    vi.unstubAllGlobals();
  });

  it("crea un cron aislado para un destino publico autorizado sin usar la tool owner-only", async () => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    const created = {
      id: "cron-new",
      agentId: "query",
      name: "Radar",
      sessionTarget: "isolated",
      delivery: {
        mode: "announce",
        channel: "query",
        accountId: "sales",
        to: "channel:86",
      },
    };
    const list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    const add = vi.fn().mockResolvedValue(created);
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, {
      getCron: () => ({ list, update: vi.fn(), add, remove: vi.fn() }),
    });
    rememberQuerySession(SESSION, {
      threadId: ORIGIN_THREAD,
      accountId: "sales",
    });
    rememberExternalContext({
      sessionKey: SESSION,
      senderId: "8",
      threadId: ORIGIN_THREAD,
      queryAccountId: "sales",
      socketUrl: SOCKET,
      agentToken: "agent-token",
      clientMsgId: "message-2",
      auth: {
        token: "delegated-add",
        expires_in: 900,
        identity: { id: 8 },
        external_account_identity: { id: 88 },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ targets: [{ thread_id: "86" }] }),
    }));

    const tool = tools[0]({
      messageChannel: "query",
      sessionKey: SESSION,
      requesterSenderId: "8",
      agentAccountId: "sales",
      agentId: "query",
    });
    const result = await tool.execute("call-2", {
      action: "add",
      job: {
        name: "Radar",
        schedule: { kind: "cron", expr: "0 8 * * 1", tz: "America/Bogota" },
        payload: { kind: "agentTurn", message: "Publica el radar." },
        delivery: created.delivery,
      },
    });

    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "query",
      sessionTarget: "isolated",
      delivery: created.delivery,
    }));
    expect(send).toHaveBeenLastCalledWith("sales", expect.objectContaining({
      data: expect.objectContaining({
        action: "added",
        external_id: "cron-new",
        delegated_token: "delegated-add",
        run_as_user_id: 88,
      }),
    }));
    expect(result.details).toMatchObject({ ok: true, job_id: "cron-new" });
    vi.unstubAllGlobals();
  });

  it("lista y consulta solo los cron Query del agente y tenant actuales", async () => {
    const { api, hooks, tools } = fakeApi();
    const jobs = [
      {
        id: "visible",
        agentId: "query",
        name: "Visible",
        sessionTarget: "isolated",
        delivery: { channel: "query", accountId: "sales", to: "channel:86" },
        payload: { kind: "agentTurn", message: "Publica." },
      },
      {
        id: "other-agent",
        agentId: "harvey",
        delivery: { channel: "query", accountId: "sales", to: "channel:86" },
      },
      {
        id: "other-tenant",
        agentId: "query",
        delivery: { channel: "query", accountId: "other", to: "channel:86" },
      },
    ];
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("gateway_start")?.({}, {
      getCron: () => ({ list: vi.fn().mockResolvedValue(jobs), update: vi.fn(), add: vi.fn(), remove: vi.fn() }),
    });
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales" });
    rememberExternalContext({
      sessionKey: SESSION,
      senderId: "7",
      threadId: ORIGIN_THREAD,
      queryAccountId: "sales",
      socketUrl: SOCKET,
      agentToken: "agent-token",
      clientMsgId: "message-list",
      auth: { token: "delegated-list", expires_in: 900, identity: { id: 7 } },
    });
    const tool = tools[0]({
      messageChannel: "query",
      sessionKey: SESSION,
      requesterSenderId: "7",
      agentAccountId: "sales",
      agentId: "query",
    });

    const listed = await tool.execute("list-call", { action: "list" });
    expect(listed.details).toMatchObject({ ok: true, count: 1 });
    expect(listed.details.jobs[0]).toMatchObject({ job_id: "visible", name: "Visible" });
    const got = await tool.execute("get-call", { action: "get", job_id: "visible" });
    expect(got.details.job).toMatchObject({ job_id: "visible", session_target: "isolated" });
    const hidden = await tool.execute("get-hidden", { action: "get", job_id: "other-agent" });
    expect(hidden.details).toEqual({ ok: false, error: "query_cron_not_query_owned" });
  });

  it("actualiza varios cron tras validar todo el lote y sincroniza el creador", async () => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const jobs = ["one", "two"].map((id) => ({
      id,
      agentId: "query",
      name: id,
      sessionTarget: "session:old",
      delivery: { channel: "query", accountId: "sales", to: "channel:86" },
      payload: { kind: "agentTurn", message: `old-${id}` },
    }));
    const list = vi.fn().mockResolvedValue(jobs);
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, {
      getCron: () => ({ list, update, add: vi.fn(), remove: vi.fn() }),
    });
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales" });
    rememberExternalContext({
      sessionKey: SESSION,
      senderId: "7",
      threadId: ORIGIN_THREAD,
      queryAccountId: "sales",
      socketUrl: SOCKET,
      agentToken: "agent-token",
      clientMsgId: "message-batch",
      auth: {
        token: "delegated-batch",
        expires_in: 900,
        identity: { id: 7 },
        external_account_identity: { id: 77 },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ targets: [{ thread_id: "86" }] }),
    }));
    const tool = tools[0]({
      messageChannel: "query",
      sessionKey: SESSION,
      requesterSenderId: "7",
      agentAccountId: "sales",
      agentId: "query",
    });

    const result = await tool.execute("batch-call", {
      action: "update_many",
      jobs: [
        { job_id: "one", patch: { payload: { kind: "agentTurn", message: "new-one" } } },
        { job_id: "two", patch: { payload: { kind: "agentTurn", message: "new-two" } } },
      ],
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, "one", expect.objectContaining({ sessionTarget: "isolated" }));
    expect(update).toHaveBeenNthCalledWith(2, "two", expect.objectContaining({ sessionTarget: "isolated" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[1].data)).toEqual([
      expect.objectContaining({ external_id: "one", run_as_user_id: 77 }),
      expect.objectContaining({ external_id: "two", run_as_user_id: 77 }),
    ]);
    expect(result.details).toMatchObject({ ok: true, action: "updated_many", count: 2 });
  });

  it("resincroniza la autorización antes de ejecutar un cron aislado", async () => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    const run = vi.fn().mockResolvedValue({ ran: true });
    const job = {
      id: "run-me",
      agentId: "query",
      name: "Run",
      sessionTarget: "isolated",
      delivery: { channel: "query", accountId: "sales", to: "channel:86" },
    };
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, {
      getCron: () => ({ list: vi.fn().mockResolvedValue([job]), update: vi.fn(), add: vi.fn(), remove: vi.fn(), run }),
    });
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales" });
    rememberExternalContext({
      sessionKey: SESSION,
      senderId: "7",
      threadId: ORIGIN_THREAD,
      queryAccountId: "sales",
      socketUrl: SOCKET,
      agentToken: "agent-token",
      clientMsgId: "message-run",
      auth: {
        token: "delegated-run",
        expires_in: 900,
        identity: { id: 7 },
        external_account_identity: { id: 77 },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ targets: [{ thread_id: "86" }] }),
    }));
    const tool = tools[0]({
      messageChannel: "query",
      sessionKey: SESSION,
      requesterSenderId: "7",
      agentAccountId: "sales",
      agentId: "query",
    });

    const result = await tool.execute("run-call", { action: "run", job_id: "run-me" });
    expect(send).toHaveBeenCalledWith("sales", expect.objectContaining({
      data: expect.objectContaining({ external_id: "run-me", run_as_user_id: 77 }),
    }));
    expect(run).toHaveBeenCalledWith("run-me", "force");
    expect(result.details).toMatchObject({ ok: true, action: "run", job_id: "run-me" });
  });

  it("no expone el gestor de cron fuera de un turno Query", () => {
    const { api, tools } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    expect(tools[0]({ messageChannel: "telegram" })).toBeNull();
  });

  it("correlaciona dos creaciones nativas concurrentes por call ID y por ID real", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    hooks.get("gateway_stop")?.();
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales" });
    for (const actor of ["alice", "bob"]) {
      rememberDelegatedAuth(ORIGIN_THREAD, { token: actor, expires_in: 900 }, SOCKET);
      await hooks.get("before_tool_call")?.({ toolName: "cron", toolCallId: actor,
        params: { action: "add", job: { delivery: cronAdded().job.delivery } } },
        { sessionKey: SESSION });
    }
    for (const actor of ["bob", "alice"]) {
      const job = { id: `real-${actor}`, delivery: cronAdded().job.delivery };
      await hooks.get("cron_changed")?.({ action: "added", jobId: job.id, job });
      expect(send.mock.calls.at(-1)?.[1].data.delegated_token).toBeUndefined();
      await hooks.get("after_tool_call")?.({ toolName: "cron", toolCallId: actor,
        params: { action: "add" }, result: { content: [{ type: "text", text: JSON.stringify(job) }] } }, {});
      expect(send.mock.calls.at(-1)?.[1].data).toMatchObject({ external_id: job.id, delegated_token: actor, authorization_version: 2 });
    }
    hooks.get("gateway_stop")?.();
  });

  it("mantiene isolated, limpia la sesión humana y bloquea la CLI autenticada", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales" });
    rememberDelegatedAuth(ORIGIN_THREAD, { token: "editor-turn", expires_in: 900 }, SOCKET);
    const native = await hooks.get("before_tool_call")?.({ toolName: "cron", toolCallId: "update-call", params: {
      action: "update", jobId: "existing", patch: { sessionTarget: "session:direct:13", delivery: { channel: "query", accountId: "sales", to: "channel:86" } },
    } }, { sessionKey: SESSION });
    expect(native.params.patch).toMatchObject({ sessionTarget: "isolated", sessionKey: null });
    await hooks.get("after_tool_call")?.({ toolName: "cron", toolCallId: "update-call", params: {},
      result: { id: "existing", ...native.params.patch } }, {});
    expect(send.mock.calls.at(-1)?.[1].data).toMatchObject({
      action: "updated", external_id: "existing", delegated_token: "editor-turn", authorization_version: 2,
    });
    const cli = await hooks.get("before_tool_call")?.({ toolName: "exec", params: {
      command: "openclaw cron add --name test",
    } }, { sessionKey: SESSION });
    expect(cli.block).toBe(true);
    hooks.get("gateway_stop")?.();
  });

  it("usa la credencial del hilo creador aunque el destino sea otro", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    const fullJob = {
      id: "cron-cross-thread",
      delivery: { channel: "query", accountId: "sales", threadId: THREAD },
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fullJob]);
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, { getCron: () => ({ list }) });
    rememberDelegatedAuth(
      ORIGIN_THREAD,
      { token: "token-del-admin", expires_in: 900 },
      SOCKET,
      "mensaje-admin",
    );
    rememberQuerySession(SESSION, {
      threadId: ORIGIN_THREAD,
      accountId: "sales",
    });

    hooks.get("before_tool_call")?.(
      {
        toolName: "cron",
        params: { action: "add", job: { delivery: fullJob.delivery } },
      },
      { sessionKey: SESSION },
    );
    // La proyeccion publica de cron_changed no incluye delivery; el plugin lo
    // recupera del inventario y conserva por separado el turno creador.
    await hooks.get("cron_changed")?.({
      action: "added",
      jobId: "cron-cross-thread",
      job: { id: "cron-cross-thread" },
    });

    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        thread_id: THREAD,
        data: expect.objectContaining({
          delegated_token: "token-del-admin",
          origin_thread_id: ORIGIN_THREAD,
          origin_client_msg_id: "mensaje-admin",
        }),
      }),
    );
    hooks.get("gateway_stop")?.();
  });

  it("adjunta la credencial del turno creador para probar de quien es", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    rememberDelegatedAuth(THREAD, { token: "de-julian", expires_in: 900 }, SOCKET);
    rememberQuerySession(SESSION, { threadId: THREAD, accountId: "sales" });

    hooks.get("before_tool_call")?.(
      {
        toolName: "cron",
        params: {
          action: "add",
          job: { delivery: { channel: "query", accountId: "sales", threadId: THREAD } },
        },
      },
      { sessionKey: SESSION },
    );
    await hooks.get("cron_changed")?.(cronAdded());

    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        data: expect.objectContaining({ delegated_token: "de-julian" }),
      }),
    );
  });

  it("registra la tarea sin token y avisa cuando no hay credencial", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    rememberQuerySession(SESSION, { threadId: THREAD, accountId: "sales" });

    hooks.get("before_tool_call")?.(
      {
        toolName: "cron",
        params: {
          action: "add",
          job: { delivery: { channel: "query", accountId: "sales", threadId: THREAD } },
        },
      },
      { sessionKey: SESSION },
    );
    await hooks.get("cron_changed")?.(cronAdded());

    const [, event] = send.mock.calls.at(-1) as [string, { data: object }];
    expect(event.data).not.toHaveProperty("delegated_token");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("sin evidencia del turno creador"),
    );
  });
});

describe("arranque del turno de un cron", () => {
  it("preserva accountId y authKey cuando corre despues el hook generico de Google", async () => {
    const hooks = new Map<string, Hook[]>();
    const api = {
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn((name: string, handler: Hook) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      }),
      registerTool: vi.fn(),
    };
    registerQueryCronSync(api as never, vi.fn());
    registerQueryGoogleGuard(api as never);

    for (const hook of hooks.get("cron_changed") ?? []) {
      await hook(cronAdded());
    }
    requestQueryScheduleAuth.mockResolvedValue({
      auth: {
        source: "schedule",
        token: "schedule-token",
        expires_in: 900,
        thread_id: ORIGIN_THREAD,
      },
      socketUrl: SOCKET,
    });

    const context = {
      jobId: "cron-1",
      channel: "query",
      chatId: THREAD,
      sessionKey: SESSION,
    };
    // Mismo orden de index.ts/produccion: cron-sync obtiene la credencial y
    // luego el guard generico vuelve a registrar la sesion.
    for (const hook of hooks.get("before_agent_start") ?? []) {
      await hook({}, context);
    }

    const session = getQuerySession(SESSION);
    expect(session).toMatchObject({
      threadId: THREAD,
      deliveryThreadId: THREAD,
      jobId: "cron-1",
      accountId: "sales",
    });
    expect(session?.authKey).toMatch(/^schedule:/);
    expect(getDelegatedAuth(session!.authKey!)?.auth.token).toBe("schedule-token");
  });

  it("corrige el contexto accidental y pide auth para el destino canonico", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("cron_changed")?.(cronAdded());
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { source: "schedule", token: "canonico", expires_in: 900 },
      socketUrl: SOCKET,
    });

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: ORIGIN_THREAD, sessionKey: SESSION },
    );

    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(THREAD, "cron-1", "sales");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("destino canonico"),
    );
  });

  it("no pide credencial a una cuenta desconocida", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { source: "schedule", token: "del-autor", expires_in: 900 },
      socketUrl: SOCKET,
    });

    // Una tarea que este proceso no sincronizo: es lo que pasa tras reiniciar
    // OpenClaw, y entonces no se conoce la cuenta de la que salio.
    await hooks.get("before_agent_start")?.(
      { prompt: "resumen diario" },
      { jobId: "cron-sin-sincronizar", channel: "query", chatId: THREAD, sessionKey: SESSION },
    );

    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
    expect(getDelegatedAuth(THREAD)).toBeUndefined();
  });

  it("usa la cuenta con la que se sincronizo la tarea", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("cron_changed")?.(cronAdded());
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { source: "schedule", token: "del-autor", expires_in: 900 },
      socketUrl: SOCKET,
    });

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD, sessionKey: SESSION },
    );

    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(THREAD, "cron-1", "sales");
  });

  it("no toca nada en un turno normal, que ya trae su credencial", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());

    await hooks.get("before_agent_start")?.(
      {},
      { channel: "query", chatId: THREAD, sessionKey: SESSION },
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

  it("conserva la credencial humana y guarda por separado la del cron", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    rememberDelegatedAuth(THREAD, { token: "aun-viva", expires_in: 900 }, SOCKET);
    requestQueryScheduleAuth.mockResolvedValue({
      auth: { source: "schedule", token: "solo-del-cron", expires_in: 900 },
      socketUrl: SOCKET,
    });

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD, sessionKey: SESSION },
    );

    expect(requestQueryScheduleAuth).toHaveBeenCalledWith(THREAD, "cron-1", "sales");
    expect(getDelegatedAuth(THREAD)?.auth.token).toBe("aun-viva");
    expect(getDelegatedAuth(getQuerySession(SESSION)!.authKey!)?.auth.token).toBe("solo-del-cron");
  });

  it("avisa con instrucciones cuando Query niega la credencial", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    requestQueryScheduleAuth.mockResolvedValue(undefined);

    await hooks.get("before_agent_start")?.(
      {},
      { jobId: "cron-1", channel: "query", chatId: THREAD, sessionKey: SESSION },
    );

    expect(getDelegatedAuth(THREAD)).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("autorizacion programada no esta vigente"),
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
        { jobId: "cron-1", channel: "query", chatId: THREAD, sessionKey: SESSION },
      ),
    ).resolves.not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("socket caido"),
    );
  });
});
