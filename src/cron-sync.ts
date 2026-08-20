import type {
  OpenClawPluginApi,
  PluginHookCronChangedEvent,
  PluginHookGatewayCronService,
} from "openclaw/plugin-sdk/plugin-runtime";
import { sendQueryOutboundEvent } from "./socket.js";
import { getDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import { rememberQuerySession } from "./query-session-store.js";
import type { QueryOutboundEvent } from "./types.js";

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
// Tareas que sabemos de Query aunque no podamos rutearlas. Un cron viejo puede
// no traer ``accountId`` -no existia cuando se creo- y aun asi tiene que
// reconocerse como nuestro: es lo que decide si sus herramientas pasan por el
// control de cuentas externas o se las salta.
const queryCronIds = new Set<string>();
let cronService: PluginHookGatewayCronService | undefined;

function explicitQueryAccountId(delivery: CronDelivery): string | undefined {
  const accountId = delivery.accountId?.trim();
  return accountId || undefined;
}

/**
 * Reconoce las tareas de Query que ya existian al arrancar.
 *
 * ``cron_changed`` solo avisa de lo que cambia, asi que un cron creado antes de
 * este arranque -o antes de que existiera este codigo- no estaria en ningun
 * mapa. Sin adoptarlo aqui, su turno no pareceria de Query y sus llamadas a
 * Google se saltarian el control: exactamente el cruce que se quiere evitar,
 * y justo en las tareas mas viejas, que son las que nadie vuelve a mirar.
 *
 * Tambien devuelve la cuenta por la que sincronizar cada tarea, que en una
 * instalacion con varias cuentas de Query es la diferencia entre pedirle la
 * credencial al tenant correcto o al de al lado.
 */
async function adoptExistingQueryCrons(api: OpenClawPluginApi): Promise<void> {
  if (!cronService?.list) return;
  let jobs: Awaited<ReturnType<PluginHookGatewayCronService["list"]>>;
  try {
    jobs = await cronService.list({ includeDisabled: true });
  } catch (error) {
    api.logger.warn(
      `query cron sync no pudo enumerar las tareas existentes: ${String(error)}`,
    );
    return;
  }
  let adopted = 0;
  for (const job of jobs ?? []) {
    const jobId = String((job as { id?: string })?.id ?? "").trim();
    const delivery = (job as { delivery?: CronDelivery })?.delivery;
    if (!jobId || delivery?.channel !== "query") continue;
    queryCronIds.add(jobId);
    adopted += 1;
    const target = delivery.threadId ?? delivery.to;
    const accountId = explicitQueryAccountId(delivery);
    if (!accountId || target === undefined || target === null) continue;
    const threadId = String(target).trim();
    if (threadId) syncedCrons.set(jobId, { accountId, threadId });
  }
  if (adopted) {
    api.logger.info(
      `query cron sync adopto ${adopted} tarea(s) de Query ya registradas.`,
    );
  }
}

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
      queryCronIds.delete(externalId);
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
  const accountId = explicitQueryAccountId(delivery);
  if (!accountId) return undefined;
  return {
    accountId,
    threadId: String(target),
  };
}

/**
 * Consigue la credencial de la tarea antes de que el agente use sus tools.
 *
 * Un cron no tiene turno humano detras, asi que el store esta vacio para ese
 * hilo y cualquier consulta fallaria con ``no_credential``. Se pide aqui, al
 * arrancar el turno, para que todo lo de abajo funcione igual que en una
 * conversacion normal y ninguna tool tenga que saber que la origino un cron.
 */
