import {afterEach,describe,expect,it,vi} from 'vitest';
import {constants,createCipheriv,generateKeyPairSync,publicEncrypt,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeFtp,ftpBridge,ftpIdempotencyKey} from './ftp-executor.js';

const identity=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const secret='PRIVATE-password-TEST';
let folders:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(folders.map(f=>rm(f,{recursive:true,force:true})));folders=[];});
function fixture(options:{protocol?:string;failAccess?:boolean;failRename?:boolean;revoke?:boolean;expired?:boolean;echo?:boolean;noEnvelope?:boolean;symlink?:boolean;failFinish?:boolean}={}) {
  const calls:Record<string,unknown>[]=[];
  let checks=0,cwd='/public_html';
  const client={ftp:{verbose:true},close:vi.fn(),access:vi.fn(async()=>{if(options.failAccess)throw new Error("TLS failed");}),cd:vi.fn(async(p:string)=>{cwd=p;}),pwd:vi.fn(async()=>cwd),
    list:vi.fn(async()=>[{name:options.echo?secret:'index.html',isFile:!options.symlink,isDirectory:false,isSymbolicLink:!!options.symlink,size:4}]),
    uploadFrom:vi.fn(async()=>{}),size:vi.fn(async()=>4),rename:vi.fn(async()=>{if(options.failRename)throw new Error('PASS '+secret);})};
  const bridge=vi.fn(async(body:Record<string,unknown>)=>{
    calls.push(body);
    if(body.action==='begin') {
      // Same contract as Core: reject invalid keys before issuing any lease.
      if(typeof body.idempotency_key!=='string'||! /^[a-zA-Z0-9_-]{1,96}$/.test(body.idempotency_key))throw new Error('ftp_invalid_idempotency_key');
      if(options.noEnvelope)return {operation_id:'op',status:'uncertain'};
      const payload={operation_id:'op',expires_at:new Date(Date.now()+(options.expired?-1000:60000)).toISOString(),operation:body.operation,
        policy:{protocol:options.protocol,host:'ftp.example.test',port:21,root:'/public_html',approved_ips:['93.184.216.34'],runtime_key:identity.publicKey,operations:['connect','list','upload','rename']},
        credentials:{user:'ftp-user',password:secret}};
      const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('op'));
      const data=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]);
      return {operation_id:'op',status:'executing',envelope:{key:publicEncrypt({key:identity.publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),nonce:nonce.toString('base64'),data:data.toString('base64')}};
    }
    if(body.action==='check') {checks++;if(options.revoke&&checks>=3)throw new Error('revoked');return {allowed:true};}
    if(body.action==='finish'&&options.failFinish)throw new Error('network');
    return {status:body.status};
  });
  const run=(action='list',extra:Record<string,unknown>={},workspace?:string,key='once')=>executeFtp(bridge as any,
    {account_id:'account',idempotency_key:key,operation:{action,path:'/public_html',...extra},...(action==='upload'?{operation:{action,path:'/public_html/index.html'},local_file:'index.html'}:{})},workspace,identity,()=>client as any);
  return {bridge,client,calls,run};
}
describe('FTP idempotency compatibility with Core',()=>{
  const failedKeys=[
    '2026-09-25:62b2c087-700a-4629-9a87-1ec267cb9827:ftp-connect',
    '2026-09-25:62b2c087-700a-4629-9a87-1ec267cb9827:ftp-list-root',
  ];
  it.each(failedKeys)('executes the previously rejected cron key %s',async key=>{
    const f=fixture();
    expect(await f.run('list',{},undefined,key)).toMatchObject({ok:true,status:'completed'});
    expect(f.calls[0].idempotency_key).toMatch(/^[a-zA-Z0-9_-]{1,96}$/);
    expect(f.calls[0].idempotency_key).toBe(ftpIdempotencyKey(key));
  });
  it('preserves valid historic keys and avoids lossy separator collisions',()=>{
    for(const key of ['once','2026-09-25_cron_list','A'.repeat(96)])expect(ftpIdempotencyKey(key)).toBe(key);
    const variants=['day:connect','day/connect','day_connect'];
    expect(new Set(variants.map(ftpIdempotencyKey)).size).toBe(variants.length);
    expect(ftpIdempotencyKey(failedKeys[0])).toBe(ftpIdempotencyKey(failedKeys[0]));
  });
  it.each(['completed','uncertain'])('keeps %s replay identity without connecting',async status=>{
    const seen=new Set<string>();let first:string|undefined;
    const bridge=vi.fn(async(body:Record<string,unknown>)=>{
      const key=String(body.idempotency_key);
      if(!first)first=key;
      seen.add(key);
      return {operation_id:'existing-operation',status};
    });
    const client=vi.fn(()=>{throw new Error('must not connect');});
    for(let n=0;n<2;n++){
      expect(await executeFtp(bridge,{account_id:'account',idempotency_key:failedKeys[0],
        operation:{action:'list',path:'/public_html'}},undefined,identity,client as any))
        .toMatchObject({operation_id:'existing-operation',status});
    }
    expect(seen.size).toBe(1);expect(client).not.toHaveBeenCalled();
    await executeFtp(bridge,{account_id:'account',idempotency_key:'historic_valid_key',
      operation:{action:'connect',path:'/public_html'}},undefined,identity,client as any);
    expect(bridge.mock.calls[2][0].idempotency_key).toBe('historic_valid_key');
  });
  it('rejects empty, oversized and control-containing keys before any bridge call',async()=>{
    for(const key of ['', ' ', 'x'.repeat(97), 'line\nend']){
      const f=fixture();
      expect(await f.run('connect',{},undefined,key)).toMatchObject({ok:false,error:'ftp_invalid_idempotency_key'});
      expect(f.bridge).not.toHaveBeenCalled();expect(f.client.access).not.toHaveBeenCalled();
    }
  });
  it('preserves the safe Core validation code but never echoes arbitrary errors',async()=>{
    for(const [code,expected] of [['ftp_invalid_idempotency_key','ftp_invalid_idempotency_key'],['PASS '+secret,'ftp_operation_failed']]){
      vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({error:code})})));
      const result=await executeFtp(ftpBridge({socketUrl:'wss://query.test/ws/',auth:{token:'test'}},'1'),
        {account_id:'account',idempotency_key:'valid_key',operation:{action:'connect',path:'/public_html'}},undefined,identity);
      expect(result).toMatchObject({ok:false,error:expected,status_recorded:false});
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
describe('FTP/FTPS runtime secret boundary',()=>{
  it('unseals only inside executor, pins endpoint, TLS and returns safe list',async()=>{
    const f=fixture();const result=await f.run();expect(result).toMatchObject({ok:true,status:'completed'});
    expect(f.client.access).toHaveBeenCalledWith(expect.objectContaining({host:'93.184.216.34',secure:true,password:secret,secureOptions:expect.objectContaining({servername:'ftp.example.test',rejectUnauthorized:true})}));
    expect(f.client.ftp.verbose).toBe(false);expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(f.calls)).not.toContain(secret);expect(f.client.close).toHaveBeenCalled();
  });
  it('uses plain FTP only when selected, never downgrades after TLS failure',async()=>{
    const plain=fixture({protocol:'ftp'});expect(await plain.run()).toMatchObject({ok:true});
    expect(plain.client.access).toHaveBeenCalledWith(expect.objectContaining({secure:false}));
    expect(plain.client.access.mock.calls[0][0]).not.toHaveProperty('secureOptions');
    const tls=fixture({protocol:'ftps',failAccess:true});expect(await tls.run()).toMatchObject({ok:false});
    expect(tls.client.access).toHaveBeenCalledTimes(1);
    expect(tls.client.access).toHaveBeenCalledWith(expect.objectContaining({secure:true}));
    const invalid=fixture({protocol:'sftp'});expect(await invalid.run()).toMatchObject({ok:false});
    expect(invalid.client.access).not.toHaveBeenCalled();
  });
  it('redacts secret echoed in a file name',async()=>{const f=fixture({echo:true});expect(JSON.stringify(await f.run())).not.toContain(secret);});
  it('never connects for expired or replayed leases',async()=>{
    for(const opts of [{expired:true},{noEnvelope:true}]){const f=fixture(opts);await f.run();expect(f.client.access).not.toHaveBeenCalled();}
  });
  it('denies remote path escape before connecting',async()=>{const f=fixture();expect(await f.run('list',{path:'/etc'})).toMatchObject({ok:false});expect(f.client.access).not.toHaveBeenCalled();});
  it('uploads to a temporary sibling then renames, does not return credentials',async()=>{
    const root=await mkdtemp(join(tmpdir(),'query-ftp-'));folders.push(root);await writeFile(join(root,'index.html'),'test');
    const f=fixture();expect(await f.run('upload',{},root)).toMatchObject({ok:true,bytes:4});
    expect(f.client.uploadFrom.mock.calls[0][1]).toMatch(/^\/public_html\/\.query-.*\.part$/);
    expect(f.client.rename).toHaveBeenCalledWith(expect.stringContaining('.part'),'/public_html/index.html');
    expect(f.calls[0]).toMatchObject({operation:{size:4,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}});
  });
  it('marks interrupted writes uncertain without replay or raw error',async()=>{
    const f=fixture({failRename:true});const result=await f.run('rename',{path:'/public_html/index.html',destination:'/public_html/new.html'});
    expect(result).toMatchObject({status:'uncertain',status_recorded:true});expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.client.rename).toHaveBeenCalledTimes(1);
  });
  it('rejects symlinks and revocation before rename',async()=>{
    for(const opts of [{symlink:true},{revoke:true}]){const f=fixture(opts);await f.run('rename',{path:'/public_html/index.html',destination:'/public_html/new.html'});expect(f.client.rename).not.toHaveBeenCalled();}
  });
  it('denies upload without trusted workspace',async()=>{const f=fixture();expect(await f.run('upload')).toMatchObject({ok:false});expect(f.bridge).not.toHaveBeenCalled();});
  it('keeps failed status reporting visible',async()=>{const f=fixture({failRename:true,failFinish:true});expect(await f.run('rename',{path:'/public_html/index.html',destination:'/public_html/new.html'})).toMatchObject({status:'uncertain',status_recorded:false});});
  it('requires HTTPS and refuses redirect-following on the secret bridge',async()=>{
    expect(()=>ftpBridge({socketUrl:'ws://query.test/ws/',auth:{token:'private-token'}},'1')).toThrow();
    const mock=vi.fn(async()=>({ok:true,json:async()=>({allowed:true})}));vi.stubGlobal('fetch',mock);
    await ftpBridge({socketUrl:'wss://query.test/ws/?token=not-in-url',auth:{token:'private-token'}},'1')({action:'check',operation_id:'op'});
    expect(mock.mock.calls[0][0]).toBe('https://query.test/api/v4/openclaw-agent/ftp/');
    expect(mock.mock.calls[0][1]).toMatchObject({redirect:'error'});
  });
});
