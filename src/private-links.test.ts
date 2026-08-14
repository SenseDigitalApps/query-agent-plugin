import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localArtifactPathForPrivateUrl,
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
});
