/** Query control-plane bridge. Host supplies a verified Talk driver, never a
 * second assistant. The only admitted route is voice-route.ts (GPT-Live over
 * ChatGPT OAuth); `verified` stays false until the live coordinated test.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EFFECTIVE_VOICE_ROUTE, VOICE_START_REFUSALS, isEffectiveOAuthRoute, isRequestedOAuthRoute, type VoiceEffectiveRoute } from "./voice-route.js";

export type VoiceScope = { call_id: string; tenant: string; user_id: number; thread_id: number; agent_id: number };
type Payload = Record<string, unknown>;
type Event = Payload & { event_id: string; sequence: number; call_id: string; type: string };
export type { VoiceEffectiveRoute } from "./voice-route.js";
// OAuth GPT-Live only. There is no Platform route and no fallback to one.
const expectedRoute: VoiceEffectiveRoute = EFFECTIVE_VOICE_ROUTE;
type Journal = { scope: VoiceScope; state: string; startDigest: string;
  operations: Record<string, { digest: string; status: string }>; events: Event[] };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const eventFields: Record<string, string[]> = {
  "call.listening": [], "call.ended": [], "call.error": ["error_code"],
  "audio.started": ["turn_id"], "audio.stopped": ["turn_id"],
  "speech.activity": [], "audio.activity": [], "task.progress": ["run_id"],
  "transcript.final": ["item_id", "role", "text"],
  "task.accepted": ["run_id", "consult_id"], "task.completed": ["run_id", "consult_id"], "task.cancelled": ["run_id", "consult_id"],
  "confirmation.required": ["confirmation_id", "text"],
  "presence.required": ["challenge_id", "deadline"], "presence.confirmed": ["challenge_id"],
  "usage.final": ["run_id", "usage"],
};
function safeEvent(input: Payload & {event_id: string; type: string}): Payload & {event_id: string; type: string} {
  if (!Object.hasOwn(eventFields, input.type) || typeof input.event_id !== "string" || !input.event_id || input.event_id.length > 128) throw Error("invalid_voice_event");
  const result: Payload & {event_id: string; type: string} = {event_id: input.event_id, type: input.type};
  for (const key of eventFields[input.type]) {
    if (key === "usage") {
      const usage = input.usage as Payload;
      if (!usage || typeof usage !== "object") throw Error("invalid_voice_usage");
      // Voice usage that is not OAuth would mean a Platform fallback happened.
      if (usage.component === "voice" && usage.auth_mode !== "oauth") throw Error("voice_usage_auth_mode_mismatch");
      result.usage = Object.fromEntries(["component", "provider_response_id", "auth_mode", "input_tokens", "output_tokens"].map(k => [k, usage[k] ?? null]));
    } else {
      const value = input[key];
      if (typeof value !== "string" || !value || value.length > (key === "text" ? 16000 : 128)) throw Error("invalid_voice_event_field");
      result[key] = value;
    }
  }
  return result;
}
const scopeKeys = ["call_id", "tenant", "user_id", "thread_id", "agent_id"] as const;

export interface QueryTalkDriver {
  /** True only after proving sender binding, both confirmation layers and lease cleanup.
   * A Gateway catalog's ready=true does NOT satisfy this assertion. */
  verified: boolean;
  owns(scope: VoiceScope): boolean;
  start(scope: VoiceScope, payload: Payload, emit: (event: Payload & {event_id: string; type: string}) => void): Promise<VoiceEffectiveRoute>;
  /** Must enforce call ownership and exact turn/run/challenge; close only media.
   * Must own Talk events and retain them until emitted into this durable outbox.
   * Must renew its media lease only from authenticated Core events polling,
   * close on lease expiry/process loss, and retain already accepted work. */
  control(scope: VoiceScope, payload: Payload): Promise<Payload>;
  touch(scope: VoiceScope): Promise<void>;
}

