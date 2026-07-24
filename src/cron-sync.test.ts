import { describe, expect, it, vi } from "vitest";
import {
  cancelQuerySchedules,
  registerQueryCronSync,
} from "./cron-sync.js";

type Hook = (...args: any[]) => unknown;

function fakeApi() {
  const hooks = new Map<string, Hook>();
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn((name: string, handler: Hook) => {
      hooks.set(name, handler);
    }),
  };
  return { api, hooks };
}

describe("Query cron sync", () => {
  it("syncs add/remove with the account and thread that own the delivery", () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);

    hooks.get("cron_changed")?.({
      action: "added",
      jobId: "cron-sales-1",
      job: {
        delivery: {
          channel: "query",
          accountId: "sales",
          threadId: "private-42",
        },
      },
    });
    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        type: "schedule.sync",
        thread_id: "private-42",
        data: expect.objectContaining({
          action: "added",
          external_id: "cron-sales-1",
        }),
      }),
    );

    hooks.get("cron_changed")?.({
      action: "removed",
      jobId: "cron-sales-1",
    });
    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        thread_id: "private-42",
        data: expect.objectContaining({ action: "removed" }),
      }),
    );
  });

  it("deduplicates cancellation ids received from Query", async () => {
    const { api, hooks } = fakeApi();
    const remove = vi.fn(async () => undefined);
    registerQueryCronSync(api as never, vi.fn());
    hooks.get("gateway_start")?.({}, { getCron: () => ({ remove }) });

    await cancelQuerySchedules(
      ["cron-cancel-1", "cron-cancel-1", ""],
      api.logger,
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("cron-cancel-1");
    hooks.get("gateway_stop")?.();
  });
});
