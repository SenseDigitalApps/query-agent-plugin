import type { QueryDelegatedAuth } from "./types.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  clientMsgId?: string;
  expiresAt: number;
};

const byThread = new Map<string, StoredAuth>();

// Margen para no usar un token que caduca mientras viaja la peticion.
const EXPIRY_MARGIN_MS = 5_000;
const STORE_VERSION = 1;

function stateFile(): string {
  const configured = process.env.QUERY_DELEGATED_AUTH_STATE_FILE?.trim();
  if (configured) return configured;
  const root = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(root, "query-delegated-auth.json");
}

/**
 * Metadatos seguros para correlacionar el proceso que recibe un mensaje con el
 * que ejecuta una tool. No expone tokens ni el contenido de la credencial.
 */
export function delegatedAuthStoreDiagnostics(): {
  stateFile: string;
  keys: string[];
} {
  loadFromDisk();
  return {
    stateFile: stateFile(),
    keys: [...byThread.keys()].sort(),
  };
}

function expiryOf(auth: QueryDelegatedAuth): number {
  if (auth.expires_at) {
    const parsed = Date.parse(auth.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const seconds = typeof auth.expires_in === "number" ? auth.expires_in : 900;
  return Date.now() + seconds * 1000;
}

function isStoredAuth(value: unknown): value is StoredAuth {
  if (!value || typeof value !== "object") return false;
  const candidate = value as StoredAuth;
  return (
    typeof candidate.auth?.token === "string" &&
    typeof candidate.socketUrl === "string" &&
    typeof candidate.expiresAt === "number"
  );
}

function loadFromDisk(): void {
  const file = stateFile();
  if (!existsSync(file)) {
    byThread.clear();
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      records?: Record<string, unknown>;
    };
    if (parsed.version !== STORE_VERSION || !parsed.records) return;
    const fromDisk = new Map<string, StoredAuth>();
    for (const [threadId, stored] of Object.entries(parsed.records)) {
      if (isStoredAuth(stored)) fromDisk.set(threadId, stored);
    }
    byThread.clear();
    for (const [threadId, stored] of fromDisk) byThread.set(threadId, stored);
  } catch {
    // Un archivo corrupto no debe bloquear el chat; se reemplaza al guardar.
  }
}

function persistToDisk(): void {
  const file = stateFile();
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    {
      version: STORE_VERSION,
      records: Object.fromEntries(byThread),
    },
    null,
    2,
  );
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort: writeFileSync already requested 0600 for newly created files.
  }
  renameSync(tmp, file);
}

function pruneExpired(now = Date.now()): boolean {
  let changed = false;
  for (const [threadId, stored] of byThread) {
    if (stored.expiresAt - EXPIRY_MARGIN_MS <= now) {
      byThread.delete(threadId);
      changed = true;
    }
  }
  return changed;
}

export function rememberDelegatedAuth(
  threadId: string | number,
  auth: QueryDelegatedAuth | undefined,
  socketUrl: string,
  clientMsgId?: string,
): void {
  loadFromDisk();
  if (!auth?.token) return;
  byThread.set(String(threadId), {
    auth,
    socketUrl,
    clientMsgId,
    expiresAt: expiryOf(auth),
  });
  pruneExpired();
  persistToDisk();
}

export function getDelegatedAuth(threadId: string | number): StoredAuth | undefined {
  loadFromDisk();
  const key = String(threadId);
  const stored = byThread.get(key);
  if (!stored) return undefined;
  if (stored.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
    // Caducada: se olvida en vez de dejar que una herramienta la use y reciba
    // un 401 que el agente no sabria interpretar.
    byThread.delete(key);
    persistToDisk();
    return undefined;
  }
  return stored;
}

export function peekDelegatedAuth(threadId: string | number): StoredAuth | undefined {
  loadFromDisk();
  return byThread.get(String(threadId));
}

export function forgetDelegatedAuth(threadId: string | number): void {
  loadFromDisk();
  byThread.delete(String(threadId));
  persistToDisk();
}

/** Hilos con credencial viva; el agente los ve para saber que puede consultar. */
export function threadsWithDelegatedAuth(): string[] {
  loadFromDisk();
  if (pruneExpired()) persistToDisk();
  return [...byThread.keys()];
}
