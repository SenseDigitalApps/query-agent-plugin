/**
 * Wires Query voice into the Gateway process:
 * - hooks that bind every Talk consult run to its Query actor (always on, so a
 *   Talk session nobody owns can never borrow a thread's text credential);
 * - when `channels.query.voice.enabled`, the Gateway-owned driver, its private
 *   HTTP bridge for Core and a dedicated operator connection to this Gateway.
 *
 * Secrets: QUERY_AGENT_VOICE_BRIDGE_TOKEN (shared with Core, >= 32 chars) comes
 * from the Gateway environment. The connection to this Gateway uses a dedicated
 * operator device (src/voice-device.ts) that asks only for `operator.write` and
 * must be approved once with `openclaw devices approve <requestId>`. No OAuth
 * token or Platform key is read here.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { join } from "node:path";
import { homedir } from "node:os";
import { getQueryRuntime } from "./runtime.js";
import type { QueryConfig } from "./types.js";
import { QueryVoiceBridge, voiceBridgeHandler, type VoiceScope } from "./voice-bridge.js";
import { checkVoiceOAuthOnly } from "./voice-route.js";
import { voiceRuns, type VoiceDelegationResult } from "./voice-run-binding.js";
import { GatewayTalkDriver } from "./voice-talk-driver.js";
import { resolveVoiceTarget, type VoiceCallTarget, type VoiceRouteConfig } from "./voice-target.js";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/config-runtime";
import { voiceGatewayBootstrap } from "./voice-gateway-auth.js";
import { VOICE_OPERATOR_ROLE, VOICE_OPERATOR_SCOPES, VoiceOperatorDevice } from "./voice-device.js";

export type QueryVoiceConfig = {
  enabled?: boolean;
  /** Set true ONLY after the coordinated live test with the server agent. */
  verified?: boolean;
  gatewayUrl?: string;
  gatewayHttpUrl?: string;
  journalDir?: string;
  /** Private directory (0700) for the bridge's own operator device key and token. */
  deviceDir?: string;
  /** Optional overrides. Without them the account is found by Core host + bot id. */
  routes?: VoiceRouteConfig[];
  /** Voice calls open at once on this Gateway (GPT-Live allows 8). Default 6. */
  maxConcurrentCalls?: number;
};

export { coreApiBaseFromSocket, resolveVoiceTarget } from "./voice-target.js";

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
  const gatewayUrl = voice.gatewayUrl?.trim() || "ws://127.0.0.1:18789";
  const gatewayHttpBase = voice.gatewayHttpUrl?.trim() || gatewayUrl.replace(/^ws/, "http");
  if (bridgeToken.length < 32) {
    api.logger.warn("query_voice_disabled reason=missing_bridge_token");
    return;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  const device = new VoiceOperatorDevice(voice.deviceDir?.trim() || join(stateDir, "query-voice-device"));
  const {identity, deps} = device.hostDeps();
  api.logger.info(`query_voice_device device=${identity.deviceId.slice(0, 12)} scopes=${VOICE_OPERATOR_SCOPES.join(",")}`);

  const bootstrap = voiceGatewayBootstrap(gatewayUrl, (getRuntimeConfigSnapshot() ?? cfg).gateway?.auth,
    Boolean(deps.loadDeviceAuthToken({deviceId: identity.deviceId, role: VOICE_OPERATOR_ROLE})));
  let driver: GatewayTalkDriver;
  const client = new GatewayClient({
    url: gatewayUrl,
    ...bootstrap,
    role: VOICE_OPERATOR_ROLE,
    scopes: [...VOICE_OPERATOR_SCOPES],
    deviceIdentity: identity,
    hostDeps: deps,
    clientDisplayName: "Query voice bridge",
    // Default backend mode exempts local gateway-client from device pairing.
    // This app control connection must obtain its own scoped device token.
    clientName: "gateway-client",
    mode: "ui",
    onEvent: frame => driver?.handleGatewayEvent(frame as {event: string; payload?: unknown}),
    onHelloOk: () => api.logger.info(`query_voice_gateway_connected device=${identity.deviceId.slice(0, 12)} scopes=${VOICE_OPERATOR_SCOPES.join(",")}`),
    onClose: () => driver?.handleGatewayClosed(),
    // Pending approval shows up here; never log the error body (it may carry tokens).
    onConnectError: () => api.logger.warn(`query_voice_gateway_connect_pending device=${identity.deviceId.slice(0, 12)}`),
  });
  driver = new GatewayTalkDriver({
    verified: voice.verified === true,
    gateway: client,
    gatewayHttpBase,
    fetch,
    registry: voiceRuns,
    maxConcurrentCalls: voice.maxConcurrentCalls,
    resolveTarget: (scope, coreHost) => resolveVoiceTarget(cfg, scope, params =>
      getQueryRuntime().channel.routing.resolveAgentRoute(params as never) as {sessionKey: string; agentId: string},
      coreHost),
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
  const journal = voice.journalDir?.trim() || join(stateDir, "query-voice-journal");
  const bridge = new QueryVoiceBridge(journal, driver);
  const handler = voiceBridgeHandler(bridge, bridgeToken);
  api.registerHttpRoute({
    path: "/plugins/query/voice",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => { await handler(req, res); return true; },
  });
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    api.logger.info(`query_voice_gateway_start device=${identity.deviceId.slice(0, 12)}`);
    client.start();
  };
  const stop = () => { started = false; client.stop(); driver.handleGatewayClosed(); };
  // A full channel runtime can be hydrated after the one-shot gateway_start hook.
  // Services participate in runtime activation/replacement as well as initial boot.
  api.registerService({id: "query-voice-gateway", start, stop});
  api.on("gateway_start", start);
  api.on("gateway_stop", stop);
}
