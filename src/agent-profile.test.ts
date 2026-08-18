import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyQuerySection,
  QUERY_SECTION_BEGIN,
  QUERY_SECTION_END,
  readSeedCandidates,
  writeAgentProfileFiles,
} from "./agent-profile.js";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "query-agent-profile-"));
}

describe("applyQuerySection", () => {
  it("agrega la seccion cuando el archivo aun no la tiene", () => {
    const result = applyQuerySection("# Mi agente\n\nNotas mias.\n", "Directo y breve.");
    expect(result).toBe(
      `# Mi agente\n\nNotas mias.\n\n${QUERY_SECTION_BEGIN}\nDirecto y breve.\n${QUERY_SECTION_END}\n`,
    );
  });

  it("reemplaza solo la seccion y conserva lo escrito a mano alrededor", () => {
    const existing = [
      "Antes.",
      "",
      QUERY_SECTION_BEGIN,
      "Version vieja.",
      QUERY_SECTION_END,
      "",
      "Despues.",
      "",
    ].join("\n");

    const result = applyQuerySection(existing, "Version nueva.");

    expect(result).toContain("Antes.");
    expect(result).toContain("Despues.");
    expect(result).toContain("Version nueva.");
    expect(result).not.toContain("Version vieja.");
  });

  it("quita la seccion entera cuando el campo se vacia", () => {
    const existing = [
      "Antes.",
      "",
      QUERY_SECTION_BEGIN,
      "Se va.",
      QUERY_SECTION_END,
      "",
      "Despues.",
      "",
    ].join("\n");

    const result = applyQuerySection(existing, "   ");

    expect(result).toBe("Antes.\n\nDespues.\n");
    expect(result).not.toContain(QUERY_SECTION_BEGIN);
  });

  it("deja el archivo vacio si solo contenia la seccion y se vacio el campo", () => {
    const existing = `${QUERY_SECTION_BEGIN}\nAlgo.\n${QUERY_SECTION_END}\n`;
    expect(applyQuerySection(existing, "")).toBe("");
  });

  it("no toca un archivo sin seccion cuando no hay nada que escribir", () => {
    expect(applyQuerySection("Solo mis notas.\n", "")).toBe("Solo mis notas.\n");
  });

  it("es idempotente: reaplicar el mismo texto no cambia el archivo", () => {
    const once = applyQuerySection("Base.\n", "Tono calido.");
    expect(applyQuerySection(once, "Tono calido.")).toBe(once);
  });
});

describe("writeAgentProfileFiles", () => {
  it("escribe personalidad en SOUL.md y mision en IDENTITY.md", async () => {
    const workspaceDir = await tempWorkspace();

    const results = await writeAgentProfileFiles({
      workspaceDir,
      profile: { personality: "Directo.", mission: "Ayudar a ventas." },
    });

    expect(results.every((result) => result.changed)).toBe(true);
    await expect(readFile(join(workspaceDir, "SOUL.md"), "utf8")).resolves.toContain(
      "Directo.",
    );
    await expect(
      readFile(join(workspaceDir, "IDENTITY.md"), "utf8"),
    ).resolves.toContain("Ayudar a ventas.");
  });

  it("no crea archivos cuando el perfil llega vacio", async () => {
    const workspaceDir = await tempWorkspace();

    const results = await writeAgentProfileFiles({
      workspaceDir,
      profile: { personality: "", mission: "" },
    });

    expect(results.every((result) => !result.changed)).toBe(true);
    expect(existsSync(join(workspaceDir, "SOUL.md"))).toBe(false);
    expect(existsSync(join(workspaceDir, "IDENTITY.md"))).toBe(false);
  });

  it("respeta lo que el operador escribio a mano en SOUL.md", async () => {
    const workspaceDir = await tempWorkspace();
    const soulPath = join(workspaceDir, "SOUL.md");
    await writeFile(soulPath, "# Reglas propias\n\nNunca uses emojis.\n", "utf8");

    await writeAgentProfileFiles({
      workspaceDir,
      profile: { personality: "Directo." },
    });

    const soul = await readFile(soulPath, "utf8");
    expect(soul).toContain("Nunca uses emojis.");
    expect(soul).toContain("Directo.");
  });

  it("no reescribe el archivo cuando el contenido no cambio", async () => {
    const workspaceDir = await tempWorkspace();
    const profile = { personality: "Directo." };

    await writeAgentProfileFiles({ workspaceDir, profile });
    const second = await writeAgentProfileFiles({ workspaceDir, profile });

    expect(second.find((result) => result.file === "SOUL.md")?.changed).toBe(false);
  });

  it("borra la seccion de Query cuando la personalidad se vacia desde el panel", async () => {
    const workspaceDir = await tempWorkspace();
    const soulPath = join(workspaceDir, "SOUL.md");

    await writeAgentProfileFiles({
      workspaceDir,
      profile: { personality: "Directo." },
    });
    await writeAgentProfileFiles({ workspaceDir, profile: { personality: "" } });

    const soul = await readFile(soulPath, "utf8");
    expect(soul).not.toContain("Directo.");
    expect(soul).not.toContain(QUERY_SECTION_BEGIN);
  });
});

