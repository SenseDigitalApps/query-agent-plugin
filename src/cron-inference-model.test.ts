import { describe, expect, it } from "vitest";
import { recordedInferenceModel } from "./cron-sync.js";

const api = (cfg: unknown) => ({ runtime: { config: { current: () => cfg } } }) as never;
const profiles = { "openai:juli@example.com": { provider: "openai" }, "anthropic:x": { provider: "anthropic" } };

describe("recordedInferenceModel", () => {
  it("fija el modelo del agente con el único perfil de su proveedor", () => {
    const cfg = { agents: { entries: { cristiano: { model: "openai/gpt-6.1-sol" } } }, auth: { profiles } };
    expect(recordedInferenceModel(api(cfg), "cristiano")).toBe("openai/gpt-6.1-sol@openai:juli@example.com");
  });
  it("usa el modelo por defecto y acepta { primary }", () => {
    const cfg = { agents: { entries: { a: {} }, defaults: { model: { primary: "openai/gpt-6.1-sol" } } }, auth: { profiles } };
    expect(recordedInferenceModel(api(cfg), "a")).toBe("openai/gpt-6.1-sol@openai:juli@example.com");
  });
  it("no adivina con varios perfiles, sin perfil o con cuenta ya fijada", () => {
    const two = { ...profiles, "openai:otra": { provider: "openai" } };
    expect(recordedInferenceModel(api({ agents: { entries: { a: { model: "openai/m" } } }, auth: { profiles: two } }), "a")).toBeUndefined();
    expect(recordedInferenceModel(api({ agents: { entries: { a: { model: "google/m" } } }, auth: { profiles } }), "a")).toBeUndefined();
    expect(recordedInferenceModel(api({ agents: { entries: { a: { model: "openai/m@p" } } }, auth: { profiles } }), "a")).toBeUndefined();
  });
});
