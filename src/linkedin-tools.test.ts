import {afterEach, expect, it, vi} from 'vitest';
const scheduled = vi.hoisted(() => ({credential: undefined as any}));
vi.mock('./cron-sync.js', () => ({primeScheduleCredential: vi.fn()}));
vi.mock('./scheduled-context.js', () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => scheduled.credential}}));
vi.mock('./delegated-store.js', () => ({getDelegatedAuth: () => ({auth:{token:'human-test'},socketUrl:'wss://query.test/ws/'}),
  peekDelegatedAuth:()=>undefined, delegatedAuthStoreDiagnostics:()=>({keys:[],stateFile:'test'}),
  rememberDelegatedAuth:vi.fn(), threadsWithDelegatedAuth:()=>[]}));
import entry from './query-tools.js';
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';
afterEach(() => {vi.unstubAllGlobals(); scheduled.credential = undefined;});

it('exposes LinkedIn automation without credentials or arbitrary remote URLs', () => {
  const tool = getToolPluginMetadata(entry)!.tools.find(t => t.name === 'query_linkedin')!;
  expect(tool.parameters.additionalProperties).toBe(false);
  for (const field of ['access_token','refresh_token','password','url','user_id','run_as']) {
    expect(tool.parameters.properties).not.toHaveProperty(field);
  }
  expect(tool.parameters.properties).toHaveProperty('image_attachment_id');
  expect(tool.parameters.properties).toHaveProperty('first_comment');
});

it.each([
  {action:'authorize', schedule_external_id:'cron-1', destination:'urn:li:organization:123', actions:['text','image','first_comment']},
  {action:'publish', destination:'urn:li:organization:123', idempotency_key:'occurrence-1', text:'Post', image_attachment_id:7, first_comment:'Comment'},
  {action:'resume', operation_id:'operation-1'},
  {action:'revoke_authorization', schedule_external_id:'cron-1'},
])('forwards $action and uses the existing scheduled context when applicable', async params => {
  const isSchedule = ['publish','resume'].includes(params.action);
  if (isSchedule) scheduled.credential = {auth:{token:'cron-test',source:'schedule'},socketUrl:'wss://query.test/ws/'};
  const fetchMock = vi.fn(async () => ({ok:true,json:async()=>({status:'completed'})}));
  vi.stubGlobal('fetch', fetchMock);
  const registerTool = vi.fn();
  entry.register({registerTool,pluginConfig:{},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
  const registration = registerTool.mock.calls.find(c => c[1]?.name === 'query_linkedin')!;
  const tool = registration[0]({sessionKey:'linkedin-test'});
  const data = {thread_id:'42', ...(params.action === 'resume' ? {} : {account_id:'saved-account'}), ...params};
  await tool.execute('call', data);
  const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/api/v4/openclaw-agent/linkedin/');
  expect(JSON.parse(String(options.body))).toEqual(data);
  expect(options.headers).toMatchObject({'X-Query-Delegated-Token':isSchedule ? 'cron-test' : 'human-test'});
});
