import { describe, expect, it } from "vitest";
import { inferenceBindingCommand, recordedInferenceModel } from "./cron-sync.js";

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

describe("inferenceBindingCommand", () => {
  const id = "df0c8730-f5d2-48d4-86d9-f46bf002b501";
  it("usa el Node y el CLI del Gateway en ejecución", () => {
    expect(inferenceBindingCommand(id, "openai/gpt-6.1-sol@openai:juli@example.com", "/node", "/x/openclaw/dist/index.js"))
      .toEqual({ command: "/node", args: ["/x/openclaw/dist/index.js", "cron", "edit", id, "--model", "openai/gpt-6.1-sol@openai:juli@example.com"] });
  });
  it("rechaza ids o modelos que no son seguros para la línea de comandos", () => {
    expect(inferenceBindingCommand("x; rm -rf /", "openai/m@p", "/node", "/x/openclaw/dist/index.js")).toBeUndefined();
    expect(inferenceBindingCommand(id, "openai/m", "/node", "/x/openclaw/dist/index.js")).toBeUndefined();
    expect(inferenceBindingCommand(id, "openai/m@p --x;y", "/node", "/x/openclaw/dist/index.js")).toBeUndefined();
    expect(inferenceBindingCommand(id, "openai/m@p", "/node", "")).toBeUndefined();
    expect(inferenceBindingCommand(id, "openai/m@p", "/node", "/tmp/other/process.js")).toBeUndefined();
  });
});
