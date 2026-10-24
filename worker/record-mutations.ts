import { AppError, diffLibraries, emptyLibrary, kinds, sameContent, type Card, type Change, type Entity, type ImportEnvelope, type Kind, type Library, type Project } from '../shared/model';
import { mergeRecords, recordKey, type SyncRecord } from '../shared/record-sync';
import { changesBetween, type SyncChange } from '../shared/sync';
import { removeCard } from '../shared/card-actions';
import { readRecords, readJournal } from './change-journal';
import { commitIncremental, validateChanges } from './incremental-store';
import { readLibrary } from './store';
import { decodeStoredRecord } from './stored-records';

export async function libraryRevision(db:D1Database,user:string){return (await db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(user).first<{revision:number}>())?.revision??0;}
export function checkRevision(actual:number,expected:unknown){if(actual!==expected)throw new AppError(409,'题库已更新，请重新核对后保存','REVISION_CONFLICT');}

/** Build an ordinary merge using only submitted IDs. Global constraints use indexes/counters. */
export async function planRecordMerge(db:D1Database,user:string,envelope:ImportEnvelope,options:{expectedRevision?:unknown;strictTargets?:boolean}={}){
  if(envelope.mode!=='merge')throw new AppError(403,'完整恢复请在备份页面预览并确认','FORBIDDEN');
  if(envelope.revisions.length)throw new AppError(422,'普通导入不能修改历史版本');
  for(const kind of kinds)if(new Set(envelope[kind].map(row=>row.id)).size!==envelope[kind].length)throw new AppError(422,`${kind} 中存在重复 ID`);
  const revision=await libraryRevision(db,user);if('expectedRevision' in options)checkRevision(revision,options.expectedRevision);
  const current=await readRecords(db,user,kinds.flatMap(kind=>envelope[kind].map(row=>({kind,id:row.id}))));
  const saved=new Map(current.map(row=>[recordKey(row),row.value]));
  if(options.strictTargets)for(const kind of kinds)for(const value of envelope[kind]){const previous=saved.get(`${kind}:${value.id}`);if(previous&&!sameContent(previous,value)&&(value.revision!==previous.revision||!value.updated_at||value.updated_at!==previous.updated_at))throw new AppError(409,'要更新的内容已有变化，或缺少当前版本信息。请读取最新资料后重新提交。','IMPORT_TARGET_CONFLICT');}
  let maxOrder:number|null=null;
  if(envelope.projects.some(row=>row.sort_order===undefined))maxOrder=(await db.prepare("SELECT max(json_extract(payload,'$.sort_order')) AS n FROM user_projects WHERE user_id=?").bind(user).first<{n:number|null}>())?.n??null;
  const requested:SyncChange[]=[];
  for(const kind of kinds)for(const input of envelope[kind]){
    const before=saved.get(`${kind}:${input.id}`)??null;let after:Entity=input;
    if(kind==='projects'){const project=input as Project,old=before as Project|null;if(project.sort_order===undefined){if(old?.sort_order!==undefined)after={...project,sort_order:old.sort_order};else if(!old&&maxOrder!==null)after={...project,sort_order:++maxOrder};}else maxOrder=Math.max(maxOrder??-1,project.sort_order);}
    requested.push({kind,id:input.id,before,after});
  }
  const merged=mergeRecords(current,requested);
  if(merged.conflicts.length)throw new AppError(409,'涉及的记录刚有修改，请重新核对','REVISION_CONFLICT');
  // Ordinary imports retain their original answer-version behavior, including flag edits.
  for(const row of merged.changes)if(row.kind==='cards'&&row.after)row.after.revision=(row.before?.revision as number??0)+1;
  await validateChanges(db,user,merged.changes);
  return {revision,changes:merged.changes,preview:await recordPreview(db,user,current,merged.changes)};
}

async function recordPreview(db:D1Database,user:string,current:SyncRecord[],changes:SyncChange[]):Promise<Change[]>{
  const before=emptyLibrary(),after=emptyLibrary();
  for(const row of current)if(row.value)(before[row.kind] as Entity[]).push(row.value);
  for(const kind of kinds)(after[kind] as Entity[])=[...(before[kind] as Entity[])];
  for(const change of changes){const list=after[change.kind] as Entity[],index=list.findIndex(row=>row.id===change.id);if(change.after){if(index<0)list.push(change.after as Entity);else list[index]=change.after as Entity;}else if(index>=0)list.splice(index,1);}
  const cardIds=new Set<string>(),sourceIds=new Set<string>();
  for(const row of changes){const value=row.after??row.before;if(!value)continue;if(row.kind==='relations'){cardIds.add(String(value.from_card_id));cardIds.add(String(value.to_card_id));}if(row.kind==='occurrences'){cardIds.add(String(value.card_id));sourceIds.add(String(value.source_id));}}
  for(const [kind,ids,field] of [['cards',cardIds,'title'],['sources',sourceIds,'name']] as const){if(!ids.size)continue;const labels=await db.prepare(`SELECT id,json_extract(payload,'$.${field}') AS label FROM user_${kind} WHERE user_id=? AND id IN (SELECT value FROM json_each(?))`).bind(user,JSON.stringify([...ids])).all<{id:string;label:string}>();for(const row of labels.results)for(const library of [before,after])if(!(library[kind] as Entity[]).some(value=>value.id===row.id))(library[kind] as Entity[]).push({id:row.id,[field]:row.label} as unknown as Entity);}
  return diffLibraries(before,after);
}

