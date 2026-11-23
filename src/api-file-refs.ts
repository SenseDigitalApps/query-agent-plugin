import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Adjuntos por referencia en query_api_request (Juli Telegram18192, 2026-11-22).
// Un objeto {"$file_base64": "<ruta>"} dentro de request.body se reemplaza por el
// base64 del archivo justo antes de enviar. Asi el PDF no viaja en los argumentos
// de la herramienta y no queda copiado en el historial de la conversacion.
// Solo se leen archivos dentro del workspace del agente.

export const FILE_REF_KEY = "$file_base64";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export type FileRefError = { ok: false; error: string; detail: string };

function isFileRef(value: unknown): value is { [FILE_REF_KEY]: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === 1
    && typeof (value as Record<string, unknown>)[FILE_REF_KEY] === "string";
}

function hasFileRef(value: unknown): boolean {
  if (isFileRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasFileRef);
  if (value && typeof value === "object") return Object.values(value).some(hasFileRef);
  return false;
}

export async function expandFileRefs(body: unknown, workspaceDir: string | undefined): Promise<{ ok: true; body: unknown } | FileRefError> {
  if (!hasFileRef(body)) return { ok: true, body };
  if (!workspaceDir) return { ok: false, error: "file_ref_workspace_unknown", detail: "No se pudo resolver el workspace del agente para leer el archivo." };
  const root = await realpath(workspaceDir);
  let total = 0;
  const walk = async (value: unknown): Promise<unknown> => {
    if (isFileRef(value)) {
      const requested = value[FILE_REF_KEY].trim();
      let resolved: string;
      try { resolved = await realpath(path.resolve(root, requested)); }
      catch { throw { ok: false, error: "file_ref_not_found", detail: `No existe el archivo ${path.basename(requested)}.` }; }
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        throw { ok: false, error: "file_ref_outside_workspace", detail: "El archivo debe estar dentro del workspace del agente." };
      const info = await stat(resolved);
      if (!info.isFile()) throw { ok: false, error: "file_ref_not_file", detail: "La referencia debe apuntar a un archivo." };
      if (info.size > MAX_FILE_BYTES) throw { ok: false, error: "file_ref_too_large", detail: "El archivo supera 15 MB." };
      total += info.size;
      if (total > MAX_TOTAL_BYTES) throw { ok: false, error: "file_ref_total_too_large", detail: "Los archivos referenciados superan 40 MB en total." };
      return (await readFile(resolved)).toString("base64");
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
      return out;
    }
    return value;
  };
  try { return { ok: true, body: await walk(body) }; }
  catch (e) { if (e && typeof e === "object" && "error" in e) return e as FileRefError; throw e; }
}
