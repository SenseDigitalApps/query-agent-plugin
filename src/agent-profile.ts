import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { getQueryRuntime } from "./runtime.js";
import { CHANNEL_ID, type QueryAgentProfile, type QueryConfig } from "./types.js";

/**
 * Delimitadores de lo que administra Query dentro de cada archivo.
 *
 * Existen porque el workspace no es nuestro: la persona pudo escribir su propio
 * `SOUL.md` mucho antes de conectar Query, y sobrescribir el archivo entero le
 * borraria ese trabajo en la primera edicion desde el panel. Van como
 * comentarios de Markdown, asi que se leen igual que el resto del archivo
 * cuando OpenClaw lo inyecta en el system prompt.
 */
export const QUERY_SECTION_BEGIN =
  "<!-- query:begin — gestionado desde el panel de Query -->";
export const QUERY_SECTION_END = "<!-- query:end -->";

/**
 * A que archivo va cada campo.
 *
 * `SOUL.md` es la voz del agente e `IDENTITY.md` quien es y para que existe:
 * son los nombres que OpenClaw arranca como bootstrap del workspace, no una
 * convencion nuestra. Escribirlos en cualquier otro archivo los dejaria fuera
 * del system prompt.
 */
const PROFILE_FILES: ReadonlyArray<{
  key: keyof QueryAgentProfile;
  file: string;
  preamble: string;
}> = [
  {
    key: "personality",
    file: "SOUL.md",
    preamble:
      "Asi habla este agente, segun lo definio su equipo desde el panel de " +
      "Query. Esto manda sobre cualquier indicacion de tono, estilo o " +
      "extension que aparezca antes en este archivo: si se contradicen, vale " +
      "lo de aqui abajo.",
  },
  {
    key: "mission",
    file: "IDENTITY.md",
    preamble:
      "Para esto existe este agente, segun lo definio su equipo desde el " +
      "panel de Query. Esto manda sobre cualquier rol o alcance descrito " +
      "antes en este archivo: si se contradicen, vale lo de aqui abajo.",
  },
];

export type QueryProfileLog = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Devuelve el archivo con la seccion de Query puesta al dia.
 *
 * Un cuerpo vacio no deja la seccion en blanco: la quita entera. Vaciar el
 * campo en el panel es la forma de devolverle al agente su comportamiento por
 * defecto, y una seccion vacia seguiria ocupando lugar en el system prompt.
 */
export function applyQuerySection(
  existing: string,
  body: string,
  preamble = "",
): string {
  const trimmed = body.trim();
  const head = preamble.trim();
  // La linea de precedencia solo viaja cuando hay texto que respaldar: sin
  // ella la seccion anunciaria que manda sobre el archivo para no decir nada,
  // y el modelo tendria que resolver una jerarquia vacia.
  const inner = head && trimmed ? `${head}\n\n${trimmed}` : trimmed;
  const section = inner
    ? `${QUERY_SECTION_BEGIN}\n${inner}\n${QUERY_SECTION_END}`
    : "";

  const begin = existing.indexOf(QUERY_SECTION_BEGIN);
  const end = existing.indexOf(QUERY_SECTION_END);
  const hasSection = begin !== -1 && end !== -1 && end > begin;

  const before = hasSection ? existing.slice(0, begin) : existing;
  const after = hasSection
    ? existing.slice(end + QUERY_SECTION_END.length)
    : "";

  // Cierre de la siembra: si el texto que llega es exactamente el que ya
  // estaba fuera de la seccion, es contenido que Query adopto del propio
  // archivo. Dejarlo en los dos sitios lo duplicaria dentro del system prompt,
  // y ademas la linea de precedencia diria que un texto manda sobre si mismo.
  const outside = [before, after].join("\n").trim();
  if (section && outside && outside === trimmed) {
    return `${section}\n`;
  }

  const pieces = [before.trimEnd(), section, after.trim()].filter(Boolean);
  return pieces.length ? `${pieces.join("\n\n")}\n` : "";
}

