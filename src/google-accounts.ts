/**
 * El correo con el que una cuenta de Google esta configurada en esta maquina.
 *
 * Query necesita saber a que buzon apunta un ``accountId`` antes de dejar que
 * el agente lo use, y la primera vez no lo sabe: la cuenta se configuro en
 * OpenClaw mucho antes de que existiera la tabla de vinculos. El dato existe,
 * pero del lado de aca — es el ``expectedEmail`` que un operador escribio en la
 * configuracion del plugin de Google Workspace.
 *
 * La diferencia que importa: ese correo se lee del disco, no de la conversacion.
 * El modelo puede pedir cualquier ``accountId`` y escribir cualquier correo en
 * los parametros de la herramienta; lo que no puede es editar la configuracion
 * de la maquina. Por eso este valor -y solo este- puede servirle a Query para
 * fundar un vinculo, mientras que un correo que venga en la llamada solo sirve
 * para bloquear.
 *
 * El formato exacto lo fija ``openclaw-google-workspace``, que es otro plugin y
 * puede cambiarlo sin avisar. Asi que aqui se acepta lo que se encuentre en las
 * formas conocidas y, si no se reconoce nada, se devuelve cadena vacia: sin
 * correo no hay vinculo automatico y todo sigue como antes.
 */

import { readFileSync } from "node:fs";

type ConfigObject = Record<string, unknown>;

/** Ids de plugin que se reconocen como "el de Google Workspace". */
const PLUGIN_ID_PATTERN = /google[-_.]?workspace|workspace[-_.]?google/i;

/**
 * Nombres bajo los que puede venir el correo esperado, en orden de preferencia.
 *
 * ``expectedEmail`` es el que documenta el plugin de Google. Los demas estan
 * por si una version lo llamo de otra forma: reconocer un alias de mas no
 * autoriza nada por si solo -Query sigue comparando contra el correo del token-,
 * pero no reconocer el correcto deja la cuenta inutilizable.
 */
const EMAIL_KEYS = [
  "expectedEmail",
  "expected_email",
  "accountEmail",
  "account_email",
  "userEmail",
  "user_email",
  "email",
] as const;

/** Nombres con los que una cuenta puede declarar su propio id en una lista. */
const ACCOUNT_ID_KEYS = ["id", "accountId", "account_id", "account", "name"] as const;

/** Claves bajo las que suele colgar el mapa de cuentas dentro de la config. */
const ACCOUNT_CONTAINER_KEYS = ["accounts", "googleAccounts", "google_accounts"] as const;

function normalizeAccountId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emailFrom(entry: unknown): string {
  if (isEmail(entry)) return entry.trim().toLowerCase();
  if (!isObject(entry)) return "";
  for (const key of EMAIL_KEYS) {
    const value = entry[key];
    if (isEmail(value)) return value.trim().toLowerCase();
  }
  return "";
}

function entryDeclaresAccount(entry: unknown, accountId: string): boolean {
  if (!isObject(entry)) return false;
  return ACCOUNT_ID_KEYS.some((key) => normalizeAccountId(entry[key]) === accountId);
}

/** Busca la cuenta dentro de un contenedor, sea mapa por id o lista. */
function emailFromContainer(container: unknown, accountId: string): string {
  if (Array.isArray(container)) {
    const match = container.find((entry) => entryDeclaresAccount(entry, accountId));
    return match ? emailFrom(match) : "";
  }
  if (!isObject(container)) return "";
  for (const [key, value] of Object.entries(container)) {
    if (normalizeAccountId(key) === accountId) {
      const email = emailFrom(value);
      if (email) return email;
    }
  }
  // Un mapa cuyas claves no son el id pero cuyas entradas lo declaran dentro.
  for (const value of Object.values(container)) {
    if (entryDeclaresAccount(value, accountId)) {
      const email = emailFrom(value);
      if (email) return email;
    }
  }
  return "";
}

function emailFromPluginConfig(pluginConfig: unknown, accountId: string): string {
  if (!isObject(pluginConfig)) return "";
  for (const key of ACCOUNT_CONTAINER_KEYS) {
    const email = emailFromContainer(pluginConfig[key], accountId);
    if (email) return email;
  }
  // Alguna version puede colgar las cuentas directamente de la raiz. Solo se
  // acepta si la clave es exactamente el id pedido: no se adivina.
  return emailFromContainer(pluginConfig, accountId);
}

