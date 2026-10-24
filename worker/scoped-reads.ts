import { AppError, emptyLibrary, graphElements, type Card, type Library } from '../shared/model';
import { readRecords } from './change-journal';
import { libraryRevision } from './record-mutations';
import { decodeStoredRecord } from './stored-records';
import { legacyPriorityTitle } from '../shared/card-priority';

export async function readProjectSnapshot(db:D1Database,user:string,id:string,includeArchived=false):Promise<Library>{
  const revision=await libraryRevision(db,user),project=(await readRecords(db,user,[{kind:'projects',id}]))[0].value;
  if(!project)throw new AppError(404,'项目不存在');
  const cards=(await db.prepare('SELECT payload FROM user_cards WHERE user_id=? AND project_id=?'+(includeArchived?'':" AND coalesce(json_extract(payload,'$.archived'),0)=0")+' ORDER BY id').bind(user,id).all<{payload:string}>()).results.map(row=>decodeStoredRecord('cards',row.payload)) as Card[],ids=JSON.stringify(cards.map(row=>row.id));
  const [occurrences,relations]=await db.batch([db.prepare('SELECT payload FROM user_occurrences WHERE user_id=? AND card_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(user,ids),db.prepare('SELECT payload FROM user_relations WHERE user_id=? AND from_card_id IN (SELECT value FROM json_each(?)) AND to_card_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(user,ids,ids)]);
  const library=emptyLibrary();library.revision=revision;library.projects=[project as Library['projects'][number]];library.cards=cards;
  library.occurrences=occurrences.results.map(row=>decodeStoredRecord('occurrences',String((row as {payload:string}).payload))) as Library['occurrences'];
  library.relations=relations.results.map(row=>decodeStoredRecord('relations',String((row as {payload:string}).payload))) as Library['relations'];
  const refs=await readRecords(db,user,[...cards.flatMap(card=>card.topic_ids.map(id=>({kind:'topics' as const,id}))),...library.occurrences.map(row=>({kind:'sources' as const,id:row.source_id}))]);
  for(const row of refs)if(row.value)(library[row.kind] as unknown[]).push(row.value);
  for(const kind of ['sources','topics'] as const)library[kind].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(await libraryRevision(db,user)!==revision)throw new AppError(409,'项目刚有更新，请重新下载','REVISION_CONFLICT');
  return library;
}

export async function readGraph(db:D1Database,user:string,project?:string){
  const revision=await libraryRevision(db,user),library=emptyLibrary();
  const rows=await db.prepare("SELECT id,project_id,json_extract(payload,'$.title') AS title,json_extract(payload,'$.mastery') AS mastery,json_extract(payload,'$.topic_ids') AS topics FROM user_cards WHERE user_id=? AND coalesce(json_extract(payload,'$.archived'),0)=0"+(project?' AND project_id=?':'')+' ORDER BY id').bind(user,...(project?[project]:[])).all<{id:string;project_id:string;title:string;mastery:Card['mastery'];topics:string|null}>();
  // Only labels/topology cross the database binding; the Worker does not load answer bodies.
  library.cards=rows.results.map(row=>({id:row.id,project_id:row.project_id,title:legacyPriorityTitle(row.title).title,mastery:row.mastery,archived:false,topic_ids:JSON.parse(row.topics??'[]')} as Card));
  const ids=JSON.stringify(library.cards.map(card=>card.id));
  const projects=[...new Set(library.cards.map(card=>card.project_id))],topics=[...new Set(library.cards.flatMap(card=>card.topic_ids))];
  const [p,t,r]=await db.batch([
    db.prepare("SELECT id,json_extract(payload,'$.name') AS name FROM user_projects WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id").bind(user,JSON.stringify(projects)),
    db.prepare("SELECT id,json_extract(payload,'$.name') AS name,json_extract(payload,'$.archived') AS archived FROM user_topics WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id").bind(user,JSON.stringify(topics)),
    db.prepare('SELECT payload FROM user_relations WHERE user_id=? AND from_card_id IN (SELECT value FROM json_each(?)) AND to_card_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(user,ids,ids),
  ]);
  library.projects=p.results as Library['projects'];library.topics=t.results as Library['topics'];library.relations=r.results.map(row=>decodeStoredRecord('relations',String((row as {payload:string}).payload))) as Library['relations'];
  if(await libraryRevision(db,user)!==revision)throw new AppError(409,'图谱刚有更新，请重试','REVISION_CONFLICT');
  return{elements:graphElements(library,project)};
}
