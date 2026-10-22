import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { resolveQuerySession } from "./query-session-store.js";

export function blocksQueryProgress(toolName: string, params: Record<string, unknown>, querySession: boolean): boolean {
  if (toolName !== "message" || params.action !== "send" || params.final !== false) return false;
  const channel = typeof params.channel === "string" ? params.channel.trim().toLowerCase() : "";
  return channel === "query" || (!channel && querySession);
}

export function registerQueryFinalOnlyGuard(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    if (!blocksQueryProgress(event.toolName, event.params ?? {}, Boolean(resolveQuerySession(ctx?.sessionKey)))) return;
    return {
      block: true,
      blockReason: "Query es final-only: no se envio este avance. Continua trabajando en silencio y entrega el resultado al terminar. No reintentes el mismo avance quitando final=false ni marcandolo final=true. Para una decision imprescindible usa query_question_ask; un bloqueo que impida continuar se informa como resultado final.",
    };
  });
}
