import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetDelegatedAuth, rememberDelegatedAuth } from "./delegated-store.js";
import {
  callQuery,
  clearQueryMetadataCache,
  containsGeneratedArtifactReference,
} from "./query-tools.js";

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
});
