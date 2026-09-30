import { afterEach, expect, it, vi } from "vitest";
import { VoicePresenceGuard } from "./voice-presence.js";

afterEach(() => vi.useRealTimers());

it("keeps active calls open and requires a current explicit challenge after silence", () => {
  vi.useFakeTimers();
  const onPrompt = vi.fn();
  const onCloseAudio = vi.fn();
  const guard = new VoicePresenceGuard({inactivityMs: 120000, graceMs: 30000, onPrompt, onCloseAudio});
  for (let minute = 0; minute < 60; minute++) {
    vi.advanceTimersByTime(60000);
    guard.activity();
  }
  expect(onPrompt).not.toHaveBeenCalled();
  vi.advanceTimersByTime(120000);
  const challenge = onPrompt.mock.calls[0][0];
  expect(guard.confirmPresence("wrong-call-or-stale")).toBe(false);
  expect(guard.confirmPresence(challenge)).toBe(true);
  expect(guard.confirmPresence(challenge)).toBe(false);
  vi.advanceTimersByTime(120000);
  guard.activity(); // Technical or delayed events never clear a visible prompt.
  vi.advanceTimersByTime(30000);
  expect(onCloseAudio).toHaveBeenCalledTimes(1);
  expect(guard.confirmPresence(onPrompt.mock.calls[1][0])).toBe(false);
  vi.advanceTimersByTime(3600000);
  expect(onCloseAudio).toHaveBeenCalledTimes(1);
});

it("hangup removes the idle timer", () => {
  vi.useFakeTimers();
  const onCloseAudio = vi.fn();
  const onPrompt = vi.fn();
  const guard = new VoicePresenceGuard({inactivityMs: 120000, graceMs: 30000, onPrompt, onCloseAudio});
  guard.dispose();
  vi.advanceTimersByTime(3600000);
  expect(onPrompt).not.toHaveBeenCalled();
  expect(onCloseAudio).not.toHaveBeenCalled();
});
