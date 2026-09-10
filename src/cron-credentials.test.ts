import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const confirmQueryScheduleSync = vi.fn();

// El hook importa socket.js de forma perezosa; se intercepta el modulo entero
// para no levantar un WebSocket real en las pruebas.
vi.mock("./socket.js", () => ({
  sendQueryOutboundEvent: vi.fn(),
  queryAccountIdForSocketUrl: vi.fn(() => "sales"),
  requestQueryScheduleAuth: (...args: unknown[]) =>
    requestQueryScheduleAuth(...args),
  confirmQueryScheduleSync: (...args: unknown[]) => confirmQueryScheduleSync(...args),
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
  confirmQueryScheduleSync.mockReset();
});

type Hook = (...args: any[]) => unknown;

function confirmAs(send: ReturnType<typeof vi.fn>, userId: number) {
  confirmQueryScheduleSync.mockImplementation(async (account, event) => {
    send(account, event);
    return { authorized: true, external_id: event.data.external_id, run_as_user_id: userId };
  });
  requestQueryScheduleAuth.mockImplementation(async (_thread, externalId) => ({
    socketUrl: SOCKET,
    auth: { token: "scheduled-only", source: "schedule", external_id: externalId, identity: { id: userId } },
  }));
}

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

describe("eliminacion desde el chat", () => {
  async function setup(options: { enabled?: boolean; accountId?: string; authorized?: boolean; retained?: boolean; failure?: boolean; syncFailure?: boolean; scheduled?: boolean } = {}) {
    const { api, hooks, tools } = fakeApi();
    const job = { id: "remove-target", name: "Saludo", agentId: "query", enabled: options.enabled ?? true,
      delivery: { channel: "query", accountId: options.accountId ?? "sales", to: "channel:86" } };
    let jobs = [job];
    const remove = vi.fn(async () => {
      if (options.failure) return { removed: false };
      if (!options.retained) jobs = [];
      return { removed: true };
    });
    const update = vi.fn();
    const send = vi.fn(() => { if (options.syncFailure) throw new Error("offline"); });
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.({}, { getCron: () => ({ list: vi.fn(async () => jobs), remove, update }) });
    rememberQuerySession(SESSION, { threadId: ORIGIN_THREAD, accountId: "sales", ...(options.scheduled ? { jobId: "running-cron" } : {}) });
    rememberExternalContext({ sessionKey: SESSION, senderId: "7", threadId: ORIGIN_THREAD,
      queryAccountId: "sales", socketUrl: SOCKET, agentToken: "agent-token", clientMsgId: "remove-message",
      auth: { token: "delegated-creator", expires_in: 900, identity: { id: 7 } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ targets: options.authorized === false ? [] : [{ thread_id: "86" }] }) }));
    const tool = tools[0]({ messageChannel: "query", sessionKey: SESSION, requesterSenderId: "7", agentAccountId: "sales", agentId: "query" });
    return { tool, remove, update, send };
  }

  it.each([true, false])("elimina una tarea enabled=%s y sincroniza la baja sin desactivarla", async (enabled) => {
    const { tool, remove, update, send } = await setup({ enabled });
    expect(tool.parameters.anyOf.some((variant: any) => variant.properties.action.const === "remove")).toBe(true);
    const result = await tool.execute("remove-call", { action: "remove", job_id: "remove-target" });
    expect(result.details).toMatchObject({ ok: true, action: "removed", removed: true, job_id: "remove-target" });
    expect(remove).toHaveBeenCalledWith("remove-target");
    expect(update).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("sales", expect.objectContaining({ type: "schedule.sync", data: expect.objectContaining({ action: "removed", external_id: "remove-target", delegated_token: "delegated-creator" }) }));
  });

  it.each([
    [{ authorized: false }, "query_cron_destination_not_authorized"],
    [{ accountId: "other" }, "query_cron_not_query_owned"],
    [{ scheduled: true }, "query_cron_creator_authorization_missing"],
  ] as const)("rechaza eliminar sin acceso: %s", async (options, error) => {
    const { tool, remove } = await setup(options);
    const result = await tool.execute("remove-call", { action: "remove", job_id: "remove-target" });
    expect(result.details).toMatchObject({ ok: false, error });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    [{ retained: true }, "query_cron_remove_unconfirmed"],
    [{ failure: true }, "query_cron_remove_failed"],
  ] as const)("no anuncia exito si el programador no elimina: %s", async (options, error) => {
    const { tool, send } = await setup(options);
    const result = await tool.execute("remove-call", { action: "remove", job_id: "remove-target" });
    expect(result.details).toMatchObject({ ok: false, error });
    expect(send).not.toHaveBeenCalled();
  });

  it("distingue borrado confirmado de sincronizacion pendiente", async () => {
    const { tool } = await setup({ syncFailure: true });
    const result = await tool.execute("remove-call", { action: "remove", job_id: "remove-target" });
    expect(result.details).toMatchObject({ ok: false, removed: true, synchronization_pending: true, removed_job_id: "remove-target" });
  });
});

