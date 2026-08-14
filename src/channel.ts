import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { inspectQueryAccount, listQueryAccountIds, resolveQueryAccount } from "./config.js";
import { queryAttachmentForMediaSource, queryAttachmentForMediaUrl } from "./media.js";
import { rewritePrivateArtifactLinks } from "./private-links.js";
import {
  botIdFromSocketUrl,
  isLocalArtifactPath,
  queryOutboundUploadUrlFor,
  uploadOutboundArtifactToQuery,
} from "./query-upload.js";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  type QueryOutboundEvent,
  type QueryConfig,
  type ResolvedQueryAccount,
} from "./types.js";

async function resolveAccountForOutbound(
  cfg: QueryConfig,
  accountId: string,
): Promise<ResolvedQueryAccount | undefined> {
  const { getQueryAccountForUpload } = await import("./socket.js");
  const liveAccount = getQueryAccountForUpload(accountId);
  if (liveAccount) return liveAccount;
  const configuredAccount = resolveQueryAccount(cfg, accountId);
  return configuredAccount.configured ? configuredAccount : undefined;
}

function newOutboundClientMsgId(deliveryQueueId?: string): string {
  if (deliveryQueueId?.trim()) return deliveryQueueId.trim();
  return `openclaw-outbound-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function uploadTargetForOutbound(to: string, threadId?: string | number | null): string {
  if (threadId !== undefined && threadId !== null && String(threadId).trim()) {
    return String(threadId).trim();
  }
  const target = to.trim();
  const channelMatch = target.match(/^channel:(\d+)$/i);
  return channelMatch?.[1] ?? target;
}

/**
 * Un envio outbound no nace de un turno, asi que no hay credencial delegada:
 * el archivo se sube con la credencial de emparejamiento del agente y viaja con
 * la url oficial. Mandar la ruta del workspace producia un enlace que Query no
 * puede servir y que el navegador resolvia contra su propio dominio.
 */
async function resolveOutboundAttachment(
  cfg: QueryConfig,
  accountId: string | null | undefined,
  to: string,
  threadId: string | number | null | undefined,
  mediaUrl: string,
  options: { audioAsVoice?: boolean; forceDocument?: boolean },
) {
  if (!isLocalArtifactPath(mediaUrl)) {
    return queryAttachmentForMediaSource(mediaUrl, options);
  }
  const account = await resolveAccountForOutbound(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  const botId = account ? botIdFromSocketUrl(account.url) : "";
  if (!account || !botId) {
    // Sin cuenta activa no hay a donde subir; se mantiene el comportamiento
    // anterior en vez de perder el envio entero.
    return queryAttachmentForMediaSource(mediaUrl, options);
  }
  return uploadOutboundArtifactToQuery({
    uploadUrl: queryOutboundUploadUrlFor(account.url, botId),
    token: account.token,
    to: uploadTargetForOutbound(to, threadId),
    path: mediaUrl,
    attachment: queryAttachmentForMediaUrl(mediaUrl, options),
  });
}

async function rewritePrivateLinksForOutbound(
  cfg: QueryConfig,
  accountId: string,
  to: string,
  threadId: string | number | null | undefined,
  text: string,
) {
  if (!text) return { text, attachments: [] };
  const account = await resolveAccountForOutbound(cfg, accountId);
  const botId = account ? botIdFromSocketUrl(account.url) : "";
  if (!account || !botId) return { text, attachments: [] };
  return rewritePrivateArtifactLinks({
    text,
    upload: async (path) =>
      uploadOutboundArtifactToQuery({
        uploadUrl: queryOutboundUploadUrlFor(account.url, botId),
        token: account.token,
        to: uploadTargetForOutbound(to, threadId),
        path,
        attachment: queryAttachmentForMediaUrl(path),
      }),
  });
}

export async function sendOutboundEvent(params: {
  cfg: QueryConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  deliveryQueueId?: string;
  data?: Record<string, unknown>;
}) {
  const { sendQueryOutboundEvent } = await import("./socket.js");
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const rewritten = await rewritePrivateLinksForOutbound(
    params.cfg,
    accountId,
    params.to,
    params.threadId,
    params.text,
  );
  const clientMsgId = newOutboundClientMsgId(params.deliveryQueueId);
  const existingAttachments = Array.isArray(params.data?.attachments)
    ? (params.data.attachments as unknown[])
    : [];
  const attachments = [...existingAttachments, ...rewritten.attachments];
  const event: QueryOutboundEvent = {
    type: "message",
    role: "assistant",
    content: rewritten.text,
    client_msg_id: clientMsgId,
    thread_id: String(params.threadId ?? params.to),
    data: {
      source: "openclaw_outbound",
      to: params.to,
      ...(params.threadId === undefined || params.threadId === null
        ? {}
        : { thread_id: String(params.threadId) }),
      ...(params.data ?? {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
  try {
    sendQueryOutboundEvent(accountId, event);
  } catch (error) {
    const account = await resolveAccountForOutbound(params.cfg, accountId);
    if (!account) throw error;
    const { sendQueryOutboundEventDirect } = await import("./outbound-direct.js");
    await sendQueryOutboundEventDirect(account, event);
  }
  return {
    channel: CHANNEL_ID,
    messageId: clientMsgId,
    chatId: params.to,
    conversationId:
      params.threadId === undefined || params.threadId === null ? params.to : String(params.threadId),
    timestamp: Date.now(),
    meta: { accountId },
  };
}

export const queryPlugin: ChannelPlugin<ResolvedQueryAccount> =
  createChatChannelPlugin<ResolvedQueryAccount>({
    base: ({
      ...createChannelPluginBase({
        id: CHANNEL_ID,
        meta: {
          id: CHANNEL_ID,
          label: "Query",
          selectionLabel: "Query (Web/Flutter)",
          docsPath: "/channels/query",
          blurb: "Connect OpenClaw to Query web and Flutter messaging.",
        },
        capabilities: {
          chatTypes: ["direct", "group"],
          media: true,
        },
        config: {
          listAccountIds: (cfg: OpenClawConfig) => listQueryAccountIds(cfg as QueryConfig),
          resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
            resolveQueryAccount(cfg as QueryConfig, accountId),
          inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
            inspectQueryAccount(resolveQueryAccount(cfg as QueryConfig, accountId)),
        },
        setup: {
          applyAccountConfig: ({ cfg, accountId, input }) => {
            const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
            const current = (cfg.channels as Record<string, unknown> | undefined)?.query;
            const currentQuery =
              typeof current === "object" && current !== null
                ? (current as Record<string, unknown>)
                : {};
            if (resolvedAccountId !== DEFAULT_ACCOUNT_ID || currentQuery.accounts) {
              const currentAccounts =
                typeof currentQuery.accounts === "object" && currentQuery.accounts !== null
                  ? (currentQuery.accounts as Record<string, unknown>)
                  : {};
              const currentAccount = currentAccounts[resolvedAccountId];
              return {
                ...cfg,
                channels: {
                  ...cfg.channels,
                  query: {
                    ...currentQuery,
                    accounts: {
                      ...currentAccounts,
                      [resolvedAccountId]: {
                        ...(typeof currentAccount === "object" && currentAccount !== null
                          ? currentAccount
                          : {}),
                        ...input,
                      },
                    },
                  },
                },
              };
            }
            return {
              ...cfg,
              channels: {
                ...cfg.channels,
                query: {
                  ...currentQuery,
                  ...input,
                },
              },
            };
          },
        },
      }),
      capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
      },
      gateway: {
        startAccount: async (ctx) => {
          if (!ctx.account.enabled) return;
          if (!ctx.account.configured) {
            throw new Error(
              "Query is not configured: set channels.query.url and provide its token in the URL, channels.query.token, or QUERY_OPENCLAW_TOKEN.",
            );
          }
          const [{ runPassiveAccountLifecycle }, { QuerySocketMonitor }] = await Promise.all([
            import("openclaw/plugin-sdk/channel-outbound"),
            import("./socket.js"),
          ]);
          await runPassiveAccountLifecycle({
            abortSignal: ctx.abortSignal,
            start: async () => {
              const monitor = new QuerySocketMonitor({
                cfg: ctx.cfg as QueryConfig,
                account: ctx.account,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
                log: ctx.log,
                getStatus: ctx.getStatus,
                setStatus: ctx.setStatus,
              });
              await monitor.start();
              return monitor;
            },
            stop: async (monitor) => monitor.stop(),
          });
        },
      },
    } as ChannelPlugin<ResolvedQueryAccount>),
    threading: { topLevelReplyToMode: "off" },
    outbound: {
      deliveryMode: "direct",
      deliveryCapabilities: {
        durableFinal: {
          text: true,
          media: true,
          thread: true,
          batch: false,
        },
      },
      resolveTarget: ({ to }) => {
        const target = to?.trim();
        if (!target) return { ok: false, error: new Error("Query outbound target is required.") };
        return { ok: true, to: target };
      },
      sendText: async (ctx) =>
        sendOutboundEvent({
          cfg: ctx.cfg as QueryConfig,
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
          deliveryQueueId: ctx.deliveryQueueId,
        }),
      sendMedia: async (ctx) => {
        const attachment = ctx.mediaUrl
          ? await resolveOutboundAttachment(ctx.cfg as QueryConfig, ctx.accountId, ctx.to, ctx.threadId, ctx.mediaUrl, {
              audioAsVoice: ctx.audioAsVoice,
              forceDocument: ctx.forceDocument,
            })
          : undefined;
        return sendOutboundEvent({
          cfg: ctx.cfg as QueryConfig,
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
          deliveryQueueId: ctx.deliveryQueueId,
          data: attachment ? { attachments: [attachment] } : undefined,
        });
      },
    },
  });
