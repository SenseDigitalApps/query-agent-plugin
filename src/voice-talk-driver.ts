/**
 * QueryTalkDriver over OpenClaw Talk: GPT-Live (`gpt-live-1-codex`) with
 * Gateway-owned WebRTC control, authenticated by the ChatGPT OAuth profile.
 *
 * Supported path in OpenClaw 2026.9.4 (dist/talk-*.mjs, createTalkClient):
 *   talk.client.create {sessionKey, provider, model, mode:"realtime",
 *     transport:"webrtc", brain:"agent-consult", capabilities:["gateway-control-v1"]}
 *   -> {clientControl:{owner:"gateway"}, clientSecret (60 s, one use),
 *       offerUrl:"/plugins/openai/realtime/calls", voiceSessionId}
 *   POST <gateway>/plugins/openai/realtime/calls (Bearer clientSecret,
 *     application/sdp, no Origin) -> answer SDP; media then flows directly
 *     between the phone and OpenAI. The Gateway keeps the sideband, runs the
 *     agent consults (createTalkClientAgentConsultRunner), enforces Talk's
 *     spoken confirmations and broadcasts `talk.event` to THIS connection only.
 *   talk.client.close {sessionKey, voiceSessionId} ends the logical session.
 *
 * The driver never sees an OAuth token or Platform key. It refuses to start if
 * any Platform credential is reachable (see voice-route.ts), because the
 * runtime would otherwise fall back to it silently.
 */
import { createHash } from "node:crypto";
import type { QueryTalkDriver, VoiceScope } from "./voice-bridge.js";
import { VoicePresenceGuard } from "./voice-presence.js";
import { EFFECTIVE_VOICE_ROUTE, VOICE_OAUTH_ROUTE, isRequestedOAuthRoute, type OAuthOnlyVerdict,
  type VoiceEffectiveRoute } from "./voice-route.js";
import type { VoiceDelegationClaim, VoiceDelegationResult, VoiceRunRegistry } from "./voice-run-binding.js";
import type { VoiceCallTarget } from "./voice-target.js";

type Payload = Record<string, unknown>;
type Emit = (event: Payload & {event_id: string; type: string}) => void;

export type TalkGatewayClient = {
  request<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T>;
  readonly connected: boolean;
};

export type TalkEventFrame = {event: string; payload?: unknown};

export type { VoiceCallTarget } from "./voice-target.js";

export type GatewayTalkDriverDeps = {
  verified: boolean;
  gateway: TalkGatewayClient;
  gatewayHttpBase: string;
  fetch: typeof fetch;
  registry: VoiceRunRegistry;
  /** coreHost: the tenant API host Core reports in the start request. */
  resolveTarget: (scope: VoiceScope, coreHost?: string) => VoiceCallTarget | undefined;
  /** Live calls allowed on this Gateway at once; GPT-Live caps at 8. */
  maxConcurrentCalls?: number;
  oauthOnly: (target: VoiceCallTarget) => OAuthOnlyVerdict;
  claimDelegation: (scope: VoiceScope, target: VoiceCallTarget, claim: VoiceDelegationClaim) => Promise<VoiceDelegationResult>;
  leaseMs?: number;
  now?: () => number;
};

type ActiveCall = {
  scope: VoiceScope;
  target: VoiceCallTarget;
  voiceSessionId: string;
  clientSecret?: string;
  offerExpiresAt: number;
  leaseUntil: number;
  emit: Emit;
  presence: VoicePresenceGuard;
  speaking: Set<string>;
  heard: Set<string>;
  ended: boolean;
};

const OFFER_PATH = "/plugins/openai/realtime/calls";
const shortId = (value: string) => value.length <= 120 ? value : createHash("sha256").update(value).digest("hex");
const str = (value: unknown) => typeof value === "string" && value ? value : undefined;
const sdpIsAudioOnly = (sdp: string) => sdp.includes("m=audio") && !sdp.includes("m=video") && !sdp.includes("m=application");

export class GatewayTalkDriver implements QueryTalkDriver {
  readonly verified: boolean;
  private calls = new Map<string, ActiveCall>();
  private bySession = new Map<string, string>();
  private leaseMs: number;
  private now: () => number;
  private leaseTimer?: ReturnType<typeof setInterval>;

