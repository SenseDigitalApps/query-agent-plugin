import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuerySocketMonitor, confirmQueryScheduleSync } from "./socket.js";

function monitor() {
  const result = new QuerySocketMonitor({
    account: { accountId: "confirmation-test", url: "ws://localhost", stateFile: join(tmpdir(), "query-confirmation-unused.json") },
    cfg: {}, abortSignal: new AbortController().signal,
  } as never);
  const frames: any[] = [];
  (result as any).socket = { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) };
  return { result, frames };
}
const event = { type: "schedule.sync", thread_id: "24", client_msg_id: "", role: "system", content: "",
  data: { external_id: "cron-52", authorization_version: 2 } } as const;

describe("schedule authorization acknowledgement", () => {
  it("correlates concurrent mutations of the same cron by unique request ID", async () => {
    const { result, frames } = monitor();
    const first = result.confirmScheduleSync(event);
    const second = result.confirmScheduleSync(event);
    expect(frames[0].client_msg_id).not.toBe(frames[1].client_msg_id);
    const reply = async (index: number, runAs: number, externalId = "cron-52") =>
      (result as any).handleRawMessage(JSON.stringify({ type: "schedule.synced",
        client_msg_id: frames[index].client_msg_id,
        data: { external_id: externalId, authorized: true, run_as_user_id: runAs } }));
    await reply(0, 999, "different-cron");
    await reply(1, 2);
    expect(await second).toMatchObject({ run_as_user_id: 2 });
    await reply(0, 3);
    expect(await first).toMatchObject({ run_as_user_id: 3 });
    await reply(0, 999); // Replayed ACK cannot satisfy another request.
  });

  it("fails closed on timeout, disconnected socket and explicit unknown account", async () => {
    vi.useFakeTimers();
    try {
      const { result } = monitor();
      const pending = result.confirmScheduleSync(event);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toBeUndefined();
      (result as any).socket = undefined;
      expect(await result.confirmScheduleSync(event)).toBeUndefined();
      expect(await confirmQueryScheduleSync("foreign-account", event)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
