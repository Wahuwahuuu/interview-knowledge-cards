import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import app from '../worker/index';
import { LocalDatabase } from '../desktop/database';
import { startDesktopServer } from '../desktop/server';
import { tokenHash,type Env } from '../worker/auth';
import { commitLibrary,readLibrary,updateCardState } from '../worker/store';
import { journalHead,readJournal } from '../worker/change-journal';
import { planIncremental,commitIncremental } from '../worker/incremental-store';
import { emptyLibrary,importSchema,prepareImport,type Library } from '../shared/model';
import { changesBetween } from '../shared/sync';
import { applyLibraryDelta } from '../shared/apply-delta';

const migrations=resolve('migrations'),site='https://delta.example.test';
const sample=()=>prepareImport(emptyLibrary(),importSchema.parse({schema_version:1,projects:[{id:'p',name:'示例题库'}],cards:[{id:'q',project_id:'p',title:'事务',question:'事务是什么？',summary_md:'初始口述',answer_md:'初始讲解'}]}));
const codec={encrypt:async(value:string)=>'test:'+value,decrypt:async(value:string)=>value.slice(5)};
function trace(db:LocalDatabase){const sql:string[]=[],prepare=db.prepare.bind(db);db.prepare=(value:string)=>{sql.push(value);return prepare(value);};return sql;}
const fullReads=(sql:string[])=>sql.filter(value=>/SELECT payload FROM user_(projects|topics|sources|cards|occurrences|relations) WHERE user_id=\? ORDER BY id/.test(value));

