import {afterEach, expect, it, vi} from 'vitest';
const scheduled = vi.hoisted(() => ({credential: undefined as any}));
vi.mock('./cron-sync.js', () => ({primeScheduleCredential: vi.fn()}));
vi.mock('./scheduled-context.js', () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => scheduled.credential}}));
vi.mock('./delegated-store.js', () => ({getDelegatedAuth: () => ({auth:{token:'human-test'},socketUrl:'wss://query.test/ws/'}),
  peekDelegatedAuth:()=>undefined, delegatedAuthStoreDiagnostics:()=>({keys:[],stateFile:'test'}),
  rememberDelegatedAuth:vi.fn(), threadsWithDelegatedAuth:()=>[]}));
import entry from './query-tools.js';
import {getToolPluginMetadata} from 'openclaw/plugin-sdk/tool-plugin';
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs(); scheduled.credential = undefined;});

function factoryFor(pluginConfig: Record<string, unknown> = {}) {
  const registerTool = vi.fn();
  entry.register({registerTool,pluginConfig,logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
  return registerTool.mock.calls.find(c => c[1]?.name === 'query_meta')![0];
}

it('exists only for the configured Query agent; nobody by default', () => {
  for (const agentId of ['query', 'manuela-villegas-marketing', undefined]) expect(factoryFor()({agentId, sessionKey:'s'})).toBeNull();
  vi.stubEnv('QUERY_META_AGENT_IDS', 'query-us, otro');
  expect(factoryFor()({agentId:'query-us', sessionKey:'s'}).name).toBe('query_meta');
  expect(factoryFor()({agentId:'manuela-villegas-marketing', sessionKey:'s'})).toBeNull();
  vi.unstubAllEnvs();
  expect(factoryFor({metaAgentIds:['query-us']})({agentId:'query-us', sessionKey:'s'}).name).toBe('query_meta');
  expect(factoryFor({metaAgentIds:['query-us']})({agentId:'otro', sessionKey:'s'})).toBeNull();
});

it('only connects, lists and disconnects; never takes tokens, URLs or Graph requests', () => {
  const tool = getToolPluginMetadata(entry)!.tools.find(t => t.name === 'query_meta')!;
  expect(tool.parameters.additionalProperties).toBe(false);
  expect(Object.keys(tool.parameters.properties!).sort()).toEqual(['action','client_business_id','connection_ids','revoke_app','thread_id']);
  for (const field of ['access_token','appsecret_proof','request','path','url','page_id']) {
    expect(tool.parameters.properties).not.toHaveProperty(field);
  }
  expect(tool.description).toContain('query_api_request');
  expect(tool.description).toContain('NO cambia ninguna tarea');
  expect(tool.description).toContain('sin llamar a Meta');
});

it('keeps the skill consistent: manual stays manual, Query never falls back, cron exception only by profile', async () => {
  const {readFileSync} = await import('node:fs');
  const skill = readFileSync(new URL('../skills/query-panel/SKILL.md', import.meta.url), 'utf8');
  const meta = skill.slice(skill.indexOf('## Meta: Facebook e Instagram'), skill.indexOf('## Generic authenticated HTTP'));
  expect(meta).toContain('Si una tarea ya era manual, permanece manual');
  expect(meta).not.toContain('esa tarea sigue por la manual');
  expect(meta).toContain('no concluyas la causa');
  expect(meta).toContain('Conectar no autoriza publicar ni cambia el circuito editorial');
  expect(skill).not.toContain('HTTP/IMAP continúan sin cron');
  expect(skill).toContain('IMAP sigue sin cron');
});

it.each([
  {action:'connect_link'},
  {action:'assets'},
  {action:'disconnect', connection_ids:['3f1c2b0e-0000-4000-8000-000000000001']},
  {action:'disconnect', client_business_id:'5005'},
  {action:'disconnect', client_business_id:'5005', revoke_app:true},
])('forwards $action to the Meta endpoint with the delegated credential', async params => {
  const fetchMock = vi.fn(async () => ({ok:true,json:async()=>({status:'ok'})}));
  vi.stubGlobal('fetch', fetchMock);
  const tool = factoryFor({metaAgentIds:['query-us']})({agentId:'query-us', sessionKey:'meta-test'});
  const data = {thread_id:'42', ...params};
  await tool.execute('call', data);
  const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/api/v4/openclaw-agent/meta/');
  expect(JSON.parse(String(options.body))).toEqual(data);
  expect(options.headers).toMatchObject({'X-Query-Delegated-Token':'human-test'});
});
