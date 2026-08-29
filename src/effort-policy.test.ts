import { describe, expect, it } from "vitest";
import {
  activityModeForEffort,
  effortInstruction,
  parseEffortMode,
  resolveEffortMode,
} from "./effort-policy.js";

describe("Query effort policy", () => {
  it("validates values and defaults to auto", () => {
    expect(parseEffortMode(" careful ")).toBe("careful");
    expect(parseEffortMode("unsafe")).toBeUndefined();
    expect(resolveEffortMode({ content: "hola" })).toMatchObject({
      configuredMode: "auto",
      effectiveMode: "fast",
      escalated: false,
      reason: "simple_intent",
    });
  });

  it("routes an ordinary lookup as normal", () => {
    expect(resolveEffortMode({ content: "busca este cliente" }).effectiveMode).toBe("normal");
  });

  it("never lets a fast request weaken a sensitive write", () => {
    expect(
      resolveEffortMode({
        configuredMode: "fast",
        content: "hazlo rapido y actualiza este registro",
      }),
    ).toMatchObject({
      effectiveMode: "careful",
      escalated: true,
      reason: "sensitive_write",
    });
  });

  it("uses exhaustive for audits, closes and production deploys", () => {
    for (const content of ["audita el trimestre", "haz el cierre contable", "deploy a produccion", "elimina el registro"]) {
      expect(resolveEffortMode({ content }).effectiveMode).toBe("exhaustive");
    }
  });

  it("keeps calendar modifications at least careful", () => {
    expect(
      resolveEffortMode({ configuredMode: "fast", content: "agenda una reunion mañana" }),
    ).toMatchObject({ effectiveMode: "careful", reason: "calendar_change" });
  });

  it("accepts explicit risk signals without exposing free-form reasons", () => {
    expect(
      resolveEffortMode({ configuredMode: "normal", riskSignals: ["possible duplicate"] }),
    ).toMatchObject({ effectiveMode: "careful", reason: "ambiguity_or_duplicate" });
  });

  it("coordinates activity verbosity with effective effort", () => {
    expect(activityModeForEffort("smart", "fast")).toBe("lite");
    expect(activityModeForEffort("lite", "careful")).toBe("verbose");
    expect(activityModeForEffort("off", "exhaustive")).toBe("off");
  });

  it("asks for useful public progress without exposing private reasoning", () => {
    const instruction = effortInstruction("normal");
    expect(instruction).toContain("[Modo de trabajo Query: normal.");
    expect(instruction).toContain("publica comentarios breves en primera persona");
    expect(instruction).toContain("subproblema concreto");
    expect(instruction).toContain("No uses frases vacías");
    expect(instruction).toContain("No muestres cadenas privadas de razonamiento");
  });
});
