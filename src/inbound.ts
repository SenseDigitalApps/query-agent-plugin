import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { QueryConfig, QueryUserMessageEvent, ResolvedQueryAccount } from "./types.js";
import { CHANNEL_ID } from "./types.js";
import { getQueryRuntime } from "./runtime.js";

export type QueryAgentResult = {
  text: string;
  mediaUrls: string[];
};

function mediaKind(kind: string | undefined) {
  if (kind === "image" || kind === "audio" || kind === "video") return kind;
  if (kind === "file") return "document" as const;
  return "unknown" as const;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export async function dispatchQueryMessage(params: {
  cfg: QueryConfig;
  account: ResolvedQueryAccount;
  event: QueryUserMessageEvent;
  threadId: string;
  onProgress?: (detail: string) => void;
}): Promise<QueryAgentResult> {
  const core = getQueryRuntime();
  const { cfg, account, event, threadId } = params;
  const peerId = threadId || account.accountId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: peerId },
  });
  const rawBody = event.content.trim() || "[Attachment]";
  const attachments = event.data?.attachments ?? [];
  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: event.client_msg_id,
    timestamp: Date.now(),
    from: `query:${peerId}`,
    sender: { id: "query-user", name: "Query user" },
    conversation: { kind: "direct", id: peerId, label: "Query" },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: peerId,
      originatingTo: peerId,
    },
    message: {
      body: rawBody,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    },
    media: attachments.map((attachment) => ({
      url: attachment.url,
      contentType: attachment.mime_type,
      kind: mediaKind(attachment.kind),
      messageId: attachment.id === undefined ? undefined : String(attachment.id),
    })),
    access: {
      commands: { authorized: true },
      mentions: { canDetectMention: false, wasMentioned: true },
    },
  });

  const texts: string[] = [];
  const mediaUrls: string[] = [];
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  await core.channel.inbound.dispatchReply({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload) => {
        if (payload.text?.trim()) {
          texts.push(payload.text.trim());
          params.onProgress?.("OpenClaw generó parte de la respuesta");
        }
        mediaUrls.push(...(payload.mediaUrls ?? []));
        if (payload.mediaUrl) mediaUrls.push(payload.mediaUrl);
      },
      onError: (error, info) => {
        params.onProgress?.(`Error de entrega ${info.kind}: ${String(error)}`);
      },
    },
    replyPipeline: {},
    record: {
      onRecordError: (error) => {
        params.onProgress?.(`No se pudo registrar la sesión: ${String(error)}`);
      },
    },
    messageId: event.client_msg_id,
  });

  return {
    text: texts.join("\n\n").trim(),
    mediaUrls: uniqueNonEmpty(mediaUrls),
  };
}
