/**
 * The only voice route Query admits: OpenAI released GPT-Live over WebRTC with
 * Gateway-owned control, authenticated by the OpenClaw ChatGPT OAuth profile.
 *
 * Source (OpenClaw 2026.9.4, installed package):
 * - dist/realtime-quicksilver-*.mjs: OPENAI_GPT_LIVE_MODELS = ["gpt-live-1-codex"],
 *   transports ["webrtc", "gateway-relay"], handlesAgentConsult=true.
 * - dist/realtime-voice-provider-factory-*.mjs: resolveBrowserSessionCapabilities
 *   reports supportsGatewayControl for a released GPT-Live model when an OAuth
 *   profile (or Platform input) is configured.
 * - dist/realtime-voice-session-policy-*.mjs: resolveOpenAIQuicksilverBridgeAuth
 *   tries OAuth first and then SILENTLY falls back to Platform
 *   (talk.realtime.providers.openai.apiKey, an `openai` api_key profile,
 *   OPENAI_API_KEY). The chosen credential type is not reported back to Talk
 *   clients, so Query must prove that no Platform input is reachable at all.
 */
export const VOICE_OAUTH_ROUTE = Object.freeze({
  provider: "openai",
  model: "gpt-live-1-codex",
  transport: "webrtc",
  brain: "agent-consult",
  capability: "gateway-control-v1",
  auth_mode: "oauth",
  control_owner: "gateway",
} as const);

export type VoiceEffectiveRoute = {
  provider: typeof VOICE_OAUTH_ROUTE.provider;
  model: typeof VOICE_OAUTH_ROUTE.model;
  transport: typeof VOICE_OAUTH_ROUTE.transport;
  auth_mode: typeof VOICE_OAUTH_ROUTE.auth_mode;
  control_owner: typeof VOICE_OAUTH_ROUTE.control_owner;
  identity_bound: true;
};

export const EFFECTIVE_VOICE_ROUTE: Readonly<VoiceEffectiveRoute> = Object.freeze({
  provider: VOICE_OAUTH_ROUTE.provider,
  model: VOICE_OAUTH_ROUTE.model,
  transport: VOICE_OAUTH_ROUTE.transport,
  auth_mode: VOICE_OAUTH_ROUTE.auth_mode,
  control_owner: VOICE_OAUTH_ROUTE.control_owner,
  identity_bound: true,
});

/** Core's start request. Anything else is rejected, including GA models. */
export function isRequestedOAuthRoute(payload: Record<string, unknown>): boolean {
  return payload.provider === VOICE_OAUTH_ROUTE.provider &&
    payload.model === VOICE_OAUTH_ROUTE.model &&
    payload.transport === VOICE_OAUTH_ROUTE.transport &&
    payload.brain === VOICE_OAUTH_ROUTE.brain &&
    payload.auth_mode === VOICE_OAUTH_ROUTE.auth_mode;
}

export function isEffectiveOAuthRoute(route: Partial<VoiceEffectiveRoute> | undefined): boolean {
  return Boolean(route) && (Object.keys(EFFECTIVE_VOICE_ROUTE) as (keyof VoiceEffectiveRoute)[])
    .every(key => route![key] === EFFECTIVE_VOICE_ROUTE[key]);
}

/**
 * Refusals raised BEFORE any Talk session or provider call exists. Only these
 * codes may leave the bridge (never provider text); Core shows them and frees
 * the call slot. Anything else stays an uncertain start.
 */
export const VOICE_START_REFUSALS: ReadonlySet<string> = new Set([
  "unsupported_voice_route",
  "voice_account_unmapped",
  "voice_platform_credential_reachable",
  "voice_oauth_profile_missing",
  "voice_realtime_model_mismatch",
  "voice_gateway_unavailable",
]);

export type OAuthOnlyDeps = {
  env: NodeJS.ProcessEnv;
  /** plugin-sdk/provider-auth isProviderAuthProfileConfigured, same inputs as the runtime. */
  isProfileConfigured: (params: {
    provider: string; cfg: unknown; agentDir?: string;
    profileTypes: ("oauth" | "api_key" | "token")[]; includeExternalCliAuth: boolean;
  }) => boolean;
  agentDir?: string;
};

export type OAuthOnlyVerdict =
  | { ok: true }
  | { ok: false; reason: "voice_platform_credential_reachable" | "voice_oauth_profile_missing" | "voice_realtime_model_mismatch" };

/**
 * Fails closed whenever the runtime COULD pick Platform for this session. Never
 * reads or returns a token. Only presence of each credential source is checked.
 */
export function checkVoiceOAuthOnly(cfg: Record<string, any>, deps: OAuthOnlyDeps): OAuthOnlyVerdict {
  const realtime = cfg?.talk?.realtime ?? {};
  const openai = realtime?.providers?.openai ?? {};
  const configuredKey = typeof openai.apiKey === "string" ? openai.apiKey.trim() : openai.apiKey;
  const platform = Boolean(configuredKey) ||
    Boolean(deps.env.OPENAI_API_KEY?.trim()) ||
    deps.isProfileConfigured({provider: "openai", cfg, agentDir: deps.agentDir,
      profileTypes: ["api_key"], includeExternalCliAuth: false});
  if (platform) return {ok: false, reason: "voice_platform_credential_reachable"};
  const configuredModel = realtime.model ?? openai.model;
  if (configuredModel !== undefined && configuredModel !== VOICE_OAUTH_ROUTE.model) {
    return {ok: false, reason: "voice_realtime_model_mismatch"};
  }
  const oauth = deps.isProfileConfigured({provider: "openai", cfg, agentDir: deps.agentDir,
    profileTypes: ["oauth"], includeExternalCliAuth: false});
  return oauth ? {ok: true} : {ok: false, reason: "voice_oauth_profile_missing"};
}
