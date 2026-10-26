# Voice continuity — prepared, not deployed

2026-10-26. Requires coordinated Core → plugin → app rollout.

- Core accepts task.failed and sanitized call.ended reasons, persists the final reason and uses a shorter (3s connect, 8s read) status request timeout. Mutating operations are never automatically retried.
- Plugin reports bound agent_end outcomes exactly once; no cross-call cancellation. Delegation HTTP timeout10s, SDP20s. Identity revalidation and explicit presence confirmation remain mandatory.
- App tolerates transient status failures for25s, closes immediately on revoked/missing access, and no longer locally mutes output as a substitute for interruption. Spoken barge-in remains the route without per-call remote interruption. No ICE restart is claimed.

The JSON is a MERGE PATCH, not a replacement config. Apply through supported OpenClaw administration after backup/schema validation; preserve all other Talk keys. It reduces reasoning for Talk consults, not text agents. It is gateway-wide for Talk, so include other Talk surfaces in validation. Do not enable fast mode without checking provider semantics/cost. Config is prepared only; no running config changed.

Deploy Core first: old Core rejects task.failed. Drain live calls before plugin activation. App can roll out later. Roll back plugin before rolling Core back. No migrations required.

Remaining work outside these patches: live device latency (end-of-speech→first audio p50/p95), RTP loss/jitter, Wi-Fi/data handover, provider429 behavior, per-call remote interruption support in upstream runtime. Do not hide provider errors with unbounded retries or remove authorization checks. Presence policy is intentionally unchanged; long silence still requires explicit confirmation.

Tests: plugin typecheck and targeted voice suites, isolated Core adapter/ledger/approval suites, Flutter realtime_call/voice_presence/voice_call_screen. Unit tests do not prove actual phone network recovery or production activation.
