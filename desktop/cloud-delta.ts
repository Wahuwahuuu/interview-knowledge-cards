import { AppError, emptyLibrary, kinds, type Library } from '../shared/model';
import { changesBetween, type SyncChange, type SyncConflict, type SyncOperation } from '../shared/sync';
import { recordKey, recordMap, resolveRecords, sameRecord, type RecordKey, type SyncRecord } from '../shared/record-sync';
import type { CloudDelta, CloudPushResult } from '../shared/cloud-sync';
import { journalHead, readJournal, readRecords } from '../worker/change-journal';
import { commitIncremental, planIncremental } from '../worker/incremental-store';
import { readLibrary } from '../worker/store';
import type { LocalDatabase } from './database';

export type DeltaPending={operation:SyncOperation;sent:SyncRecord[];localBefore:number;ack?:CloudPushResult};
export type DeltaConflict={id:string;direction:'pull'|'push'|'ack';values:SyncConflict[];records:SyncRecord[];cursor:number;remoteRevision:number;localRevision:number};
export type DeltaState={protocol?:2;deltaPending?:DeltaPending;deltaConflict?:DeltaConflict;deltaMore?:boolean;deltaRetry?:RecordKey[]};
type BaseLink=DeltaState&{site:string;secret:string;proxy?:string;deviceId:string;baseline:Library;epoch:string;localEpoch:string;remoteRevision:number;localRevision:number;enabled:boolean;review:boolean;error?:string;errorCode?:string;lastSync?:string};
type Locked=<T>(work:()=>Promise<T>)=>Promise<T>;
type Call=<T>(link:BaseLink,action:string,value?:unknown)=>Promise<T>;

