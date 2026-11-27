import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
vi.mock("./cron-sync.js", () => ({primeScheduleCredential: vi.fn()}));
vi.mock("./scheduled-context.js", () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => undefined}}));
vi.mock("./delegated-store.js", () => ({getDelegatedAuth: () => ({auth: {token: "delegated-test"}, socketUrl: "wss://query.test/ws/"}), peekDelegatedAuth: () => undefined, delegatedAuthStoreDiagnostics: () => ({keys: [], stateFile: "test"}), rememberDelegatedAuth: vi.fn(), threadsWithDelegatedAuth: () => []}));
import entry from "./query-tools.js";
import {getToolPluginMetadata} from "openclaw/plugin-sdk/tool-plugin";

const MEETING_TOOLS = ["query_meetings_search", "query_meeting_get", "query_meeting_transcript", "query_meeting_summary_save", "query_personal_tasks"];

afterEach(() => vi.unstubAllGlobals());

function registered(name: string) {
  const registerTool = vi.fn();
  entry.register({registerTool, pluginConfig: {}, logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}} as any);
  return registerTool.mock.calls.find(call => call[1]?.name === name)![0]({sessionKey: "meetings-test"});
}

function okFetch(body: unknown = {results: []}) {
  const fetchMock = vi.fn(async () => ({ok: true, status: 200, json: async () => body}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Query meeting tools", () => {
  it("are implemented and declared in the manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const names = getToolPluginMetadata(entry)!.tools.map(t => t.name);
    for (const name of MEETING_TOOLS) {
      expect(names).toContain(name);
      expect(manifest.contracts.tools).toContain(name);
    }
  });

  it("search posts the filters to the delegated meetings endpoint", async () => {
    const fetchMock = okFetch({results: [{id: 7, matches: [{minute: "01:01"}]}]});
    const params = {thread_id: "42", text: "facturación", client: "Acme", date_from: "2026-11-02", date_to: "2026-11-08"};
    const result = await registered("query_meetings_search").execute("call", params);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://query.test/api/v4/openclaw-agent/meetings/search/");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({"X-Query-Delegated-Token": "delegated-test"});
    const {thread_id: _thread, ...body} = params;
    expect(JSON.parse(String(options.body))).toMatchObject(body);
    expect(JSON.stringify(result)).toContain("01:01");
  });

  it("get reads one meeting by id", async () => {
    const fetchMock = okFetch({meeting: {id: 7}});
    await registered("query_meeting_get").execute("call", {thread_id: "42", meeting_id: 7});
    const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://query.test/api/v4/openclaw-agent/meetings/7/");
    expect(options.headers).toMatchObject({"X-Query-Delegated-Token": "delegated-test"});
  });

  it("transcript sends only the window it was asked for", async () => {
    const fetchMock = okFetch({segments: []});
    await registered("query_meeting_transcript").execute("call", {thread_id: "42", meeting_id: 7, around_seq: 12, limit: 20});
    const url = new URL(String((fetchMock.mock.calls[0] as unknown as [URL])[0]));
    expect(url.pathname).toBe("/api/v4/openclaw-agent/meetings/7/transcript/");
    expect(Object.fromEntries(url.searchParams)).toEqual({around_seq: "12", limit: "20"});
  });

  it("transcript schema caps the page size", () => {
    const tool = getToolPluginMetadata(entry)!.tools.find(t => t.name === "query_meeting_transcript")!;
    expect((tool.parameters.properties as any).limit.maximum).toBe(60);
  });

  it("summary save posts to the meeting summary endpoint", async () => {
    const fetchMock = okFetch({saved: true});
    await registered("query_meeting_summary_save").execute("call", {
      thread_id: "42", meeting_id: 7, summary: "Acordamos la propuesta.",
      tasks: [{description: "Enviar contrato", minute: "02:05"}],
    });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://query.test/api/v4/openclaw-agent/meetings/7/summary/");
    expect(JSON.parse(String(options.body))).toMatchObject({summary: "Acordamos la propuesta."});
  });

  it("summary save sends the meeting tasks for the owner's personal board", async () => {
    const fetchMock = okFetch({saved: true, personal_task_ids: [5]});
    const personal_tasks = [{title: "Enviar contrato", description: "Versión firmada", due_at: "2026-11-09", minute: "02:05"}];
    await registered("query_meeting_summary_save").execute("call", {thread_id: "42", meeting_id: 7, summary: "Acordamos.", personal_tasks});
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({personal_tasks});
    const tool = getToolPluginMetadata(entry)!.tools.find(t => t.name === "query_meeting_summary_save")!;
    expect((tool.parameters.properties as any).personal_tasks.maxItems).toBe(30);
    expect(tool.description).toContain("Mis tareas");
  });

  it("personal tasks post to the delegated personal board endpoint", async () => {
    const fetchMock = okFetch({action: "create", card: {id: 9}});
    await registered("query_personal_tasks").execute("call", {thread_id: "42", action: "create", title: "Llamar a Acme", column_name: "En curso"});
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://query.test/api/v4/openclaw-agent/personal-tasks/");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({"X-Query-Delegated-Token": "delegated-test"});
    expect(JSON.parse(String(options.body))).toMatchObject({thread_id: "42", action: "create", title: "Llamar a Acme", column_name: "En curso"});
    const tool = getToolPluginMetadata(entry)!.tools.find(t => t.name === "query_personal_tasks")!;
    expect(Object.keys(tool.parameters.properties as object)).not.toContain("user_id");
    expect(tool.description).toMatch(/nunca el de otra persona/);
  });

  it("surfaces a not-found meeting without inventing content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ok: false, status: 404, json: async () => ({error: "meeting_not_found"})})));
    const result = await registered("query_meeting_get").execute("call", {thread_id: "42", meeting_id: 99});
    expect(JSON.stringify(result)).toContain("meeting_not_found");
  });

  it("descriptions keep the transcript as untrusted data", () => {
    const tools = getToolPluginMetadata(entry)!.tools.filter(t => MEETING_TOOLS.includes(t.name));
    for (const name of ["query_meetings_search", "query_meeting_transcript"]) {
      expect(tools.find(t => t.name === name)!.description).toMatch(/no confiable/);
    }
    expect(tools.find(t => t.name === "query_meeting_summary_save")!.description).toContain("query_records_propose_batch");
  });
});
