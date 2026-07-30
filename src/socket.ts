import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { dispatchQueryMessage } from "./inbound.js";
import {
  activityEvent,
  buildSocketUrl,
  cachedResponseEvent,
  parseQueryEvent,
  reconnectDelay,
} from "./protocol.js";
import { queryAttachmentForMediaSource, queryAttachmentForMediaUrl } from "./media.js";
import {
  isLocalArtifactPath,
  QueryUploadError,
  queryUploadUrlFor,
  uploadArtifactToQuery,
} from "./query-upload.js";
import {
  delegatedAuthStoreDiagnostics,
  peekDelegatedAuth,
  rememberDelegatedAuth,
} from "./delegated-store.js";
import { defaultResponseStorePath, ResponseStore } from "./response-store.js";
import type {
  CachedResponse,
  QueryConfig,
  QueryAttachment,
  QueryDelegatedAuth,
  QueryOutboundEvent,
  QueryUserMessageEvent,
  ResolvedQueryAccount,
} from "./types.js";

const require = createRequire(import.meta.url);
// Renovar la credencial es un ida y vuelta por el socket ya abierto: si Query
// no contesta en este plazo, se prefiere perder el adjunto a colgar el turno.
const QUERY_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const QUERY_REPLY_AUDIO = process.env.QUERY_REPLY_AUDIO ?? "1";
const QUERY_REPLY_AUDIO_MODE = process.env.QUERY_REPLY_AUDIO_MODE ?? "requested";
const QUERY_TTS_BIN = process.env.QUERY_TTS_BIN;
const QUERY_TTS_VOICE = process.env.QUERY_TTS_VOICE ?? "es-CO-GonzaloNeural";
const QUERY_TTS_LANG = process.env.QUERY_TTS_LANG ?? "es-CO";
const QUERY_TTS_RATE = process.env.QUERY_TTS_RATE ?? "+15%";
const QUERY_ACTIVITY_HEARTBEAT_MS = Math.max(
  5_000,
  Number(process.env.QUERY_ACTIVITY_HEARTBEAT_MS) || 20_000,
);

export type QuerySocketOptions = {
  cfg: QueryConfig;
  account: ResolvedQueryAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (status: ChannelAccountSnapshot) => void;
  dispatchMessage?: typeof dispatchQueryMessage;
};

function toText(data: RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`El agente no terminó dentro de ${timeoutMs}ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function eventRequestsAudio(event: QueryUserMessageEvent): boolean {
  if (QUERY_REPLY_AUDIO !== "1") return false;
  const mode = QUERY_REPLY_AUDIO_MODE.toLowerCase();
  if (mode === "always") return true;
  if (mode === "never" || mode === "0" || mode === "false") return false;
  const content = event.content.toLowerCase();
  const asksForAudio =
    /\b(audio|voz|nota de voz|voice note|voice|habl[aá]me|responde(?:me)? en voz|m[aá]ndame .*voz)\b/i.test(
      content,
    );
  const hasInboundAudio = (event.data?.attachments ?? []).some((attachment) => {
    const mimeType = attachment.mime_type?.toLowerCase() ?? "";
    return attachment.kind === "audio" || mimeType.startsWith("audio/");
  });
  return asksForAudio || hasInboundAudio;
}

function isAudioAttachment(attachment: QueryAttachment): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() ?? "";
  return attachment.kind === "audio" || mimeType.startsWith("audio/");
}

function oneVoiceNote(attachments: QueryAttachment[]): QueryAttachment[] {
  let keptAudio = false;
  return attachments.filter((attachment) => {
    if (!isAudioAttachment(attachment)) return true;
    if (keptAudio) return false;
    keptAudio = true;
    return true;
  });
}

async function buildAssistantAudioAttachment(
  event: QueryUserMessageEvent,
  text: string,
): Promise<QueryAttachment | undefined> {
  if (!eventRequestsAudio(event)) return undefined;
  const speechText = textForSpeech(text);
  if (!speechText) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "query-tts-"));
  const outputPath = join(directory, "reply.mp3");
  try {
    await runTextToSpeech(speechText, outputPath);
    const bytes = await readFile(outputPath);
    return {
      id: `assistant-audio-${Date.now()}`,
      kind: "audio",
      name: "respuesta-openclaw.mp3",
      mime_type: "audio/mpeg",
      is_voice_note: true,
      voice: true,
      size: bytes.length,
      url: `data:audio/mpeg;base64,${bytes.toString("base64")}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function textForSpeech(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, " enlace ")
    .trim()
    .slice(0, 1400);
}

