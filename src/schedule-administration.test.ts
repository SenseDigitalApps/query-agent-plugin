import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleAdministration, scheduleRevision, canonical, type ScheduleAdminCommand } from "./schedule-administration.js";
import { parseQueryEvent } from "./protocol.js";

describe("administrative scheduler adapter", () => {
  let dir: string, job: any, service: any, adapter: ScheduleAdministration;
  const id = "aa000000-0000-4000-8000-000000000001";
  const command = (action = "disable", patch: any = { enabled: false }): ScheduleAdminCommand => ({
    type: "schedule.admin.command", client_msg_id: id, thread_id: "7", data: {
      external_id: "cron-1", revision: scheduleRevision(job), request_hash: "f".repeat(64), action, patch,
      execute: false, run_as_user_id: 82,
    },
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "query-admin-test-"));
    job = { id: "cron-1", name: "Informe ágil 🗓", enabled: true, sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Bogota" },
      payload: { kind: "agentTurn", message: "instrucción privada" },
      delivery: { channel: "query", mode: "announce", accountId: "tenant-a", to: "direct:7" },
      state: { lastRunAtMs: 123, nextRunAtMs: Date.now() + 600000 }, createdAtMs: 1 };
    service = {
      list: vi.fn(async () => [structuredClone(job)]),
      updateWithPrecondition: vi.fn(async (_id, patch, check) => {
        await check(structuredClone(job), Date.now()); Object.assign(job, patch); return job;
      }),
      run: vi.fn(), add: vi.fn(), remove: vi.fn(), update: vi.fn(),
    };
    adapter = new ScheduleAdministration(join(dir, "receipts.json"), "tenant-a", "ws://tenant-a/bot/1", () => service);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("updates the same ID, preserves history and never runs/recreates", async () => {
    const result = await adapter.apply(command());
    expect(result.applied).toBe(true); expect(job.enabled).toBe(false);
    expect(job.state.lastRunAtMs).toBe(123); expect(job.createdAtMs).toBe(1);
    for (const method of ["run", "add", "remove", "update"]) expect(service[method]).not.toHaveBeenCalled();
    expect(service.updateWithPrecondition.mock.calls[0][0]).toBe("cron-1");
    expect(service.updateWithPrecondition.mock.calls[0][1]).toEqual({ enabled: false });
  });
  it("replays after restart without another scheduler write", async () => {
    const request = command(); await adapter.apply(request);
    const restarted = new ScheduleAdministration(join(dir, "receipts.json"), "tenant-a", "ws://tenant-a/bot/1", () => service);
    expect((await restarted.apply(request)).applied).toBe(true);
    expect(service.updateWithPrecondition).toHaveBeenCalledTimes(1);
    const receipt = await readFile(join(dir, "receipts.json"), "utf8");
    expect(receipt).not.toContain("instrucción"); expect(receipt).not.toContain("payload");
  });
  it("serializes simultaneous duplicate commands", async () => {
    const request = command();
    expect((await Promise.all([adapter.apply(request), adapter.apply(request)])).every(r => r.applied)).toBe(true);
    expect(service.updateWithPrecondition).toHaveBeenCalledTimes(1);
  });
  it("does not replay an applied operation over a subsequent edit", async () => {
    const request = command(); await adapter.apply(request); job.name = "changed independently";
    expect((await adapter.apply(request)).applied).toBe(false);
    expect(service.updateWithPrecondition).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant-b", undefined])("rejects foreign or missing account %s", async account => {
    job.delivery.accountId = account;
    expect((await adapter.apply(command())).applied).toBe(false);
    expect(service.updateWithPrecondition).not.toHaveBeenCalled();
  });
  it("rejects another destination and cross-account patches", async () => {
    const wrong = command(); wrong.thread_id = "99";
    expect((await adapter.apply(wrong)).applied).toBe(false);
    expect((await adapter.apply(command("edit", { delivery: { ...job.delivery, accountId: "tenant-b" } }))).applied).toBe(false);
    expect(service.updateWithPrecondition).not.toHaveBeenCalled();
  });
  it("moves the destination and can replay using the original destination", async () => {
    const request = command("edit", { delivery: { ...job.delivery, to: "channel:9" } });
    expect((await adapter.apply(request)).applied).toBe(true);
    expect((await adapter.apply(request)).applied).toBe(true);
    expect(job.delivery.to).toBe("channel:9");
    expect(service.updateWithPrecondition).toHaveBeenCalledTimes(1);
  });
  it("rechecks revision under native scheduler lock", async () => {
    service.updateWithPrecondition.mockImplementation(async (_id, _patch, check) => {
      job.name = "concurrent edit"; await check(job, Date.now());
    });
    expect((await adapter.apply(command())).applied).toBe(false); expect(job.enabled).toBe(true);
  });
  it("rejects missing atomic support", async () => {
    delete service.updateWithPrecondition;
    expect((await adapter.apply(command())).applied).toBe(false); expect(service.update).not.toHaveBeenCalled();
  });
  it("rejects a running job before mutation", async () => {
    job.state.runningAtMs = Date.now();
    expect((await adapter.apply(command())).applied).toBe(false); expect(job.enabled).toBe(true);
  });
  it("does not wake an overdue job as an edit side effect", async () => {
    job.state.nextRunAtMs = Date.now() - 100;
    expect((await adapter.apply(command("edit", { name: "new" }))).applied).toBe(false);
    expect(job.name).not.toBe("new");
  });
  it("preserves enabled during repair/reauthorization without issuing credentials", async () => {
    job.enabled = false;
    expect((await adapter.apply(command("reauthorize", {}))).applied).toBe(true);
    expect(job.enabled).toBe(false); expect(service.updateWithPrecondition).not.toHaveBeenCalled();
  });
  it("rejects loss of native optional fields before writing", async () => {
    job.payload.toolsAllow = ["read"];
    expect((await adapter.apply(command("edit", { payload: { kind: "agentTurn", message: "new" } }))).applied).toBe(false);
    expect(service.updateWithPrecondition).not.toHaveBeenCalled();
  });
  it("never includes native errors or secrets in a negative ACK", async () => {
    service.list.mockRejectedValue(new Error("secret-credential"));
    const result = await adapter.apply(command());
    expect(result).toEqual({ external_id: "cron-1", request_hash: "f".repeat(64), applied: false,
                            error_code: "schedule_scheduler_rejected" });
  });
  it("does not accept a successful update without observing the desired definition", async () => {
    service.updateWithPrecondition.mockResolvedValue({ ok: true });
    expect((await adapter.apply(command())).applied).toBe(false);
  });
  it("parses only administrative commands with execute false", () => {
    const request = command(); expect(parseQueryEvent(JSON.stringify(request))).toEqual(request);
    expect(parseQueryEvent(JSON.stringify({ ...request, data: { ...request.data, execute: true } }))).toBeNull();
  });
  it("uses Python-compatible canonical unicode and ignores execution history", () => {
    expect(canonical({ z: "á😀", a: [null, true] })).toBe('{"a":[null,true],"z":"\\u00e1\\ud83d\\ude00"}');
    const revision = scheduleRevision(job); job.state.lastRunAtMs++;
    expect(scheduleRevision(job)).toBe(revision);
  });
  it("socket waits for Core applied receipt before syncing the new snapshot", async () => {
    const { QuerySocketMonitor } = await import("./socket.js");
    const monitor = new QuerySocketMonitor({ account: { accountId: "tenant-a", url: "ws://tenant-a/bot/1",
      stateFile: join(dir, "socket.json") }, cfg: {}, abortSignal: new AbortController().signal } as any) as any;
    monitor.adminEnabled = true;
    monitor.administration = adapter;
    monitor.send = vi.fn();
    const request = command();
    await monitor.handleRawMessage(JSON.stringify(request));
    expect(monitor.send).toHaveBeenCalledTimes(1);
    expect(monitor.send.mock.calls[0][0]).toMatchObject({ type: "schedule.admin.result", client_msg_id: id,
      data: { external_id: "cron-1", applied: true } });
    await monitor.handleRawMessage(JSON.stringify({ type: "schedule.admin.received", client_msg_id: id,
      data: { external_id: "other-cron", status: "applied" } }));
    expect(monitor.send).toHaveBeenCalledTimes(1);
    await monitor.handleRawMessage(JSON.stringify({ type: "schedule.admin.received", client_msg_id: id,
      data: { external_id: "cron-1", status: "applied" } }));
    expect(monitor.send.mock.calls[1][0]).toMatchObject({ type: "schedule.sync", data: {
      external_id: "cron-1", authorization_version: 2, query_account_id: "tenant-a", request_ack: true } });
    expect(monitor.send.mock.calls[1][0].data).not.toHaveProperty("delegated_token");
  });
  it("socket does not accept administrative commands without Core capability", async () => {
    const { QuerySocketMonitor } = await import("./socket.js");
    const monitor = new QuerySocketMonitor({ account: { accountId: "tenant-a", stateFile: join(dir, "socket.json") },
      cfg: {}, abortSignal: new AbortController().signal } as any) as any;
    monitor.administration = adapter;
    monitor.send = vi.fn();
    await monitor.handleRawMessage(JSON.stringify(command()));
    expect(monitor.send).not.toHaveBeenCalled(); expect(service.updateWithPrecondition).not.toHaveBeenCalled();
  });
});
