import type {
  OpenClawPluginApi,
  PluginHookCronChangedEvent,
  PluginHookGatewayCronService,
} from "openclaw/plugin-sdk/plugin-runtime";
import { sendQueryOutboundEvent } from "./socket.js";
import { DEFAULT_ACCOUNT_ID, type QueryOutboundEvent } from "./types.js";

type CronDelivery = {
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
};

type SyncedCron = {
  accountId: string;
  threadId: string;
};

const syncedCrons = new Map<string, SyncedCron>();
let cronService: PluginHookGatewayCronService | undefined;

export async function cancelQuerySchedules(
  externalIds: string[],
  log?: { info?: (message: string) => void; warn?: (message: string) => void },
): Promise<void> {
  if (!cronService) {
    log?.warn?.("Query cannot cancel schedules before the cron service is ready.");
    return;
  }
  for (const externalId of [...new Set(externalIds.filter(Boolean))]) {
    try {
      await cronService.remove(externalId);
      syncedCrons.delete(externalId);
      log?.info?.(`Query cancelled OpenClaw schedule ${externalId}.`);
    } catch (error) {
      log?.warn?.(
        `Query failed to cancel OpenClaw schedule ${externalId}: ${String(error)}`,
      );
    }
  }
}

function targetFrom(event: PluginHookCronChangedEvent): SyncedCron | undefined {
  const job = event.job as
    | (NonNullable<PluginHookCronChangedEvent["job"]> & {
        delivery?: CronDelivery;
      })
    | undefined;
  const delivery = job?.delivery;
  if (delivery?.channel !== "query") return syncedCrons.get(event.jobId);
  const target = delivery.threadId ?? delivery.to;
  if (target === undefined || target === null || String(target).trim() === "") {
    return undefined;
  }
  return {
    accountId: delivery.accountId?.trim() || DEFAULT_ACCOUNT_ID,
    threadId: String(target),
  };
}

export function registerQueryCronSync(
  api: OpenClawPluginApi,
  sendEvent: typeof sendQueryOutboundEvent = sendQueryOutboundEvent,
): void {
  api.on("gateway_start", (_event, context) => {
    cronService = context.getCron?.();
  });
  api.on("gateway_stop", () => {
    cronService = undefined;
  });
  api.on("cron_changed", (event: PluginHookCronChangedEvent) => {
    if (!["added", "updated", "removed"].includes(event.action)) return;
    const target = targetFrom(event);
    if (!target) return;

    const outbound: QueryOutboundEvent = {
      type: "schedule.sync",
      role: "system",
      content: "",
      client_msg_id: "",
      thread_id: target.threadId,
      data: {
        action: event.action,
        external_id: event.jobId,
        job: event.job ?? null,
      },
    };
    try {
      sendEvent(target.accountId, outbound);
      if (event.action === "removed") syncedCrons.delete(event.jobId);
      else syncedCrons.set(event.jobId, target);
    } catch (error) {
      api.logger.warn(
        `query cron sync failed for ${event.jobId}: ${String(error)}`,
      );
    }
  });
}
