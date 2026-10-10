import {expect,it,vi} from 'vitest';
import {executeX} from './x-tools.js';
it('reserves costly URL rate before publish',async()=>{
 const post=vi.fn().mockResolvedValueOnce({status:'pending',expected_digest:'digest'}).mockResolvedValueOnce({status:'completed'});
 const reserve=vi.fn().mockResolvedValue({ok:true});
 await executeX({action:'publish',operation_id:'op',expected_digest:'digest',thread_id:'42'},post,reserve);
 expect(reserve.mock.calls[0][1]).toBe(20);
 expect(post).toHaveBeenCalledTimes(2);
});
it.each(['uncertain','completed','rejected','cancelled'])('does not repeat %s',async(status)=>{
 const post=vi.fn().mockResolvedValue({status,expected_digest:'digest'});const reserve=vi.fn();
 expect((await executeX({action:'publish',operation_id:'op',expected_digest:'digest'},post,reserve)).status).toBe(status);
 expect(post).toHaveBeenCalledTimes(1);expect(reserve).not.toHaveBeenCalled();
});
it('budget refusal blocks all paid requests',async()=>{
 const post=vi.fn();const reserve=vi.fn().mockResolvedValue({ok:false,error:'budget'});
 await executeX({action:'metrics',post_ids:['123']},post,reserve);
 expect(post).not.toHaveBeenCalled();expect(reserve.mock.calls[0][1]).toBe(0.5);
});
it('already connected does not reserve or reconnect',async()=>{
 const post=vi.fn().mockResolvedValue({accounts:[{account_id:'a',revision:2,status:'stored',x:{revision:2,identity:{id:'123'}}}]});
 const reserve=vi.fn();
 expect((await executeX({action:'connect',account_id:'a'},post,reserve)).cached).toBe(true);
 expect(reserve).not.toHaveBeenCalled();expect(post).toHaveBeenCalledTimes(1);
});
it('connection preflight refusal spends nothing',async()=>{
 const post=vi.fn().mockResolvedValue({error:'no_credential'});const reserve=vi.fn();
 await executeX({action:'connect',account_id:'a'},post,reserve);
 expect(reserve).not.toHaveBeenCalled();
});
