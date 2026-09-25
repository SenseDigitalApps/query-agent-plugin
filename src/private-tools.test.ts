import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('./cron-sync.js',()=>({primeScheduleCredential:vi.fn()}));
vi.mock('./scheduled-context.js',()=>({scheduledCredential:vi.fn(),scheduledToolContext:{getStore:()=>undefined}}));
vi.mock('./delegated-store.js',()=>({getDelegatedAuth:()=>({auth:{token:'delegated-test'},socketUrl:'wss://query.test/ws/'}),peekDelegatedAuth:()=>undefined,delegatedAuthStoreDiagnostics:()=>({keys:[],stateFile:'test'}),rememberDelegatedAuth:vi.fn(),threadsWithDelegatedAuth:()=>[]}));
import entry from './query-tools.js';
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';

afterEach(()=>vi.unstubAllGlobals());
describe('private delivery registration and transport',()=>{
  function registered() {
    const registerTool=vi.fn();
    entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
    return registerTool.mock.calls;
  }
  it('registers all capabilities without any secret-valued parameter',()=>{
    const names=['accounts','request','revoke','operation'].map(n=>`query_private_${n}`);
    const metadata=getToolPluginMetadata(entry)!;
    const calls=registered();
    for(const name of names){
      expect(calls.some(c=>c[1]?.name===name)).toBe(true);
      const schema=metadata.tools.find(t=>t.name===name)!.parameters;
      expect(schema.additionalProperties).toBe(false);
      for(const key of ['values','api_key','password','access_token','client_secret','accepted','agent_id','owner_id','tenant','url']) expect(Object.keys(schema.properties??{})).not.toContain(key);
    }
  });
  it('requests a private form using delegated context; rejects extra values before HTTP',async()=>{
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({delivery_id:'opaque',path:'/private-delivery#delivery=opaque'})}));
    vi.stubGlobal('fetch',fetchMock);
    const call=registered().find(c=>c[1]?.name==='query_private_request')!;
    const tool=call[0]({sessionKey:'test-private-session'});
    await tool.execute('call',{thread_id:'42',integration:'credential',label:'My account',secret_fields:['api_key','client_secret']});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url,options]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toContain('/api/v4/openclaw-agent/private-delivery/');
    expect(JSON.parse(String(options.body))).toMatchObject({action:'request',thread_id:'42',integration:'credential',secret_fields:['api_key','client_secret']});
    expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'delegated-test'});
    await tool.execute('call2',{thread_id:'42',integration:'openai',label:'My account',api_key:'do-not-forward'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('registers FTP operations with no secret fields and injects the runtime key internally',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'query-ftp-tools-'));
    const old=process.env.OPENCLAW_STATE_DIR;process.env.OPENCLAW_STATE_DIR=directory;
    try {
      const calls=registered();
      for(const name of ['query_ftp_authorize','query_ftp_execute','query_ftp_status','query_ftp_revoke','query_ftp_accounts','query_ftp_permissions']) {
        expect(calls.some(c=>c[1]?.name===name)).toBe(true);
        const properties=getToolPluginMetadata(entry)!.tools.find(t=>t.name===name)!.parameters.properties!;
        for(const key of ['password','values','runtime_key','private_key','tenant','owner_id','agent_id'])expect(properties).not.toHaveProperty(key);
      }
      const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({delivery_id:'opaque',consumer:'ftp'})}));vi.stubGlobal('fetch',fetchMock);
      const tool= calls.find(c=>c[1]?.name==='query_ftp_authorize')![0]({sessionKey:'test-private-session'});
      const params={thread_id:'42',account_id:'account',host:'ftp.example.test',operations:['connect','list']};
      await tool.execute('request',params);
      const request=JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(request).toMatchObject({action:'authorize',thread_id:'42',policy:{host:'ftp.example.test',allow_schedules:false}});
      expect(request.policy.runtime_key).toContain('BEGIN PUBLIC KEY');
      await tool.execute('injection',{...params,password:'DO-NOT-FORWARD'});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await tool.execute('new',{thread_id:'42',label:'New FTP',host:'ftp.example.test',protocol:'ftp',access_mode:'agent_members'});
      const fresh=JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(fresh).not.toHaveProperty('account_id');
      expect(fresh).toMatchObject({label:'New FTP',policy:{protocol:'ftp',access_mode:'agent_members'}});
      const permissions=calls.find(c=>c[1]?.name==='query_ftp_permissions')![0]({sessionKey:'test-private-session'});
      await permissions.execute('share',{thread_id:'42',account_id:'account',access_mode:'agent_members'});
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({action:'permissions',account_id:'account',access_mode:'agent_members'});
    } finally {if(old===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=old;rmSync(directory,{recursive:true,force:true});}
  });
});
