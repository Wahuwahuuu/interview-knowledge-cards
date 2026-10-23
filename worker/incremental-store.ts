import { AppError, canonical, kinds, type Card, type Entity, type Kind, type Occurrence, type Project, type Relation, type Source, type Topic } from '../shared/model';
import { knowledgeCategories } from '../shared/topic-categories';
import { mergeRecords, recordKey, recordMap, type RecordKey, type SyncRecord } from '../shared/record-sync';
import type { SyncChange, SyncConflict } from '../shared/sync';
import { readRecords } from './change-journal';
import { upsert } from './store';

export async function planIncremental(db:D1Database,user:string,changes:SyncChange[]) {
  const current=await readRecords(db,user,changes),merged=mergeRecords(current,changes);
  if(merged.conflicts.length)return{current,changes:[],conflicts:merged.conflicts};
  try{await validateChanges(db,user,merged.changes);}catch(error){if(!(error instanceof AppError))throw error;return{current,changes:[],conflicts:[{kind:'library',id:'references',field:'references',before:null,computer:error.message,phone:changes}] as SyncConflict[]};}
  return{current,changes:merged.changes,conflicts:[] as SyncConflict[]};
}

async function validateChanges(db:D1Database,user:string,changes:SyncChange[]) {
  const target=new Map(changes.map(row=>[recordKey(row),row.after as Entity|null])),refs:RecordKey[]=[];
  for(const row of changes){const value=row.after;if(!value)continue;
    if(row.kind==='cards'){refs.push({kind:'projects',id:String(value.project_id)},...(value.topic_ids as string[]).map(id=>({kind:'topics' as const,id})));if(new Set(value.topic_ids as string[]).size!==(value.topic_ids as string[]).length)throw new AppError(422,'知识点重复');}
    if(row.kind==='occurrences')refs.push({kind:'cards',id:String(value.card_id)},{kind:'sources',id:String(value.source_id)});
    if(row.kind==='relations')refs.push({kind:'cards',id:String(value.from_card_id)},{kind:'cards',id:String(value.to_card_id)});
  }
  const stored=recordMap(await readRecords(db,user,refs));
  const get=(kind:Kind,id:string)=>target.has(`${kind}:${id}`)?target.get(`${kind}:${id}`):stored.get(`${kind}:${id}`)?.value;
  for(const ref of refs)if(!get(ref.kind,ref.id))throw new AppError(422,'关联的项目、知识大类、问题或来源不存在');
  const incomingRelations=changes.filter(row=>row.kind==='relations'),overlay=incomingRelations.map(row=>({id:row.id,...(row.after?{from:row.after.from_card_id,to:row.after.to_card_id,kind:row.after.kind}:{})}));
  for(const row of changes){const before=row.before,after=row.after;
    if(!after){if(row.kind==='sources'||row.kind==='occurrences'&&!changes.some(v=>v.kind==='cards'&&v.id===before?.card_id&&!v.after))throw new AppError(422,'同步不能删除原始来源记录');continue;}
    if(row.kind==='sources'&&before&&before.original_markdown!==after.original_markdown)throw new AppError(422,'已有来源的原始记录不能被覆盖');
    if(row.kind==='occurrences'&&before&&['asked_question','original_answer_md','card_id','source_id'].some(key=>before[key]!==after[key]))throw new AppError(422,'已有出现记录的原始问答及归属不能被覆盖');
    if(row.kind==='cards'&&(!before||canonical(before.topic_ids)!==canonical(after.topic_ids))){const topics=(after.topic_ids as string[]).map(id=>get('topics',id) as Topic);if(knowledgeCategories(topics).length>1)throw new AppError(422,'每张卡片只能选择一个知识大类');}
    if(row.kind==='projects'&&before?.name!==after.name){const matches=await db.prepare("SELECT id FROM user_projects WHERE user_id=? AND trim(json_extract(payload,'$.name'))=?").bind(user,String(after.name).trim()).all<{id:string}>();if(matches.results.some(item=>item.id!==row.id&&!changes.some(v=>v.kind==='projects'&&v.id===item.id&&v.after?.name!==after.name))||changes.some(item=>item!==row&&item.kind==='projects'&&item.after?.name===after.name))throw new AppError(422,'项目名称已存在');}
    if(row.kind==='topics'&&knowledgeCategories([after as unknown as Topic]).length&&!(before&&before.name===after.name&&!before.archived)){const matches=await db.prepare("SELECT id,payload FROM user_topics WHERE user_id=? AND json_extract(payload,'$.name')=?").bind(user,String(after.name)).all<{id:string;payload:string}>();if(matches.results.some(item=>item.id!==row.id&&!target.has(`topics:${item.id}`)&&knowledgeCategories([JSON.parse(item.payload)]).length)||changes.some(item=>item!==row&&item.kind==='topics'&&item.after?.name===after.name&&knowledgeCategories([item.after as unknown as Topic]).length))throw new AppError(422,'知识大类名称已存在');}
    if(row.kind==='relations'&&after.from_card_id===after.to_card_id)throw new AppError(422,'问题不能关联自身');
  }
  const relations=incomingRelations.flatMap(row=>row.after?[row.after as unknown as Relation]:[]);
  if(relations.length){
    const endpoints=[...new Set(relations.flatMap(row=>row.kind==='related'?[row.from_card_id,row.to_card_id]:[row.from_card_id]))],existing:Relation[]=[];
    for(let i=0;i<endpoints.length;i+=75){const part=endpoints.slice(i,i+75);const rows=await db.prepare(`SELECT payload FROM user_relations WHERE user_id=? AND from_card_id IN (${part.map(()=>'?').join(',')})`).bind(user,...part).all<{payload:string}>();existing.push(...rows.results.filter(row=>!target.has(`relations:${JSON.parse(row.payload).id}`)).map(row=>JSON.parse(row.payload)));}
    const key=(row:Relation)=>`${row.kind}:${(row.kind==='related'?[row.from_card_id,row.to_card_id].sort():[row.from_card_id,row.to_card_id]).join(':')}`;
    for(const relation of relations)if([...existing,...relations.filter(row=>row.id!==relation.id)].some(row=>key(row)===key(relation)))throw new AppError(422,'同一问题关系重复');
    const newFollowups=incomingRelations.filter(row=>row.after?.kind==='followup'&&(!row.before||row.before.kind!=='followup'||row.before.from_card_id!==row.after.from_card_id||row.before.to_card_id!==row.after.to_card_id));
    if(newFollowups.length){
      const children=[...new Set(newFollowups.map(row=>String(row.after!.to_card_id)))];
      for(let i=0;i<children.length;i+=75){const part=children.slice(i,i+75);const rows=await db.prepare(`SELECT id,to_card_id FROM user_relations WHERE user_id=? AND to_card_id IN (${part.map(()=>'?').join(',')}) AND json_extract(payload,'$.kind')='followup'`).bind(user,...part).all<{id:string;to_card_id:string}>();if(rows.results.some(row=>!target.has(`relations:${row.id}`)))throw new AppError(422,'追问已有直接主问题');}
      if(new Set(relations.filter(row=>row.kind==='followup').map(row=>row.to_card_id)).size!==relations.filter(row=>row.kind==='followup').length)throw new AppError(422,'同一追问不能有多个主问题');
      const cycle=await db.prepare(`WITH RECURSIVE delta AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.from') src,json_extract(value,'$.to') dst,json_extract(value,'$.kind') kind FROM json_each(?)),walk(root,id) AS (
        SELECT src,dst FROM delta WHERE kind='followup'
        UNION SELECT w.root,r.to_card_id FROM walk w JOIN user_relations r ON r.user_id=? AND r.from_card_id=w.id WHERE json_extract(r.payload,'$.kind')='followup' AND r.id NOT IN (SELECT id FROM delta)
        UNION SELECT w.root,d.dst FROM walk w JOIN delta d ON d.src=w.id WHERE d.kind='followup'
      ) SELECT 1 AS found FROM walk WHERE root=id LIMIT 1`).bind(JSON.stringify(overlay),user).first();
      if(cycle)throw new AppError(422,'追问关系会形成循环');
    }
  }
  const maxima:Record<Kind,number>={projects:1000,topics:2000,sources:2000,cards:2000,occurrences:5000,relations:5000};
  for(const kind of kinds){const added=changes.filter(row=>row.kind===kind&&!row.before&&row.after).length;if(added){const count=await db.prepare(`SELECT count(*) AS n FROM user_${kind} WHERE user_id=?`).bind(user).first<{n:number}>();const removed=changes.filter(row=>row.kind===kind&&row.before&&!row.after).length;if((count?.n??0)+added-removed>maxima[kind])throw new AppError(422,'题库记录数量超过限制');}}
}

