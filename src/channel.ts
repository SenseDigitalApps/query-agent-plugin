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
  type QueryConfig,
  type ResolvedQueryAccount,
} from "./types.js";

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
  });
