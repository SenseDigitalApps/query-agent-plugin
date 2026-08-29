import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localArtifactPathForPrivateUrl,
  redactUnsafeArtifactReferences,
  rewritePrivateArtifactLinks,
} from "./private-links.js";

const previousRoots = process.env.QUERY_PRIVATE_LINK_ROOTS;

afterEach(() => {
  if (previousRoots === undefined) {
    delete process.env.QUERY_PRIVATE_LINK_ROOTS;
  } else {
    process.env.QUERY_PRIVATE_LINK_ROOTS = previousRoots;
  }
});

async function tempArtifact(name: string, body = "<h1>ok</h1>") {
  const dir = await mkdtemp(join(tmpdir(), "query-private-links-"));
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  process.env.QUERY_PRIVATE_LINK_ROOTS = dir;
  return { dir, path };
}

describe("localArtifactPathForPrivateUrl", () => {
  it("maps a private preview URL to a configured local artifact root", async () => {
    const { path } = await tempArtifact("reporte.html");
    await expect(
      localArtifactPathForPrivateUrl("http://100.114.172.42:8787/reporte.html"),
    ).resolves.toBe(path);
  });

  it("ignores public URLs", async () => {
    await tempArtifact("reporte.html");
    await expect(
      localArtifactPathForPrivateUrl("https://apius.itsquery.com/media/public/reporte.html"),
    ).resolves.toBeUndefined();
  });

  it("finds generated artifacts by filename when a preview server flattens the route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "query-private-links-"));
    const nested = join(dir, "comercial", "propuestas", "_backups", "generated-public-html");
    await mkdir(nested, { recursive: true });
    const path = join(nested, "propuesta.html");
    await writeFile(path, "<h1>ok</h1>", "utf8");
    process.env.QUERY_PRIVATE_LINK_ROOTS = dir;

    await expect(
      localArtifactPathForPrivateUrl("http://100.114.172.42:8787/propuesta.html"),
    ).resolves.toBe(path);
  });
});

