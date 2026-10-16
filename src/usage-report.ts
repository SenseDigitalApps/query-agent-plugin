import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { queryRunTurn } from "./external-context.js";
import { resolveQuerySession } from "./query-session-store.js";
import { trySendQueryUsage } from "./socket.js";
import type { QueryOutboundEvent } from "./types.js";

/**
 * Consumo de tokens de cada intento del agente, reportado a Query.
 *
 * OpenClaw avisa con ``llm_output`` al cerrar cada intento de una ejecución, con
 * el consumo acumulado de todas sus llamadas al modelo. Un reintento o un cambio
 * de modelo vuelve a avisar con el mismo ``runId``: por eso cada aviso lleva su
 * número de intento. Query descarta duplicados por esa clave, así que reenviar
 * es seguro; aquí solo se guarda lo pendiente hasta que Query lo confirme.
 */

type UsageCounts = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

export type LlmOutputEvent = { runId: string; provider?: string; model?: string; usage?: UsageCounts };
export type LlmOutputContext = {
  sessionKey?: string;
  channel?: string;
  chatId?: string;
  channelId?: string;
  accountId?: string;
  trigger?: string;
};

export type PendingUsageReport = {
  reportId: string;
  accountId?: string;
  event: QueryOutboundEvent;
  createdAt: number;
  sentAt?: number;
};

type Sender = (accountId: string | undefined, event: QueryOutboundEvent) => boolean;

const STORE_VERSION = 1;
const MAX_PENDING = 5000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Sin confirmación en este tiempo se reenvía: Query responde en milisegundos.
const RESEND_AFTER_MS = 60 * 1000;
const ATTEMPT_MEMORY_MS = 12 * 60 * 60 * 1000;

const attempts = new Map<string, { count: number; at: number }>();
const pending = new Map<string, PendingUsageReport>();
let loaded = false;

function stateFile(): string {
  const configured = process.env.QUERY_USAGE_STATE_FILE?.trim();
  if (configured) return configured;
  const root = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(root, "query-usage-pending.json");
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as {
      version?: number;
      reports?: PendingUsageReport[];
    };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.reports)) return;
    for (const report of parsed.reports) {
      if (report?.reportId && report.event) pending.set(report.reportId, report);
    }
  } catch {
    // Sin archivo o corrupto: no hay pendientes que recuperar.
  }
}

function persist(): void {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, reports: [...pending.values()] }), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, file);
  } catch {
    // Perder un reporte cuesta menos que interrumpir el turno del agente.
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nextAttempt(runId: string, now: number): number {
  for (const [key, entry] of attempts) {
    if (now - entry.at > ATTEMPT_MEMORY_MS) attempts.delete(key);
  }
  const entry = attempts.get(runId);
  const value = (entry?.count ?? 0) + 1;
  attempts.set(runId, { count: value, at: now });
  return value;
}

/** Arma el reporte de un intento, o nada si no salió de una conversación de Query. */
export function usageReportFor(
  event: LlmOutputEvent,
  context: LlmOutputContext,
  now = Date.now(),
): PendingUsageReport | undefined {
  const usage = {
    input: count(event.usage?.input),
    output: count(event.usage?.output),
    cacheRead: count(event.usage?.cacheRead),
    cacheWrite: count(event.usage?.cacheWrite),
  };
  if (!event.runId || !(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)) return undefined;
  // El turno humano fijado al despachar dice quién escribió; la sesión, si es un cron.
  const turn = queryRunTurn(event.runId);
  const session = resolveQuerySession(context.sessionKey);
  const channelThread = context.channel === "query" ? context.chatId ?? context.channelId : undefined;
  const threadId = turn?.threadId ?? session?.threadId ?? channelThread;
  if (!threadId) return undefined;
  const accountId = turn?.accountId ?? session?.accountId ??
    (context.channel === "query" ? context.accountId : undefined);
  const attempt = nextAttempt(event.runId, now);
  const reportId = `${event.runId}:${attempt}`;
  const clientMsgId = turn?.clientMsgId ?? "";
  return {
    reportId,
    accountId,
    createdAt: now,
    event: {
      type: "usage.report",
      role: "system",
      content: "",
      client_msg_id: clientMsgId,
      thread_id: String(threadId),
      data: {
        report_id: reportId,
        run_id: event.runId,
        attempt,
        provider: event.provider ?? "",
        model: event.model ?? "",
        usage,
        trigger: context.trigger ?? "",
        ...(session?.jobId ? { job_id: session.jobId } : {}),
        ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
      },
    },
  };
}

/** Envía lo pendiente que no se haya enviado hace rato. */
export function flushUsageReports(send: Sender, now = Date.now()): void {
  load();
  let changed = false;
  for (const [reportId, report] of pending) {
    if (now - report.createdAt > MAX_AGE_MS) {
      pending.delete(reportId);
      changed = true;
      continue;
    }
    if (report.sentAt && now - report.sentAt < RESEND_AFTER_MS) continue;
    if (send(report.accountId, report.event)) {
      report.sentAt = now;
      changed = true;
    }
  }
  if (changed) persist();
}

export function queueUsageReport(report: PendingUsageReport, send: Sender): void {
  load();
  pending.set(report.reportId, report);
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  if (send(report.accountId, report.event)) report.sentAt = Date.now();
  persist();
}

/** Query confirmó el reporte (nuevo o repetido): ya no hace falta guardarlo. */
export function acknowledgeUsageReport(reportId: string): void {
  load();
  if (pending.delete(reportId)) persist();
}

export function pendingUsageReports(): PendingUsageReport[] {
  load();
  return [...pending.values()];
}

/** Solo para pruebas: olvida el estado en memoria. */
export function resetUsageReportsForTests(): void {
  attempts.clear();
  pending.clear();
  loaded = false;
}

export function registerQueryUsage(api: OpenClawPluginApi, sender: Sender = trySendQueryUsage): void {
  api.on("llm_output", async (event, context) => {
    try {
      const report = usageReportFor(event as LlmOutputEvent, (context ?? {}) as LlmOutputContext);
      if (report) queueUsageReport(report, sender);
    } catch (error) {
      api.logger.warn(`query usage: no se pudo reportar el consumo: ${String(error)}`);
    }
  });
  const timer = setInterval(() => flushUsageReports(sender), RESEND_AFTER_MS);
  timer.unref?.();
}
