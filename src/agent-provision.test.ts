import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as profileFiles from "./agent-profile.js";
import { provisionQueryAgent, registerQueryProvision, verifyPendingProvisionActivations, type ProvisionDependencies } from "./agent-provision.js";

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
 deps = { readSource: async () => structuredClone(cfg), config: { current: () => cfg, mutateConfigFile: mutate as any }, workspace: (_, id) => join(root, id), waitReady: ready as any, timeoutMs: 5 };
 vi.stubEnv("QUERY_OPENCLAW_TOKEN", "");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe.each(["legacy", "entries"])("native Query provisioning (%s)", schema => {
 beforeEach(() => {
   if (schema === "entries") {
     const { id, ...entry } = cfg.agents.list[0];
     cfg.agents = { entries: { [id]: entry } };
   }
 });
 const agents = () => cfg.agents.entries
   ? Object.entries(cfg.agents.entries).map(([id, entry]) => ({ id, ...(entry as object) }))
   : cfg.agents.list;
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
   expect(schema === "entries" ? cfg.agents.entries.old : cfg.agents.list[0]).toEqual(schema === "entries" ? original.agents.entries.old : original.agents.list[0]); expect(cfg.channels.query.url).toBe(original.channels.query.url);
   expect(ready.mock.calls[1][0].map((x:any)=>x.id)).toEqual(["default", "sales"]);
   expect(JSON.stringify(result)).not.toContain("secret");
   await writeFile(join(root, "sales", "SOUL.md"), "human content");
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("already_present");
   expect(mutate).toHaveBeenCalledTimes(1); expect(await readFile(join(root,"sales","SOUL.md"),"utf8")).toBe("human content");
   expect((await provisionQueryAgent({...manifest(), idempotency_key:"different"}, false, deps)).error).toBe("manifest_collision");
 });
 it.each(["agent", "account", "workspace"])("blocks %s collisions", async kind => {
   if(kind==="agent") { if(schema==="entries") cfg.agents.entries.sales={}; else cfg.agents.list.push({ id: "sales" }); }
   if(kind==="account") cfg.channels.query.accounts={sales:{url:"wss://other/?token=other"}};
   if(kind==="workspace") await mkdir(join(root,"sales"));
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("failed"); expect(mutate).not.toHaveBeenCalled();
 });
 it("compares source rather than runtime defaults and preserves secret references",async()=>{
   cfg.gateway={reload:{mode:"off"}};
   cfg.agents.defaults={model:{primary:"test/model"}};
   cfg.channels.query.accounts={other:{enabled:false,url:"${OTHER_URL}"}};
   deps.config.current=()=>{const runtime=structuredClone(cfg);
     runtime.agents.defaults.extraRuntimeDefault=true;
     runtime.channels.query.accounts.other.url="wss://other.example/?token=resolved";
     return runtime;
   };
   const result=await provisionQueryAgent(manifest(),false,deps);
   expect(result.status).toBe("pending_activation");
   expect(cfg.agents.defaults.extraRuntimeDefault).toBeUndefined();
   expect(cfg.channels.query.accounts.other.url).toBe("${OTHER_URL}");
   expect(mutate.mock.calls[0][0].base).toBe("source");
 });
 it.each(["agents","query","bindings"])("rejects a real concurrent source change in %s",async section=>{
   ready.mockImplementationOnce(async()=>{
     if(section==="agents")cfg.agents.defaults={workspace:"/changed"};
     if(section==="query")cfg.channels.query.enabled=false;
     if(section==="bindings")cfg.bindings.push({type:"route",agentId:"old",match:{channel:"telegram"}});
     return true;
   });
   const result=await provisionQueryAgent(manifest(),false,deps);
   expect(result.error).toBe("concurrent_configuration_change");
   expect(agents()).toHaveLength(1);
   expect(cfg.channels.query.accounts?.sales).toBeUndefined();
   expect(await readdir(root)).toEqual([]);
 });
 it("accepts key reordering without losing unrelated changes",async()=>{
   ready.mockImplementationOnce(async()=>{
     cfg.channels.query=Object.fromEntries(Object.entries(cfg.channels.query).reverse());
     cfg.messages={ackReaction:"ok"};
     return true;
   });
   expect((await provisionQueryAgent(manifest(),false,deps)).status).toBe("created");
   expect(cfg.messages).toEqual({ackReaction:"ok"});
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
   expect(result.rollback).toBe("restored"); expect(agents()).toHaveLength(1); expect(await readdir(root)).toEqual([]);
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
 it.each(["off", "restart"])("retains a durable pending receipt for activation (%s)", async mode => {
   if (mode === "off") cfg.gateway = { reload: { mode: "off" } };
   else {
     const apply = mutate.getMockImplementation()!;
     mutate.mockImplementation(async (...args:any[]) => { await apply(...args); return { followUp: { requiresRestart: true } }; });
   }
   expect((await provisionQueryAgent(manifest(), false, deps)).status).toBe("pending_activation");
   expect(mutate).toHaveBeenCalledTimes(1);
   expect(ready).toHaveBeenCalledTimes(1);
   const receipt = await readFile(join(root,"sales",".query-provision-activation.json"),"utf8");
   expect(receipt).not.toContain("token");
   expect(JSON.parse(receipt).status).toBe("pending_activation");
   expect(await verifyPendingProvisionActivations(deps)).toEqual([{ agentId:"sales", accountId:"sales", status:"ready" }]);
   expect(ready.mock.calls[1][0].map((x:any)=>x.id)).toEqual(["default","sales"]);
   expect(mutate).toHaveBeenCalledTimes(1);
   expect(await verifyPendingProvisionActivations(deps)).toEqual([]);
 });
 it("records failed activation without removing persisted config",async()=>{
   cfg.gateway={reload:{mode:"off"}};
   await provisionQueryAgent(manifest(),false,deps);
   ready.mockResolvedValue(false);
   expect(await verifyPendingProvisionActivations(deps)).toEqual([{agentId:"sales",accountId:"sales",status:"activation_failed"}]);
   expect(agents()).toHaveLength(2); expect(mutate).toHaveBeenCalledTimes(1);
 });
 it("does not certify activation if an original account disappeared",async()=>{
   cfg.gateway={reload:{mode:"off"}};
   await provisionQueryAgent(manifest(),false,deps);
   delete cfg.channels.query.url;
   ready.mockClear();
   expect(await verifyPendingProvisionActivations(deps)).toEqual([{agentId:"sales",accountId:"sales",status:"activation_failed"}]);
   expect(ready).not.toHaveBeenCalled();
 });
 it("never verifies an activation receipt with a changed identity",async()=>{
   cfg.gateway={reload:{mode:"off"}};
   await provisionQueryAgent(manifest(),false,deps);
   const p=join(root,"sales",".query-provision-activation.json");
   const state=JSON.parse(await readFile(p,"utf8"));state.accountId="foreign";
   await writeFile(p,JSON.stringify(state));ready.mockClear();
   expect(await verifyPendingProvisionActivations(deps)).toEqual([]);expect(ready).not.toHaveBeenCalled();
 });
 it("exposes the native tool only to trusted owner turns",()=>{
   const registerTool=vi.fn(); registerQueryProvision({registerTool,on:vi.fn()} as any);
   const factory=registerTool.mock.calls[0][0];
   expect(factory({})).toBeNull(); expect(factory({senderIsOwner:false})).toBeNull();
   expect(factory({senderIsOwner:true,sandboxed:true})).toBeNull();
   expect(factory({senderIsOwner:true}).name).toBe("query_agent_provision");
 });
});
