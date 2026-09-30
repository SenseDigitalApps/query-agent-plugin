# Voice pilot — A/B contract verification, not a live feature

Current delivery adds `src/voice-bridge.ts`, `voice-execution-context.ts` and
`voice-presence.ts`, plus tests. These are server integration components;
the verified `QueryTalkDriver` is not implemented/registered yet. See
`query-core/docs/agent-voice/SERVER-HANDOFF.md` for the exact driver obligations,
authenticated Core endpoints, deployment flags and remaining SDK identity hook.
Do not expose a live route or claim a real call based on the offline pilot below.

Base: plugin `main` / `406b8bb`, installed OpenClaw `2026.9.4`.
Run `node --test scripts/voice/pilot.test.mjs`. No network, secrets or paid calls.
Also run `node --test scripts/voice/pilot.test.mjs scripts/voice/lab-authority.test.mjs`
for the synthetic identity/revocation checks: seven tests passed in total.
These simulate authority; they do not verify real JWTs or Query/Google credentials.
The isolated Compose and test-Gateway prerequisites are documented in
`query-core/docs/agent-voice/lab/README.md`.
It exercises the real public Talk controller and bounded PCM queue; audio is
synthetic and the read-only Query consultation is simulated. Five tests passed.
This is not evidence of microphone/WebRTC/provider/agent authentication working.

`pilot.mjs` is deliberately not registered as a plugin tool or route. Its journal
is serializable memory, not durable storage. Production must claim consultations
transactionally in Core and bind each run before Query/Google tools execute.

Canonical cross-repo design and proposed event schema:
`query-core/docs/agent-voice/INTEGRATION.md` and `contract.v1.json`.
Copied contracts in this directory must stay byte-identical to that source.

Verified installed RPCs: `talk.client.create` for WebRTC with
`capabilities:["gateway-control-v1"]`; `talk.session.create` for Gateway relay;
`talk.session.cancelOutput` is not task cancellation; `talk.client.close` needs
the original sessionKey and returned voiceSessionId. Use call-scoped controls.
OpenAI GA Gateway control requires Platform auth; OAuth is not a substitute.
The released GPT-Live route must be checked separately against the configured
provider. Do not change the selected model or drop to client-owned tool control.

Blocking live gap: ordinary Query inbound binds delegated actor/run; Talk bypasses
that handler. SDK sender-auth revision 1 forwards trusted sender facts, but a
Gateway operator login is not a Query user credential. Validate the complete
bridge with an authorized read-only staging call before exposing full mobile UI.
Retain Talk's exact high-impact confirmation and Query's proposal gates.
Transcripts are history, never another `chat.send` or `confirm_action`.

No production deployment/restart, provider call, or OpenClaw core modification
was performed. The five paired text/voice benchmark runs remain unmeasured.
