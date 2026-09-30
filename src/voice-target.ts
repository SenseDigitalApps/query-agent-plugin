/**
 * Maps Core's call scope to the Query account and OpenClaw session of THIS
 * Gateway. Explicit `channels.query.voice.routes` win; otherwise the account is
 * found by itself: its socket URL `wss://<core host>/ws/openclaw-agent/<bot id>/`
 * must match the host Core reports for the tenant and the agent id of the call.
 * Zero or several candidates refuse the call; nothing is guessed.
 */
import { listQueryAccountIds, resolveQueryAccount } from "./config.js";
import type { QueryConfig } from "./types.js";
import type { VoiceScope } from "./voice-bridge.js";

export type VoiceRouteConfig = { tenant: string; agentId: number; accountId: string };

export type VoiceCallTarget = {
  sessionKey: string;
  /** OpenClaw agent that owns sessionKey; its auth store decides the credential. */
  agentId: string;
  accountId: string;
  socketUrl: string;
  agentToken: string;
  coreApiBase: string;
};

type RouteResolver = (params: {cfg: QueryConfig; channel: string; accountId: string;
  peer: {kind: "direct"; id: string}}) => {sessionKey: string; agentId: string};

const AGENT_SOCKET_PATH = /^\/ws\/openclaw-agent\/([^/]+)\/?$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** wss://tenant.example/ws/openclaw-agent/<bot>/ -> https://tenant.example/api/v4/ */
export function coreApiBaseFromSocket(socketUrl: string): string {
  const url = new URL(socketUrl);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw Error("voice_core_url_insecure");
  }
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/api/v4/`;
}

/** Host and bot id of an account's Query socket, or undefined if it is not one. */
export function agentSocketIdentity(socketUrl: string): {host: string; botId: string} | undefined {
  try {
    const url = new URL(socketUrl);
    const match = AGENT_SOCKET_PATH.exec(url.pathname);
    return match ? {host: url.hostname.toLowerCase(), botId: decodeURIComponent(match[1])} : undefined;
  } catch {
    return undefined;
  }
}

function accountIdsFor(cfg: QueryConfig, scope: VoiceScope, coreHost: string | undefined): string[] {
  const voice = (cfg.channels?.query as {voice?: {routes?: VoiceRouteConfig[]}} | undefined)?.voice;
  const explicit = (voice?.routes ?? []).filter(route => route.tenant === scope.tenant && route.agentId === scope.agent_id);
  if (explicit.length) return explicit.map(route => route.accountId);
  const host = coreHost?.trim().toLowerCase();
  if (!host || !HOSTNAME.test(host)) return [];
  return listQueryAccountIds(cfg).filter(accountId => {
    const account = resolveQueryAccount(cfg, accountId);
    const identity = agentSocketIdentity(account.url);
    return identity?.host === host && identity.botId === String(scope.agent_id);
  });
}

export function resolveVoiceTarget(cfg: QueryConfig, scope: VoiceScope, resolveRoute: RouteResolver,
    coreHost?: string): VoiceCallTarget | undefined {
  const candidates = accountIdsFor(cfg, scope, coreHost);
  if (candidates.length !== 1) return undefined;
  const account = resolveQueryAccount(cfg, candidates[0]);
  if (!account.enabled || !account.configured) return undefined;
  // Same route as src/inbound.ts for a private thread: direct peer = thread id.
  const route = resolveRoute({cfg, channel: "query", accountId: account.accountId,
    peer: {kind: "direct", id: String(scope.thread_id)}});
  if (!route?.sessionKey || !route.agentId) return undefined;
  return {sessionKey: route.sessionKey, agentId: route.agentId, accountId: account.accountId, socketUrl: account.url,
    agentToken: account.token, coreApiBase: coreApiBaseFromSocket(account.url)};
}