describe("registro de la tarea", () => {
  it.each(["add", "update", "run"])("%s espera el acuse y falla sin autorización, sin iniciar el agente", async (action) => {
    const { api, hooks, tools } = fakeApi();
    const job = { id: "support-cron", agentId: "query", name: "Support", sessionTarget: "isolated",
      delivery: { channel: "query", accountId: "sales", to: "channel:86" } };
    const add = vi.fn().mockResolvedValue(job);
    const update = vi.fn().mockResolvedValue(job);
    const run = vi.fn();
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("gateway_start")?.({}, { getCron: () => ({
      list: vi.fn().mockResolvedValue([job]), add, update, run,
    }) });
    rememberQuerySession(SESSION, { threadId: "24", accountId: "sales" });
    rememberExternalContext({ sessionKey: SESSION, senderId: "1", threadId: "24",
      queryAccountId: "sales", socketUrl: SOCKET, agentToken: "agent", clientMsgId: "support-message",
      auth: { token: "signed-support", expires_in: 900, identity: { id: 1 }, external_account_identity: { id: 2 } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ targets: [{ thread_id: "86" }] }) }));
    const tool = tools[0]({ messageChannel: "query", sessionKey: SESSION, requesterSenderId: "1",
      agentAccountId: "sales", agentId: "query" });
    const params = action === "add" ? { action, job } : { action, job_id: job.id, patch: {} };
    let settle: (value: unknown) => void = () => {};
    confirmQueryScheduleSync.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    let finished = false;
    const pending = tool.execute("support-call", params).then((result: any) => { finished = true; return result; });
    await vi.waitFor(() => expect(confirmQueryScheduleSync).toHaveBeenCalled());
    expect(finished).toBe(false);
    expect(run).not.toHaveBeenCalled();
    if (action === "add") {
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      expect(update).not.toHaveBeenCalled();
    }
    settle({ external_id: job.id, authorized: false, error: "support_delegation_revoked" });
    expect((await pending).details).toMatchObject({ ok: false, error: "query_schedule_authorization_rejected",
      ...(action === "add" ? { disabled: true, ready: false, persisted_job_ids: [job.id] } : {}) });
    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    for (const [reply, error] of [
      [undefined, "query_schedule_authorization_unconfirmed"],
      [{ external_id: job.id, authorized: true, run_as_user_id: 1 }, "query_schedule_authorization_identity_mismatch"],
    ] as const) {
      confirmQueryScheduleSync.mockResolvedValue(reply);
      expect((await tool.execute("retry", params)).details).toMatchObject({ ok: false, error });
    }
    confirmQueryScheduleSync.mockResolvedValue({ external_id: job.id, authorized: true, run_as_user_id: 2 });
    requestQueryScheduleAuth.mockResolvedValue(undefined);
    expect((await tool.execute("preflight", params)).details).toMatchObject({ ok: false, error: "query_schedule_authorization_missing" });
    expect(run).not.toHaveBeenCalled();
    requestQueryScheduleAuth.mockResolvedValue({ socketUrl: SOCKET, auth: {
      token: "schedule", source: "schedule", external_id: job.id, identity: { id: 2 },
    } });
    run.mockResolvedValue({ ran: true, summary: "query_schedule_authorization_missing" });
    const result = await tool.execute("authorized", params);
    expect(result.details.ok).toBe(action !== "run");
    if (action === "add") expect(update).toHaveBeenLastCalledWith(job.id, { enabled: true });
    if (action === "run") expect(result.details.error).toBe("query_schedule_authorization_missing");
    expect(getDelegatedAuth("24")).toBeUndefined();
    job.delivery.accountId = "foreign";
    add.mockClear(); update.mockClear(); run.mockClear();
    const foreign = await tool.execute("foreign", params);
    expect(foreign.details).toMatchObject({ ok: false, error: action === "add"
      ? "query_cron_cross_tenant_destination" : "query_cron_not_query_owned" });
    expect(add).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["success", "disabled", "credential_missing", "activation_failure", "rollback_failure"])(
    "un cron nuevo solo se activa tras confirmar credencial (%s)", async (outcome) => {
      const { api, hooks, tools } = fakeApi();
      const jobs: any[] = [];
      const add = vi.fn(async (input) => { const job = { ...input, id: "staged-cron" }; jobs.push(job); return job; });
      const update = vi.fn(async (id, patch) => {
        if (!patch.enabled && outcome === "rollback_failure") throw new Error("storage unavailable");
        Object.assign(jobs.find((job) => job.id === id), patch);
        if (patch.enabled && ["activation_failure", "rollback_failure"].includes(outcome)) throw new Error("activation failed");
        return jobs[0];
      });
      registerQueryCronSync(api as never, vi.fn());
      await hooks.get("gateway_start")?.({}, { getCron: () => ({ list: async () => jobs, add, update }) });
      rememberQuerySession(SESSION, { threadId: "24", accountId: "sales" });
      rememberExternalContext({ sessionKey: SESSION, senderId: "1", threadId: "24",
        queryAccountId: "sales", socketUrl: SOCKET, agentToken: "agent", clientMsgId: "staged-message",
        auth: { token: "signed-support", expires_in: 900, identity: { id: 1 }, external_account_identity: { id: 2 } } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ targets: [{ thread_id: "24" }] }) }));
      confirmQueryScheduleSync.mockImplementation(async (_account, event) => {
        expect(jobs[0].enabled).toBe(false);
        expect(event.data.delegated_token).toBe("signed-support");
        return { authorized: true, external_id: jobs[0].id, run_as_user_id: 2 };
      });
      let settle: (value: unknown) => void = () => {};
      requestQueryScheduleAuth.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
      const tool = tools[0]({ messageChannel: "query", sessionKey: SESSION, requesterSenderId: "1",
        agentAccountId: "sales", agentId: "query" });
      const pending = tool.execute("staged-call", { action: "add", job: {
        name: "Inbox", enabled: outcome !== "disabled", schedule: { kind: "cron", expr: "0 4 * * *" },
        payload: { kind: "agentTurn", message: "Preserved prompt" },
        delivery: { channel: "query", accountId: "sales", to: "channel:24" },
      } });
      await vi.waitFor(() => expect(requestQueryScheduleAuth).toHaveBeenCalled());
      expect(jobs[0].enabled).toBe(false);
      expect(update).not.toHaveBeenCalled();
      settle(outcome === "credential_missing" ? undefined : { auth: {
        token: "schedule", source: "schedule", external_id: jobs[0].id, identity: { id: 2 },
      } });
      const result = await pending;
      expect(result.details.ok).toBe(["success", "disabled"].includes(outcome));
      expect(jobs[0].enabled).toBe(["success", "rollback_failure"].includes(outcome));
      expect(jobs[0].payload.message).toBe("Preserved prompt");
      expect(jobs).toHaveLength(1);
      if (outcome === "rollback_failure") expect(result.details).toMatchObject({ disabled: false, disable_error: "query_cron_disable_unconfirmed" });
      if (outcome === "activation_failure") expect(result.details).toMatchObject({ disabled: true, ready: false });
    },
  );
  it("expone un gestor propio en Query y repara el ID existente con el actor delegado", async () => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    confirmAs(send, 77);
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
    confirmAs(send, 88);
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
    confirmAs(send, 77);
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

  it.each([
    ["ok", undefined, undefined],
    ["error", "query_schedule_authorization_missing", "query_schedule_authorization_missing"],
    ["error", "business failure", "query_cron_run_failed"],
    ["stale", undefined, "query_cron_run_result_unconfirmed"],
    ["not_started", undefined, "query_cron_run_not_started"],
    ["false_ok", undefined, "query_schedule_authorization_missing"],
    ["no_completion", undefined, "query_cron_run_result_unconfirmed"],
  ])("run consulta el resultado persistido (%s), no solo el recibo ok", async (status, lastError, expectedError) => {
    const { api, hooks, tools } = fakeApi();
    const send = vi.fn();
    confirmAs(send, 77);
    const job = {
      id: "run-me",
      agentId: "query",
      name: "Run",
      sessionTarget: "isolated",
      delivery: { channel: "query", accountId: "sales", to: "channel:86" },
      state: {} as Record<string, unknown>,
    };
    const run = vi.fn().mockImplementation(async () => {
      const nativeStatus = ["stale", "false_ok", "no_completion"].includes(status!) ? "ok" : status;
      job.state = { lastRunStatus: nativeStatus,
        lastRunAtMs: status === "stale" ? 1 : Date.now(), lastError };
      if (status !== "no_completion") await hooks.get("cron_changed")?.({
        action: "finished", jobId: job.id, job, status: nativeStatus, runAtMs: job.state.lastRunAtMs,
        summary: status === "false_ok" ? "No se ejecutó: query_schedule_authorization_missing" : "Completed",
      });
      return { ok: true, ran: status !== "not_started" };
    });
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
    expect(result.details).toMatchObject(expectedError ? { ok: false, error: expectedError }
      : { ok: true, action: "run", job_id: "run-me" });
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
  it("el scheduler nativo persiste error aunque run() devuelva ok:true", async () => {
    const directory = mkdtempSync(join(tmpdir(), "query-native-cron-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = directory;
    let cron: any;
    let closeDatabase: (() => void) | undefined;
    try {
      // Exercise the installed, pinned runtime without changing node_modules.
      const dist = dirname(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-runtime")));
      const loadExport = async (prefix: string, symbol: string) => {
        for (const name of readdirSync(dist).filter((name) => name.startsWith(prefix) && name.endsWith(".js"))) {
          const alias = readFileSync(join(dist, name), "utf8").match(new RegExp(`\\b${symbol} as (\\w+)`))?.[1];
          if (alias) return (await import(/* @vite-ignore */ pathToFileURL(join(dist, name)).href))[alias];
        }
        throw new Error(`Installed OpenClaw runtime is missing ${symbol}`);
      };
      const buildService = await loadExport("server-cron-", "buildGatewayCronService");
      const resolveOutcome = await loadExport("run-session-state-", "resolveCronPayloadOutcome");
      const loadStore = await loadExport("store-", "loadCronJobsStoreWithConfigJobsReadOnly");
      closeDatabase = await loadExport("openclaw-state-db-", "closeOpenClawStateDatabase");
      const store = join(directory, "jobs.json");
      ({ cron } = buildService({ cfg: { cron: { enabled: false, store },
        session: { store: join(directory, "sessions.json") },
        agents: { list: [{ id: "query", default: true, workspace: directory }] } },
        deps: {}, broadcast: vi.fn() }));
      const job = await cron.add({ name: "Authorization gate test", agentId: "query", enabled: true,
        schedule: { kind: "every", everyMs: 86_400_000 }, sessionTarget: "isolated", wakeMode: "now",
        payload: { kind: "agentTurn", message: "No real business work in this test" },
        delivery: { mode: "none", channel: "query", accountId: "sales", to: THREAD } });
      const { api, hooks } = fakeApi();
      registerQueryCronSync(api as never, vi.fn());
      await hooks.get("cron_changed")?.({ action: "added", jobId: job.id, job });
      requestQueryScheduleAuth.mockResolvedValue(undefined);
      const model = vi.fn();
      cron.state.deps.runIsolatedAgentJob = async () => {
        const decision = await hooks.get("before_agent_run")!({}, {
          jobId: job.id, channel: "query", chatId: THREAD, sessionKey: SESSION,
        });
        if (decision.outcome === "pass") model();
        expect(decision.outcome).toBe("block");
        // Envelope emitted by OpenClaw's embedded/CLI harness on hook_block.
        const outcome = resolveOutcome({ payloads: [{ text: decision.message, isError: true }],
          runLevelError: { kind: "hook_block", message: decision.message } });
        return { status: outcome.hasFatalErrorPayload ? "error" : "ok",
          error: outcome.embeddedRunError, summary: outcome.summary };
      };
      const receipt = await cron.run(job.id, "force");
      expect(receipt).toMatchObject({ ok: true, ran: true });
      expect(model).not.toHaveBeenCalled();
      const persisted = (await loadStore(store)).store.jobs.find((item: any) => item.id === job.id);
      expect(persisted.state.lastRunStatus).toBe("error");
      expect(persisted.state.lastError).toContain("query_schedule_authorization_missing");
    } finally {
      cron?.stop();
      closeDatabase?.();
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(["denied", "transport", "foreign_credential", "authorized"])(
    "el gate automático bloquea antes del modelo: %s", async (scenario) => {
      const { api, hooks } = fakeApi();
      registerQueryCronSync(api as never, vi.fn());
      await hooks.get("cron_changed")?.(cronAdded("gate-cron"));
      rememberDelegatedAuth(THREAD, { token: "human-admin", identity: { id: 1 }, expires_in: 900 }, SOCKET);
      if (scenario === "transport") requestQueryScheduleAuth.mockRejectedValue(new Error("disconnected"));
      else requestQueryScheduleAuth.mockResolvedValue(scenario === "denied" ? undefined : {
        socketUrl: SOCKET, auth: { source: "schedule", token: "scheduled-beneficiary", expires_in: 900,
          external_id: scenario === "foreign_credential" ? "different-cron" : "gate-cron", identity: { id: 2 } },
      });
      const gate = hooks.get("before_agent_run")!;
      const context = { jobId: "gate-cron", channel: "query", chatId: THREAD, sessionKey: SESSION };
      const decision = await gate({ prompt: "Do work" }, context);
      const model = vi.fn();
      if (decision.outcome === "pass") model();
      expect(decision.outcome).toBe(scenario === "authorized" ? "pass" : "block");
      expect(model).toHaveBeenCalledTimes(scenario === "authorized" ? 1 : 0);
      if (scenario !== "authorized") expect(decision).toMatchObject({ category: "query_schedule_authorization_missing" });
      expect(getDelegatedAuth(THREAD)?.auth.token).toBe("human-admin");
      expect(requestQueryScheduleAuth).toHaveBeenCalledWith(THREAD, "gate-cron", "sales");
    },
  );

  it("el gate pasa turnos humanos y crones ajenos, pero bloquea Query sin cuenta o destino", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    const gate = hooks.get("before_agent_run")!;
    expect(await gate({}, { channel: "query", sessionKey: SESSION })).toEqual({ outcome: "pass" });
    expect(await gate({}, { jobId: "unrelated", channel: "discord" })).toEqual({ outcome: "pass" });
    expect((await gate({}, { jobId: "unroutable", channel: "query" })).outcome).toBe("block");
    expect(requestQueryScheduleAuth).not.toHaveBeenCalled();
  });
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