async function primeScheduleCredential(
  api: OpenClawPluginApi,
  context: {
    jobId?: string;
    channel?: string;
    chatId?: string;
    channelId?: string;
    sessionKey?: string;
  },
): Promise<void> {
  // ``jobId`` solo viene en ejecuciones disparadas por cron; un turno normal ya
  // trae su credencial con el mensaje y no debe tocar nada de esto.
  const externalId = context.jobId?.trim();
  if (!externalId) return;
  if (context.channel && context.channel !== "query") return;
  const threadId = (context.chatId ?? context.channelId ?? "").trim();
  if (!threadId) return;

  const synced = syncedCrons.get(externalId);
  // Que la tarea es de Query hay que poder afirmarlo, no suponerlo: o el
  // contexto lo dice, o la sincronizacion la registro como nuestra. Lo que se
  // apunta aqui es lo que despues deja al guard bloquear un cron sin autor, asi
  // que adoptar de mas seria bloquear crones de otras integraciones.
  const isQueryCron =
    context.channel === "query" || Boolean(synced) || queryCronIds.has(externalId);
  if (isQueryCron) {
    rememberQuerySession(context.sessionKey, {
      threadId,
      jobId: externalId,
      accountId: synced?.accountId,
    });
  }

  // Un reintento dentro de la misma ventana reusa la credencial que ya hay.
  if (getDelegatedAuth(threadId)) return;

  try {
    const { requestQueryScheduleAuth } = await import("./socket.js");
    const granted = await requestQueryScheduleAuth(
      threadId,
      externalId,
      synced?.accountId,
    );
    if (!granted) {
      api.logger.warn(
        `query cron ${externalId}: Query no entrego credencial para el hilo ` +
          `${threadId}. Vuelve a crear la tarea desde una conversacion con la ` +
          `persona en cuyo nombre debe correr.`,
      );
      return;
    }
    rememberDelegatedAuth(threadId, granted.auth, granted.socketUrl);
    // Con credencial en mano la tarea es de Query sin lugar a dudas, aunque el
    // contexto no lo dijera y la sincronizacion se hubiera perdido en un
    // reinicio: Query no la habria firmado si no.
    if (!isQueryCron) {
      rememberQuerySession(context.sessionKey, { threadId, jobId: externalId });
    }
  } catch (error) {
    api.logger.warn(
      `query cron ${externalId}: fallo pidiendo credencial: ${String(error)}`,
    );
  }
}

export function registerQueryCronSync(
  api: OpenClawPluginApi,
  sendEvent: typeof sendQueryOutboundEvent = sendQueryOutboundEvent,
): void {
  api.on("gateway_start", async (_event, context) => {
    cronService = context.getCron?.();
    await adoptExistingQueryCrons(api);
  });
  api.on("gateway_stop", () => {
    cronService = undefined;
    syncedCrons.clear();
    queryCronIds.clear();
  });
  api.on("before_agent_start", async (_event, context) => {
    await primeScheduleCredential(api, context ?? {});
  });
  api.on("cron_changed", (event: PluginHookCronChangedEvent) => {
    if (!["added", "updated", "removed"].includes(event.action)) return;
    const delivery = (
      event.job as
        | (NonNullable<PluginHookCronChangedEvent["job"]> & { delivery?: CronDelivery })
        | undefined
    )?.delivery;
    if (
      delivery?.channel === "query" &&
      !explicitQueryAccountId(delivery) &&
      (delivery.threadId ?? delivery.to) !== undefined
    ) {
      api.logger.warn(
        `query cron ${event.jobId} tiene delivery Query sin accountId; ` +
          `no se sincroniza para evitar enrutarlo por una cuenta equivocada.`,
      );
    }
    const target = targetFrom(event);
    if (!target) return;

    // Query no acepta que le digamos de quien es la tarea: hay que probarlo con
    // la credencial del turno en que se pidio. Aqui todavia existe, porque
    // ``cron_changed`` se dispara mientras esa conversacion sigue viva. Si no
    // esta, la tarea se registra igual pero sin identidad y no podra consultar.
    const stored = getDelegatedAuth(target.threadId);
    if (!stored) {
      api.logger.warn(
        `query cron ${event.jobId} se registro sin credencial: no podra ` +
          `consultar Query hasta que se vuelva a crear desde una conversacion.`,
      );
    }

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
        ...(stored ? { delegated_token: stored.auth.token } : {}),
      },
    };
    try {
      sendEvent(target.accountId, outbound);
      if (event.action === "removed") {
        syncedCrons.delete(event.jobId);
        queryCronIds.delete(event.jobId);
      } else {
        syncedCrons.set(event.jobId, target);
        queryCronIds.add(event.jobId);
      }
    } catch (error) {
      api.logger.warn(
        `query cron sync failed for ${event.jobId}: ${String(error)}`,
      );
    }
  });
}
