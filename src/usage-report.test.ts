import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pinExternalRun, rememberExternalContext } from "./external-context.js";
import { forgetQuerySession, rememberQuerySession } from "./query-session-store.js";
import {
  acknowledgeUsageReport,
  flushUsageReports,
  pendingUsageReports,
  queueUsageReport,
  registerQueryUsage,
  resetUsageReportsForTests,
  usageReportFor,
} from "./usage-report.js";

vi.mock("./socket.js", () => ({ trySendQueryUsage: vi.fn(() => false) }));

const SOCKET = "wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x";
const HUMAN_SESSION = "agent:query:query:group:24";
const CRON_SESSION = "agent:query:cron:cron-9:run:run-c";
const USAGE = { input: 100, output: 20, cacheRead: 300, cacheWrite: 0 };

let directory: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["QUERY_USAGE_STATE_FILE", "QUERY_SESSION_BINDING_STATE_FILE", "QUERY_EXTERNAL_CONTEXT_DIR"];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "query-usage-"));
  for (const name of ENV) saved[name] = process.env[name];
  process.env.QUERY_USAGE_STATE_FILE = join(directory, "usage.json");
  process.env.QUERY_SESSION_BINDING_STATE_FILE = join(directory, "sessions.json");
  process.env.QUERY_EXTERNAL_CONTEXT_DIR = join(directory, "external");
});

afterAll(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(directory, { recursive: true, force: true });
});

afterEach(() => {
  for (const report of pendingUsageReports()) acknowledgeUsageReport(report.reportId);
  resetUsageReportsForTests();
  forgetQuerySession(HUMAN_SESSION);
  forgetQuerySession(CRON_SESSION);
});

function humanTurn(runId: string) {
  rememberExternalContext({ sessionKey: HUMAN_SESSION, senderId: "7", threadId: "24", queryAccountId: "sales",
    socketUrl: SOCKET, agentToken: "agent", clientMsgId: "turno-7", auth: { token: "signed", expires_in: 900 } });
  pinExternalRun(runId, HUMAN_SESSION, "7", "sales");
}

describe("reporte de consumo", () => {
  it("lleva el turno de Query y numera cada intento de la misma ejecucion", () => {
    humanTurn("run-1");
    const context = { sessionKey: HUMAN_SESSION, channel: "query", trigger: "user" };
    const first = usageReportFor({ runId: "run-1", provider: "openai-codex", model: "gpt-5.4", usage: USAGE }, context);
    const retry = usageReportFor({ runId: "run-1", provider: "openai", model: "gpt-5.4-mini", usage: USAGE }, context);

    expect(first).toMatchObject({
      reportId: "run-1:1",
      accountId: "sales",
      event: { type: "usage.report", thread_id: "24", client_msg_id: "turno-7",
        data: { run_id: "run-1", attempt: 1, model: "gpt-5.4", usage: USAGE, client_msg_id: "turno-7" } },
    });
    expect(retry?.reportId).toBe("run-1:2");
    expect(retry?.event.data).toMatchObject({ attempt: 2, provider: "openai" });
  });

  it("un cron lleva su id para cobrarle a quien lo autorizo", () => {
    rememberQuerySession(CRON_SESSION, { threadId: "31", accountId: "sales", jobId: "cron-9" });
    const report = usageReportFor({ runId: "run-c", usage: USAGE }, { sessionKey: CRON_SESSION, trigger: "cron" });

    expect(report?.event.thread_id).toBe("31");
    expect(report?.event.data).toMatchObject({ job_id: "cron-9", trigger: "cron" });
  });

  it("ignora lo que no viene de Query o no gasto nada", () => {
    expect(usageReportFor({ runId: "run-x", usage: USAGE }, { sessionKey: "agent:query:main", channel: "telegram" }))
      .toBeUndefined();
    humanTurn("run-0");
    expect(usageReportFor({ runId: "run-0", usage: {} }, { sessionKey: HUMAN_SESSION })).toBeUndefined();
  });

  it("guarda lo que no se pudo enviar, lo reenvia y lo suelta con el acuse", () => {
    humanTurn("run-2");
    const report = usageReportFor({ runId: "run-2", usage: USAGE }, { sessionKey: HUMAN_SESSION })!;
    const offline = vi.fn(() => false);
    queueUsageReport(report, offline);
    expect(pendingUsageReports().map((item) => item.reportId)).toEqual(["run-2:1"]);

    // Un reinicio del proceso no pierde el pendiente: se lee del disco.
    resetUsageReportsForTests();
    const online = vi.fn(() => true);
    flushUsageReports(online, Date.now() + 1000);
    expect(online).toHaveBeenCalledWith("sales", expect.objectContaining({ type: "usage.report" }));

    flushUsageReports(online, Date.now() + 2000);
    expect(online).toHaveBeenCalledTimes(1);
    acknowledgeUsageReport("run-2:1");
    expect(pendingUsageReports()).toEqual([]);
  });

  it("se engancha a llm_output sin romper el turno ante un error", async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const api = { logger: { warn: vi.fn(), info: vi.fn() }, on: vi.fn((name: string, hook: any) => hooks.set(name, hook)) };
    const send = vi.fn(() => true);
    registerQueryUsage(api as never, send);
    humanTurn("run-3");

    await hooks.get("llm_output")!({ runId: "run-3", usage: USAGE }, { sessionKey: HUMAN_SESSION });
    await hooks.get("llm_output")!({ runId: "run-4", get usage(): never { throw new Error("roto"); } }, {});

    expect(send).toHaveBeenCalledTimes(1);
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no se pudo reportar"));
  });
});
