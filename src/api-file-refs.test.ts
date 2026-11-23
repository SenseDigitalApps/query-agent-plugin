import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandFileRefs } from "./api-file-refs.js";

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), "qref-"));
  await writeFile(path.join(dir, "doc.pdf"), "%PDF-1.4 hola");
  return dir;
}

describe("expandFileRefs", () => {
  it("deja intacto un body sin referencias", async () => {
    const body = { a: 1, b: ["x", { c: "y" }] };
    expect(await expandFileRefs(body, undefined)).toEqual({ ok: true, body });
  });

  it("reemplaza la referencia por el base64 del archivo", async () => {
    const dir = await workspace();
    const r = await expandFileRefs({ Attachments: [{ FileName: "doc.pdf", RawContent: { $file_base64: "doc.pdf" } }] }, dir);
    expect(r).toEqual({ ok: true, body: { Attachments: [{ FileName: "doc.pdf", RawContent: Buffer.from("%PDF-1.4 hola").toString("base64") }] } });
  });

  it("acepta rutas absolutas dentro del workspace", async () => {
    const dir = await workspace();
    const r = await expandFileRefs({ f: { $file_base64: path.join(dir, "doc.pdf") } }, dir);
    expect(r.ok).toBe(true);
  });

  it("rechaza archivos fuera del workspace, también por enlace simbólico", async () => {
    const dir = await workspace();
    expect(await expandFileRefs({ f: { $file_base64: "/etc/hostname" } }, dir)).toMatchObject({ ok: false, error: "file_ref_outside_workspace" });
    await symlink("/etc/hostname", path.join(dir, "link"));
    expect(await expandFileRefs({ f: { $file_base64: "link" } }, dir)).toMatchObject({ ok: false, error: "file_ref_outside_workspace" });
    expect(await expandFileRefs({ f: { $file_base64: "../x" } }, dir)).toMatchObject({ ok: false });
  });

  it("exige workspace conocido y archivo existente", async () => {
    expect(await expandFileRefs({ f: { $file_base64: "doc.pdf" } }, undefined)).toMatchObject({ ok: false, error: "file_ref_workspace_unknown" });
    const dir = await workspace();
    expect(await expandFileRefs({ f: { $file_base64: "nada.pdf" } }, dir)).toMatchObject({ ok: false, error: "file_ref_not_found" });
  });

  it("no trata como referencia un objeto con más claves", async () => {
    const body = { f: { $file_base64: "doc.pdf", otra: 1 } };
    expect(await expandFileRefs(body, undefined)).toEqual({ ok: true, body });
  });
});
