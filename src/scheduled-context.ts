import { AsyncLocalStorage } from "node:async_hooks";
import { getDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import { getQuerySession, rememberQuerySession } from "./query-session-store.js";

type Credential = NonNullable<ReturnType<typeof getDelegatedAuth>>;
export const scheduledToolContext = new AsyncLocalStorage<Credential>();

/** Resolve only the isolated run's slot; never inspect a human credential. */
export async function scheduledCredential(sessionKey?: string): Promise<
  { threadId: string; credential: Credential } | undefined
> {
  const session = getQuerySession(sessionKey);
  if (!session?.jobId) return undefined;
  if (!session.authKey || !session.accountId) {
    throw new Error("query_schedule_authorization_missing: resincroniza el cron desde un turno autorizado de su creador.");
  }
  let credential = getDelegatedAuth(session.authKey);
  if (!credential) {
    const { requestQueryScheduleAuth } = await import("./socket.js");
    const granted = await requestQueryScheduleAuth(
      session.deliveryThreadId ?? session.threadId, session.jobId, session.accountId,
    );
    if (!granted || granted.auth.source !== "schedule") {
      throw new Error("query_schedule_authorization_missing: Query no autorizó esta tarea; no se usará otra identidad ni otro tenant.");
    }
    rememberDelegatedAuth(session.authKey, granted.auth, granted.socketUrl);
    credential = getDelegatedAuth(session.authKey);
    if (granted.auth.thread_id) {
      session.threadId = granted.auth.thread_id;
      rememberQuerySession(sessionKey, session);
    }
  }
  if (!credential || credential.auth.source !== "schedule") {
    throw new Error("query_schedule_authorization_missing");
  }
  return { threadId: credential.auth.thread_id ?? session.threadId, credential };
}
