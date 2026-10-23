import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ProxyAgent } from 'undici';
import { z } from 'zod';
import { AppError, emptyLibrary, librarySchema, validateLibrary, type Library, type Entity } from '../shared/model';
import { websiteOrigin, type CloudAccount, type CloudInflight, type CloudLinkReply, type CloudSnapshot, type CloudSyncStatus } from '../shared/cloud-sync';
import { changesBetween, mergeOperation, type SyncOperation, type SyncResult, type SyncConflict } from '../shared/sync';
import { assertOrigin, authenticate, resolveIdentity, type Env } from '../worker/auth';
import { commitLibrary, readLibrary } from '../worker/store';
import type { LocalDatabase } from './database';

export type SecretCodec = { encrypt(value:string):Promise<string>; decrypt(value:string):Promise<string> };
type Locked = <T>(work:()=>Promise<T>)=>Promise<T>;
type ConflictState = { id:string; values:SyncConflict[]; direction:'pull'|'push'; remote:Library; localRevision:number };
type Link = { site:string; proxy?:string; deviceId:string; account:CloudAccount; secret:string; baseline:Library; epoch:string; remoteRevision:number; localEpoch:string; localRevision:number; enabled:boolean; review:boolean; lastSync?:string; error?:string; errorCode?:string; inflight?:CloudInflight; conflict?:ConflictState; localCards:number; remoteCards:number };
type Options = { codec?:SecretCodec; fetch?:typeof fetch; allowTestLoopback?:boolean; autoStart?:boolean; intervalMs?:number };
const daily = (library:Library):Library => ({...library,revisions:[]});
const active = (library:Library)=>library.cards.filter(c=>!c.archived).length;
const confirmed = z.object({confirmed:z.literal(true)}).strict();

