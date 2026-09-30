import { describe, expect, it, vi } from "vitest";
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({ callGatewayTool: vi.fn() }));
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { abortQueryRun, QueryTurnStop } from "./turn-stop.js";

describe("exact run stop", () => {
  it("uses only the server-bound run/session and rejects no-active-run as confirmation", async () => {
    const rpc = vi.mocked(callGatewayTool);
    rpc.mockResolvedValueOnce({ ok: true, status: "aborted", abortedRunId: "run-1" });
    expect(await abortQueryRun({ runId: "run-1", sessionKey: "session-1" })).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("sessions.abort", { timeoutMs: 10000 }, { key: "session-1", runId: "run-1" });
    rpc.mockResolvedValueOnce({ ok: true, status: "no-active-run", abortedRunId: null });
    expect(await abortQueryRun({ runId: "run-1", sessionKey: "session-1" })).toBe(false);
    expect(await abortQueryRun({ runId: "", sessionKey: "session-1" })).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("keeps Stop unconfirmed on RPC failure, but still interrupts the local dispatch", async () => {
    const rpc = vi.fn(async () => { throw new Error("gateway unavailable"); });
    const stop = new QueryTurnStop(rpc);
    stop.bind({ runId: "a", sessionKey: "b" });
    stop.request("idempotent");
    stop.request("idempotent");
    expect(await stop.confirmed()).toBe(false);
    expect(stop.controller.signal.aborted).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("cancels early admission without widening to a session abort", async () => {
    const rpc = vi.fn(async () => true);
    const stop = new QueryTurnStop(rpc);
    stop.request("early");
    expect(stop.controller.signal.aborted).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    stop.bind({ runId: "admitted-late", sessionKey: "s" });
    expect(await stop.confirmed()).toBe(true);
    expect(rpc).toHaveBeenCalledWith({ runId: "admitted-late", sessionKey: "s" });
  });
});