  constructor(private deps: GatewayTalkDriverDeps) {
    this.verified = deps.verified;
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  owns(scope: VoiceScope): boolean {
    const call = this.calls.get(scope.call_id);
    return Boolean(call && !call.ended && this.deps.gateway.connected && sameScope(call.scope, scope));
  }

  async start(scope: VoiceScope, payload: Payload, emit: Emit): Promise<VoiceEffectiveRoute> {
    if (!isRequestedOAuthRoute(payload)) throw Error("unsupported_voice_route");
    const live = [...this.calls.values()].filter(call => !call.ended).length;
    if (live >= (this.deps.maxConcurrentCalls ?? 6)) throw Error("voice_capacity_full");
    const target = this.deps.resolveTarget(scope, typeof payload.core_host === "string" ? payload.core_host : undefined);
    if (!target) throw Error("voice_account_unmapped");
    const verdict = this.deps.oauthOnly(target);
    if (!verdict.ok) throw Error(verdict.reason);
    if (!this.deps.gateway.connected) throw Error("voice_gateway_unavailable");
    this.deps.registry.registerCall({
      scope, sessionKey: target.sessionKey, accountId: target.accountId,
      socketUrl: target.socketUrl, agentToken: target.agentToken,
      claim: claim => this.deps.claimDelegation(scope, target, claim),
      onAccepted: (runId, consultId) => {
        const call = this.calls.get(scope.call_id);
        call?.presence.activity();
        call?.emit({event_id: shortId(`accepted:${runId}`), type: "task.accepted", run_id: runId, consult_id: consultId});
      },
    });
    let session: Payload;
    try {
      session = await this.deps.gateway.request<Payload>("talk.client.create", {
        sessionKey: target.sessionKey,
        provider: VOICE_OAUTH_ROUTE.provider,
        model: VOICE_OAUTH_ROUTE.model,
        mode: "realtime",
        transport: VOICE_OAUTH_ROUTE.transport,
        brain: VOICE_OAUTH_ROUTE.brain,
        capabilities: [VOICE_OAUTH_ROUTE.capability],
      });
    } catch {
      this.deps.registry.unregisterCall(scope.call_id);
      throw Error("voice_talk_create_failed");
    }
    const voiceSessionId = str(session.voiceSessionId);
    const clientSecret = str(session.clientSecret);
    const control = session.clientControl as Payload | undefined;
    const accepted = voiceSessionId && clientSecret && control?.owner === "gateway" &&
      session.provider === VOICE_OAUTH_ROUTE.provider && session.transport === VOICE_OAUTH_ROUTE.transport &&
      session.offerUrl === OFFER_PATH && (session.model === undefined || session.model === VOICE_OAUTH_ROUTE.model);
    // Re-check after creation: a Platform key added meanwhile could have been used.
    const stillOAuth = this.deps.oauthOnly(target).ok;
    if (!accepted || !stillOAuth) {
      if (voiceSessionId) await this.closeTalk(target.sessionKey, voiceSessionId).catch(() => undefined);
      this.deps.registry.unregisterCall(scope.call_id);
      // After creation it is no longer a pre-effect refusal: report uncertainty.
      throw Error(stillOAuth ? "voice_talk_route_mismatch" : "voice_platform_credential_appeared");
    }
    const expires = typeof session.expiresAt === "number" ? session.expiresAt : this.now() + 60_000;
    const inactivityMs = Number(payload.inactivity_seconds ?? 120) * 1000;
    const graceMs = Number(payload.presence_grace_seconds ?? 30) * 1000;
    const call: ActiveCall = {
      scope, target, voiceSessionId: voiceSessionId!, clientSecret, offerExpiresAt: expires,
      leaseUntil: this.now() + this.leaseMs, emit, speaking: new Set(), heard: new Set(), ended: false,
      presence: new VoicePresenceGuard({
        inactivityMs, graceMs,
        onPrompt: (challengeId, deadline) => emit({event_id: shortId(`presence:${challengeId}`),
          type: "presence.required", challenge_id: challengeId, deadline: new Date(deadline).toISOString()}),
        onCloseAudio: () => { this.finish(scope.call_id, "presence_timeout").catch(() => undefined); },
      }),
    };
    this.calls.set(scope.call_id, call);
    this.bySession.set(call.voiceSessionId, scope.call_id);
    this.ensureLeaseTimer();
    return {...EFFECTIVE_VOICE_ROUTE};
  }

  async control(scope: VoiceScope, payload: Payload): Promise<Payload> {
    const call = this.calls.get(scope.call_id);
    if (payload.kind === "close") {
      if (call) await this.finish(scope.call_id, "client_close");
      return {status: "completed"};
    }
    if (!call || call.ended || !sameScope(call.scope, scope)) throw Error("voice_call_not_owned");
    switch (payload.kind) {
      case "offer": return {sdp: await this.exchangeOffer(call, String(payload.sdp ?? ""))};
      case "presence": {
        const challenge = String(payload.challenge_id ?? "");
        if (!call.presence.confirmPresence(challenge)) throw Error("voice_challenge_not_active");
        call.emit({event_id: shortId(`presence-ok:${challenge}`), type: "presence.confirmed", challenge_id: challenge});
        return {status: "completed"};
      }
      // Gateway-controlled GPT-Live exposes no per-call output cancel to an
      // external owner, and talk.client.steer is session-wide (it could cancel
      // a text run in the same chat). Speaking "para"/"cancela" is handled by
      // the Gateway per call. Refuse rather than touch the wrong work.
      case "interrupt": throw Error("voice_interrupt_unsupported");
      case "cancel_task": throw Error("voice_cancel_unsupported");
      default: throw Error("invalid_voice_control");
    }
  }

  async touch(scope: VoiceScope): Promise<void> {
    const call = this.calls.get(scope.call_id);
    if (!call || call.ended || !sameScope(call.scope, scope)) throw Error("voice_call_not_owned");
    call.leaseUntil = this.now() + this.leaseMs;
  }

  /** Feed from the GatewayClient `onEvent`. Only this connection receives them. */
  handleGatewayEvent(frame: TalkEventFrame): void {
    if (frame.event !== "talk.event") return;
    const payload = frame.payload as {voiceSessionId?: string; talkEvent?: Payload} | undefined;
    const callId = payload?.voiceSessionId ? this.bySession.get(payload.voiceSessionId) : undefined;
    const call = callId ? this.calls.get(callId) : undefined;
    const talk = payload?.talkEvent;
    if (!call || call.ended || !talk || typeof talk.type !== "string") return;
    const id = str(talk.id) ?? `${talk.type}:${talk.seq}`;
    const turnId = str(talk.turnId);
    const data = (talk.payload ?? {}) as Payload;
    const emit = (event: Payload & {type: string}, key = id) =>
      call.emit({...event, event_id: shortId(`talk:${key}`)});
    switch (talk.type) {
      case "session.ready":
        emit({type: "call.listening"});
        return;
      case "input.audio.committed":
      case "transcript.delta":
        call.presence.activity();
        if (turnId && !call.heard.has(turnId)) { call.heard.add(turnId); emit({type: "speech.activity"}, `speech:${turnId}`); }
        return;
      case "output.audio.started":
        call.presence.activity();
        if (turnId) { call.speaking.add(turnId); emit({type: "audio.started", turn_id: turnId}); }
        return;
      case "output.audio.done":
        call.presence.activity();
        if (turnId && call.speaking.delete(turnId)) emit({type: "audio.stopped", turn_id: turnId});
        return;
      case "transcript.done": {
        const text = str(data.text);
        const role = data.role === "user" || data.role === "assistant" ? data.role : undefined;
        if (!text || !role || talk.final === false) return;
        call.presence.activity();
        // One writer: the item id is stable across Gateway replays.
        emit({type: "transcript.final", item_id: shortId(str(talk.itemId) ?? id), role, text}, `final:${str(talk.itemId) ?? id}`);
        return;
      }
      case "tool.progress": {
        const runId = str(data.runId);
        if (runId) { call.presence.activity(); emit({type: "task.progress", run_id: runId}); }
        return;
      }
      case "session.error":
        emit({type: "call.error", error_code: "provider_session_error"});
        this.finish(call.scope.call_id, "provider_error").catch(() => undefined);
        return;
      case "session.closed":
        this.finish(call.scope.call_id, "provider_closed").catch(() => undefined);
        return;
      default:
        return; // Unknown or audio-level deltas are not part of Query's contract.
    }
  }

  /** Gateway connection lost: the Gateway itself closes sessions it no longer can reach. */
  handleGatewayClosed(): void {
    for (const callId of [...this.calls.keys()]) this.finish(callId, "gateway_connection_lost", false).catch(() => undefined);
  }

  private async exchangeOffer(call: ActiveCall, sdp: string): Promise<string> {
    const secret = call.clientSecret;
    call.clientSecret = undefined; // One use, even if the exchange fails.
    if (!secret || this.now() >= call.offerExpiresAt) throw Error("voice_offer_expired");
    if (!sdp || sdp.length > 262_144 || !sdpIsAudioOnly(sdp)) throw Error("audio_only_offer_required");
    const response = await this.deps.fetch(new URL(OFFER_PATH, this.deps.gatewayHttpBase), {
      method: "POST",
      headers: {authorization: `Bearer ${secret}`, "content-type": "application/sdp"},
      body: sdp,
    });
    const answer = await response.text();
    if (!response.ok || answer.length > 262_144 || !sdpIsAudioOnly(answer)) throw Error("voice_offer_rejected");
    call.presence.activity();
    return answer;
  }

  private async finish(callId: string, _reason: string, closeRemote = true): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    call.ended = true;
    call.presence.dispose();
    this.deps.registry.unregisterCall(callId);
    this.bySession.delete(call.voiceSessionId);
    try {
      if (closeRemote) await this.closeTalk(call.target.sessionKey, call.voiceSessionId);
    } finally {
      call.emit({event_id: shortId(`ended:${callId}`), type: "call.ended"});
      this.calls.delete(callId);
    }
  }

  private async closeTalk(sessionKey: string, voiceSessionId: string): Promise<void> {
    if (!this.deps.gateway.connected) return;
    await this.deps.gateway.request("talk.client.close", {sessionKey, voiceSessionId});
  }

  private ensureLeaseTimer(): void {
    if (this.leaseTimer) return;
    this.leaseTimer = setInterval(() => {
      const now = this.now();
      for (const [callId, call] of this.calls) if (!call.ended && call.leaseUntil <= now) this.finish(callId, "lease_expired").catch(() => undefined);
      if (this.calls.size === 0 && this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = undefined; }
    }, 5_000);
    this.leaseTimer.unref?.();
  }
}

function sameScope(a: VoiceScope, b: VoiceScope): boolean {
  return a.call_id === b.call_id && a.tenant === b.tenant && a.user_id === b.user_id &&
    a.thread_id === b.thread_id && a.agent_id === b.agent_id;
}