describe("rewritePrivateArtifactLinks", () => {
  it("uploads private links, replaces them with the official Query URL, and returns attachments", async () => {
    const { path } = await tempArtifact("dashboard.html");
    const upload = vi.fn(async () => ({
      kind: "file",
      name: "dashboard.html",
      url: "https://apius.itsquery.com/media/public/agent_chat/dashboard.html",
    }));

    const result = await rewritePrivateArtifactLinks({
      text: "Listo: http://100.114.172.42:8787/dashboard.html",
      upload,
    });

    expect(upload).toHaveBeenCalledWith(path, "http://100.114.172.42:8787/dashboard.html");
    expect(result.text).toBe(
      "Listo: https://apius.itsquery.com/media/public/agent_chat/dashboard.html",
    );
    expect(result.attachments).toHaveLength(1);
  });

  it("leaves public Query media URLs untouched", async () => {
    const publicUrl = "https://apius.itsquery.com/media/public/agent_chat/24/reporte.html";
    const upload = vi.fn(async () => {
      throw new Error("public URLs should not be uploaded");
    });

    const result = await rewritePrivateArtifactLinks({
      text: `Listo: ${publicUrl}`,
      upload,
    });

    expect(upload).not.toHaveBeenCalled();
    expect(result.text).toBe(`Listo: ${publicUrl}`);
    expect(result.attachments).toHaveLength(0);
    expect(result.blockedUrls).toHaveLength(0);
  });

  it("uploads local absolute paths embedded in Markdown links", async () => {
    const { path } = await tempArtifact("estado-resultados.pdf");
    const upload = vi.fn(async () => ({
      kind: "file",
      name: "estado-resultados.pdf",
      url: "https://apius.itsquery.com/media/public/agent_chat/estado-resultados.pdf",
    }));

    const result = await rewritePrivateArtifactLinks({
      text: `Archivo: [estado-resultados.pdf](${path})`,
      upload,
    });

    expect(upload).toHaveBeenCalledWith(path, path);
    expect(result.text).toBe(
      "Archivo: [estado-resultados.pdf](https://apius.itsquery.com/media/public/agent_chat/estado-resultados.pdf)",
    );
    expect(result.attachments).toHaveLength(1);
  });

  it("uploads public URLs that accidentally contain a server-local absolute path", async () => {
    const { path } = await tempArtifact("estado-resultados-query-junio-julio-2026.pdf");
    const leakedUrl = `https://us.itsquery.com${path}`;
    const upload = vi.fn(async () => ({
      kind: "file",
      name: "estado-resultados-query-junio-julio-2026.pdf",
      url: "https://apius.itsquery.com/media/public/agent_chat/estado-resultados-query-junio-julio-2026.pdf",
    }));

    const result = await rewritePrivateArtifactLinks({
      text: `Mira ${leakedUrl}`,
      upload,
    });

    expect(upload).toHaveBeenCalledWith(path, leakedUrl);
    expect(result.text).toBe(
      "Mira https://apius.itsquery.com/media/public/agent_chat/estado-resultados-query-junio-julio-2026.pdf",
    );
    expect(result.text).not.toContain("https://us.itsquery.com/home");
    expect(result.attachments).toHaveLength(1);
  });

  it("removes unresolved private links instead of leaking them", async () => {
    const result = await rewritePrivateArtifactLinks({
      text: "Mira http://127.0.0.1:8787/no-existe.html",
      upload: async () => {
        throw new Error("should not upload");
      },
    });

    expect(result.text).not.toContain("127.0.0.1");
    expect(result.blockedUrls).toEqual(["http://127.0.0.1:8787/no-existe.html"]);
  });

  it("keeps punctuation outside uploaded private URL replacements", async () => {
    await tempArtifact("deck.html");
    const upload = vi.fn(async () => ({
      kind: "file",
      name: "deck.html",
      url: "https://apius.itsquery.com/media/public/agent_chat/deck.html",
    }));

    const result = await rewritePrivateArtifactLinks({
      text: "Listo: http://100.114.172.42:8787/deck.html.",
      upload,
    });

    expect(upload).toHaveBeenCalledWith(
      expect.stringContaining("deck.html"),
      "http://100.114.172.42:8787/deck.html",
    );
    expect(result.text).toBe(
      "Listo: https://apius.itsquery.com/media/public/agent_chat/deck.html.",
    );
  });

  it("blocks private links when upload fails", async () => {
    await tempArtifact("fallo.html");
    const result = await rewritePrivateArtifactLinks({
      text: "Mira http://100.114.172.42:8787/fallo.html",
      upload: async () => {
        throw new Error("upload failed");
      },
    });

    expect(result.text).not.toContain("100.114.172.42");
    expect(result.blockedUrls).toEqual(["http://100.114.172.42:8787/fallo.html"]);
  });

  it.each([
    "http://localhost:8787/reporte.pdf",
    "http://0.0.0.0:3000/reporte.pdf",
    "http://10.20.30.40/reporte.pdf",
    "http://172.20.0.8/reporte.pdf",
    "http://192.168.1.9/reporte.pdf",
    "http://100.100.10.20/reporte.pdf",
    "https://agente.tailnet-name.ts.net/reporte.pdf",
  ])("never exposes private delivery URL %s", async (privateUrl) => {
    const result = await rewritePrivateArtifactLinks({
      text: `Archivo listo: ${privateUrl}`,
      upload: async () => {
        throw new Error("unavailable");
      },
    });

    expect(result.text).not.toContain(privateUrl);
    expect(result.blockedUrls).toEqual([privateUrl]);
  });

  it("removes unresolved Linux and Windows paths", async () => {
    const linux = "/tmp/query/no-existe/reporte.pdf";
    const windows = "C:\\workspace\\query\\reporte.xlsx";
    const result = await rewritePrivateArtifactLinks({
      text: `Linux: ${linux}\nWindows: ${windows}`,
      upload: async () => {
        throw new Error("should not upload missing files");
      },
    });

    expect(result.text).not.toContain(linux);
    expect(result.text).not.toContain(windows);
    expect(result.blockedUrls).toEqual([linux, windows]);
  });

  it("blocks a fabricated public URL with an unresolved local path", async () => {
    const leakedUrl = "https://downloads.example.com/home/ubuntu/workspace/no-existe.html";
    const result = await rewritePrivateArtifactLinks({
      text: `Mira ${leakedUrl}`,
      upload: async () => {
        throw new Error("should not upload missing files");
      },
    });

    expect(result.text).not.toContain(leakedUrl);
    expect(result.blockedUrls).toEqual([leakedUrl]);
  });
});

describe("redactUnsafeArtifactReferences", () => {
  it("protects streamed drafts without changing public URLs", () => {
    const publicUrl = "https://query.test/media/reporte.pdf";
    const draft = redactUnsafeArtifactReferences(
      `Linux: /tmp/query/reporte.pdf Windows: C:\\workspace\\reporte.xlsx ` +
        `Privado: http://127.0.0.1:8000/reporte.pdf Público: ${publicUrl}`,
    );

    expect(draft).not.toContain("/tmp/query/reporte.pdf");
    expect(draft).not.toContain("C:\\workspace\\reporte.xlsx");
    expect(draft).not.toContain("127.0.0.1");
    expect(draft).toContain(publicUrl);
    expect(draft).toContain("[archivo pendiente de adjuntar]");
  });
});
