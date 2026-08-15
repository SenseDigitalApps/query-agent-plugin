import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  onAgentEvent,
  type AgentEventPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  QueryAgentActivity,
  QueryConfig,
  QueryUserMessageEvent,
  ResolvedQueryAccount,
} from "./types.js";
import { CHANNEL_ID } from "./types.js";
import { getQueryRuntime } from "./runtime.js";

export type QueryAgentResult = {
  text: string;
  mediaUrls: string[];
};

function boundedText(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function activityFromAgentEvent(event: AgentEventPayload): QueryAgentActivity | undefined {
  const phase = boundedText(event.data.phase ?? event.data.state, 32)?.toLowerCase();
  const toolName = boundedText(
    event.data.toolName ?? event.data.tool_name ?? event.data.name ?? event.data.tool,
    64,
  );
  const rawProgress = Number(event.data.progress);
  const progress = Number.isFinite(rawProgress)
    ? Math.max(0, Math.min(100, rawProgress))
    : undefined;

  if (event.stream === "lifecycle") {
    if (phase === "start") {
      return { label: "Analizando la solicitud", stage: "agent", progress: 5 };
    }
    if (phase === "finishing") {
      return { label: "Preparando la respuesta", stage: "response", progress: 90 };
    }
    if (phase === "fallback_step") {
      return { label: "Buscando una alternativa", stage: "agent" };
    }
    return undefined;
  }
  if (event.stream === "tool") {
    const finished = phase === "end" || phase === "done" || phase === "complete";
    return {
      label: toolName
        ? finished
          ? `${toolName} completado`
          : `Usando ${toolName}`
        : finished
          ? "Consulta completada"
          : "Consultando herramientas",
      stage: "tool",
      toolName,
      progress,
    };
  }
  if (event.stream === "compaction") {
    return { label: "Organizando el contexto", stage: "context" };
  }
  if (event.stream === "assistant") {
    return { label: "Redactando la respuesta", stage: "response", progress: 85 };
  }
  if (event.stream === "thinking" || event.stream === "plan") {
    return { label: "Analizando la información", stage: "thinking" };
  }
  return undefined;
}

type QueryLog = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const DEFAULT_INBOUND_MEDIA_DIR =
  process.env.QUERY_INBOUND_MEDIA_DIR ?? join(homedir(), ".openclaw", "media", "inbound");

function positiveNumberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Un archivo de 200 MB por un enlace lento tarda minutos y es legitimo; lo que
// no puede es quedarse colgado para siempre, que es lo que pasaba sin timeout.
const INBOUND_DOWNLOAD_TIMEOUT_MS = positiveNumberFromEnv(
  "QUERY_INBOUND_DOWNLOAD_TIMEOUT_MS",
  15 * 60 * 1000,
);
const INBOUND_MEDIA_TTL_MS =
  positiveNumberFromEnv("QUERY_INBOUND_MEDIA_TTL_HOURS", 72) * 60 * 60 * 1000;

function mediaKind(kind: string | undefined) {
  if (kind === "image" || kind === "audio" || kind === "video") return kind;
  if (kind === "file") return "document" as const;
  return "unknown" as const;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function isAudioAttachment(attachment: { kind?: string; mime_type?: string }): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() ?? "";
  return attachment.kind === "audio" || mimeType.startsWith("audio/");
}

function isImageAttachment(attachment: { kind?: string; mime_type?: string }): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() ?? "";
  return attachment.kind === "image" || mimeType.startsWith("image/");
}

/**
 * Adjuntos que hay que bajar a disco antes de pasarlos al agente.
 *
 * OpenClaw descarta cualquier adjunto que no traiga una ruta local: en
 * `resolveAgentTurnAttachments` hace `if (!attachment.path) return false`, y en
 * el historial ademas rechaza las rutas remotas. Una URL, por publica que sea,
 * nunca llega al modelo.
 *
 * Vale para todo, no solo para medios. Un xlsx o un pdf enviados desde Query se
 * caian por este mismo `if`, y como ademas no se mencionaban en el cuerpo el
 * agente ni se enteraba de que existian: contestaba como si el mensaje hubiera
 * llegado sin nada.
 */
function needsLocalMaterialization(_attachment: {
  kind?: string;
  mime_type?: string;
}): boolean {
  return true;
}

function audioAttachments(event: QueryUserMessageEvent) {
  return (event.data?.attachments ?? []).filter(isAudioAttachment);
}

