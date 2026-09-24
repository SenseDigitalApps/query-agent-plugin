import {describe, expect, it, vi} from 'vitest';
vi.mock('./cron-sync.js', () => ({primeScheduleCredential: vi.fn()}));
vi.mock('./scheduled-context.js', () => ({scheduledCredential: vi.fn(), scheduledToolContext: {getStore: () => undefined}}));
import entry from './query-tools.js';
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
    const registerTool = vi.fn();
    entry.register({registerTool, pluginConfig:{}, logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}} as any);
    const names = registerTool.mock.calls.map(call => call[1]?.name ?? call[0]?.name);
    for (const tool of smtp) expect(names).toContain(tool.name);
  });
});
