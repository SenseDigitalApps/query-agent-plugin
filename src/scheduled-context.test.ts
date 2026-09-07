import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import queryTools from "./query-tools.js";
import { rememberQuerySession } from "./query-session-store.js";
import { forgetDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import { scheduledCredential } from "./scheduled-context.js";

const request = vi.fn();
vi.mock("./socket.js", () => ({ requestQueryScheduleAuth: (...args: unknown[]) => request(...args) }));
const directory = mkdtempSync(join(tmpdir(), "query-isolated-test-"));
const original = { auth: process.env.QUERY_DELEGATED_AUTH_STATE_FILE, session: process.env.QUERY_SESSION_BINDING_STATE_FILE };
beforeAll(() => {
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(directory, "auth.json");
  process.env.QUERY_SESSION_BINDING_STATE_FILE = join(directory, "session.json");
});
afterAll(() => {
  if (original.auth === undefined) delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  else process.env.QUERY_DELEGATED_AUTH_STATE_FILE = original.auth;
  if (original.session === undefined) delete process.env.QUERY_SESSION_BINDING_STATE_FILE;
  else process.env.QUERY_SESSION_BINDING_STATE_FILE = original.session;
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => { request.mockReset(); vi.unstubAllGlobals(); forgetDelegatedAuth("isolated-a"); });

function tool(sessionKey: string) {
  const factories = new Map<string, any>();
  (queryTools as any).register({
    logger: { info: vi.fn(), warn: vi.fn() },
    registerTool: (factory: any, options: any) => factories.set(options.name, factory),
  });
  return factories.get("query_modules_list")({ sessionKey });
}
function bind(sessionKey = "cron-session") {
  rememberQuerySession(sessionKey, { threadId: "86", deliveryThreadId: "channel:86", accountId: "query", jobId: "real-job", authKey: "isolated-a" });
}

describe("isolated Query tools", () => {
  it("runs without thread_id and ignores a model-supplied delivery identity", async () => {
    bind();
    request.mockResolvedValue({ socketUrl: "wss://tenant-a.test/ws/", auth: { token: "scheduled-a", source: "schedule", thread_id: "13", expires_in: 900 } });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ modules: [] }) });
    vi.stubGlobal("fetch", fetch);
    const modules = tool("cron-session");
    expect(modules.parameters.required).not.toContain("thread_id");
    await modules.execute("call-1", {});
    await modules.execute("call-2", { thread_id: "86" });
    expect(request).toHaveBeenCalledWith("channel:86", "real-job", "query");
    expect(fetch.mock.calls[0][1].headers["X-Query-Delegated-Token"]).toBe("scheduled-a");
    expect(fetch.mock.calls[0][0].toString()).toContain("tenant-a.test");
  });

  it("renews the scheduled identity after expiry without a human token", async () => {
    bind();
    rememberDelegatedAuth("isolated-a", { token: "expired", source: "schedule", expires_at: "2000-01-01T00:00:00Z" }, "wss://tenant-a.test");
    request.mockResolvedValue({ socketUrl: "wss://tenant-a.test", auth: { token: "fresh", source: "schedule", thread_id: "13", expires_in: 900 } });
    expect((await scheduledCredential("cron-session"))?.credential.auth.token).toBe("fresh");
  });

  it("never falls back to a live human or another tenant on denial", async () => {
    bind();
    rememberDelegatedAuth("86", { token: "other-tenant-human", expires_in: 900 }, "wss://tenant-b.test");
    request.mockResolvedValue(undefined);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await tool("cron-session").execute("call-3", {});
    expect(result.details.error).toBe("query_schedule_authorization_missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves explicit human parameters and response shape", async () => {
    rememberQuerySession("human", { threadId: "13", accountId: "query" });
    rememberDelegatedAuth("13", { token: "human-a", expires_in: 900 }, "wss://tenant-a.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ modules: ["test"] }) }));
    const modules = tool("human");
    expect(modules.parameters.properties.thread_id).toBeDefined();
    const result = await modules.execute("call-4", { thread_id: "13" });
    expect(result.details).toEqual({ modules: ["test"] });
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves a scheduled binding created after the tool catalog", async () => {
    const modules = tool("late-cron");
    expect(modules.parameters.required).not.toContain("thread_id");
    bind("late-cron");
    request.mockResolvedValue(undefined);
    const result = await modules.execute("call-late", {});
    expect(result.details.error).toBe("query_schedule_authorization_missing");
  });
});
