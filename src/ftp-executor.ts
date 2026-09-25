import { Client } from "basic-ftp";
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { queryApiUrl } from "./query-api.js";

type Auth = {socketUrl: string; auth: {token: string}};
type Policy = {protocol?:'ftp'|'ftps';host:string;port:number;root:string;operations:string[];allow_schedules:boolean;
  username_field:string;password_field:string;runtime_key:string;approved_ips:string[]};
type Operation = {action:string;path:string;destination?:string;sha256?:string;size?:number};
type Lease = {operation_id:string;expires_at:string;operation:Operation;policy:Policy;credentials:{user:string;password:string}};
type Reply = {operation_id?:string;status?:string;allowed?:boolean;envelope?:{key:string;nonce:string;data:string};[key:string]:unknown};
export type Bridge = (body:Record<string,unknown>) => Promise<Reply>;

// This key belongs to the runtime, not to a model tool. Persist across cron runs.
export function runtimeIdentity() {
  const root = process.env.OPENCLAW_STATE_DIR || path.join(homedir(), '.openclaw');
  mkdirSync(root, {recursive:true,mode:0o700});
  const file = path.join(root, 'query-ftp-runtime.json');
  try {
    const existing=JSON.parse(readFileSync(file,'utf8'));
    if(!existing.publicKey||!existing.privateKey)throw new Error('ftp_runtime_identity_unavailable');
    chmodSync(file,0o600);return existing as {publicKey:string;privateKey:string};
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('ftp_runtime_identity_unavailable');}
  try {
    const pair = generateKeyPairSync('rsa', {modulusLength:2048,
      publicKeyEncoding:{type:'spki',format:'pem'}, privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    writeFileSync(file, JSON.stringify(pair), {flag:'wx',mode:0o600});
  } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('ftp_runtime_identity_unavailable'); }
  chmodSync(file,0o600);
  return JSON.parse(readFileSync(file,'utf8')) as {publicKey:string;privateKey:string};
}

const SAFE_ERRORS=new Set([
  'ftp_invalid_options','ftp_account_not_shared','ftp_label_required','ftp_invalid_parameters','ftp_invalid_policy','ftp_invalid_host','ftp_invalid_port','ftp_invalid_path',
  'ftp_invalid_operations','ftp_invalid_field_mapping','ftp_invalid_runtime_key','ftp_stored_credential_required',
  'ftp_credential_fields_missing','ftp_public_destination_required','ftp_authorization_required','ftp_schedule_not_authorized',
  'ftp_operation_not_authorized','ftp_path_outside_root','ftp_root_mutation_forbidden','ftp_invalid_upload',
  'ftp_idempotency_conflict','ftp_operation_expired','ftp_owner_required','owner_interactive_turn_required',
  'account_unavailable','agent_unavailable','connection_unavailable','delegated_access_unavailable',
  'ftp_runtime_identity_unavailable','ftp_upload_workspace_required','ftp_upload_outside_workspace','ftp_upload_too_large',
  'ftp_upload_changed','ftp_lease_mismatch','ftp_lease_expired','ftp_root_not_canonical','ftp_unsafe_directory',
  'ftp_symlink_forbidden','ftp_directory_required','ftp_file_required','ftp_size_mismatch','ftp_authorization_changed',
  'ftp_https_required',
]);
export function safeFtpError(error:unknown) {
  if(error instanceof Error && SAFE_ERRORS.has(error.message))return error.message;
  const code=(error as {code?:unknown})?.code;
  if(code===530)return 'ftp_authentication_failed';
  if(['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(String(code)))return 'ftp_tls_certificate_rejected';
  return 'ftp_operation_failed';
}

export function ftpBridge(auth:Auth, threadId:string):Bridge {
  const url = queryApiUrl(auth.socketUrl, 'ftp/');
  if (!url.startsWith('https://')) throw new Error('ftp_https_required');
  return async body => {
    const response = await fetch(url, {method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json','X-Query-Delegated-Token':auth.auth.token},
      body:JSON.stringify({...body,thread_id:threadId})});
    if (!response.ok) {
      // Only known codes may escape, never raw bodies or provider messages.
      const error=await response.json().catch(()=>undefined) as {error?:unknown}|undefined;
      throw new Error(typeof error?.error==='string' && SAFE_ERRORS.has(error.error)?error.error:'ftp_operation_failed');
    }
    return await response.json() as Reply;
  };
}

function inside(value:string, root:string) {
  if (!value.startsWith('/') || /[\\\x00-\x1f]/.test(value) || value.split('/').some(s=>s==='..'||s==='.')) throw new Error('ftp_invalid_path');
  const normalized=path.posix.normalize(value);
  if (normalized!==root && !normalized.startsWith(root.replace(/\/$/,'')+'/')) throw new Error('ftp_path_outside_root');
  return normalized;
}

function unseal(reply:Reply, privateKey:string):Lease {
  const envelope=reply.envelope!;
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.key,'base64'));
  try {
    const data=Buffer.from(envelope.data,'base64');
    const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'));
    cipher.setAAD(Buffer.from(reply.operation_id!)); cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(0,-16)),cipher.final()]).toString());
  } finally {key.fill(0);}
}

