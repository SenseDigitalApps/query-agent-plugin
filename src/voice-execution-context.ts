import { AsyncLocalStorage } from "node:async_hooks";
import type { ExternalContext } from "./external-context.js";

export type VoiceExecutionBinding = {
  runId: string;
  context: ExternalContext;
  // Must call authenticated Core delegation endpoint for THIS consult/run.
  // Throws on revocation or actor/tenant change; never uses thread fallback.
  revalidate: () => Promise<ExternalContext>;
};
const voiceExecution = new AsyncLocalStorage<VoiceExecutionBinding>();
export function hasVoiceExecution(): boolean { return voiceExecution.getStore() !== undefined; }

/** The verified Talk driver wraps execution BEFORE any tools can run.
 * Do not wrap a bare consult helper to bypass Talk's confirmation machinery.
 */
export function withVoiceExecution<T>(binding: VoiceExecutionBinding, execute: () => T): T {
  if (!binding.runId || binding.context.auth.source !== "voice" || !binding.context.auth.token ||
      String(binding.context.auth.identity?.id) !== binding.context.senderId ||
      binding.context.auth.identity?.id !== binding.context.auth.external_account_identity?.id) {
    throw Error("invalid_voice_execution_binding");
  }
  return voiceExecution.run(binding, execute);
}

export async function voiceContextForTool(): Promise<ExternalContext | undefined> {
  const binding = voiceExecution.getStore();
  if (!binding) return undefined;
  const fresh = await binding.revalidate();
  const previous = binding.context;
  if (["sessionKey", "senderId", "threadId", "queryAccountId", "socketUrl"].some(
      key => fresh[key as keyof ExternalContext] !== previous[key as keyof ExternalContext]) ||
      fresh.auth.source !== "voice" || !fresh.auth.token ||
      fresh.auth.identity?.id !== previous.auth.identity?.id ||
      fresh.auth.external_account_identity?.id !== previous.auth.external_account_identity?.id) {
    throw Error("voice_delegation_identity_changed");
  }
  return fresh;
}
