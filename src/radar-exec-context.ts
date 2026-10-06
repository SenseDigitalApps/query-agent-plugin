import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

export const RADAR_EXEC_ENV = "ASOCAPITALES_RADAR_EXEC_CONTEXT";
type Context = { agentId?: string; sessionKey?: string; messageProvider?: string };
type Event = { host?: string; sessionKey?: string };

/** Only runtime hook context may identify the caller; never command args/env. */
export function radarExecContext(event: Event, ctx: Context): Record<string, string> {
  const denied = { [RADAR_EXEC_ENV]: "" };
  if (event.host !== "gateway" || ctx.agentId !== "comunicaciones") return denied;
  const sessionKey = ctx.sessionKey ?? event.sessionKey;
  if (ctx.sessionKey && event.sessionKey && ctx.sessionKey !== event.sessionKey) return denied;
  if (ctx.messageProvider && ctx.messageProvider !== "query") return denied;
  if (!sessionKey || !/^agent:comunicaciones:query:(group|channel):129$/.test(sessionKey)) return denied;
  return { [RADAR_EXEC_ENV]: JSON.stringify({
    version: 1, agentId: "comunicaciones", accountId: "comunicaciones-asocapitales",
    channelId: "129", sessionKey, source: "openclaw-resolve-exec-env",
  }) };
}

export function registerRadarExecContext(api: OpenClawPluginApi) {
  api.on("resolve_exec_env", (event, ctx) => radarExecContext(event, ctx));
}
