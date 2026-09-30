import { afterEach, expect, it, vi } from "vitest";
import { GatewayTalkDriver, type TalkGatewayClient, type VoiceCallTarget } from "./voice-talk-driver.js";
import { VoiceRunRegistry } from "./voice-run-binding.js";
import type { VoiceScope } from "./voice-bridge.js";

afterEach(() => { vi.useRealTimers(); });

const scope: VoiceScope = {call_id: "f98a57d5-3587-4794-bc8f-58dc71de7391", tenant: "tenant_a", user_id: 7, thread_id: 102, agent_id: 3};
const payload = {provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", brain: "agent-consult", auth_mode: "oauth",
  inactivity_seconds: 120, presence_grace_seconds: 30};
const target: VoiceCallTarget = {sessionKey: "agent:ventas:query:direct:102", agentId: "ventas", accountId: "acme",
  socketUrl: "wss://acme.invalid/ws/openclaw-agent/3/", agentToken: "bot", coreApiBase: "https://acme.invalid/api/v4/"};
const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function setup(overrides: Partial<ConstructorParameters<typeof GatewayTalkDriver>[0]> = {}, session: Record<string, unknown> = {}) {
  const request = vi.fn(async (method: string) => method === "talk.client.create" ? {
    provider: "openai", transport: "webrtc", clientSecret: "one-use", offerUrl: "/plugins/openai/realtime/calls",
    model: "gpt-live-1-codex", voice: "cove", expiresAt: Date.now() + 60_000, voiceSessionId: "vs-1",
    clientControl: {owner: "gateway"}, ...session,
  } : {ok: true});
  const gateway: TalkGatewayClient = {request: request as never, connected: true};
  const fetch = vi.fn(async () => new Response(answer, {status: 201, headers: {"content-type": "application/sdp"}}));
  const registry = new VoiceRunRegistry();
  const events: Record<string, unknown>[] = [];
  const driver = new GatewayTalkDriver({verified: true, gateway, gatewayHttpBase: "http://127.0.0.1:18789",
    fetch: fetch as never, registry, resolveTarget: () => target, oauthOnly: () => ({ok: true}),
    claimDelegation: vi.fn(), ...overrides});
  return {driver, request, fetch, registry, events, emit: (event: Record<string, unknown>) => { events.push(event); }};
}

it("creates the Gateway-controlled GPT-Live session on the thread's own session key", async () => {
  const {driver, request, registry, emit} = setup();
  const route = await driver.start(scope, payload, emit);
  expect(route).toEqual({provider: "openai", model: "gpt-live-1-codex", transport: "webrtc", auth_mode: "oauth",
    control_owner: "gateway", identity_bound: true});
  expect(request).toHaveBeenCalledWith("talk.client.create", {sessionKey: target.sessionKey, provider: "openai",
    model: "gpt-live-1-codex", mode: "realtime", transport: "webrtc", brain: "agent-consult", capabilities: ["gateway-control-v1"]});
  expect(registry.hasActiveCall(target.sessionKey)).toBe(true);
  expect(driver.owns(scope)).toBe(true);
  expect(driver.owns({...scope, user_id: 8})).toBe(false);
});

it("never creates a session when a Platform credential is reachable or the account is unmapped", async () => {
  const platform = setup({oauthOnly: () => ({ok: false, reason: "voice_platform_credential_reachable"})});
  await expect(platform.driver.start(scope, payload, platform.emit)).rejects.toThrow("voice_platform_credential_reachable");
  expect(platform.request).not.toHaveBeenCalled();
  const unmapped = setup({resolveTarget: () => undefined});
  await expect(unmapped.driver.start(scope, payload, unmapped.emit)).rejects.toThrow("voice_account_unmapped");
  const ga = setup();
  await expect(ga.driver.start(scope, {...payload, model: "gpt-realtime-2.1"}, ga.emit)).rejects.toThrow("unsupported_voice_route");
  expect(ga.request).not.toHaveBeenCalled();
});

it("closes and refuses a session the Gateway did not create as gateway-owned GPT-Live", async () => {
  const {driver, request, registry, emit} = setup({}, {clientControl: undefined});
  await expect(driver.start(scope, payload, emit)).rejects.toThrow("voice_talk_route_mismatch");
  expect(request).toHaveBeenCalledWith("talk.client.close", {sessionKey: target.sessionKey, voiceSessionId: "vs-1"});
  expect(registry.hasActiveCall(target.sessionKey)).toBe(false);
  let checks = 0;
  const raced = setup({oauthOnly: () => (++checks === 1 ? {ok: true} : {ok: false, reason: "voice_platform_credential_reachable"})});
  await expect(raced.driver.start(scope, payload, raced.emit)).rejects.toThrow("voice_platform_credential_appeared");
  expect(raced.request).toHaveBeenCalledWith("talk.client.close", {sessionKey: target.sessionKey, voiceSessionId: "vs-1"});
});

