import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetDelegatedAuth } from "./delegated-store.js";
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
    const logInfo = vi.fn();
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
      log: { info: logInfo },
    });
    cleanupTasks.push(async () => {
      forgetDelegatedAuth("thread-7");
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
      thread_id: "thread-7",
      event_id: 7,
      data: {
        attachments: [],
        created_by_id: 99,
        delegated_auth: { token: "delegated-secret", expires_in: 900 },
      },
    });
    socket.send(userMessage);

    await expect(receive(socket)).resolves.toMatchObject({
      type: "activity",
      client_msg_id: "msg-7",
      data: { state: "working", stage: "received" },
    });
    // El turno se resuelve en milisegundos, asi que el paso de herramienta se
    // queda dentro del silencio inicial: despues del acuse llega la respuesta
    // y nada mas. Un chat rapido no se llena de cronologia.
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
    const diagnosticLog = logInfo.mock.calls.flat().join("\n");
    expect(diagnosticLog).toContain("query_delegated_auth_inbound");
    expect(diagnosticLog).toContain('thread_id="thread-7"');
    expect(diagnosticLog).toContain("delegated_auth_present=true");
    expect(diagnosticLog).toContain("created_by_id_present=true");
    expect(diagnosticLog).toContain("query_delegated_auth_stored");
    expect(diagnosticLog).not.toContain("delegated-secret");

    controller.abort();
    await monitor.stop();
  });

  it("uploads a local HTML from mediaUrls and sends only the Query attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-artifact-"));
    const filePath = join(directory, "dashboard.html");
    await writeFile(filePath, "<h1>Dashboard</h1>", "utf8");
    let delegatedToken = "";
    const httpServer = createServer((request, response) => {
      if (request.url?.includes("/attachments/")) {
        delegatedToken = String(request.headers["x-query-delegated-token"] ?? "");
        request.resume();
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 73,
            kind: "file",
            name: "dashboard.html",
            mime_type: "text/html",
            url: "https://query.test/media/agent_chat/dashboard.html",
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
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      forgetDelegatedAuth("thread-artifact");
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
        text: "Dashboard listo.",
        mediaUrls: [filePath],
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
        data: { protocol: "query-openclaw.v2", thread_id: "thread-artifact" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "genera un dashboard html",
        client_msg_id: "msg-artifact",
        thread_id: "thread-artifact",
        data: {
          attachments: [],
          delegated_auth: { token: "delegated-artifact-token", expires_in: 900 },
        },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({ type: "activity" });
    const response = await receive(socket);
    expect(delegatedToken).toBe("delegated-artifact-token");
    expect(response).toMatchObject({
      type: "message",
      content: "Dashboard listo.",
      data: {
        attachments: [
          {
            id: 73,
            kind: "file",
            name: "dashboard.html",
            url: "https://query.test/media/agent_chat/dashboard.html",
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain(filePath);

    controller.abort();
    await monitor.stop();
  }, 10_000);

  it("removes a local path from final text even when no upload credential exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-blocked-path-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const leakedPath = "C:\\workspace\\query\\secret-report.pdf";
    const warnings = vi.fn();
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
        text: `Reporte listo: ${leakedPath}`,
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
        data: { protocol: "query-openclaw.v2", thread_id: "thread-no-auth" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "genera el reporte",
        client_msg_id: "msg-no-auth",
        thread_id: "thread-no-auth",
        data: { attachments: [] },
      }),
    );

    await expect(receive(socket)).resolves.toMatchObject({ type: "activity" });
    const response = await receive(socket);
    expect(response.type).toBe("message");
    expect(response.content).toContain("Reporte listo");
    expect(response.content).toContain("archivo privado no entregado");
    expect(response.content).not.toContain(leakedPath);
    expect(warnings.mock.calls.flat().join("\n")).not.toContain(leakedPath);

    controller.abort();
    await monitor.stop();
  });

  it("publishes tool progress with its canonical step when the turn is slow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-activity-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    // `verbose` es el mismo camino que `smart` una vez pasado el silencio
    // inicial, y no obliga a que la prueba espere cuatro segundos reales.
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
      activityMode: "verbose",
    };
    const dispatchMessage = vi.fn(
      async (params: { onActivity?: (activity: Record<string, unknown>) => void }) => {
        // La herramienta ofrece un detalle con credencial: es justo lo que no
        // puede llegar al chat por mucho que el evento lo traiga.
        params.onActivity?.({
          kind: "searching",
          toolName: "query_records_search",
          detail: "Authorization: Bearer abc123",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { text: "Listo", mediaUrls: [] };
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
      log: {},
    });
    cleanupTasks.push(async () => {
      forgetDelegatedAuth("thread-act");
    });

    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    const wire: QueryOutboundEvent[] = [];
    socket.on("message", (data) =>
      wire.push(JSON.parse(data.toString()) as QueryOutboundEvent),
    );
    socket.send(
      JSON.stringify({
        type: "session.ready",
        role: "system",
        content: "",
        data: { protocol: "query-openclaw.v1", thread_id: "thread-act" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "message",
        role: "user",
        content: "cuantos clientes hay",
        client_msg_id: "msg-act",
        thread_id: "thread-act",
        event_id: 11,
        data: { attachments: [] },
      }),
    );

    await waitFor(() => wire.some((event) => event.type === "message"));
    const activities = wire.filter((event) => event.type === "activity");

    expect(activities[0]).toMatchObject({
      client_msg_id: "msg-act",
      data: { kind: "received", stage: "received", visibility: "public" },
    });
    expect(activities[1]).toMatchObject({
      data: {
        kind: "searching",
        label: "Estoy buscando la información necesaria en Query.",
        tool_name: "query_records_search",
        visibility: "public",
      },
    });
    // El paso viaja; la credencial que lo acompanaba no.
    expect(activities[1]?.data).not.toHaveProperty("detail");
    const traffic = JSON.stringify(wire);
    expect(traffic).not.toContain("Bearer");
    expect(traffic).not.toContain("abc123");
    expect(wire.at(-1)).toMatchObject({
      type: "message",
      content: "Listo",
      client_msg_id: "msg-act",
    });

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

  it("reports an explicitly steered turn as adopted instead of failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-steer-"));
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
      setStatus: (next) => { status = next as never; },
      dispatchMessage: vi.fn(async () => ({ text: "", mediaUrls: [] })),
    });
    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    await monitor.start();
    const socket = await connection;
    socket.send(JSON.stringify({
      type: "session.ready",
      role: "system",
      content: "",
      data: { protocol: "query-openclaw.v2", thread_id: "thread-steer" },
    }));
    socket.send(JSON.stringify({
      type: "message",
      role: "user",
      content: "agrega este dato",
      client_msg_id: "msg-steer",
      thread_id: "thread-steer",
      data: { attachments: [], delivery_mode: "intervene" },
    }));

    await expect(receive(socket)).resolves.toMatchObject({ type: "activity" });
    await expect(receive(socket)).resolves.toMatchObject({
      type: "turn.adopted",
      client_msg_id: "msg-steer",
      data: { adopted: true, delivery_mode: "intervene" },
    });
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
    // El canal queda en linea con la sesion abierta, no con el socket abierto:
    // Query acepta la conexion incluso cuando va a rechazar la credencial.
    socket.send(
      JSON.stringify({
        type: "session.ready",
        role: "system",
        content: "",
        data: { protocol: "query-openclaw.v2", general_thread_id: "thread-1" },
      }),
    );
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

  it("keeps the channel down when Query accepts the socket and rejects the credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-denied-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    // Query acepta el handshake y solo despues cierra con 4401, que es lo que
    // hace `deny_consumer` cuando el token de emparejamiento no coincide.
    server.on("connection", (socket) => {
      socket.close(4401, "agent_token_invalid");
    });

    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/test/`,
      token: "token-viejo",
      heartbeatMs: 5_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 200,
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
      log: { warn: vi.fn() },
    });

    await monitor.start();
    await waitFor(() => (status as { running?: boolean }).running === false);
    expect((status as { lastError?: string }).lastError).toContain("4401");

    controller.abort();
    await monitor.stop();
  });

  it("treats an unsolicited clean close as a drop and reconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-restart-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const sockets: WebSocket[] = [];
    server.on("connection", (socket) => {
      sockets.push(socket);
      socket.send(
        JSON.stringify({
          type: "session.ready",
          role: "system",
          content: "",
          data: { protocol: "query-openclaw.v2", general_thread_id: "thread-1" },
        }),
      );
    });

    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/test/`,
      token: "bot-secret",
      heartbeatMs: 5_000,
      reconnectMinMs: 100,
      reconnectMaxMs: 200,
      responseTimeoutMs: 0,
      stateFile: join(directory, "responses.json"),
    };
    let status = { accountId: "default" } as never;
    const runningStates: Array<boolean | undefined> = [];
    const monitor = new QuerySocketMonitor({
      cfg: { channels: { query: {} } } as never,
      account,
      runtime: { error: vi.fn() } as never,
      abortSignal: controller.signal,
      getStatus: () => status,
      setStatus: (next) => {
        status = next as never;
        runningStates.push((next as { running?: boolean }).running);
      },
      dispatchMessage: vi.fn(),
      log: { warn: vi.fn() },
    });

    await monitor.start();
    await waitFor(() => (status as { running?: boolean }).running === true);
    // Daphne cierra con 1000 al reiniciarse: para el plugin es una caida.
    sockets[0].close(1000, "server restart");

    await waitFor(() => sockets.length === 2);
    expect(runningStates).toContain(false);
    await waitFor(() => (status as { running?: boolean }).running === true);

    controller.abort();
    await monitor.stop();
  });

  it("replays a cached terminal response after the socket drops mid-turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-socket-terminal-replay-"));
    const server = new WebSocketServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const controller = new AbortController();
    cleanupTasks.push(async () => {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const sockets: WebSocket[] = [];
    server.on("connection", (socket) => {
      sockets.push(socket);
      socket.send(
        JSON.stringify({
          type: "session.ready",
          role: "system",
          content: "",
          data: { protocol: "query-openclaw.v2", general_thread_id: "thread-replay" },
        }),
      );
    });

    let finishDispatch:
      | ((result: { text: string; mediaUrls: string[] }) => void)
      | undefined;
    const dispatchMessage = vi.fn(
      () =>
        new Promise<{ text: string; mediaUrls: string[] }>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const logError = vi.fn();
    const account: ResolvedQueryAccount = {
      accountId: "default",
      enabled: true,
      configured: true,
      url: `ws://127.0.0.1:${address.port}/ws/openclaw-agent/test/`,
      token: "bot-secret",
      heartbeatMs: 5_000,
      // Da tiempo a que el turno termine y se guarde mientras no hay socket.
      reconnectMinMs: 400,
      reconnectMaxMs: 400,
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
      dispatchMessage: dispatchMessage as never,
      log: { error: logError, warn: vi.fn() },
    });

    await monitor.start();
    await waitFor(() => sockets.length === 1);
    const userMessage = JSON.stringify({
      type: "message",
      role: "user",
      content: "respuesta larga",
      client_msg_id: "msg-terminal-replay",
      thread_id: "thread-replay",
      data: { attachments: [] },
    });
    const initialActivity = receive(sockets[0]);
    sockets[0].send(userMessage);
    await expect(initialActivity).resolves.toMatchObject({
      type: "activity",
      client_msg_id: "msg-terminal-replay",
    });

    sockets[0].close(1011, "bridge restart");
    await waitFor(() => (status as { running?: boolean }).running === false);
    finishDispatch?.({ text: "Respuesta recuperada", mediaUrls: [] });
    // `send` falla porque todavía no hay socket, pero la respuesta ya quedó en
    // ResponseStore. La excepción observada confirma que probamos ese camino.
    await waitFor(() => logError.mock.calls.length > 0);

    await waitFor(() => sockets.length === 2);
    const replayedTerminal = receive(sockets[1]);
    // Query vuelve a enviar el turno PROCESSING al reconectar; el plugin no lo
    // ejecuta otra vez y responde desde su cache durable.
    sockets[1].send(userMessage);
    await expect(replayedTerminal).resolves.toMatchObject({
      type: "message",
      content: "Respuesta recuperada",
      client_msg_id: "msg-terminal-replay",
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);

    controller.abort();
    await monitor.stop();
  });
});