function runTextToSpeech(text: string, outputPath: string): Promise<void> {
  const ttsBin = QUERY_TTS_BIN ?? require.resolve("node-edge-tts/bin.js");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        ttsBin,
        "--text",
        text,
        "--filepath",
        outputPath,
        "--voice",
        QUERY_TTS_VOICE,
        "--lang",
        QUERY_TTS_LANG,
        "--rate",
        QUERY_TTS_RATE,
        "--outputFormat",
        "audio-24khz-48kbitrate-mono-mp3",
        "--timeout",
        "30000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Query assistant audio synthesis timed out."));
    }, 45_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `node-edge-tts exited with ${code}`));
        return;
      }
      resolve();
    });
  });
}

export class QuerySocketMonitor {
  private readonly store: ResponseStore;
  private socket?: WebSocket;
  private legacyGeneralThreadId: string;
  private readonly inFlight = new Set<string>();
  private runTask?: Promise<void>;
  // Renovaciones de credencial en curso, por turno. Una tarea larga puede
  // terminar con el token del turno ya vencido y necesita uno nuevo justo
  // cuando va a subir su resultado.
  private readonly pendingAuth = new Map<
    string,
    { resolve: (auth?: QueryDelegatedAuth) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: QuerySocketOptions) {
    const { account } = options;
    this.legacyGeneralThreadId = account.accountId;
    this.store = new ResponseStore(
      account.stateFile ?? defaultResponseStorePath(account.accountId),
    );
  }

  get account(): ResolvedQueryAccount {
    return this.options.account;
  }

  async start(): Promise<void> {
    await this.store.load();
    activeMonitors.set(this.options.account.accountId, this);
    this.runTask = this.runLoop();
  }

  async stop(): Promise<void> {
    if (activeMonitors.get(this.options.account.accountId) === this) {
      activeMonitors.delete(this.options.account.accountId);
    }
    this.socket?.close(1000, "El agente se está deteniendo");
    await this.runTask;
  }

