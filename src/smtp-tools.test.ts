import {afterEach, describe, expect, it, vi} from 'vitest';
const scheduled = vi.hoisted(() => ({credential: undefined as any}));
vi.mock('./cron-sync.js', () => ({primeScheduleCredential: vi.fn()}));
vi.mock('./scheduled-context.js', () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => scheduled.credential}}));
vi.mock('./delegated-store.js',()=>({getDelegatedAuth:()=>({auth:{token:'delegated-test'},socketUrl:'wss://query.test/ws/'}),peekDelegatedAuth:()=>undefined,delegatedAuthStoreDiagnostics:()=>({keys:[],stateFile:'test'}),rememberDelegatedAuth:vi.fn(),threadsWithDelegatedAuth:()=>[]}));
import entry from './query-tools.js';
afterEach(()=>{vi.unstubAllGlobals(); scheduled.credential = undefined;});
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';

describe('SMTP tool exposure', () => {
  it('exposes conversational SMTP tools through registration without secret schemas', () => {
    const metadata = getToolPluginMetadata(entry)!;
    const smtp = metadata.tools.filter(t => t.name.startsWith('query_smtp_'));
    expect(smtp.map(t => t.name).sort()).toEqual(['accounts','grants','preauthorize','connect','revoke','disconnect','send','setup','prefer'].map(n => `query_smtp_${n}`).sort());
    for (const tool of smtp) {
      expect(Object.keys(tool.parameters.properties ?? {})).not.toContain('password');
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(smtp.find(t => t.name === 'query_smtp_send')!.parameters.required).toContain('account_id');
    const preauthorize = smtp.find(t => t.name === 'query_smtp_preauthorize')!.parameters;
    const grants = smtp.find(t => t.name === 'query_smtp_grants')!.parameters;
    for (const schema of [preauthorize, grants]) {
      expect(schema.properties).toHaveProperty('beneficiary_username');
      expect(schema.properties).toHaveProperty('beneficiary_id');
      expect(schema.properties).not.toHaveProperty('username');
      expect(schema.required ?? []).not.toContain('beneficiary_id');
    }
    const registerTool = vi.fn();
    entry.register({registerTool, pluginConfig:{}, logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
    const names = registerTool.mock.calls.map(call => call[1]?.name ?? call[0]?.name);
    for (const tool of smtp) expect(names).toContain(tool.name);
  });
});

it.each(['preauthorize','grants'])('forwards Query username and legacy ID for SMTP %s',async action=>{
  const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({accounts:[]})}));
  vi.stubGlobal('fetch',fetchMock);
  const registerTool=vi.fn();
  entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
  const registration=registerTool.mock.calls.find(c=>c[1]?.name===`query_smtp_${action}`)!;
  const tool=registration[0]({sessionKey:'smtp-test-session'});
  for(const identity of [{beneficiary_username:'owner'},{beneficiary_id:7},{beneficiary_id:7,beneficiary_username:'owner'}]){
    await tool.execute('call',{thread_id:'42',...identity,...(action==='preauthorize'?{addresses:['mail@example.com'],provider:'smtp',host:'smtp.example.com',port:465,tls:'tls'}:{})});
    const [url,options]=fetchMock.mock.calls.at(-1) as unknown as [string,RequestInit];
    expect(url).toContain('/api/v4/openclaw-agent/smtp/');
    expect(JSON.parse(String(options.body))).toMatchObject({action,thread_id:'42',...identity});
    expect(JSON.parse(String(options.body))).not.toHaveProperty('username');
    expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'delegated-test'});
  }
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each([
  {action:'propose',attachment_ids:[23],idempotency_key:'stable',to:['to@example.com'],subject:'PDF',body:'Adjunto'},
  {action:'revise',submission_id:'draft',attachment_ids:[],new_account_id:'second',expected_digest:'digest'},
  {action:'send',submission_id:'draft',expected_digest:'digest'},
  {action:'retry',submission_id:'rejected'},
])('forwards conversational SMTP action $action to the same account service',async params=>{
  const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({status:'accepted'})}))
  vi.stubGlobal('fetch',fetchMock)
  const registerTool=vi.fn()
  entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any)
  const registration=registerTool.mock.calls.find(c=>c[1]?.name==='query_smtp_send')!
  const tool=registration[0]({sessionKey:'smtp-test-session'})
  await tool.execute('call',{thread_id:'42',account_id:'existing',...params})
  const [url,options]=fetchMock.mock.calls[0] as any
  expect(url).toContain('/api/v4/openclaw-agent/smtp/')
  expect(JSON.parse(options.body)).toEqual({thread_id:'42',account_id:'existing',...params})
  expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'delegated-test'})
})
it('uses the scheduled identity for SMTP and private/FTP discovery instead of the interactive token', async () => {
  scheduled.credential = {auth:{token:'scheduled-test',source:'schedule'},socketUrl:'wss://query.test/ws/'};
  const fetchMock = vi.fn(async () => ({ok:true,json:async()=>({accounts:[],status:'accepted'})}));
  vi.stubGlobal('fetch', fetchMock);
  const registerTool = vi.fn();
  entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
  for (const [name, params] of [
    ['query_private_accounts', {}],
    ['query_ftp_accounts', {}],
    ['query_smtp_accounts', {}],
    ['query_smtp_send', {action:'send',account_id:'account',submission_id:'scheduled-draft'}],
  ] as const) {
    const registration = registerTool.mock.calls.find(c => c[1]?.name === name)!;
    const tool = registration[0]({sessionKey:'scheduled-test-session'});
    await tool.execute('call', {thread_id:'42',...params});
    const [, options] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'scheduled-test'});
  }
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