async function uploadBytes(file:string, root:string|undefined) {
  if(!root) throw new Error('ftp_upload_workspace_required');
  const base=await realpath(root), resolved=await realpath(path.resolve(base,file));
  const relative=path.relative(base,resolved);
  if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ftp_upload_outside_workspace');
  const fd=await open(resolved,'r');
  try {
    const stat=await fd.stat();
    if(!stat.isFile()||stat.size>20*1024*1024) throw new Error('ftp_upload_too_large');
    const bytes=Buffer.alloc(stat.size+1);
    const {bytesRead}=await fd.read(bytes,0,bytes.length,0);
    if(bytesRead!==stat.size) throw new Error('ftp_upload_changed');
    return bytes.subarray(0,bytesRead);
  } finally {await fd.close();}
}

// Reject links, and verify canonical directory after every CWD. The server account
// must also be jailed: no FTP client can constrain a malicious server's filesystem.
async function enterParent(client:Client, target:string, root:string) {
  const parent=path.posix.dirname(target);
  await client.cd(root);
  if(path.posix.normalize(await client.pwd())!==root) throw new Error('ftp_root_not_canonical');
  const parts=path.posix.relative(root,parent).split('/').filter(Boolean);
  let current=root;
  for(const part of parts) {
    const item=(await client.list()).find(entry=>entry.name===part);
    if(!item?.isDirectory || item.isSymbolicLink) throw new Error('ftp_unsafe_directory');
    current=path.posix.join(current,part);await client.cd(current);
    if(path.posix.normalize(await client.pwd())!==current) throw new Error('ftp_unsafe_directory');
  }
  const item=(await client.list()).find(entry=>entry.name===path.posix.basename(target));
  if(item?.isSymbolicLink) throw new Error('ftp_symlink_forbidden');
  return item;
}

