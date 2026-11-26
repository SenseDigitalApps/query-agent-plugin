import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Codex entrega una guía con skills_read solo si cabe entera en 64000 caracteres
// ponderados; si no, la lectura falla y la tarea programada se detiene (LinkedIn,
// 26-nov-2026); además recorta la salida cerca de 47000 (query-panel con 49000 perdió
// el final). Se deja margen para el envoltorio y el crecimiento normal.
const MAX_SKILL_CHARS = 42_000;
const skillsDir = join(__dirname, "..", "skills");

describe("tamaño de las guías del plugin", () => {
  for (const name of readdirSync(skillsDir)) {
    it(`${name} cabe en el presupuesto de skills_read`, () => {
      const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    });
  }

  it("query-panel enumera todos sus anexos", () => {
    const core = readFileSync(join(skillsDir, "query-panel", "SKILL.md"), "utf8");
    for (const name of readdirSync(skillsDir).filter((n) => n.startsWith("query-panel-"))) {
      expect(core).toContain(`\`${name}\``);
    }
  });
});
