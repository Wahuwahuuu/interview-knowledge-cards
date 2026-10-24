import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import app from '../worker/index';
import { LocalDatabase } from '../desktop/database';
import { type Env } from '../worker/auth';
import { commitLibrary, readLibrary } from '../worker/store';
import { emptyLibrary, graphElements, importSchema, kinds, prepareImport, projectSnapshot, type Library } from '../shared/model';
import { applyLibraryDelta } from '../shared/apply-delta';
import { removeCard } from '../shared/card-actions';
import { applyMutationReply, deltaPath, mutateLibrary, refreshChangedRecords } from '../src/record-mutation-actions';
import { projectExport } from '../shared/project-actions';
import { createImportSubmitter } from '../src/import-actions';

const origin='http://127.0.0.1',migrations=resolve('migrations');
const ordered=(library:Library)=>({...library,...Object.fromEntries(kinds.map(kind=>[kind,[...library[kind]].sort((a,b)=>a.id.localeCompare(b.id))]))});
function fixture(){return prepareImport(emptyLibrary(),importSchema.parse({schema_version:1,
  projects:[{id:'p',name:'示例项目',sort_order:0},{id:'other',name:'其他项目',sort_order:1}],topics:[{id:'t',name:'示例大类'}],
  cards:['q','a','b','c','z'].map(id=>({id,project_id:id==='z'?'other':'p',title:id+' 题目',question:id+' 是什么？',summary_md:'简短口述',answer_md:'PRIVATE_ANSWER_'+id,topic_ids:['t']})),
  sources:[{id:'s',name:'示例来源',kind:'note',original_markdown:'PRIVATE_ORIGINAL'}],
  occurrences:[{id:'o',card_id:'q',source_id:'s',asked_question:'原始问法',original_answer_md:'原始回答'}],
  relations:[{id:'qa',from_card_id:'q',to_card_id:'a',kind:'followup',order:0},{id:'qb',from_card_id:'q',to_card_id:'b',kind:'followup',order:1},{id:'ac',from_card_id:'a',to_card_id:'c',kind:'followup',order:0}],
}));}

