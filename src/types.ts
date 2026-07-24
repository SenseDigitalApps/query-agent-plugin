import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

export const CHANNEL_ID = "query" as const;
export const DEFAULT_ACCOUNT_ID = "default";

export type QueryChannelConfig = {
  enabled?: boolean;
  url?: string;
  token?: string;
  heartbeatMs?: number;
  origin?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  responseTimeoutMs?: number;
  stateFile?: string;
  accounts?: Record<string, QueryAccountConfig>;
};

export type QueryAccountConfig = Omit<QueryChannelConfig, "accounts">;

export type ResolvedQueryAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  url: string;
  token: string;
  heartbeatMs: number;
  origin?: string;
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
  is_voice_note?: boolean;
  voice?: boolean;
  size?: number;
  url: string;
};

export type QuerySessionReadyEvent = {
  type: "session.ready";
  role?: "system";
  content?: string;
  data: {
    protocol: "query-openclaw.v1" | "query-openclaw.v2" | string;
    bot_id?: string | number;
    display_name?: string;
    thread_id?: string | number;
    general_thread_id?: string | number;
    multi_thread?: boolean;
  };
};

export type QueryThreadType = "general" | "topic" | "private";

export type QueryUserMessageEvent = {
  type: "message";
  role: "user";
  content: string;
  client_msg_id: string;
  thread_id?: string | number;
  event_id?: string | number;
  data?: {
    attachments?: QueryAttachment[];
    thread_id?: string | number;
    thread_type?: QueryThreadType;
    thread_name?: string;
    sender?: {
      id?: string | number;
      name?: string;
      type?: "member" | "support" | string;
      private_thread_id?: string | number | null;
    };
    [key: string]: unknown;
  };
};

export type QueryScheduleCancelEvent = {
  type: "schedule.cancel";
  role: "system";
  content?: string;
  client_msg_id?: string;
  thread_id?: string | number;
  data: {
    external_ids: string[];
    reason?: string;
  };
};

export type QueryInboundEvent =
  | QuerySessionReadyEvent
  | QueryUserMessageEvent
  | QueryScheduleCancelEvent;

export type QueryActivityState = "queued" | "working" | "done" | "error";

export type QueryOutboundEvent = {
  type: "activity" | "message" | "error" | "schedule.sync";
  role: "assistant" | "system";
  content: string;
  client_msg_id: string;
  thread_id: string;
  data: Record<string, unknown>;
};

export type CachedResponse = {
  threadId: string;
  clientMsgId: string;
  type: "message" | "error";
  content: string;
  data: Record<string, unknown>;
  completedAt: number;
};
