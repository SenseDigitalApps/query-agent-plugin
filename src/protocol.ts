import type {
  CachedResponse,
  QueryActivityState,
  QueryInboundEvent,
  QueryOutboundEvent,
  QuerySessionReadyEvent,
  QueryUserMessageEvent,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQueryEvent(raw: string): QueryInboundEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.type === "session.ready" && isRecord(value.data)) {
    return value as QuerySessionReadyEvent;
  }
  if (
    value.type === "message" &&
    value.role === "user" &&
    typeof value.client_msg_id === "string" &&
    value.client_msg_id.length > 0
  ) {
    const content = typeof value.content === "string" ? value.content : "";
    const attachments = isRecord(value.data) && Array.isArray(value.data.attachments)
      ? value.data.attachments
      : [];
    if (!content && attachments.length === 0) return null;
    return { ...value, content } as QueryUserMessageEvent;
  }
  return null;
}

export function buildSocketUrl(url: string, token: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Query WebSocket URL must use ws:// or wss://.");
  }
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

export function activityEvent(params: {
  clientMsgId: string;
  state: QueryActivityState;
  label: string;
  detail?: string;
  stage?: string;
  progress?: number;
}): QueryOutboundEvent {
  const { clientMsgId, ...data } = params;
  return {
    type: "activity",
    role: "assistant",
    content: "",
    client_msg_id: clientMsgId,
    data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  };
}

export function cachedResponseEvent(response: CachedResponse): QueryOutboundEvent {
  return {
    type: response.type,
    role: "assistant",
    content: response.content,
    client_msg_id: response.clientMsgId,
    data: response.data,
  };
}

export function reconnectDelay(
  attempt: number,
  minimumMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maximumMs, minimumMs * 2 ** Math.max(0, attempt));
  return Math.max(minimumMs, Math.floor(minimumMs + random() * (ceiling - minimumMs)));
}
