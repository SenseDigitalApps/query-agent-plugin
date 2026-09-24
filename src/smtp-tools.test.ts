import {afterEach, describe, expect, it, vi} from 'vitest';
vi.mock('./cron-sync.js', () => ({primeScheduleCredential: vi.fn()}));
vi.mock('./scheduled-context.js', () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => undefined}}));
vi.mock('./delegated-store.js',()=>({getDelegatedAuth:()=>({auth:{token:'delegated-test'},socketUrl:'wss://query.test/ws/'}),peekDelegatedAuth:()=>undefined,delegatedAuthStoreDiagnostics:()=>({keys:[],stateFile:'test'}),rememberDelegatedAuth:vi.fn(),threadsWithDelegatedAuth:()=>[]}));
import entry from './query-tools.js';
afterEach(()=>vi.unstubAllGlobals());
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';

describe('SMTP tool exposure', () => {
  it('exposes seven tools through the actual plugin registration and no secret schema', () => {
    const metadata = getToolPluginMetadata(entry)!;
    const smtp = metadata.tools.filter(t => t.name.startsWith('query_smtp_'));
    expect(smtp.map(t => t.name).sort()).toEqual(['accounts','grants','preauthorize','connect','revoke','disconnect','send'].map(n => `query_smtp_${n}`).sort());
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
