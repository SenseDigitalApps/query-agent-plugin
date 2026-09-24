import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
vi.mock("./cron-sync.js", () => ({primeScheduleCredential: vi.fn()}));
vi.mock("./scheduled-context.js", () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => undefined}}));
import entry from "./query-tools.js";
import {getToolPluginMetadata} from "openclaw/plugin-sdk/tool-plugin";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
describe("Query installed tool contract", () => {
  it("declares every implemented tool in the real manifest", () => {
    const declared = new Set(manifest.contracts.tools);
    const implemented = getToolPluginMetadata(entry)!.tools.map(t => t.name);
    expect(implemented.filter(name => !declared.has(name))).toEqual([]);
    expect(declared.size).toBe(manifest.contracts.tools.length);
  });
  it("registers SMTP and private tools against the manifest boundary", () => {
    const declared = new Set(manifest.contracts.tools);
    const accepted: string[] = [];
    const rejected: string[] = [];
    entry.register({registerTool: (tool: any, opts: any) => {
      const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : []), ...(typeof tool === "function" ? [] : [tool.name])];
      for (const name of names) (declared.has(name) ? accepted : rejected).push(name);
    }, pluginConfig: {}, logger: {info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
    expect(rejected).toEqual([]);
    expect(accepted.filter(n => n.startsWith("query_smtp_")).length).toBe(7);
    expect(accepted.filter(n => n.startsWith("query_private_")).length).toBe(4);
  });
});
