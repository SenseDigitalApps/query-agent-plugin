import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Que asset de Query corresponde a cada archivo que el agente ya subio.
 *
 * El agente trabaja sobre el mismo archivo del workspace una y otra vez:
 * escribe el informe, lo corrige, lo vuelve a mandar. Sin memoria de por medio
 * cada envio es un asset nuevo, asi que una tarde de correcciones deja diez
 * copias y nueve enlaces que ya no valen. Aqui se recuerda el asset que salio
 * de cada ruta para poder reemplazar su contenido en vez de crear otro.
 *
 * La clave es la ruta local mas el hilo. El hilo importa: el mismo archivo
 * mandado a dos canales son dos assets, cada uno con los permisos de su canal,
 * y reutilizar el id entre ellos filtraria un adjunto de un canal a otro.
 *
 * Se guarda en disco porque el gateway se reinicia y el agente sigue con el
 * mismo archivo abierto: perder el mapa en cada arranque devolveria justo el
 * problema que esto resuelve.
 */

type StoredArtifact = {
  attachmentId: string | number;
  /** Ultima vez que se uso, para poder caducar lo que ya nadie toca. */
  touchedAt: number;
};

const byKey = new Map<string, StoredArtifact>();

const STORE_VERSION = 1;
/**
 * Sin caducidad por defecto.
 *
 * Trabajar sobre un archivo es trabajar sobre un archivo, tarde una tarde o un
 * mes: mientras sea el mismo, su asset es el mismo y el enlace que la persona
 * ya tiene sigue sirviendo la version al dia. Un plazo que venciera solo
 * repartiria copias sin que nadie las pidiera, que es justo el problema que
 * esto resuelve.
 *
 * Conservar la version anterior es una decision, no un accidente del reloj: se
 * pide con ``forgetArtifact`` y entonces el siguiente envio crea un asset
 * nuevo. ``QUERY_ARTIFACT_REUSE_TTL_MS`` sigue disponible para quien quiera un
 * limite, pero apagado es el comportamiento normal.
 */
const DEFAULT_TTL_MS = 0;
const MAX_ENTRIES = 500;

function ttlMs(): number {
  const parsed = Number(process.env.QUERY_ARTIFACT_REUSE_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function stateFile(): string {
  const configured = process.env.QUERY_ARTIFACT_STATE_FILE?.trim();
  if (configured) return configured;
  const root = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(root, "query-artifacts.json");
}

function keyFor(threadId: string | number, path: string): string {
  return JSON.stringify([String(threadId), path]);
}

let loaded = false;

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  const file = stateFile();
  if (!existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      entries?: Array<[string, StoredArtifact]>;
    };
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.entries)) return;
    const now = Date.now();
    const expiry = ttlMs();
    for (const [key, value] of parsed.entries) {
      if (typeof key !== "string" || !value) continue;
      const { attachmentId, touchedAt } = value;
      if (attachmentId === undefined || attachmentId === null) continue;
      if (expiry > 0 && now - Number(touchedAt || 0) > expiry) continue;
      byKey.set(key, { attachmentId, touchedAt: Number(touchedAt || 0) });
    }
  } catch {
    // Un estado corrupto no puede impedir que el agente mande un archivo: se
    // empieza de cero y como mucho se crea un asset de mas.
  }
}

function persist(): void {
  const file = stateFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: STORE_VERSION, entries: [...byKey] }),
      { mode: 0o600 },
    );
    renameSync(temporary, file);
  } catch {
    // Sin disco el mapa sigue vivo en memoria durante este proceso.
  }
}

/**
 * El asset que ya salio de esta ruta, si sigue vigente.
 *
 * Devuelve `undefined` cuando no hay ninguno o cuando caduco, que son el mismo
 * caso para quien llama: toca crear uno nuevo.
 */
export function rememberedArtifact(
  threadId: string | number,
  path: string,
): string | number | undefined {
  loadFromDisk();
  const key = keyFor(threadId, path);
  const stored = byKey.get(key);
  if (!stored) return undefined;
  const expiry = ttlMs();
  if (expiry > 0 && Date.now() - stored.touchedAt > expiry) {
    byKey.delete(key);
    persist();
    return undefined;
  }
  return stored.attachmentId;
}

/** Anota el asset que quedo asociado a esta ruta. */
export function rememberArtifact(
  threadId: string | number,
  path: string,
  attachmentId: string | number | undefined | null,
): void {
  if (attachmentId === undefined || attachmentId === null) return;
  loadFromDisk();
  const key = keyFor(threadId, path);
  byKey.set(key, { attachmentId, touchedAt: Date.now() });
  if (byKey.size > MAX_ENTRIES) {
    // Se va el mas viejo: el mapa es una comodidad, no un registro que haya
    // que conservar entero.
    const oldest = [...byKey.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    )[0];
    if (oldest) byKey.delete(oldest[0]);
  }
  persist();
}

/**
 * Olvida la asociacion de una ruta: el proximo envio creara un asset nuevo.
 *
 * Dos motivos, uno deliberado y otro de rescate. El deliberado es conservar la
 * version anterior: lo pide el agente con ``query_artifact_new_version`` cuando
 * lo ya enviado debe seguir existiendo aparte. El de rescate es un asset que ya
 * no admite reemplazo -lo borraron, o Query lo rechaza-; sin esto el siguiente
 * envio reintentaria el mismo reemplazo imposible una y otra vez.
 */
export function forgetArtifact(threadId: string | number, path: string): void {
  loadFromDisk();
  if (byKey.delete(keyFor(threadId, path))) persist();
}

/** Solo para pruebas: deja el store como recien arrancado. */
export function resetArtifactStore(): void {
  byKey.clear();
  loaded = false;
}