/** Modern pages request journal rows; older clients can still request their full response. */
export async function mutationResponse(db:D1Database,user:string,request:Request,extra?:Record<string,unknown>){
  const url=new URL(request.url);
  if(url.searchParams.get('response')==='delta')return {...extra,delta:await readJournal(db,user,Number(url.searchParams.get('cursor')),url.searchParams.get('epoch')??undefined)};
  const library=await readLibrary(db,user);return extra?{...extra,library}:library;
}

export async function deleteRecord(db:D1Database,user:string,kind:Kind,id:string,expected:unknown){
  const revision=await libraryRevision(db,user);checkRevision(revision,expected);
  const value=(await readRecords(db,user,[{kind,id}]))[0].value;if(!value)throw new AppError(404,'记录不存在');
  if(kind==='sources'||kind==='occurrences')throw new AppError(422,'原始问答与来源记录保留供追溯');
  let changes:SyncChange[];
  if(kind==='cards'){
    // Reparenting needs the connected follow-up branch, but not its question/answer bodies.
    const component=await db.prepare(`WITH RECURSIVE branch(id) AS (SELECT ? UNION SELECT r.to_card_id FROM user_relations r JOIN branch b ON r.from_card_id=b.id WHERE r.user_id=? AND json_extract(r.payload,'$.kind')='followup' UNION SELECT r.from_card_id FROM user_relations r JOIN branch b ON r.to_card_id=b.id WHERE r.user_id=? AND json_extract(r.payload,'$.kind')='followup') SELECT c.id,c.project_id,coalesce(json_extract(c.payload,'$.archived'),0) AS archived FROM user_cards c WHERE c.user_id=? AND c.id IN (SELECT id FROM branch)`).bind(id,user,user,user).all<{id:string;project_id:string;archived:number}>();
    const ids=component.results.map(row=>row.id),scope=emptyLibrary();
    scope.cards=component.results.map(row=>row.id===id?value as Card:{id:row.id,project_id:row.project_id,archived:!!row.archived} as Card);
    const links=await db.prepare("SELECT payload FROM user_relations WHERE user_id=? AND ((from_card_id IN (SELECT value FROM json_each(?)) AND json_extract(payload,'$.kind')='followup') OR from_card_id=? OR to_card_id=?)").bind(user,JSON.stringify(ids),id,id).all<{payload:string}>();
    scope.relations=links.results.map(row=>decodeStoredRecord('relations',row.payload)) as Library['relations'];
    scope.occurrences=(await db.prepare('SELECT payload FROM user_occurrences WHERE user_id=? AND card_id=?').bind(user,id).all<{payload:string}>()).results.map(row=>decodeStoredRecord('occurrences',row.payload)) as Library['occurrences'];
    changes=changesBetween(scope,removeCard(scope,id));
  }else if(kind==='projects'){
    const cards=(await db.prepare('SELECT payload FROM user_cards WHERE user_id=? AND project_id=?').bind(user,id).all<{payload:string}>()).results.map(row=>decodeStoredRecord('cards',row.payload)),ids=JSON.stringify(cards.map(row=>row.id));
    const [occurrences,relations]=await db.batch([db.prepare('SELECT payload FROM user_occurrences WHERE user_id=? AND card_id IN (SELECT value FROM json_each(?))').bind(user,ids),db.prepare('SELECT payload FROM user_relations WHERE user_id=? AND (from_card_id IN (SELECT value FROM json_each(?)) OR to_card_id IN (SELECT value FROM json_each(?)))').bind(user,ids,ids)]);
    changes=[{kind,id,before:value,after:null},...cards.map(card=>({kind:'cards' as const,id:card.id,before:card,after:null})),...occurrences.results.map(row=>{const value=decodeStoredRecord('occurrences',String((row as {payload:string}).payload));return{kind:'occurrences' as const,id:value.id,before:value,after:null};}),...relations.results.map(row=>{const value=decodeStoredRecord('relations',String((row as {payload:string}).payload));return{kind:'relations' as const,id:value.id,before:value,after:null};})];
  }else{
    if(kind==='topics'&&await db.prepare('SELECT 1 AS found FROM user_card_topics WHERE user_id=? AND topic_id=? LIMIT 1').bind(user,id).first())throw new AppError(422,'该知识大类仍被卡片使用，请先修改分类');
    changes=[{kind,id,before:value,after:null}];
  }
  await validateChanges(db,user,changes);await commitIncremental(db,user,revision,changes);
}
