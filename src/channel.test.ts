import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { sendOutboundEvent, uploadTargetForOutbound } from "./channel.js";
import type { QueryConfig, QueryOutboundEvent } from "./types.js";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

function receive(socket: WebSocket): Promise<QueryOutboundEvent> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      socket.close(1000, "test received outbound event");
      resolve(JSON.parse(data.toString()) as QueryOutboundEvent);
    });
    socket.once("error", reject);
  });
}

describe("uploadTargetForOutbound", () => {
  it("uses the concrete thread id when present", () => {
    expect(uploadTargetForOutbound("channel:3", 3)).toBe("3");
    expect(uploadTargetForOutbound("channel:3", "42")).toBe("42");
  });

  it("normalizes OpenClaw channel targets for Query attachment uploads", () => {
    expect(uploadTargetForOutbound("channel:3")).toBe("3");
    expect(uploadTargetForOutbound("user:7")).toBe("user:7");
  });
});

describe("sendOutboundEvent", () => {
  it("falls back to a direct Query socket when no gateway monitor is active", async () => {
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    cleanupTasks.push(
      async () => {
        for (const client of server.clients) client.terminate();
        server.close();
      },
    );

    const event = new Promise<QueryOutboundEvent>((resolve, reject) => {
      server.once("connection", (socket) => {
        receive(socket).then(resolve, reject);
      });
      server.once("error", reject);
    });
    const sendResult = sendOutboundEvent({
      cfg: {
        channels: {
          query: {
            accounts: {
              cli: {
                enabled: true,
                url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/8/`,
                token: "bot-token",
              },
            },
          },
        },
      } as QueryConfig,
      accountId: "cli",
      to: "channel:53",
      threadId: "53",
      text: "Adjunto listo",
      deliveryQueueId: "test-cli-fallback",
    });
    await expect(event).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: "Adjunto listo",
      client_msg_id: "test-cli-fallback",
      thread_id: "53",
      data: {
        source: "openclaw_outbound",
        to: "channel:53",
        thread_id: "53",
      },
    });
    await expect(sendResult).resolves.toMatchObject({
      channel: "query",
      messageId: "test-cli-fallback",
      chatId: "channel:53",
      conversationId: "53",
      meta: { accountId: "cli" },
    });
  }, 10_000);
});
