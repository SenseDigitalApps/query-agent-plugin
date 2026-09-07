import { Type } from "typebox";
import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import { getQuerySession } from "./query-session-store.js";
import { scheduledCredential, scheduledToolContext } from "./scheduled-context.js";
import {
  defineToolPlugin,
  type ToolPluginExecutionContext,
} from "openclaw/plugin-sdk/tool-plugin";
import {
  delegatedAuthStoreDiagnostics,
  getDelegatedAuth,
  peekDelegatedAuth,
  rememberDelegatedAuth,
  threadsWithDelegatedAuth,
} from "./delegated-store.js";
import { queryApiUrl } from "./query-api.js";
import { queryAttachmentForMediaUrl } from "./media.js";
import {
  isLocalArtifactPath,
  QueryUploadError,
  queryUploadUrlFor,
  uploadArtifactToQuery,
} from "./query-upload.js";

/**
 * Herramientas para consultar Query en nombre de la persona que escribe.
 *
 * La credencial nunca pasa por el modelo: el agente indica en que canal esta y
 * el plugin pone el token que Query emitio para ese turno. Lo que devuelve cada
 * herramienta es exactamente lo que esa persona puede ver, porque Query
 * revalida sus permisos en cada llamada.
 */

const THREAD_PARAM = Type.String({
  description:
    "Id del canal de Query en el que estas conversando (conversation.id del mensaje).",
});

const RECORD_FILTER_PARAM = Type.Object({
  field: Type.String({
    description:
      "Slug exacto devuelto por query_module_describe; tambien admite campos del sistema como author, id y title.",
  }),
  operator: Type.Optional(
    Type.Union(
      ["eq", "neq", "contains", "icontains", "in", "gt", "gte", "lt", "lte", "between", "is_empty"].map(
        (value) => Type.Literal(value),
      ),
      { default: "eq" },
    ),
  ),
  value: Type.Optional(Type.Unknown()),
});

const RECORD_SORT_PARAM = Type.Object({
  field: Type.String(),
  direction: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], { default: "asc" }),
  ),
});

const RECORD_METRIC_PARAM = Type.Object({
  operation: Type.Union(
    ["count", "sum", "avg", "min", "max"].map((value) => Type.Literal(value)),
  ),
  field: Type.Optional(Type.String()),
  alias: Type.Optional(Type.String()),
});

