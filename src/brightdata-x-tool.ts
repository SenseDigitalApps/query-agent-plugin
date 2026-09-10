import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

const DATASET_ID = "gd_lwxkxvnf1cynvib9co";
const API_URL = "https://api.brightdata.com/datasets/v3/scrape";
const ALLOWED_AGENTS = new Set([
  "comunicaciones",
  "congreso",
  "manuela-villegas-marketing",
]);

export type BrightDataXInput = {
  profile_urls: string[];
  num_of_posts?: number;
  start_date?: string;
  end_date?: string;
  include_reposts?: boolean;
  timeout_seconds?: number;
};

function normalizeProfileUrl(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (parsed.protocol !== "https:" || !["x.com", "twitter.com"].includes(hostname)) {
    throw new Error("brightdata_x_invalid_profile_url");
  }
  const handle = parsed.pathname.split("/").filter(Boolean)[0];
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new Error("brightdata_x_invalid_profile_handle");
  }
  return `https://x.com/${handle}`;
}

function endpoint(): URL {
  const url = new URL(API_URL);
  url.searchParams.set("dataset_id", DATASET_ID);
  url.searchParams.set("type", "discover_new");
  url.searchParams.set("discover_by", "profile_url");
  url.searchParams.set("format", "json");
  url.searchParams.set("include_errors", "true");
  return url;
}

export async function fetchBrightDataXProfilePosts(
  input: BrightDataXInput,
  deps: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const token = deps.token ?? process.env.BRIGHTDATA_API_TOKEN;
  if (!token) throw new Error("brightdata_x_token_unavailable");

  const profileUrls = [...new Set(input.profile_urls.map(normalizeProfileUrl))];
  const payload = profileUrls.map((url) => ({
    url,
    num_of_posts: input.num_of_posts ?? 10,
    include_reposts: input.include_reposts ?? false,
    ...(input.start_date ? { start_date: input.start_date } : {}),
    ...(input.end_date ? { end_date: input.end_date } : {}),
  }));
  const response = await (deps.fetchImpl ?? fetch)(endpoint(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout((input.timeout_seconds ?? 90) * 1000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`brightdata_x_http_${response.status}: ${body.slice(0, 2_000)}`);
  }
  let posts: unknown;
  try {
    posts = JSON.parse(body);
  } catch {
    throw new Error("brightdata_x_non_json_response");
  }
  if (!Array.isArray(posts)) throw new Error("brightdata_x_unexpected_response");
  return {
    ok: true,
    dataset_id: DATASET_ID,
    requested_profiles: profileUrls,
    count: posts.length,
    posts,
  };
}

export function registerBrightDataXTool(api: OpenClawPluginApi): void {
  if (typeof api.registerTool !== "function") return;
  api.registerTool((context) => {
    if (!context.agentId || !ALLOWED_AGENTS.has(context.agentId)) return null;
    return {
      name: "brightdata_x_profile_posts",
      label: "Bright Data: publicaciones de perfiles X",
      description:
        "Consulta publicaciones publicas de perfiles X mediante el dataset verificado de Bright Data. " +
        "Usa esta herramienta en lugar de web_data_x_profile_posts, cuyo recolector remoto esta defectuoso.",
      parameters: Type.Object({
        profile_urls: Type.Array(Type.String({ format: "uri" }), {
          minItems: 1,
          maxItems: 20,
        }),
        num_of_posts: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
        start_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        end_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        include_reposts: Type.Optional(Type.Boolean({ default: false })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 180, default: 90 })),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        try {
          const result = await fetchBrightDataXProfilePosts(params as BrightDataXInput);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "brightdata_x_unknown_error";
          return {
            content: [{ type: "text" as const, text: message }],
            details: { ok: false, error: message },
          };
        }
      },
    };
  }, { name: "brightdata_x_profile_posts", optional: true });
}
