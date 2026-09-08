import { createHash } from "node:crypto";

const connections = new Map<string, string>();
const hash = (url: string) => createHash("sha256").update(url).digest("hex");
export function setProvisionReady(accountId: string, url: string, ready: boolean) {
  if (ready) connections.set(accountId, hash(url));
  else if (connections.get(accountId) === hash(url)) connections.delete(accountId);
}
export function isProvisionReady(accountId: string, url: string) {
  return connections.get(accountId) === hash(url);
}
export async function waitProvisionReady(accounts: Array<{ id: string; url: string }>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (accounts.every(account => isProvisionReady(account.id, account.url))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}