export class QueryVoiceBridge {
  constructor(private directory: string, private driver: QueryTalkDriver) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
  }
  private path(scope: VoiceScope): string { return join(this.directory, digest([scope.tenant, scope.call_id]) + ".json"); }
  private read(scope: VoiceScope): Journal | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path(scope), "utf8")) as Journal;
      if (scopeKeys.some(key => value.scope[key] !== scope[key])) throw Error("voice_scope_mismatch");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private write(value: Journal): void {
    const path = this.path(value.scope);
    writeFileSync(path + ".tmp", JSON.stringify(value), {mode: 0o600});
    renameSync(path + ".tmp", path);
  }
  private scope(value: unknown): VoiceScope {
    const s = value as VoiceScope;
    if (!s || Object.keys(s).length !== scopeKeys.length ||
        !/^[0-9a-f-]{36}$/i.test(s.call_id) || !/^[a-zA-Z0-9_]+$/.test(s.tenant) ||
        ![s.user_id, s.thread_id, s.agent_id].every(n => Number.isSafeInteger(n) && n > 0)) throw Error("invalid_voice_scope");
    return Object.fromEntries(scopeKeys.map(key => [key, s[key]])) as VoiceScope;
  }
  async dispatch(operation: string, input: unknown): Promise<Payload> {
    if (!this.driver.verified) throw Error("voice_driver_not_verified");
    const request = input as {version: number; scope: VoiceScope; payload: Payload};
    if (!request || request.version !== 1 || !request.payload || typeof request.payload !== "object") throw Error("invalid_voice_request");
    const scope = this.scope(request.scope);
    const payload = request.payload;
    let journal = this.read(scope);
    if (operation === "start") {
      if (!isRequestedOAuthRoute(payload)) throw Error("unsupported_voice_route");
      if (journal) {
        if (journal.startDigest !== digest(payload)) throw Error("voice_start_conflict");
        if (journal.state === "refused") throw Error("voice_start_refused");
        if (journal.state !== "started" || !this.driver.owns(scope)) throw Error("voice_start_uncertain");
        return {...expectedRoute};
      }
      journal = {scope, state: "accepted", startDigest: digest(payload), operations: {}, events: []};
      this.write(journal); // Claim before any provider effect. No retry on uncertainty.
      try {
        const route = await this.driver.start(scope, payload, rawEvent => {
          const event = safeEvent(rawEvent);
          const current = this.read(scope)!;
          if (current.events.some(e => e.event_id === event.event_id)) {
            const prior = current.events.find(e => e.event_id === event.event_id)!;
            if (digest({...event, call_id: scope.call_id, sequence: prior.sequence}) !== digest(prior)) throw Error("voice_event_conflict");
            return;
          }
          current.events.push({...event, call_id: scope.call_id, sequence: current.events.length + 1});
          this.write(current);
        });
        if (!isEffectiveOAuthRoute(route)) throw Error("voice_effective_route_mismatch");
        journal = this.read(scope)!;
        if (journal.state !== "accepted") {
          await this.driver.control(scope, {kind: "close", client_operation_id: scope.call_id});
          throw Error("voice_start_cancelled");
        }
        journal.state = "started";
        this.write(journal);
        return {...expectedRoute};
      } catch (error) {
        journal = this.read(scope)!;
        const code = error instanceof Error ? error.message : "";
        if (journal.state === "accepted" && VOICE_START_REFUSALS.has(code)) {
          // Refused before any Talk session existed: nothing to reconcile.
          journal.state = "refused";
          this.write(journal);
          throw Error(code);
        }
        if (journal.state === "accepted") journal.state = "unknown";
        this.write(journal);
        throw Error("voice_start_uncertain");
      }
    }
    if (!journal) {
      if (operation === "control" && payload.kind === "close") return {status: "completed"};
      throw Error("voice_call_not_found");
    }
    if (operation === "events") {
      const after = payload.after;
      if (!Number.isSafeInteger(after) || Number(after) < 0 || Number(after) > journal.events.length) throw Error("invalid_voice_cursor");
      if (journal.state === "started") {
        if (!this.driver.owns(scope)) throw Error("voice_owner_lost");
        await this.driver.touch(scope);
      }
      return {events: journal.events.slice(Number(after), Number(after) + 100)};
    }
    if (operation !== "control") throw Error("unsupported_voice_operation");
    const id = payload.client_operation_id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw Error("invalid_voice_operation_id");
    const prior = journal.operations[id];
    if (prior) {
      if (prior.digest !== digest(payload)) throw Error("voice_operation_conflict");
      if (payload.kind === "close" && prior.status !== "completed") {
        // Close has no new agent effect and can safely reconcile a lost ack.
        await this.driver.control(scope, payload);
        journal = this.read(scope)!; journal.operations[id].status = "completed"; journal.state = "closed"; this.write(journal);
        return {status: "completed"};
      }
      if (prior.status !== "completed" || payload.kind === "offer") throw Error("voice_operation_uncertain");
      return {status: prior.status};
    }
    if (journal.state !== "started" && payload.kind !== "close") throw Error("voice_call_closed");
    if (!["offer", "interrupt", "cancel_task", "presence", "close"].includes(String(payload.kind))) throw Error("invalid_voice_control");
    journal.operations[id] = {digest: digest(payload), status: "accepted"};
    if (payload.kind === "close") journal.state = "closing";
    this.write(journal);
    try {
      const result = await this.driver.control(scope, payload);
      journal = this.read(scope)!;
      if (payload.kind !== "close" && journal.state !== "started") {
        await this.driver.control(scope, {kind: "close", client_operation_id: scope.call_id});
        throw Error("voice_call_closed");
      }
      journal.operations[id].status = "completed";
      if (payload.kind === "close") journal.state = "closed";
      this.write(journal);
      // SDP is returned once, never journaled. Retry requires reconciliation.
      return payload.kind === "offer" ? {sdp: result.sdp} : {status: "completed"};
    } catch {
      journal = this.read(scope)!; journal.operations[id].status = "unknown"; this.write(journal);
      throw Error("voice_operation_uncertain");
    }
  }
}

export function voiceBridgeHandler(bridge: QueryVoiceBridge, token: string) {
  if (token.length < 32) throw Error("voice_bridge_token_too_short");
  const expected = createHash("sha256").update("Bearer " + token).digest();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const actual = createHash("sha256").update(req.headers.authorization ?? "").digest();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || !timingSafeEqual(expected, actual)) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 524288) throw Error("voice_request_too_large");
      }
      const operation = req.url?.split("?")[0]?.split("/").pop() ?? "";
      const result = await bridge.dispatch(operation, JSON.parse(body));
      res.end(JSON.stringify(result));
    } catch (error) {
      // Only our own pre-effect refusal codes leave this process.
      const code = error instanceof Error ? error.message : "";
      if (VOICE_START_REFUSALS.has(code)) { res.writeHead(409); res.end(JSON.stringify({error: code})); return; }
      res.writeHead(503); res.end('{"error":"voice_bridge_unavailable"}');
    }
  };
}