/** Todo lo que no es audio ni imagen: hojas de calculo, pdf, csv, texto. */
function documentAttachments(event: QueryUserMessageEvent) {
  return (event.data?.attachments ?? []).filter(
    (attachment) => !isAudioAttachment(attachment) && !isImageAttachment(attachment),
  );
}

// A partir de aca la forma de leer el archivo deja de ser indiferente.
const LARGE_ATTACHMENT_HINT_BYTES = positiveNumberFromEnv(
  "QUERY_LARGE_ATTACHMENT_HINT_BYTES",
  25 * 1024 * 1024,
);

function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function attachmentTranscript(attachment: {
  transcript?: string;
  transcription?: string;
  text?: string;
}): string {
  return (
    attachment.transcript?.trim() ||
    attachment.transcription?.trim() ||
    attachment.text?.trim() ||
    ""
  );
}

function attachmentDuration(attachment: {
  duration?: number;
  duration_seconds?: number;
  duration_ms?: number;
}): string {
  const seconds =
    attachment.duration_seconds ??
    attachment.duration ??
    (attachment.duration_ms === undefined ? undefined : attachment.duration_ms / 1000);
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? `${Number(seconds.toFixed(2))}s`
    : "";
}

function originalFilename(attachment: { name?: string; url: string }, index: number): string {
  const cleanName = attachment.name?.trim();
  if (cleanName) return cleanName;
  try {
    const parsed = new URL(attachment.url);
    const fromUrl = basename(parsed.pathname);
    if (fromUrl) return fromUrl;
  } catch {
    const cleanPath = attachment.url.split(/[?#]/, 1)[0]?.replace(/\\/g, "/") ?? "";
    const fromPath = cleanPath.split("/").pop();
    if (fromPath) return fromPath;
  }
  // Neutro a proposito: esta funcion ya no sirve solo para notas de voz, y un
  // xlsx llamado "audio-1" es peor que uno sin nombre.
  return `adjunto-${index + 1}`;
}

function safeFilename(filename: string): string {
  const extension = extname(filename).slice(0, 16);
  const stem = basename(filename, extension)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "adjunto"}${extension || ".bin"}`;
}

function stableInboundMediaPath(params: {
  event: QueryUserMessageEvent;
  attachment: { id?: string | number; name?: string; url: string };
  index: number;
  mediaDir: string;
}): string {
  const filename = safeFilename(originalFilename(params.attachment, params.index));
  const sourceKey = [
    params.event.client_msg_id,
    params.attachment.id === undefined ? "" : String(params.attachment.id),
    params.attachment.url,
    params.index,
  ].join("|");
  const digest = createHash("sha256").update(sourceKey).digest("hex").slice(0, 12);
  return join(params.mediaDir, `${params.event.client_msg_id}-${digest}-${filename}`);
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLocalPath(value: string): boolean {
  if (!isAbsolute(value)) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value);
}

function bufferForDataUrl(url: string): Buffer {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url);
  if (!match) throw new Error("Invalid data URL");
  const payload = decodeURIComponent(match[3] ?? "");
  return match[2] ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
}

/**
 * Baja el adjunto a disco sin pasarlo entero por memoria.
 *
 * Antes esto era un `arrayBuffer()`: un xlsx de 150 MB se convertia en un
 * Buffer de 150 MB antes de tocar el disco, y con varios adjuntos a la vez el
 * proceso del agente se iba al suelo. Con `pipeline` el pico es el del chunk.
 *
 * Se escribe en un temporal y se renombra al final: una descarga cortada a la
 * mitad dejaba un archivo truncado que el chequeo de existencia daba por bueno
 * en el turno siguiente, y el agente leia datos incompletos sin saberlo.
 */
async function downloadAttachmentToFile(
  url: string,
  destination: string,
): Promise<number> {
  const temporary = `${destination}.${randomUUID().slice(0, 8)}.part`;
  try {
    if (isDataUrl(url)) {
      await writeFile(temporary, bufferForDataUrl(url));
    } else if (isLocalPath(url)) {
      await copyFile(url, temporary);
    } else if (isHttpUrl(url)) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error("Respuesta sin cuerpo");
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(temporary),
      );
    } else {
      throw new Error(`Unsupported media URL: ${url.slice(0, 80)}`);
    }
    await rename(temporary, destination);
    const written = await stat(destination);
    return written.size;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Borra lo materializado hace mas de `QUERY_INBOUND_MEDIA_TTL_HOURS`.
 *
 * Nadie limpiaba este directorio: con adjuntos de pocos MB tardaba anios en
 * notarse, pero con archivos de 200 MB llena el disco del agente en semanas.
 */
async function cleanupInboundMedia(mediaDir: string, log?: QueryLog): Promise<void> {
  const cutoff = Date.now() - INBOUND_MEDIA_TTL_MS;
  const entries = await readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(mediaDir, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      await unlink(path);
      log?.debug?.(`query_inbound_media_pruned path=${path} bytes=${info.size}`);
    } catch {
      // Otro turno pudo borrarlo primero: no es un error que valga reportar.
    }
  }
}

export async function materializeInboundMediaAttachments(
  event: QueryUserMessageEvent,
  options: { mediaDir?: string; log?: QueryLog } = {},
): Promise<QueryUserMessageEvent> {
  const attachments = event.data?.attachments ?? [];
  if (attachments.length === 0 || !attachments.some(needsLocalMaterialization)) return event;

  const mediaDir = options.mediaDir ?? DEFAULT_INBOUND_MEDIA_DIR;
  await mkdir(mediaDir, { recursive: true });
  await cleanupInboundMedia(mediaDir, options.log);

  // En serie y no con `Promise.all`: tres adjuntos grandes en paralelo son tres
  // descargas compitiendo por el mismo ancho de banda y disco, y ninguna de las
  // tres termina antes por eso.
  const enrichedAttachments: typeof attachments = [];
  for (const [index, attachment] of attachments.entries()) {
    if (!needsLocalMaterialization(attachment) || attachment.local_path) {
      enrichedAttachments.push(attachment);
      continue;
    }

    const localPath = stableInboundMediaPath({ event, attachment, index, mediaDir });
    try {
      const existing = await stat(localPath).catch(() => null);
      if (existing?.isFile() && existing.size > 0) {
        options.log?.debug?.(
          `query_inbound_media_materialized_existing msg=${event.client_msg_id} path=${localPath} bytes=${existing.size}`,
        );
        enrichedAttachments.push({
          ...attachment,
          local_path: localPath,
          size: attachment.size ?? existing.size,
        });
        continue;
      }

      const bytes = await downloadAttachmentToFile(attachment.url, localPath);
      options.log?.info?.(
        `query_inbound_media_materialized msg=${event.client_msg_id} attachment=${attachment.id ?? index} path=${localPath} bytes=${bytes}`,
      );
      enrichedAttachments.push({
        ...attachment,
        local_path: localPath,
        size: attachment.size ?? bytes,
      });
    } catch (error) {
      options.log?.warn?.(
        `query_inbound_media_materialize_failed msg=${event.client_msg_id} attachment=${attachment.id ?? index} url=${attachment.url} error=${String(error)}`,
      );
      enrichedAttachments.push(attachment);
    }
  }

  return {
    ...event,
    data: {
      ...event.data,
      attachments: enrichedAttachments,
    },
  };
}

function messageRequestsAudio(event: QueryUserMessageEvent): boolean {
  const content = event.content.toLowerCase();
  const asksForAudio =
    /\b(audio|voz|nota de voz|voice note|voice|habl[aá]me|responde(?:me)? en voz|m[aá]ndame .*voz)\b/i.test(
      content,
    );
  return asksForAudio || audioAttachments(event).length > 0;
}

export function rawBodyForAgent(event: QueryUserMessageEvent): string {
  if (event.content.trim()) return event.content.trim();
  if (audioAttachments(event).length > 0) return "[Nota de voz adjunta]";
  return "[Adjunto]";
}

/**
 * Que paso con la propuesta cuando la persona la cerro escribiendo.
 *
 * Sin esta linea el agente sigue creyendo que su propuesta espera aprobacion y
 * responde pidiendo que pulsen un boton que ya no esta.
 */
function resolvedActionLine(event: QueryUserMessageEvent): string {
  const resolved = event.data?.resolved_action;
  if (!resolved) return "";
  const target = resolved.module_label ? ` en ${resolved.module_label}` : "";
  if (resolved.status === "applied") {
    if (resolved.decision === "cancel") {
      return `Query descarto tu propuesta${target} porque la persona lo pidio en este mensaje. No la vuelvas a proponer salvo que te lo pidan`;
    }
    const record = resolved.record_id ? ` (registro ${resolved.record_id})` : "";
    return `Query ya aplico tu propuesta${target}${record}: la persona la confirmo en este mensaje. Da el cambio por hecho y no vuelvas a proponerlo`;
  }
  if (resolved.status === "ambiguous") {
    const count = resolved.pending?.length ?? 0;
    return `La persona quiso ${resolved.decision === "cancel" ? "descartar" : "confirmar"} una propuesta, pero hay ${count} esperando y no se sabe cual. Preguntale cual antes de nada; siguen pendientes`;
  }
  if (resolved.status === "not_allowed") {
    return `La persona quiso confirmar la propuesta${target} pero no tiene permiso para aplicarla. Dile que la apruebe alguien con ese permiso; sigue pendiente`;
  }
  return `Query intento cerrar tu propuesta${target} con este mensaje y no pudo (${resolved.error ?? "error"}). No des el cambio por hecho: cuentaselo a la persona`;
}

export function bodyForAgent(event: QueryUserMessageEvent): string {
  const rawBody = rawBodyForAgent(event);
  const audioLines = audioAttachments(event).flatMap((attachment, index) => {
    const transcript = attachmentTranscript(attachment);
    const filename = originalFilename(attachment, index);
    const duration = attachmentDuration(attachment);
    const fields = [
      `AudioAttachment ${index + 1}:`,
      `Filename: ${filename}`,
      `MediaType: ${attachment.mime_type || "audio/unknown"}`,
      attachment.local_path ? `LocalMediaPath: ${attachment.local_path}` : "",
      `MediaPath: ${attachment.url}`,
      isHttpUrl(attachment.url) ? `MediaUrl: ${attachment.url}` : "",
      duration ? `Duration: ${duration}` : "",
      transcript ? `Transcript: [system-generated] ${transcript}` : "",
      "Instruction: usa este audio como entrada directa del usuario. Si LocalMediaPath existe, úsalo primero; si no, usa MediaUrl/MediaPath como fallback. No busques transcripts internos ni JSONL de sesión para entender este audio.",
    ].filter(Boolean);
    if (transcript) return [fields.join("\n")];
    return [
      [
        ...fields,
        "Transcript: no disponible; debes acceder al archivo local o a la URL remota para interpretar la nota de voz.",
      ].join("\n"),
    ];
  });
  const documentLines = documentAttachments(event).map((attachment, index) => {
    const filename = originalFilename(attachment, index);
    const size = typeof attachment.size === "number" ? attachment.size : 0;
    return [
      `DocumentAttachment ${index + 1}:`,
      `Filename: ${filename}`,
      `MediaType: ${attachment.mime_type || "application/octet-stream"}`,
      size > 0 ? `Size: ${formatAttachmentSize(size)}` : "",
      attachment.local_path ? `LocalPath: ${attachment.local_path}` : "",
      isHttpUrl(attachment.url) ? `MediaUrl: ${attachment.url}` : "",
      // Sin esto el agente ve la ruta y responde describiendo el archivo por su
      // nombre, sin abrirlo. Un xlsx es un zip de XML: hay que leerlo con
      // codigo, no de corrido.
      "Instruction: la persona te adjunto este archivo en este mensaje. Abrelo " +
        "desde LocalPath para responder; si es xlsx u otro formato binario, " +
        "leelo con codigo (openpyxl, pandas o equivalente) en vez de suponer su " +
        "contenido. Si no puedes abrirlo, dilo claramente en vez de responder " +
        "como si no hubiera llegado nada.",
      // El tamaño manda sobre la tecnica: `pandas.read_excel` sobre un archivo
      // de cientos de MB se lleva puesto el proceso, y el agente no tiene como
      // saberlo si solo ve una ruta.
      size > LARGE_ATTACHMENT_HINT_BYTES
        ? "Instruction: este archivo es grande. No lo cargues entero en memoria " +
          "ni lo vuelques al contexto: leelo en streaming o por consultas " +
          "(openpyxl en read_only, DuckDB, polars o equivalente), trabaja sobre " +
          "agregados y muestras, y si tienes que entregar un resultado visual " +
          "genera un archivo y subelo en vez de imprimir filas."
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const context = [
    `Canal Query: ${event.data?.thread_name || event.thread_id || "desconocido"}`,
    `Tipo: ${event.data?.thread_type || "desconocido"}`,
    event.data?.sender?.private_thread_id
      ? `Canal privado del remitente: ${event.data.sender.private_thread_id}`
      : "",
    resolvedActionLine(event),
    ...audioLines,
    ...documentLines,
    "Si creas una tarea programada para una persona, configura la entrega al canal privado indicado; no uses un canal compartido como destino individual.",
  ]
    .filter(Boolean)
    .join(". ");
  const audioHint = messageRequestsAudio(event)
    ? "\n\n[Query puede convertir tu respuesta final a una nota de voz reproducible. Responde normalmente con el contenido; no digas que no tienes herramienta de audio.]"
    : "";
  return `${rawBody}\n\n[Contexto de Query: ${context}]${audioHint}`;
}

export async function dispatchQueryMessage(params: {
  cfg: QueryConfig;
  account: ResolvedQueryAccount;
  event: QueryUserMessageEvent;
  threadId: string;
  onProgress?: (detail: string) => void;
  onActivity?: (activity: QueryAgentActivity) => void;
  log?: QueryLog;
}): Promise<QueryAgentResult> {
  const core = getQueryRuntime();
  const { cfg, account, threadId } = params;
  const event = await materializeInboundMediaAttachments(params.event, { log: params.log });
  const peerId = threadId || account.accountId;
  const threadType = event.data?.thread_type;
  const sender = event.data?.sender;
  const senderId =
    sender?.id === undefined || sender?.id === null
      ? "query-user"
      : String(sender.id);
  const senderName = sender?.name?.trim() || "Query user";
  const conversationKind = threadType === "private" ? "direct" : "group";
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: conversationKind, id: peerId },
  });
  const rawBody = rawBodyForAgent(event);
  const body = bodyForAgent(event);
  // Query solo entrega un segundo turno mientras hay uno activo cuando la
  // persona pulsa "Intervenir ahora". La directiva hace explicita esa decision
  // aun si la configuracion global de OpenClaw usa otro modo de cola. Los
  // mensajes normales no llevan directiva: Query ya los serializo y OpenClaw
  // debe tratarlos como el turno base, sin recordar ``steer`` en la sesion.
  const agentBody =
    event.data?.delivery_mode === "intervene" ? `/queue steer\n${body}` : body;
  const attachments = event.data?.attachments ?? [];
  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: event.client_msg_id,
    timestamp: Date.now(),
    from: `query:${peerId}`,
    sender: { id: senderId, name: senderName },
    conversation: {
      kind: conversationKind,
      id: peerId,
      label: event.data?.thread_name?.trim() || "Query",
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: peerId,
      originatingTo: peerId,
    },
    message: {
      body: rawBody,
      bodyForAgent: agentBody,
      rawBody,
      commandBody: agentBody,
    },
    media: attachments.map((attachment) => ({
      // Vale para audio y para imagen: OpenClaw solo mira `path`. Sin ruta
      // local, `resolveAgentTurnAttachments` descarta la imagen en silencio y
      // el turno llega con `imagesCount: 0`.
      path: attachment.local_path,
      url: attachment.url,
      contentType: attachment.mime_type,
      kind: mediaKind(attachment.kind),
      transcribed: isAudioAttachment(attachment) ? Boolean(attachmentTranscript(attachment)) : undefined,
      messageId: attachment.id === undefined ? undefined : String(attachment.id),
    })),
    access: {
      commands: { authorized: true },
      mentions: { canDetectMention: false, wasMentioned: true },
    },
  });

  const texts: string[] = [];
  const mediaUrls: string[] = [];
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  let runId: string | undefined;
  const unsubscribe = onAgentEvent((agentEvent) => {
    if (agentEvent.sessionKey !== route.sessionKey) return;
    if (agentEvent.agentId && agentEvent.agentId !== route.agentId) return;
    const phase = boundedText(agentEvent.data.phase, 32)?.toLowerCase();
    if (!runId) {
      if (agentEvent.stream !== "lifecycle" || phase !== "start") return;
      runId = agentEvent.runId;
    }
    if (agentEvent.runId !== runId) return;
    const activity = activityFromAgentEvent(agentEvent);
    if (activity) params.onActivity?.({ ...activity, runId });
  });

  try {
    await core.channel.inbound.dispatchReply({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: core.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: async (payload) => {
          if (payload.text?.trim()) {
            texts.push(payload.text.trim());
            params.onProgress?.("El agente generó parte de la respuesta");
            params.onActivity?.({
              label: "Preparando la respuesta",
              stage: "response",
              progress: 90,
              runId,
            });
          }
          mediaUrls.push(...(payload.mediaUrls ?? []));
          if (payload.mediaUrl) mediaUrls.push(payload.mediaUrl);
        },
        onError: (error, info) => {
          params.onProgress?.(`Error de entrega ${info.kind}: ${String(error)}`);
        },
      },
      replyPipeline: {},
      record: {
        onRecordError: (error) => {
          params.onProgress?.(`No se pudo registrar la sesión: ${String(error)}`);
        },
      },
      messageId: event.client_msg_id,
    });
  } finally {
    unsubscribe();
  }

  return {
    text: texts.join("\n\n").trim(),
    mediaUrls: uniqueNonEmpty(mediaUrls),
  };
}
