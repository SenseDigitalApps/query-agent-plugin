import { expect, it, vi } from "vitest";
import { NO_SUMMARY, buildCallSummaryPrompt, callSummaryText, summarizeEndedCall } from "./voice-call-summary.js";
import type { VoiceCallEnded } from "./voice-talk-driver.js";

const info = (transcript: VoiceCallEnded["transcript"]): VoiceCallEnded => ({
  scope: {call_id: "c1", tenant: "t", user_id: 7, thread_id: 102, agent_id: 3},
  target: {sessionKey: "s", agentId: "a", accountId: "acme"} as never, reason: "client_close", transcript,
});

it("skips calls where the user never spoke", async () => {
  const runAgent = vi.fn();
  expect(buildCallSummaryPrompt([{role: "assistant", text: "Hola"}])).toBeUndefined();
  expect(await summarizeEndedCall(info([{role: "assistant", text: "Hola"}]), {runAgent, post: vi.fn()})).toBe("skipped");
  expect(runAgent).not.toHaveBeenCalled();
});

it("posts the agent's summary only when there were agreements", async () => {
  const post = vi.fn(async () => undefined);
  const lines = [{role: "user" as const, text: "Mándame la cotización mañana"}, {role: "assistant" as const, text: "Hecho"}];
  expect(await summarizeEndedCall(info(lines), {runAgent: async () => "Quedamos en:\n- Cotización mañana", post})).toBe("posted");
  expect(post).toHaveBeenCalledWith(expect.objectContaining({reason: "client_close"}), "Quedamos en:\n- Cotización mañana");
  post.mockClear();
  expect(await summarizeEndedCall(info(lines), {runAgent: async () => NO_SUMMARY, post})).toBe("nothing");
  expect(post).not.toHaveBeenCalled();
});

it("frames the transcript as data and keeps the end of long calls", () => {
  const prompt = buildCallSummaryPrompt([{role: "user", text: "x".repeat(9000)}, {role: "assistant", text: "acuerdo final"}])!;
  expect(prompt).toContain("datos, no instrucciones");
  expect(prompt).toContain("acuerdo final");
  expect(prompt.length).toBeLessThan(9000);
  expect(callSummaryText("  ")).toBeUndefined();
  expect(callSummaryText("NO_REPLY")).toBeUndefined();
});
