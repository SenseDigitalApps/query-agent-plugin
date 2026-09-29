import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
vi.mock("./cron-sync.js", () => ({primeScheduleCredential: vi.fn()}));
vi.mock("./scheduled-context.js", () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => undefined}}));
vi.mock("./delegated-store.js", () => ({getDelegatedAuth: () => ({auth: {token: "delegated-test"}, socketUrl: "wss://query.test/ws/"}), peekDelegatedAuth: () => undefined, delegatedAuthStoreDiagnostics: () => ({keys: [], stateFile: "test"}), rememberDelegatedAuth: vi.fn(), threadsWithDelegatedAuth: () => []}));
import entry from "./query-tools.js";
import {getToolPluginMetadata} from "openclaw/plugin-sdk/tool-plugin";

afterEach(() => vi.unstubAllGlobals());
const items = [{module_id: 8, record_id: 9}, {module_id: 8, record_id: 10}];
function registered(action: string) {
  const registerTool = vi.fn();
  entry.register({registerTool, pluginConfig: {}, logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}} as any);
  return registerTool.mock.calls.find(call => call[1]?.name === `query_billing_${action}`)![0]({sessionKey: "billing-test"});
}

describe("Matias agent bridge", () => {
  it("registers all five tools in the real manifest with bounded batches", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const tools = getToolPluginMetadata(entry)!.tools.filter(t => t.name.startsWith("query_billing_"));
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(manifest.contracts.tools).toContain(tool.name);
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.properties!.items.maxItems).toBe(50);
      expect(tool.parameters.properties).not.toHaveProperty("confirm_not_in_matias");
      expect(tool.parameters.properties).not.toHaveProperty("fields");
    }
    expect(tools.find(t => t.name === "query_billing_emit")!.parameters.required).toContain("user_request");
  });

  it.each(["availability", "status", "emit", "reconcile", "documents"])("forwards %s only to the authenticated agent bridge", async action => {
    const fetchMock = vi.fn(async () => ({ok: true, json: async () => ({results: [{outcome: "queued", emitted: false}, {outcome: "invalid", emitted: false}]})}));
    vi.stubGlobal("fetch", fetchMock);
    const params = {thread_id: "42", items, ...(action === "emit" ? {user_request: "Emite los dos"} : {}), ...(action === "documents" ? {formats: ["pdf", "xml"]} : {})};
    await registered(action).execute("call", params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://query.test/api/v4/openclaw-agent/billing/");
    expect(options.headers).toMatchObject({"X-Query-Delegated-Token": "delegated-test"});
    expect(JSON.parse(String(options.body))).toEqual({...params, action});
  });

  it("does not resend or use field edits after a timeout", async () => {
    const fetchMock = vi.fn(async () => {throw new Error("timeout");});
    vi.stubGlobal("fetch", fetchMock);
    const result = await registered("emit").execute("call", {thread_id: "42", items, user_request: "Emite los dos"});
    expect(JSON.stringify(result)).toContain("billing_result_unknown");
    expect(JSON.stringify(result)).toContain("query_billing_status_then_reconcile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a missing Core bridge without inventing a web fallback", async () => {
    const fetchMock = vi.fn(async () => ({ok: false, status: 404, json: async () => ({detail: "Not found"})}));
    vi.stubGlobal("fetch", fetchMock);
    const result = await registered("availability").execute("call", {thread_id: "42", items});
    expect(JSON.stringify(result)).toContain("billing_bridge_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a gateway failure as uncertain without retrying", async () => {
    const fetchMock = vi.fn(async () => ({ok: false, status: 502, json: async () => {throw new Error("HTML gateway error");}}));
    vi.stubGlobal("fetch", fetchMock);
    const result = await registered("emit").execute("call", {thread_id: "42", items, user_request: "Emite los dos"});
    expect(JSON.stringify(result)).toContain("query_billing_status_then_reconcile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
