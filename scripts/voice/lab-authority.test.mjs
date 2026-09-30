import { test } from "node:test";
import assert from "node:assert/strict";
import { LabAuthority } from "./lab-authority.mjs";

const alice = { callId: "lab-a", tenant: "synthetic_a", userId: "7", threadId: "102",
  agentId: "query", sessionKey: "agent:query:query:synthetic_a:102", accountId: "a",
  googleSubject: "synthetic-alice", expiresAt: 200 };
const bob = { ...alice, callId: "lab-b", tenant: "synthetic_b", accountId: "b",
  sessionKey: "agent:query:query:synthetic_b:102", googleSubject: "synthetic-bob" };

test("synthetic same numeric user/thread IDs cannot cross tenant or Google identity", () => {
  const authority = new LabAuthority([alice, bob]);
  authority.pin(alice.callId, "run-a", 100);
  authority.pin(bob.callId, "run-b", 100);
  assert.equal(authority.toolContext("run-a", alice, 100).googleSubject, "synthetic-alice");
  for (const key of ["tenant", "userId", "threadId", "agentId", "sessionKey", "accountId", "googleSubject"]) {
    assert.throws(() => authority.toolContext("run-a", { ...alice, [key]: "other" }, 100), /identity_mismatch/);
  }
  assert.throws(() => authority.toolContext("run-a", bob, 100), /identity_mismatch/);
  assert.throws(() => authority.toolContext("unbound", alice, 100), /missing_run_binding/);
  assert.throws(() => authority.pin(bob.callId, "run-a", 100), /run_already_bound/);
});

test("synthetic expiry, revocation and changed renewed identity fail closed on next tool", () => {
  const authority = new LabAuthority([alice]);
  authority.pin(alice.callId, "run-a", 100);
  assert.throws(() => authority.toolContext("run-a", alice, 200), /delegation_unavailable/);
  authority.bindings.get(alice.callId).googleSubject = "changed";
  assert.throws(() => authority.toolContext("run-a", alice, 150), /identity_mismatch/);
  authority.bindings.get(alice.callId).revoked = true;
  assert.throws(() => authority.toolContext("run-a", alice, 150), /delegation_unavailable/);
});
