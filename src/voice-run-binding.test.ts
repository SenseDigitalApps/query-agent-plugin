import { expect, it, vi } from "vitest";
import { VoiceRunRegistry, questionDigest, type ActiveVoiceCall, type VoiceDelegationResult } from "./voice-run-binding.js";
import type { VoiceScope } from "./voice-bridge.js";

const scopeA: VoiceScope = {call_id: "f98a57d5-3587-4794-bc8f-58dc71de7391", tenant: "tenant_a", user_id: 7, thread_id: 102, agent_id: 3};
const scopeB: VoiceScope = {call_id: "5b4bd1f9-4a43-4f7e-8f6a-9c38b7fd7f1a", tenant: "tenant_b", user_id: 8, thread_id: 102, agent_id: 3};
const run = (n: number) => `talk-realtime-consult:1759180000000:00000000-0000-4000-8000-00000000000${n}`;

const delegation = (scope: VoiceScope, replayed = false, id = scope.user_id): VoiceDelegationResult => ({
  scope, replayed,
  delegated_auth: {token: `tok-${scope.user_id}`, source: "voice", expires_in: 900,
    identity: {id} as never, external_account_identity: {id} as never},
});

function call(scope: VoiceScope, sessionKey: string, claim = vi.fn(async () => delegation(scope))): ActiveVoiceCall {
  return {scope, sessionKey, accountId: `acct-${scope.tenant}`, socketUrl: "wss://synthetic.invalid/ws", agentToken: "bot", claim};
}

it("leaves text runs alone and blocks Talk runs that no Query call owns", async () => {
  const registry = new VoiceRunRegistry();
  expect(await registry.beforeToolCall({runId: "run-text-1", sessionKey: "s-a", toolCallId: "t1"}, "query_records_search")).toBeUndefined();
  expect(registry.toolCallState("t1", "s-a")).toEqual({kind: "text"});
  registry.recordPrompt(run(1), "¿Cuántas ventas hubo ayer?");
  expect(await registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "t2"}, "query_records_search"))
    .toBe("voice_call_not_owned");
});

it("claims Core once per run before the first tool and hands the identity to that tool call only", async () => {
  const registry = new VoiceRunRegistry();
  const claim = vi.fn(async () => delegation(scopeA));
  const accepted = vi.fn();
  registry.registerCall({...call(scopeA, "s-a", claim), onAccepted: accepted});
  registry.recordPrompt(run(1), "¿Cuántas ventas hubo ayer?");
  registry.recordPrompt(run(1), "a later model call must not change the digest");
  await Promise.all([
    registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "t1"}, "query_records_search"),
    registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "t2"}, "query_record_get"),
  ]);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(claim).toHaveBeenCalledWith({consult_id: `consult:${run(1)}`, run_id: run(1),
    question_digest: questionDigest("¿Cuántas ventas hubo ayer?")});
  expect(accepted).toHaveBeenCalledWith(run(1), `consult:${run(1)}`);
  const state = registry.toolCallState("t1", "s-a");
  expect(state.kind === "voice" && state.binding.context.senderId).toBe("7");
  expect(state.kind === "voice" && state.binding.context.threadId).toBe("102");
});

it("blocks without the question, with a disallowed plugin tool, or when Core returns another actor or scope", async () => {
  const registry = new VoiceRunRegistry();
  registry.registerCall(call(scopeA, "s-a"));
  expect(await registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "t1"}, "query_records_search"))
    .toBe("voice_question_unavailable");
  registry.recordPrompt(run(2), "Envía un correo");
  expect(await registry.beforeToolCall({runId: run(2), sessionKey: "s-a", toolCallId: "t2"}, "query_smtp_send"))
    .toBe("voice_tool_not_allowed");

  const other = new VoiceRunRegistry();
  other.registerCall(call(scopeA, "s-a", vi.fn(async () => delegation(scopeA, false, 99))));
  other.recordPrompt(run(3), "hola");
  expect(await other.beforeToolCall({runId: run(3), sessionKey: "s-a", toolCallId: "t3"}, "query_records_search"))
    .toBe("voice_delegation_identity_mismatch");
  expect(other.toolCallState("t3", "s-a")).toEqual({kind: "refused", reason: "voice_run_not_bound"});

  const wrongScope = new VoiceRunRegistry();
  wrongScope.registerCall(call(scopeA, "s-a", vi.fn(async () => delegation({...scopeA, thread_id: 103}))));
  wrongScope.recordPrompt(run(4), "hola");
  expect(await wrongScope.beforeToolCall({runId: run(4), sessionKey: "s-a", toolCallId: "t4"}, "query_records_search"))
    .toBe("voice_delegation_scope_mismatch");
});

