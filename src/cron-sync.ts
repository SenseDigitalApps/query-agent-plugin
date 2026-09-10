import type {
  OpenClawPluginApi,
  PluginHookCronChangedEvent,
  PluginHookGatewayCronJob,
  PluginHookGatewayCronService,
} from "openclaw/plugin-sdk/plugin-runtime";
import { Type } from "typebox";
import {
  queryAccountIdForSocketUrl,
  requestQueryScheduleAuth,
  confirmQueryScheduleSync,
  sendQueryOutboundEvent,
} from "./socket.js";
import {
  forgetDelegatedAuth,
  getDelegatedAuth,
  rememberDelegatedAuth,
} from "./delegated-store.js";
import {
  getQuerySession,
  rememberQuerySession,
} from "./query-session-store.js";
import { inspectGoogleWorkspaceConfiguration } from "./google-accounts.js";
import {
  externalContextForRun,
  externalContextForSessionSender,
  type ExternalContext,
} from "./external-context.js";
import { queryApiUrl } from "./query-api.js";
import type { QueryOutboundEvent } from "./types.js";

type CronDelivery = {
  mode?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
};

type QueryCronJob = PluginHookGatewayCronJob & {
  delivery?: CronDelivery;
  payload?: {
    kind?: string;
    message?: string;
    text?: string;
    timeoutSeconds?: number;
    toolsAllow?: string[];
  };
};

const CronScheduleSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("cron"),
    expr: Type.String({ minLength: 1 }),
    tz: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("at"),
    at: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("every"),
    everyMs: Type.Number({ minimum: 1 }),
    anchorMs: Type.Optional(Type.Number()),
  }, { additionalProperties: false }),
]);

