import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as profileFiles from "./agent-profile.js";
import { provisionQueryAgent, registerQueryProvision, type ProvisionDependencies } from "./agent-provision.js";

const manifest = () => ({type: "query_openclaw_provision", version: 1, idempotency_key: "unique-key",
 agent: { suggested_id: "sales", workspace_slug: "sales", display_name: "Sales", personality: "Direct", mission: "Help", effort_mode: "normal" },
 query_account: { suggested_id: "sales" }, connection: { url: "wss://query.example/ws/1/?token=secret", protocol: "query-openclaw.v2" },
 binding: { channel: "query", account_id: "sales" }});
let root: string;
let cfg: any;
let deps: ProvisionDependencies;
let mutate: ReturnType<typeof vi.fn>;
let ready: ReturnType<typeof vi.fn>;
beforeEach(async () => {
 root = await mkdtemp(join(tmpdir(), "query-provision-test-"));
 cfg = { agents: { list: [{ id: "old", workspace: join(root, "old") }] }, bindings: [], channels: { query: { url: "wss://query.example/ws/old/?token=old" } } };
 mutate = vi.fn(async ({ mutate: apply }: any) => { const draft = structuredClone(cfg); await apply(draft); cfg = draft; return {}; });
 ready = vi.fn(async () => true);
 deps = { config: { current: () => cfg, mutateConfigFile: mutate as any }, workspace: (_, id) => join(root, id), waitReady: ready as any, timeoutMs: 5 };
 vi.stubEnv("QUERY_OPENCLAW_TOKEN", "");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("native Query provisioning", () => {
 it("validates without writing config or files", async () => {
   expect((await provisionQueryAgent(manifest(), true, deps)).status).toBe("validated");
   expect(mutate).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
 });
 it.each([undefined, { type: "query_agent_connection", version: "2" }, { ...manifest(), version: 99 }])("rejects legacy/unknown contracts", async value => {
   expect((await provisionQueryAgent(value, false, deps)).error).toBe("manifest_version_unsupported"); expect(mutate).not.toHaveBeenCalled();
 });
 it("rejects public ws and missing schema fields", async () => {
   const value=manifest(); value.connection.url="ws://query.example/?token=secret";
   expect((await provisionQueryAgent(value, false, deps)).error).toBe("connection_wss_required");
   expect((await provisionQueryAgent({...manifest(), unexpected: true}, false, deps)).error).toBe("manifest_invalid");
 });
 it("creates in one mutation, preserves old account and repeats without writes", async () => {
   const original=structuredClone(cfg);
   const result=await provisionQueryAgent(manifest(), false, deps);
   expect(result.status).toBe("created"); expect(mutate).toHaveBeenCalledTimes(1);
   expect(mutate.mock.calls[0][0].afterWrite).toEqual({ mode: "auto" });
   expect(cfg.agents.list[0]).toEqual(original.agents.list[0]); expect(cfg.channels.query.url).toBe(original.channels.query.url);
   expect(ready.mock.calls[1][0].map((x:any)=>x.id)).toEqual(["default", "sales"]);
   expect(JSON.stringify(result)).not.toContain("secret");
   await writeFile(join(root, "sales", "SOUL.md"), "human content");
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("already_present");
   expect(mutate).toHaveBeenCalledTimes(1); expect(await readFile(join(root,"sales","SOUL.md"),"utf8")).toBe("human content");
   expect((await provisionQueryAgent({...manifest(), idempotency_key:"different"}, false, deps)).error).toBe("manifest_collision");
 });
 it.each(["agent", "account", "workspace"])("blocks %s collisions", async kind => {
   if(kind==="agent") cfg.agents.list.push({ id: "sales" });
   if(kind==="account") cfg.channels.query.accounts={sales:{url:"wss://other/?token=other"}};
   if(kind==="workspace") await mkdir(join(root,"sales"));
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("failed"); expect(mutate).not.toHaveBeenCalled();
 });
 it("blocks a conflicting tenant token",async()=>{
   vi.stubEnv("QUERY_OPENCLAW_TOKEN","other");
   expect((await provisionQueryAgent(manifest(), false, deps)).error).toBe("global_query_token_conflict"); expect(mutate).not.toHaveBeenCalled();
 });
 it("does not mutate while an existing account is offline",async()=>{
   ready.mockResolvedValue(false);
   expect((await provisionQueryAgent(manifest(), false, deps)).error).toBe("existing_accounts_not_ready"); expect(await readdir(root)).toEqual([]);
 });
 it("rolls back only new nodes when readiness times out",async()=>{
   const original=structuredClone(cfg); ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
   const result=await provisionQueryAgent(manifest(), false, deps);
   expect(result.rollback).toBe("restored"); expect(mutate).toHaveBeenCalledTimes(2);
   expect(cfg.agents).toEqual(original.agents); expect(cfg.bindings).toEqual([]); expect(cfg.channels.query.url).toBe(original.channels.query.url);
   expect(cfg.channels.query.accounts).toEqual({}); expect(await readdir(root)).toEqual([]);
 });
 it("cleans up when config write fails and redacts errors",async()=>{
   mutate.mockRejectedValueOnce(new Error("secret wss://private/?token=secret"));
   const result=await provisionQueryAgent(manifest(), false, deps);
   expect(result.error).toBe("provision_failed"); expect(JSON.stringify(result)).not.toContain("secret"); expect(await readdir(root)).toEqual([]);
 });
 it("compensates if config persisted before afterWrite failed",async()=>{
   const original=mutate.getMockImplementation()!;
   mutate.mockImplementationOnce(async (...args:any[])=>{ await original(...args); throw new Error("after_write_failed"); });
   const result=await provisionQueryAgent(manifest(), false, deps);
   expect(result.rollback).toBe("restored"); expect(cfg.agents.list).toHaveLength(1); expect(await readdir(root)).toEqual([]);
 });
 it("retains user files if rollback cleanup detects new content",async()=>{
   ready.mockImplementationOnce(async()=>true).mockImplementationOnce(async()=>{await writeFile(join(root,"sales","SOUL.md"),"human content");return false;});
   expect((await provisionQueryAgent(manifest(), false, deps)).rollback).toBe("manual_recovery_required");
   expect(await readFile(join(root,"sales","SOUL.md"),"utf8")).toBe("human content");
 });
 it("serializes concurrent provisioning with a lock",async()=>{
   let release!:()=>void;
   ready.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{ release=()=>resolve(true); }));
   const first=provisionQueryAgent(manifest(), false, deps);
   await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
   expect((await provisionQueryAgent(manifest(), false, deps)).error).toBe("query_provision_locked");
   release(); expect((await first).status).toBe("created");
 });
 it("removes its workspace when profile preparation fails",async()=>{
   vi.spyOn(profileFiles,"writeAgentProfileFiles").mockRejectedValueOnce(new Error("disk failed"));
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("failed");
   expect(mutate).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
 });
 it("preserves config changed by another writer during rollback",async()=>{
   ready.mockImplementationOnce(async()=>true).mockImplementationOnce(async()=>{
     cfg.channels.query.accounts.sales.effortMode="careful"; return false;
   });
   expect((await provisionQueryAgent(manifest(), false, deps)).rollback).toBe("manual_recovery_required");
   expect(cfg.channels.query.accounts.sales.effortMode).toBe("careful");
   expect(await readdir(root)).toContain("sales");
 });
 it("exposes the native tool only to trusted owner turns",()=>{
   const registerTool=vi.fn(); registerQueryProvision({registerTool} as any);
   const factory=registerTool.mock.calls[0][0];
   expect(factory({})).toBeNull(); expect(factory({senderIsOwner:false})).toBeNull();
   expect(factory({senderIsOwner:true,sandboxed:true})).toBeNull();
   expect(factory({senderIsOwner:true}).name).toBe("query_agent_provision");
 });
});
