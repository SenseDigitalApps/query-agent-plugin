import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import { getDelegatedAuth } from "./delegated-store.js";
import { authorizeExternalAccount } from "./external-accounts.js";
import { readConfiguredGoogleAccountEmail } from "./google-accounts.js";
import {
  findQuerySessionByThread,
  getQuerySession,
  rememberQuerySession,
} from "./query-session-store.js";

/**
 * Nadie usa una cuenta de Google que no sea suya, aunque el agente lo pida.
 *
 * En la maquina de OpenClaw conviven varias cuentas de Google. El agente elige
 * una escribiendo su ``accountId``, y esa eleccion sale del modelo: de lo que
 * recuerda del prompt, del nombre que vio en otra conversacion, o de una
 * confusion entre dos personas del mismo canal. Es un dato razonable la mayoria
 * de las veces y catastrofico cuando no lo es, porque el error se paga leyendo
 * el correo de otra persona.
 *
 * Este guard corre antes de que exista un cliente de Google. Toma la identidad
 * de la credencial delegada -que Query firmo, no el modelo- y le pregunta a
 * Query si esa persona es duena de esa cuenta. Si la respuesta no es un si
 * explicito, la herramienta no llega a ejecutarse.
 *
 * Solo interviene en sesiones que nacieron de Query. Un turno de otro canal, o
 * de la consola, no pasa por aqui: su politica es otra y no le corresponde a
 * este plugin decidirla.
 */

const PROVIDER = "google_workspace";
// Prefijos de las herramientas que hablan con Google. El nombre lo decide el
// otro plugin, asi que se puede ampliar sin tocar codigo: una herramienta que
// se llame distinto quedaria fuera del guard, y quedarse fuera es abrir la
// puerta.
const DEFAULT_TOOL_PREFIXES = ["google"];

// Nombres con los que las herramientas de Google reciben la cuenta. Se aceptan
// varias grafias porque el contrato lo fija el otro plugin, no este.
const ACCOUNT_PARAM_KEYS = ["accountId", "account_id", "account"] as const;
const EMAIL_PARAM_KEYS = [
  "expectedEmail",
  "expected_email",
  "accountEmail",
  "account_email",
] as const;

function guardedToolPrefixes(): string[] {
  const configured = process.env.QUERY_EXTERNAL_ACCOUNT_GUARD_TOOLS?.trim();
  if (!configured) return DEFAULT_TOOL_PREFIXES;
  const extra = configured
    .split(",")
    .map((prefix) => prefix.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_TOOL_PREFIXES, ...extra])];
}

function isGoogleTool(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  return guardedToolPrefixes().some(
    (prefix) =>
      name === prefix ||
      name.startsWith(`${prefix}_`) ||
      name.startsWith(`${prefix}.`),
  );
}

function readParam(
  params: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return undefined;
}

function blocked(reason: string): PluginHookBeforeToolCallResult {
  return { block: true, blockReason: reason };
}

/**
 * Nombre del parametro con el que exigirle a Google que confirme el buzon.
 *
 * Apagado, y con razon: hoy las tools de ``openclaw-google-workspace`` solo
 * reciben ``accountId``. El correo esperado vive en la configuracion interna de
 * cada cuenta de ese plugin, que lo valida por su cuenta, asi que meterle aqui
 * una clave que su esquema no declara solo romperia la llamada.
 *
 * El correo que devuelve Query se usa para preguntar y para contrastar lo que la
 * llamada ya traiga; no para reescribir sus parametros. Esto queda como puerta
 * por si ese contrato cambia, no como algo que haya que encender.
 */
function expectedEmailParam(): string {
  return process.env.QUERY_GOOGLE_GUARD_EXPECTED_EMAIL_PARAM?.trim() ?? "";
}

