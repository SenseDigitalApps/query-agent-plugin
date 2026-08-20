import { Type } from "typebox";
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

const LOCAL_GENERATED_ARTIFACT_RE =
  /(?:^|[\s"'([{])(?:https?:\/\/[^\s<>"')\]]*)?\/(?:home|tmp|var|mnt|opt|srv|Users|private\/var)\/[^\s<>"')\]]+\.(?:html?|pdf|csv|json|md|txt|xlsx?|docx?|pptx?|zip|png|jpe?g|gif|webp|mp4|mov|m4v|webm)(?:[.,!?;:]?)(?:$|[\s"')\]}])/i;

type QueryToolLog = ToolPluginExecutionContext["api"]["logger"];

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
      "Envia una respuesta normal con la ruta local o preview del archivo; el canal Query lo subira como attachment/public asset.",
  };
}

async function callQuery(
  threadId: string,
  path: string,
  query: Record<string, string>,
  toolName: string,
  log: QueryToolLog,
): Promise<unknown> {
  const stored = await delegatedAuthForTool(threadId, toolName, log);
  if (!stored) return noCredential();
  const url = new URL(queryApiUrl(stored.socketUrl, path));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
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
  return body;
}

async function delegatedAuthForTool(
  threadId: string,
  toolName: string,
  log: QueryToolLog,
) {
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
        ),
    }),
    tool({
      name: "query_records_search",
      label: "Query: buscar registros",
      description:
        "Busca registros de un modulo. Acepta texto libre y filtros por campo. Devuelve los registros con sus etiquetas humanas.",
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
      }),
      execute: async (
        { thread_id, module, q, field, value, page, page_size },
        _config,
        context,
      ) => {
        const query: Record<string, string> = {};
        if (q) query.q = q;
        if (field && value !== undefined) query[`field.${field}`] = value;
        if (page) query.page = String(page);
        if (page_size) query.page_size = String(page_size);
        return callQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/`,
          query,
          "query_records_search",
          context.api.logger,
        );
      },
    }),
    tool({
      name: "query_record_propose",
      label: "Query: proponer un cambio",
      description:
        "Unica via para cambiar datos en Query. No aplica nada: deja la propuesta en el chat y una persona la confirma con un boton. Usala tanto para crear como para actualizar registros reales. No la uses para entregar HTML, PDF, imagenes, hojas de calculo u otros artifacts generados: esos se envian como attachments/public assets en una respuesta normal. Antes, consulta query_module_describe y usa los slugs exactos. Para un campo relacional ref_, envia {id: ...} con el id obtenido de query_records_search o {consecutivo: ...} si solo conoces el consecutivo; Query construye y valida el objeto relacional completo. Despues, dile a la persona que revise la propuesta en el chat; no afirmes que el cambio quedo hecho.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
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
            "Valores por slug. En campos ref_ envia preferiblemente {id: ...}; si solo conoces el consecutivo usa {consecutivo: ...}. No inventes label, type ni module.",
        })),
        intent: Type.Optional(
          Type.String({
            description:
              "Por que se propone, en una frase. Lo lee la persona que decide.",
          }),
        ),
      }),
      execute: async (
        { thread_id, module, record_id, title, fields, intent },
        _config,
        context,
      ) => {
        if (containsGeneratedArtifactReference({ title, fields, intent })) {
          return generatedArtifactAsRecordError();
        }
        const base = `modules/${encodeURIComponent(module)}/records/`;
        const path =
          record_id === undefined ? `${base}propose/` : `${base}${record_id}/propose/`;
        const body: Record<string, unknown> = { fields: fields ?? {}, intent };
        if (title !== undefined) body.title = title;
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
        "Para configurar el panel: crear modulos, grupos de modulos, campos, grupos de campos, carpetas, APIs externas. Propone una SECUENCIA de llamadas a la API de Query que una persona aprueba de una vez. No aplica nada por si sola. Cada paso lleva method (POST/PUT/PATCH/DELETE), path y body. Para encadenar pasos usa \"$N.campo\" en el body: por ejemplo module: \"$0.id\" toma el id que devolvio el paso 0, util porque el modulo aun no existe cuando propones. Se ejecuta todo o nada: si un paso falla, ninguno queda aplicado. Las rutas de usuarios, roles, permisos, tokens y agentes estan bloqueadas y el plan se rechaza entero si incluyes una. Para cambiar datos de registros NO uses esto: usa query_record_propose o query_records_propose_batch.",
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
        "Como query_record_propose pero para varios registros reales del mismo modulo a la vez. Usala SIEMPRE que vayas a proponer mas de un cambio seguido: deja UNA sola tarjeta que la persona aprueba de una vez, en vez de obligarla a confirmar una por una. No la uses para entregar HTML, PDF, imagenes, hojas de calculo u otros artifacts generados: esos se envian como attachments/public assets en una respuesta normal. Cada item puede traer record_id (actualizar), omitirlo (crear) o llevar delete: true con su record_id (eliminar ese registro). Un lote con borrados exige que la persona tenga permiso de eliminar en el modulo, se pinta en rojo y pide una confirmacion aparte. Si un item esta mal, Query rechaza el lote entero y no propone nada, asi que revisa los slugs con query_module_describe antes. Se aplica todo o nada al confirmar. Despues, dile a la persona que revise la propuesta; no afirmes que los cambios quedaron hechos.",
      parameters: Type.Object({
        thread_id: THREAD_PARAM,
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
                  "Valores por slug, igual que en query_record_propose. En campos ref_ envia {id: ...} o {consecutivo: ...}.",
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
      execute: async ({ thread_id, module, items, intent }, _config, context) => {
        if (containsGeneratedArtifactReference({ items, intent })) {
          return generatedArtifactAsRecordError();
        }
        return postQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/propose-batch/`,
          { items, intent },
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
  ],
});
