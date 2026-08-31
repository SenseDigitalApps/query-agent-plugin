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
    const onPartialReply = vi.fn();
    const dispatchReply = vi.fn(async (params: any) => {
      params.replyOptions.onItemEvent?.({
        kind: "preamble",
        progressText: "Voy a revisar los leads y contrastar sus estados.",
      });
      params.replyOptions.onPlanUpdate?.({
        explanation: "Después organizaré los hallazgos.",
      });
      params.replyOptions.onPartialReply?.({
        text: "💨Fast: auto-onEstoy redactando la respuesta con el dato confirmado.",
      });
      params.replyOptions.onToolStart?.({ name: "query_records_search" });
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
        data: {
          text: "💨Fast: auto-off(61s>=60s)💨Fast: auto-onRespuesta que solo aparecio en el stream.",
        },
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
      onPartialReply,
    });

    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0][0].replyOptions).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      thinkingLevelOverride: "low",
      fastModeOverride: true,
      bootstrapContextMode: "lightweight",
      commentaryProgressEnabled: true,
      suppressDefaultToolProgressMessages: true,
      allowToolLifecycleWhenProgressHidden: true,
      allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      onPartialReply: expect.any(Function),
      onToolStart: expect.any(Function),
    });
    expect(dispatchReply.mock.calls[0][0].replyOptions.onReasoningStream).toBeUndefined();
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reasoning_summary",
        label: "Voy a revisar los leads y contrastar sus estados.",
        source: "commentary",
      }),
    );
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reasoning_summary",
        label: "Después organizaré los hallazgos.",
        source: "plan",
      }),
    );
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "searching",
        label: "Estoy buscando los registros relacionados con tu solicitud.",
      }),
    );
    expect(onPartialReply.mock.calls.map(([text]) => text)).toEqual([
      "Voy a revisar los leads y contrastar sus estados.",
      "Después organizaré los hallazgos.",
      "Estoy redactando la respuesta con el dato confirmado.",
    ]);
    expect(result.text).toBe("Respuesta que solo aparecio en el stream.");
  });

  it("filters Fast annotations from the final delivery callback", async () => {
    const dispatchReply = vi.fn(async (params: any) => {
      await params.delivery.deliver({
        text: "💨Fast: auto-off(161s>=60s)💨Fast: auto-onRespuesta final limpia.",
      });
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
    const info = vi.fn();

    const result = await dispatchQueryMessage({
      cfg: { channels: { query: {} } } as QueryConfig,
      account,
      threadId: "test-thread",
      event: {
        type: "message",
        role: "user",
        content: "Continúa",
        client_msg_id: "turn-fast-control",
        thread_id: "test-thread",
        data: { attachments: [] },
      },
      log: { info },
    });

    expect(result.text).toBe("Respuesta final limpia.");
    expect(info).toHaveBeenCalledWith(
      "query_control_annotation_filtered msg=turn-fast-control kind=fast_mode",
    );
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
      "localizarla y cargarla con tool_search",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "No afirmes que query_attachment_send esta ausente o no disponible sin haber ejecutado antes tool_search",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "nunca muestres file_path ni ninguna ruta local al usuario",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      "Solo reporta indisponibilidad si tool_search no encuentra query_attachment_send o devuelve un error tecnico real",
    );
    expect(dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent).toContain(
      'no inventes que hace falta "exponer el conector en la sesion"',
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
    expect(body).toContain("publicalo en el topic o canal Query actual con query_attachment_send");
    expect(body).toContain("localizarla y cargarla con tool_search");
    expect(body).toContain("nunca las muestres como entrega final");
    expect(body).toContain("Canal privado del remitente: private-22");
    expect(body).toContain("[Destino de tareas programadas:");
    expect(body).toContain("conserva el canal actual como destino");
    expect(body).toContain(
      "canal privado private-22 solo si el usuario pide expresamente",
    );
  });

  it.each([
    ["topic compartido", "topic", "topic-reportes"],
    ["canal privado", "private", "private-22"],
  ] as const)("injects the deferred attachment policy in every Query %s", async (
    _label,
    threadType,
    threadId,
  ) => {
    const dispatchReply = vi.fn(async (params: any) => {
      await params.delivery.deliver({ text: "Respuesta visible." });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: `agent:query-tenant:${threadId}`,
      };
    });
    setQueryRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "query-tenant",
            accountId: "tenant-acme",
            sessionKey: `agent:query-tenant:${threadId}`,
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
      account: { ...account, accountId: "tenant-acme" },
      threadId,
      event: {
        type: "message",
        role: "user",
        content: "Genera y entrega el reporte",
        client_msg_id: `turn-policy-${threadType}`,
        thread_id: threadId,
        data: {
          attachments: [],
          thread_name: threadId,
          thread_type: threadType,
          tenant: { schema: "acme" },
        },
      },
    });

    expect(dispatchReply.mock.calls[0][0]).toMatchObject({
      accountId: "tenant-acme",
      agentId: "query-tenant",
    });
    const body = dispatchReply.mock.calls[0][0].ctxPayload.BodyForAgent as string;
    expect(body).toContain(
      `Tipo de canal: ${threadType}${threadType === "topic" ? " compartido" : ""}`,
    );
    expect(body).toContain(
      "publicalo en el topic o canal Query actual con query_attachment_send usando su ruta local interna como file_path",
    );
    expect(body).toContain(
      "query_attachment_send es una herramienta diferida: si no aparece entre las herramientas ya cargadas, debes localizarla y cargarla con tool_search",
    );
    expect(body).toContain(
      "No afirmes que query_attachment_send esta ausente o no disponible sin haber ejecutado antes tool_search",
    );
    expect(body).toContain("nunca muestres file_path ni ninguna ruta local al usuario");
  });
});
