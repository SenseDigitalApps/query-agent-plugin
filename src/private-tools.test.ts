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
  it('routes generic requests through the same delegated Query identity',async()=>{
    const metadata=getToolPluginMetadata(entry)!;
    const schema=metadata.tools.find(t=>t.name==='query_api_request')!.parameters;
    expect(schema.additionalProperties).toBe(false);
    for(const key of ['values','password','access_token','owner_id','tenant','url'])expect(schema.properties).not.toHaveProperty(key);
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({operation_id:'opaque',status:'completed'})}));
    vi.stubGlobal('fetch',fetchMock);
    const tool=registered().find(c=>c[1]?.name==='query_api_request')![0]({sessionKey:'test-api'});
    await tool.execute('call',{thread_id:'42',action:'request',connection_id:'account',idempotency_key:'unique',request:{method:'POST',path:'/v2/email/outbound-bulk-emails',body:{BulkEmailEntries:[]}}});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url,options]=fetchMock.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toContain('/api/v4/openclaw-agent/authenticated-api/');
    expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'delegated-test'});
    expect(JSON.parse(String(options.body))).toMatchObject({connection_id:'account',idempotency_key:'unique'});
  });
  it('requests authorization through the private form without forwarding secret values',async()=>{
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({delivery_id:'form',status:'pending'})}));
    vi.stubGlobal('fetch',fetchMock);
    const tool=registered().find(c=>c[1]?.name==='query_api_request')![0]({sessionKey:'test-api'});
    const policy={origin:'https://api.example.test',auth:'custom_keys',secret_headers:{'X-Key':'key'},rules:[{method:'GET',path_prefix:'/v1'}]};
    await tool.execute('connect',{thread_id:'42',action:'connect',label:'Example',policy});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({action:'connect',label:'Example',policy});
    await tool.execute('invalid',{thread_id:'42',action:'connect',label:'Example',policy,values:{key:'never-forward'}});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('supports generic OAuth2 reconnect without accepting credentials',async()=>{
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({delivery_id:'form',status:'pending'})}));
    vi.stubGlobal('fetch',fetchMock);
    const tool=registered().find(c=>c[1]?.name==='query_api_request')![0]({sessionKey:'test-api'});
    const policy={origin:'https://api.example.test',auth:'oauth2',oauth2:{token_url:'https://identity.example.test/token'},rules:[{method:'GET',path_prefix:'/v1'}]};
    await tool.execute('reconnect',{thread_id:'42',action:'connect',connection_id:'account',policy,reconnect:true});
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({action:'connect',connection_id:'account',policy,reconnect:true});
    await tool.execute('invalid',{thread_id:'42',action:'connect',connection_id:'account',policy,reconnect:true,refresh_token:'never-forward'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('shares HTTP through delegated context without accepting actor, agent or secrets',async()=>{
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({grant_id:'grant-test'})}));
    vi.stubGlobal('fetch',fetchMock);
    const tool=registered().find(c=>c[1]?.name==='query_api_request')![0]({sessionKey:'test-sharing'});
    const grant={user_id:7,capabilities:['discover','consult','execute'],contexts:['private'],rules:[{method:'GET',path_prefix:'/v2/email/account'}]};
    await tool.execute('grant',{thread_id:'42',action:'grant',connection_id:'account',grant});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({action:'grant',grant});
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({'X-Query-Delegated-Token':'delegated-test'});
    for (const field of ['owner_id','actor_id','agent_id','tenant','values']) {
      await tool.execute('injection',{thread_id:'42',action:'grant',connection_id:'account',grant,[field]:'forged'});
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tool.execute('revoke',{thread_id:'42',action:'revoke_grant',connection_id:'account',grant_id:'grant-test'});
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({action:'revoke_grant',grant_id:'grant-test'});
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
