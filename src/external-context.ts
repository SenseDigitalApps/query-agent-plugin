/** Versioned local bridge. Written only from trusted inbound/runtime context. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QueryDelegatedAuth } from "./types.js";

export type ExternalContext = {
  version: 1;
  sessionKey: string;
  senderId: string;
  threadId: string;
  queryAccountId: string;
  socketUrl: string;
  agentToken: string;
  clientMsgId: string;
  auth: QueryDelegatedAuth;
  expiresAt: number;
};

function directory(): string {
  return process.env.QUERY_EXTERNAL_CONTEXT_DIR?.trim() ||
    join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw"), "query-external-contexts");
}
function path(key: string): string {
  return join(directory(), createHash("sha256").update(key).digest("hex") + ".json");
}
function sessionKey(session: string, sender: string, account: string): string {
  return JSON.stringify([session, account, sender]);
}
function write(key: string, value: ExternalContext): void {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const target = path(key);
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, target);
}
function read(key: string): ExternalContext | undefined {
  try {
    const value = JSON.parse(readFileSync(path(key), "utf8")) as ExternalContext;
    if (value.version === 1 && value.auth?.token && value.agentToken && value.socketUrl &&
        value.sessionKey && value.senderId && value.clientMsgId && Number.isFinite(value.expiresAt)) return value;
  } catch { /* Missing context never authorizes a new operation. */ }
  return undefined;
}
export function rememberExternalContext(value: Omit<ExternalContext, "version" | "expiresAt">): void {
  const expiresAt = value.auth.expires_at ? Date.parse(value.auth.expires_at) :
    Date.now() + (value.auth.expires_in ?? 900) * 1000;
  try {
    write(sessionKey(value.sessionKey, value.senderId, value.queryAccountId), { ...value, version: 1, expiresAt });
  } catch { /* A new bridge must not interrupt delivery to legacy users. */ }
}
export function pinExternalRun(runId?: string, session?: string, sender?: string, account?: string): void {
  if (!runId || !session || !sender || !account) return;
  const value = read(sessionKey(session, sender, account));
  if (value) {
    try { write(`run:${runId}`, value); } catch { /* Keep legacy delivery available. */ }
  }
}
export async function externalContextForRun(runId?: string): Promise<ExternalContext | undefined> {
  if (!runId) return undefined;
  const value = read(`run:${runId}`);
  if (!value) return undefined;
  if (value.expiresAt - 5000 > Date.now()) return value;
  const { refreshQueryDelegatedAuth } = await import("./socket.js");
  const refreshed = await refreshQueryDelegatedAuth(value.threadId, value.socketUrl, value.clientMsgId);
  if (!refreshed?.token) throw new Error("query_delegation_refresh_unavailable");
  // The backend reissues THIS message's actor, never the last speaker's identity.
  if (refreshed.identity?.id !== value.auth.identity?.id ||
      refreshed.external_account_identity?.id !== value.auth.external_account_identity?.id) {
    throw new Error("query_delegation_identity_changed");
  }
  const updated = { ...value, auth: refreshed, expiresAt: refreshed.expires_at ?
    Date.parse(refreshed.expires_at) : Date.now() + (refreshed.expires_in ?? 900) * 1000 };
  write(`run:${runId}`, updated);
  const latest = read(sessionKey(value.sessionKey, value.senderId, value.queryAccountId));
  if (latest?.clientMsgId === value.clientMsgId) write(sessionKey(value.sessionKey, value.senderId, value.queryAccountId), updated);
  return updated;
}
