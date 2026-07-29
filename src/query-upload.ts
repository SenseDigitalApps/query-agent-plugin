import { openAsBlob, promises as fs } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { QueryAttachment } from "./types.js";

/**
 * Subida de artifacts del agente a Query.
 *
 * El agente corre en otra maquina que quien lee el chat. La ruta donde acaba de
 * escribir un dashboard no significa nada para ese navegador: si viaja como
 * `url`, se resuelve contra el dominio de Query y produce un enlace inventado
 * que responde 404. El archivo tiene que entregarse, no referenciarse.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class QueryUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QueryUploadError";
  }

  /** El agente puede recuperarse renovando su credencial y reintentando. */
  get isExpiredCredential(): boolean {
    return this.code === "token_expired" || this.code === "token_invalid";
  }
}

/**
 * Cualquier ruta absoluta del disco del agente, no solo la carpeta de medios.
 * Un artifact generado en el workspace es igual de inalcanzable para Query.
 */
export function isLocalArtifactPath(candidate: string): boolean {
  const value = candidate?.trim();
  if (!value) return false;
  // Windows ("C:\...") es absoluto y a la vez parece llevar esquema: se
  // comprueba antes de descartar por protocolo.
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return isAbsolute(value);
}

/**
 * Endpoint de ingesta derivado de la conexion que el plugin ya tiene
 * configurada, para no pedirle al usuario una segunda URL que mantener.
 */
export function queryUploadUrlFor(socketUrl: string, threadId: string | number): string {
  const parsed = new URL(socketUrl);
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/api/v4/openclaw-agent/threads/${threadId}/attachments/`;
  return parsed.toString();
}

async function readArtifact(path: string): Promise<{ blob: Blob; size: number }> {
  const stats = await fs.stat(path);
  if (!stats.isFile()) {
    throw new QueryUploadError("not_a_file", `Query artifact is not a file: ${path}`);
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new QueryUploadError(
      "file_too_large",
      `Query artifact exceeds ${MAX_UPLOAD_BYTES} bytes: ${path}`,
    );
  }
  return { blob: await openAsBlob(path), size: stats.size };
}

/**
 * Endpoint de ingesta para envios que no nacen de un turno (notificaciones,
 * cron): no hay persona delegante, asi que se autentica con la credencial de
 * emparejamiento del propio agente.
 */
export function queryOutboundUploadUrlFor(socketUrl: string, botId: string | number): string {
  const parsed = new URL(socketUrl);
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/api/v4/openclaw-agent/bots/${botId}/attachments/`;
  return parsed.toString();
}

/** El bot id viaja en la propia ruta del WebSocket de emparejamiento. */
export function botIdFromSocketUrl(socketUrl: string): string {
  const match = new URL(socketUrl).pathname.match(/openclaw-agent\/(\d+)/);
  return match?.[1] ?? "";
}

export async function uploadOutboundArtifactToQuery(params: {
  uploadUrl: string;
  token: string;
  to: string;
  path: string;
  attachment: QueryAttachment;
  fetchImpl?: typeof fetch;
}): Promise<QueryAttachment> {
  return uploadArtifactToQuery({
    uploadUrl: params.uploadUrl,
    token: params.token,
    path: params.path,
    attachment: params.attachment,
    fetchImpl: params.fetchImpl,
    tokenHeader: "X-Agent-Token",
    extraFields: { to: params.to },
  });
}

export async function uploadArtifactToQuery(params: {
  uploadUrl: string;
  token: string;
  path: string;
  attachment: QueryAttachment;
  fetchImpl?: typeof fetch;
  /** Delegada por defecto; el envio outbound usa la credencial del agente. */
  tokenHeader?: string;
  extraFields?: Record<string, string>;
}): Promise<QueryAttachment> {
  const { uploadUrl, token, path, attachment } = params;
  if (!token) {
    throw new QueryUploadError("token_missing", "Query did not provide a token.");
  }
  const { blob, size } = await readArtifact(path);
  const name = attachment.name || basename(path) || "artifact";
  const form = new FormData();
  form.append("file", blob, name);
  form.append("kind", attachment.kind ?? "file");
  if (attachment.mime_type) form.append("mime_type", attachment.mime_type);
  for (const [field, value] of Object.entries(params.extraFields ?? {})) {
    form.append(field, value);
  }

  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(uploadUrl, {
    method: "POST",
    headers: { [params.tokenHeader ?? "X-Query-Delegated-Token"]: token },
    body: form,
  });
  if (!response.ok) {
    let code = `http_${response.status}`;
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      if (body?.error) code = body.error;
      detail = body?.detail ?? "";
    } catch {
      // Un error sin cuerpo JSON sigue siendo un error: basta con el estado.
    }
    throw new QueryUploadError(
      code,
      detail || `Query rejected the upload (${response.status}).`,
      response.status,
    );
  }
  const uploaded = (await response.json()) as {
    id?: number;
    kind?: string;
    name?: string;
    mime_type?: string;
    size?: number;
    url?: string;
  };
  if (!uploaded?.url) {
    throw new QueryUploadError("missing_url", "Query accepted the file but returned no url.");
  }
  return {
    ...attachment,
    id: uploaded.id ?? attachment.id,
    kind: (uploaded.kind as QueryAttachment["kind"]) ?? attachment.kind,
    name: uploaded.name || name,
    mime_type: uploaded.mime_type || attachment.mime_type,
    size: uploaded.size ?? size,
    url: uploaded.url,
  };
}
