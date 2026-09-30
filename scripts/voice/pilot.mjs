/** Offline contract pilot. NOT registered as a tool, route, or production bridge.
 * Uses the installed public Talk SDK; injected read-only consult is a test port.
 * A durable Core transaction must replace this journal before live integration.
 */
import { createHash } from "node:crypto";
import {
  createTalkSessionController, createRealtimeVoiceAudioQueue,
  REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION,
} from "openclaw/plugin-sdk/realtime-voice";

const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeKeys = ["callId", "tenant", "userId", "threadId", "agentId", "sessionKey"];

export class VoiceContractPilot {
  constructor(scope, readOnlyConsult, snapshot) {
    if (REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION !== 1) throw Error("unsupported_sender_auth_revision");
    if (scopeKeys.some(key => !scope[key]) || !scope.sessionKey.startsWith(`agent:${scope.agentId}:`)) throw Error("invalid_scope");
    this.scope = Object.freeze({ ...scope });
    this.consult = readOnlyConsult;
    this.journal = snapshot ? structuredClone(snapshot) : {
      scope: { ...scope }, closed: false, transcripts: {}, consults: {}, usage: {},
    };
    this.assertScope(this.journal.scope);
    this.events = [];
    this.talk = createTalkSessionController({ sessionId: scope.callId, mode: "realtime",
      transport: "gateway-relay", brain: "agent-consult" }, { onEvent: event => this.events.push(event) });
    this.audio = createRealtimeVoiceAudioQueue("reject-newest");
  }

  assertScope(scope) {
    if (scopeKeys.some(key => scope[key] !== this.scope[key])) throw Error("scope_mismatch");
  }

  finalTranscript(scope, entryId, role, text) {
    this.assertScope(scope);
    if (!["user", "assistant"].includes(role) || !entryId || !text) throw Error("invalid_transcript");
    const entry = { role, text };
    const existing = this.journal.transcripts[entryId];
    if (existing && fingerprint(existing) !== fingerprint(entry)) throw Error("transcript_conflict");
    this.journal.transcripts[entryId] = entry;
    // Deliberately no consultation, chat.send or proposal-confirmation call.
    return { duplicate: Boolean(existing) };
  }

  async acceptedConsult(scope, consultId, question) {
    this.assertScope(scope);
    if (!consultId || !question) throw Error("invalid_consult");
    const existing = this.journal.consults[consultId];
    if (existing) {
      if (existing.digest !== fingerprint(question)) throw Error("consult_conflict");
      return structuredClone(existing);
    }
    if (this.journal.closed) throw Error("call_closed");
    const entry = { digest: fingerprint(question), status: "accepted" };
    this.journal.consults[consultId] = entry;
    try {
      entry.result = await this.consult({ ...this.scope, consultId, question,
        toolsAllow: ["query_modules_list", "query_module_describe", "query_records_search", "query_record_get"] });
      entry.status = "completed";
    } catch {
      // Unknown outcomes are reconciled; never auto-run an accepted consult again.
      entry.status = "unknown";
    }
    return structuredClone(entry);
  }

  recordUsage(scope, receipt) {
    this.assertScope(scope);
    if (!["voice", "agent"].includes(receipt.component) || !receipt.responseId || !receipt.runId ||
        ![receipt.inputTokens, receipt.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !["platform", "oauth"].includes(receipt.authMode)) throw Error("invalid_usage");
    // Usage belongs to one provider response, not its number of deliveries.
    const key = JSON.stringify([receipt.component, receipt.runId, receipt.responseId]);
    const normalized = { component: receipt.component, runId: receipt.runId, responseId: receipt.responseId,
      authMode: receipt.authMode, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens };
    const existing = this.journal.usage[key];
    if (existing && fingerprint(existing) !== fingerprint(normalized)) throw Error("usage_conflict");
    this.journal.usage[key] = normalized;
    // No price or billed amount is inferred, especially for OAuth.
    return { duplicate: Boolean(existing) };
  }

  interruptAudio(turnId) {
    if (this.talk.activeTurnId !== turnId) return { applied: false };
    this.audio.clear();
    this.talk.finishOutputAudio({ turnId, payload: { reason: "barge-in" } });
    return { applied: true };
  }

  endCall() {
    this.journal.closed = true;
    this.audio.clear();
    // No cancellation of accepted work and no rollback of Query actions.
  }

  snapshot() { return structuredClone(this.journal); }
}
