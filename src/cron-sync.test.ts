import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  backfillQuerySchedules,
  cancelQuerySchedules,
  probeQuerySchedule,
  registerQueryCronSync,
} from "./cron-sync.js";
import { forgetDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import { setOpenClawConfigLoader } from "./google-accounts.js";

type Hook = (...args: any[]) => unknown;

const stateDirectory = mkdtempSync(join(tmpdir(), "query-cron-sync-"));
const previousStateFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;

beforeAll(() => {
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(
    stateDirectory,
    "delegated.json",
  );
});

afterAll(() => {
  if (previousStateFile === undefined) {
    delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  } else {
    process.env.QUERY_DELEGATED_AUTH_STATE_FILE = previousStateFile;
  }
  rmSync(stateDirectory, { recursive: true, force: true });
});

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
  it("syncs add/remove with the account and thread that own the delivery", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);

    await hooks.get("cron_changed")?.({
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

    await hooks.get("cron_changed")?.({
      action: "updated",
      jobId: "cron-sales-1",
      job: {
        delivery: {
          channel: "query",
          accountId: "sales",
          threadId: "private-43",
        },
      },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("sales", expect.objectContaining({
      thread_id: "private-43",
      data: expect.objectContaining({ action: "updated", authorization_version: 2 }),
    }));

    await hooks.get("cron_changed")?.({
      action: "removed",
      jobId: "cron-sales-1",
    });
    expect(send).toHaveBeenLastCalledWith(
      "sales",
      expect.objectContaining({
        thread_id: "private-43",
        data: expect.objectContaining({ action: "removed" }),
      }),
    );
  });

  it("refuses to sync Query cron delivery without an explicit accountId", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);

    await hooks.get("cron_changed")?.({
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

  it("removes the old Query target when delivery moves to another channel", async () => {
    const { api, hooks } = fakeApi();
    const send = vi.fn();
    registerQueryCronSync(api as never, send);
    await hooks.get("cron_changed")?.({
      action: "added",
      jobId: "cron-leaves-query",
      job: {
        delivery: { channel: "query", accountId: "sales", threadId: "42" },
      },
    });
    send.mockClear();

    await hooks.get("cron_changed")?.({
      action: "updated",
      jobId: "cron-leaves-query",
      job: { delivery: { channel: "discord", to: "alerts" } },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({
        thread_id: "42",
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

  it("no atribuye un cron histórico a la credencial casualmente viva del canal", async () => {
    const { send } = await startWithExistingCrons([existingJob]);
    rememberDelegatedAuth(
      "private-42",
      { token: "turno-posterior", identity: { id: 99 } },
      "wss://query.example/ws",
      "mensaje-posterior",
    );

    backfillQuerySchedules("sales", send);

    expect(send.mock.calls[0][1].data).toMatchObject({
      sync_source: "startup_adoption",
    });
    expect(send.mock.calls[0][1].data).not.toHaveProperty("delegated_token");
    expect(send.mock.calls[0][1].data).not.toHaveProperty("origin_client_msg_id");
    forgetDelegatedAuth("private-42");
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
    await hooks.get("cron_changed")?.({
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

describe("prueba no destructiva de cron", () => {
  it("valida cron, destino y Google configurado sin ejecutarlo", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("gateway_start")?.(
      {},
      {
        getCron: () => ({
          list: async () => [
            {
              id: "cron-google",
              delivery: {
                channel: "query",
                accountId: "sales",
                threadId: "42",
              },
            },
          ],
        }),
      },
    );
    setOpenClawConfigLoader(() => ({
      plugins: {
        entries: {
          "openclaw-google-workspace": {
            config: {
              accounts: { juli: { expectedEmail: "juli@example.com" } },
            },
          },
        },
      },
    }));

    const result = await probeQuerySchedule({
      externalId: "cron-google",
      threadId: "42",
      queryAccountId: "sales",
      googleAccountId: "juli",
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toMatchObject({
      cron_exists: true,
      query_delivery: true,
      delivery_target: true,
      gmail_available: true,
      drive_available: true,
    });
    setOpenClawConfigLoader(undefined);
    hooks.get("gateway_stop")?.();
  });

  it("no exige Google cuando el cron no lo declara", async () => {
    const { api, hooks } = fakeApi();
    registerQueryCronSync(api as never, vi.fn());
    await hooks.get("gateway_start")?.(
      {},
      {
        getCron: () => ({
          list: async () => [
            {
              id: "cron-query",
              delivery: { channel: "query", accountId: "sales", to: "42" },
            },
          ],
        }),
      },
    );

    const result = await probeQuerySchedule({
      externalId: "cron-query",
      threadId: "42",
      queryAccountId: "sales",
    });

    expect(result.ok).toBe(true);
    expect(result.checks.google_not_required).toBe(true);
    hooks.get("gateway_stop")?.();
  });
});
