import { describe, expect, it, vi } from "vitest";
import {
  backfillQuerySchedules,
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

  it("refuses to sync Query cron delivery without an explicit accountId", () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);

    hooks.get("cron_changed")?.({
      action: "added",
      jobId: "cron-ambiguous-1",
      job: {
        delivery: {
          channel: "query",
          threadId: "private-42",
        },
      },
    });

    expect(send).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("delivery Query sin accountId"),
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

describe("backfill de crones preexistentes", () => {
  /** Arranca el gateway con tareas ya registradas y devuelve los hooks. */
  async function startWithExistingCrons(
    jobs: unknown[],
    send = vi.fn(),
  ) {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, send);
    await hooks.get("gateway_start")?.(
      {},
      { getCron: () => ({ list: async () => jobs }) },
    );
    return { api, hooks, send };
  }

  const existingJob = {
    id: "cron-viejo",
    name: "Resumen semanal",
    payload: { kind: "text", text: "Revisa las alertas" },
    delivery: { channel: "query", accountId: "sales", threadId: "private-42" },
  };

  it("no anuncia nada hasta que la sesion de Query esta lista", async () => {
    const { send } = await startWithExistingCrons([existingJob]);
    // El gateway arranca antes que el socket: aqui todavia no hay a quien
    // mandarselo.
    expect(send).not.toHaveBeenCalled();
  });

  it("anuncia la tarea que Query nunca llego a conocer", async () => {
    const { send } = await startWithExistingCrons([existingJob]);

    backfillQuerySchedules("sales", send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        type: "schedule.sync",
        thread_id: "private-42",
        data: expect.objectContaining({
          action: "added",
          external_id: "cron-viejo",
          job: expect.objectContaining({ name: "Resumen semanal" }),
        }),
      }),
    );
  });

  it("no repite el anuncio al reconectar", async () => {
    const { send } = await startWithExistingCrons([existingJob]);

    backfillQuerySchedules("sales", send);
    backfillQuerySchedules("sales", send);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deja la tarea pendiente si la sesion se cae al anunciarla", async () => {
    const failing = vi.fn(() => {
      throw new Error("socket cerrado");
    });
    const { api } = await startWithExistingCrons([existingJob], failing);

    backfillQuerySchedules("sales", failing, api.logger as never);
    expect(api.logger.warn).toHaveBeenCalled();

    // Sigue pendiente: el siguiente `session.ready` vuelve a intentarlo.
    const retry = vi.fn();
    backfillQuerySchedules("sales", retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("solo anuncia lo de la cuenta que acaba de conectarse", async () => {
    const { send } = await startWithExistingCrons([
      existingJob,
      { ...existingJob, id: "cron-otro", delivery: { ...existingJob.delivery, accountId: "soporte" } },
    ]);

    backfillQuerySchedules("sales", send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("sales");
  });

  it("una tarea que cambia sola deja de estar pendiente", async () => {
    const { hooks, send } = await startWithExistingCrons([existingJob]);

    // Su propio `cron_changed` ya la anuncia; el backfill no debe duplicarla.
    hooks.get("cron_changed")?.({
      action: "updated",
      jobId: "cron-viejo",
      job: existingJob,
    });
    expect(send).toHaveBeenCalledTimes(1);

    backfillQuerySchedules("sales", send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignora una tarea sin destino resoluble", async () => {
    const { send } = await startWithExistingCrons([
      { id: "cron-sin-cuenta", delivery: { channel: "query", threadId: "private-9" } },
    ]);

    backfillQuerySchedules("sales", send);
    expect(send).not.toHaveBeenCalled();
  });
});
