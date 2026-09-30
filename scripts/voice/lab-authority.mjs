// Synthetic authority for OFFLINE tests only. Not Query authentication or a tool.
export class LabAuthority {
  constructor(bindings) {
    this.bindings = new Map(bindings.map(binding => [binding.callId, structuredClone(binding)]));
    this.runs = new Map();
  }

  authorize(callId, now) {
    const binding = this.bindings.get(callId);
    if (!binding || binding.revoked || now >= binding.expiresAt) throw Error("delegation_unavailable");
    return structuredClone(binding);
  }

  pin(callId, runId, now) {
    const binding = this.authorize(callId, now);
    if (this.runs.has(runId)) throw Error("run_already_bound");
    this.runs.set(runId, binding);
  }

  toolContext(runId, target, now) {
    const pinned = this.runs.get(runId);
    if (!pinned) throw Error("missing_run_binding");
    const current = this.authorize(pinned.callId, now);
    for (const key of ["tenant", "userId", "threadId", "agentId", "sessionKey", "accountId", "googleSubject"]) {
      if (current[key] !== pinned[key] || target[key] !== pinned[key]) throw Error("identity_mismatch");
    }
    return structuredClone(pinned);
  }
}
