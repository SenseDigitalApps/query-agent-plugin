import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("uploads an outbound local artifact with the bot credential and never sends its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-outbound-artifact-"));
    const filePath = join(directory, "reporte.html");
    await writeFile(filePath, "<h1>Reporte</h1>", "utf8");
    let uploadToken = "";
    const httpServer = createServer((request, response) => {
      if (request.url?.includes("/attachments/")) {
        uploadToken = String(request.headers["x-agent-token"] ?? "");
        request.resume();
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 44,
            kind: "file",
            name: "reporte.html",
            mime_type: "text/html",
            url: "https://query.test/media/agent_chat/reporte.html",
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const server = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    cleanupTasks.push(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const event = new Promise<QueryOutboundEvent>((resolve, reject) => {
      server.once("connection", (socket) => receive(socket).then(resolve, reject));
      server.once("error", reject);
    });
    await sendOutboundEvent({
      cfg: {
        channels: {
          query: {
            accounts: {
              cron: {
                enabled: true,
                url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/8/`,
                token: "bot-cron-token",
              },
            },
          },
        },
      } as QueryConfig,
      accountId: "cron",
      to: "channel:53",
      threadId: "53",
      text: `Reporte listo: ${filePath}`,
      deliveryQueueId: "cron-artifact-1",
    });

    const sent = await event;
    expect(uploadToken).toBe("bot-cron-token");
    expect(sent.content).toBe(
      "Reporte listo: https://query.test/media/agent_chat/reporte.html",
    );
    expect(sent.content).not.toContain(filePath);
    expect(sent.data.attachments).toEqual([
      expect.objectContaining({
        id: 44,
        name: "reporte.html",
        url: "https://query.test/media/agent_chat/reporte.html",
      }),
    ]);
  }, 10_000);
});