/** CLI uses the same Windows-user protection without depending on Electron. */
function windowsSecret(value:string,decrypt:boolean):string {
  if(process.platform!=='win32') throw new AppError(503,'当前系统没有配置安全的凭证存储');
  const script = 'Add-Type -AssemblyName System.Security; $cloudSecret=[Console]::In.ReadToEnd(); '+(decrypt
    ? '[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($cloudSecret),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
    : '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($cloudSecret),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:value,encoding:'utf8',windowsHide:true});
  if(result.status!==0) throw new AppError(503,'本机加密凭证暂时无法读取，请使用原 Windows 账户打开客户端');
  return result.stdout.trim();
}
export const windowsCodec:SecretCodec = {encrypt:async value=>'dpapi:'+windowsSecret(value,false),decrypt:async value=>{if(!value.startsWith('dpapi:'))throw new AppError(503,'请用桌面客户端读取这个网站连接；本地题库仍可正常使用');return windowsSecret(value.slice(6),true);}};
function proxyAddress(value:string|undefined) {
  if(!value?.trim()) return undefined;
  let url:URL; try{url=new URL(value.trim());}catch{throw new AppError(422,'代理地址格式不正确');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new AppError(422,'可选代理须为本机 HTTP 代理地址，例如 http://127.0.0.1:7897');
  return url.origin;
}
function resolveOperation(base:Library,operation:SyncOperation,incomingWins:boolean) {
  const copy=structuredClone(operation), checked=mergeOperation(base,copy);
  for(const conflict of checked.conflicts) {
    const change=copy.changes.find(v=>v.kind===conflict.kind&&v.id===conflict.id);
    if(!change) throw new AppError(409,'关联记录存在冲突，请先调整相关卡片后重新检查');
    const current=(base[change.kind] as Entity[]).find(v=>v.id===change.id);
    if(['record','delete','deleted'].includes(conflict.field)) {
      if(incomingWins) change.before=current?{...current}:null;
      else copy.changes=copy.changes.filter(v=>v!==change);
    } else if(incomingWins) change.before![conflict.field]=(current as unknown as Record<string,unknown>)[conflict.field];
    else change.after![conflict.field]=(current as unknown as Record<string,unknown>)[conflict.field];
  }
  const result=mergeOperation(base,copy);
  if(result.conflicts.length) throw new AppError(409,'关联记录仍有冲突，请先调整题目或关系后重新检查');
  return result.target;
}

export class DesktopCloudSync {
  private codec:SecretCodec; private running=new Map<string,Promise<void>>(); private controllers=new Set<AbortController>();
  private timer?:ReturnType<typeof setInterval>; private changedTimer?:ReturnType<typeof setTimeout>; private stopped=false;
  private retry=new Map<string,number>(); private tokens=new Map<string,string>(); private proxies=new Map<string,ProxyAgent>();
  constructor(private db:LocalDatabase,private env:Env,private locked:Locked,private dataDir:string,private options:Options={}) {
    this.codec=options.codec??windowsCodec;
    if(options.autoStart!==false)this.start();
  }
  private key(user:string){return 'website-sync:'+user;}
  private get(user:string):Link|undefined { const row=this.db.raw.prepare('SELECT value FROM desktop_settings WHERE key=?').get(this.key(user));return row?JSON.parse(String(row.value)):undefined; }
  private save(user:string,value:Link){this.db.raw.prepare('INSERT INTO desktop_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(user),JSON.stringify(value));}
  private epoch(user:string){return String(this.db.raw.prepare('SELECT epoch FROM sync_state WHERE user_id=?').get(user)?.epoch);}
  private revision(user:string){return Number(this.db.raw.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').get(user)?.revision??0);}
  start(){this.stopped=false;if(this.timer)return;this.timer=setInterval(()=>void this.tick(),this.options.intervalMs??20000);this.timer.unref();void this.tick();}
  changed(){if(this.stopped)return;if(this.changedTimer)clearTimeout(this.changedTimer);this.changedTimer=setTimeout(()=>{this.retry.clear();void this.tick();},1500);this.changedTimer.unref();}
  private async tick(){if(this.stopped)return;const users=await this.locked(async()=>this.db.raw.prepare("SELECT substr(key,14) AS user FROM desktop_settings WHERE key LIKE 'website-sync:%'").all().map(r=>String(r.user))).catch(()=>[]);for(const user of users)if((this.retry.get(user)??0)<Date.now())this.kick(user);}
  kick(user:string){if(this.stopped||this.running.has(user))return;const job=this.cycle(user).catch(()=>undefined).finally(()=>this.running.delete(user));this.running.set(user,job);}
  async syncNow(user:string){this.retry.delete(user);if(this.running.has(user))return this.running.get(user);const job=this.cycle(user).finally(()=>this.running.delete(user));this.running.set(user,job);return job;}
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;if(this.changedTimer)clearTimeout(this.changedTimer);for(const controller of this.controllers)controller.abort();await Promise.allSettled([...this.running.values()]);}
  async close(){await this.stop();for(const proxy of this.proxies.values())await proxy.close();this.tokens.clear();}
  private async call<T>(link:Pick<Link,'site'|'proxy'|'secret'>,action:string,value?:unknown):Promise<T> {
    const headers:Record<string,string>={Origin:link.site};
    if(link.secret){let token=this.tokens.get(link.secret);if(!token){token=await this.codec.decrypt(link.secret);this.tokens.set(link.secret,token);}headers.Authorization='Bearer '+token;}
    if(value!==undefined)headers['Content-Type']='application/json';
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),15000);this.controllers.add(controller);
    try {
      let dispatcher:ProxyAgent|undefined;
      if(link.proxy){dispatcher=this.proxies.get(link.proxy);if(!dispatcher){dispatcher=new ProxyAgent(link.proxy);this.proxies.set(link.proxy,dispatcher);}}
      const init:RequestInit&{dispatcher?:ProxyAgent}={method:value===undefined?'GET':'POST',headers,body:value===undefined?undefined:JSON.stringify(value),redirect:'error',signal:controller.signal,...(dispatcher?{dispatcher}:{})};
      const response=await (this.options.fetch??fetch)(link.site+'/api/v1/device-sync/'+action,init);
      if(!response.headers.get('content-type')?.includes('application/json'))throw new AppError(response.status===401?401:502,'网站暂时不可达或需要重新登录，本地修改仍保留','CLOUD_CONNECTION');
      const data=await response.json() as {error?:{message?:string;code?:string}};
      if(!response.ok)throw new AppError(response.status,data.error?.message??'网站同步尚未完成',data.error?.code??'CLOUD_CONNECTION');
      if(action==='connect')z.object({token:z.string().regex(/^[a-f0-9]{64}$/),deviceId:z.string().min(1).max(128),account:z.object({user_id:z.string().min(1).max(128),email:z.string().min(1).max(255),display_name:z.string().max(120)})}).parse(data);
      if(action.startsWith('snapshot')){const snapshot=data as CloudSnapshot;z.object({epoch:z.string().min(1).max(128),revision:z.number().int().nonnegative()}).parse(snapshot);if(snapshot.library){snapshot.library=librarySchema.parse(snapshot.library);validateLibrary(snapshot.library);}}
      return data as T;
    }catch(error){if(error instanceof AppError)throw error;throw new AppError(503,'暂时无法连接网站，本地修改已保留，联网后会自动重试；必要时检查本机代理设置','CLOUD_CONNECTION');}
    finally{clearTimeout(timeout);this.controllers.delete(controller);}
  }
  async status(user:string):Promise<CloudSyncStatus>{return this.locked(async()=>{
    const link=this.get(user);if(!link)return{connected:false,enabled:false,phase:'unlinked'};
    const pending=!!link.inflight||link.localRevision!==this.revision(user);
    const phase:CloudSyncStatus['phase']=link.review?'review':link.errorCode?.includes('EPOCH')?'recovery':link.conflict?'conflict':!link.enabled?'paused':this.running.has(user)?'syncing':link.error?'error':pending?'pending':'idle';
    const conflicts=link.conflict?.values.map(value=>{
      if(value.kind!=='cards')return value;
      const row=this.db.raw.prepare('SELECT payload FROM user_cards WHERE user_id=? AND id=?').get(user,value.id);
      const card=row?JSON.parse(String(row.payload)):link.conflict!.remote.cards.find(card=>card.id===value.id)??link.inflight?.sent.cards.find(card=>card.id===value.id);
      return {...value,label:card?.question||card?.title};
    });
    return{connected:true,enabled:link.enabled,phase,site:link.site,proxy:link.proxy,account:link.account,lastSync:link.lastSync,error:link.error,errorCode:link.errorCode,pending,conflicts,localCards:link.localCards,remoteCards:link.remoteCards};
  });}
  async connect(user:string,values:{site:string;code:string;name:string;proxy?:string}) {
    let site:string;try{site=websiteOrigin(values.site,this.options.allowTestLoopback);}catch(error){throw new AppError(422,error instanceof Error?error.message:'网站地址不正确');}const proxy=proxyAddress(values.proxy);
    const previous=await this.locked(async()=>this.get(user));
    if(previous)throw new AppError(409,'已有网站连接，请先暂停并解除旧连接；题库会保留');
    await this.codec.encrypt('availability-check');
    const reply=await this.call<CloudLinkReply>({site,proxy,secret:''},'connect',{code:values.code.trim(),name:values.name});
    const secret=await this.codec.encrypt(reply.token);this.tokens.set(secret,reply.token);
    const temp={site,proxy,secret};
    try {
    const snapshot=await this.call<CloudSnapshot>(temp,'snapshot');
    if(!snapshot.library)throw new AppError(502,'网站没有返回首次核对所需的题库');
    await this.locked(async()=>{
      if(this.get(user))throw new AppError(409,'另一项连接已完成，请保留当前连接');
      const local=await readLibrary(this.db.asD1(),user);
      this.save(user,{...temp,deviceId:reply.deviceId,account:reply.account,baseline:emptyLibrary(),epoch:snapshot.epoch,remoteRevision:-1,localEpoch:this.epoch(user),localRevision:local.revision,enabled:false,review:true,localCards:active(local),remoteCards:active(snapshot.library!)});
    });
    return this.status(user);
    } catch(error) {
      // A failed preview must not silently leave another usable website grant.
      await this.call(temp,'disconnect',{confirmed:true}).catch(()=>undefined);
      this.tokens.delete(secret);throw error;
    }
  }
  async enable(user:string) {
    await this.locked(async()=>{
      const link=this.get(user);if(!link)throw new AppError(404,'尚未连接网站');
      if(link.errorCode?.includes('EPOCH'))throw new AppError(409,'题库已恢复，请重新连接并核对两边的内容');
      if(link.review)await this.db.saveBackup(join(this.dataDir,'backups',`before-website-sync-${Date.now()}.sqlite`));
      link.enabled=true;link.review=false;link.error=undefined;link.errorCode=undefined;this.save(user,link);
    });this.kick(user);return this.status(user);
  }
  async pause(user:string){await this.locked(async()=>{const link=this.get(user);if(link){link.enabled=false;this.save(user,link);}});return this.status(user);}
  async network(user:string,proxy:string|undefined){await this.locked(async()=>{const link=this.get(user);if(!link)throw new AppError(404,'尚未连接网站');link.proxy=proxyAddress(proxy);if(!link.errorCode?.includes('EPOCH')){link.error=undefined;link.errorCode=undefined;}this.save(user,link);});this.retry.delete(user);this.kick(user);return this.status(user);}
  async disconnect(user:string){if(this.running.has(user))throw new AppError(409,'正在同步，请先暂停并等待本次操作结束');const link=await this.locked(async()=>this.get(user));if(!link)return this.status(user);try{await this.call(link,'disconnect',{confirmed:true});}catch(error){if(!(error instanceof AppError&&error.code==='CLOUD_RECONNECT'))throw error;}
    await this.locked(async()=>this.db.raw.prepare('DELETE FROM desktop_settings WHERE key=?').run(this.key(user)));this.tokens.delete(link.secret);return this.status(user);
  }
  private async recordError(user:string,error:unknown){if(this.stopped)return;this.retry.set(user,Date.now()+60000);await this.locked(async()=>{const link=this.get(user);if(link){link.error=error instanceof AppError?error.message:'同步尚未完成，本地修改仍保留';link.errorCode=error instanceof AppError?error.code:'CLOUD_CONNECTION';this.save(user,link);}});}
  private async pending(user:string,link:Link) {
    if(!link.inflight)return true;
    const result=await this.call<SyncResult>(link,'push',link.inflight.operation);
    if(result.id!==link.inflight.operation.id||!['applied','conflict'].includes(result.status)||!Array.isArray(result.conflicts))throw new AppError(502,'网站回执不完整，待同步操作仍保留，将自动重试','CLOUD_PROTOCOL');
    return this.locked(async()=>{
      const current=this.get(user);if(!current||current.inflight?.operation.id!==link.inflight!.operation.id)return false;
      if(result.status==='conflict') {
        current.conflict={id:crypto.randomUUID(),values:result.conflicts,direction:'push',remote:link.baseline,localRevision:this.revision(user)};
        this.save(user,current);return false;
      }
      current.baseline=daily(current.inflight.sent);current.localRevision=current.inflight.localRevision;current.remoteRevision=-1;current.inflight=undefined;current.error=undefined;current.errorCode=undefined;current.lastSync=new Date().toISOString();this.save(user,current);return true;
    });
  }
  private async cycle(user:string) {
    try {
      let link=await this.locked(async()=>{if(this.db.raw.prepare('SELECT status FROM users WHERE id=?').get(user)?.status!=='active')return undefined;const value=this.get(user);if(value&&value.enabled&&!value.review&&!value.conflict&&this.epoch(user)!==value.localEpoch)throw new AppError(409,'本机题库已恢复备份，请重新连接并核对；网站不会自动覆盖本机','LOCAL_EPOCH_CHANGED');return value;});
      if(!link?.enabled||link.review||link.conflict||link.errorCode?.includes('EPOCH')||this.stopped)return;
      if(link.inflight&&!await this.pending(user,link))return;
      link=(await this.locked(async()=>this.get(user)))!;if(!link?.enabled||this.stopped)return;
      const remote=await this.call<CloudSnapshot>(link,`snapshot?revision=${link.remoteRevision}&epoch=${encodeURIComponent(link.epoch)}`);
      const outgoing=await this.locked(async()=>this.db.transaction(async()=>{
        const current=this.get(user);if(!current?.enabled||current.deviceId!==link!.deviceId||this.stopped||this.db.raw.prepare('SELECT status FROM users WHERE id=?').get(user)?.status!=='active')return undefined;
        if(this.epoch(user)!==current.localEpoch)throw new AppError(409,'本机题库已恢复备份，请重新连接并核对','LOCAL_EPOCH_CHANGED');
        if(remote.epoch!==current.epoch)throw new AppError(409,'网站题库已恢复备份，请重新连接并核对，本地修改仍保留','CLOUD_EPOCH_CHANGED');
        const remoteLibrary=remote.library??current.baseline,local=await readLibrary(this.db.asD1(),user);
        const operation:SyncOperation={id:crypto.randomUUID(),epoch:remote.epoch,changes:changesBetween(current.baseline,remoteLibrary)};
        const merged=mergeOperation(local,operation);
        if(merged.conflicts.length){current.conflict={id:crypto.randomUUID(),direction:'pull',remote:daily(remoteLibrary),localRevision:local.revision,values:merged.conflicts.map(v=>({...v,computer:v.phone,phone:v.computer}))};current.error=undefined;this.save(user,current);return undefined;}
        let next=local;if(changesBetween(local,merged.target).length)next=await commitLibrary(this.db.asD1(),user,local,merged.target);
        const changes=changesBetween(remoteLibrary,next);
        current.localCards=active(next);current.remoteCards=active(remoteLibrary);current.error=undefined;current.errorCode=undefined;
        if(changes.length)current.inflight={operation:{id:crypto.randomUUID(),epoch:remote.epoch,changes},sent:daily(next),localRevision:next.revision};
        else{current.baseline=daily(remoteLibrary);current.remoteRevision=remote.revision;current.localRevision=next.revision;current.lastSync=new Date().toISOString();}
        this.save(user,current);return current.inflight?current:undefined;
      }));
      if(outgoing&&!this.stopped)await this.pending(user,outgoing);
      this.retry.delete(user);
    }catch(error){await this.recordError(user,error);}
  }
  async resolve(user:string,choice:'local'|'remote') {
    if(this.running.has(user))throw new AppError(409,'正在同步，请稍后处理');
    const link=await this.locked(async()=>this.get(user));if(!link?.conflict)throw new AppError(409,'冲突已改变，请重新检查');
    const remote=await this.call<CloudSnapshot>(link,'snapshot');if(!remote.library)throw new AppError(502,'网站题库未读取完成');
    await this.locked(async()=>this.db.transaction(async()=>{
      const current=this.get(user);if(current?.conflict?.id!==link.conflict!.id)throw new AppError(409,'冲突已改变，请重新检查');
      if(this.epoch(user)!==current.localEpoch||remote.epoch!==current.epoch)throw new AppError(409,'题库已恢复，需要重新连接核对','CLOUD_EPOCH_CHANGED');
      const local=await readLibrary(this.db.asD1(),user);
      if(local.revision!==current.conflict.localRevision)throw new AppError(409,'本地又有修改，请点击重新检查后再选择');
      let target:Library;
      if(current.conflict.direction==='pull') {
        if(remote.library!.revision!==current.conflict.remote.revision)throw new AppError(409,'网站又有修改，请点击重新检查后再选择');
        target=resolveOperation(local,{id:crypto.randomUUID(),epoch:current.epoch,changes:changesBetween(current.baseline,remote.library!)},choice==='remote');
      }else {
        const wanted=resolveOperation(remote.library!,current.inflight!.operation,choice==='local');
        const apply=mergeOperation(local,{id:crypto.randomUUID(),epoch:current.epoch,changes:changesBetween(current.inflight!.sent,wanted)});
        if(apply.conflicts.length)throw new AppError(409,'本地内容又有变化，请重新检查');target=apply.target;
      }
      if(changesBetween(local,target).length)await commitLibrary(this.db.asD1(),user,local,target);
      current.baseline=daily(remote.library!);current.remoteRevision=remote.revision;current.conflict=undefined;current.inflight=undefined;current.error=undefined;current.errorCode=undefined;this.save(user,current);
    }));this.kick(user);return this.status(user);
  }
  async recheck(user:string){await this.locked(async()=>{const link=this.get(user);if(link){if(link.conflict?.direction==='push')link.inflight=undefined;link.conflict=undefined;link.error=undefined;this.save(user,link);}});this.kick(user);return this.status(user);}
  async handle(request:Request,origin:string) {
    if(new URL(request.url).origin!==origin)throw new AppError(403,'请在电脑客户端配置网站同步');
    assertOrigin(request,this.env);
    const identity=await this.locked(async()=>resolveIdentity(await authenticate(request,this.env),request,this.env));
    if(!['admin','member'].includes(identity.role))throw new AppError(403,'请用自己的客户端账号配置同步');
    const user=identity.user_id,action=new URL(request.url).pathname.slice('/api/v1/desktop/cloud-sync'.length);
    if(request.method==='GET'&&action==='')return Response.json(await this.status(user));
    if(request.method!=='POST')throw new AppError(404,'同步接口不存在');
    const value=await request.json();let result:CloudSyncStatus;
    if(action==='/connect')result=await this.connect(user,z.object({site:z.string().max(512),code:z.string().trim().regex(/^[a-f0-9]{64}$/),name:z.string().trim().min(1).max(80),proxy:z.string().max(128).optional()}).strict().parse(value));
    else if(action==='/enable'){confirmed.parse(value);result=await this.enable(user);}
    else if(action==='/pause'){z.object({}).strict().parse(value);result=await this.pause(user);}
    else if(action==='/network'){const v=z.object({proxy:z.string().max(128).optional()}).strict().parse(value);result=await this.network(user,v.proxy);}
    else if(action==='/now'){z.object({}).strict().parse(value);this.kick(user);result=await this.status(user);}
    else if(action==='/disconnect'){confirmed.parse(value);result=await this.disconnect(user);}
    else if(action==='/resolve'){const v=z.object({choice:z.enum(['local','remote']),confirmed:z.literal(true)}).strict().parse(value);result=await this.resolve(user,v.choice);}
    else if(action==='/recheck'){z.object({}).strict().parse(value);result=await this.recheck(user);}
    else throw new AppError(404,'同步接口不存在');
    return Response.json(result);
  }
}
