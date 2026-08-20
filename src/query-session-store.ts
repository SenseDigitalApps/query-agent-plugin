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
 * Que sesion de OpenClaw corresponde a que canal de Query.
 *
 * Una herramienta no sabe de donde viene: recibe sus parametros y el nombre de
 * la sesion, nada mas. Para decidir si puede tocar una cuenta externa hace
 * falta la otra mitad del dato -en que canal de Query estamos y si el turno lo
 * disparo un cron-, y esa mitad solo se conoce cuando arranca el turno.
 *
 * Se apunta aqui al arrancar y se consulta al ejecutar. Va a disco por la misma
 * razon que las credenciales delegadas: el proceso que recibe el mensaje y el
 * que corre la herramienta no siempre son el mismo.
 */

export type QuerySessionBinding = {
  /** Canal de Query (``chatId`` del turno). Clave del store de credenciales. */
  threadId: string;
  /** Cuenta de Query por la que entro el turno, cuando se conoce. */
  accountId?: string;
  /** Presente solo si el turno lo disparo una tarea programada. */
  jobId?: string;
  updatedAt: number;
};

const bySessionKey = new Map<string, QuerySessionBinding>();

const STORE_VERSION = 1;
// Una sesion vieja no dice nada util y solo hace crecer el archivo. El limite
// es generoso: sobrevive a un turno largo o a una noche entre dos crones.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stateFile(): string {
  const configured = process.env.QUERY_SESSION_BINDING_STATE_FILE?.trim();
  if (configured) return configured;
  const root = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(root, "query-session-bindings.json");
}

function isBinding(value: unknown): value is QuerySessionBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as QuerySessionBinding;
  return (
    typeof candidate.threadId === "string" && typeof candidate.updatedAt === "number"
  );
}

function loadFromDisk(): void {
  const file = stateFile();
  if (!existsSync(file)) {
    bySessionKey.clear();
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      records?: Record<string, unknown>;
    };
    if (parsed.version !== STORE_VERSION || !parsed.records) return;
    bySessionKey.clear();
    for (const [sessionKey, stored] of Object.entries(parsed.records)) {
      if (isBinding(stored)) bySessionKey.set(sessionKey, stored);
    }
  } catch {
    // Un archivo corrupto no debe tumbar el turno; se reemplaza al guardar.
  }
}

function persistToDisk(): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    { version: STORE_VERSION, records: Object.fromEntries(bySessionKey) },
    null,
    2,
  );
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort: writeFileSync ya pidio 0600 al crear el archivo.
  }
  renameSync(tmp, file);
}

function pruneExpired(now = Date.now()): boolean {
  let changed = false;
  for (const [sessionKey, binding] of bySessionKey) {
    if (now - binding.updatedAt > MAX_AGE_MS) {
      bySessionKey.delete(sessionKey);
      changed = true;
    }
  }
  return changed;
}

export function rememberQuerySession(
  sessionKey: string | undefined,
  binding: Omit<QuerySessionBinding, "updatedAt">,
): void {
  const key = sessionKey?.trim();
  if (!key || !binding.threadId) return;
  loadFromDisk();
  bySessionKey.set(key, { ...binding, updatedAt: Date.now() });
  pruneExpired();
  persistToDisk();
}

export function getQuerySession(
  sessionKey: string | undefined,
): QuerySessionBinding | undefined {
  const key = sessionKey?.trim();
  if (!key) return undefined;
  loadFromDisk();
  return bySessionKey.get(key);
}

/**
 * Sesion Query por el canal al que pertenece.
 *
 * Red de seguridad para los hosts que ejecutan una herramienta sin decir de que
 * sesion viene. Buscar por hilo no puede confundirse con otra integracion: solo
 * acierta si ese id es exactamente un canal de Query que ya vimos.
 */
export function findQuerySessionByThread(
  threadId: string | undefined,
): QuerySessionBinding | undefined {
  const key = threadId?.trim();
  if (!key) return undefined;
  loadFromDisk();
  let newest: QuerySessionBinding | undefined;
  for (const binding of bySessionKey.values()) {
    if (binding.threadId !== key) continue;
    if (!newest || binding.updatedAt > newest.updatedAt) newest = binding;
  }
  return newest;
}

export function forgetQuerySession(sessionKey: string | undefined): void {
  const key = sessionKey?.trim();
  if (!key) return;
  loadFromDisk();
  if (bySessionKey.delete(key)) persistToDisk();
}

/** Solo para pruebas y diagnostico: sesiones Query vivas en el store. */
export function querySessionKeys(): string[] {
  loadFromDisk();
  if (pruneExpired()) persistToDisk();
  return [...bySessionKey.keys()].sort();
}