export async function evaluateGoogleToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  log?: { info?: (message: string) => void; warn?: (message: string) => void },
): Promise<PluginHookBeforeToolCallResult | void> {
  if (!isGoogleTool(event.toolName)) return;

  const session =
    getQuerySession(ctx.sessionKey) ?? findQuerySessionByThread(ctx.channelId);
  // Sin sesion Query no hay nada que aislar: este guard existe para las cuentas
  // que Query administra, no para adueñarse de las herramientas de Google.
  if (!session) return;

  const params = event.params ?? {};
  const account = readParam(params, ACCOUNT_PARAM_KEYS);
  if (!account) {
    return blocked(
      `${event.toolName} necesita que digas explicitamente que cuenta de Google ` +
        `vas a usar. Query no elige una por defecto: elegir mal significa abrir ` +
        `el correo de otra persona.`,
    );
  }

  const stored = getDelegatedAuth(session.threadId);
  if (!stored) {
    // Un cron sin ``run_as`` valido nunca recibe credencial, asi que este es el
    // punto en que se detiene: no hay a nombre de quien pedir la cuenta.
    const detail = session.jobId
      ? `la tarea programada ${session.jobId} no tiene un autor con acceso ` +
        `vigente al canal de Query. Vuelve a crearla desde una conversacion con ` +
        `la persona en cuyo nombre debe correr.`
      : `no hay una credencial vigente de Query para el canal ${session.threadId}.`;
    return blocked(
      `${event.toolName} no puede usar Google: ${detail} Sin saber por quien ` +
        `actuas, Query no puede decir que cuenta te corresponde.`,
    );
  }

  // Dos correos, y la diferencia entre ellos es la del guard entero.
  //
  // ``declaredEmail`` sale de los parametros de la herramienta, o sea del
  // modelo. Solo puede restar: si no cuadra con lo que Query tiene vinculado, se
  // bloquea. Nunca funda nada.
  //
  // ``configuredEmail`` sale de la configuracion de Google Workspace en esta
  // maquina, que escribio un operador y el modelo no puede tocar. Es lo que le
  // permite a Query reconocer en el primer uso una cuenta que ya estaba
  // configurada, sin pedir una migracion a mano por persona. Si la cuenta no
  // declara ``expectedEmail``, no se manda nada y Query responde como siempre.
  const declaredEmail = readParam(params, EMAIL_PARAM_KEYS);
  const configuredEmail = await readConfiguredGoogleAccountEmail(account.value);
  const verdict = await authorizeExternalAccount({
    socketUrl: stored.socketUrl,
    token: stored.auth.token,
    provider: PROVIDER,
    accountId: account.value,
    authenticatedEmail: declaredEmail?.value,
    configuredEmail: configuredEmail || undefined,
    threadId: session.threadId,
  });

  const actor =
    stored.auth.identity?.display_name ??
    stored.auth.identity?.username ??
    "la persona de este canal";

  if (!verdict.ok) {
    log?.warn?.(
      `query_google_guard_blocked tool=${event.toolName} ` +
        `account=${account.value} thread=${session.threadId} ` +
        `job=${session.jobId ?? ""} error=${verdict.error}`,
    );
    const alternatives = verdict.allowedAccountIds.length
      ? ` Cuentas de Google habilitadas para ${actor}: ` +
        `${verdict.allowedAccountIds.join(", ")}.`
      : ` ${actor} no tiene ninguna cuenta de Google habilitada en Query.`;
    return blocked(
      `Query no autoriza usar la cuenta de Google "${account.value}" en nombre ` +
        `de ${actor} (${verdict.error}): ${verdict.detail}${alternatives}`,
    );
  }

  if (
    declaredEmail &&
    verdict.authenticatedEmail &&
    declaredEmail.value.toLowerCase() !== verdict.authenticatedEmail.toLowerCase()
  ) {
    return blocked(
      `La cuenta "${account.value}" esta vinculada en Query a otro correo del ` +
        `que declaraste en ${declaredEmail.key}. No se llama a Google con una ` +
        `identidad que no coincide.`,
    );
  }

  log?.info?.(
    `query_google_guard_allowed tool=${event.toolName} ` +
      `account=${verdict.accountId} thread=${session.threadId} ` +
      `job=${session.jobId ?? ""} status=${verdict.status}`,
  );

  const injectInto = expectedEmailParam();
  if (injectInto && !declaredEmail && verdict.authenticatedEmail) {
    return { params: { ...params, [injectInto]: verdict.authenticatedEmail } };
  }
  return;
}

export function registerQueryGoogleGuard(api: OpenClawPluginApi): void {
  api.on("before_agent_start", (_event, context) => {
    // Solo los turnos que Query declara suyos. Un canal que no se identifica no
    // se adopta: bloquear las herramientas de Google de otra integracion seria
    // tan dañino como dejar pasar las nuestras. Los crones los apunta
    // ``cron-sync``, que es quien puede reconocerlos.
    const channel = context?.channel ?? context?.messageProvider;
    if (channel !== "query") return;
    const threadId = (context?.chatId ?? context?.channelId ?? "").trim();
    if (!threadId) return;
    rememberQuerySession(context?.sessionKey, {
      threadId,
      jobId: context?.jobId?.trim() || undefined,
    });
  });
  api.on("subagent_spawned", (event, ctx) => {
    // Un subagente hereda el trabajo pero no la sesion, y con ella perderia el
    // canal del que salio: sus llamadas a Google pasarian sin que nadie las
    // reconozca como de Query. Se le traslada el mismo vinculo, que es tambien
    // la misma restriccion.
    const parent = getQuerySession(ctx?.requesterSessionKey);
    const fromRequester =
      event.requester?.channel === "query"
        ? String(event.requester.threadId ?? "").trim()
        : "";
    const threadId = parent?.threadId ?? fromRequester;
    if (!threadId || !event.childSessionKey) return;
    rememberQuerySession(event.childSessionKey, {
      threadId,
      jobId: parent?.jobId,
      accountId: parent?.accountId ?? event.requester?.accountId,
    });
  });
  api.on("before_tool_call", async (event, ctx) =>
    evaluateGoogleToolCall(event, ctx, api.logger),
  );
}