export async function executeFtp(bridge:Bridge, params:{account_id:string;idempotency_key:string;operation:Operation;local_file?:string},
  workspace:string|undefined, identity=runtimeIdentity(), makeClient=()=>new Client(15000,{allowSeparateTransferHost:false,maxListingBytes:1024*1024})) {
  let bytes:Buffer|undefined, lease:Lease|undefined, reply:Reply|undefined, client:Client|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined, mutation=false;
  const output:Record<string,unknown>={};
  try {
    const operation={...params.operation};
    if(operation.action==='upload') {
      bytes=await uploadBytes(params.local_file!,workspace);
      operation.size=bytes.length;operation.sha256=createHash('sha256').update(bytes).digest('hex');
    }
    reply=await bridge({action:'begin',account_id:params.account_id,idempotency_key:params.idempotency_key,operation});
    if(!reply.envelope) return {operation_id:reply.operation_id,status:reply.status};
    lease=unseal(reply,identity.privateKey);
    if(lease.operation_id!==reply.operation_id||JSON.stringify(lease.operation)!==JSON.stringify(operation)) {
      // Object key order is not a security property.
      if(lease.operation_id!==reply.operation_id||Object.keys(operation).some(k=>operation[k as keyof Operation]!==lease!.operation[k as keyof Operation])) throw new Error('ftp_lease_mismatch');
    }
    const policy=lease.policy, op=lease.operation;
    if(policy.runtime_key!==identity.publicKey||!policy.operations.includes(op.action)) throw new Error('ftp_lease_mismatch');
    inside(op.path,policy.root);if(op.destination)inside(op.destination,policy.root);
    const remaining=Date.parse(lease.expires_at)-Date.now();
    if(remaining<=0||remaining>65000||!policy.approved_ips.length)throw new Error('ftp_lease_expired');
    client=makeClient();client.ftp.verbose=false;
    timer=setTimeout(()=>client?.close(),remaining);
    const check=async()=>{if(Date.now()>=Date.parse(lease!.expires_at))throw new Error('ftp_lease_expired');
      const state=await bridge({action:'check',operation_id:lease!.operation_id});if(state.allowed!==true)throw new Error('ftp_authorization_changed');};
    await check();
    if(policy.protocol!==undefined && !['ftp','ftps'].includes(policy.protocol))throw new Error('ftp_invalid_options');
    const secure=policy.protocol!=='ftp';
    await client.access({host:policy.approved_ips[0],port:policy.port,...lease.credentials,secure,
      ...(secure?{secureOptions:{servername:policy.host,rejectUnauthorized:true,minVersion:'TLSv1.2' as const}}:{})});
    await client.cd(policy.root);
    if(path.posix.normalize(await client.pwd())!==policy.root)throw new Error('ftp_root_not_canonical');
    await check();
    if(op.action==='list') {
      if(op.path!==policy.root) {
        const entry=await enterParent(client,op.path,policy.root);
        if(!entry?.isDirectory)throw new Error('ftp_directory_required');
        await client.cd(op.path);
        if(path.posix.normalize(await client.pwd())!==op.path)throw new Error('ftp_unsafe_directory');
      }
      const entries=await client.list();
      output.entries=entries.slice(0,200).map(entry=>({name:entry.name,type:entry.isSymbolicLink?'link':entry.isDirectory?'directory':'file',size:entry.size}));
      output.truncated=entries.length>200;
    } else if(op.action==='upload') {
      const existing=await enterParent(client,op.path,policy.root);
      if(existing&&!existing.isFile)throw new Error('ftp_file_required');
      const temp=path.posix.join(path.posix.dirname(op.path),`.query-${randomUUID()}.part`);
      await check();mutation=true;
      await client.uploadFrom(Readable.from(bytes!),temp);
      if(await client.size(temp)!==bytes!.length)throw new Error('ftp_size_mismatch');
      await check();
      await client.rename(temp,op.path); // Never delete the destination as fallback.
      output.bytes=bytes!.length;
    } else if(op.action==='rename') {
      const source=await enterParent(client,op.path,policy.root);
      if(!source?.isFile)throw new Error('ftp_file_required');
      const target=await enterParent(client,op.destination!,policy.root);
      if(target&&!target.isFile)throw new Error('ftp_file_required');
      await check();mutation=true;await client.rename(op.path,op.destination!);
    } else if(op.action!=='connect') throw new Error('ftp_invalid_operation');
    client.close();
    await bridge({action:'finish',operation_id:lease.operation_id,status:'completed'});
    if(Array.isArray(output.entries))output.entries=output.entries.map(entry=>{
      let name=entry.name as string;
      for(const secret of Object.values(lease!.credentials))name=name.split(secret).join('[redacted]');
      return {...entry,name:name.slice(0,255)};
    });
    return {ok:true,operation_id:lease.operation_id,status:'completed',...output};
  } catch(error) {
    // Provider replies can echo PASS or USER. No error.message, stack or raw data escapes.
    const status=mutation?'uncertain':'failed';
    let recorded=false;
    if(reply?.operation_id)try {await bridge({action:'finish',operation_id:reply.operation_id,status});recorded=true;} catch {}
    return {ok:false,operation_id:reply?.operation_id,status,error:mutation?'ftp_result_uncertain':safeFtpError(error),status_recorded:recorded};
  } finally {
    if(timer)clearTimeout(timer);client?.close();bytes?.fill(0);
    if(lease){lease.credentials.user='';lease.credentials.password='';}
  }
}
