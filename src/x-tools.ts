import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

type Params = Record<string, any>;
type Post = (data: Params) => Promise<any>;
export function reserveXBudget(key: string, cents: number): Promise<any> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/python3', ['/home/ubuntu/.openclaw/workspace/integrations/x-reader/private_budget.py'], {stdio:['pipe','pipe','pipe']});
    let output = ''; let finished = false;
    const done = (value: unknown) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {child.kill(); done({ok:false,error:'x_budget_unavailable'});}, 15000);
    child.on('error', () => done({ok:false,error:'x_budget_unavailable'}));
    child.stdin.on('error', () => done({ok:false,error:'x_budget_unavailable'}));
    child.stdout.on('data', data => {output += String(data); if(output.length > 16000) {child.kill(); done({ok:false,error:'x_budget_unavailable'});} });
    child.on('close', code => {try {done(code === 0 ? JSON.parse(output) : {ok:false,error:'x_budget_unavailable'});} catch {done({ok:false,error:'x_budget_unavailable'});} });
    child.stdin.end(JSON.stringify({key,cents}));
  });
}

/** Core owns credentials; Manuela has a separate unlimited, metered policy. */
export async function executeX(params: Params, post: Post, reserve = reserveXBudget): Promise<any> {
  const {action, thread_id} = params;
  let cents = 0; let key = randomUUID() as string;
  if (action === 'publish' || action === 'resume') {
    const state = await post({action:'status',thread_id,operation_id:params.operation_id});
    if (state.error || state.ok === false) return state;
    if (state.expected_digest !== params.expected_digest) return {ok:false,error:'x_draft_changed'};
    if (['completed','uncertain','rejected','cancelled'].includes(state.status)) return state;
    const allowed = action === 'resume' ? ['uploading_media','waiting_media'] : ['pending'];
    if (!allowed.includes(state.status) || state.retry_after_seconds > 0) return state;
    // Meter the post estimate once across every upload/resume checkpoint.
    // This is not a media price guarantee or a local spending ceiling.
    cents = 20; key = `publish:${params.operation_id}`;
  } else if (action === 'connect') {
    const state = await post({action:'accounts',thread_id});
    if (state.error || state.ok === false) return state;
    const account = state.accounts?.find((a: Params) => a.account_id === params.account_id);
    if (!account) return {ok:false,error:'x_account_unavailable'};
    if (account.status !== 'revoked' && account.x?.revision === account.revision && account.x?.identity) {
      return {status:'connected',identity:account.x.identity,cached:true};
    }
    cents = 1;
  } else if (action === 'metrics') {
    if (!Array.isArray(params.post_ids) || params.post_ids.length < 1 || params.post_ids.length > 20) return {ok:false,error:'x_post_ids_invalid'};
    cents = params.post_ids.length * 0.5;
  }
  if (cents) {
    const fingerprint = createHash('sha256').update(JSON.stringify([thread_id,key])).digest('hex');
    const receipt = await reserve(`query-x:${fingerprint}`,cents);
    if (!receipt?.ok) return receipt;
    // Never release on ambiguous provider/transport errors; overreservation is safe.
  }
  return post(params);
}
