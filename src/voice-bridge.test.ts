import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryVoiceBridge, type QueryTalkDriver, type VoiceScope } from "./voice-bridge.js";
import { withVoiceExecution, voiceContextForTool } from "./voice-execution-context.js";
import type { ExternalContext } from "./external-context.js";
const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, {recursive: true, force: true}); });
const scope: VoiceScope = {call_id: "f98a57d5-3587-4794-bc8f-58dc71de7391", tenant: "synthetic_a", user_id: 7, thread_id: 102, agent_id: 3};
const payload = {provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", brain: "agent-consult", auth_mode: "oauth"};
const request = (data: Record<string, unknown> = payload, target = scope) => ({version: 1, scope: target, payload: data});

it("durably claims starts and commands, isolates actors and never repeats an uncertain effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-voice-")); dirs.push(directory);
  const driver: QueryTalkDriver = {verified: true, owns: () => true, start: vi.fn(async (_s, _p, emit) => {
    emit({event_id: "ready", type: "call.listening"});
    return {control_owner: "gateway", identity_bound: true, provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", auth_mode: "oauth"} as const;
  }), control: vi.fn(async () => { throw Error("lost response"); }), touch: vi.fn(async () => {})};
  const bridge = new QueryVoiceBridge(directory, driver);
  await bridge.dispatch("start", request());
  const restored = new QueryVoiceBridge(directory, driver);
  await restored.dispatch("start", request());
  expect(driver.start).toHaveBeenCalledTimes(1);
  await expect(restored.dispatch("events", request({after: 0}, {...scope, user_id: 8}))).rejects.toThrow("scope");
  const events = await restored.dispatch("events", request({after: 0}));
  expect((events.events as unknown[]).length).toBe(1);
  const command = {kind: "cancel_task", run_id: "run-1", client_operation_id: "e5e834c6-71cf-4e73-8413-cddba5b04ea0"};
  await expect(restored.dispatch("control", request(command))).rejects.toThrow("uncertain");
  await expect(restored.dispatch("control", request(command))).rejects.toThrow("uncertain");
  expect(driver.control).toHaveBeenCalledTimes(1);
});

it("driver validation is mandatory even when provider catalog is ready", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-voice-")); dirs.push(directory);
  const start = vi.fn();
  const bridge = new QueryVoiceBridge(directory, {verified: false, owns: () => false, start, control: vi.fn(), touch: vi.fn()});
  await expect(bridge.dispatch("start", request())).rejects.toThrow("not_verified");
  expect(start).not.toHaveBeenCalled();
});

it("voice executions retain their delegated identity across overlapping async work", async () => {
  const context = {version: 1, sessionKey: "agent:query:query:102", senderId: "7", threadId: "102",
    queryAccountId: "synthetic_a", socketUrl: "wss://synthetic.invalid/ws", agentToken: "synthetic",
    clientMsgId: "voice-1", expiresAt: Date.now() + 1000,
    auth: {source: "voice", token: "synthetic", identity: {id: 7}, external_account_identity: {id: 7}}} as ExternalContext;
  const other = {...context, queryAccountId: "synthetic_b", senderId: "8", auth: {
    ...context.auth, identity: {...context.auth.identity!, id: 8}, external_account_identity: {...context.auth.external_account_identity!, id: 8}}};
  await Promise.all([context, other].map((ctx, i) => withVoiceExecution({runId: `run-${i}`, context: ctx, revalidate: async () => ctx}, async () => {
    await Promise.resolve();
    expect((await voiceContextForTool())?.senderId).toBe(ctx.senderId);
  })));
  expect(await voiceContextForTool()).toBeUndefined();
  await expect(withVoiceExecution({runId: "run", context, revalidate: async () => other}, voiceContextForTool)).rejects.toThrow("identity_changed");
  await expect(withVoiceExecution({runId: "run", context, revalidate: async () => {throw Error("revoked");}}, voiceContextForTool)).rejects.toThrow("revoked");
});

it("rejects every Platform or GA route before touching the driver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-voice-")); dirs.push(directory);
  const start = vi.fn();
  const bridge = new QueryVoiceBridge(directory, {verified: true, owns: () => true, start, control: vi.fn(), touch: vi.fn()});
  for (const variant of [
    {...payload, model: "gpt-realtime-2.1"},
    {...payload, auth_mode: "platform"},
    {...payload, transport: "gateway-relay"},
    {provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", brain: "agent-consult"},
  ]) {
    await expect(bridge.dispatch("start", request(variant, {...scope, call_id: crypto.randomUUID()}))).rejects.toThrow("unsupported_voice_route");
  }
  expect(start).not.toHaveBeenCalled();
});

it("treats a Platform-billed voice usage event or route as a failed start", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-voice-")); dirs.push(directory);
  const control = vi.fn(async () => ({}));
  const platformRoute: QueryTalkDriver = {verified: true, owns: () => true, control, touch: vi.fn(),
    start: vi.fn(async () => ({control_owner: "gateway", identity_bound: true, provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", auth_mode: "platform"}) as never)};
  await expect(new QueryVoiceBridge(directory, platformRoute).dispatch("start", request())).rejects.toThrow("voice_start_uncertain");
  const usage: QueryTalkDriver = {verified: true, owns: () => true, control, touch: vi.fn(), start: vi.fn(async (_s, _p, emit) => {
    emit({event_id: "u1", type: "usage.final", run_id: "voice-session:1",
      usage: {component: "voice", provider_response_id: "r1", auth_mode: "platform", input_tokens: 1, output_tokens: 1}});
    return {control_owner: "gateway", identity_bound: true, provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", auth_mode: "oauth"} as const;
  })};
  await expect(new QueryVoiceBridge(directory, usage).dispatch("start", request(payload, {...scope, call_id: "0c6b5e0e-0a3e-4b1c-9b1e-5d7f0f3d2a11"}))).rejects.toThrow("voice_start_uncertain");
});

it("reports pre-effect refusals by code and never retries them as a new session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-voice-")); dirs.push(directory);
  const start = vi.fn(async () => { throw Error("voice_oauth_profile_missing"); });
  const bridge = new QueryVoiceBridge(directory, {verified: true, owns: () => false, start, control: vi.fn(), touch: vi.fn()});
  await expect(bridge.dispatch("start", request())).rejects.toThrow("voice_oauth_profile_missing");
  await expect(bridge.dispatch("start", request())).rejects.toThrow("voice_start_refused");
  expect(start).toHaveBeenCalledTimes(1);
  // Provider-side or unknown failures stay uncertain and opaque.
  const opaque = new QueryVoiceBridge(directory, {verified: true, owns: () => false, control: vi.fn(), touch: vi.fn(),
    start: vi.fn(async () => { throw Error("sk-leaked provider detail"); })});
  await expect(opaque.dispatch("start", request(payload, {...scope, call_id: "3e0d2b8e-7a41-4f55-9d8e-2f7a4b1c6d90"})))
    .rejects.toThrow("voice_start_uncertain");
});
