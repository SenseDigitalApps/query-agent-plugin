import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuerySocketMonitor } from "./socket.js";
import type { QueryOutboundEvent, ResolvedQueryAccount } from "./types.js";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

function receive(socket: WebSocket): Promise<QueryOutboundEvent> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as QueryOutboundEvent));
    socket.once("error", reject);
  });
}

describe("QuerySocketMonitor", () => {
  it("acks immediately, returns the agent reply, and deduplicates a replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/test/`,
      token: "bot-secret",
      heartbeatMs: 5_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      responseTimeoutMs: 0,
      stateFile: join(directory, "responses.json"),
    };
    const dispatchMessage = vi.fn(async () => ({ text: "¡Hola!", mediaUrls: [] }));
    let status = { accountId: "default" } as never;
    const monitor = new QuerySocketMonitor({
      cfg: { channels: { query: {} } } as never,
      account,
      runtime: { error: vi.fn() } as never,
      abortSignal: controller.signal,
      getStatus: () => status,
      setStatus: (next) => {
        status = next as never;
      },
      dispatchMessage,
    });

    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    socket.send(
      JSON.stringify({
        type: "session.ready",
        role: "system",
        content: "",
        data: { protocol: "query-openclaw.v1", thread_id: "thread-7" },
      }),
    );
    const userMessage = JSON.stringify({
      type: "message",
      role: "user",
      content: "hola",
      client_msg_id: "msg-7",
      event_id: 7,
      data: { attachments: [] },
    });
    socket.send(userMessage);

    await expect(receive(socket)).resolves.toMatchObject({
      type: "activity",
      client_msg_id: "msg-7",
      data: { state: "working", stage: "received" },
    });
    await expect(receive(socket)).resolves.toMatchObject({
      type: "message",
      content: "¡Hola!",
      client_msg_id: "msg-7",
    });

    socket.send(userMessage);
    await expect(receive(socket)).resolves.toMatchObject({
      type: "message",
      content: "¡Hola!",
      client_msg_id: "msg-7",
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);

    controller.abort();
    await monitor.stop();
  });
});
