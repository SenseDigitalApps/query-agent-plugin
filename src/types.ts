import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "query" as const;
export const DEFAULT_ACCOUNT_ID = "default";

export type QueryChannelConfig = {
  enabled?: boolean;
  url?: string;
  token?: string;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  responseTimeoutMs?: number;
  stateFile?: string;
};

export type ResolvedQueryAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  url: string;
  token: string;
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  responseTimeoutMs: number;
  stateFile?: string;
};

export type QueryConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    query?: QueryChannelConfig;
  };
};

export type QueryAttachment = {
  id?: string | number;
  kind?: "image" | "file" | "audio" | "video" | string;
  name?: string;
  mime_type?: string;
  size?: number;
  url: string;
};

export type QuerySessionReadyEvent = {
  type: "session.ready";
  role?: "system";
  content?: string;
  data: {
    protocol: "query-openclaw.v1" | string;
    bot_id?: string | number;
    display_name?: string;
    thread_id?: string | number;
  };
};

export type QueryUserMessageEvent = {
  type: "message";
  role: "user";
  content: string;
  client_msg_id: string;
  event_id?: string | number;
  data?: {
    attachments?: QueryAttachment[];
    [key: string]: unknown;
  };
};

export type QueryInboundEvent = QuerySessionReadyEvent | QueryUserMessageEvent;

export type QueryActivityState = "queued" | "working" | "done" | "error";

export type QueryOutboundEvent = {
  type: "activity" | "message" | "error";
  role: "assistant";
  content: string;
  client_msg_id: string;
  data: Record<string, unknown>;
};

export type CachedResponse = {
  clientMsgId: string;
  type: "message" | "error";
  content: string;
  data: Record<string, unknown>;
  completedAt: number;
};
