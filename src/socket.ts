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
import { queryAttachmentForMediaSource } from "./media.js";
import { defaultResponseStorePath, ResponseStore } from "./response-store.js";
import type {
  CachedResponse,
  QueryConfig,
  QueryAttachment,
  QueryOutboundEvent,
  QueryUserMessageEvent,
  ResolvedQueryAccount,
} from "./types.js";

const require = createRequire(import.meta.url);
const QUERY_REPLY_AUDIO = process.env.QUERY_REPLY_AUDIO ?? "1";
const QUERY_REPLY_AUDIO_MODE = process.env.QUERY_REPLY_AUDIO_MODE ?? "requested";
const QUERY_TTS_BIN = process.env.QUERY_TTS_BIN ?? require.resolve("node-edge-tts/bin.js");
const QUERY_TTS_VOICE = process.env.QUERY_TTS_VOICE ?? "es-CO-GonzaloNeural";
const QUERY_TTS_LANG = process.env.QUERY_TTS_LANG ?? "es-CO";
const QUERY_TTS_RATE = process.env.QUERY_TTS_RATE ?? "+15%";

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
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        QUERY_TTS_BIN,
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
  private sessionThreadId: string;
  private readonly inFlight = new Set<string>();
  private runTask?: Promise<void>;

  constructor(private readonly options: QuerySocketOptions) {
    const { account } = options;
    this.sessionThreadId = account.accountId;
    this.store = new ResponseStore(
      account.stateFile ?? defaultResponseStorePath(account.accountId),
    );
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
      if (event.data.protocol !== "query-openclaw.v1") {
        throw new Error(`Unsupported Query protocol: ${event.data.protocol}`);
      }
      if (event.data.thread_id !== undefined) {
        this.sessionThreadId = String(event.data.thread_id);
      }
      return;
    }
    await this.handleUserMessage(event);
  }

  private async handleUserMessage(event: QueryUserMessageEvent): Promise<void> {
    const receivedAt = Date.now();
    const cached = this.store.get(event.client_msg_id);
    if (cached) {
      this.send(cachedResponseEvent(cached));
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_cached_terminal_sent total_ms=${Date.now() - receivedAt}`,
      );
      return;
    }
    if (this.inFlight.has(event.client_msg_id)) {
      this.send(
        activityEvent({
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

    this.inFlight.add(event.client_msg_id);
    this.options.log?.info?.(
      `[${this.options.account.accountId}] ${event.client_msg_id}: query_received attachments=${event.data?.attachments?.length ?? 0}`,
    );
    this.send(
      activityEvent({
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
          threadId: this.sessionThreadId,
          onProgress: (detail) => {
            this.options.log?.debug?.(
              `[${this.options.account.accountId}] ${event.client_msg_id}: ${detail}`,
            );
          },
        }),
        this.options.account.responseTimeoutMs,
      );
      const agentDoneAt = Date.now();
      this.options.log?.info?.(
        `[${this.options.account.accountId}] ${event.client_msg_id}: query_agent_done agent_ms=${agentDoneAt - dispatchAt} total_ms=${agentDoneAt - receivedAt}`,
      );
      const mediaAttachments = await Promise.all(
        result.mediaUrls.map((url) => queryAttachmentForMediaSource(url)),
      );
      try {
        const assistantAudio = await buildAssistantAudioAttachment(event, result.text);
        if (assistantAudio) mediaAttachments.push(assistantAudio);
      } catch (error) {
        this.options.log?.warn?.(
          `[${this.options.account.accountId}] ${event.client_msg_id}: query_assistant_audio_failed error=${String(error)}`,
        );
      }
      const response: CachedResponse = {
        clientMsgId: event.client_msg_id,
        type: "message",
        content: result.text,
        data: {
          attachments: mediaAttachments,
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
      const existing = this.store.get(event.client_msg_id);
      if (existing) {
        throw error;
      }
      const response: CachedResponse = {
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
      this.inFlight.delete(event.client_msg_id);
    }
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

export function sendQueryOutboundEvent(accountId: string, event: QueryOutboundEvent): void {
  const monitor = activeMonitors.get(accountId);
  if (!monitor) {
    throw new Error(`Query account ${accountId} is not running.`);
  }
  monitor.sendOutboundEvent(event);
}
