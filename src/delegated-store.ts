import type { QueryDelegatedAuth } from "./types.js";

/**
 * Credenciales delegadas vigentes, por hilo.
 *
 * Una herramienta se ejecuta fuera del turno: su contexto no dice de quien es
 * el mensaje que la provoco. Por eso la credencial se guarda cuando llega el
 * mensaje y la herramienta la pide por ``thread_id``, en vez de usar "la
 * ultima" — que en un canal con varias personas seria la de cualquiera y el
 * agente acabaria leyendo datos de una con los permisos de otra.
 */

type StoredAuth = {
  auth: QueryDelegatedAuth;
  socketUrl: string;
  expiresAt: number;
};

const byThread = new Map<string, StoredAuth>();

// Margen para no usar un token que caduca mientras viaja la peticion.
const EXPIRY_MARGIN_MS = 5_000;

function expiryOf(auth: QueryDelegatedAuth): number {
  if (auth.expires_at) {
    const parsed = Date.parse(auth.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const seconds = typeof auth.expires_in === "number" ? auth.expires_in : 900;
  return Date.now() + seconds * 1000;
}

export function rememberDelegatedAuth(
  threadId: string | number,
  auth: QueryDelegatedAuth | undefined,
  socketUrl: string,
): void {
  if (!auth?.token) return;
  byThread.set(String(threadId), {
    auth,
    socketUrl,
    expiresAt: expiryOf(auth),
  });
}

export function getDelegatedAuth(threadId: string | number): StoredAuth | undefined {
  const key = String(threadId);
  const stored = byThread.get(key);
  if (!stored) return undefined;
  if (stored.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
    // Caducada: se olvida en vez de dejar que una herramienta la use y reciba
    // un 401 que el agente no sabria interpretar.
    byThread.delete(key);
    return undefined;
  }
  return stored;
}

export function forgetDelegatedAuth(threadId: string | number): void {
  byThread.delete(String(threadId));
}

/** Hilos con credencial viva; el agente los ve para saber que puede consultar. */
export function threadsWithDelegatedAuth(): string[] {
  const alive: string[] = [];
  for (const [threadId] of byThread) {
    if (getDelegatedAuth(threadId)) alive.push(threadId);
  }
  return alive;
}
