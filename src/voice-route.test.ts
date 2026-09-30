import { expect, it, vi } from "vitest";
import { checkVoiceOAuthOnly, isEffectiveOAuthRoute, isRequestedOAuthRoute, EFFECTIVE_VOICE_ROUTE } from "./voice-route.js";

const oauthOnly = (types: string[]) => vi.fn((params: {profileTypes: string[]}) =>
  params.profileTypes.some(type => types.includes(type)));

it("admits only released GPT-Live over WebRTC with OAuth", () => {
  const base = {provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", brain: "agent-consult", auth_mode: "oauth"};
  expect(isRequestedOAuthRoute(base)).toBe(true);
  expect(isRequestedOAuthRoute({...base, model: "gpt-realtime-2.1"})).toBe(false);
  expect(isRequestedOAuthRoute({...base, model: "gpt-live-unlisted"})).toBe(false);
  expect(isRequestedOAuthRoute({...base, auth_mode: "platform"})).toBe(false);
  expect(isRequestedOAuthRoute({...base, transport: "gateway-relay"})).toBe(false);
  expect(isEffectiveOAuthRoute(EFFECTIVE_VOICE_ROUTE)).toBe(true);
  expect(isEffectiveOAuthRoute({...EFFECTIVE_VOICE_ROUTE, auth_mode: "platform" as never})).toBe(false);
});

it("fails closed when any Platform source the runtime would fall back to is reachable", () => {
  const cfg = {talk: {realtime: {}}};
  expect(checkVoiceOAuthOnly(cfg, {env: {}, isProfileConfigured: oauthOnly(["oauth"])})).toEqual({ok: true});
  // Image or other Platform key exported to the Gateway process.
  expect(checkVoiceOAuthOnly(cfg, {env: {OPENAI_API_KEY: "sk-image"}, isProfileConfigured: oauthOnly(["oauth"])}))
    .toEqual({ok: false, reason: "voice_platform_credential_reachable"});
  // `openai` api_key auth profile in the agent store.
  expect(checkVoiceOAuthOnly(cfg, {env: {}, isProfileConfigured: oauthOnly(["oauth", "api_key"])}))
    .toEqual({ok: false, reason: "voice_platform_credential_reachable"});
  // Configured realtime key, even a SecretRef.
  expect(checkVoiceOAuthOnly({talk: {realtime: {providers: {openai: {apiKey: {source: "env", id: "X"}}}}}},
    {env: {}, isProfileConfigured: oauthOnly(["oauth"])})).toEqual({ok: false, reason: "voice_platform_credential_reachable"});
  expect(checkVoiceOAuthOnly(cfg, {env: {}, isProfileConfigured: oauthOnly([])}))
    .toEqual({ok: false, reason: "voice_oauth_profile_missing"});
  expect(checkVoiceOAuthOnly({talk: {realtime: {model: "gpt-realtime-2.1"}}}, {env: {}, isProfileConfigured: oauthOnly(["oauth"])}))
    .toEqual({ok: false, reason: "voice_realtime_model_mismatch"});
});

it("models.providers.openai.apiKey (image generation) is not a Talk realtime source", () => {
  const cfg = {models: {providers: {openai: {apiKey: "sk-image"}}}, talk: {realtime: {}}};
  expect(checkVoiceOAuthOnly(cfg, {env: {}, isProfileConfigured: oauthOnly(["oauth"])})).toEqual({ok: true});
});