  sendOutboundEvent(event: QueryOutboundEvent): void {
    this.send(event);
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.options.abortSignal.aborted) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (error) {
        if (this.options.abortSignal.aborted) break;
        const delay = reconnectDelay(
          attempt++,
          this.options.account.reconnectMinMs,
          this.options.account.reconnectMaxMs,
        );
        this.options.log?.warn?.(
          `[${this.options.account.accountId}] Query socket disconnected: ${String(error)}; reconnecting in ${delay}ms`,
        );
        this.patchStatus({ running: false, lastError: String(error) });
        await wait(delay, this.options.abortSignal);
      }
    }
  }

  private connectOnce(): Promise<void> {
    const { account, abortSignal } = this.options;
    const url = buildSocketUrl(account.url, account.token);
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastPongAt = Date.now();
      const socket = new WebSocket(url, {
        handshakeTimeout: 15_000,
        ...(account.origin ? { origin: account.origin } : {}),
      });
      this.socket = socket;

      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt > account.heartbeatMs * 2.5) {
          socket.terminate();
          return;
        }
        socket.ping();
      }, account.heartbeatMs);

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        abortSignal.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = undefined;
        error ? reject(error) : resolve();
      };
      const abort = () => {
        socket.close(1000, "El agente se está deteniendo");
        finish();
      };
      abortSignal.addEventListener("abort", abort, { once: true });

      socket.on("open", () => {
        lastPongAt = Date.now();
        this.options.log?.info?.(`[${account.accountId}] connected to Query`);
        this.patchStatus({ running: true, lastError: undefined });
      });
      socket.on("pong", () => {
        lastPongAt = Date.now();
      });
      socket.on("message", (data) => {
        void this.handleRawMessage(toText(data)).catch((error) => {
          this.options.log?.error?.(`[${account.accountId}] inbound failure: ${String(error)}`);
        });
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", (code, reason) => {
        const suffix = reason.length ? `: ${reason.toString("utf8")}` : "";
        if (abortSignal.aborted || code === 1000) finish();
        else finish(new Error(`WebSocket closed with code ${code}${suffix}`));
      });
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    const event = parseQueryEvent(raw);
    if (!event) {
      this.options.log?.debug?.("Query ignored an unsupported or malformed event.");
      return;
    }
    if (event.type === "session.ready") {
      if (
        event.data.protocol !== "query-openclaw.v1" &&
        event.data.protocol !== "query-openclaw.v2"
      ) {
        throw new Error(`Unsupported Query protocol: ${event.data.protocol}`);
      }
      const generalThreadId =
        event.data.general_thread_id ?? event.data.thread_id;
      if (generalThreadId !== undefined) {
        this.legacyGeneralThreadId = String(generalThreadId);
      }
      return;
    }
    if (event.type === "auth.granted") {
      const turnKey = `${String(event.thread_id ?? "")} ${event.client_msg_id ?? ""}`;
      const waiting = this.pendingAuth.get(turnKey);
      if (waiting) {
        this.pendingAuth.delete(turnKey);
        clearTimeout(waiting.timer);
        waiting.resolve(event.data?.delegated_auth);
      }
      return;
    }
    if (event.type === "schedule.cancel") {
      const { cancelQuerySchedules } = await import("./cron-sync.js");
      await cancelQuerySchedules(event.data.external_ids, this.options.log);
      return;
    }
    await this.handleUserMessage(event);
  }

  private async handleUserMessage(event: QueryUserMessageEvent): Promise<void> {
    const receivedAt = Date.now();
    const threadSource =
      event.thread_id !== undefined && event.thread_id !== null
        ? "event.thread_id"
        : event.data?.thread_id !== undefined && event.data.thread_id !== null
          ? "event.data.thread_id"
          : "session.ready";
    const threadId = String(
      event.thread_id ?? event.data?.thread_id ?? this.legacyGeneralThreadId,
    ).trim();
    if (!threadId) {
      throw new Error("Query message is missing thread_id.");
    }
    const rawEvent = event as unknown as Record<string, unknown>;
    const rawData =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};
    const createdById = rawEvent.created_by_id ?? rawData.created_by_id;
    const delegatedAuthPresent = Boolean(event.data?.delegated_auth?.token);
    const diagnosticsBefore = delegatedAuthStoreDiagnostics();
    this.options.log?.info?.(
      `[${this.options.account.accountId}] query_delegated_auth_inbound ` +
        `pid=${process.pid} thread_id=${JSON.stringify(threadId)} ` +
        `thread_source=${threadSource} client_msg_id=${JSON.stringify(event.client_msg_id)} ` +
        `delegated_auth_present=${delegatedAuthPresent} ` +
        `created_by_id_present=${createdById !== undefined && createdById !== null} ` +
        `store_key=${JSON.stringify(threadId)} ` +
        `store_file=${JSON.stringify(diagnosticsBefore.stateFile)}`,
    );
    // La credencial del turno queda disponible para las herramientas Query, que
    // se ejecutan despues y fuera de este contexto.
    rememberDelegatedAuth(
      threadId,
      event.data?.delegated_auth,
      this.options.account.url,
      event.client_msg_id,
    );
    const stored = peekDelegatedAuth(threadId);
    const diagnosticsAfter = delegatedAuthStoreDiagnostics();
    this.options.log?.info?.(
      `[${this.options.account.accountId}] query_delegated_auth_stored ` +
        `pid=${process.pid} store_key=${JSON.stringify(threadId)} ` +
        `stored=${Boolean(stored)} ` +
        `client_msg_id_match=${stored?.clientMsgId === event.client_msg_id} ` +
        `visible_keys=${JSON.stringify(diagnosticsAfter.keys)} ` +
        `store_file=${JSON.stringify(diagnosticsAfter.stateFile)}`,
    );
    const turnKey = `${threadId}\u0000${event.client_msg_id}`;
    const cached = this.store.get(threadId, event.client_msg_id);
    if (cached) {
      this.send(cachedResponseEvent(cached));
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_cached_terminal_sent total_ms=${Date.now() - receivedAt}`,
      );
      return;
    }
    if (this.inFlight.has(turnKey)) {
      this.send(
        activityEvent({
          threadId,
          clientMsgId: event.client_msg_id,
          state: "working",
          label: "El agente sigue procesando el mensaje",
          stage: "agent",
        }),
      );
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_duplicate_inflight_activity_sent total_ms=${Date.now() - receivedAt}`,
      );
      return;
    }

    this.inFlight.add(turnKey);
    this.options.log?.info?.(
      `[${this.options.account.accountId}] ${event.client_msg_id}: query_received attachments=${event.data?.attachments?.length ?? 0}`,
    );
    this.send(
      activityEvent({
        threadId,
        clientMsgId: event.client_msg_id,
        state: "working",
        label: "El agente recibió el mensaje",
        stage: "received",
        progress: 0,
      }),
    );
    const activityAt = Date.now();
    this.options.log?.info?.(
      `[${this.options.account.accountId}] ${event.client_msg_id}: query_activity_sent activity_ms=${activityAt - receivedAt}`,
    );
    this.patchStatus({ lastInboundAt: Date.now() });

    let lastActivityLabel = "El agente está trabajando";
    const emitTurnActivity = (
      activity: {
        label: string;
        detail?: string;
        stage?: string;
        toolName?: string;
        progress?: number;
        runId?: string;
      },
      heartbeat = false,
    ) => {
      lastActivityLabel = activity.label || lastActivityLabel;
      try {
        this.send(
          activityEvent({
            threadId,
            clientMsgId: event.client_msg_id,
            state: "working",
            label: lastActivityLabel,
            detail: activity.detail,
            stage: activity.stage,
            toolName: activity.toolName,
            progress: activity.progress,
            runId: activity.runId,
            heartbeat,
            elapsedMs: Date.now() - receivedAt,
          }),
        );
      } catch (error) {
        this.options.log?.debug?.(
          `[${this.options.account.accountId}] ${event.client_msg_id}: activity delivery deferred: ${String(error)}`,
        );
      }
    };
    const activityHeartbeat = setInterval(() => {
      emitTurnActivity(
        {
          label: lastActivityLabel,
          stage: "heartbeat",
        },
        true,
      );
    }, QUERY_ACTIVITY_HEARTBEAT_MS);
    activityHeartbeat.unref?.();

    try {
      const dispatchAt = Date.now();
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_gateway_dispatch dispatch_ms=${dispatchAt - receivedAt}`,
      );
      const result = await withTimeout(
        (this.options.dispatchMessage ?? dispatchQueryMessage)({
          cfg: this.options.cfg,
          account: this.options.account,
          event,
          threadId,
          onProgress: (detail) => {
            this.options.log?.debug?.(
              `[${this.options.account.accountId}] ${event.client_msg_id}: ${detail}`,
            );
          },
          onActivity: (activity) => emitTurnActivity(activity),
          log: this.options.log,
        }),
        this.options.account.responseTimeoutMs,
      );
      const agentDoneAt = Date.now();
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_agent_done agent_ms=${agentDoneAt - dispatchAt} total_ms=${agentDoneAt - receivedAt}`,
      );
      let mediaAttachments = await this.buildResponseAttachments(
        event,
        threadId,
        result.mediaUrls,
      );
      try {
        const alreadyHasAudio = mediaAttachments.some(isAudioAttachment);
        const assistantAudio = alreadyHasAudio
          ? undefined
          : await buildAssistantAudioAttachment(event, result.text);
        if (assistantAudio) mediaAttachments.push(assistantAudio);
      } catch (error) {
        this.options.log?.warn?.(
          `[${this.options.account.accountId}] ${event.client_msg_id}: query_assistant_audio_failed error=${String(error)}`,
        );
      }
      mediaAttachments = oneVoiceNote(mediaAttachments);
      const responseText = result.text.trim();
      if (!responseText && mediaAttachments.length === 0) {
        const response: CachedResponse = {
          threadId,
          clientMsgId: event.client_msg_id,
          type: "error",
          content: "El agente terminó sin devolver contenido visible.",
          data: { detail: "empty_agent_response" },
          completedAt: Date.now(),
        };
        await this.store.set(response);
        this.patchStatus({ lastOutboundAt: Date.now(), lastError: "empty_agent_response" });
        this.options.runtime.error?.(
          `query: empty visible response for ${event.client_msg_id}`,
        );
        this.send(cachedResponseEvent(response));
        this.options.log?.info?.(
          `[${this.options.account.accountId}] ${event.client_msg_id}: query_empty_terminal_guard_sent total_ms=${Date.now() - receivedAt}`,
        );
        return;
      }
      const response: CachedResponse = {
        threadId,
        clientMsgId: event.client_msg_id,
        type: "message",
        content: responseText,
        data: {
          attachments: mediaAttachments,
          ...(responseText ? { caption: responseText, text: responseText } : {}),
        },
        completedAt: Date.now(),
      };
      await this.store.set(response);
      this.patchStatus({ lastOutboundAt: Date.now(), lastError: undefined });
      this.send(cachedResponseEvent(response));
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_terminal_sent total_ms=${Date.now() - receivedAt}`,
      );
    } catch (error) {
      const existing = this.store.get(threadId, event.client_msg_id);
      if (existing) {
        throw error;
      }
      const response: CachedResponse = {
        threadId,
        clientMsgId: event.client_msg_id,
        type: "error",
        content: "El agente no pudo procesar este mensaje.",
        data: { detail: error instanceof Error ? error.message : String(error) },
        completedAt: Date.now(),
      };
      await this.store.set(response);
      this.patchStatus({ lastOutboundAt: Date.now(), lastError: String(error) });
      this.options.runtime.error?.(`query: failed processing ${event.client_msg_id}: ${String(error)}`);
      this.send(cachedResponseEvent(response));
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_error_terminal_sent total_ms=${Date.now() - receivedAt}`,
      );
    } finally {
      clearInterval(activityHeartbeat);
      this.inFlight.delete(turnKey);
    }
  }

  /**
   * Convierte lo que produjo el agente en adjuntos que Query puede servir.
   *
   * Un artifact local se sube y viaja con su URL oficial. Solo si Query no
   * delego credencial (gateway antiguo) se cae al comportamiento anterior, que
   * como mucho puede inlinear medios pequenos.
   */
  private async buildResponseAttachments(
    event: QueryUserMessageEvent,
    threadId: string,
    mediaUrls: string[],
  ): Promise<QueryAttachment[]> {
    const attachments: QueryAttachment[] = [];
    for (const mediaUrl of mediaUrls) {
      const delegated = event.data?.delegated_auth;
      if (!isLocalArtifactPath(mediaUrl) || !delegated?.token) {
        attachments.push(await queryAttachmentForMediaSource(mediaUrl));
        continue;
      }
      try {
        attachments.push(
          await this.uploadArtifact(event, threadId, mediaUrl, delegated),
        );
      } catch (error) {
        // Se pierde el archivo, no el turno: el usuario recibe la respuesta y
        // el fallo queda en el log en vez de un enlace que no abre.
        this.options.log?.warn?.(
          `[${this.options.account.accountId}] ${event.client_msg_id}: ` +
            `query_artifact_upload_failed path=${mediaUrl} error=${String(error)}`,
        );
      }
    }
    return attachments;
  }

  private async uploadArtifact(
    event: QueryUserMessageEvent,
    threadId: string,
    mediaUrl: string,
    delegated: QueryDelegatedAuth,
  ): Promise<QueryAttachment> {
    const uploadUrl = queryUploadUrlFor(this.options.account.url, threadId);
    const attachment = queryAttachmentForMediaUrl(mediaUrl);
    try {
      return await uploadArtifactToQuery({
        uploadUrl,
        token: delegated.token,
        path: mediaUrl,
        attachment,
      });
    } catch (error) {
      if (!(error instanceof QueryUploadError) || !error.isExpiredCredential) {
        throw error;
      }
      const renewed = await this.refreshDelegatedAuth(threadId, event.client_msg_id);
      if (!renewed?.token) throw error;
      return uploadArtifactToQuery({
        uploadUrl,
        token: renewed.token,
        path: mediaUrl,
        attachment,
      });
    }
  }

  refreshDelegatedAuth(
    threadId: string,
    clientMsgId: string,
  ): Promise<QueryDelegatedAuth | undefined> {
    const turnKey = `${threadId}\u0000${clientMsgId}`;
    const existing = this.pendingAuth.get(turnKey);
    if (existing) {
      // Ya hay una renovacion en vuelo para este turno: no se pide dos veces.
      return new Promise((resolve) => {
        const previous = existing.resolve;
        existing.resolve = (auth) => {
          previous(auth);
          resolve(auth);
        };
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(turnKey);
        resolve(undefined);
      }, QUERY_AUTH_REFRESH_TIMEOUT_MS);
      timer.unref?.();
      this.pendingAuth.set(turnKey, { resolve, timer });
      try {
        this.send({
          type: "auth.refresh",
          role: "system",
          content: "",
          client_msg_id: clientMsgId,
          thread_id: threadId,
          data: {},
        });
      } catch (error) {
        this.pendingAuth.delete(turnKey);
        clearTimeout(timer);
        this.options.log?.warn?.(
          `[${this.options.account.accountId}] ${clientMsgId}: ` +
            `query_auth_refresh_failed error=${String(error)}`,
        );
        resolve(undefined);
      }
    });
  }

  private send(event: QueryOutboundEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Query WebSocket is not connected.");
    }
    this.socket.send(JSON.stringify(event));
  }

  private patchStatus(patch: Partial<ChannelAccountSnapshot>): void {
    this.options.setStatus({ ...this.options.getStatus(), ...patch });
  }
}

const activeMonitors = new Map<string, QuerySocketMonitor>();

/** Cuenta viva de una sesion, para derivar el endpoint de subida y su token. */
export function getQueryAccountForUpload(
  accountId: string,
): ResolvedQueryAccount | undefined {
  return activeMonitors.get(accountId)?.account;
}

export function sendQueryOutboundEvent(accountId: string, event: QueryOutboundEvent): void {
  const monitor = activeMonitors.get(accountId);
  if (!monitor) {
    throw new Error(`Query account ${accountId} is not running.`);
  }
  monitor.sendOutboundEvent(event);
}

export async function refreshQueryDelegatedAuth(
  threadId: string | number,
  socketUrl: string,
  clientMsgId?: string,
): Promise<QueryDelegatedAuth | undefined> {
  if (!clientMsgId) return undefined;
  const monitor = [...activeMonitors.values()].find(
    (candidate) => candidate.account.url === socketUrl,
  );
  if (!monitor) return undefined;
  return monitor.refreshDelegatedAuth(String(threadId), clientMsgId);
}
