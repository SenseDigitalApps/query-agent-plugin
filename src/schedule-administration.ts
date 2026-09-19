import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QueryGatewayCronService } from "./openclaw-compat.js";

type Job = Record<string, any>;
export type ScheduleAdminCommand = {
  type: "schedule.admin.command"; client_msg_id: string; thread_id: string | number;
  data: { external_id: string; revision: string; request_hash: string; action: string;
    patch: Record<string, unknown>; execute: false; run_as_user_id?: number | null };
};
type Receipt = { requestHash: string; externalId: string; revision: string; desired: string;
  target: string; applied: boolean };
export const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = ["name", "description", "schedule", "payload", "delivery", "sessionTarget", "enabled", "sessionKey"];
// Same JSON ASCII encoding and recursive key order as Core's json.dumps.
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${canonical(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function scheduleRevision(job: Job): string {
  return createHash("sha256").update(canonical(Object.fromEntries(fields.map(k => [k, job[k] ?? null])))).digest("hex");
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
class AdministrationError extends Error {}
const fail = (code: string): never => { throw new AdministrationError(code); };
function target(job: Job, accountId: string): string {
  if (job.delivery?.channel !== "query" || job.delivery.accountId !== accountId) fail("schedule_account_mismatch");
  const value = String(job.delivery.threadId ?? job.delivery.to ?? "");
  const match = /^(?:(?:direct|channel):)?([1-9][0-9]*)$/.exec(value);
  if (!match) return fail("schedule_destination_invalid");
  return match[1];
}
function validate(command: ScheduleAdminCommand) {
  const d = command.data;
  if (!/^[0-9a-f-]{36}$/i.test(command.client_msg_id) || !record(d) || d.execute !== false ||
      typeof d.external_id !== "string" || !d.external_id.trim() || d.external_id.length > 200 ||
      !/^[0-9a-f]{64}$/.test(d.revision) || !/^[0-9a-f]{64}$/.test(d.request_hash) || !record(d.patch) ||
      !["edit", "enable", "disable", "repair", "reauthorize"].includes(d.action)) fail("schedule_command_invalid");
  if (Object.keys(d.patch).some(k => !fields.includes(k) || k === "sessionKey")) fail("schedule_patch_invalid");
  if (["enable", "disable"].includes(d.action)) {
    if (Object.keys(d.patch).length !== 1 || d.patch.enabled !== (d.action === "enable")) fail("schedule_patch_invalid");
  } else if (d.action !== "edit" && Object.keys(d.patch).length) fail("schedule_patch_invalid");
  else if (d.action === "edit" && "enabled" in d.patch) fail("schedule_patch_invalid");
  if ("sessionTarget" in d.patch && d.patch.sessionTarget !== "isolated") fail("schedule_isolation_required");
}

/** Only authenticated Core commands call this adapter. No turn/creator token is used. */
export class ScheduleAdministration {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private accountId: string, private socketUrl: string,
              private getService: () => QueryGatewayCronService | undefined) {}
  apply(command: ScheduleAdminCommand): Promise<Record<string, unknown>> {
    const task = this.tail.then(() => this.applyLocked(command));
    this.tail = task.catch(() => undefined);
    return task.catch(error => ({ external_id: command.data.external_id, request_hash: command.data.request_hash,
      applied: false, error_code: error instanceof AdministrationError ? error.message : "schedule_scheduler_rejected" }));
  }
  private async journal(): Promise<Record<string, Receipt>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!record(parsed)) return fail("schedule_journal_invalid");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async save(receipts: Record<string, Receipt>) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(receipts), { mode: 0o600, flag: "wx" });
    await rename(temp, this.file);
  }
  private async applyLocked(command: ScheduleAdminCommand) {
    validate(command);
    const d = command.data;
    const service = this.getService();
    if (!service?.updateWithPrecondition) fail("schedule_atomic_update_unavailable");
    const jobs = await service!.list({ includeDisabled: true });
    const matches = jobs.filter(j => j.id === d.external_id);
    if (matches.length !== 1) fail("schedule_not_found_or_ambiguous");
    const job = matches[0] as Job;
    const currentTarget = target(job, this.accountId);
    const receipts = await this.journal();
    const key = hash(JSON.stringify([this.socketUrl, this.accountId, command.client_msg_id]));
    let receipt = receipts[key];
    if (receipt && (receipt.requestHash !== d.request_hash || receipt.externalId !== d.external_id || receipt.revision !== d.revision))
      fail("schedule_idempotency_conflict");
    if (!receipt) {
      if (currentTarget !== String(command.thread_id) || scheduleRevision(job) !== d.revision) fail("schedule_revision_conflict");
      const desired = { ...job, ...d.patch };
      target(desired, this.accountId);
      if (d.action !== "disable" && (desired.sessionTarget !== "isolated" || desired.sessionKey)) fail("schedule_isolation_required");
      // Native updates merge these objects. Reject destructive replacement before writing.
      for (const field of ["payload", "delivery"]) {
        if (field in d.patch && (!record(d.patch[field]) ||
            Object.keys(job[field] ?? {}).some(k => !(k in (d.patch[field] as object))))) fail("schedule_patch_not_lossless");
      }
      receipt = { requestHash: d.request_hash, externalId: d.external_id, revision: d.revision,
                  desired: scheduleRevision(desired), target: target(desired, this.accountId), applied: false };
      receipts[key] = receipt;
      await this.save(receipts); // Write intent before scheduler mutation, for crash recovery.
    }
    const alreadyApplied = scheduleRevision(job) === receipt.desired && currentTarget === receipt.target;
    if (!alreadyApplied) {
      if (receipt.applied || currentTarget !== String(command.thread_id) || scheduleRevision(job) !== receipt.revision)
        fail("schedule_revision_conflict");
      await service!.updateWithPrecondition!(d.external_id, d.patch, (current, nowMs) => {
        const locked = current as Job;
        if (target(locked, this.accountId) !== String(command.thread_id) || scheduleRevision(locked) !== receipt.revision)
          fail("schedule_revision_conflict");
        if (locked.state?.runningAtMs) fail("schedule_job_running");
        // An unchanged overdue timer could otherwise wake immediately after editing.
        if (locked.enabled !== false && Number(locked.state?.nextRunAtMs) <= nowMs &&
            d.action !== "disable" && !("schedule" in d.patch)) fail("schedule_job_due");
      });
    }
    const observed = (await service!.list({ includeDisabled: true })).find(j => j.id === d.external_id) as Job | undefined;
    if (!observed || target(observed, this.accountId) !== receipt.target || scheduleRevision(observed) !== receipt.desired)
      fail("schedule_update_unconfirmed");
    receipt.applied = true;
    await this.save(receipts);
    return { external_id: d.external_id, request_hash: d.request_hash, applied: true, job: observed };
  }
}