it("isolates concurrent calls of different tenants and never uses the thread slot during a call", async () => {
  const registry = new VoiceRunRegistry();
  registry.registerCall(call(scopeA, "s-a"));
  registry.registerCall(call(scopeB, "s-b"));
  expect(() => registry.registerCall(call({...scopeA, call_id: scopeB.call_id}, "s-a"))).toThrow("voice_session_already_active");
  registry.recordPrompt(run(1), "a"); registry.recordPrompt(run(2), "b");
  await registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "ta"}, "query_records_search");
  await registry.beforeToolCall({runId: run(2), sessionKey: "s-b", toolCallId: "tb"}, "query_records_search");
  const a = registry.toolCallState("ta", "s-a"); const b = registry.toolCallState("tb", "s-b");
  expect(a.kind === "voice" && a.binding.context.queryAccountId).toBe("acct-tenant_a");
  expect(b.kind === "voice" && b.binding.context.queryAccountId).toBe("acct-tenant_b");
  // A run from another session cannot adopt this call.
  registry.recordPrompt(run(5), "c");
  expect(await registry.beforeToolCall({runId: run(5), sessionKey: "s-other", toolCallId: "tc"}, "query_records_search"))
    .toBe("voice_call_not_owned");
  // Tool call the hook never saw, during an active call: refused, not the legacy slot.
  expect(registry.toolCallState("unseen", "s-a")).toEqual({kind: "refused", reason: "voice_tool_binding_missing"});
});

it("revalidation must be a replay of the same run and keeps the actor", async () => {
  const claim = vi.fn()
    .mockResolvedValueOnce(delegation(scopeA))
    .mockResolvedValueOnce(delegation(scopeA, true))
    .mockResolvedValueOnce(delegation(scopeA, false));
  const registry = new VoiceRunRegistry();
  registry.registerCall(call(scopeA, "s-a", claim));
  registry.recordPrompt(run(1), "hola");
  await registry.beforeToolCall({runId: run(1), sessionKey: "s-a", toolCallId: "t1"}, "query_records_search");
  expect((await registry.revalidate(run(1))).senderId).toBe("7");
  await expect(registry.revalidate(run(1))).rejects.toThrow("voice_delegation_not_replayed");
  // Accepted work keeps its binding after the audio closes.
  registry.unregisterCall(scopeA.call_id);
  expect(registry.hasActiveCall("s-a")).toBe(false);
});

it("provides only Core-validated speaker names for current hyphenated Talk runs", async () => {
  const registry = new VoiceRunRegistry();
  const claim = vi.fn(async () => {
    const result = delegation(scopeA);
    result.delegated_auth.identity!.display_name = 'Julián Vargas';
    return result;
  });
  registry.registerCall(call(scopeA, 's-a', claim));
  const ctx = {runId:'talk-realtime-consult-current-uuid',sessionKey:'s-a'};
  const context = await registry.speakerContext(ctx, '¿Cómo me llamo?');
  expect(context).toContain('Julián Vargas');
  expect(context).not.toContain('tok-');
  await registry.beforeToolCall({...ctx,toolCallId:'name-tool'},'query_records_search');
  expect(claim).toHaveBeenCalledTimes(1);
  expect(await registry.speakerContext({...ctx,sessionKey:'other'},'hola')).toBeUndefined();
  expect(await registry.speakerContext({runId:'text',sessionKey:'s-a'},'hola')).toBeUndefined();
});

it("rejects another actor's name and does not invent a missing name", async () => {
  const registry = new VoiceRunRegistry();
  registry.registerCall(call(scopeA, 's-a', vi.fn(async () => delegation(scopeA,false,99))));
  await expect(registry.speakerContext({runId:'talk-realtime-consult-bad',sessionKey:'s-a'},'hola'))
    .rejects.toThrow('voice_delegation_identity_mismatch');
  const neutral = new VoiceRunRegistry();
  neutral.registerCall(call(scopeA,'s-a'));
  expect(await neutral.speakerContext({runId:'talk-realtime-consult-neutral',sessionKey:'s-a'},'hola'))
    .toContain('no suministró el nombre');
});

it("does not present a username fallback as a person's real name", async () => {
  const registry = new VoiceRunRegistry();
  registry.registerCall(call(scopeA,'s-a',vi.fn(async()=>{
    const r=delegation(scopeA);r.delegated_auth.identity={id:7,username:'JCVARGAS',display_name:'JCVARGAS'};return r;
  })));
  expect(await registry.speakerContext({runId:'talk-realtime-consult-username',sessionKey:'s-a'},'mi nombre'))
    .toContain('no suministró el nombre');
  const actual = new VoiceRunRegistry();
  actual.registerCall(call(scopeA,'s-a',vi.fn(async()=>{
    const r=delegation(scopeA);r.delegated_auth.identity={id:7,username:'JCVARGAS',display_name:'JCVARGAS',full_name:'Julián'};return r;
  })));
  const context=await actual.speakerContext({runId:'talk-realtime-consult-realname',sessionKey:'s-a'},'mi nombre');
  expect(context).toContain('"name":"Julián"');
  expect(context).toContain('"username":"JCVARGAS"');
});
