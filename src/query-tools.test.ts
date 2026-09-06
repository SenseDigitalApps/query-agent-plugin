import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import {
  aggregateQueryRecordsForThread,
  batchProposalRequestBody,
  callQuery,
  clearQueryMetadataCache,
  containsGeneratedArtifactReference,
  queryDeliveryTargetsForThread,
  queryRecordsForThread,
  recordProposalRequestBody,
  uploadQueryAttachmentForThread,
} from "./query-tools.js";

let stateDirectory: string;
let previousStateFile: string | undefined;

beforeAll(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "query-tools-state-"));
  previousStateFile = process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  process.env.QUERY_DELEGATED_AUTH_STATE_FILE = join(
    stateDirectory,
    "delegated.json",
  );
});

afterAll(async () => {
  if (previousStateFile === undefined) {
    delete process.env.QUERY_DELEGATED_AUTH_STATE_FILE;
  } else {
    process.env.QUERY_DELEGATED_AUTH_STATE_FILE = previousStateFile;
  }
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("query_delivery_targets", () => {
  it("asks Query for the destinations authorized from the creator thread", async () => {
    rememberDelegatedAuth(
      "thread-origin",
      { token: "delegated-origin-token", expires_in: 900 },
      "wss://query.test/ws/openclaw-agent/8/",
      "msg-origin",
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        origin_thread_id: "thread-origin",
        targets: [{ thread_id: "77", name: "Reportes", thread_type: "topic" }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    try {
      const result = await queryDeliveryTargetsForThread("thread-origin", log);
      expect(result).toMatchObject({
        origin_thread_id: "thread-origin",
        targets: [{ thread_id: "77", name: "Reportes" }],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://query.test/api/v4/openclaw-agent/threads/thread-origin/delivery-targets/",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-Query-Delegated-Token": "delegated-origin-token",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      forgetDelegatedAuth("thread-origin");
    }
  });
});

describe("correccion de propuestas pendientes", () => {
  it("propagates action_id and merge/replace semantics for one record", () => {
    expect(
      recordProposalRequestBody({
        actionId: "348be349-a33d-11f1-a7b2-d843ae899220",
        fields: { email: "correcto@example.com" },
        replaceProposal: false,
      }),
    ).toEqual({
      action_id: "348be349-a33d-11f1-a7b2-d843ae899220",
      fields: { email: "correcto@example.com" },
      replace_proposal: false,
    });
  });

  it("propagates action_id when replacing a pending batch", () => {
    expect(
      batchProposalRequestBody({
        actionId: "348be349-a33d-11f1-a7b2-d843ae899220",
        items: [{ fields: { nombre: "Corregido" } }],
      }),
    ).toEqual({
      action_id: "348be349-a33d-11f1-a7b2-d843ae899220",
      items: [{ fields: { nombre: "Corregido" } }],
    });
  });
});

describe("containsGeneratedArtifactReference", () => {
  it("detects local generated artifacts in proposed record fields", () => {
    expect(
      containsGeneratedArtifactReference({
        fields: {
          reporte:
            "/home/ubuntu/.openclaw/workspace/tenants/query/agents/elonmusk/workspace/artifacts/reporte.html",
        },
      }),
    ).toBe(true);
  });

  it("detects public URLs that leak a server-local generated artifact path", () => {
    expect(
      containsGeneratedArtifactReference({
        fields: {
          reporte:
            "https://us.itsquery.com/home/ubuntu/.openclaw/workspace/tenants/query/agents/elonmusk/workspace/artifacts/reporte.pdf",
        },
      }),
    ).toBe(true);
  });

  it("detects Windows generated artifacts before a record proposal", () => {
    expect(
      containsGeneratedArtifactReference({
        fields: { reporte: "C:\\workspace\\query\\artifacts\\reporte.xlsx" },
      }),
    ).toBe(true);
  });

  it("does not block ordinary record data", () => {
    expect(
      containsGeneratedArtifactReference({
        title: "Estado de Resultados Query - Junio y Julio 2026",
        fields: {
          estado: "Listo",
          url: "https://apius.itsquery.com/media/public/agent_chat/reporte.pdf",
        },
      }),
    ).toBe(false);
  });
});

describe("query_attachment_send", () => {
  it("reuses the delegated uploader and returns only Query attachment metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "query-tool-attachment-"));
    const filePath = join(directory, "dashboard.html");
    await writeFile(filePath, "<h1>Query</h1>", "utf8");
    rememberDelegatedAuth(
      "thread-attachment",
      { token: "delegated-upload-token", expires_in: 900 },
      "wss://query.test/ws/openclaw-agent/8/",
      "msg-attachment",
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        id: 91,
        kind: "file",
        name: "dashboard.html",
        mime_type: "text/html",
        url: "https://query.test/media/agent_chat/dashboard.html",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    try {
      const result = (await uploadQueryAttachmentForThread({
        threadId: "thread-attachment",
        filePath,
        message: "Dashboard listo",
        log,
      })) as Record<string, unknown>;

      expect(result).toMatchObject({
        ok: true,
        thread_id: "thread-attachment",
        public_url: "https://query.test/media/agent_chat/dashboard.html",
        message: "Dashboard listo",
        attachment: {
          id: 91,
          kind: "file",
          name: "dashboard.html",
          url: "https://query.test/media/agent_chat/dashboard.html",
        },
        media: {
          url: "https://query.test/media/agent_chat/dashboard.html",
          attachments: [
            {
              id: 91,
              kind: "file",
              name: "dashboard.html",
              url: "https://query.test/media/agent_chat/dashboard.html",
            },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain(filePath);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://query.test/api/v4/openclaw-agent/threads/thread-attachment/attachments/",
        expect.objectContaining({
          method: "POST",
          headers: { "X-Query-Delegated-Token": "delegated-upload-token" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      forgetDelegatedAuth("thread-attachment");
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("cache de metadatos de modulos", () => {
  const SOCKET_URL = "wss://query.test/ws/openclaw-agent/1/";
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearQueryMetadataCache();
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ modules: ["clientes"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetDelegatedAuth("thread-cache");
    forgetDelegatedAuth("thread-otro");
    clearQueryMetadataCache();
  });

  it("no repite la misma lectura de metadatos dentro del TTL", async () => {
    rememberDelegatedAuth(
      "thread-cache",
      { token: "token-ana", expires_in: 900 },
      SOCKET_URL,
      "msg-1",
    );
    const first = await callQuery("thread-cache", "modules/", {}, "query_modules_list", log, {
      cacheable: true,
    });
    const second = await callQuery("thread-cache", "modules/", {}, "query_modules_list", log, {
      cacheable: true,
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("nunca sirve a una persona la metadata resuelta con la credencial de otra", async () => {
    rememberDelegatedAuth(
      "thread-cache",
      { token: "token-ana", expires_in: 900 },
      SOCKET_URL,
      "msg-1",
    );
    await callQuery("thread-cache", "modules/", {}, "query_modules_list", log, {
      cacheable: true,
    });
    // Mismo endpoint, otra persona: sus permisos pueden ser distintos, asi que
    // la respuesta tiene que volver a pedirse.
    rememberDelegatedAuth(
      "thread-otro",
      { token: "token-luis", expires_in: 900 },
      SOCKET_URL,
      "msg-2",
    );
    await callQuery("thread-otro", "modules/", {}, "query_modules_list", log, {
      cacheable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no cachea lo que no se marca como metadata", async () => {
    rememberDelegatedAuth(
      "thread-cache",
      { token: "token-ana", expires_in: 900 },
      SOCKET_URL,
      "msg-1",
    );
    await callQuery("thread-cache", "modules/clientes/records/", {}, "query_records_search", log);
    await callQuery("thread-cache", "modules/clientes/records/", {}, "query_records_search", log);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no cachea una respuesta de error", async () => {
    rememberDelegatedAuth(
      "thread-cache",
      { token: "token-ana", expires_in: 900 },
      SOCKET_URL,
      "msg-1",
    );
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "unavailable" }),
    });
    await callQuery("thread-cache", "modules/", {}, "query_modules_list", log, { cacheable: true });
    await callQuery("thread-cache", "modules/", {}, "query_modules_list", log, { cacheable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("query_module_categories_list pide /module-categories/, no un nombre inventado", async () => {
    // Regresion: la unica forma correcta de descubrir el id real de una
    // categoria antes de sumarle un modulo en un plan. Nada de adivinar un
    // `group` en el cuerpo de /api/v2/modulos/.
    rememberDelegatedAuth(
      "thread-cache",
      { token: "token-ana", expires_in: 900 },
      SOCKET_URL,
      "msg-1",
    );
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ id: 7, title: "Productividad", slug: "productividad", modules: [] }],
      }),
    });
    const result = await callQuery(
      "thread-cache",
      "module-categories/",
      {},
      "query_module_categories_list",
      log,
      { cacheable: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("/api/v4/openclaw-agent/module-categories/");
    expect(result).toEqual({
      results: [{ id: 7, title: "Productividad", slug: "productividad", modules: [] }],
    });
  });
});

describe("consultas estructuradas de registros", () => {
  const SOCKET_URL = "wss://query.test/ws/openclaw-agent/1/";
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  beforeEach(() => {
    rememberDelegatedAuth(
      "thread-records",
      { token: "token-registros", expires_in: 900 },
      SOCKET_URL,
      "msg-records",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetDelegatedAuth("thread-records");
  });

  it("envia filtros simultaneos y proyeccion al endpoint estructurado", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, total_matches: 2, rows: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await queryRecordsForThread(
      {
        threadId: "thread-records",
        module: "registro_de_horas",
        filters: [
          {
            field: "fecha_a_registrar_registro_horas",
            operator: "between",
            value: ["2026-08-24", "2026-08-30"],
          },
          { field: "author", operator: "eq", value: "JCVARGAS" },
        ],
        columns: ["title", "author", "fecha_a_registrar_registro_horas", "horas"],
        limit: 20,
      },
      log,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://query.test/api/v4/openclaw-agent/modules/registro_de_horas/records/query/",
    );
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      "X-Query-Delegated-Token": "token-registros",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(options.body))).toMatchObject({
      filters: [
        {
          field: "fecha_a_registrar_registro_horas",
          operator: "between",
          value: ["2026-08-24", "2026-08-30"],
        },
        { field: "author", operator: "eq", value: "JCVARGAS" },
      ],
      columns: ["title", "author", "fecha_a_registrar_registro_horas", "horas"],
      limit: 20,
    });
  });

  it("pide a Core que sume y agrupe en vez de hacerlo en el modelo", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        total_records: 2,
        rows: [{ fecha: "2026-08-24", total_horas: 70.5 }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await aggregateQueryRecordsForThread(
      {
        threadId: "thread-records",
        module: "registro_de_horas",
        filters: [{ field: "author", operator: "eq", value: "JCVARGAS" }],
        groupBy: ["fecha_a_registrar_registro_horas"],
        metrics: [{ operation: "sum", field: "horas", alias: "total_horas" }],
        dateFilters: [
          {
            field: "fecha_a_registrar_registro_horas",
            from: "2026-08-24",
            to: "2026-08-30",
          },
        ],
      },
      log,
    );

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://query.test/api/v4/openclaw-agent/modules/registro_de_horas/records/aggregate/",
    );
    expect(JSON.parse(String(options.body))).toMatchObject({
      filters: [{ field: "author", operator: "eq", value: "JCVARGAS" }],
      group_by: ["fecha_a_registrar_registro_horas"],
      metrics: [{ operation: "sum", field: "horas", alias: "total_horas" }],
      date_filters: [
        {
          field: "fecha_a_registrar_registro_horas",
          from: "2026-08-24",
          to: "2026-08-30",
        },
      ],
    });
  });

  it("conserva el GET anterior cuando solo recibe field y value", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, results: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await queryRecordsForThread(
      {
        threadId: "thread-records",
        module: "clientes",
        field: "estado",
        value: "Activo",
        pageSize: 20,
      },
      log,
    );

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(
      "https://query.test/api/v4/openclaw-agent/modules/clientes/records/?field.estado=Activo&page_size=20",
    );
    expect(options.method).toBeUndefined();
  });
});