/** Indexed record writes + CAS + receipt are one transaction. No library-wide payload read. */
export async function commitIncremental(db:D1Database,user:string,revision:number,changes:SyncChange[],extra:D1PreparedStatement[]=[]) {
  const guard=crypto.randomUUID(),statements:D1PreparedStatement[]=[db.prepare('INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT revision FROM user_library_meta WHERE user_id=?)=? THEN 1 ELSE 0 END)').bind(user,guard,user,revision)];
  for(const row of changes.filter(row=>row.kind==='relations'&&row.before))statements.push(db.prepare('DELETE FROM user_relations WHERE user_id=? AND id=?').bind(user,row.id));
  for(const kind of ['occurrences','cards'] as const)for(const row of changes.filter(row=>row.kind===kind&&!row.after)){
    if(kind==='cards')statements.push(db.prepare('DELETE FROM user_card_topics WHERE user_id=? AND card_id=?').bind(user,row.id),db.prepare('DELETE FROM user_card_revisions WHERE user_id=? AND card_id=?').bind(user,row.id));
    statements.push(db.prepare(`DELETE FROM user_${kind} WHERE user_id=? AND id=?`).bind(user,row.id));
  }
  for(const kind of kinds)for(const row of changes.filter(row=>row.kind===kind&&row.after)){
    const value=row.after as unknown as Entity;
    statements.push(upsert(db,user,kind,value));
    if(kind==='cards'){
      const card=value as Card;
      if(!row.before||canonical(row.before.topic_ids)!==canonical(card.topic_ids)){statements.push(db.prepare('DELETE FROM user_card_topics WHERE user_id=? AND card_id=?').bind(user,row.id));for(const topic of card.topic_ids)statements.push(db.prepare('INSERT INTO user_card_topics(user_id,card_id,topic_id) VALUES (?,?,?)').bind(user,row.id,topic));}
      if(!row.before||row.before.revision!==card.revision){const entry={card_id:card.id,revision:card.revision,saved_at:card.updated_at,action:row.before?'同步编辑':'同步新增',snapshot:card};statements.push(db.prepare('INSERT INTO user_card_revisions(user_id,card_id,revision,saved_at,action,payload) VALUES (?,?,?,?,?,?)').bind(user,card.id,card.revision,card.updated_at,entry.action,JSON.stringify(entry)));}
    }
  }
  // Move surviving child references before removing their previous parent/category.
  for(const kind of ['sources','topics','projects'] as const)for(const row of changes.filter(row=>row.kind===kind&&!row.after))statements.push(db.prepare(`DELETE FROM user_${kind} WHERE user_id=? AND id=?`).bind(user,row.id));
  if(changes.length)statements.push(db.prepare('UPDATE user_library_meta SET revision=revision+1 WHERE user_id=?').bind(user));
  statements.push(...extra,db.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(user,guard));
  try{await db.batch(statements);}catch(error){if(/mutation_guard|ok=1/.test(String(error)))throw new AppError(409,'题库刚有更新，将重新合并','REVISION_CONFLICT');if(String(error).includes('FOREIGN KEY'))throw new AppError(409,'关联记录尚未处理，请重新核对修改','REFERENCE_CONFLICT');throw error;}
  return revision+(changes.length?1:0);
}
