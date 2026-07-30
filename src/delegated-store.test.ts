import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  forgetDelegatedAuth,
  getDelegatedAuth,
  rememberDelegatedAuth,
  threadsWithDelegatedAuth,
} from "./delegated-store.js";

const SOCKET = "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x";
let stateDirectory: string;
let stateFile: string;
let previousStateFile: string | undefined;

beforeAll(() => {
  previousStateFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  stateDirectory = mkdtempSync(join(tmpdir(), "query-delegated-store-"));
  stateFile = join(stateDirectory, "delegated-auth.json");
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = stateFile;
});

afterAll(() => {
  if (previousStateFile === undefined) {
    delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  } else {
    process.env.QUERY_DELEGATED_AUTH_STATE_FILE = previousStateFile;
  }
  rmSync(stateDirectory, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  for (const threadId of threadsWithDelegatedAuth()) forgetDelegatedAuth(threadId);
});

describe("delegated auth store", () => {
  it("keeps one credential per thread so they never get mixed up", () => {
    // Dos personas distintas escribiendo al mismo agente en canales distintos.
    rememberDelegatedAuth(10, { token: "de-alicia", expires_in: 900 }, SOCKET);
    rememberDelegatedAuth(20, { token: "de-bruno", expires_in: 900 }, SOCKET);

    expect(getDelegatedAuth(10)?.auth.token).toBe("de-alicia");
    expect(getDelegatedAuth(20)?.auth.token).toBe("de-bruno");
    expect(getDelegatedAuth(99)).toBeUndefined();
  });

  it("forgets a credential once it expires instead of handing out a dead token", () => {
    vi.useFakeTimers();
    rememberDelegatedAuth(30, { token: "corta", expires_in: 60 }, SOCKET);
    expect(getDelegatedAuth(30)?.auth.token).toBe("corta");

    vi.advanceTimersByTime(61_000);
    expect(getDelegatedAuth(30)).toBeUndefined();
    expect(threadsWithDelegatedAuth()).not.toContain("30");
  });

  it("prefers the absolute expiry Query sent over the relative one", () => {
    vi.useFakeTimers();
    const expired = new Date(Date.now() - 1000).toISOString();
    rememberDelegatedAuth(
      40,
      { token: "ya-vencida", expires_at: expired, expires_in: 900 },
      SOCKET,
    );
    expect(getDelegatedAuth(40)).toBeUndefined();
  });

  it("ignores an event that carries no credential", () => {
    rememberDelegatedAuth(50, undefined, SOCKET);
    rememberDelegatedAuth(51, { token: "" }, SOCKET);
    expect(getDelegatedAuth(50)).toBeUndefined();
    expect(getDelegatedAuth(51)).toBeUndefined();
  });

  it("replaces the credential when the same thread sends a newer turn", () => {
    rememberDelegatedAuth(60, { token: "vieja", expires_in: 900 }, SOCKET);
    rememberDelegatedAuth(60, { token: "nueva", expires_in: 900 }, SOCKET);
    expect(getDelegatedAuth(60)?.auth.token).toBe("nueva");
  });

  it("keeps the client message id that can refresh tool credentials", () => {
    rememberDelegatedAuth(
      70,
      { token: "turno", expires_in: 900 },
      SOCKET,
      "client-123",
    );
    expect(getDelegatedAuth(70)?.clientMsgId).toBe("client-123");
  });

  it("sees a credential written by another process after its first lookup", () => {
    expect(getDelegatedAuth(80)).toBeUndefined();
    rememberDelegatedAuth(
      79,
      { token: "proceso-receptor", expires_in: 900 },
      SOCKET,
      "client-79",
    );
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as {
      version: number;
      records: Record<string, unknown>;
    };
    persisted.records["80"] = {
      auth: { token: "proceso-externo", expires_in: 900 },
      socketUrl: SOCKET,
      clientMsgId: "client-80",
      expiresAt: Date.now() + 900_000,
    };
    writeFileSync(stateFile, JSON.stringify(persisted), "utf8");

    expect(getDelegatedAuth(80)?.auth.token).toBe("proceso-externo");
    expect(getDelegatedAuth(80)?.clientMsgId).toBe("client-80");
  });
});
