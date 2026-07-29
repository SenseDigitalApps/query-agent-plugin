import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { getDelegatedAuth, threadsWithDelegatedAuth } from "./delegated-store.js";

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

function queryApiUrl(socketUrl: string, path: string): string {
  const parsed = new URL(socketUrl);
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/api/v4/openclaw-agent/${path}`.replace(/\/{2,}/g, "/");
  return parsed.toString();
}

async function callQuery(
  threadId: string,
  path: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  const stored = getDelegatedAuth(threadId);
  if (!stored) {
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
      execute: async ({ thread_id }) => callQuery(thread_id, "modules/"),
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
      execute: async ({ thread_id, module }) =>
        callQuery(thread_id, `modules/${encodeURIComponent(module)}/`),
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
      execute: async ({ thread_id, module, q, field, value, page, page_size }) => {
        const query: Record<string, string> = {};
        if (q) query.q = q;
        if (field && value !== undefined) query[`field.${field}`] = value;
        if (page) query.page = String(page);
        if (page_size) query.page_size = String(page_size);
        return callQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/`,
          query,
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
      execute: async ({ thread_id, module, record_id }) =>
        callQuery(
          thread_id,
          `modules/${encodeURIComponent(module)}/records/${record_id}/`,
        ),
    }),
  ],
});
