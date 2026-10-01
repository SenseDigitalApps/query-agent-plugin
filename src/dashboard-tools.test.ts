import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import {
  publishQueryDashboardForThread,
  shareQueryDashboardForThread,
} from "./query-tools.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
let directory: string;
let previousStateFile: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "query-dashboard-tools-"));
  previousStateFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(directory, "delegated.json");
  rememberDelegatedAuth(
    "thread-dash",
    { token: "dash-token", expires_in: 900 },
    "wss://query.test/ws/openclaw-agent/8/",
    "msg-dash",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  forgetDelegatedAuth("thread-dash");
  if (previousStateFile === undefined) delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  else process.env.QUERY_DELEGATED_AUTH_STATE_FILE = previousStateFile;
  await rm(directory, { recursive: true, force: true });
});

describe("query_dashboard_publish", () => {
  it("envia el HTML y las consultas, y entrega el adjunto como media del turno", async () => {
    const filePath = join(directory, "ventas.html");
    await writeFile(filePath, "<div class='qd-card'></div><script>QueryDashboard.render(()=>{})</script>", "utf8");
    const attachment = { id: 7, kind: "file", name: "ventas.html", url: "https://query.test/assets/7/ventas.html" };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, dashboard: { id: 3 }, attachment, audience: "Solo lo ve su autor." }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const queries = [{ name: "ventas", source: "records_aggregate", module: "ventas", metrics: [{ operation: "count" }] }];
    const result = (await publishQueryDashboardForThread({
      threadId: "thread-dash",
      filePath,
      name: "Ventas",
      queries,
      dashboardId: 3,
      log,
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, media: { url: attachment.url, attachments: [attachment] } });
    expect(JSON.stringify(result)).not.toContain(filePath);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://query.test/api/v4/openclaw-agent/threads/thread-dash/dashboards/publish/");
    expect(init.headers).toMatchObject({ "X-Query-Delegated-Token": "dash-token" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ name: "Ventas", queries, dashboard_id: 3 });
    expect(body.html).toContain("QueryDashboard.render");
  });

  it("devuelve los errores de validacion de Query sin inventar un adjunto", async () => {
    const filePath = join(directory, "quemado.html");
    await writeFile(filePath, "<p>1.500.000</p>", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: "dashboard_invalid", errors: [{ error: "embedded_data" }] }),
      })),
    );
    const result = (await publishQueryDashboardForThread({
      threadId: "thread-dash",
      filePath,
      queries: [{ name: "x", source: "static", value: 1 }],
      log,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, error: "dashboard_invalid", errors: [{ error: "embedded_data" }] });
    expect(result).not.toHaveProperty("media");
  });

  it("exige una ruta local absoluta", async () => {
    const result = (await publishQueryDashboardForThread({
      threadId: "thread-dash",
      filePath: "relativo/ventas.html",
      queries: [],
      log,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, error: "local_file_required" });
  });
});

describe("query_dashboard_share", () => {
  it("manda solo lo que la persona pidio cambiar", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, pinned: true, audience: "Lo ven: Cobranza (ademas del autor)." }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await shareQueryDashboardForThread({
      threadId: "thread-dash",
      dashboardId: 3,
      pinned: true,
      groups: ["Cobranza"],
      log,
    });
    expect(result).toMatchObject({ ok: true, pinned: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://query.test/api/v4/openclaw-agent/threads/thread-dash/dashboards/3/share/");
    expect(JSON.parse(String(init.body))).toEqual({ pinned: true, groups: ["Cobranza"] });
  });
});
