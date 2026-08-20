import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  forgetDelegatedAuth,
  rememberDelegatedAuth,
} from "./delegated-store.js";
import { clearExternalAccountCache } from "./external-accounts.js";
import { setOpenClawConfigLoader } from "./google-accounts.js";
import { evaluateGoogleToolCall, registerQueryGoogleGuard } from "./google-guard.js";
import { forgetQuerySession, rememberQuerySession } from "./query-session-store.js";

const SOCKET = "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x";
const THREAD = "42";
const SESSION = "query:agent:42";

let stateDirectory: string;
let previousAuthFile: string | undefined;
let previousSessionFile: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), "query-google-guard-"));
  previousAuthFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  previousSessionFile = process.env.QUERY_SESSION_BINDING_STATE_FILE;
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(stateDirectory, "auth.json");
  process.env.QUERY_SESSION_BINDING_STATE_FILE = join(
    stateDirectory,
    "sessions.json",
  );
});

afterAll(() => {
  for (const [name, value] of [
    ["QUERY_DELEGATED_AUTH_STATE_FILE", previousAuthFile],
    ["QUERY_SESSION_BINDING_STATE_FILE", previousSessionFile],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(stateDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // Por defecto, una maquina sin cuentas de Google configuradas: asi las
  // pruebas de siempre siguen describiendo el comportamiento sin correo.
  setOpenClawConfigLoader(() => ({}));
});

/** Deja escrito en la config de la maquina el correo de una cuenta. */
function configuredAccounts(accounts: Record<string, { expectedEmail?: string }>) {
  setOpenClawConfigLoader(() => ({
    plugins: { entries: { "google-workspace": { config: { accounts } } } },
  }));
}

function requestBody(call = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call];
  return JSON.parse(String((init as RequestInit).body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOpenClawConfigLoader(undefined);
  clearExternalAccountCache();
  forgetDelegatedAuth(THREAD);
  forgetQuerySession(SESSION);
  delete process.env.QUERY_GOOGLE_GUARD_EXPECTED_EMAIL_PARAM;
  delete process.env.QUERY_EXTERNAL_ACCOUNT_GUARD_TOOLS;
});

function grantedResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function deniedResponse(body: Record<string, unknown>, status = 403) {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

function storeAuth(username = "juli", token = "token-de-juli") {
  rememberDelegatedAuth(
    THREAD,
    {
      token,
      expires_in: 900,
      identity: { id: 1, username, display_name: username },
      source: "turn",
    },
    SOCKET,
    "msg-1",
  );
}

function querySession(jobId?: string) {
  rememberQuerySession(SESSION, { threadId: THREAD, jobId });
}

async function callGoogle(params: Record<string, unknown>, toolName = "google_gmail_search") {
  return evaluateGoogleToolCall(
    { toolName, params },
    { toolName, sessionKey: SESSION },
  );
}

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

describe("guard de cuentas de Google en sesiones Query", () => {
  it("deja pasar las herramientas que no son de Google", async () => {
    querySession();
    const decision = await evaluateGoogleToolCall(
      { toolName: "read_file", params: {} },
      { toolName: "read_file", sessionKey: SESSION },
    );
    expect(decision).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no se mete en sesiones que no son de Query", async () => {
    storeAuth();
    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: {} },
      { toolName: "google_gmail_search", sessionKey: "discord:otra-sesion" },
    );
    expect(decision).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bloquea cuando la llamada no dice que cuenta usa", async () => {
    querySession();
    storeAuth();
    const decision = await callGoogle({ query: "facturas" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("explicitamente");
    // No hay fallback: Query ni siquiera llega a preguntarse cual seria.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bloquea cuando no hay credencial delegada vigente", async () => {
    querySession();
    const decision = await callGoogle({ accountId: "jcvargas" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("credencial vigente");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explica el caso del cron sin autor cuando no hay credencial", async () => {
    querySession("cron-nocturno");
    const decision = await callGoogle({ accountId: "jcvargas" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("cron-nocturno");
    expect(decision?.blockReason).toContain("autor");
  });

  it("deja pasar la cuenta que Query autoriza", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        provider: "google_workspace",
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
        source: "auto_email_match",
        user: { username: "juli" },
      }),
    );
    const decision = await callGoogle({ accountId: "jcvargas", query: "facturas" });
    expect(decision).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://apius.itsquery.com/api/v4/openclaw-agent/external-accounts/authorize-use/",
    );
    expect((init as RequestInit).headers).toMatchObject({
      "X-Query-Delegated-Token": "token-de-juli",
    });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      provider: "google_workspace",
      account_id: "jcvargas",
      thread_id: THREAD,
    });
    // Sin cuenta configurada localmente no hay correo que mandar, y Query
    // decide con lo unico que tiene: el vinculo que ya exista.
    expect(body).not.toHaveProperty("configured_email");
  });

  it("bloquea la cuenta de otra persona antes de llamar a Google", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_not_owned",
        detail: "La cuenta felotaca no esta vinculada a esta persona en Query.",
        allowed_account_ids: ["jcvargas"],
      }),
    );
    const decision = await callGoogle({ accountId: "felotaca" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("felotaca");
    // Nombra a la persona con la identidad que vino de Query, no con lo que el
    // agente crea recordar de la conversacion.
    expect(decision?.blockReason).toContain("juli");
    // Y le dice cual si puede usar, para que el reintento sea el correcto.
    expect(decision?.blockReason).toContain("jcvargas");
  });

  it("puede vigilar herramientas que no se llaman google_*", async () => {
    process.env.QUERY_EXTERNAL_ACCOUNT_GUARD_TOOLS = "gmail,gcal";
    querySession();
    storeAuth();
    const decision = await callGoogle({ query: "facturas" }, "gmail_search");
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("explicitamente");
  });

  it("encuentra la sesion por canal cuando el host no da sessionKey", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_not_owned",
        detail: "no es tuya",
        allowed_account_ids: ["jcvargas"],
      }),
    );
    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: { accountId: "felotaca" } },
      { toolName: "google_gmail_search", channelId: THREAD },
    );
    expect(decision?.block).toBe(true);
  });

  it("bloquea una cuenta pendiente de revision", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_needs_review",
        detail: "La cuenta comun espera que un administrador confirme de quien es.",
        allowed_account_ids: [],
      }),
    );
    const decision = await callGoogle({ accountId: "comun" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("binding_needs_review");
  });

  it("bloquea si no puede preguntarle a Query", async () => {
    querySession();
    storeAuth();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const decision = await callGoogle({ accountId: "jcvargas" });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("authorization_unavailable");
  });

  it("bloquea si el correo declarado no es el que Query tiene vinculado", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
      }),
    );
    const decision = await callGoogle({
      accountId: "jcvargas",
      expectedEmail: "felotaca@gmail.com",
    });
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("otro correo");
  });

  it("puede exigirle a Google el correo que Query vinculo", async () => {
    process.env.QUERY_GOOGLE_GUARD_EXPECTED_EMAIL_PARAM = "expectedEmail";
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
      }),
    );
    const decision = await callGoogle({ accountId: "jcvargas" });
    expect(decision?.params).toMatchObject({
      accountId: "jcvargas",
      expectedEmail: "jc.vargas2150@gmail.com",
    });
  });

  it("le manda a Query el correo que la maquina tiene escrito para esa cuenta", async () => {
    configuredAccounts({ jcvargas: { expectedEmail: "jc.vargas2150@gmail.com" } });
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
        source: "auto_email_match",
      }),
    );
    const decision = await callGoogle({ accountId: "jcvargas", query: "facturas" });
    expect(decision).toBeUndefined();
    expect(requestBody()).toMatchObject({
      account_id: "jcvargas",
      configured_email: "jc.vargas2150@gmail.com",
    });
  });

  it("solo manda el correo de la cuenta que la llamada pidio", async () => {
    configuredAccounts({
      jcvargas: { expectedEmail: "jc.vargas2150@gmail.com" },
      felotaca: { expectedEmail: "felotaca@gmail.com" },
    });
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_not_owned",
        detail: "no es tuya",
        allowed_account_ids: ["jcvargas"],
      }),
    );
    await callGoogle({ accountId: "felotaca" });
    expect(requestBody()).toMatchObject({
      account_id: "felotaca",
      configured_email: "felotaca@gmail.com",
    });
  });

  it("no manda nada si la cuenta configurada no declara expectedEmail", async () => {
    configuredAccounts({ jcvargas: { scopes: ["gmail.readonly"] } as never });
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_missing",
        detail: "no esta vinculada",
        allowed_account_ids: [],
      }),
    );
    const decision = await callGoogle({ accountId: "jcvargas" });
    // Comportamiento de siempre: sin correo configurado Query no funda nada y
    // la herramienta queda bloqueada.
    expect(decision?.block).toBe(true);
    expect(requestBody()).not.toHaveProperty("configured_email");
  });

  it("el correo configurado no sale de los parametros del modelo", async () => {
    // La llamada afirma un correo; la maquina tiene escrito otro. Son campos
    // distintos a proposito: el de la llamada solo puede bloquear, el de la
    // maquina es el unico que Query puede usar para fundar el vinculo.
    configuredAccounts({ jcvargas: { expectedEmail: "jc.vargas2150@gmail.com" } });
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "email_mismatch",
        detail: "otro correo",
        allowed_account_ids: ["jcvargas"],
      }),
    );
    await callGoogle({
      accountId: "jcvargas",
      expectedEmail: "el-correo-que-invento-el-modelo@gmail.com",
    });
    expect(requestBody()).toMatchObject({
      configured_email: "jc.vargas2150@gmail.com",
      authenticated_email: "el-correo-que-invento-el-modelo@gmail.com",
    });
  });

  it("no le mete el correo configurado a los parametros de la tool", async () => {
    configuredAccounts({ jcvargas: { expectedEmail: "jc.vargas2150@gmail.com" } });
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
      }),
    );
    // Las tools de ``openclaw-google-workspace`` solo declaran ``accountId``.
    // Anadirles una clave que su esquema no conoce romperia la llamada, y el
    // correo esperado ya lo valida ese plugin por su lado.
    const decision = await callGoogle({ accountId: "jcvargas", query: "facturas" });
    expect(decision).toBeUndefined();
  });

  it("no vuelve a preguntar lo mismo dentro del mismo turno", async () => {
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
      }),
    );
    await callGoogle({ accountId: "jcvargas" });
    await callGoogle({ accountId: "jcvargas" }, "google_calendar_list");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un subagente hereda el canal, y con el la restriccion", async () => {
    const { api, hooks } = fakeApi();
    registerQueryGoogleGuard(api as never);
    querySession();
    storeAuth();
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_not_owned",
        detail: "no es tuya",
        allowed_account_ids: ["jcvargas"],
      }),
    );

    const child = "query:agent:subagente";
    hooks.get("subagent_spawned")?.(
      {
        childSessionKey: child,
        agentId: "investigador",
        mode: "run",
        threadRequested: false,
        runId: "run-1",
        requester: { channel: "query", threadId: THREAD },
      },
      { requesterSessionKey: SESSION },
    );

    const decision = await evaluateGoogleToolCall(
      { toolName: "google_gmail_search", params: { accountId: "felotaca" } },
      { toolName: "google_gmail_search", sessionKey: child },
    );
    expect(decision?.block).toBe(true);
    forgetQuerySession(child);
  });

  it("una credencial de otra persona no hereda el permiso cacheado", async () => {
    querySession();
    storeAuth("juli", "token-de-juli");
    fetchMock.mockResolvedValue(
      grantedResponse({
        ok: true,
        account_id: "jcvargas",
        authenticated_email: "jc.vargas2150@gmail.com",
        status: "verified",
      }),
    );
    await callGoogle({ accountId: "jcvargas" });

    forgetDelegatedAuth(THREAD);
    storeAuth("felipe", "token-de-felipe");
    fetchMock.mockResolvedValue(
      deniedResponse({
        ok: false,
        error: "binding_not_owned",
        detail: "no es tuya",
        allowed_account_ids: ["felotaca"],
      }),
    );
    const decision = await callGoogle({ accountId: "jcvargas" });
    expect(decision?.block).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