export class CloudDeltaEngine<L extends BaseLink> {
  constructor(private db:LocalDatabase,private locked:Locked,private get:(user:string)=>L|undefined,private save:(user:string,link:L)=>void,private call:Call){}
  private localEpoch(user:string){return String(this.db.raw.prepare('SELECT epoch FROM sync_state WHERE user_id=?').get(user)?.epoch);}
  private localRevision(user:string){return Number(this.db.raw.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').get(user)?.revision??0);}
  private check(user:string,link:L){if(this.localEpoch(user)!==link.localEpoch)throw new AppError(409,'本机题库已恢复备份，请重新核对','LOCAL_EPOCH_CHANGED');}
  private base(user:string,keys:RecordKey[]):SyncRecord[]{return keys.map(key=>{const row=this.db.raw.prepare('SELECT payload,remote_revision FROM website_sync_baseline WHERE user_id=? AND kind=? AND id=?').get(user,key.kind,key.id);return{...key,value:row?.payload?JSON.parse(String(row.payload)):null,revision:Number(row?.remote_revision??-1)};});}
  private remember(user:string,records:SyncRecord[]){const statement=this.db.raw.prepare('INSERT INTO website_sync_baseline(user_id,kind,id,payload,remote_revision) VALUES (?,?,?,?,?) ON CONFLICT(user_id,kind,id) DO UPDATE SET payload=excluded.payload,remote_revision=excluded.remote_revision');for(const row of records)statement.run(user,row.kind,row.id,row.value?JSON.stringify(row.value):null,row.revision??0);}
  private incoming(user:string,records:SyncRecord[]):SyncChange[]{const old=recordMap(this.base(user,records));return records.filter(row=>(row.revision??0)>(old.get(recordKey(row))?.revision??-1)).map(row=>({kind:row.kind,id:row.id,before:old.get(recordKey(row))?.value as unknown as SyncChange['before']??null,after:row.value as unknown as SyncChange['after']}));}
  private async stage(user:string,link:L,keys:RecordKey[],localBefore:number){
    const current=await readRecords(this.db.asD1(),user,keys),base=recordMap(this.base(user,current));
    const changes=current.filter(row=>!sameRecord(row.value,base.get(recordKey(row))?.value)).map(row=>({kind:row.kind,id:row.id,before:base.get(recordKey(row))?.value as unknown as SyncChange['before']??null,after:row.value as unknown as SyncChange['after']}));
    if(changes.length)link.deltaPending={operation:{id:crypto.randomUUID(),epoch:link.epoch,cursor:link.remoteRevision,changes},sent:current.filter(row=>changes.some(change=>recordKey(change)===recordKey(row))),localBefore};
  }
  /** One local indexing pass upgrades the old saved baseline, without replacing credentials. */
  async initialize(user:string,link:L){
    const remote=await this.call<{epoch:string;revision:number;floor:number}>(link,'head');
    if(remote.epoch!==link.epoch)throw new AppError(409,'网站题库已恢复，请重新核对','CLOUD_EPOCH_CHANGED');
    if(link.remoteRevision<remote.floor)return false;
    await this.locked(async()=>this.db.transaction(async()=>{
      const current=this.get(user);if(!current||current.protocol||current.deviceId!==link.deviceId)return;
      this.check(user,current);const local=await readLibrary(this.db.asD1(),user);
      this.db.raw.prepare('DELETE FROM website_sync_baseline WHERE user_id=?').run(user);
      this.remember(user,kinds.flatMap(kind=>current.baseline[kind].map(value=>({kind,id:value.id,value,revision:current.remoteRevision}))));
      const pending=changesBetween(current.baseline,local);current.protocol=2;current.localRevision=local.revision;
      if(pending.length)current.deltaPending={operation:{id:crypto.randomUUID(),epoch:current.epoch,cursor:current.remoteRevision,changes:pending},sent:pending.map(row=>({kind:row.kind,id:row.id,value:row.after as SyncRecord['value']})),localBefore:local.revision};
      current.baseline=emptyLibrary();this.save(user,current);
    }));return true;
  }
  /** Retry only an old acknowledgement with exactly the sent content; never choose a conflict side. */
  private async retryUnchangedAcknowledgment(user:string,link:L){return this.locked(async()=>{
    const current=this.get(user),pending=current?.deltaPending,ack=pending?.ack;
    if(!current?.enabled||current.deviceId!==link.deviceId||current.deltaConflict?.id!==link.deltaConflict?.id||current.deltaConflict?.direction!=='ack'||!pending||!ack||ack.status!=='applied'||ack.id!==pending.operation.id||ack.epoch!==current.epoch)return;
    const sent=recordMap(pending.sent);
    if(!sent.size||ack.records.length!==sent.size||new Set(ack.records.map(recordKey)).size!==sent.size||ack.records.some(row=>!sent.has(recordKey(row))||!sameRecord(row.value,sent.get(recordKey(row))?.value)))return;
    this.check(user,current);current.deltaConflict=undefined;this.save(user,current);return current;
  });}
  async cycle(user:string,link:L){
    if(link.deltaConflict){const retry=await this.retryUnchangedAcknowledgment(user,link);if(!retry)return;link=retry;}
    if(link.deltaPending){if(!await this.push(user,link))return;link=(await this.locked(async()=>this.get(user)))!;if(!link?.enabled||link.deltaConflict)return;}
    const page=await this.call<CloudDelta>(link,`pull?cursor=${link.remoteRevision}&epoch=${encodeURIComponent(link.epoch)}`);
    if(page.cursor<link.remoteRevision||page.cursor>page.revision||page.records.some(row=>row.revision===undefined||row.revision<=link.remoteRevision||row.revision>page.cursor))throw new AppError(502,'增量回执的同步位置不完整，现有修改仍保留','CLOUD_PROTOCOL');
    let outgoing:L|undefined;
    await this.locked(async()=>this.db.transaction(async()=>{
      const current=this.get(user);if(!current?.enabled||current.deviceId!==link.deviceId||current.deltaConflict)return;
      this.check(user,current);if(page.epoch!==current.epoch)throw new AppError(409,'网站题库已恢复，请重新核对','CLOUD_EPOCH_CHANGED');
      const before=current.localRevision,local=await readJournal(this.db.asD1(),user,before),incoming=this.incoming(user,page.records);
      const plan=await planIncremental(this.db.asD1(),user,incoming);
      if(plan.conflicts.length){current.deltaConflict={id:crypto.randomUUID(),direction:'pull',values:plan.conflicts.map(row=>({...row,computer:row.phone,phone:row.computer})),records:page.records.filter(row=>incoming.some(change=>recordKey(change)===recordKey(row))),cursor:page.cursor,remoteRevision:page.revision,localRevision:this.localRevision(user)};current.error=undefined;this.save(user,current);return;}
      const revision=this.localRevision(user);if(plan.changes.length)await commitIncremental(this.db.asD1(),user,revision,plan.changes);
      this.remember(user,page.records.filter(row=>(row.revision??0)>(this.base(user,[row])[0].revision??-1)));
      current.remoteRevision=page.cursor;current.deltaMore=page.hasMore;current.localRevision=local.hasMore?local.cursor:this.localRevision(user);current.error=undefined;current.errorCode=undefined;
      await this.stage(user,current,[...local.records,...page.records,...(current.deltaRetry??[])],before);current.deltaRetry=undefined;
      if(!current.deltaPending&&!page.hasMore)current.lastSync=new Date().toISOString();this.save(user,current);if(current.deltaPending)outgoing=current;
    }));
    if(outgoing)await this.push(user,outgoing);
  }
  private async push(user:string,link:L){
    const pending=link.deltaPending;if(!pending)return true;
    const result=pending.ack??await this.call<CloudPushResult>(link,'push',pending.operation);
    if(result.id!==pending.operation.id||result.epoch!==link.epoch||!['applied','conflict'].includes(result.status)||!Number.isSafeInteger(result.revision)||!Array.isArray(result.records)||typeof result.caughtUp!=='boolean')throw new AppError(502,'同步回执不完整，待同步操作仍保留','CLOUD_PROTOCOL');
    return this.locked(async()=>this.db.transaction(async()=>{
      const current=this.get(user);if(!current||current.deltaPending?.operation.id!==pending.operation.id)return false;this.check(user,current);
      if(result.status==='conflict'){current.deltaConflict={id:crypto.randomUUID(),direction:'push',values:result.conflicts,records:[],cursor:current.remoteRevision,remoteRevision:result.revision,localRevision:this.localRevision(user)};this.save(user,current);return false;}
      const expected=new Set(pending.sent.map(recordKey));if(result.records.length!==expected.size||new Set(result.records.map(recordKey)).size!==expected.size||result.records.some(row=>!expected.has(recordKey(row))))throw new AppError(502,'同步回执缺少关联记录，操作仍保留','CLOUD_PROTOCOL');
      const sent=recordMap(pending.sent),incoming=result.records.map(row=>({kind:row.kind,id:row.id,before:sent.get(recordKey(row))?.value as unknown as SyncChange['before']??null,after:row.value as unknown as SyncChange['after']}));
      const plan=await planIncremental(this.db.asD1(),user,incoming);
      current.deltaPending.ack=result;
      if(plan.conflicts.length){current.deltaConflict={id:crypto.randomUUID(),direction:'ack',values:plan.conflicts.map(row=>({...row,computer:row.phone,phone:row.computer})),records:result.records,cursor:current.remoteRevision,remoteRevision:result.revision,localRevision:this.localRevision(user)};this.save(user,current);return false;}
      const before=this.localRevision(user);if(plan.changes.length)await commitIncremental(this.db.asD1(),user,before,plan.changes);
      this.remember(user,result.records);if(current.localRevision===before)current.localRevision=this.localRevision(user);
      if(result.caughtUp)current.remoteRevision=result.revision;
      current.deltaMore=!result.caughtUp;current.deltaPending=undefined;current.error=undefined;current.errorCode=undefined;current.lastSync=new Date().toISOString();this.save(user,current);return true;
    }));
  }
  async resolve(user:string,choice:'local'|'remote'){
    const link=await this.locked(async()=>this.get(user));if(!link?.deltaConflict)throw new AppError(409,'冲突已改变，请重新检查');const conflict=link.deltaConflict;
    const keys=conflict.direction==='push'?link.deltaPending!.sent:conflict.records;
    const remote=await this.call<{epoch:string;revision:number;records:SyncRecord[]}>(link,'records',{keys:keys.map(({kind,id})=>({kind,id}))});
    if(remote.epoch!==link.epoch)throw new AppError(409,'网站题库已恢复，请重新核对','CLOUD_EPOCH_CHANGED');
    await this.locked(async()=>this.db.transaction(async()=>{
      const current=this.get(user);if(current?.deltaConflict?.id!==conflict.id||this.localRevision(user)!==conflict.localRevision)throw new AppError(409,'本地又有修改，请重新检查');this.check(user,current);
      let resolved:SyncChange[],baseline:SyncRecord[];
      if(conflict.direction==='push'){
        const wanted=resolveRecords(remote.records,current.deltaPending!.operation.changes,choice==='local'),wantedMap=recordMap(remote.records);
        for(const row of wanted)wantedMap.set(recordKey(row),{kind:row.kind,id:row.id,value:row.after as SyncRecord['value']});
        const sent=recordMap(current.deltaPending!.sent),operation=[...wantedMap.values()].map(row=>({kind:row.kind,id:row.id,before:sent.get(recordKey(row))?.value as unknown as SyncChange['before']??null,after:row.value as unknown as SyncChange['after']}));
        const plan=await planIncremental(this.db.asD1(),user,operation);if(plan.conflicts.length)throw new AppError(409,'本地内容又有变化，请重新检查');resolved=plan.changes;baseline=remote.records.map(row=>({...row,revision:remote.revision}));
      }else{
        if(remote.revision!==conflict.remoteRevision)throw new AppError(409,'网站又有修改，请重新检查');
        const before=conflict.direction==='ack'?recordMap(current.deltaPending!.sent):recordMap(this.base(user,conflict.records));
        const incoming=conflict.records.map(row=>({kind:row.kind,id:row.id,before:before.get(recordKey(row))?.value as unknown as SyncChange['before']??null,after:row.value as unknown as SyncChange['after']}));
        const local=await readRecords(this.db.asD1(),user,keys);resolved=resolveRecords(local,incoming,choice==='remote');baseline=conflict.records;
      }
      const plan=await planIncremental(this.db.asD1(),user,resolved);if(plan.conflicts.length)throw new AppError(409,'关联记录仍有冲突，请先调整后重新检查');
      const before=current.localRevision;if(plan.changes.length)await commitIncremental(this.db.asD1(),user,this.localRevision(user),plan.changes);
      this.remember(user,baseline);if(conflict.direction==='pull'){current.remoteRevision=conflict.cursor;current.deltaMore=conflict.cursor<conflict.remoteRevision;}
      if(conflict.direction==='ack'){current.deltaMore=!current.deltaPending?.ack?.caughtUp;if(current.deltaPending?.ack?.caughtUp)current.remoteRevision=conflict.remoteRevision;}
      current.deltaConflict=undefined;current.deltaPending=undefined;current.error=undefined;current.errorCode=undefined;
      await this.stage(user,current,keys,before);this.save(user,current);
    }));
  }
  async recheck(user:string){await this.locked(async()=>{const link=this.get(user);if(!link)return;if(link.deltaConflict?.direction==='push'&&link.deltaPending){link.deltaRetry=link.deltaPending.sent.map(({kind,id})=>({kind,id}));link.localRevision=Math.min(link.localRevision,link.deltaPending.localBefore);link.deltaPending=undefined;}link.deltaConflict=undefined;link.error=undefined;this.save(user,link);});}
}