/**
 * Lo que el agente ya tenia escrito y Query podria adoptar.
 *
 * Solo devuelve archivos que Query nunca administro. Si ya hay una seccion
 * nuestra, que el panel este vacio significa que alguien lo vacio a proposito,
 * y volver a sembrar desde el archivo desharia esa decision en cada reconexion.
 */
export async function readSeedCandidates(
  workspaceDir: string,
): Promise<QueryAgentProfile> {
  const seed: QueryAgentProfile = {};

  for (const { key, file } of PROFILE_FILES) {
    let existing = "";
    try {
      existing = await readFile(join(workspaceDir, file), "utf8");
    } catch {
      continue;
    }
    if (existing.includes(QUERY_SECTION_BEGIN)) continue;
    const body = existing.trim();
    if (body) seed[key] = body;
  }

  return seed;
}

export type ProfileFileResult = {
  file: string;
  path: string;
  changed: boolean;
};

/**
 * Escribe personalidad y mision en el workspace indicado.
 *
 * Solo toca el disco cuando el contenido cambia: el agente reconecta a menudo y
 * reescribir los archivos identicos en cada `session.ready` cambiaria su fecha
 * sin motivo, ademas de disparar cualquier watcher que los observe.
 */
export async function writeAgentProfileFiles(params: {
  workspaceDir: string;
  profile: QueryAgentProfile;
}): Promise<ProfileFileResult[]> {
  const results: ProfileFileResult[] = [];

  for (const { key, file, preamble } of PROFILE_FILES) {
    const body = (params.profile[key] ?? "").trim();
    const path = join(params.workspaceDir, file);

    let existing = "";
    let exists = true;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      exists = false;
    }

    // Sin archivo y sin texto no hay nada que representar: crear un `SOUL.md`
    // vacio le sugeriria al agente que su personalidad quedo deliberadamente en
    // blanco, que no es lo mismo que no haberla definido nunca.
    if (!exists && !body) {
      results.push({ file, path, changed: false });
      continue;
    }

    const next = applyQuerySection(existing, body, preamble);
    if (next === existing) {
      results.push({ file, path, changed: false });
      continue;
    }

    await mkdir(params.workspaceDir, { recursive: true });
    await writeFile(path, next, "utf8");
    results.push({ file, path, changed: true });
  }

  return results;
}

/**
 * Lleva al workspace del agente el perfil que acaba de mandar Query.
 *
 * Un perfil ausente no es un perfil vacio: significa que del otro lado hay un
 * Query anterior a esta funcion, y ahi lo correcto es no tocar nada en vez de
 * borrarle al agente lo que tuviera escrito.
 */
export async function applyQueryAgentProfile(params: {
  cfg: QueryConfig;
  accountId: string;
  peerId: string;
  profile: QueryAgentProfile | undefined;
  log?: QueryProfileLog;
}): Promise<{ workspaceDir: string; results: ProfileFileResult[] }> {
  if (!params.profile) return { workspaceDir: "", results: [] };

  const core = getQueryRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: "group", id: params.peerId },
  });
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, route.agentId);

  const results = await writeAgentProfileFiles({
    workspaceDir,
    profile: params.profile,
  });

  // El workspace se registra siempre, cambie o no el perfil: es el unico dato
  // que revela si dos agentes de Query estan apuntando al mismo directorio. Si
  // dos cuentas distintas escriben aqui la misma ruta, comparten SOUL.md y la
  // ultima personalidad guardada pisa a la otra.
  const where = `agente=${route.agentId} workspace=${workspaceDir}`;
  const changed = results.filter((result) => result.changed);
  if (changed.length) {
    params.log?.info?.(
      `[${params.accountId}] perfil actualizado (${where}): ` +
        `${changed.map((result) => result.file).join(", ")}. ` +
        "OpenClaw lo tomara en la proxima sesion del agente.",
    );
  } else {
    params.log?.info?.(`[${params.accountId}] perfil sin cambios (${where}).`);
  }
  return { workspaceDir, results };
}