describe('按记录处理导入、来源和关系',()=>{
  let db:LocalDatabase,env:Env,sql:string[];
  const read=()=>readLibrary(db.asD1(),'admin');
  const request=(path:string,method='GET',body?:unknown,agent=false)=>app.fetch(new Request(origin+'/api/v1'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(agent?{'x-local-role':'agent'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const noFullReads=()=>expect(sql.filter(text=>/SELECT payload FROM user_(projects|topics|cards|sources|occurrences|relations) WHERE user_id=\? ORDER BY id/.test(text))).toEqual([]);
  beforeEach(async()=>{db=new LocalDatabase(':memory:',migrations);env={DB:db.asD1(),APP_ENV:'local',OWNER_EMAIL:'test@example.test',ASSETS:{fetch:async()=>new Response('test')} as unknown as Fetcher};await commitLibrary(db.asD1(),'admin',await read(),fixture());sql=[];const prepare=db.prepare.bind(db);db.prepare=text=>{sql.push(text);return prepare(text);};});
  afterEach(()=>db.close());

  it('来源备注、出现记录和问题关系的保存只返回变化行，保留原文与其余题目',async()=>{
    const base=await read();sql.length=0;
    const response=await request(deltaPath('/changes',base.revision),'POST',{expected_revision:base.revision,changes:{schema_version:1,sources:[{...base.sources[0],notes:'新的备注'}],occurrences:[{id:'new-o',card_id:'z',source_id:'s',asked_question:'另一次具体问法'}],relations:[{id:'az',from_card_id:'a',to_card_id:'z',kind:'related'}]}});
    expect(response.status).toBe(200);const result=await response.json() as any;expect(Object.keys(result)).toEqual(['delta']);expect(result.delta.records.map((row:any)=>row.kind).sort()).toEqual(['occurrences','relations','sources']);noFullReads();
    const next=applyLibraryDelta(base,result.delta);expect(next.cards).toBe(base.cards);expect(next.sources[0]).toMatchObject({notes:'新的备注',original_markdown:'PRIVATE_ORIGINAL'});
    expect(ordered(await read())).toEqual(ordered(next));
  });
  it('非法来源覆盖、追问环或重复父问题整批拒绝，失败时不产生计数或日志',async()=>{
    const base=await read(),counts=db.raw.prepare('SELECT * FROM library_entity_counts ORDER BY kind').all();
    for(const changes of [{sources:[{...base.sources[0],original_markdown:'覆盖原文'}]},{relations:[{id:'cq',from_card_id:'c',to_card_id:'q',kind:'followup'}]},{relations:[{id:'bc',from_card_id:'b',to_card_id:'c',kind:'followup'}]}]){
      expect((await request(deltaPath('/changes',base.revision),'POST',{expected_revision:base.revision,changes:{schema_version:1,...changes}})).status).toBe(422);
    }
    expect(await read()).toEqual(base);expect(db.raw.prepare('SELECT * FROM library_entity_counts ORDER BY kind').all()).toEqual(counts);
  });
  it('445 道题连同来源和追问按分组 SQL 原子导入，不随题数逐行增加数据库调用',async()=>{
    const base=await read(),cards=Array.from({length:445},(_,index)=>({id:'bulk-'+index,project_id:'p',title:'批量示例 '+index,question:'具体问题 '+index+'？',summary_md:'短口述',answer_md:'对应讲解'}));sql.length=0;
    const response=await request(deltaPath('/imports/submit',base.revision),'POST',{schema_version:1,batch_id:'bulk',cards,sources:[{id:'bulk-source',name:'批量来源',kind:'note',original_markdown:'保留原文'}],occurrences:cards.map(card=>({id:'occ-'+card.id,card_id:card.id,source_id:'bulk-source',asked_question:card.question})),relations:cards.map((card,index)=>({id:'rel-'+card.id,from_card_id:'q',to_card_id:card.id,kind:'followup',order:index+2}))});
    expect(response.status).toBe(200);const result=await response.json() as any;expect(result.batch.status).toBe('applied');expect(result.delta.records).toHaveLength(1336);noFullReads();expect(sql.length).toBeLessThan(45);
    const saved=await read();expect(saved.cards).toHaveLength(base.cards.length+445);expect(saved.revision).toBe(base.revision+1);
    for(const kind of ['projects','topics','cards','sources','occurrences','relations'])expect(db.raw.prepare('SELECT n FROM library_entity_counts WHERE user_id=? AND kind=?').get('admin',kind)!.n).toBe(db.raw.prepare(`SELECT count(*) n FROM user_${kind} WHERE user_id='admin'`).get()!.n);
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('重复导入和回执丢失重试按当前游标补变化，不重新入库或覆盖后续修改',async()=>{
    const base=await read(),input={schema_version:1,batch_id:'retry',cards:[{id:'new',project_id:'p',title:'新题',question:'具体问法？',answer_md:'答案'}]};
    expect((await request(deltaPath('/imports/submit',base.revision),'POST',input)).status).toBe(200);
    const current=await read();await request('/cards/z/state','PATCH',{expected_revision:current.revision,card_revision:current.cards.find(card=>card.id==='z')!.revision,patch:{favorite:true}});
    const latest=await read();sql.length=0;const retry=await request(deltaPath('/imports/submit',base.revision),'POST',input),result=await retry.json() as any;
    expect(result.already_applied).toBe(true);expect(ordered(applyLibraryDelta(base,result.delta))).toEqual(ordered(latest));noFullReads();expect(await read()).toEqual(latest);
    sql.length=0;const agent=await request('/agent/imports/submit','POST',input,true);expect(agent.status).toBe(200);noFullReads();
  });
  it('导入记录列表只取摘要，展开单条时才取正文和预览',async()=>{
    const base=await read();await request(deltaPath('/imports/submit',base.revision),'POST',{schema_version:1,batch_id:'list',cards:[{id:'new',project_id:'p',title:'列表中的题名',question:'具体问题？',answer_md:'PRIVATE_IMPORT_ANSWER'}]});sql.length=0;
    const response=await request('/imports'),rows=await response.json() as any[];expect(rows[0]).toMatchObject({question_count:1,label:'列表中的题名',preview:[],preview_loaded:false});expect(JSON.stringify(rows)).not.toContain('PRIVATE_IMPORT_ANSWER');expect(sql.some(text=>/SELECT \* FROM user_import_batches/.test(text))).toBe(false);
    const detail=await (await request('/imports/list')).json() as any;expect(detail.preview_loaded).toBe(true);expect(JSON.stringify(detail.preview)).toContain('PRIVATE_IMPORT_ANSWER');
  });
  it('删除关系仅发墓碑；删除主问题只读取关联分支并保留追问重挂规则',async()=>{
    let base=await read();sql.length=0;const response=await request(deltaPath('/relations/ac',base.revision),'DELETE',{expected_revision:base.revision}),result=await response.json() as any;expect(result.delta.records).toMatchObject([{kind:'relations',id:'ac',value:null}]);noFullReads();base=applyLibraryDelta(base,result.delta);
    const expected=removeCard(base,'q');sql.length=0;const deleted=await request(deltaPath('/cards/q',base.revision),'DELETE',{expected_revision:base.revision});expect(deleted.status).toBe(200);noFullReads();const next=applyLibraryDelta(base,(await deleted.json() as any).delta);
    const links=(library:Library)=>library.relations.map(({id,from_card_id,to_card_id,kind,order})=>({id,from_card_id,to_card_id,kind,order})).sort((a,b)=>a.id.localeCompare(b.id));expect(links(next)).toEqual(links(expected));expect(next.cards.map(row=>row.id)).toEqual(expected.cards.map(row=>row.id));expect(next.sources).toEqual(base.sources);expect(next.cards.find(row=>row.id==='z')).toBe(base.cards.find(row=>row.id==='z'));
  });
  it('项目删除只查询所属卡片与引用，包含归档题并保留共用来源与其他项目',async()=>{
    const base=await read();sql.length=0;const response=await request(deltaPath('/projects/p',base.revision),'DELETE',{expected_revision:base.revision});expect(response.status).toBe(200);noFullReads();const next=applyLibraryDelta(base,(await response.json() as any).delta);
    expect(next.cards.map(row=>row.id)).toEqual(['z']);expect(next.sources).toEqual(base.sources);expect(next.projects.map(row=>row.id)).toEqual(['other']);expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('图谱只传标签元数据，项目快照只查该项目，输出与原行为一致',async()=>{
    const base=await read();sql.length=0;const graph=await (await request('/graph?project_id=p')).json();expect(graph).toEqual({elements:graphElements(base,'p')});expect(sql.some(text=>/SELECT payload FROM user_cards/.test(text))).toBe(false);expect(sql.some(text=>/FROM user_sources/.test(text))).toBe(false);
    sql.length=0;const snapshot=await (await request('/projects/p/snapshot')).json() as any;expect(snapshot.snapshot).toEqual(projectSnapshot(base,'p'));noFullReads();
  });
  it('项目导出只读取该项目，包含归档卡片；离线快照继续排除归档',async()=>{
    let base=await read();await request('/cards/b','PATCH',{expected_revision:base.revision,card_revision:base.cards.find(row=>row.id==='b')!.revision,patch:{archived:true}});base=await read();sql.length=0;
    const bundle=await (await request('/projects/p/export')).json();expect(bundle).toEqual(projectExport(base,'p'));noFullReads();expect((bundle as any).cards.some((card:any)=>card.id==='b')).toBe(true);
    const snapshot=await (await request('/projects/p/snapshot')).json() as any;expect(snapshot.snapshot.cards.some((card:any)=>card.id==='b')).toBe(false);
  });
  it('老接口保留完整响应兼容，现代接口保存不依赖整库响应',async()=>{
    const base=await read(),response=await request('/changes','POST',{expected_revision:base.revision,changes:{schema_version:1,sources:[{...base.sources[0],notes:'兼容修改'}]}});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({schema_version:1,revision:base.revision+1});
  });
  it('单卡历史恢复只读取该卡及选中版本，保留标记并追加恢复历史',async()=>{
    const base=await read(),card=base.cards.find(row=>row.id==='q')!;
    const edited=await (await request('/cards/q','PATCH',{expected_revision:base.revision,card_revision:card.revision,patch:{summary_md:'新口述',favorite:true}})).json() as any;
    sql.length=0;const restored=await request(deltaPath('/cards/q/restore',edited.revision),'POST',{expected_revision:edited.revision,card_revision:1});expect(restored.status).toBe(200);noFullReads();
    const delta=(await restored.json() as any).delta;expect(delta.records).toHaveLength(1);expect(delta.records[0].value).toMatchObject({summary_md:card.summary_md,favorite:true,revision:3});
    expect(db.raw.prepare("SELECT action FROM user_card_revisions WHERE user_id='admin' AND card_id='q' AND revision=3").get()!.action).toBe('恢复版本 1');
  });
  it('完整恢复后计数自动保持一致，普通导入不扫描全表统计容量',async()=>{
    const base=await read();await commitLibrary(db.asD1(),'admin',base,base,{restore:true});
    for(const kind of kinds)expect(db.raw.prepare('SELECT n FROM library_entity_counts WHERE user_id=? AND kind=?').get('admin',kind)!.n).toBe(base[kind].length);
    const current=await read();sql.length=0;const response=await request(deltaPath('/imports/submit',current.revision),'POST',{schema_version:1,batch_id:'count',cards:[{id:'new',project_id:'p',title:'新题',question:'具体问题？'}]});expect(response.status).toBe(200);expect(sql.some(text=>/SELECT count\(\*\).*FROM user_(cards|projects|topics|sources|occurrences|relations)/.test(text))).toBe(false);noFullReads();
  });
});

describe('前端只应用增量',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('普通维护只请求变化响应，不重新载入题库',async()=>{
    const library=fixture(),row={...library.sources[0],notes:'新备注'},fetch=vi.fn(async()=>Response.json({delta:{epoch:'e',revision:library.revision+1,cursor:library.revision+1,hasMore:false,records:[{kind:'sources',id:row.id,value:row}]}}));vi.stubGlobal('fetch',fetch);
    const next=await mutateLibrary(library,'/changes',{method:'POST',body:'{}'});expect(fetch).toHaveBeenCalledTimes(1);expect(String((fetch.mock.calls[0] as any)[0])).toContain('response=delta&cursor=');expect(next.sources[0].notes).toBe('新备注');expect(next.cards).toBe(library.cards);
  });
  it('分批补齐中间提交，保留其他对象；空转页拒绝而不覆盖本机数据',async()=>{
    const library=fixture(),first={epoch:'e',revision:library.revision+2,cursor:library.revision+1,hasMore:true,records:[]},second={...first,cursor:library.revision+2,hasMore:false,records:[{kind:'cards',id:'z',value:{...library.cards.find(card=>card.id==='z')!,favorite:true}}]};
    const fetch=vi.fn(async()=>Response.json(second));vi.stubGlobal('fetch',fetch);const next=await applyMutationReply(library,{delta:first});expect(next.cards.find(card=>card.id==='z')!.favorite).toBe(true);expect(next.relations).toBe(library.relations);expect(fetch).toHaveBeenCalledTimes(1);
    await expect(applyMutationReply(library,{delta:{...first,cursor:library.revision}})).rejects.toMatchObject({code:'INVALID_DELTA'});expect(library.cards.find(card=>card.id==='z')!.favorite).toBe(false);
  });
  it('新导入携带当前游标，回应丢失后复用批次标识且不读整库',async()=>{
    const library=fixture(),fetch=vi.fn(async()=>Response.json({batch:{id:'b',status:'applied'},already_applied:false,delta:{epoch:'e',revision:library.revision,cursor:library.revision,hasMore:false,records:[]}}));vi.stubGlobal('fetch',fetch);
    const submit=createImportSubmitter(),envelope=importSchema.parse({schema_version:1});await submit(envelope,library);await submit(envelope,library);expect(fetch).toHaveBeenCalledTimes(2);const calls=fetch.mock.calls as any[];expect(calls[0][0]).toContain('response=delta&cursor=');expect(JSON.parse(calls[0][1].body).batch_id).toBe(JSON.parse(calls[1][1].body).batch_id);
  });
  it('临时错误不回退整库读取，只有恢复导致旧游标失效才重新初始化',async()=>{
    const library=fixture(),fetch=vi.fn(async()=>Response.json({error:{code:'SERVER_ERROR',message:'暂时不可用'}},{status:503}));vi.stubGlobal('fetch',fetch);
    await expect(refreshChangedRecords(library)).rejects.toMatchObject({status:503});expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset();fetch.mockResolvedValueOnce(Response.json({error:{code:'SYNC_INITIALIZATION_REQUIRED',message:'重新初始化'}},{status:409})).mockResolvedValueOnce(Response.json(library));
    expect(await refreshChangedRecords(library)).toEqual(library);expect(String((fetch.mock.calls[1] as any)[0])).toBe('/api/v1/library');
  });
});
