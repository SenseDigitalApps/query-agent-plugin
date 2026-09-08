import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { forgetDelegatedAuth } from "./delegated-store.js";
import type { QueryOutboundEvent, ResolvedQueryAccount } from "./types.js";

/**
 * La respuesta de voz automatica solia viajar como `data:audio/mpeg;base64,...`
 * porque el mp3 que genera node-edge-tts nunca se subia a Query: Flutter
 * exige una URL publica y descargable, asi que mostraba el adjunto como roto
 * aunque en Query Web sonara bien (los navegadores si soportan data URI).
 * Estas pruebas cubren que ahora se sube como cualquier otro artifact.
 */

const FAKE_TTS_BIN = fileURLToPath(new URL("./fixtures/fake-tts.mjs", import.meta.url));

let QuerySocketMonitor: typeof import("./socket.js")["QuerySocketMonitor"];

beforeAll(async () => {
  process.env.QUERY_TTS_BIN = FAKE_TTS_BIN;
  process.env.QUERY_REPLY_AUDIO = "1";
  process.env.QUERY_REPLY_AUDIO_MODE = "requested";
  ({ QuerySocketMonitor } = await import("./socket.js"));
}, 30_000);

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

describe("QuerySocketMonitor assistant voice replies", () => {
  it("uploads the synthesized reply as a real Query attachment, not a data URI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-audio-"));
    let receivedToken = "";
    let receivedKind = "";
    let receivedMimeType = "";
    const httpServer = createServer((request, response) => {
      if (request.url?.includes("/attachments/")) {
        receivedToken = String(request.headers["x-query-delegated-token"] ?? "");
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          receivedKind = /name="kind"\r\n\r\n([^\r\n]+)/.exec(body)?.[1] ?? "";
          receivedMimeType = /name="mime_type"\r\n\r\n([^\r\n]+)/.exec(body)?.[1] ?? "";
          response.writeHead(201, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: 501,
              kind: "audio",
              name: "respuesta-openclaw.mp3",
              mime_type: "audio/mpeg",
              size: 7,
              url: "https://query.test/media/agent_chat/respuesta-openclaw.mp3",
            }),
          );
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const server = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      forgetDelegatedAuth("thread-voice");
      await rm(directory, { recursive: true, force: true });
    });

    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/8/`,
      token: "bot-secret",
      heartbeatMs: 5_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      responseTimeoutMs: 0,
      stateFile: join(directory, "responses.json"),
    };
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
      dispatchMessage: vi.fn(async () => ({
        text: "Aqui tienes la respuesta.",
        mediaUrls: [],
      })),
    });

    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    socket.send(
      JSON.stringify({
        type: "session.ready",
        role: "system",
        content: "",
        data: { protocol: "query-openclaw.v2", thread_id: "thread-voice" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "mandame la respuesta en nota de voz",
        client_msg_id: "msg-voice",
        thread_id: "thread-voice",
        data: {
          attachments: [],
          delegated_auth: { token: "delegated-voice-token", expires_in: 900 },
        },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({ type: "activity" });
    const response = await receive(socket);

    expect(receivedToken).toBe("delegated-voice-token");
    expect(receivedKind).toBe("audio");
    expect(receivedMimeType).toBe("audio/mpeg");
    expect(response).toMatchObject({
      type: "message",
      content: "Aqui tienes la respuesta.",
      data: {
        attachments: [
          {
            id: 501,
            kind: "audio",
            mime_type: "audio/mpeg",
            is_voice_note: true,
            voice: true,
            url: "https://query.test/media/agent_chat/respuesta-openclaw.mp3",
          },
        ],
      },
    });
    const raw = JSON.stringify(response);
    expect(raw).not.toContain("data:audio");
    expect(raw).not.toContain("base64");
    expect(raw).not.toContain(directory);

    controller.abort();
    await monitor.stop();
  }, 20_000);

  it("drops the voice reply instead of falling back to a data URI when there is no upload credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-audio-noauth-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const warnings = vi.fn();
    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/9/`,
      token: "bot-secret",
      heartbeatMs: 5_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      responseTimeoutMs: 0,
      stateFile: join(directory, "responses.json"),
    };
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
      dispatchMessage: vi.fn(async () => ({
        text: "Aqui tienes la respuesta.",
        mediaUrls: [],
      })),
      log: { warn: warnings },
    });

    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    socket.send(
      JSON.stringify({
        type: "session.ready",
        role: "system",
        content: "",
        data: { protocol: "query-openclaw.v2", thread_id: "thread-voice-noauth" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "mandame la respuesta en nota de voz",
        client_msg_id: "msg-voice-noauth",
        thread_id: "thread-voice-noauth",
        data: { attachments: [] },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({ type: "activity" });
    const response = await receive(socket);

    expect(response.content).toBe("Aqui tienes la respuesta.");
    const attachments = (response as { data?: { attachments?: unknown[] } }).data?.attachments ?? [];
    expect(attachments).toHaveLength(0);
    expect(JSON.stringify(response)).not.toContain("data:audio");
    expect(
      warnings.mock.calls.some(([line]) =>
        String(line).includes("query_assistant_audio_upload_blocked"),
      ),
    ).toBe(true);

    controller.abort();
    await monitor.stop();
  }, 20_000);
});