const LOCAL_GENERATED_ARTIFACT_RE =
  /(?:^|[\s"'([{])(?:(?:https?:\/\/[^\s<>"')\]]*)?\/(?:home|tmp|var|mnt|opt|srv|Users|private\/var|workspace|workspaces|root)\/|[a-z]:[\\/])[^\s<>"')\]]+\.(?:html?|pdf|csv|json|md|txt|xlsx?|docx?|pptx?|zip|png|jpe?g|gif|webp|mp4|mov|m4v|webm)(?:[.,!?;:]?)(?:$|[\s"')\]}])/i;

type QueryToolLog = ToolPluginExecutionContext["api"]["logger"];

/**
 * Cache corto de metadatos de modulos.
 *
 * El agente tiene instruccion de empezar cada tarea listando modulos y
 * describiendo el que va a tocar, asi que un turno normal repite las mismas dos
 * llamadas antes de hacer nada util. La estructura de un modulo no cambia entre
 * dos frases de una conversacion, pero los permisos si pueden cambiar entre dos
 * personas: por eso la clave incluye la credencial delegada y no el hilo. Dos
 * usuarios del mismo canal tienen tokens distintos y nunca comparten entrada.
 *
 * Solo entra aqui la metadata. Los registros no se cachean: cambian, y una
 * lectura vieja despues de aplicar una propuesta seria un error visible.
 */
const METADATA_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.QUERY_TOOLS_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();
const METADATA_CACHE_MAX_ENTRIES = 200;
const metadataCache = new Map<string, { value: unknown; expiresAt: number }>();

function readMetadataCache(key: string, now: number): unknown | undefined {
  const hit = metadataCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    metadataCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeMetadataCache(key: string, value: unknown, now: number): void {
  if (METADATA_CACHE_TTL_MS <= 0) return;
  for (const [entryKey, entry] of metadataCache) {
    if (entry.expiresAt <= now) metadataCache.delete(entryKey);
  }
  if (metadataCache.size >= METADATA_CACHE_MAX_ENTRIES) {
    const oldest = metadataCache.keys().next();
    if (!oldest.done) metadataCache.delete(oldest.value);
  }
  metadataCache.set(key, { value, expiresAt: now + METADATA_CACHE_TTL_MS });
}

/** Expuesto para las pruebas: ningun turno depende de que el cache persista. */
export function clearQueryMetadataCache(): void {
  metadataCache.clear();
}

async function postQuery(
  threadId: string,
  path: string,
  body: Record<string, unknown>,
  toolName: string,
  log: QueryToolLog,
): Promise<unknown> {
  const stored = await delegatedAuthForTool(threadId, toolName, log);
  if (!stored) return noCredential();
  const response = await fetch(queryApiUrl(stored.socketUrl, path), {
    method: "POST",
    headers: {
      "X-Query-Delegated-Token": stored.auth.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    return {
      ok: false,
      error:
        (payload as { error?: string } | undefined)?.error ??
        `http_${response.status}`,
      ...(payload && typeof payload === "object" ? payload : {}),
    };
  }
  return payload;
}

export async function queryDeliveryTargetsForThread(
  threadId: string,
  log: QueryToolLog,
): Promise<unknown> {
  const stored = await delegatedAuthForTool(
    threadId,
    "query_delivery_targets",
    log,
  );
  if (!stored) return noCredential();
  const response = await fetch(
    queryApiUrl(
      stored.socketUrl,
      `threads/${encodeURIComponent(threadId)}/delivery-targets/`,
    ),
    {
      method: "POST",
      headers: {
        "X-Query-Delegated-Token": stored.auth.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    return {
      ok: false,
      error:
        (payload as { error?: string } | undefined)?.error ??
        `http_${response.status}`,
      ...(payload && typeof payload === "object" ? payload : {}),
    };
  }
  const { queryAccountIdForSocketUrl } = await import("./socket.js");
  return {
    ...(payload && typeof payload === "object" ? payload : {}),
    query_account_id: queryAccountIdForSocketUrl(stored.socketUrl),
  };
}

function noCredential() {
  const alive = threadsWithDelegatedAuth();
  return {
    ok: false,
    error: "no_credential",
    detail:
      "No hay una credencial vigente para ese canal. Responde a un mensaje " +
      "reciente de esa conversacion antes de consultar.",
    ...(alive.length ? { canales_disponibles: alive } : {}),
  };
}

export function containsGeneratedArtifactReference(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return LOCAL_GENERATED_ARTIFACT_RE.test(text);
}

function generatedArtifactAsRecordError() {
  return {
    ok: false,
    error: "artifact_delivery_not_record",
    detail:
      "No crees ni actualices registros de Query para entregar HTML, PDF u otros artifacts generados desde rutas locales. " +
      "Publica el archivo en el canal actual con query_attachment_send usando la ruta local solo como file_path interno y nunca la muestres al usuario. " +
      "Si la herramienta no esta cargada, localizala y cargala primero con tool_search.",
  };
}

export function recordProposalRequestBody(params: {
  actionId?: string;
  title?: string;
  fields?: Record<string, unknown>;
  intent?: string;
  replaceProposal?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { fields: params.fields ?? {} };
  if (params.intent !== undefined) body.intent = params.intent;
  if (params.title !== undefined) body.title = params.title;
  if (params.actionId !== undefined) body.action_id = params.actionId;
  if (params.replaceProposal !== undefined) {
    body.replace_proposal = params.replaceProposal;
  }
  return body;
}

export function batchProposalRequestBody(params: {
  actionId?: string;
  items: unknown[];
  intent?: string;
}): Record<string, unknown> {
  return {
    items: params.items,
    ...(params.intent !== undefined ? { intent: params.intent } : {}),
    ...(params.actionId ? { action_id: params.actionId } : {}),
  };
}

function attachmentThreadId(requested: string | undefined): string | undefined {
  const explicit = requested?.trim();
  if (explicit) return explicit;
  const available = threadsWithDelegatedAuth();
  return available.length === 1 ? available[0] : undefined;
}

export async function uploadQueryAttachmentForThread(params: {
  threadId?: string;
  filePath: string;
  message?: string;
  name?: string;
  mimeType?: string;
  kind?: string;
  log: QueryToolLog;
}): Promise<unknown> {
  const threadId = attachmentThreadId(params.threadId);
  if (!threadId) {
    return {
      ok: false,
      error: "thread_required",
      detail:
        "Indica thread_id; solo puede omitirse cuando hay exactamente una conversacion Query activa.",
    };
  }
  if (!isLocalArtifactPath(params.filePath)) {
    return {
      ok: false,
      error: "local_file_required",
      detail: "file_path debe ser una ruta local absoluta del archivo generado.",
    };
  }
  const stored = await delegatedAuthForTool(threadId, "query_attachment_send", params.log);
  if (!stored) return noCredential();
  const inferred = queryAttachmentForMediaUrl(params.filePath);
  try {
    const attachment = await uploadArtifactToQuery({
      uploadUrl: queryUploadUrlFor(stored.socketUrl, threadId),
      token: stored.auth.token,
      path: params.filePath,
      attachment: {
        ...inferred,
        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        ...(params.mimeType?.trim() ? { mime_type: params.mimeType.trim() } : {}),
        ...(params.kind?.trim() ? { kind: params.kind.trim() } : {}),
      },
    });
    return {
      ok: true,
      thread_id: threadId,
      attachment,
      public_url: attachment.url,
      // OpenClaw recoge `details.media` de las tools y lo agrega a mediaUrls
      // del turno. Asi el socket lo convierte en data.attachments sin pedirle
      // al agente que copie una ruta o enlace en su texto final.
      media: {
        url: attachment.url,
        attachments: [attachment],
      },
      ...(params.message?.trim() ? { message: params.message.trim() } : {}),
    };
  } catch (error) {
    params.log.warn(
      `query_attachment_send_failed thread_id=${JSON.stringify(threadId)} ` +
        `error=${error instanceof QueryUploadError ? error.code : "upload_failed"}`,
    );
    return {
      ok: false,
      error: error instanceof QueryUploadError ? error.code : "upload_failed",
      detail: "Query no pudo subir el archivo. No compartas la ruta local; informa el fallo en texto.",
    };
  }
}

export async function callQuery(
  threadId: string,
  path: string,
  query: Record<string, string>,
  toolName: string,
  log: QueryToolLog,
  options: { cacheable?: boolean } = {},
): Promise<unknown> {
  const stored = await delegatedAuthForTool(threadId, toolName, log);
  if (!stored) return noCredential();
  const url = new URL(queryApiUrl(stored.socketUrl, path));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const cacheKey =
    options.cacheable && METADATA_CACHE_TTL_MS > 0
      ? JSON.stringify([stored.auth.token, url.toString()])
      : undefined;
  const now = Date.now();
  if (cacheKey) {
    const cached = readMetadataCache(cacheKey, now);
    if (cached !== undefined) {
      log.info(`query_metadata_cache_hit tool=${JSON.stringify(toolName)}`);
      return cached;
    }
  }
  const response = await fetch(url, {
    headers: { "X-Query-Delegated-Token": stored.auth.token },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    return {
      ok: false,
      error:
        (body as { error?: string } | undefined)?.error ?? `http_${response.status}`,
      detail: (body as { detail?: string } | undefined)?.detail,
    };
  }
  // Un fallo nunca se cachea: repetir un error durante un minuto convierte un
  // problema pasajero en uno que parece permanente.
  if (cacheKey && body !== undefined) writeMetadataCache(cacheKey, body, now);
  return body;
}

export async function queryRecordsForThread(
  params: {
    threadId: string;
    module: string;
    q?: string;
    field?: string;
    value?: string;
    page?: number;
    pageSize?: number;
    filters?: unknown[];
    columns?: string[];
    sort?: unknown[];
    limit?: number;
  },
  log: QueryToolLog,
): Promise<unknown> {
  const structured =
    params.filters !== undefined ||
    params.columns !== undefined ||
    params.sort !== undefined ||
    params.limit !== undefined;
  if (!structured) {
    const query: Record<string, string> = {};
    if (params.q) query.q = params.q;
    if (params.field && params.value !== undefined) {
      query[`field.${params.field}`] = params.value;
    }
    if (params.page) query.page = String(params.page);
    if (params.pageSize) query.page_size = String(params.pageSize);
    return callQuery(
      params.threadId,
      `modules/${encodeURIComponent(params.module)}/records/`,
      query,
      "query_records_search",
      log,
    );
  }

  const filters = [...(params.filters ?? [])];
  if (params.q) {
    filters.push({ field: "title", operator: "icontains", value: params.q });
  }
  if (params.field && params.value !== undefined) {
    filters.push({ field: params.field, operator: "eq", value: params.value });
  }
  return postQuery(
    params.threadId,
    `modules/${encodeURIComponent(params.module)}/records/query/`,
    {
      filters,
      columns: params.columns ?? [],
      sort: params.sort ?? [],
      limit: params.limit ?? params.pageSize ?? 50,
    },
    "query_records_search",
    log,
  );
}

export async function aggregateQueryRecordsForThread(
  params: {
    threadId: string;
    module: string;
    filters?: unknown[];
    groupBy?: string[];
    metrics?: unknown[];
    dateFilters?: unknown[];
    timeGranularity?: Record<string, string>;
  },
  log: QueryToolLog,
): Promise<unknown> {
  return postQuery(
    params.threadId,
    `modules/${encodeURIComponent(params.module)}/records/aggregate/`,
    {
      filters: params.filters ?? [],
      group_by: params.groupBy ?? [],
      metrics: params.metrics ?? [],
      date_filters: params.dateFilters ?? [],
      time_granularity: params.timeGranularity ?? {},
    },
    "query_records_aggregate",
    log,
  );
}

async function delegatedAuthForTool(
  threadId: string,
  toolName: string,
  log: QueryToolLog,
) {
  const scheduled = scheduledToolContext.getStore();
  if (scheduled) return scheduled;
  const lookupKey = String(threadId);
  const stale = peekDelegatedAuth(threadId);
  const alive = getDelegatedAuth(threadId);
  const diagnostics = delegatedAuthStoreDiagnostics();
  log.info(
    `query_delegated_auth_resolve pid=${process.pid} ` +
      `tool=${JSON.stringify(toolName)} requested_thread_id=${JSON.stringify(threadId)} ` +
      `lookup_key=${JSON.stringify(lookupKey)} found=${Boolean(alive)} ` +
      `stale_present=${Boolean(stale)} visible_keys=${JSON.stringify(diagnostics.keys)} ` +
      `store_file=${JSON.stringify(diagnostics.stateFile)}`,
  );
  if (alive) return alive;
  if (!stale?.clientMsgId) {
    log.warn(
      `query_delegated_auth_missing pid=${process.pid} ` +
        `tool=${JSON.stringify(toolName)} lookup_key=${JSON.stringify(lookupKey)} ` +
        `refreshable=false`,
    );
    return undefined;
  }
  const { refreshQueryDelegatedAuth } = await import("./socket.js");
  const refreshed = await refreshQueryDelegatedAuth(
    threadId,
    stale.socketUrl,
    stale.clientMsgId,
  );
  log.info(
    `query_delegated_auth_refresh pid=${process.pid} ` +
      `tool=${JSON.stringify(toolName)} lookup_key=${JSON.stringify(lookupKey)} ` +
      `refreshed=${Boolean(refreshed?.token)}`,
  );
  if (!refreshed?.token) return undefined;
  rememberDelegatedAuth(threadId, refreshed, stale.socketUrl, stale.clientMsgId);
  return getDelegatedAuth(threadId);
}

export default defineToolPlugin({
  id: "query-tools",
  name: "Query",
  description:
    "Consulta modulos, campos y registros de Query en nombre de la persona con la que conversas.",
  tools: (tool) => [
    tool({
      name: "query_delivery_targets",
      label: "Query: destinos de tareas programadas",
      description:
        "Lista los canales Query en los que la persona de este turno puede programar entregas. Usala antes de crear o mover un cron hacia otro canal; no adivines threadId ni accountId. Un administrador puede recibir destinos adicionales del mismo agente y un usuario normal solo los que tiene autorizados.",
      parameters: Type.Object({ thread_id: THREAD_PARAM }),
      execute: async ({ thread_id }, _config, context) =>
        queryDeliveryTargetsForThread(thread_id, context.api.logger),
    }),
    tool({
      name: "query_attachment_send",
      label: "Query: entregar archivo",
      description:
        "Sube un archivo generado o modificado al sistema nativo de attachments de Query para dejarlo visible y descargable en el chat. Usa esta herramienta para HTML, PDF, Word, Excel, CSV, imagenes, audio, video, ZIP, dashboards y presentaciones. Nunca muestres file_path al usuario ni uses registros de negocio para entregar archivos.",
      parameters: Type.Object({
        file_path: Type.String({
          description: "Ruta local absoluta del archivo que el agente ya genero.",
        }),
        thread_id: Type.Optional(THREAD_PARAM),
        message: Type.Optional(
          Type.String({ description: "Texto corto opcional que acompana el archivo." }),
        ),
        name: Type.Optional(Type.String({ description: "Nombre visible opcional." })),
        mime_type: Type.Optional(Type.String({ description: "MIME type opcional." })),
        kind: Type.Optional(
          Type.String({ description: "Tipo opcional: file, image, audio o video." }),
        ),
      }),
      execute: async (
        { file_path, thread_id, message, name, mime_type, kind },
        _config,
        context,
      ) =>
        uploadQueryAttachmentForThread({
          threadId: thread_id,
          filePath: file_path,
          message,
          name,
          mimeType: mime_type,
          kind,
          log: context.api.logger,
        }),
    }),
    tool({
      name: "query_modules_list",
      label: "Query: listar modulos",
      description:
        "Punto de partida obligatorio: lista los modulos de Query que puede ver la persona con la que conversas, con su nombre tecnico, su nombre visible y sus permisos. Cada sistema tiene modulos distintos, asi que nunca supongas que existe uno; descubrelos aqui primero.",
      parameters: Type.Object({ thread_id: THREAD_PARAM }),
      execute: async ({ thread_id }, _config, context) =>
        callQuery(
          thread_id,
          "modules/",
          {},
          "query_modules_list",
          context.api.logger,
          { cacheable: true },
        ),
    }),
    tool({
      name: "query_module_describe",
      label: "Query: describir modulo",
      description:
        "Devuelve la estructura de un modulo: campos, grupos, tipos, cuales son obligatorios, cuales no se pueden escribir y que opciones admite cada campo de seleccion. Uselo antes de filtrar o de proponer cambios, en vez de suponer los nombres.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        module: Type.String({
          description:
            "Nombre tecnico del modulo o el nombre visible tal como aparece en " +
            "query_modules_list. No inventes nombres: cada sistema tiene los suyos.",
        }),
      }),
      execute: async ({ thread_id, module }, _config, context) =>
        callQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/`,
          {},
          "query_module_describe",
          context.api.logger,
          { cacheable: true },
        ),
    }),
    tool({
      name: "query_module_categories_list",
      label: "Query: listar categorias de modulos",
      description:
        "Lista las categorias (grupos de modulos) que existen hoy, con su id real, su titulo y que modulos tiene cada una. Usala antes de proponer un plan que asocie un modulo a una categoria (por ejemplo, sumar el modulo que acabas de crear a 'Productividad'): el id sale de aqui, nunca lo inventes ni supongas que el nombre visible sirve como cuerpo de la llamada.",
      parameters: Type.Object({ thread_id: THREAD_PARAM }),
      execute: async ({ thread_id }, _config, context) =>
        callQuery(
          thread_id,
          "module-categories/",
          {},
          "query_module_categories_list",
          context.api.logger,
          { cacheable: true },
        ),
    }),
    tool({
      name: "query_records_search",
      label: "Query: buscar registros",
      description:
        "Busca registros de un modulo. Para cruzar fecha, autor u otros criterios usa filters; para evitar respuestas enormes pide solo columns. author es quien creo el registro y admite username o nombre completo. Conserva field/value para busquedas simples antiguas.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        module: Type.String({ description: "Modulo donde buscar." }),
        q: Type.Optional(
          Type.String({ description: "Texto a buscar en el titulo del registro." }),
        ),
        field: Type.Optional(
          Type.String({
            description:
              "Slug del campo por el que filtrar; usa query_module_describe para conocerlo.",
          }),
        ),
        value: Type.Optional(
          Type.String({ description: "Valor exacto que debe tener ese campo." }),
        ),
        page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
        page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        filters: Type.Optional(
          Type.Array(RECORD_FILTER_PARAM, {
            description: "Filtros simultaneos; between recibe [desde, hasta].",
          }),
        ),
        columns: Type.Optional(
          Type.Array(Type.String(), {
            description: "Slugs exactos que deben volver; reduce el payload.",
          }),
        ),
        sort: Type.Optional(Type.Array(RECORD_SORT_PARAM)),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      execute: async (
        { thread_id, module, q, field, value, page, page_size, filters, columns, sort, limit },
        _config,
        context,
      ) =>
        queryRecordsForThread(
          {
            threadId: thread_id,
            module,
            q,
            field,
            value,
            page,
            pageSize: page_size,
            filters,
            columns,
            sort,
            limit,
          },
          context.api.logger,
        ),
    }),
    tool({
      name: "query_records_aggregate",
      label: "Query: calcular sobre registros",
      description:
        "Calcula en Query conteos, sumas, promedios, minimos y maximos, con filtros y agrupaciones. Usala para horas, dinero, totales o reportes: no descargues decenas de filas para sumarlas manualmente. Para quien creo el registro filtra por author; para detalle diario agrupa por el campo de fecha.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        module: Type.String({ description: "Modulo donde calcular." }),
        filters: Type.Optional(Type.Array(RECORD_FILTER_PARAM)),
        group_by: Type.Optional(
          Type.Array(Type.String(), {
            description: "Campos por los que se separa el resultado.",
          }),
        ),
        metrics: Type.Array(RECORD_METRIC_PARAM, {
          minItems: 1,
          description: "Calculos solicitados. sum/avg/min/max requieren field.",
        }),
        date_filters: Type.Optional(
          Type.Array(
            Type.Object({
              field: Type.String(),
              from: Type.String({ description: "Fecha ISO inicial inclusiva." }),
              to: Type.String({ description: "Fecha ISO final inclusiva." }),
            }),
          ),
        ),
        time_granularity: Type.Optional(
          Type.Record(
            Type.String(),
            Type.Union(
              ["day", "week", "month", "quarter", "year"].map((value) =>
                Type.Literal(value),
              ),
            ),
          ),
        ),
      }),
      execute: async (
        { thread_id, module, filters, group_by, metrics, date_filters, time_granularity },
        _config,
        context,
      ) =>
        aggregateQueryRecordsForThread(
          {
            threadId: thread_id,
            module,
            filters,
            groupBy: group_by,
            metrics,
            dateFilters: date_filters,
            timeGranularity: time_granularity,
          },
          context.api.logger,
        ),
    }),
    tool({
      name: "query_record_propose",
      label: "Query: proponer un cambio",
      description:
        "Unica via para cambiar datos en Query. Por defecto deja una propuesta en el chat que dura 24 horas. Si un administrador autorizo a ese usuario a crear registros sin aprobacion, Query aplica las creaciones automaticamente y devuelve requires_confirmation=false con status=executed. Las actualizaciones siguen requiriendo aprobacion. Usala tanto para crear como para actualizar registros reales. Si la persona corrige una propuesta que sigue pendiente, vuelve a llamar esta tool con el action_id de esa propuesta: Query actualiza la misma tarjeta, sin pedir que la descarte ni crear otra. Los fields corregidos se mezclan con los ya propuestos; usa replace_proposal=true y envia la version completa solo cuando debas quitar cambios anteriores. No la uses para entregar HTML, PDF, imagenes, hojas de calculo u otros artifacts generados: publicalos en el canal actual con query_attachment_send, buscandola primero con tool_search si no esta cargada, y nunca muestres la ruta local. Antes, consulta query_module_describe y usa los slugs exactos. Los campos calculator, calculador_initial, calculator_advanced y calculator_table tambien aceptan el valor inicial calculado por el agente; el frontend podra recalcularlo despues. Para un campo relacional ref_, envia {id: ...} con el id obtenido de query_records_search o {consecutivo: ...} si solo conoces el consecutivo; Query construye y valida el objeto relacional completo. Lee la respuesta: solo si status=executed informa que se creo el registro; si requires_confirmation=true pide revisar la propuesta en el chat. No asumas exito ante errores.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        action_id: Type.Optional(
          Type.String({
            description:
              "UUID de una propuesta pendiente devuelto por esta tool. Incluyelo para corregir esa misma tarjeta.",
          }),
        ),
        module: Type.String({ description: "Modulo donde se hara el cambio." }),
        record_id: Type.Optional(
          Type.Integer({
            description:
              "Id del registro a actualizar. Omitelo para proponer uno nuevo.",
          }),
        ),
        title: Type.Optional(
          Type.String({
            description:
              "Titulo descriptivo del registro. En Query viaja fuera de fields.",
          }),
        ),
        fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Valores por slug, incluidos campos calculados como valor inicial. En campos ref_ envia preferiblemente {id: ...}; si solo conoces el consecutivo usa {consecutivo: ...}. No inventes label, type ni module.",
        })),
        intent: Type.Optional(
          Type.String({
            description:
              "Por que se propone, en una frase. Lo lee la persona que decide.",
          }),
        ),
        replace_proposal: Type.Optional(
          Type.Boolean({
            description:
              "false por defecto: mezcla fields corregidos con los ya propuestos. true reemplaza toda la propuesta y exige enviar su version completa.",
          }),
        ),
      }),
      execute: async (
        { thread_id, action_id, module, record_id, title, fields, intent, replace_proposal },
        _config,
        context,
      ) => {
        if (containsGeneratedArtifactReference({ title, fields, intent })) {
          return generatedArtifactAsRecordError();
        }
        const base = `modules/${encodeURIComponent(module)}/records/`;
        const path =
          record_id === undefined ? `${base}propose/` : `${base}${record_id}/propose/`;
        const body = recordProposalRequestBody({
          actionId: action_id,
          title,
          fields,
          intent,
          replaceProposal: replace_proposal,
        });
        return postQuery(
          thread_id,
          path,
          body,
          "query_record_propose",
          context.api.logger,
        );
      },
    }),
    tool({
      name: "query_record_delete_propose",
      label: "Query: proponer eliminar un registro",
      description:
        "Unica via para eliminar un registro de Query. No borra nada: deja la propuesta en el chat y una persona la confirma en un modal que le muestra que va a desaparecer. Exige que esa persona tenga permiso de eliminar en el modulo (miralo en query_modules_list: permissions.delete); si no lo tiene, Query rechaza la propuesta. Un borrado no se puede deshacer, asi que identifica el registro con query_records_search o query_record_get antes y explica en intent por que se elimina. Despues, dile a la persona que revise la propuesta; no afirmes que el registro quedo eliminado.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        module: Type.String({ description: "Modulo al que pertenece el registro." }),
        record_id: Type.Integer({
          description: "Id del registro que se propone eliminar.",
        }),
        intent: Type.Optional(
          Type.String({
            description:
              "Por que se propone eliminarlo, en una frase. Lo lee la persona que decide.",
          }),
        ),
      }),
      execute: async ({ thread_id, module, record_id, intent }, _config, context) =>
        postQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/${record_id}/propose-delete/`,
          { intent },
          "query_record_delete_propose",
          context.api.logger,
        ),
    }),
    tool({
      name: "query_api_plan_propose",
      label: "Query: proponer cambios de configuracion",
      description:
        "Para configurar el panel: crear modulos, campos, carpetas, APIs externas, y sumar un modulo a una categoria existente (grupo de modulos). Propone una SECUENCIA de llamadas a la API de Query que una persona aprueba de una vez. No aplica nada por si sola: cada paso se comprueba contra el contrato real de su endpoint al proponer -si el cuerpo ya es incompatible, el plan se rechaza aqui mismo, no al aplicar- salvo que dependa de \"$N.campo\" de un paso anterior, en cuyo caso queda diferido hasta la ejecucion. Cada paso lleva method (POST/PUT/PATCH/DELETE), path y body. Para encadenar pasos usa \"$N.campo\" en el body: por ejemplo module: \"$0.id\" toma el id que devolvio el paso 0, util porque el modulo aun no existe cuando propones. Se ejecuta todo o nada: si un paso falla, ninguno queda aplicado. Las rutas de usuarios, roles, permisos, tokens y agentes estan bloqueadas y el plan se rechaza entero si incluyes una. Para sumar un modulo a una categoria usa POST en /api/v2/modulos-category/<id>/add-module/ con body {\"module\": \"$N.id\"}: es aditivo, no borra los modulos que la categoria ya tenia. Nunca mandes un campo \"group\" en el body de /api/v2/modulos/: no existe: la categoria se asocia despues, con ese paso aparte, y el id real de la categoria sale de query_module_categories_list. Para cambiar datos de registros NO uses esto: usa query_record_propose o query_records_propose_batch.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        steps: Type.Array(
          Type.Object({
            method: Type.String({
              description: "POST, PUT, PATCH o DELETE. GET no va en un plan.",
            }),
            path: Type.String({
              description:
                "Ruta de la API, por ejemplo /api/v2/modulos/ o /api/v2/custom-fields/.",
            }),
            body: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
                description:
                  "Cuerpo de la llamada. Admite referencias \"$N.campo\" a lo que devolvio un paso anterior.",
              }),
            ),
            label: Type.Optional(
              Type.String({
                description:
                  "Que hace el paso, en lenguaje humano. Es lo que lee quien aprueba, asi que escribelo siempre.",
              }),
            ),
          }),
          {
            description: "Pasos en el orden en que deben ejecutarse. Maximo 40.",
            minItems: 1,
          },
        ),
        intent: Type.Optional(
          Type.String({
            description:
              "Que se quiere lograr con el plan, en una frase. Lo lee la persona que decide.",
          }),
        ),
      }),
      execute: async ({ thread_id, steps, intent }, _config, context) => {
        return postQuery(
          thread_id,
          "api-plan/propose/",
          { steps, intent },
          "query_api_plan_propose",
          context.api.logger,
        );
      },
    }),
    tool({
      name: "query_records_propose_batch",
      label: "Query: proponer varios cambios",
      description:
        "Como query_record_propose pero para varios registros reales del mismo modulo a la vez. Usala SIEMPRE que vayas a proponer mas de un cambio seguido: deja UNA sola tarjeta que la persona aprueba de una vez, en vez de obligarla a confirmar una por una. Si corriges un lote pendiente, incluye su action_id y envia la lista items completa corregida; Query actualiza la misma tarjeta. No la uses para entregar HTML, PDF, imagenes, hojas de calculo u otros artifacts generados: publicalos en el canal actual con query_attachment_send, buscandola primero con tool_search si no esta cargada, y nunca muestres la ruta local. Cada item puede traer record_id (actualizar), omitirlo (crear) o llevar delete: true con su record_id (eliminar ese registro). Un lote con borrados exige que la persona tenga permiso de eliminar en el modulo, se pinta en rojo y pide una confirmacion aparte. Si un item esta mal, Query rechaza el lote entero y no propone nada, asi que revisa los slugs con query_module_describe antes. Se aplica todo o nada al confirmar. Las propuestas duran 24 horas. Query puede ejecutar automaticamente un lote compuesto solo por creaciones si un administrador autorizo a ese usuario. Solo si status=executed informa que se aplico; si requires_confirmation=true pide revisar la propuesta. Los lotes con modificaciones o borrados siempre requieren aprobacion.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        action_id: Type.Optional(
          Type.String({
            description:
              "UUID del lote pendiente a corregir. Envia la lista items completa corregida.",
          }),
        ),
        module: Type.String({
          description: "Modulo donde se haran los cambios. Uno solo por lote.",
        }),
        items: Type.Array(
          Type.Object({
            record_id: Type.Optional(
              Type.Integer({
                description:
                  "Id del registro a actualizar. Omitelo para proponer uno nuevo.",
              }),
            ),
            title: Type.Optional(
              Type.String({
                description:
                  "Titulo descriptivo del registro. En Query viaja fuera de fields.",
              }),
            ),
            fields: Type.Optional(
              Type.Record(Type.String(), Type.Unknown(), {
            description:
                  "Valores por slug, incluidos campos calculados como valor inicial, igual que en query_record_propose. En campos ref_ envia {id: ...} o {consecutivo: ...}.",
              }),
            ),
            delete: Type.Optional(
              Type.Boolean({
                description:
                  "true para ELIMINAR ese registro en vez de escribirlo. Exige record_id y no lleva fields ni title. El borrado no se puede deshacer.",
              }),
            ),
          }),
          {
            description:
              "Registros del lote, maximo 50. Cada uno necesita fields, title o ambos, salvo los de delete: true, que solo llevan record_id.",
            minItems: 1,
          },
        ),
        intent: Type.Optional(
          Type.String({
            description:
              "Por que se propone el lote, en una frase. Lo lee la persona que decide.",
          }),
        ),
      }),
      execute: async ({ thread_id, action_id, module, items, intent }, _config, context) => {
        if (containsGeneratedArtifactReference({ items, intent })) {
          return generatedArtifactAsRecordError();
        }
        return postQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/propose-batch/`,
          batchProposalRequestBody({ actionId: action_id, items, intent }),
          "query_records_propose_batch",
          context.api.logger,
        );
      },
    }),
    tool({
      name: "query_record_get",
      label: "Query: ver registro",
      description:
        "Devuelve un registro concreto con todos sus campos, sus etiquetas humanas y el contenido original.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        module: Type.String({ description: "Modulo al que pertenece el registro." }),
        record_id: Type.Integer({ description: "Id del registro." }),
      }),
      execute: async ({ thread_id, module, record_id }, _config, context) =>
        callQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/${record_id}/`,
          {},
          "query_record_get",
          context.api.logger,
        ),
    }),
    tool({
      name: "query_artifact_new_version",
      label: "Query: conservar la version anterior de un archivo",
      description:
        "Usalo ANTES de volver a enviar un archivo cuando quieras conservar la version que ya mandaste. " +
        "Por defecto, reenviar el mismo archivo reemplaza su contenido en Query: el enlace que la persona ya tiene sigue sirviendo y muestra la version al dia, sin repartir copias. " +
        "Llama a esta herramienta solo cuando la version anterior deba seguir existiendo por separado -por ejemplo un informe que ya se aprobo y ahora preparas otra edicion-. " +
        "Despues de llamarla, el siguiente envio de ese archivo crea un asset nuevo y deja el anterior intacto. " +
        "No borra nada ni cambia lo ya enviado.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
        path: Type.String({
          description:
            "Ruta local del archivo que vas a enviar, tal como la escribiste en tu workspace.",
        }),
      }),
      execute: async ({ thread_id, path }, _config, context) => {
        const { forgetArtifact } = await import("./artifact-store.js");
        forgetArtifact(thread_id, path);
        context.api.logger.info(
          `query_artifact_new_version thread=${JSON.stringify(String(thread_id))}`,
        );
        return {
          ok: true,
          detail:
            "El proximo envio de este archivo creara una copia nueva en Query y conservara la anterior.",
        };
      },
    }),
  ].map((definition) => ({
    ...definition,
    // Tool catalogs can be built before before_agent_start. Accept omission
    // there too; the trusted session is resolved again at execution time.
    parameters: {
      ...definition.parameters,
      required: (((definition.parameters as unknown as { required?: string[] }).required ?? [])).filter((key) => key !== "thread_id"),
    },
    execute: undefined,
    factory: ({ api, config, toolContext }) => {
      const sessionKey = toolContext.sessionKey;
      return {
        name: definition.name, label: definition.label,
        description: definition.description,
        parameters: {
          ...definition.parameters,
          required: (((definition.parameters as unknown as { required?: string[] }).required ?? [])).filter((key) => key !== "thread_id"),
        },
        execute: async (toolCallId, params, signal, onUpdate) => {
          const invoke = (resolved: unknown) => definition.execute!(resolved, config, { api, toolCallId, signal, onUpdate });
          const session = getQuerySession(sessionKey);
          if (!session?.jobId) {
            const supplied = params as Record<string, unknown>;
            const value = await invoke({ ...supplied, thread_id: supplied.thread_id ?? session?.threadId });
            return typeof value === "string" ? textResult(value, value) : jsonResult(value);
          }
          try {
            const resolved = await scheduledCredential(sessionKey);
            if (!resolved) throw new Error("query_schedule_authorization_missing");
            const value = await scheduledToolContext.run(resolved.credential, () =>
              invoke({ ...(params as Record<string, unknown>), thread_id: resolved.threadId }));
            return typeof value === "string" ? textResult(value, value) : jsonResult(value);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "query_schedule_authorization_missing";
            return { content: [{ type: "text" as const, text: detail }], details: { ok: false, error: "query_schedule_authorization_missing" } };
          }
        },
      };
    },
  })),
});
