import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {executeFtp} from '../dist/src/ftp-executor.js';
const [url,workspace]=process.argv.slice(2);
if(!url.startsWith('http://127.0.0.1:'))throw new Error('fixture must use loopback');
const identity=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const post=async body=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('fixture_rejected');return r.json();};
const form=await post({stage:'request',runtime_key:identity.publicKey});
assert.deepEqual(form.spec.fields,[]);assert.ok(['ftp','ftps'].includes(form.spec.ftp_options.protocol));
await post({stage:'approve'});
const account_id=form.account_id;
for(const [key,operation,local_file] of [
  ['connect',{action:'connect',path:'/public_html'}],
  ['upload',{action:'upload',path:'/public_html/index.html'},'index.html'],
  ['rename',{action:'rename',path:'/public_html/index.html',destination:'/public_html/published.html'}],
  ['list',{action:'list',path:'/public_html'}],
]) {
  const result=await executeFtp(post,{account_id,idempotency_key:key,operation,local_file},workspace,identity);
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes('fixture-password'),false);
  if(key==='list')assert.ok(result.entries.some(e=>e.name==='published.html'));
  assert.equal((await post({action:'status',operation_id:result.operation_id})).status,'completed');
}
const replay=await executeFtp(post,{account_id,idempotency_key:'rename',operation:{action:'rename',path:'/public_html/index.html',destination:'/public_html/published.html'}},workspace,identity);
assert.equal(replay.status,'completed');
await post({action:'revoke',account_id});
const revoked=await executeFtp(post,{account_id,idempotency_key:'revoked',operation:{action:'list',path:'/public_html'}},workspace,identity);
assert.equal(revoked.ok,false);
console.log('PASS: agent authorization request -> private form -> consent -> sealed Core lease -> OpenClaw FTP/FTPS -> audited status.');
