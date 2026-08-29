import { describe, expect, it } from "vitest";
import { stripOpenClawControlAnnotations } from "./public-text.js";

describe("stripOpenClawControlAnnotations", () => {
  it("removes chained Fast runtime annotations from the public answer", () => {
    expect(
      stripOpenClawControlAnnotations(
        "💨Fast: auto-off(161s>=60s)💨Fast: auto-onRetomé la escena 00.",
      ),
    ).toBe("Retomé la escena 00.");
  });

  it("removes an annotation from an accumulated partial draft", () => {
    expect(
      stripOpenClawControlAnnotations(
        "Ya revisé los datos. 💨️ Fast: auto-off(75s >= 60s) Continúo con el informe.",
      ),
    ).toBe("Ya revisé los datos.  Continúo con el informe.");
  });

  it("preserves legitimate prose about Fast and unrelated wind emoji", () => {
    const text = "Fast: auto-on es una opción documentada. 💨 Seguimos avanzando.";
    expect(stripOpenClawControlAnnotations(text)).toBe(text);
  });
});
