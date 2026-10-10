import {expect,it,vi} from 'vitest';
vi.mock('./cron-sync.js',()=>({primeScheduleCredential:vi.fn()}));
import entry from './query-tools.js';
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';
it('exposes no secrets, arbitrary destinations or fabricated identity',()=>{
 const schema=getToolPluginMetadata(entry)!.tools.find(t=>t.name==='query_x')!.parameters;
 expect(schema.additionalProperties).toBe(false);
 for(const key of ['values','api_key','password','access_token','api_secret','accepted','agent_id','owner_id','tenant','url']) expect(Object.keys(schema.properties??{})).not.toContain(key);
});
it('instantiates only for trusted Manuela agent context',()=>{
 const registerTool=vi.fn();
 entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
 const factory=registerTool.mock.calls.find(c=>c[1]?.name==='query_x')![0];
 for(const agentId of ['main','comunicaciones','query',undefined]) expect(factory({agentId,sessionKey:'agent:manuela-villegas-marketing:query:channel:24'})).toBeNull();
 expect(factory({agentId:'manuela-villegas-marketing',sessionKey:'test'}).name).toBe('query_x');
});
