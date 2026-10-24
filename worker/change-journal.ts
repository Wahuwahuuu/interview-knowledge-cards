import { AppError, kinds, type Kind } from '../shared/model';
import { recordKey, type RecordKey, type SyncRecord } from '../shared/record-sync';
import type { CloudDelta } from '../shared/cloud-sync';
import { decodeStoredRecord } from './stored-records';

export async function journalHead(db:D1Database,user:string) {
  const value=await db.prepare('SELECT s.epoch,m.revision,f.revision AS floor FROM user_library_meta m JOIN cloud_sync_state s ON s.user_id=m.user_id JOIN library_change_floor f ON f.user_id=m.user_id WHERE m.user_id=?').bind(user).first<{epoch:string;revision:number;floor:number}>();
  if(!value)throw new AppError(503,'增量同步尚未就绪，请检查数据库迁移');
  return value;
}
export async function readRecords(db:D1Database,user:string,keys:RecordKey[]):Promise<SyncRecord[]> {
  const unique=[...new Map(keys.map(row=>[recordKey(row),row])).values()],queries:D1PreparedStatement[]=[],groups:Kind[]=[];
  for(const kind of kinds){const ids=unique.filter(row=>row.kind===kind).map(row=>row.id);if(ids.length){queries.push(db.prepare(`SELECT payload FROM user_${kind} WHERE user_id=? AND id IN (SELECT value FROM json_each(?))`).bind(user,JSON.stringify(ids)));groups.push(kind);}}
  const values=new Map<string,SyncRecord>();
  if(queries.length){const result=await db.batch(queries);result.forEach((rows,index)=>rows.results.forEach(row=>{const value=decodeStoredRecord(groups[index],String((row as {payload:string}).payload));const record={kind:groups[index],id:value.id,value};values.set(recordKey(record),record);}));}
  return unique.map(key=>values.get(recordKey(key))??{...key,value:null});
}

/** Pages end on a committed mutation boundary, including its deletes and relation rewrites. */
export async function readJournal(db:D1Database,user:string,cursor:number,epoch?:string,limit=200):Promise<CloudDelta> {
  const head=await journalHead(db,user);
  if(epoch&&epoch!==head.epoch)throw new AppError(409,'题库已恢复备份，需要重新核对','CLOUD_EPOCH_CHANGED');
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>head.revision)throw new AppError(409,'同步位置不正确，请重新核对题库','INVALID_SYNC_CURSOR');
  if(cursor<head.floor)throw new AppError(409,'需要首次初始化增量同步；现有修改仍保留','SYNC_INITIALIZATION_REQUIRED');
  if(cursor===head.revision)return{epoch:head.epoch,revision:head.revision,cursor,hasMore:false,records:[]};
  type Row={seq:number;revision:number;kind:Kind;id:string;payload:string|null};
  const groups=(await db.prepare('SELECT revision,count(*) AS n,sum(coalesce(length(CAST(payload AS BLOB)),0)) AS bytes FROM library_changes WHERE user_id=? AND revision>? AND revision<=? GROUP BY revision ORDER BY revision LIMIT ?').bind(user,cursor,head.revision,limit+1).all<{revision:number;n:number;bytes:number}>()).results;
  let next=head.revision,count=0,bytes=0,selected=0;
  for(const group of groups){if(selected&&(count+group.n>limit||bytes+group.bytes>2*1024*1024)){next=groups[selected-1].revision;break;}count+=group.n;bytes+=group.bytes;selected++;}
  if(selected===groups.length&&groups.length>limit)next=groups.at(-1)!.revision;
  const rows=(await db.prepare('SELECT seq,revision,kind,id,payload FROM library_changes WHERE user_id=? AND revision>? AND revision<=? ORDER BY revision,seq').bind(user,cursor,next).all<Row>()).results;
  const after=await journalHead(db,user);if(after.epoch!==head.epoch)throw new AppError(409,'题库刚恢复备份，请重新核对','CLOUD_EPOCH_CHANGED');
  const values=new Map<string,SyncRecord>();for(const row of rows)values.set(recordKey(row),{kind:row.kind,id:row.id,revision:row.revision,value:row.payload===null?null:decodeStoredRecord(row.kind,row.payload)});
  return{epoch:head.epoch,revision:head.revision,cursor:next,hasMore:next<head.revision,records:[...values.values()]};
}
