import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { QuerySocketMonitor } from "./socket.js";
import { parseQueryEvent } from "./protocol.js";

async function until(test: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
}

it("rejects unscoped or user-authored abort commands", () => {
  for (const event of [
    { type: "turn.abort", role: "user", thread_id: "1", client_msg_id: "a", data: { request_id: "r" } },
    { type: "turn.abort", role: "system", client_msg_id: "a", data: { request_id: "r" } },
  ]) expect(parseQueryEvent(JSON.stringify(event))).toBeNull();
});

it("aborts only the selected dispatch, waits for drain and replays its terminal without rerunning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "query-stop-"));
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const lifetime = new AbortController();
  const runs = new Map<string, { signal: AbortSignal; finish: () => void }>();
  const abortRun = vi.fn(async () => true);
  const dispatch = vi.fn(async (params: any) => {
    params.onRunStarted({ runId: `run-${params.threadId}`, sessionKey: `session-${params.threadId}` });
    await new Promise<void>(resolve => runs.set(params.threadId, { signal: params.abortSignal, finish: resolve }));
    return { text: "Normal result", mediaUrls: [] };
  });
  const monitor = new QuerySocketMonitor({
    cfg: { channels: { query: {} } } as never,
    account: { accountId: "stop-test", enabled: true, configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/test/`, token: "synthetic",
      heartbeatMs: 5000, reconnectMinMs: 100, reconnectMaxMs: 1000,
      responseTimeoutMs: 0, stateFile: join(directory, "responses.json") },
    runtime: { error: vi.fn() } as never, abortSignal: lifetime.signal,
    getStatus: () => ({ accountId: "stop-test" }), setStatus: () => {}, dispatchMessage: dispatch, abortRun,
  });
  const connected = new Promise<WebSocket>(resolve => server.once("connection", resolve));
  try {
    await monitor.start();
    const socket = await connected;
    const events: any[] = [];
    socket.on("message", data => events.push(JSON.parse(data.toString())));
    const message = (thread: string) => ({ type: "message", role: "user", content: "work",
      thread_id: thread, client_msg_id: "same-id", data: { attachments: [] } });
    const stop = (thread: string) => ({ type: "turn.abort", role: "system", thread_id: thread,
      client_msg_id: "same-id", data: { request_id: "stop-1" } });
    socket.send(JSON.stringify(message("a")));
    socket.send(JSON.stringify(message("b")));
    await until(() => runs.size === 2);
    socket.send(JSON.stringify(stop("unknown")));
    await until(() => events.some(e => e.type === "turn.abort.result"));
    expect(runs.get("a")!.signal.aborted).toBe(false);
    socket.send(JSON.stringify(stop("a")));
    socket.send(JSON.stringify(stop("a")));
    await until(() => runs.get("a")!.signal.aborted);
    expect(runs.get("b")!.signal.aborted).toBe(false);
    expect(abortRun).toHaveBeenCalledExactlyOnceWith({ runId: "run-a", sessionKey: "session-a" });
    expect(events.some(e => e.data?.stop?.state === "stopped")).toBe(false);
    runs.get("a")!.finish();
    await until(() => events.some(e => e.data?.stop?.state === "stopped"));
    const terminal = events.find(e => e.data?.stop?.state === "stopped");
    expect(terminal).toMatchObject({ thread_id: "a", client_msg_id: "same-id", type: "message" });
    socket.send(JSON.stringify(message("a")));
    await until(() => events.filter(e => e.data?.stop?.state === "stopped").length === 2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    runs.get("b")!.finish();
    await until(() => events.some(e => e.thread_id === "b" && e.type === "message"));
  } finally {
    for (const run of runs.values()) run.finish();
    lifetime.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
