import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { externalContextForRun, pinExternalRun, rememberExternalContext } from "./external-context.js";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("./socket.js", () => ({ refreshQueryDelegatedAuth: refresh }));
let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.QUERY_EXTERNAL_CONTEXT_DIR;
  root = mkdtempSync(join(tmpdir(), "query-scoped-context-test-"));
  process.env.QUERY_EXTERNAL_CONTEXT_DIR = root;
  refresh.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.QUERY_EXTERNAL_CONTEXT_DIR;
  else process.env.QUERY_EXTERNAL_CONTEXT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
function remember(account: string, sender: string, msg = "first") {
  rememberExternalContext({ sessionKey: "same-session", senderId: sender, threadId: "42",
    queryAccountId: account, socketUrl: `wss://${account}.example/ws/`, agentToken: "synthetic-bot",
    clientMsgId: msg, auth: { token: `synthetic-${account}-${sender}`, expires_in: 900,
      identity: { id: Number(sender) }, external_account_identity: { id: Number(sender) } } });
}
describe("external account context isolation", () => {
  it("keeps equal thread, session and sender ids separate across Query accounts", async () => {
    remember("a", "1");
    remember("b", "1");
    pinExternalRun("run-a", "same-session", "1", "a");
    pinExternalRun("run-b", "same-session", "1", "b");
    expect((await externalContextForRun("run-a"))?.socketUrl).toBe("wss://a.example/ws/");
    expect((await externalContextForRun("run-b"))?.socketUrl).toBe("wss://b.example/ws/");
  });
  it("pins a turn before another speaker or later message arrives", async () => {
    remember("a", "1");
    pinExternalRun("first-run", "same-session", "1", "a");
    remember("a", "2", "support-turn");
    remember("a", "1", "second-turn");
    expect((await externalContextForRun("first-run"))?.clientMsgId).toBe("first");
  });
  it("refreshes the original message internally without erasing its context", async () => {
    vi.useFakeTimers();
    remember("a", "1");
    pinExternalRun("first-run", "same-session", "1", "a");
    vi.advanceTimersByTime(901000);
    refresh.mockResolvedValue({ token: "refreshed", expires_in: 900, identity: { id: 1 }, external_account_identity: { id: 1 } });
    expect((await externalContextForRun("first-run"))?.auth.token).toBe("refreshed");
    expect(refresh).toHaveBeenCalledWith("42", "wss://a.example/ws/", "first");
  });
  it("does not adopt a different beneficiary on refresh", async () => {
    vi.useFakeTimers();
    remember("a", "1");
    pinExternalRun("first-run", "same-session", "1", "a");
    vi.advanceTimersByTime(901000);
    refresh.mockResolvedValue({ token: "other", identity: { id: 1 }, external_account_identity: { id: 2 } });
    await expect(externalContextForRun("first-run")).rejects.toThrow("query_delegation_identity_changed");
  });
  it("does not require the new store for existing unscoped executions", async () => {
    expect(await externalContextForRun()).toBeUndefined();
    expect(await externalContextForRun("old-run")).toBeUndefined();
  });
});
