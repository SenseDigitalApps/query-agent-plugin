import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuerySocketMonitor, sendQueryOutboundEvent } from "./socket.js";
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

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > 2_000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for condition."));
      }
    }, 10);
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
    const dispatchMessage = vi.fn(
      async (params: {
        onActivity?: (activity: {
          label: string;
          stage?: string;
          toolName?: string;
          progress?: number;
        }) => void;
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        params.onActivity?.({
          label: "Consultando inventario",
          stage: "tool",
          toolName: "inventario",
          progress: 40,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { text: "¡Hola!", mediaUrls: [] };
      },
    );
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
      type: "activity",
      client_msg_id: "msg-7",
      data: {
        label: "Consultando inventario",
        stage: "tool",
        tool_name: "inventario",
        progress: 40,
      },
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

  it("does not send a blank terminal message when the agent returns no visible content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-empty-"));
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
    const runtimeError = vi.fn();
    const dispatchMessage = vi.fn(async () => ({ text: "   ", mediaUrls: [] }));
    let status = { accountId: "default" } as never;
    const monitor = new QuerySocketMonitor({
      cfg: { channels: { query: {} } } as never,
      account,
      runtime: { error: runtimeError } as never,
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
        data: { protocol: "query-openclaw.v1", thread_id: "thread-empty" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "hola",
        client_msg_id: "msg-empty",
        event_id: 7,
        data: { attachments: [] },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({
      type: "activity",
      client_msg_id: "msg-empty",
    });
    await expect(receive(socket)).resolves.toMatchObject({
      type: "error",
      content: "El agente terminó sin devolver contenido visible.",
      client_msg_id: "msg-empty",
      data: { detail: "empty_agent_response" },
    });
    expect(runtimeError).toHaveBeenCalledWith(
      "query: empty visible response for msg-empty",
    );

    controller.abort();
    await monitor.stop();
  });

  it("sends outbound messages over the active account socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-outbound-"));
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
      dispatchMessage: vi.fn(),
    });

    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    await waitFor(() => (status as { running?: boolean }).running === true);

    sendQueryOutboundEvent("default", {
      type: "message",
      role: "assistant",
      content: "push listo",
      client_msg_id: "outbound-1",
      data: { source: "test" },
    });

    await expect(receive(socket)).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: "push listo",
      client_msg_id: "outbound-1",
    });

    controller.abort();
    await monitor.stop();
  });

  it("keeps text with a voice note when the agent already returned audio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-audio-"));
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
    const dispatchMessage = vi.fn(async () => ({
      text: "Aquí va la respuesta en texto.",
      mediaUrls: ["https://example.com/reply.mp3"],
    }));
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
        data: { protocol: "query-openclaw.v1", thread_id: "thread-audio" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "",
        client_msg_id: "msg-audio",
        data: {
          attachments: [
            {
              id: "inbound-audio",
              kind: "audio",
              mime_type: "audio/ogg",
              url: "https://example.com/input.ogg",
            },
          ],
        },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({
      type: "activity",
      client_msg_id: "msg-audio",
    });
    const response = await receive(socket);
    expect(response).toMatchObject({
      type: "message",
      content: "Aquí va la respuesta en texto.",
      client_msg_id: "msg-audio",
    });
    expect(response.data.caption).toBe("Aquí va la respuesta en texto.");
    expect(response.data.text).toBe("Aquí va la respuesta en texto.");
    expect((response.data.attachments as unknown[])).toHaveLength(1);

    controller.abort();
    await monitor.stop();
  });

  it("keeps only one voice note when the agent returns duplicate audio media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-audio-dedupe-"));
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
    const dispatchMessage = vi.fn(async () => ({
      text: "Respuesta con una sola nota de voz.",
      mediaUrls: ["https://example.com/reply-a.mp3", "https://example.com/reply-b.mp3"],
    }));
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
        data: { protocol: "query-openclaw.v1", thread_id: "thread-audio-dedupe" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "responde en voz",
        client_msg_id: "msg-audio-dedupe",
        data: { attachments: [] },
      }),
    );

    await receive(socket);
    const response = await receive(socket);
    expect(response).toMatchObject({
      type: "message",
      content: "Respuesta con una sola nota de voz.",
      client_msg_id: "msg-audio-dedupe",
    });
    expect(response.data.caption).toBe("Respuesta con una sola nota de voz.");
    expect(response.data.text).toBe("Respuesta con una sola nota de voz.");
    expect((response.data.attachments as unknown[])).toHaveLength(1);

    controller.abort();
    await monitor.stop();
  });
});
