import { randomUUID } from "node:crypto";

/** Server-side inactivity guard for a call owner. No maximum call duration.
 * The Talk adapter must feed live activity, never replayed transcripts/heartbeats.
 * A presence challenge is not a Talk or Query action confirmation.
 */
export class VoicePresenceGuard {
  private timer?: ReturnType<typeof setTimeout>;
  private challenge?: string;
  private deadline = 0;
  private closed = false;

  constructor(private readonly options: {
    inactivityMs: number;
    graceMs: number;
    onPrompt: (challengeId: string, deadline: number) => void;
    onCloseAudio: () => void;
  }) {
    if (![options.inactivityMs, options.graceMs].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error("invalid_presence_intervals");
    }
    this.activity();
  }

  activity(): void {
    if (this.closed || this.challenge) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.challenge = randomUUID();
      this.deadline = Date.now() + this.options.graceMs;
      this.timer = setTimeout(() => this.expire(), this.options.graceMs);
      this.options.onPrompt(this.challenge, this.deadline);
    }, this.options.inactivityMs);
  }

  /** Called only after Core verifies actor, membership, call and explicit click. */
  confirmPresence(challengeId: string): boolean {
    if (this.closed || !this.challenge || challengeId !== this.challenge) return false;
    if (Date.now() >= this.deadline) {
      this.expire();
      return false;
    }
    this.challenge = undefined;
    this.activity();
    return true;
  }

  private expire(): void {
    if (this.closed) return;
    this.dispose();
    // This callback closes media; it must not cancel accepted agent tasks.
    this.options.onCloseAudio();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.closed = true;
    this.challenge = undefined;
  }
}