describe("precedencia de la seccion de Query", () => {
  it("antepone la linea de precedencia al texto del panel", () => {
    const result = applyQuerySection("Base.\n", "Directo.", "Esto manda.");

    expect(result).toContain("Esto manda.");
    expect(result.indexOf("Esto manda.")).toBeLessThan(
      result.indexOf("Directo."),
    );
  });

  it("no deja la linea de precedencia huerfana cuando no hay texto", () => {
    const result = applyQuerySection("Base.\n", "", "Esto manda.");

    expect(result).toBe("Base.\n");
    expect(result).not.toContain("Esto manda.");
  });

  it("sigue siendo idempotente con precedencia", () => {
    const once = applyQuerySection("Base.\n", "Directo.", "Esto manda.");
    expect(applyQuerySection(once, "Directo.", "Esto manda.")).toBe(once);
  });

  it("SOUL.md e IDENTITY.md declaran que mandan sobre lo anterior", async () => {
    const workspaceDir = await tempWorkspace();
    await writeFile(
      join(workspaceDir, "SOUL.md"),
      "# SOUL.md\n\nBe clear and institutional.\n",
      "utf8",
    );

    await writeAgentProfileFiles({
      workspaceDir,
      profile: { personality: "Directo.", mission: "Ayudar a ventas." },
    });

    const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");

    // Lo escrito a mano sigue ahi, pero deja de ser la ultima palabra.
    expect(soul).toContain("Be clear and institutional.");
    expect(soul).toContain("si se contradicen");
    expect(soul.indexOf("Be clear and institutional.")).toBeLessThan(
      soul.indexOf("Directo."),
    );
    expect(identity).toContain("si se contradicen");
  });
});

describe("siembra desde el workspace", () => {
  it("ofrece lo que el agente ya tenia escrito", async () => {
    const dir = await tempWorkspace();
    await writeFile(join(dir, "SOUL.md"), "# SOUL.md\n\nYou are Elon, a specialized agent.\n", "utf8");

    const seed = await readSeedCandidates(dir);

    expect(seed.personality).toContain("You are Elon, a specialized agent.");
    expect(seed.mission).toBeUndefined();
  });

  it("no ofrece nada si Query ya administro el archivo", async () => {
    const dir = await tempWorkspace();
    await writeAgentProfileFiles({
      workspaceDir: dir,
      profile: { personality: "Directo." },
    });
    await writeAgentProfileFiles({ workspaceDir: dir, profile: { personality: "" } });

    // El archivo quedo sin seccion, pero Query ya paso por aqui: que el panel
    // este vacio es una decision, no un vacio por llenar.
    const seed = await readSeedCandidates(dir);
    expect(seed.personality).toBeUndefined();
  });

  it("no ofrece nada cuando no hay archivos", async () => {
    const seed = await readSeedCandidates(await tempWorkspace());
    expect(seed).toEqual({});
  });

  it("al devolver lo sembrado no lo duplica: el archivo colapsa en la seccion", async () => {
    const dir = await tempWorkspace();
    await writeFile(join(dir, "SOUL.md"), "# SOUL.md\n\nYou are Elon, a specialized agent.\n", "utf8");

    const seed = await readSeedCandidates(dir);
    await writeAgentProfileFiles({
      workspaceDir: dir,
      profile: { personality: seed.personality },
    });

    const soul = await readFile(join(dir, "SOUL.md"), "utf8");
    const veces = soul.split("You are Elon, a specialized agent.").length - 1;
    expect(veces).toBe(1);
    expect(soul.startsWith(QUERY_SECTION_BEGIN)).toBe(true);
  });

  it("la migracion de la siembra es idempotente", async () => {
    const dir = await tempWorkspace();
    await writeFile(join(dir, "SOUL.md"), "# SOUL.md\n\nYou are Elon, a specialized agent.\n", "utf8");

    const seed = await readSeedCandidates(dir);
    const profile = { personality: seed.personality };
    await writeAgentProfileFiles({ workspaceDir: dir, profile });
    const once = await readFile(join(dir, "SOUL.md"), "utf8");

    const again = await writeAgentProfileFiles({ workspaceDir: dir, profile });

    expect(again.find((r) => r.file === "SOUL.md")?.changed).toBe(false);
    expect(await readFile(join(dir, "SOUL.md"), "utf8")).toBe(once);
  });
});
