import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  onAgentEvent,
  type AgentEventPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
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

function audioAttachments(event: QueryUserMessageEvent) {
  return (event.data?.attachments ?? []).filter(isAudioAttachment);
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
  return `audio-${index + 1}`;
}

function safeFilename(filename: string): string {
  const extension = extname(filename).slice(0, 16);
  const stem = basename(filename, extension)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "audio"}${extension || ".bin"}`;
}

function stableInboundAudioPath(params: {
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

async function bytesForAttachmentUrl(url: string): Promise<Buffer> {
  if (isDataUrl(url)) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url);
    if (!match) throw new Error("Invalid data URL");
    const payload = decodeURIComponent(match[3] ?? "");
    return match[2] ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8");
  }
  if (isLocalPath(url)) {
    return readFile(url);
  }
  if (isHttpUrl(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error(`Unsupported media URL: ${url.slice(0, 80)}`);
}

export async function materializeInboundAudioAttachments(
  event: QueryUserMessageEvent,
  options: { mediaDir?: string; log?: QueryLog } = {},
): Promise<QueryUserMessageEvent> {
  const attachments = event.data?.attachments ?? [];
  if (attachments.length === 0 || !attachments.some(isAudioAttachment)) return event;

  const mediaDir = options.mediaDir ?? DEFAULT_INBOUND_MEDIA_DIR;
  await mkdir(mediaDir, { recursive: true });
  const enrichedAttachments = await Promise.all(
    attachments.map(async (attachment, index) => {
      if (!isAudioAttachment(attachment)) return attachment;
      if (attachment.local_path) return attachment;

      const localPath = stableInboundAudioPath({ event, attachment, index, mediaDir });
      try {
        try {
          const existing = await stat(localPath);
          if (existing.isFile() && existing.size > 0) {
            options.log?.debug?.(
              `query_inbound_audio_materialized_existing msg=${event.client_msg_id} path=${localPath} bytes=${existing.size}`,
            );
            return { ...attachment, local_path: localPath, size: attachment.size ?? existing.size };
          }
        } catch {
          // File does not exist yet.
        }

        const bytes = await bytesForAttachmentUrl(attachment.url);
        await writeFile(localPath, bytes, { flag: "wx" }).catch(async (error: unknown) => {
          if ((error as { code?: string }).code !== "EEXIST") throw error;
        });
        options.log?.info?.(
          `query_inbound_audio_materialized msg=${event.client_msg_id} attachment=${attachment.id ?? index} path=${localPath} bytes=${bytes.length}`,
        );
        return { ...attachment, local_path: localPath, size: attachment.size ?? bytes.length };
      } catch (error) {
        options.log?.warn?.(
          `query_inbound_audio_materialize_failed msg=${event.client_msg_id} attachment=${attachment.id ?? index} url=${attachment.url} error=${String(error)}`,
        );
        return attachment;
      }
    }),
  );

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
  const context = [
    `Canal Query: ${event.data?.thread_name || event.thread_id || "desconocido"}`,
    `Tipo: ${event.data?.thread_type || "desconocido"}`,
    event.data?.sender?.private_thread_id
      ? `Canal privado del remitente: ${event.data.sender.private_thread_id}`
      : "",
    ...audioLines,
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
  const event = await materializeInboundAudioAttachments(params.event, { log: params.log });
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
  const agentBody = bodyForAgent(event);
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
      path: isAudioAttachment(attachment) ? attachment.local_path : undefined,
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