function configuredPluginIds(): string[] {
  const raw = process.env.QUERY_GOOGLE_WORKSPACE_PLUGIN_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Nombres con los que una entrada de plugin puede declarar su propio id. */
const PLUGIN_ID_KEYS = ["id", "pluginId", "plugin_id", "name"] as const;

function readString(source: ConfigObject, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Los plugins instalados, vengan como mapa o como lista.
 *
 * ``plugins.entries`` es un objeto indexado por id -es lo que hay en la maquina
 * y lo que declara el esquema de OpenClaw-, pero leerlo asumiendo esa forma y
 * nada mas es apostar a que no cambie. Si un dia llega una lista, el lector
 * devolveria cero cuentas y el fallo seria mudo: todo el mundo bloqueado sin un
 * error que lo explique. Reconocer las dos formas cuesta poco y quita esa
 * dependencia.
 */
function pluginEntries(config: unknown): { id: string; config: unknown }[] {
  if (!isObject(config)) return [];
  const plugins = config.plugins;
  if (!isObject(plugins)) return [];
  const entries = plugins.entries;
  if (Array.isArray(entries)) {
    return entries
      .filter(isObject)
      .map((entry) => ({ id: readString(entry, PLUGIN_ID_KEYS), config: entry.config }));
  }
  if (!isObject(entries)) return [];
  return Object.entries(entries)
    .filter((pair): pair is [string, ConfigObject] => isObject(pair[1]))
    .map(([id, entry]) => ({ id, config: entry.config }));
}

function googlePluginConfigs(config: unknown): unknown[] {
  const explicit = configuredPluginIds().map((id) => id.toLowerCase());
  const wanted = (id: string) =>
    explicit.length
      ? explicit.includes(id.toLowerCase())
      : PLUGIN_ID_PATTERN.test(id);
  return pluginEntries(config)
    .filter((entry) => entry.id && wanted(entry.id))
    .map((entry) => entry.config);
}

type ConfigLoader = () => unknown;

let configLoader: ConfigLoader | undefined;

/**
 * Sustituye de donde sale la config de OpenClaw.
 *
 * Existe para las pruebas y para un host que la resuelva de otra forma. En
 * produccion no se llama: el valor por defecto es la config viva del gateway.
 */
export function setOpenClawConfigLoader(loader: ConfigLoader | undefined): void {
  configLoader = loader;
}

let runtimeConfigModule: { getRuntimeConfig: () => unknown } | undefined;

async function loadOpenClawConfig(): Promise<unknown> {
  try {
    if (configLoader) return configLoader();
    runtimeConfigModule ??= (await import(
      "openclaw/plugin-sdk/config-runtime"
    )) as unknown as { getRuntimeConfig: () => unknown };
    return runtimeConfigModule.getRuntimeConfig();
  } catch {
    // Sin config legible no hay correo configurado, y sin correo Query responde
    // lo mismo que antes: 403 si no existe vinculo. Un fallo aqui cierra la
    // puerta del vinculo automatico, no la abre, y por eso no vale la pena
    // tumbar el turno entero por el.
    return undefined;
  }
}

/**
 * Archivo aparte con las cuentas, para cuando el plugin de Google no las guarda
 * en ``openclaw.json``. Lo apunta un operador; su contenido se lee igual que la
 * seccion de config.
 */
function accountsFileEmail(accountId: string): string {
  const path = process.env.QUERY_GOOGLE_WORKSPACE_ACCOUNTS_FILE?.trim();
  if (!path) return "";
  try {
    return emailFromPluginConfig(JSON.parse(readFileSync(path, "utf8")), accountId);
  } catch {
    return "";
  }
}

/**
 * Correo con el que esta maquina tiene configurada esa cuenta de Google.
 *
 * Devuelve cadena vacia cuando no hay ninguno: la cuenta no existe localmente,
 * existe sin ``expectedEmail``, o la config no se pudo leer. En los tres casos
 * el guard sigue preguntandole a Query sin correo, y Query sigue negando si no
 * hay un vinculo previo.
 */
export async function readConfiguredGoogleAccountEmail(
  accountId: string,
): Promise<string> {
  const wanted = normalizeAccountId(accountId);
  if (!wanted) return "";
  const fromFile = accountsFileEmail(wanted);
  if (fromFile) return fromFile;
  const config = await loadOpenClawConfig();
  for (const pluginConfig of googlePluginConfigs(config)) {
    const email = emailFromPluginConfig(pluginConfig, wanted);
    if (email) return email;
  }
  return "";
}