const QueryCronDeliverySchema = Type.Object({
  mode: Type.Optional(Type.Literal("announce")),
  channel: Type.Literal("query"),
  to: Type.String({ minLength: 1 }),
  accountId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const QueryCronPayloadSchema = Type.Object({
  kind: Type.Literal("agentTurn"),
  message: Type.String({ minLength: 1 }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  toolsAllow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

const QueryCronCreateSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  schedule: CronScheduleSchema,
  payload: QueryCronPayloadSchema,
  delivery: QueryCronDeliverySchema,
  wakeMode: Type.Optional(Type.Union([
    Type.Literal("now"),
    Type.Literal("next-heartbeat"),
  ])),
}, { additionalProperties: false });

const QueryCronPatchSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  schedule: Type.Optional(CronScheduleSchema),
  payload: Type.Optional(QueryCronPayloadSchema),
  delivery: Type.Optional(QueryCronDeliverySchema),
  wakeMode: Type.Optional(Type.Union([
    Type.Literal("now"),
    Type.Literal("next-heartbeat"),
  ])),
}, { additionalProperties: false });

type SyncedCron = {
  accountId: string;
  threadId: string;
};

type PendingCronMutation = {
  toolCallId?: string;
  action: "added" | "updated" | "removed";
  jobId?: string;
  originThreadId: string;
  originAccountId?: string;
  requestedTarget?: SyncedCron;
  delegatedToken?: string;
  originClientMsgId?: string;
  creatorUserId?: number;
  runAsUserId?: number;
  capturedAt: number;
};

const syncedCrons = new Map<string, SyncedCron>();
/**
 * Crones que existian antes de arrancar y que Query todavia no conoce.
 *
 * ``cron_changed`` solo avisa de lo que cambia, asi que una tarea creada antes
 * de que existiera esta sincronizacion -o mientras Query estaba caido- no se
 * anuncia sola nunca mas. Se guardan aqui con su job entero y se sueltan
 * cuando la sesion de Query queda lista, que es el primer momento en que hay
 * alguien al otro lado escuchando.
 */
const pendingBackfill = new Map<
  string,
  { target: SyncedCron; job: PluginHookGatewayCronJob }
>();
// Tareas que sabemos de Query aunque no podamos rutearlas. Un cron viejo puede
// no traer ``accountId`` -no existia cuando se creo- y aun asi tiene que
// reconocerse como nuestro: es lo que decide si sus herramientas pasan por el
// control de cuentas externas o se las salta.
const queryCronIds = new Set<string>();
// Runtime receipts omit summaries. Keep the structured completion evidence,
// scoped by account and cron, without storing message contents or credentials.
const cronCompletions = new Map<string, {
  runAtMs: number; status?: string; authorizationFailed: boolean;
}>();
const cronCompletionKey = (accountId: string, jobId: string) => JSON.stringify([accountId, jobId]);
type QueryCronService = PluginHookGatewayCronService & {
  run?: (id: string, mode: "force" | "due") => Promise<unknown>;
};

let cronService: QueryCronService | undefined;
const pendingCronMutations: PendingCronMutation[] = [];
const PENDING_MUTATION_TTL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function prunePendingMutations(now = Date.now()): void {
  while (
    pendingCronMutations.length &&
    now - pendingCronMutations[0].capturedAt > PENDING_MUTATION_TTL_MS
  ) {
    pendingCronMutations.shift();
  }
}

function mutationAction(value: unknown): PendingCronMutation["action"] | undefined {
  if (value === "add") return "added";
  if (value === "update") return "updated";
  if (value === "remove") return "removed";
  return undefined;
}

function deliveryFromCronParams(
  params: Record<string, unknown>,
  action: PendingCronMutation["action"],
): CronDelivery | undefined {
  const container = action === "added" ? params.job : params.patch;
  if (!isRecord(container) || !isRecord(container.delivery)) return undefined;
  return container.delivery as CronDelivery;
}

function targetFromDelivery(
  delivery: CronDelivery | undefined,
): SyncedCron | undefined {
  if (!delivery || (delivery.channel && delivery.channel !== "query")) return undefined;
  const threadId = trimmed(delivery.threadId ?? delivery.to);
  const accountId = explicitQueryAccountId(delivery);
  if (!threadId || !accountId) return undefined;
  return { threadId, accountId };
}

function captureCronMutation(
  event: { toolName: string; params: Record<string, unknown>; toolCallId?: string },
  context: { sessionKey?: string; toolCallId?: string },
  pinned?: Awaited<ReturnType<typeof externalContextForRun>>,
): void {
  if (event.toolName.trim().toLowerCase() !== "cron") return;
  const action = mutationAction(event.params.action);
  if (!action) return;
  const session = getQuerySession(context.sessionKey);
  if (!session?.threadId || session.jobId) return;

  const stored = pinned ?? getDelegatedAuth(session.threadId);
  const accountId =
    pinned?.queryAccountId ??
    session.accountId ??
    (stored?.socketUrl ? queryAccountIdForSocketUrl(stored.socketUrl) : undefined);
  const delivery = deliveryFromCronParams(event.params, action);
  if (action === "added" && delivery?.channel && delivery.channel !== "query") {
    return;
  }
  const requestedTarget = targetFromDelivery(delivery);

  prunePendingMutations();
  pendingCronMutations.push({
    toolCallId: context.toolCallId ?? event.toolCallId,
    action,
    jobId: trimmed(event.params.jobId ?? event.params.id),
    originThreadId: pinned?.threadId ?? session.threadId,
    originAccountId: accountId,
    requestedTarget,
    delegatedToken: stored?.auth.token,
    originClientMsgId: stored?.clientMsgId,
    creatorUserId: stored?.auth.identity?.id,
    runAsUserId: (stored?.auth.external_account_identity ?? stored?.auth.identity)?.id,
    capturedAt: Date.now(),
  });
}

function takePendingMutation(
  event: PluginHookCronChangedEvent,
  target?: SyncedCron,
): PendingCronMutation | undefined {
  prunePendingMutations();
  let index = pendingCronMutations.findIndex(
    (candidate) =>
      candidate.action === event.action &&
      !candidate.toolCallId &&
      Boolean(candidate.jobId) &&
      candidate.jobId === event.jobId,
  );
  if (index < 0 && event.action === "added") {
    index = pendingCronMutations.findIndex(
      (candidate) =>
        candidate.action === "added" &&
        !candidate.toolCallId &&
        (!candidate.requestedTarget ||
          !target ||
          (candidate.requestedTarget.accountId === target.accountId &&
            candidate.requestedTarget.threadId === target.threadId)),
    );
  }
  if (index < 0) return undefined;
  // Older hosts lack a call id. Ambiguity must never assign the next actor.
  if (pendingCronMutations.filter((item) => !item.toolCallId && item.action === event.action).length !== 1) return undefined;
  return pendingCronMutations.splice(index, 1)[0];
}

function explicitQueryAccountId(delivery: CronDelivery): string | undefined {
  const accountId = delivery.accountId?.trim();
  return accountId || undefined;
}

function bareThreadId(value: string): string {
  return value.trim().replace(/^(?:direct|channel):/, "");
}

async function assertAuthorizedCronDestination(
  actor: ExternalContext,
  delivery: CronDelivery,
): Promise<void> {
  const accountId = explicitQueryAccountId(delivery);
  if (!accountId || accountId !== actor.queryAccountId) {
    throw new Error("query_cron_cross_tenant_destination");
  }
  const requested = trimmed(delivery.threadId ?? delivery.to);
  if (!requested) throw new Error("query_cron_destination_required");
  const response = await fetch(
    queryApiUrl(
      actor.socketUrl,
      `threads/${encodeURIComponent(actor.threadId)}/delivery-targets/`,
    ),
    {
      method: "POST",
      headers: {
        "X-Query-Delegated-Token": actor.auth.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const payload = await response.json().catch(() => undefined) as
    | { targets?: Array<{ thread_id?: string | number }> ; error?: string }
    | undefined;
  if (!response.ok) {
    throw new Error(payload?.error || `query_delivery_targets_http_${response.status}`);
  }
  const allowed = new Set(
    (payload?.targets ?? [])
      .map((item) => trimmed(item.thread_id))
      .filter((item): item is string => Boolean(item))
      .map(bareThreadId),
  );
  if (!allowed.has(bareThreadId(requested))) {
    throw new Error("query_cron_destination_not_authorized");
  }
}

function cronJobId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = trimmed(value.id ?? value.jobId);
  if (direct) return direct;
  return isRecord(value.job) ? trimmed(value.job.id ?? value.job.jobId) : undefined;
}

function isManageableQueryCron(
  job: QueryCronJob,
  actor: ExternalContext,
  agentId: string | undefined,
): boolean {
  return (
    job.delivery?.channel === "query" &&
    explicitQueryAccountId(job.delivery) === actor.queryAccountId &&
    (!agentId || job.agentId === agentId)
  );
}

function publicCronSummary(
  job: QueryCronJob,
  detailed = true,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    job_id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    agent_id: job.agentId,
    session_target: job.sessionTarget,
    schedule: job.schedule,
    delivery: job.delivery && {
      channel: job.delivery.channel,
      account_id: job.delivery.accountId,
      to: job.delivery.threadId ?? job.delivery.to,
    },
  };
  if (detailed) {
    summary.payload = job.payload && {
      kind: job.payload.kind,
      message: job.payload.message,
      timeout_seconds: job.payload.timeoutSeconds,
    };
    summary.state = job.state;
  }
  return summary;
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
    if (!threadId) continue;
    const resolved = { accountId, threadId };
    syncedCrons.set(jobId, resolved);
    pendingBackfill.set(jobId, {
      target: resolved,
      job: job as PluginHookGatewayCronJob,
    });
  }
  if (adopted) {
    api.logger.info(
      `query cron sync adopto ${adopted} tarea(s) de Query ya registradas.`,
    );
  }
}

/**
 * Anuncia a Query los crones que ya existian cuando arranco el gateway.
 *
 * Lo llama el socket al quedar lista la sesion: antes de eso no hay a quien
 * mandarselo. Cada tarea se suelta una sola vez por proceso -se borra del mapa
 * al conseguirlo-, asi que reconectar no repite el anuncio.
 *
 * La adopción nunca reutiliza la credencial corta que casualmente esté viva en
 * el canal: esa credencial puede pertenecer a una conversación posterior y no
 * prueba quién creó el cron histórico. Query lo registra para que su migración
 * administrativa resuelva la identidad con evidencia durable.
 */
export function backfillQuerySchedules(
  accountId: string,
  sendEvent: typeof sendQueryOutboundEvent = sendQueryOutboundEvent,
  log?: { info?: (message: string) => void; warn?: (message: string) => void },
): void {
  if (!pendingBackfill.size) return;
  let announced = 0;
  for (const [jobId, entry] of [...pendingBackfill]) {
    if (entry.target.accountId !== accountId) continue;
    const outbound: QueryOutboundEvent = {
      type: "schedule.sync",
      role: "system",
      content: "",
      client_msg_id: "",
      thread_id: entry.target.threadId,
      data: {
        action: "added",
        external_id: jobId,
        job: entry.job,
        sync_source: "startup_adoption",
        authorization_version: 2,
        query_account_id: accountId,
      },
    };
    try {
      sendEvent(accountId, outbound);
      pendingBackfill.delete(jobId);
      announced += 1;
    } catch (error) {
      // La sesion se cayo entre medias: se deja pendiente para el proximo
      // ``session.ready`` en vez de darlo por anunciado.
      log?.warn?.(
        `query cron backfill fallo para ${jobId}: ${String(error)}`,
      );
    }
  }
  if (announced) {
    log?.info?.(
      `query cron backfill anuncio ${announced} tarea(s) preexistente(s).`,
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

export async function probeQuerySchedule(params: {
  externalId: string;
  threadId: string;
  queryAccountId: string;
  googleAccountId?: string;
}): Promise<{ ok: boolean; checks: Record<string, boolean>; detail: string }> {
  let jobs: Awaited<ReturnType<PluginHookGatewayCronService["list"]>> = [];
  try {
    jobs = (await cronService?.list?.({ includeDisabled: true })) ?? [];
  } catch {
    return {
      ok: false,
      checks: { cron_inventory: false },
      detail: "OpenClaw no pudo leer su inventario de tareas.",
    };
  }
  const job = (jobs ?? []).find(
    (candidate) => String((candidate as { id?: string }).id ?? "") === params.externalId,
  ) as (PluginHookGatewayCronJob & { delivery?: CronDelivery }) | undefined;
  const delivery = job?.delivery;
  const target = delivery?.threadId ?? delivery?.to;
  const checks: Record<string, boolean> = {
    cron_exists: Boolean(job),
    query_delivery: delivery?.channel === "query",
    query_account: explicitQueryAccountId(delivery ?? {}) === params.queryAccountId,
    delivery_target: String(target ?? "").trim().replace(/^(direct|channel):/, "") === params.threadId.replace(/^(direct|channel):/, ""),
  };
  const googleAccountId = params.googleAccountId?.trim();
  if (googleAccountId) {
    const google = await inspectGoogleWorkspaceConfiguration(googleAccountId);
    checks.google_plugin = google.pluginConfigured;
    checks.google_account = google.accountConfigured;
    // Gmail y Drive pertenecen al mismo plugin; este chequeo confirma que las
    // tools pueden cargarse para la cuenta, sin ejecutar ninguna de ellas.
    checks.gmail_available = google.pluginConfigured && google.accountConfigured;
    checks.drive_available = google.pluginConfigured && google.accountConfigured;
  } else {
    checks.google_not_required = true;
  }
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    checks,
    detail: ok
      ? "La tarea, su destino y sus integraciones requeridas están configurados."
      : "La prueba encontró una configuración incompleta; no se ejecutó el cron.",
  };
}

async function currentCronJob(
  api: OpenClawPluginApi,
  event: PluginHookCronChangedEvent,
): Promise<(PluginHookGatewayCronJob & { delivery?: CronDelivery }) | undefined> {
  const announced = event.job as
    | (PluginHookGatewayCronJob & { delivery?: CronDelivery })
    | undefined;
  if (announced?.delivery || event.action === "removed") return announced;
  try {
    const jobs = (await cronService?.list?.({ includeDisabled: true })) ?? [];
    return jobs.find(
      (candidate) => String((candidate as { id?: string }).id ?? "") === event.jobId,
    ) as (PluginHookGatewayCronJob & { delivery?: CronDelivery }) | undefined;
  } catch (error) {
    api.logger.warn(
      `query cron ${event.jobId}: no se pudo resolver el delivery real: ${String(error)}`,
    );
    return announced;
  }
}

function sameTarget(left: SyncedCron | undefined, right: SyncedCron | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.accountId === right.accountId &&
      left.threadId === right.threadId,
  );
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
): Promise<"not_query" | "authorized" | "blocked"> {
  // ``jobId`` solo viene en ejecuciones disparadas por cron; un turno normal ya
  // trae su credencial con el mensaje y no debe tocar nada de esto.
  const externalId = context.jobId?.trim();
  if (!externalId) return "not_query";
  const synced = syncedCrons.get(externalId);
  // Que la tarea es de Query hay que poder afirmarlo, no suponerlo: o el
  // contexto lo dice, o la sincronizacion la registro como nuestra. Lo que se
  // apunta aqui es lo que despues deja al guard bloquear un cron sin autor, asi
  // que adoptar de mas seria bloquear crones de otras integraciones.
  const isQueryCron =
    context.channel === "query" || Boolean(synced) || queryCronIds.has(externalId);
  if (!isQueryCron) return "not_query";
  const contextualThreadId = (context.chatId ?? context.channelId ?? "").trim();
  const threadId = synced?.threadId ?? contextualThreadId;
  if (!threadId) return "blocked";
  if (synced?.threadId && contextualThreadId && synced.threadId !== contextualThreadId) {
    api.logger.warn(
      `query cron ${externalId}: OpenClaw inicio el turno en ${contextualThreadId}, ` +
        `pero el destino canonico es ${synced.threadId}; se usa el destino canonico.`,
    );
  }
  if (isQueryCron) {
    rememberQuerySession(context.sessionKey, {
      threadId,
      jobId: externalId,
      accountId: synced?.accountId,
      authKey: `schedule:${JSON.stringify([synced?.accountId, externalId, context.sessionKey])}`,
      deliveryThreadId: threadId,
    });
  }

  // Nunca reutilices la credencial humana que casualmente este viva en el
  // destino. Una ejecucion programada solo puede correr con la credencial que
  // Query emite para ese cron y su autorizacion durable.
  const authKey = getQuerySession(context.sessionKey)?.authKey;
  if (!authKey || !synced?.accountId) {
    api.logger.warn(`query cron ${externalId}: query_schedule_authorization_missing (cuenta o sesión aislada ausente).`);
    return "blocked";
  }
  forgetDelegatedAuth(authKey);
  try {
    const { requestQueryScheduleAuth } = await import("./socket.js");
    const granted = await requestQueryScheduleAuth(
      threadId,
      externalId,
      synced?.accountId,
    );
    if (!granted) {
      api.logger.warn(
        `query cron ${externalId}: Query no entrego credencial de ejecución; ` +
          `la autorizacion programada no esta vigente. Resincroniza el mismo ID desde su creador.`,
      );
      return "blocked";
    }
    if (granted.auth.source !== "schedule") {
      api.logger.warn(`query cron ${externalId}: Query devolvió una credencial no programada.`);
      return "blocked";
    }
    rememberDelegatedAuth(authKey, granted.auth, granted.socketUrl);
    rememberQuerySession(context.sessionKey, {
      threadId: granted.auth.thread_id ?? threadId,
      deliveryThreadId: threadId,
      jobId: externalId, accountId: synced.accountId, authKey,
    });
    api.logger.info(`query cron ${externalId}: Ejecuta como ${granted.auth.identity?.username ?? "usuario autorizado"}; ` +
      `Creado desde ${granted.auth.origin_context ?? "origen histórico sin confirmar"}; Entrega en ${threadId}; autorización programada vigente.`);
    // Con credencial en mano la tarea es de Query sin lugar a dudas, aunque el
    // contexto no lo dijera y la sincronizacion se hubiera perdido en un
    // reinicio: Query no la habria firmado si no.
    if (!isQueryCron) {
      rememberQuerySession(context.sessionKey, { threadId, jobId: externalId });
    }
    return "authorized";
  } catch (error) {
    api.logger.warn(
      `query cron ${externalId}: fallo pidiendo credencial: ${String(error)}`,
    );
    return "blocked";
  }
}

export function registerQueryCronSync(
  api: OpenClawPluginApi,
  sendEvent: typeof sendQueryOutboundEvent = sendQueryOutboundEvent,
): void {
  const confirmAuthorization = async (jobId: string, delivery: CronDelivery, expectedRunAs?: number) => {
    const target = targetFromDelivery(delivery);
    if (!target) throw new Error("query_schedule_authorization_unconfirmed");
    const granted = await requestQueryScheduleAuth(target.threadId, jobId, target.accountId);
    if (!granted?.auth.token || granted.auth.source !== "schedule" ||
        granted.auth.external_id !== jobId || !granted.auth.identity?.id) {
      throw new Error("query_schedule_authorization_missing");
    }
    if (expectedRunAs !== undefined && granted.auth.identity.id !== expectedRunAs) {
      throw new Error("query_schedule_authorization_identity_mismatch");
    }
    // This short-lived credential is deliberately not put in any human session store.
    return { authorized: true, run_as_user_id: granted.auth.identity.id };
  };
  api.on("gateway_start", async (_event, context) => {
    cronService = context.getCron?.();
    await adoptExistingQueryCrons(api);
  });
  api.on("gateway_stop", () => {
    cronService = undefined;
    syncedCrons.clear();
    queryCronIds.clear();
    cronCompletions.clear();
    pendingBackfill.clear();
    pendingCronMutations.length = 0;
  });
  api.on("before_agent_start", async (_event, context) => {
    await primeScheduleCredential(api, context ?? {});
  });
  api.on("before_agent_run", async (_event, context) => {
    // A preparation hook cannot stop inference. This gate returns a native
    // hook_block error, which OpenClaw propagates to the cron result and store.
    const outcome = await primeScheduleCredential(api, context ?? {});
    if (outcome === "not_query") return { outcome: "pass" };
    const session = getQuerySession(context?.sessionKey);
    const credential = session?.authKey ? getDelegatedAuth(session.authKey) : undefined;
    if (outcome === "authorized" && credential?.auth.source === "schedule" &&
        credential.auth.external_id === context?.jobId && credential.auth.identity?.id) {
      return { outcome: "pass" };
    }
    if (session?.authKey) forgetDelegatedAuth(session.authKey);
    return {
      outcome: "block",
      reason: "query_schedule_authorization_missing",
      category: "query_schedule_authorization_missing",
      message: "query_schedule_authorization_missing: la tarea no tiene una credencial de ejecución vigente. " +
        "No se inició el modelo ni se ejecutó el trabajo. Revisa la autorización persistida del mismo cron en Query.",
    };
  });
  api.on("before_tool_call", async (event, context) => {
    const session = getQuerySession(context?.sessionKey);
    if (session && event.toolName === "exec" &&
        /\bopenclaw\s+cron\s+(add|edit)\b/i.test(String(event.params?.command ?? ""))) {
      return { block: true, blockReason: "Para crones Query autenticados usa la herramienta nativa cron en modo isolated; la CLI no captura la autorización del creador." };
    }
    if (event.toolName !== "cron" || !mutationAction(event.params.action)) return;
    let pinned;
    const runId = context?.runId ?? event.runId;
    if (runId && session && !session.jobId) {
      try { pinned = await externalContextForRun(runId); }
      catch { return { block: true, blockReason: "No se pudo renovar la autorización del turno creador de este cron." }; }
      if (!pinned) return { block: true, blockReason: "Falta el contexto autorizado del turno creador. Reintenta desde su conversación Query." };
    }
    captureCronMutation(
      {
        toolName: String(event.toolName ?? ""),
        params: isRecord(event.params) ? event.params : {},
        toolCallId: event.toolCallId,
      },
      context ?? {},
      pinned,
    );
    if (session && !session.jobId && event.toolName === "cron" &&
        ["add", "update"].includes(String(event.params.action))) {
      const key = event.params.action === "add" ? "job" : "patch";
      const patch = isRecord(event.params[key]) ? event.params[key] : {};
      const delivery = isRecord(patch.delivery) ? patch.delivery : undefined;
      const isQueryMutation = delivery?.channel === "query" ||
        (!delivery?.channel && (event.params.action === "add" ||
          queryCronIds.has(String(event.params.jobId ?? event.params.id ?? ""))));
      if (isQueryMutation) {
        if (delivery?.accountId && session.accountId && delivery.accountId !== session.accountId) {
          return { block: true, blockReason: "El destino Query debe pertenecer al tenant autorizado del creador." };
        }
        const isolated = { ...patch, sessionTarget: "isolated", sessionKey: null };
        return { params: { ...event.params, [key]: isolated } };
      }
    }
  });
  const syncChanged = async (event: PluginHookCronChangedEvent, provenMutation?: PendingCronMutation, requireConfirmation = false) => {
    if (!["added", "updated", "removed"].includes(event.action)) return;
    const previous = syncedCrons.get(event.jobId);
    const job = await currentCronJob(api, event);
    const delivery = job?.delivery;
    const resolvedTarget = targetFromDelivery(delivery);
    const mutation = provenMutation ?? takePendingMutation(event, resolvedTarget);
    const target =
      event.action === "removed" ||
      (delivery?.channel !== undefined && delivery.channel !== "query")
        ? undefined
        : resolvedTarget ?? mutation?.requestedTarget ?? previous;
    if (
      delivery?.channel === "query" &&
      !explicitQueryAccountId(delivery) &&
      (delivery.threadId ?? delivery.to) !== undefined &&
      !mutation?.requestedTarget
    ) {
      api.logger.warn(
        `query cron ${event.jobId} tiene delivery Query sin accountId; ` +
          `no se sincroniza para evitar enrutarlo por una cuenta equivocada.`,
      );
    }
    if (!target && !previous) return;
    if (mutation?.originAccountId && target && mutation.originAccountId !== target.accountId) {
      api.logger.warn(`query cron ${event.jobId}: se rechazó una sincronización entre tenants.`);
      return;
    }
    if (event.action === "added" && !mutation?.delegatedToken) {
      api.logger.warn(
        `query cron ${event.jobId} se registro sin evidencia del turno creador; ` +
          `Query debera resolver su autor mediante migracion administrativa.`,
      );
    }

    const publish = async (destination: SyncedCron, action: "added" | "updated" | "removed") => {
      const outbound: QueryOutboundEvent = {
        type: "schedule.sync",
        role: "system",
        content: "",
        client_msg_id: "",
        thread_id: destination.threadId,
        data: {
          action,
          external_id: event.jobId,
          job: job ?? event.job ?? null,
          sync_source: "live_hook",
          authorization_version: 2,
          request_ack: requireConfirmation,
          query_account_id: destination.accountId,
          delivery: job?.delivery ?? null,
          ...(mutation?.creatorUserId ? { creator_user_id: mutation.creatorUserId } : {}),
          ...(mutation?.runAsUserId ? { run_as_user_id: mutation.runAsUserId } : {}),
          ...(mutation?.originThreadId
            ? { origin_thread_id: mutation.originThreadId }
            : {}),
          ...(mutation?.originClientMsgId
            ? { origin_client_msg_id: mutation.originClientMsgId }
            : {}),
          ...(mutation?.delegatedToken
            ? { delegated_token: mutation.delegatedToken }
            : {}),
        },
      };
      if (requireConfirmation && action !== "removed") {
        const ack = await confirmQueryScheduleSync(destination.accountId, outbound);
        if (!ack) throw new Error("query_schedule_authorization_unconfirmed");
        if (!ack.authorized) throw Object.assign(new Error("query_schedule_authorization_rejected"), {
          authorizationReason: ack.error && /^[a-z_]{1,80}$/.test(ack.error) ? ack.error : undefined,
        });
        if (ack.run_as_user_id !== mutation?.runAsUserId) {
          throw new Error("query_schedule_authorization_identity_mismatch");
        }
      } else sendEvent(destination.accountId, outbound);
    };

    try {
      if (previous && (event.action === "removed" || !target || previous.accountId !== target.accountId)) {
        await publish(previous, "removed");
      }
      if (target && event.action !== "removed") {
        await publish(target, event.action === "updated" || previous ? "updated" : "added");
      }
      pendingBackfill.delete(event.jobId);
      if (!target || event.action === "removed") {
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
      if (requireConfirmation) throw error;
    }
  };

  if (typeof api.registerTool === "function") api.registerTool((ctx) => {
    if (ctx.messageChannel !== "query" || ctx.sandboxed || ctx.oneShotCliRun) {
      return null;
    }
    return {
      name: "query_cron_manage",
      label: "Query: programar tarea",
      description:
        "Lista, consulta, crea, actualiza o ejecuta un cron Query desde el turno autorizado del creador. " +
        "Mantiene la ejecución aislada, valida el destino y sincroniza run_as " +
        "sin depender de que el canal de entrega sea el canal privado.",
      parameters: Type.Union([
        Type.Object({
          action: Type.Literal("list"),
          include_disabled: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("get"),
          job_id: Type.String({ minLength: 1 }),
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("add"),
          job: QueryCronCreateSchema,
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("update"),
          job_id: Type.String({ minLength: 1 }),
          patch: QueryCronPatchSchema,
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("update_many"),
          jobs: Type.Array(Type.Object({
            job_id: Type.String({ minLength: 1 }),
            patch: QueryCronPatchSchema,
          }, { additionalProperties: false }), { minItems: 1, maxItems: 25 }),
        }, { additionalProperties: false }),
        Type.Object({
          action: Type.Literal("run"),
          job_id: Type.String({ minLength: 1 }),
        }, { additionalProperties: false }),
      ]),
      execute: async (_toolCallId, rawParams) => {
        if (!cronService) {
          const result = {
            ok: false,
            error: "query_cron_service_unavailable",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        }
        const params = rawParams as
          | { action: "list"; include_disabled?: boolean }
          | { action: "get"; job_id: string }
          | { action: "add"; job: Record<string, unknown> & { delivery: CronDelivery } }
          | { action: "update"; job_id: string; patch: Record<string, unknown> & { delivery?: CronDelivery } }
          | { action: "update_many"; jobs: Array<{ job_id: string; patch: Record<string, unknown> & { delivery?: CronDelivery } }> }
          | { action: "run"; job_id: string };
        const session = getQuerySession(ctx.sessionKey);
        const accountId = ctx.agentAccountId ?? session?.accountId;
        let actor: ExternalContext | undefined;
        try {
          actor = await externalContextForSessionSender(
            ctx.sessionKey,
            ctx.requesterSenderId,
            accountId,
          );
        } catch {
          actor = undefined;
        }
        if (!actor || session?.jobId) {
          const result = {
            ok: false,
            error: "query_cron_creator_authorization_missing",
            detail: "Reintenta desde un mensaje reciente del creador en Query.",
          };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }

        const persistedJobIds: string[] = [];
        let createdJobId: string | undefined;
        let activationAttempted = false;
        try {
          const jobs = (await cronService.list({ includeDisabled: true })) as QueryCronJob[];
          const manageable = jobs.filter((job) =>
            isManageableQueryCron(job, actor, ctx.agentId)
          );

          if (params.action === "list") {
            const visible = params.include_disabled === false
              ? manageable.filter((job) => job.enabled !== false)
              : manageable;
            const publicResult = {
              ok: true,
              count: visible.length,
              jobs: visible.map((job) => publicCronSummary(job, false)),
            };
            return { content: [{ type: "text", text: JSON.stringify(publicResult) }], details: publicResult };
          }

          if (params.action === "get") {
            const jobId = params.job_id.trim();
            const current = manageable.find((job) => job.id === jobId);
            if (!current) {
              if (jobs.some((job) => job.id === jobId)) throw new Error("query_cron_not_query_owned");
              throw new Error("query_cron_not_found");
            }
            const publicResult = { ok: true, job: publicCronSummary(current) };
            return { content: [{ type: "text", text: JSON.stringify(publicResult) }], details: publicResult };
          }

          if (params.action === "run") {
            const jobId = params.job_id.trim();
            const current = manageable.find((job) => job.id === jobId);
            if (!current) {
              if (jobs.some((job) => job.id === jobId)) throw new Error("query_cron_not_query_owned");
              throw new Error("query_cron_not_found");
            }
            if (current.sessionTarget !== "isolated") {
              throw new Error("query_cron_run_requires_isolated");
            }
            if (typeof cronService.run !== "function") {
              throw new Error("query_cron_run_unavailable");
            }
            const effectiveDelivery = current.delivery as CronDelivery;
            await assertAuthorizedCronDestination(actor, effectiveDelivery);
            const mutation: PendingCronMutation = {
              action: "updated",
              jobId,
              originThreadId: actor.threadId,
              originAccountId: actor.queryAccountId,
              requestedTarget: targetFromDelivery(effectiveDelivery),
              delegatedToken: actor.auth.token,
              originClientMsgId: actor.clientMsgId,
              creatorUserId: actor.auth.identity?.id,
              runAsUserId: (actor.auth.external_account_identity ?? actor.auth.identity)?.id,
              capturedAt: Date.now(),
            };
            await syncChanged({ action: "updated", jobId, job: current }, mutation, true);
            await confirmAuthorization(jobId, effectiveDelivery, mutation.runAsUserId);
            const requestedAt = Date.now();
            cronCompletions.delete(cronCompletionKey(actor.queryAccountId, jobId));
            const runResult = await cronService.run(jobId, "force");
            if (JSON.stringify(runResult)?.includes("query_schedule_authorization_missing")) {
              throw new Error("query_schedule_authorization_missing");
            }
            if (isRecord(runResult) && runResult.ok === false) throw new Error("query_cron_run_failed");
            if (!isRecord(runResult) || runResult.ran !== true) throw new Error("query_cron_run_not_started");
            // Native run() returns {ok:true, ran:true} even for failed work.
            // Read the outcome persisted by the scheduler, not that receipt.
            const afterRun = (await cronService.list({ includeDisabled: true })) as QueryCronJob[];
            const state = afterRun.find((job) => job.id === jobId)?.state;
            if (!state || typeof state.lastRunAtMs !== "number" || state.lastRunAtMs < requestedAt ||
                state.runningAtMs !== undefined) throw new Error("query_cron_run_result_unconfirmed");
            const completion = cronCompletions.get(cronCompletionKey(actor.queryAccountId, jobId));
            if (completion?.runAtMs === state.lastRunAtMs && completion.authorizationFailed) {
              throw new Error("query_schedule_authorization_missing");
            }
            if (state.lastError?.includes("query_schedule_authorization_missing")) {
              throw new Error("query_schedule_authorization_missing");
            }
            if (state.lastRunStatus === "error") throw new Error("query_cron_run_failed");
            if (state.lastRunStatus !== "ok") throw new Error("query_cron_run_result_unconfirmed");
            if (completion?.runAtMs !== state.lastRunAtMs || completion.status !== "ok") {
              throw new Error("query_cron_run_result_unconfirmed");
            }
            const publicResult = { ok: true, action: "run", job_id: jobId, run: runResult, state };
            return { content: [{ type: "text", text: JSON.stringify(publicResult) }], details: publicResult };
          }

          if (params.action === "update_many") {
            const ids = params.jobs.map((item) => item.job_id.trim());
            if (new Set(ids).size !== ids.length) throw new Error("query_cron_duplicate_job_id");
            const prepared = [] as Array<{
              jobId: string;
              patch: Record<string, unknown> & { delivery?: CronDelivery };
              delivery: CronDelivery;
            }>;
            for (const item of params.jobs) {
              const jobId = item.job_id.trim();
              const current = manageable.find((job) => job.id === jobId);
              if (!current) {
                if (jobs.some((job) => job.id === jobId)) throw new Error("query_cron_not_query_owned");
                throw new Error("query_cron_not_found");
              }
              const delivery = item.patch.delivery ?? current.delivery;
              if (!delivery) throw new Error("query_cron_destination_required");
              await assertAuthorizedCronDestination(actor, delivery);
              prepared.push({ jobId, patch: item.patch, delivery });
            }
            const updated: Array<Record<string, unknown>> = [];
            for (const item of prepared) {
              await cronService.update(item.jobId, {
                ...item.patch,
                sessionTarget: "isolated",
              } as never);
              const after = (await cronService.list({ includeDisabled: true })) as QueryCronJob[];
              const resultingJob = after.find((job) => job.id === item.jobId);
              if (!resultingJob) throw new Error("query_cron_not_persisted");
              persistedJobIds.push(item.jobId);
              const mutation: PendingCronMutation = {
                action: "updated",
                jobId: item.jobId,
                originThreadId: actor.threadId,
                originAccountId: actor.queryAccountId,
                requestedTarget: targetFromDelivery(item.delivery),
                delegatedToken: actor.auth.token,
                originClientMsgId: actor.clientMsgId,
                creatorUserId: actor.auth.identity?.id,
                runAsUserId: (actor.auth.external_account_identity ?? actor.auth.identity)?.id,
                capturedAt: Date.now(),
              };
              await syncChanged({ action: "updated", jobId: item.jobId, job: resultingJob }, mutation, true);
              await confirmAuthorization(item.jobId, item.delivery, mutation.runAsUserId);
              updated.push({ job_id: item.jobId, session_target: "isolated" });
            }
            const publicResult = { ok: true, action: "updated_many", count: updated.length, jobs: updated };
            return { content: [{ type: "text", text: JSON.stringify(publicResult) }], details: publicResult };
          }

          let action: PendingCronMutation["action"];
          let jobId: string | undefined;
          let effectiveDelivery: CronDelivery;
          let result: unknown;
          let resultingJob: QueryCronJob | undefined;

          if (params.action === "add") {
            effectiveDelivery = params.job.delivery;
            await assertAuthorizedCronDestination(actor, effectiveDelivery);
            action = "added";
            const input = {
              ...params.job,
              agentId: ctx.agentId,
              // Persist first, but never let the scheduler race authorization.
              enabled: false,
              description: params.job.description ?? "",
              sessionTarget: "isolated",
              wakeMode: params.job.wakeMode ?? "now",
            };
            result = await cronService.add(input as never);
            jobId = cronJobId(result);
            if (!jobId) {
              const after = (await cronService.list({ includeDisabled: true })) as QueryCronJob[];
              const candidates = after.filter((job) =>
                !jobs.some((before) => before.id === job.id) &&
                job.name === params.job.name,
              );
              if (candidates.length === 1) jobId = candidates[0].id;
            }
          } else {
            jobId = params.job_id.trim();
            const current = manageable.find((job) => job.id === jobId);
            if (!current) {
              if (jobs.some((job) => job.id === jobId)) throw new Error("query_cron_not_query_owned");
              throw new Error("query_cron_not_found");
            }
            const currentDelivery = current.delivery;
            if (currentDelivery?.channel !== "query") {
              throw new Error("query_cron_not_query_owned");
            }
            effectiveDelivery = params.patch.delivery ?? currentDelivery;
            await assertAuthorizedCronDestination(actor, effectiveDelivery);
            action = "updated";
            result = await cronService.update(jobId, {
              ...params.patch,
              sessionTarget: "isolated",
            } as never);
          }

          if (!jobId) throw new Error("query_cron_id_missing");
          if (params.action === "add") {
            createdJobId = jobId;
            persistedJobIds.push(jobId);
          }
          const after = (await cronService.list({ includeDisabled: true })) as QueryCronJob[];
          resultingJob = after.find((job) => job.id === jobId);
          if (!resultingJob) throw new Error("query_cron_not_persisted");
          if (!persistedJobIds.includes(jobId)) persistedJobIds.push(jobId);
          const mutation: PendingCronMutation = {
            action,
            jobId,
            originThreadId: actor.threadId,
            originAccountId: actor.queryAccountId,
            requestedTarget: targetFromDelivery(effectiveDelivery),
            delegatedToken: actor.auth.token,
            originClientMsgId: actor.clientMsgId,
            creatorUserId: actor.auth.identity?.id,
            runAsUserId:
              (actor.auth.external_account_identity ?? actor.auth.identity)?.id,
            capturedAt: Date.now(),
          };
          await syncChanged({ action, jobId, job: resultingJob }, mutation, true);
          const authorization = await confirmAuthorization(jobId, effectiveDelivery, mutation.runAsUserId);
          if (params.action === "add" && params.job.enabled !== false) {
            activationAttempted = true;
            await cronService.update(jobId, { enabled: true });
          }
          const publicResult = {
            ok: true,
            authorization,
            action,
            job_id: jobId,
            session_target: "isolated",
            creator_user_id: mutation.creatorUserId,
            run_as_user_id: mutation.runAsUserId,
            origin_thread_id: actor.threadId,
            delivery: {
              channel: "query",
              account_id: effectiveDelivery.accountId,
              to: effectiveDelivery.threadId ?? effectiveDelivery.to,
            },
          };
          return {
            content: [{ type: "text", text: JSON.stringify(publicResult) }],
            details: publicResult,
          };
        } catch (error) {
          let disabled = Boolean(createdJobId);
          if (createdJobId && activationAttempted) {
            try {
              await cronService.update(createdJobId, { enabled: false });
            } catch {
              disabled = false;
            }
          }
          const allowed = new Set([
            "query_cron_cross_tenant_destination",
            "query_cron_destination_required",
            "query_cron_destination_not_authorized",
            "query_cron_not_found",
            "query_cron_not_query_owned",
            "query_cron_id_missing",
            "query_cron_not_persisted",
            "query_cron_duplicate_job_id",
            "query_cron_run_requires_isolated",
            "query_cron_run_unavailable",
            "query_cron_run_failed",
            "query_cron_run_not_started",
            "query_cron_run_result_unconfirmed",
            "query_schedule_authorization_missing",
            "query_schedule_authorization_rejected",
            "query_schedule_authorization_unconfirmed",
            "query_schedule_authorization_identity_mismatch",
          ]);
          const code = error instanceof Error && allowed.has(error.message)
            ? error.message
            : "query_cron_manage_failed";
          const publicResult = {
            ok: false, error: code,
            ...(error instanceof Error && "authorizationReason" in error
              ? { authorization_reason: error.authorizationReason } : {}),
            ...(persistedJobIds.length ? { persisted_job_ids: persistedJobIds, ready: false } : {}),
            ...(createdJobId ? { disabled, ...(disabled ? {} : { disable_error: "query_cron_disable_unconfirmed" }) } : {}),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(publicResult) }],
            details: publicResult,
          };
        }
      },
    };
  }, { optional: true, names: ["query_cron_manage"] });

  api.on("cron_changed", (event) => {
    if (event.action === "finished") {
      const target = targetFromDelivery((event.job as QueryCronJob | undefined)?.delivery) ?? syncedCrons.get(event.jobId);
      if (target && typeof event.runAtMs === "number") {
        const key = cronCompletionKey(target.accountId, event.jobId);
        const previous = cronCompletions.get(key);
        if (!previous || previous.runAtMs <= event.runAtMs) {
          cronCompletions.set(key, {
            runAtMs: event.runAtMs, status: event.status,
            authorizationFailed: [event.error, event.summary].some((text) =>
              text?.includes("query_schedule_authorization_missing")),
          });
          if (cronCompletions.size > 4096) cronCompletions.delete(cronCompletions.keys().next().value!);
        }
      }
      return;
    }
    return syncChanged(event);
  });
  api.on("after_tool_call", async (event, context) => {
    if (event.toolName !== "cron") return;
    const callId = context?.toolCallId ?? event.toolCallId;
    if (!callId) return;
    const index = pendingCronMutations.findIndex((item) => item.toolCallId === callId);
    if (index < 0) return;
    const mutation = pendingCronMutations.splice(index, 1)[0];
    if (event.error) return;
    let result = event.result;
    if (isRecord(result) && (result.isError || result.ok === false)) return;
    if (isRecord(result) && Array.isArray(result.content)) {
      const text = result.content.find((item) => isRecord(item) && item.type === "text");
      try { result = JSON.parse(text?.text ?? ""); } catch { return; }
    }
    const job = isRecord(result) && isRecord(result.job) ? result.job : result;
    const jobId = trimmed(isRecord(job) ? job.id ?? job.jobId : undefined) ?? mutation.jobId;
    if (!jobId) {
      api.logger.warn("query cron: no se pudo sincronizar la autorización; falta el ID real en el resultado nativo.");
      return;
    }
    await syncChanged({ action: mutation.action, jobId, job: job as PluginHookGatewayCronJob }, mutation);
  });
}
