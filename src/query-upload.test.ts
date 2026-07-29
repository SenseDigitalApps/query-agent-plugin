import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { queryAttachmentForMediaUrl } from "./media.js";
import {
  isLocalArtifactPath,
  QueryUploadError,
  queryUploadUrlFor,
  uploadArtifactToQuery,
} from "./query-upload.js";

async function writeArtifact(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "query-artifact-"));
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}

describe("isLocalArtifactPath", () => {
  it("treats any absolute workspace path as local, not just the media folder", () => {
    // Es la ruta que llegaba al navegador como enlace roto.
    expect(
      isLocalArtifactPath(
        "/home/ubuntu/.openclaw/workspace/tenants/query/workspace/outputs/test-adjuntos.html",
      ),
    ).toBe(true);
    expect(isLocalArtifactPath("C:\\Users\\agent\\outputs\\dashboard.html")).toBe(true);
  });

  it("leaves anything already servible alone", () => {
    expect(isLocalArtifactPath("https://query.test/media/x.html")).toBe(false);
    expect(isLocalArtifactPath("data:text/html;base64,PGgxPg==")).toBe(false);
    expect(isLocalArtifactPath("relative/path.html")).toBe(false);
    expect(isLocalArtifactPath("")).toBe(false);
  });
});

describe("queryUploadUrlFor", () => {
  it("derives the ingest endpoint from the configured socket url", () => {
    expect(queryUploadUrlFor("wss://apius.itsquery.com/ws/openclaw-agent/3/?token=x", 42)).toBe(
      "https://apius.itsquery.com/api/v4/openclaw-agent/threads/42/attachments/",
    );
    expect(queryUploadUrlFor("ws://localhost:8000/ws/openclaw-agent/1/?token=x", 7)).toBe(
      "http://localhost:8000/api/v4/openclaw-agent/threads/7/attachments/",
    );
  });

  it("never carries the pairing credential into the http url", () => {
    const url = queryUploadUrlFor("wss://q.test/ws/openclaw-agent/3/?token=secreto", 1);
    expect(url).not.toContain("secreto");
  });
});

describe("uploadArtifactToQuery", () => {
  it("sends the file with the delegated token and returns the official url", async () => {
    const path = await writeArtifact("dashboard.html", "<h1>hola</h1>");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 9,
          kind: "file",
          name: "dashboard.html",
          mime_type: "text/html",
          size: 13,
          url: "https://q.test/media/agent_chat/dashboard.html",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    const attachment = await uploadArtifactToQuery({
      uploadUrl: "https://q.test/api/v4/openclaw-agent/threads/1/attachments/",
      token: "delegado",
      path,
      attachment: queryAttachmentForMediaUrl(path),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(attachment.url).toBe("https://q.test/media/agent_chat/dashboard.html");
    expect(attachment.mime_type).toBe("text/html");
    expect(attachment.kind).toBe("file");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Query-Delegated-Token"]).toBe("delegado");
    const form = init.body as FormData;
    expect(form.get("kind")).toBe("file");
    expect(form.get("mime_type")).toBe("text/html");
    expect((form.get("file") as File).name).toBe("dashboard.html");
  });

  it("flags an expired credential so the caller can renew and retry", async () => {
    const path = await writeArtifact("late.html", "<p>tarde</p>");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "token_expired", detail: "expiro" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = await uploadArtifactToQuery({
      uploadUrl: "https://q.test/upload/",
      token: "viejo",
      path,
      attachment: queryAttachmentForMediaUrl(path),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(QueryUploadError);
    expect((failure as QueryUploadError).code).toBe("token_expired");
    expect((failure as QueryUploadError).isExpiredCredential).toBe(true);
  });

  it("does not treat a missing scope as something a retry would fix", async () => {
    const path = await writeArtifact("denied.html", "<p>no</p>");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "scope_missing" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = (await uploadArtifactToQuery({
      uploadUrl: "https://q.test/upload/",
      token: "sin-scope",
      path,
      attachment: queryAttachmentForMediaUrl(path),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((error) => error)) as QueryUploadError;

    expect(failure.code).toBe("scope_missing");
    expect(failure.isExpiredCredential).toBe(false);
  });
});
