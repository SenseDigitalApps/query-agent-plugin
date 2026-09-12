import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetArtifact,
  rememberArtifact,
  rememberedArtifact,
  resetArtifactStore,
} from "./artifact-store.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "query-artifacts-"));
  process.env.QUERY_ARTIFACT_STATE_FILE = join(directory, "artifacts.json");
  resetArtifactStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.QUERY_ARTIFACT_STATE_FILE;
  delete process.env.QUERY_ARTIFACT_REUSE_TTL_MS;
  resetArtifactStore();
  await rm(directory, { recursive: true, force: true });
});

const REPORT = "/home/agent/workspace/artifacts/reporte.html";

describe("memoria de artifacts subidos", () => {
  it("no recuerda una ruta que nunca se subio", () => {
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();
  });

  it("devuelve el asset que ya salio de esa ruta", () => {
    rememberArtifact("thread-1", REPORT, 42);
    expect(rememberedArtifact("thread-1", REPORT)).toBe(42);
  });

  it("no comparte el asset entre hilos distintos", () => {
    rememberArtifact("thread-1", REPORT, 42);
    // El mismo archivo en otro canal es otro adjunto, con los permisos de ese
    // canal: reutilizar el id lo filtraria de un sitio a otro.
    expect(rememberedArtifact("thread-2", REPORT)).toBeUndefined();
  });

  it("distingue dos archivos del mismo hilo", () => {
    rememberArtifact("thread-1", REPORT, 42);
    rememberArtifact("thread-1", "/home/agent/workspace/artifacts/otro.pdf", 43);
    expect(rememberedArtifact("thread-1", REPORT)).toBe(42);
    expect(
      rememberedArtifact("thread-1", "/home/agent/workspace/artifacts/otro.pdf"),
    ).toBe(43);
  });

  it("la ultima subida manda sobre la anterior", () => {
    rememberArtifact("thread-1", REPORT, 42);
    rememberArtifact("thread-1", REPORT, 77);
    expect(rememberedArtifact("thread-1", REPORT)).toBe(77);
  });

  it("olvidar una ruta obliga a crear un asset nuevo", () => {
    rememberArtifact("thread-1", REPORT, 42);
    forgetArtifact("thread-1", REPORT);
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();
  });

  it("ignora un id vacio en vez de guardar basura", () => {
    rememberArtifact("thread-1", REPORT, undefined);
    rememberArtifact("thread-1", REPORT, null);
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();
  });

  it("sobrevive a un reinicio del gateway", () => {
    rememberArtifact("thread-1", REPORT, 42);
    // El agente sigue con el mismo archivo abierto despues de reiniciar; sin
    // persistencia cada arranque devolveria el problema que esto resuelve.
    resetArtifactStore();
    expect(rememberedArtifact("thread-1", REPORT)).toBe(42);
  });

  it("por defecto no caduca: el mismo archivo sigue siendo el mismo asset", () => {
    rememberArtifact("thread-1", REPORT, 42);
    resetArtifactStore();
    // Sin plazo de por medio, trabajar sobre el archivo una semana despues
    // sigue reemplazando en vez de repartir copias que nadie pidio.
    expect(rememberedArtifact("thread-1", REPORT)).toBe(42);
  });

  it("conservar la version anterior es una decision explicita", () => {
    rememberArtifact("thread-1", REPORT, 42);
    // Lo que hace `query_artifact_new_version`: a partir de aqui el siguiente
    // envio crea un asset nuevo y el 42 se queda como estaba.
    forgetArtifact("thread-1", REPORT);
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();

    rememberArtifact("thread-1", REPORT, 43);
    expect(rememberedArtifact("thread-1", REPORT)).toBe(43);
  });

  it("admite un limite de reuso para quien lo quiera", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    rememberArtifact("thread-1", REPORT, 42);
    process.env.QUERY_ARTIFACT_REUSE_TTL_MS = "1";
    clock.mockReturnValue(now + 2);
    resetArtifactStore();
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();
  });

  it("un estado corrupto en disco no impide mandar el archivo", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.env.QUERY_ARTIFACT_STATE_FILE!, "{no es json");
    resetArtifactStore();
    expect(() => rememberedArtifact("thread-1", REPORT)).not.toThrow();
    expect(rememberedArtifact("thread-1", REPORT)).toBeUndefined();
  });
});