describe('增量日志的事务边界',()=>{
  let db:LocalDatabase;
  beforeEach(async()=>{db=new LocalDatabase(':memory:',migrations);await commitLibrary(db.asD1(),'admin',await readLibrary(db.asD1(),'admin'),sample());});afterEach(()=>db.close());
  it('空闲只读游标；复习标记、答案与删除由同事务触发器记录',async()=>{
    const before=await journalHead(db.asD1(),'admin'),sql=trace(db);
    expect((await readJournal(db.asD1(),'admin',before.revision,before.epoch)).records).toEqual([]);expect(fullReads(sql)).toEqual([]);
    const card=sample().cards[0];await updateCardState(db.asD1(),'admin','q',{expected_revision:before.revision,card_revision:card.revision,patch:{mastery:'mastered'}});
    const page=await readJournal(db.asD1(),'admin',before.revision,before.epoch);expect(page.records).toHaveLength(1);expect(page.records[0]).toMatchObject({kind:'cards',id:'q',value:{mastery:'mastered'}});
    const base=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',base,{...base,cards:[],revisions:[]});expect((await readJournal(db.asD1(),'admin',page.cursor,page.epoch)).records).toMatchObject([{kind:'cards',id:'q',value:null}]);
  });
  it('失败事务不会留下日志或推进游标',async()=>{
    const head=await journalHead(db.asD1(),'admin');await expect(db.batch([db.prepare("UPDATE user_cards SET payload=json_set(payload,'$.favorite',1) WHERE user_id='admin' AND id='q'"),db.prepare("INSERT INTO user_mutation_guard VALUES ('admin','fail',0)")])).rejects.toThrow();
    expect(await journalHead(db.asD1(),'admin')).toEqual(head);expect((await readJournal(db.asD1(),'admin',head.revision)).records).toEqual([]);expect((await readLibrary(db.asD1(),'admin')).cards[0].favorite).toBe(false);
  });
  it('分页不拆同一提交；多次修改按最后版本折叠，保留删除墓碑',async()=>{
    const start=await journalHead(db.asD1(),'admin'),base=await readLibrary(db.asD1(),'admin');
    const cards=Array.from({length:205},(_,index)=>({id:'many-'+index,project_id:'p',title:'示例 '+index,question:'示例问题 '+index+'？'}));await commitLibrary(db.asD1(),'admin',base,prepareImport(base,importSchema.parse({schema_version:1,cards})));
    let latest=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',latest,prepareImport(latest,importSchema.parse({schema_version:1,cards:[{...latest.cards[0],answer_md:'后续讲解'}]})));
    const first=await readJournal(db.asD1(),'admin',start.revision);expect(first.records).toHaveLength(205);expect(first.hasMore).toBe(true);
    const second=await readJournal(db.asD1(),'admin',first.cursor,first.epoch);expect(second.records).toHaveLength(1);expect(second.hasMore).toBe(false);
    latest=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',latest,{...latest,cards:latest.cards.filter(row=>row.id!=='q'),revisions:latest.revisions.filter(row=>row.card_id!=='q')});
    const deleted=await readJournal(db.asD1(),'admin',second.cursor);expect(deleted.records).toMatchObject([{kind:'cards',id:'q',value:null}]);
  });
  it('恢复切换代次；旧游标不能读取半份恢复数据',async()=>{
    const head=await journalHead(db.asD1(),'admin'),base=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',base,base,{restore:true});
    await expect(readJournal(db.asD1(),'admin',head.revision,head.epoch)).rejects.toMatchObject({code:'CLOUD_EPOCH_CHANGED'});await expect(readJournal(db.asD1(),'admin',head.revision)).rejects.toMatchObject({code:'SYNC_INITIALIZATION_REQUIRED'});
  });
  it('索引校验阻止跨账号引用、重复项目和深层追问环，原始来源不可覆盖',async()=>{
    const base=await readLibrary(db.asD1(),'admin'),target=prepareImport(base,importSchema.parse({schema_version:1,cards:[{id:'b',project_id:'p',title:'追问 B',question:'B？'},{id:'c',project_id:'p',title:'追问 C',question:'C？'}],relations:[{id:'ab',from_card_id:'q',to_card_id:'b',kind:'followup'},{id:'bc',from_card_id:'b',to_card_id:'c',kind:'followup'}],sources:[{id:'s',name:'示例原文',kind:'note',original_markdown:'保留原文'}]}));await commitLibrary(db.asD1(),'admin',base,target);
    const change=(kind:any,id:string,after:any,before:any=null)=>[{kind,id,before,after}];
    expect((await planIncremental(db.asD1(),'admin',change('relations','ca',{id:'ca',from_card_id:'c',to_card_id:'q',kind:'followup'}))).conflicts).toHaveLength(1);
    expect((await planIncremental(db.asD1(),'admin',change('cards','bad',{...base.cards[0],id:'bad',project_id:'another-account-project'}))).conflicts).toHaveLength(1);
    expect((await planIncremental(db.asD1(),'admin',change('projects','duplicate',{id:'duplicate',name:'示例题库'}))).conflicts).toHaveLength(1);
    const source=target.sources[0];expect((await planIncremental(db.asD1(),'admin',change('sources','s',{...source,original_markdown:'替换原文'},source))).conflicts).toHaveLength(1);
  });
  it('前台只应用变化记录，保留未变化对象和分组所需的事务完整性',async()=>{
    const old=await readLibrary(db.asD1(),'admin'),head=await journalHead(db.asD1(),'admin');await updateCardState(db.asD1(),'admin','q',{expected_revision:head.revision,card_revision:old.cards[0].revision,patch:{favorite:true}});const next=applyLibraryDelta(old,await readJournal(db.asD1(),'admin',head.revision));expect(next.cards[0].favorite).toBe(true);expect(next.projects).toBe(old.projects);expect(old.cards[0].favorite).toBe(false);
  });
  it('同一提交移动卡片、移除旧项目与分类时引用和日志一起完成',async()=>{
    let old=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',old,prepareImport(old,importSchema.parse({schema_version:1,topics:[{id:'old-category',name:'旧大类'}],cards:[{...old.cards[0],topic_ids:['old-category']}]})));old=await readLibrary(db.asD1(),'admin');
    const destination=prepareImport(old,importSchema.parse({schema_version:1,projects:[{id:'new-project',name:'新项目'}],cards:[{...old.cards[0],project_id:'new-project',topic_ids:[]}]}));destination.projects=destination.projects.filter(row=>row.id!=='p');destination.topics=[];
    const plan=await planIncremental(db.asD1(),'admin',changesBetween(old,destination));expect(plan.conflicts).toEqual([]);await commitIncremental(db.asD1(),'admin',old.revision,plan.changes);const actual=await readLibrary(db.asD1(),'admin');expect(actual.projects.map(row=>row.id)).toEqual(['new-project']);expect(actual.cards[0]).toMatchObject({project_id:'new-project',topic_ids:[]});expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('网站与客户端只同步变化记录',()=>{
  let remote:LocalDatabase,server:Awaited<ReturnType<typeof startDesktopServer>>,env:Env,cookie='';
  let offline=false,loseAck=false,beforePush:(()=>Promise<void>)|undefined;const traffic:{path:string;records:number}[]=[];let remoteSQL:string[]=[],localSQL:string[]=[];
  const request=async(path:string,value?:unknown)=>app.fetch(new Request(site+'/api/v1/'+path,{method:value===undefined?'GET':'POST',headers:{Origin:site,Cookie:'__Host-interview_session='+cookie,...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)}),env);
  const readLocal=()=>readLibrary(server.db.asD1(),'admin');
  async function edit(where:'local'|'remote',patch:object){const db=where==='local'?server.db:remote,base=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',base,prepareImport(base,importSchema.parse({schema_version:1,cards:[{...base.cards[0],...patch}]})));}
  beforeEach(async()=>{
    offline=false;loseAck=false;beforePush=undefined;traffic.length=0;remote=new LocalDatabase(':memory:',migrations);cookie='c'.repeat(64);remote.raw.prepare("UPDATE users SET email='owner@example.test',password_hash='test-only' WHERE id='admin'").run();remote.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(cookie),'admin',new Date().toISOString(),new Date(Date.now()+3600000).toISOString());
    env={DB:remote.asD1(),APP_ENV:'production',OWNER_EMAIL:'owner@example.test',ASSETS:{fetch:async()=>new Response('test')} as unknown as Fetcher};await commitLibrary(remote.asD1(),'admin',await readLibrary(remote.asD1(),'admin'),sample());
    server=await startDesktopServer({dataDir:mkdtempSync(join(tmpdir(),'cards-delta-')),assets:resolve('dist'),migrations,port:0,lan:false,cloud:{autoStart:false,codec,fetch:async(input,init)=>{if(offline)throw new Error('offline');const path=new URL(String(input)).pathname;if(path.endsWith('/push')&&beforePush){const run=beforePush;beforePush=undefined;await run();}const response=await app.fetch(new Request(String(input),init),env);const body=await response.clone().json() as any;traffic.push({path,records:body.records?.length??0});if(path.endsWith('/push')&&response.ok&&loseAck){loseAck=false;throw new Error('lost ack');}return response;}}});await commitLibrary(server.db.asD1(),'admin',await readLocal(),sample());
    const code=(await (await request('device-sync/code',{})).json() as any).code;await server.cloud.connect('admin',{site,code,name:'示例电脑'});await server.cloud.enable('admin');await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).incremental).toBe(true);remoteSQL=trace(remote);localSQL=trace(server.db);traffic.length=0;
  });
  afterEach(async()=>{await server.close();remote.close();});
  it('空闲、拉取、上传均无整库读取；修改一题只返回这一题，上传后不再拉完整快照',async()=>{
    await server.cloud.syncNow('admin');expect(traffic.every(row=>row.records===0)).toBe(true);expect(fullReads(remoteSQL)).toEqual([]);expect(fullReads(localSQL)).toEqual([]);
    await edit('remote',{answer_md:'网站新答案'});remoteSQL.length=0;localSQL.length=0;traffic.length=0;await server.cloud.syncNow('admin');expect(traffic.some(row=>row.path.endsWith('/pull')&&row.records===1)).toBe(true);expect(fullReads(remoteSQL)).toEqual([]);expect(fullReads(localSQL)).toEqual([]);expect((await readLocal()).cards[0].answer_md).toBe('网站新答案');
    await edit('local',{summary_md:'本机新口述'});remoteSQL.length=0;localSQL.length=0;traffic.length=0;await server.cloud.syncNow('admin');expect(fullReads(remoteSQL)).toEqual([]);expect(fullReads(localSQL)).toEqual([]);expect(traffic.some(row=>row.path.endsWith('/push')&&row.records===1)).toBe(true);expect(traffic.some(row=>row.path.endsWith('/snapshot'))).toBe(false);expect((await readLibrary(remote.asD1(),'admin')).cards[0].summary_md).toBe('本机新口述');expect((await server.cloud.status('admin')).phase).toBe('idle');
  });
  it('断网、丢失回执和重启继续使用原游标、令牌及持久操作',async()=>{
    const saved=JSON.parse(String(server.db.raw.prepare("SELECT value FROM desktop_settings WHERE key='website-sync:admin'").get()!.value));await edit('local',{answer_md:'断网的新讲解'});offline=true;await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).pending).toBe(true);offline=false;loseAck=true;await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).pending).toBe(true);const count=remote.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n;await server.cloud.syncNow('admin');expect(remote.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n).toBe(count);expect((await server.cloud.status('admin')).pending).toBe(false);const next=JSON.parse(String(server.db.raw.prepare("SELECT value FROM desktop_settings WHERE key='website-sync:admin'").get()!.value));expect(next.secret).toBe(saved.secret);expect(next.deviceId).toBe(saved.deviceId);expect(traffic.some(row=>row.path.endsWith('/snapshot'))).toBe(false);
  });
  it('旧的已连接配置本地建索引后直接增量接续，不换令牌、不重下题库',async()=>{
    const local=await readLocal(),cloud=await readLibrary(remote.asD1(),'admin'),key='website-sync:admin',link=JSON.parse(String(server.db.raw.prepare('SELECT value FROM desktop_settings WHERE key=?').get(key)!.value));link.protocol=undefined;link.baseline=cloud;link.localRevision=local.revision;link.remoteRevision=cloud.revision;server.db.raw.prepare('UPDATE desktop_settings SET value=? WHERE key=?').run(JSON.stringify(link),key);server.db.raw.prepare("DELETE FROM website_sync_baseline WHERE user_id='admin'").run();
    await edit('local',{summary_md:'旧客户端尚未上传'});traffic.length=0;await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).incremental).toBe(true);expect((await readLibrary(remote.asD1(),'admin')).cards[0].summary_md).toBe('旧客户端尚未上传');expect(traffic.some(row=>row.path.endsWith('/snapshot')||row.path.endsWith('/connect'))).toBe(false);const next=JSON.parse(String(server.db.raw.prepare('SELECT value FROM desktop_settings WHERE key=?').get(key)!.value));expect(next.secret).toBe(link.secret);
  });
  it('同字段冲突与重新检查仅取相关记录；选择后两边继续收敛',async()=>{
    await edit('local',{answer_md:'本地冲突'});await edit('remote',{answer_md:'网站冲突'});traffic.length=0;await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('conflict');await server.cloud.resolve('admin','local');await server.cloud.syncNow('admin');await server.cloud.syncNow('admin');expect((await readLocal()).cards[0].answer_md).toBe('本地冲突');expect((await readLibrary(remote.asD1(),'admin')).cards[0].answer_md).toBe('本地冲突');expect(traffic.some(row=>row.path.endsWith('/snapshot'))).toBe(false);
  });
  it('上传间隙网站修改其他字段，回执合并后不会重放旧日志造成假冲突',async()=>{
    await edit('local',{summary_md:'本地口述'});beforePush=async()=>{await edit('remote',{answer_md:'同时修改的网站讲解'});};await server.cloud.syncNow('admin');await server.cloud.syncNow('admin');const actual=(await readLocal()).cards[0];expect(actual).toMatchObject({summary_md:'本地口述',answer_md:'同时修改的网站讲解'});expect((await server.cloud.status('admin')).phase).toBe('idle');expect(traffic.some(row=>row.path.endsWith('/snapshot'))).toBe(false);
  });
  it('上传冲突后继续编辑并重新检查，不会丢弃已消费游标对应的待发送内容',async()=>{
    await edit('local',{answer_md:'第一次本地修改'});beforePush=async()=>{await edit('remote',{answer_md:'网站并发修改'});};await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('conflict');await edit('local',{answer_md:'网站并发修改',summary_md:'还要保留的本地口述'});await server.cloud.recheck('admin');await server.cloud.syncNow('admin');await server.cloud.syncNow('admin');expect((await readLibrary(remote.asD1(),'admin')).cards[0]).toMatchObject({answer_md:'网站并发修改',summary_md:'还要保留的本地口述'});expect((await server.cloud.status('admin')).conflicts).toBeUndefined();
  });
  it('单条变更的返回量不随几百条未变题目增长',async()=>{
    for(const db of [remote,server.db]){const old=await readLibrary(db.asD1(),'admin');await commitLibrary(db.asD1(),'admin',old,prepareImport(old,importSchema.parse({schema_version:1,cards:Array.from({length:350},(_,i)=>({id:'unrelated-'+i,project_id:'p',title:'无关示例 '+i,question:'无关示例问题 '+i+'？'}))})));}
    await server.cloud.syncNow('admin');await server.cloud.syncNow('admin');await edit('remote',{answer_md:'仅这一条发生变化'});traffic.length=0;remoteSQL.length=0;localSQL.length=0;await server.cloud.syncNow('admin');expect(traffic.filter(row=>row.path.endsWith('/pull')).map(row=>row.records)).toEqual([1]);expect(fullReads(remoteSQL)).toEqual([]);expect(fullReads(localSQL)).toEqual([]);
  });
  it('恢复后沿用现有连接重新核对，待上传内容、设备标识和密文均保留',async()=>{
    const key='website-sync:admin',before=JSON.parse(String(server.db.raw.prepare('SELECT value FROM desktop_settings WHERE key=?').get(key)!.value));await edit('local',{answer_md:'恢复前尚未上传'});const base=await readLibrary(remote.asD1(),'admin');await commitLibrary(remote.asD1(),'admin',base,base,{restore:true});await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('recovery');
    const preview=await server.cloud.reviewRestore('admin');expect(preview.phase).toBe('review');expect((await readLocal()).cards[0].answer_md).toBe('恢复前尚未上传');await server.cloud.enable('admin');for(let i=0;i<3;i++)await server.cloud.syncNow('admin');expect((await readLibrary(remote.asD1(),'admin')).cards[0].answer_md).toBe('恢复前尚未上传');const after=JSON.parse(String(server.db.raw.prepare('SELECT value FROM desktop_settings WHERE key=?').get(key)!.value));expect(after.deviceId).toBe(before.deviceId);expect(after.secret).toBe(before.secret);expect(after.protocol).toBe(2);
  });
});
