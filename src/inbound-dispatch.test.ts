import { describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { dispatchQueryMessage } from "./inbound.js";
import { setQueryRuntime } from "./runtime.js";
import type { QueryConfig, ResolvedQueryAccount } from "./types.js";

const account: ResolvedQueryAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  url: "ws://127.0.0.1/ws/openclaw-agent/test/",
  token: "test-token",
  heartbeatMs: 5_000,
  reconnectMinMs: 100,
  reconnectMaxMs: 1_000,
  responseTimeoutMs: 0,
  stateFile: "responses.json",
};

describe("Query inbound dispatch recovery", () => {
  it("recovers assistant text when OpenClaw omits the final delivery callback", async () => {
    const onActivity = vi.fn();
    const dispatchReply = vi.fn(async (params: any) => {
      params.replyOptions.onItemEvent?.({
        kind: "preamble",
        progressText: "Voy a revisar los leads y contrastar sus estados.",
      });
      emitAgentEvent({
        runId: "run-streamed",
        stream: "lifecycle",
        sessionKey: "agent:query:test-thread",
        agentId: "agent",
        data: { phase: "start" },
      });
      emitAgentEvent({
        runId: "run-streamed",
        stream: "assistant",
        sessionKey: "agent:query:test-thread",
        agentId: "agent",
        data: { text: "Respuesta que solo aparecio en el stream." },
      });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: "agent:query:test-thread",
        dispatchResult: {
          queuedFinal: false,
          counts: { tool: 2, block: 0, final: 0 },
          noVisibleReplyFallbackEligible: true,
        },
      };
    });
    setQueryRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent",
            accountId: "default",
            sessionKey: "agent:query:test-thread",
          }),
        },
        session: {
          resolveStorePath: () => "sessions.json",
          recordInboundSession: vi.fn(),
        },
        inbound: { dispatchReply },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      },
    } as never);

    const result = await dispatchQueryMessage({
      cfg: { channels: { query: {} } } as QueryConfig,
      account,
      threadId: "test-thread",
      event: {
        type: "message",
        role: "user",
        content: "Revisa los leads de ayer",
        client_msg_id: "turn-streamed-1",
        thread_id: "test-thread",
        data: { attachments: [], effort_mode: "fast" },
      },
      onActivity,
    });

    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0][0].replyOptions).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      thinkingLevelOverride: "low",
      fastModeOverride: true,
      bootstrapContextMode: "lightweight",
      commentaryProgressEnabled: true,
    });
    expect(dispatchReply.mock.calls[0][0].replyOptions.onReasoningStream).toBeUndefined();
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reasoning_summary",
        label: "Voy a revisar los leads y contrastar sus estados.",
      }),
    );
    expect(result.text).toBe("Respuesta que solo aparecio en el stream.");
  });

  it("asks for one visible final without tools when the first turn returns empty", async () => {
    const dispatchReply = vi.fn(async (params: any) => {
      const firstAttempt = dispatchReply.mock.calls.length === 1;
      if (!firstAttempt) {
        await params.delivery.deliver({
          text: "Respuesta recuperada sin repetir acciones.",
        });
      }
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: "agent:query:test-thread",
        dispatchResult: {
          queuedFinal: !firstAttempt,
          counts: {
            tool: firstAttempt ? 3 : 0,
            block: 0,
            final: firstAttempt ? 0 : 1,
          },
          ...(firstAttempt
            ? { noVisibleReplyFallbackEligible: true }
            : {}),
        },
      };
    });
    setQueryRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent",
            accountId: "default",
            sessionKey: "agent:query:test-thread",
          }),
        },
        session: {
          resolveStorePath: () => "sessions.json",
          recordInboundSession: vi.fn(),
        },
        inbound: { dispatchReply },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      },
    } as never);
    const warn = vi.fn();

    const result = await dispatchQueryMessage({
      cfg: { channels: { query: {} } } as QueryConfig,
      account,
      threadId: "test-thread",
      event: {
        type: "message",
        role: "user",
        content: "Revisa los leads de ayer",
        client_msg_id: "turn-empty-1",
        thread_id: "test-thread",
        data: { attachments: [] },
      },
      log: { warn },
    });

    expect(dispatchReply).toHaveBeenCalledTimes(2);
    expect(dispatchReply.mock.calls[0][0].replyOptions).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      thinkingLevelOverride: "medium",
    });
    expect(dispatchReply.mock.calls[1][0].replyOptions).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      thinkingLevelOverride: "high",
      fastModeOverride: false,
      bootstrapContextMode: "full",
    });
    expect(dispatchReply.mock.calls[0][0].toolsAllow).toBeUndefined();
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "cierra este turno con contenido visible para la persona",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "query_attachment_send",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "Puedes usar LocalPath y rutas locales para leer adjuntos recibidos o crear archivos internamente",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "No uses registros de negocio para entregar archivos",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "El usuario final esta en otro computador",
    );
    expect(dispatchReply.mock.calls[1][0].toolsAllow).toEqual([]);
    expect(dispatchReply.mock.calls[1][0].ctxPayload.BodyForAgent).toContain(
      "No repitas herramientas, consultas ni acciones",
    );
    expect(result.text).toBe("Respuesta recuperada sin repetir acciones.");
    expect(result.diagnostics?.recoveredFromEmptyReply).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("query_empty_reply_recovery msg=turn-empty-1"),
    );
  });

  it("keeps asset, visible-response, intervention, and private-cron rules together", async () => {
    const dispatchReply = vi.fn(async (params: any) => {
      await params.delivery.deliver({ text: "Intervencion recibida." });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: "agent:query:test-thread",
      };
    });
    setQueryRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent",
            accountId: "default",
            sessionKey: "agent:query:test-thread",
          }),
        },
        session: {
          resolveStorePath: () => "sessions.json",
          recordInboundSession: vi.fn(),
        },
        inbound: { dispatchReply },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      },
    } as never);

    await dispatchQueryMessage({
      cfg: { channels: { query: {} } } as QueryConfig,
      account,
      threadId: "test-thread",
      event: {
        type: "message",
        role: "user",
        content: "agrega este dato",
        client_msg_id: "turn-intervene-policy",
        thread_id: "test-thread",
        data: {
          attachments: [],
          delivery_mode: "intervene",
          sender: { private_thread_id: "private-22" },
        },
      },
    });

    const body = dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent as string;
    expect(body).toContain("/queue steer");
    expect(body).toContain("No uses NO_REPLY");
    expect(body).toContain("subelo con query_attachment_send");
    expect(body).toContain("nunca las muestres como entrega final");
    expect(body).toContain("Canal privado del remitente: private-22");
    expect(body).toContain("[Entrega de tareas programadas:");
    expect(body).toContain("entrega el resultado en su canal privado private-22");
  });
});