it("exchanges one audio-only offer through the Gateway broker with the one-use secret", async () => {
  const {driver, fetch, emit} = setup();
  await driver.start(scope, payload, emit);
  await expect(driver.control(scope, {kind: "offer", sdp: offer + "m=video 9 UDP 96\r\n"})).rejects.toThrow("audio_only_offer_required");
  // The secret was consumed by the rejected attempt: no retry with the same token.
  await expect(driver.control(scope, {kind: "offer", sdp: offer})).rejects.toThrow("voice_offer_expired");
  const fresh = setup();
  await fresh.driver.start(scope, payload, fresh.emit);
  expect(await fresh.driver.control(scope, {kind: "offer", sdp: offer})).toEqual({sdp: answer});
  const [url, init] = fresh.fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(url)).toBe("http://127.0.0.1:18789/plugins/openai/realtime/calls");
  expect(init.headers).toEqual({authorization: "Bearer one-use", "content-type": "application/sdp"});
  expect((init.headers as Record<string, string>).origin).toBeUndefined();
  void fetch;
});

it("maps Talk events once, ignores other voice sessions and keeps one transcript per item", async () => {
  const {driver, events, emit} = setup();
  await driver.start(scope, payload, emit);
  const talk = (talkEvent: Record<string, unknown>, voiceSessionId = "vs-1") =>
    driver.handleGatewayEvent({event: "talk.event", payload: {voiceSessionId, talkEvent}});
  talk({id: "e1", type: "session.ready", seq: 1});
  talk({id: "e2", type: "input.audio.committed", turnId: "u1", seq: 2});
  talk({id: "e3", type: "transcript.delta", turnId: "u1", seq: 3});
  talk({id: "e4", type: "transcript.done", turnId: "u1", itemId: "item-1", final: true, seq: 4, payload: {role: "user", text: "hola"}});
  talk({id: "e4b", type: "transcript.done", turnId: "u1", itemId: "item-1", final: true, seq: 5, payload: {role: "user", text: "hola"}});
  talk({id: "e5", type: "output.audio.started", turnId: "a1", seq: 6});
  talk({id: "e6", type: "output.audio.done", turnId: "a1", seq: 7});
  talk({id: "x", type: "transcript.done", itemId: "other", final: true, seq: 1, payload: {role: "user", text: "ajeno"}}, "vs-other");
  expect(events.map(event => event.type)).toEqual(["call.listening", "speech.activity", "transcript.final", "transcript.final", "audio.started", "audio.stopped"]);
  const finals = events.filter(event => event.type === "transcript.final");
  // Same provider item -> same event id: the bridge journal drops the replay.
  expect(finals[0].event_id).toBe(finals[1].event_id);
  expect(finals[0]).toMatchObject({item_id: "item-1", role: "user", text: "hola"});
});

it("refuses interrupt and cancel instead of steering the whole session, and closes idempotently", async () => {
  const {driver, request, registry, events, emit} = setup();
  await driver.start(scope, payload, emit);
  await expect(driver.control(scope, {kind: "interrupt", turn_id: "a1"})).rejects.toThrow("voice_interrupt_unsupported");
  await expect(driver.control(scope, {kind: "cancel_task", run_id: "r1"})).rejects.toThrow("voice_cancel_unsupported");
  expect(request).not.toHaveBeenCalledWith("talk.client.steer", expect.anything());
  await driver.control(scope, {kind: "close"});
  await driver.control(scope, {kind: "close"});
  expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(1);
  expect(events.filter(event => event.type === "call.ended")).toHaveLength(1);
  expect(registry.hasActiveCall(target.sessionKey)).toBe(false);
  expect(driver.owns(scope)).toBe(false);
});

it("closes audio when Core stops renewing the connectivity lease or the Gateway connection drops", async () => {
  vi.useFakeTimers();
  const {driver, events, emit} = setup({leaseMs: 60_000});
  await driver.start(scope, payload, emit);
  await vi.advanceTimersByTimeAsync(30_000);
  await driver.touch(scope);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(driver.owns(scope)).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(driver.owns(scope)).toBe(false);
  expect(events.at(-1)?.type).toBe("call.ended");

  const second = setup();
  await second.driver.start(scope, payload, second.emit);
  second.driver.handleGatewayClosed();
  await Promise.resolve();
  expect(second.driver.owns(scope)).toBe(false);
});

it("asks for presence after inactivity and only accepts the live challenge", async () => {
  vi.useFakeTimers();
  const {driver, events, emit} = setup({leaseMs: 10 * 60_000});
  await driver.start(scope, {...payload, inactivity_seconds: 120, presence_grace_seconds: 30}, emit);
  await vi.advanceTimersByTimeAsync(120_000);
  const prompt = events.find(event => event.type === "presence.required");
  expect(prompt).toBeDefined();
  await expect(driver.control(scope, {kind: "presence", challenge_id: "wrong"})).rejects.toThrow("voice_challenge_not_active");
  await driver.control(scope, {kind: "presence", challenge_id: String(prompt!.challenge_id)});
  expect(events.at(-1)).toMatchObject({type: "presence.confirmed"});
});

it("refuses before creating a session when the Gateway's voice lines are full", async () => {
  const {driver, request, emit} = setup({maxConcurrentCalls: 1});
  await driver.start(scope, payload, emit);
  await expect(driver.start({...scope, call_id: "5b4bd1f9-4a43-4f7e-8f6a-9c38b7fd7f1a", user_id: 8}, payload, emit))
    .rejects.toThrow("voice_capacity_full");
  expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(1);
});

it("passes Core's tenant host to the account resolver", async () => {
  const resolveTarget = vi.fn(() => target);
  const {driver, emit} = setup({resolveTarget});
  await driver.start(scope, {...payload, core_host: "apius.itsquery.com"}, emit);
  expect(resolveTarget).toHaveBeenCalledWith(scope, "apius.itsquery.com");
});
