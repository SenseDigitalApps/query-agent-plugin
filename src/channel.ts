import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { inspectQueryAccount, resolveQueryAccount } from "./config.js";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  type QueryOutboundEvent,
  type QueryConfig,
  type ResolvedQueryAccount,
} from "./types.js";

function newOutboundClientMsgId(deliveryQueueId?: string): string {
  if (deliveryQueueId?.trim()) return deliveryQueueId.trim();
  return `openclaw-outbound-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function sendOutboundEvent(params: {
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  deliveryQueueId?: string;
  data?: Record<string, unknown>;
}) {
  const { sendQueryOutboundEvent } = await import("./socket.js");
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const clientMsgId = newOutboundClientMsgId(params.deliveryQueueId);
  const event: QueryOutboundEvent = {
    type: "message",
    role: "assistant",
    content: params.text,
    client_msg_id: clientMsgId,
    data: {
      source: "openclaw_outbound",
      to: params.to,
      ...(params.threadId === undefined || params.threadId === null
        ? {}
        : { thread_id: String(params.threadId) }),
      ...(params.data ?? {}),
    },
  };
  sendQueryOutboundEvent(accountId, event);
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
          chatTypes: ["direct"],
          media: true,
        },
        config: {
          listAccountIds: () => [DEFAULT_ACCOUNT_ID],
          resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
            resolveQueryAccount(cfg as QueryConfig, accountId),
          inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
            inspectQueryAccount(resolveQueryAccount(cfg as QueryConfig, accountId)),
        },
        setup: {
          applyAccountConfig: ({ cfg, input }) => {
            const current = (cfg.channels as Record<string, unknown> | undefined)?.query;
            return {
              ...cfg,
              channels: {
                ...cfg.channels,
                query: {
                  ...(typeof current === "object" && current !== null ? current : {}),
                  ...input,
                },
              },
            };
          },
        },
      }),
      capabilities: {
        chatTypes: ["direct"],
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
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
          deliveryQueueId: ctx.deliveryQueueId,
        }),
      sendMedia: async (ctx) =>
        sendOutboundEvent({
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
          deliveryQueueId: ctx.deliveryQueueId,
          data: ctx.mediaUrl
            ? {
                attachments: [
                  {
                    kind: "file",
                    name: ctx.mediaUrl.split("/").pop() || "attachment",
                    url: ctx.mediaUrl,
                  },
                ],
              }
            : undefined,
        }),
    },
  });
