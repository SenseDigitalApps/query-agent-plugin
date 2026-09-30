import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceContractPilot } from "./pilot.mjs";

const scope = { callId: "call-1", tenant: "tenant-a", userId: "7", threadId: "102",
  agentId: "query-9", sessionKey: "agent:query-9:query:direct:102" };

test("actual Talk SDK accepts bounded PCM and output interruption without cancelling work", async () => {
  let finish;
  let calls = 0;
  const pilot = new VoiceContractPilot(scope, async bound => {
    calls++;
    assert.equal(bound.threadId, "102");
    assert.deepEqual(bound.toolsAllow, ["query_modules_list", "query_module_describe", "query_records_search", "query_record_get"]);
    return new Promise(resolve => { finish = resolve; });
  });
  const pcm = Buffer.alloc(960); // 20 ms, 24 kHz mono PCM16; synthetic, not microphone evidence.
  assert.equal(pilot.audio.enqueue(pcm), true);
  assert.deepEqual(pilot.audio.dequeue(), pcm);
  assert.equal(pilot.audio.enqueue(Buffer.alloc(1048577)), false);
  const pending = pilot.acceptedConsult(scope, "consult-1", "Consulta las actas de mi proyecto");
  const { turnId } = pilot.talk.startOutputAudio();
  assert.equal(pilot.interruptAudio("stale-turn").applied, false);
  assert.equal(pilot.talk.outputAudioActive, true);
  assert.equal(pilot.interruptAudio(turnId).applied, true);
  pilot.endCall();
  finish({ record_ids: [74], source: "mock-query-read-only" });
  assert.equal((await pending).status, "completed");
  assert.equal(calls, 1);
  assert.equal(pilot.talk.activeTurnId, turnId);
});

test("final transcripts and reconnect never execute an accepted consult twice", async () => {
  let calls = 0;
  const consult = async () => { calls++; return { record_ids: [] }; };
  const pilot = new VoiceContractPilot(scope, consult);
  pilot.finalTranscript(scope, "utterance-1", "user", "Consulta las actas");
  assert.equal(calls, 0);
  await pilot.acceptedConsult(scope, "consult-1", "Consulta las actas");
  const restored = new VoiceContractPilot(scope, consult, pilot.snapshot());
  assert.equal(restored.finalTranscript(scope, "utterance-1", "user", "Consulta las actas").duplicate, true);
  await restored.acceptedConsult(scope, "consult-1", "Consulta las actas");
  assert.equal(calls, 1);
  assert.throws(() => restored.finalTranscript(scope, "utterance-1", "user", "Texto distinto"), /conflict/);
});

test("tenant, user, thread, agent and call are not supplied by model arguments", async () => {
  const pilot = new VoiceContractPilot(scope, async () => assert.fail("must not consult"));
  for (const key of Object.keys(scope)) {
    const other = { ...scope, [key]: "other" };
    await assert.rejects(pilot.acceptedConsult(other, "consult-1", "lee datos"), /scope_mismatch/);
    assert.throws(() => pilot.finalTranscript(other, "entry", "user", "hola"), /scope_mismatch/);
    assert.throws(() => new VoiceContractPilot(other, () => {}, pilot.snapshot()));
  }
});

test("voice and agent usage deduplicate separately without inventing OAuth charges", () => {
  const pilot = new VoiceContractPilot(scope, () => {});
  for (const component of ["voice", "agent"]) {
    const receipt = { component, runId: "run-1", responseId: "response-1", authMode: "oauth", inputTokens: 11, outputTokens: 3 };
    assert.equal(pilot.recordUsage(scope, receipt).duplicate, false);
    assert.equal(pilot.recordUsage(scope, receipt).duplicate, true);
  }
  const usage = Object.values(pilot.snapshot().usage);
  assert.equal(usage.length, 2);
  assert.equal(usage.some(entry => "cost" in entry || "billedAmount" in entry), false);
});

test("uncertain consult and closed call never silently restart work", async () => {
  let calls = 0;
  const pilot = new VoiceContractPilot(scope, async () => { calls++; throw Error("connection lost"); });
  assert.equal((await pilot.acceptedConsult(scope, "c1", "lee")).status, "unknown");
  pilot.endCall();
  assert.equal((await pilot.acceptedConsult(scope, "c1", "lee")).status, "unknown");
  await assert.rejects(pilot.acceptedConsult(scope, "c2", "otra consulta"), /call_closed/);
  assert.equal(calls, 1);
});
