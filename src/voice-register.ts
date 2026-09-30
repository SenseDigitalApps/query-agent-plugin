/**
 * Wires Query voice into the Gateway process:
 * - hooks that bind every Talk consult run to its Query actor (always on, so a
 *   Talk session nobody owns can never borrow a thread's text credential);
 * - when `channels.query.voice.enabled`, the Gateway-owned driver, its private
 *   HTTP bridge for Core and a dedicated operator connection to this Gateway.
 *
 * Secrets come only from the Gateway environment: QUERY_AGENT_VOICE_BRIDGE_TOKEN
 * (shared with Core, >= 32 chars) and QUERY_VOICE_GATEWAY_DEVICE_TOKEN (paired
 * operator device, `operator.write`, never `operator.admin`). No OAuth token or
 * Platform key is read here.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveQueryAccount } from "./config.js";
import { getQueryRuntime } from "./runtime.js";
import type { QueryConfig } from "./types.js";
import { QueryVoiceBridge, voiceBridgeHandler, type VoiceScope } from "./voice-bridge.js";
import { checkVoiceOAuthOnly } from "./voice-route.js";
import { voiceRuns, type VoiceDelegationResult } from "./voice-run-binding.js";
import { GatewayTalkDriver, type VoiceCallTarget } from "./voice-talk-driver.js";

export type QueryVoiceConfig = {
  enabled?: boolean;
  /** Set true ONLY after the coordinated live test with the server agent. */
  verified?: boolean;
  gatewayUrl?: string;
  gatewayHttpUrl?: string;
  journalDir?: string;
  /** Trusted tenant + Query agent id -> local Query account. Exactly one match. */
  routes?: { tenant: string; agentId: number; accountId: string }[];
};

/** wss://tenant.example/ws/openclaw-agent/<bot>/ -> https://tenant.example/api/v4/ */
export function coreApiBaseFromSocket(socketUrl: string): string {
  const url = new URL(socketUrl);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw Error("voice_core_url_insecure");
  }
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/api/v4/`;
}

export function resolveVoiceTarget(cfg: QueryConfig, scope: VoiceScope,
    resolveRoute: (params: {cfg: QueryConfig; channel: string; accountId: string; peer: {kind: "direct"; id: string}}) => {sessionKey: string; agentId: string}):
    VoiceCallTarget | undefined {
  const voice = (cfg.channels?.query as {voice?: QueryVoiceConfig} | undefined)?.voice;
  const matches = (voice?.routes ?? []).filter(route => route.tenant === scope.tenant && route.agentId === scope.agent_id);
  if (matches.length !== 1) return undefined;
  const account = resolveQueryAccount(cfg, matches[0].accountId);
  if (!account.enabled || !account.configured) return undefined;
  // Same route as src/inbound.ts for a private thread: direct peer = thread id.
  const route = resolveRoute({cfg, channel: "query", accountId: account.accountId,
    peer: {kind: "direct", id: String(scope.thread_id)}});
  if (!route?.sessionKey || !route.agentId) return undefined;
  return {sessionKey: route.sessionKey, agentId: route.agentId, accountId: account.accountId, socketUrl: account.url,
    agentToken: account.token, coreApiBase: coreApiBaseFromSocket(account.url)};
}

async function claimDelegation(scope: VoiceScope, target: VoiceCallTarget,
    claim: {consult_id: string; run_id: string; question_digest: string}, bridgeToken: string): Promise<VoiceDelegationResult> {
  const response = await fetch(new URL(`voice/calls/${scope.call_id}/delegation/`, target.coreApiBase), {
    method: "POST",
    headers: {authorization: `Bearer ${bridgeToken}`, "content-type": "application/json"},
    body: JSON.stringify(claim),
  });
  if (!response.ok) throw Error(response.status === 403 ? "voice_delegation_refused" : "voice_delegation_unavailable");
  return await response.json() as VoiceDelegationResult;
}

export function registerQueryVoice(api: OpenClawPluginApi): void {
  if (!("on" in api) || typeof api.on !== "function") return;

  // Question digest for the consult: the run's first model input.
  api.on("llm_input", (event: {runId?: string; prompt?: string}) => { voiceRuns.recordPrompt(event?.runId, event?.prompt); });
  api.on("before_agent_run", (event: {prompt?: string}, ctx: {runId?: string}) => { voiceRuns.recordPrompt(ctx?.runId, event?.prompt); });
  api.on("before_tool_call", async (event: {toolName: string; runId?: string}, ctx: {runId?: string; sessionKey?: string; toolCallId?: string}) => {
    const runId = ctx?.runId ?? event.runId;
    const refusal = await voiceRuns.beforeToolCall({...ctx, runId}, event.toolName);
    if (refusal) return {block: true, blockReason: `No se puede usar ${event.toolName} en esta llamada de voz (${refusal}).`};
    return undefined;
  });

  const cfg = api.config as QueryConfig;
  const voice = (cfg.channels?.query as {voice?: QueryVoiceConfig} | undefined)?.voice;
  if (!voice?.enabled) return;
  const bridgeToken = process.env.QUERY_AGENT_VOICE_BRIDGE_TOKEN?.trim() ?? "";
  const deviceToken = process.env.QUERY_VOICE_GATEWAY_DEVICE_TOKEN?.trim() ?? "";
  const gatewayUrl = voice.gatewayUrl?.trim() || "ws://127.0.0.1:18789";
  const gatewayHttpBase = voice.gatewayHttpUrl?.trim() || gatewayUrl.replace(/^ws/, "http");
  if (bridgeToken.length < 32 || !deviceToken) {
    api.logger.warn("query_voice_disabled reason=missing_private_tokens");
    return;
  }

  let driver: GatewayTalkDriver;
  const client = new GatewayClient({
    url: gatewayUrl,
    deviceToken,
    role: "operator",
    scopes: ["operator.write"],
    clientDisplayName: "Query voice bridge",
    onEvent: frame => driver?.handleGatewayEvent(frame as {event: string; payload?: unknown}),
    onClose: () => driver?.handleGatewayClosed(),
  });
  driver = new GatewayTalkDriver({
    verified: voice.verified === true,
    gateway: client,
    gatewayHttpBase,
    fetch,
    registry: voiceRuns,
    resolveTarget: scope => resolveVoiceTarget(cfg, scope, params =>
      getQueryRuntime().channel.routing.resolveAgentRoute(params as never) as {sessionKey: string; agentId: string}),
    oauthOnly: target => {
      // Same agent store the Talk session will resolve credentials from.
      const agentDir = resolveAgentDir(cfg, target.agentId);
      return checkVoiceOAuthOnly(cfg as Record<string, any>, {
        env: process.env,
        agentDir,
        isProfileConfigured: params => isProviderAuthProfileConfigured(params as never),
      });
    },
    claimDelegation: (scope, target, claim) => claimDelegation(scope, target, claim, bridgeToken),
  });
  const journal = voice.journalDir?.trim() ||
    join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw"), "query-voice-journal");
  const bridge = new QueryVoiceBridge(journal, driver);
  const handler = voiceBridgeHandler(bridge, bridgeToken);
  api.registerHttpRoute({
    path: "/plugins/query/voice",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => { await handler(req, res); return true; },
  });
  api.on("gateway_start", () => { client.start(); });
  api.on("gateway_stop", () => { client.stop(); driver.handleGatewayClosed(); });
}
