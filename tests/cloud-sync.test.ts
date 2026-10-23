import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import app from '../worker/index';
import { LocalDatabase } from '../desktop/database';
import { startDesktopServer } from '../desktop/server';
import { tokenHash, type Env } from '../worker/auth';
import { emptyLibrary, importSchema, prepareImport, type Library } from '../shared/model';
import { changesBetween, type SyncOperation } from '../shared/sync';
import { commitLibrary, readLibrary } from '../worker/store';
import type { SecretCodec } from '../desktop/cloud-sync';

const site='https://sync.example.test',migrations=resolve('migrations');
const fixture=()=>prepareImport(emptyLibrary(),importSchema.parse({schema_version:1,projects:[{id:'p',name:'示例题库'}],cards:[{id:'q',project_id:'p',title:'事务',question:'事务是什么？',summary_md:'初始口述',answer_md:'初始讲解'}]}));
const codec:SecretCodec={encrypt:async value=>'test:'+Buffer.from(value).toString('base64'),decrypt:async value=>Buffer.from(value.slice(5),'base64').toString()};
it('带网站同步表的完整数据库导入本地后不会重复迁移或改变原题库',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'cards-cloud-import-')),'library.sqlite');let db=new LocalDatabase(file,migrations);
  await commitLibrary(db.asD1(),'admin',await readLibrary(db.asD1(),'admin'),fixture());const before=await readLibrary(db.asD1(),'admin');
  const epoch=db.raw.prepare("SELECT epoch FROM cloud_sync_state WHERE user_id='admin'").get()!.epoch;
  db.raw.exec('DELETE FROM desktop_migrations');db.close();db=new LocalDatabase(file,migrations);
  try{expect((await readLibrary(db.asD1(),'admin')).cards).toEqual(before.cards);expect(db.raw.prepare("SELECT epoch FROM cloud_sync_state WHERE user_id='admin'").get()!.epoch).toBe(epoch);expect(db.raw.prepare("SELECT count(*) n FROM desktop_migrations WHERE name LIKE '0004%'").get()!.n).toBe(1);}finally{db.close();}
});
async function website() {
  const db=new LocalDatabase(':memory:',migrations),cookieToken='b'.repeat(64);
  db.raw.prepare("UPDATE users SET email='owner@example.test',password_hash='test-hash' WHERE id='admin'").run();
  db.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(cookieToken),'admin',new Date().toISOString(),new Date(Date.now()+3600000).toISOString());
  const env:Env={DB:db.asD1(),APP_ENV:'production',OWNER_EMAIL:'owner@example.test',ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test-human',AGENT_ACCESS_AUD:'test-machine',ASSETS:{fetch:async()=>new Response('test')} as unknown as Fetcher};
  await commitLibrary(db.asD1(),'admin',await readLibrary(db.asD1(),'admin'),fixture());
  const request=async(path:string,value?:unknown,token?:string,session=true)=>app.fetch(new Request(site+'/api/v1/'+path,{method:value===undefined?'GET':'POST',headers:{Origin:site,...(session?{Cookie:'__Host-interview_session='+cookieToken}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)}),env);
  const code=async()=>String((await (await request('device-sync/code',{})).json() as {code:string}).code);
  return{db,env,request,code};
}

describe('网站设备同步授权与事务',()=>{
  let remote:Awaited<ReturnType<typeof website>>;
  beforeEach(async()=>{remote=await website();});afterEach(()=>remote.db.close());
  it('连接码只能用一次；设备令牌只访问同步协议，不能调用账号或普通管理 API',async()=>{
    const code=await remote.code();const response=await remote.request('device-sync/connect',{code,name:'电脑'},undefined,false);expect(response.status).toBe(200);const {token}=await response.json() as {token:string};
    expect((await remote.request('device-sync/connect',{code,name:'另一台'},undefined,false)).status).toBe(401);
    expect((await remote.request('device-sync/snapshot',undefined,token,false)).status).toBe(200);
    expect((await remote.request('library',undefined,token,false)).status).toBe(401);
    expect((await remote.request('device-sync/code',{},token,false)).status).toBe(401);
    expect((await remote.request('users',undefined,token,false)).status).toBe(401);
  });
  it('过期连接码、匿名、跨站请求均不能建立授权',async()=>{
    const code=await remote.code();remote.db.raw.prepare('UPDATE cloud_sync_codes SET expires_at=0').run();
    expect((await remote.request('device-sync/connect',{code,name:'电脑'},undefined,false)).status).toBe(401);
    expect((await remote.request('device-sync/code',{},undefined,false)).status).toBe(401);
    expect((await app.fetch(new Request(site+'/api/v1/device-sync/connect',{method:'POST',headers:{Origin:'https://wrong.example.test','Content-Type':'application/json'},body:JSON.stringify({code,name:'电脑'})}),remote.env)).status).toBe(403);
  });
  it('幂等回执与答案同事务保存，重复请求不会增加历史，操作编号不能换内容',async()=>{
    const code=await remote.code(),{token}=await (await remote.request('device-sync/connect',{code,name:'电脑'},undefined,false)).json() as {token:string};
    const snapshot=await (await remote.request('device-sync/snapshot',undefined,token,false)).json() as {library:Library;epoch:string};
    const target=prepareImport(snapshot.library,importSchema.parse({schema_version:1,cards:[{...snapshot.library.cards[0],answer_md:'新讲解'}]}));
    const operation={id:'edit-once',epoch:snapshot.epoch,changes:changesBetween(snapshot.library,target)};
    const one=await (await remote.request('device-sync/push',operation,token,false)).json(),count=remote.db.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n;
    expect(await (await remote.request('device-sync/push',operation,token,false)).json()).toEqual(one);
    expect(remote.db.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n).toBe(count);
    expect((await remote.request('device-sync/push',{...operation,changes:[]},token,false)).status).toBe(409);
    expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('新讲解');
  });
  it('令牌按账号隔离，撤销和修改密码后立即失效',async()=>{
    const code=await remote.code(),linked=await (await remote.request('device-sync/connect',{code,name:'电脑'},undefined,false)).json() as {token:string;deviceId:string};
    const now=new Date().toISOString();remote.db.raw.prepare("INSERT INTO users VALUES ('member','member@example.test','成员','member','active','hash',?,?)").run(now,now);remote.db.raw.prepare("INSERT INTO user_library_meta VALUES ('member',0)").run();
    const snapshot=await (await remote.request('device-sync/snapshot',undefined,linked.token,false)).json() as {library:Library};expect(snapshot.library.cards).toHaveLength(1);
    expect((await remote.request('device-sync/revoke',{id:linked.deviceId})).status).toBe(422);
    await remote.request('device-sync/revoke',{id:linked.deviceId,confirmed:true});expect((await remote.request('device-sync/snapshot',undefined,linked.token,false)).status).toBe(401);
    const next=await (await remote.request('device-sync/connect',{code:await remote.code(),name:'电脑'},undefined,false)).json() as {token:string};remote.db.raw.prepare("UPDATE users SET password_hash='changed' WHERE id='admin'").run();expect((await remote.request('device-sync/snapshot',undefined,next.token,false)).status).toBe(401);
  });
  it('回执写入失败时，答案与历史也回滚，设备不能提交恢复或导入记录',async()=>{
    const {token}=await (await remote.request('device-sync/connect',{code:await remote.code(),name:'电脑'},undefined,false)).json() as {token:string};
    const snapshot=await (await remote.request('device-sync/snapshot',undefined,token,false)).json() as {library:Library;epoch:string};
    const changed=prepareImport(snapshot.library,importSchema.parse({schema_version:1,cards:[{...snapshot.library.cards[0],answer_md:'不应部分保存'}]}));const operation={id:'receipt-fails',epoch:snapshot.epoch,changes:changesBetween(snapshot.library,changed)};
    expect((await remote.request('device-sync/push',{...operation,record:{}},token,false)).status).toBe(403);
    expect((await remote.request('device-sync/push',{...operation,mode:'restore'},token,false)).status).toBe(422);
    remote.db.raw.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON cloud_sync_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END;");
    expect((await remote.request('device-sync/push',operation,token,false)).status).toBe(500);
    expect((await readLibrary(remote.db.asD1(),'admin')).cards).toEqual(snapshot.library.cards);
    expect(remote.db.raw.prepare('SELECT count(*) n FROM cloud_sync_receipts').get()!.n).toBe(0);
    expect(remote.db.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n).toBe(1);
  });
});

describe('客户端与网站的持久双向同步',()=>{
  let remote:Awaited<ReturnType<typeof website>>,server:Awaited<ReturnType<typeof startDesktopServer>>,data:string;
  let offline=false,loseAck=false,pushGate:(()=>Promise<void>)|undefined,beforePush:(()=>Promise<void>)|undefined,lastToken='';
  const transport:typeof fetch=async(input,init)=>{
    if(offline)throw new Error('test offline');
    const url=String(input);if(url.endsWith('/push')&&beforePush){const task=beforePush;beforePush=undefined;await task();}const response=await app.fetch(new Request(url,init),remote.env);
    if(url.endsWith('/connect')&&response.ok)lastToken=(await response.clone().json() as {token:string}).token;
    if(url.endsWith('/push')&&response.ok){if(pushGate)await pushGate();if(loseAck){loseAck=false;throw new Error('test lost acknowledgment');}}
    return response;
  };
  const start=()=>startDesktopServer({dataDir:data,assets:resolve('dist'),migrations,port:0,lan:false,cloud:{autoStart:false,codec,fetch:transport}});
  const local=()=>readLibrary(server.db.asD1(),'admin');
  async function edit(where:'local'|'remote',patch:object){const db=where==='local'?server.db:remote.db,base=await readLibrary(db.asD1(),'admin');return commitLibrary(db.asD1(),'admin',base,prepareImport(base,importSchema.parse({schema_version:1,cards:[{...base.cards[0],...patch}]})));}
  async function link(){await server.cloud.connect('admin',{site,code:await remote.code(),name:'测试电脑'});await server.cloud.enable('admin');await server.cloud.syncNow('admin');}
  beforeEach(async()=>{offline=false;loseAck=false;pushGate=undefined;beforePush=undefined;lastToken='';remote=await website();data=mkdtempSync(join(tmpdir(),'cards-cloud-'));server=await start();await commitLibrary(server.db.asD1(),'admin',await local(),fixture());});
  afterEach(async()=>{await server?.close();remote.db.close();});
  it('首次读取不会自动混合；确认后备份并合并，状态接口不暴露令牌',async()=>{
    const base=await local();await commitLibrary(server.db.asD1(),'admin',base,prepareImport(base,importSchema.parse({schema_version:1,cards:[{id:'local-only',project_id:'p',title:'仅本机',question:'仅本机问题？'}]})));
    const remoteBase=await readLibrary(remote.db.asD1(),'admin');await commitLibrary(remote.db.asD1(),'admin',remoteBase,prepareImport(remoteBase,importSchema.parse({schema_version:1,cards:[{id:'remote-only',project_id:'p',title:'仅网站',question:'仅网站问题？'}]})));
    const status=await server.cloud.connect('admin',{site,code:await remote.code(),name:'测试电脑'});
    expect(status.phase).toBe('review');expect((await local()).cards).toHaveLength(2);expect((await readLibrary(remote.db.asD1(),'admin')).cards).toHaveLength(2);
    expect(JSON.stringify(status)).not.toContain(lastToken);expect(String(server.db.raw.prepare("SELECT value FROM desktop_settings WHERE key='website-sync:admin'").get()!.value)).not.toContain(lastToken);
    await server.cloud.enable('admin');await server.cloud.syncNow('admin');expect((await local()).cards).toHaveLength(3);expect((await readLibrary(remote.db.asD1(),'admin')).cards).toHaveLength(3);
    expect(readdirSync(join(data,'backups')).some(name=>name.startsWith('before-website-sync-'))).toBe(true);
  });
  it('网站题目和答案到本机、本机答案到网站，不同字段并发修改自动合并',async()=>{
    await link();await edit('remote',{question:'网站的新问题？',summary_md:'网站的新口述'});await server.cloud.syncNow('admin');expect((await local()).cards[0]).toMatchObject({question:'网站的新问题？',summary_md:'网站的新口述'});
    await edit('local',{answer_md:'本地新讲解'});await edit('remote',{mastery:'mastered'});await server.cloud.syncNow('admin');
    expect((await local()).cards[0]).toMatchObject({mastery:'mastered',answer_md:'本地新讲解'});expect((await readLibrary(remote.db.asD1(),'admin')).cards[0]).toMatchObject({mastery:'mastered',answer_md:'本地新讲解'});
  });
  it.each(['local','remote'] as const)('同字段冲突保留两份，确认后选择 %s 版本',async choice=>{
    await link();await edit('local',{answer_md:'本地讲解'});await edit('remote',{answer_md:'网站讲解'});await server.cloud.syncNow('admin');
    const state=await server.cloud.status('admin');expect(state.phase).toBe('conflict');expect(state.conflicts?.[0]).toMatchObject({field:'answer_md',computer:'网站讲解',phone:'本地讲解'});
    expect((await local()).cards[0].answer_md).toBe('本地讲解');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('网站讲解');
    await server.cloud.resolve('admin',choice);await server.cloud.syncNow('admin');const answer=choice==='local'?'本地讲解':'网站讲解';expect((await local()).cards[0].answer_md).toBe(answer);expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe(answer);
  });
  it('断网和重启不丢本地修改，恢复连接后继续上传',async()=>{
    await link();await edit('local',{summary_md:'断网时保存的口述'});offline=true;await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('error');await server.close();server=await start();expect((await local()).cards[0].summary_md).toBe('断网时保存的口述');offline=false;await server.cloud.syncNow('admin');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].summary_md).toBe('断网时保存的口述');
  });
  it('网站提交后丢失回执，重启重试不会重复保存或丢失修改',async()=>{
    await link();await edit('local',{answer_md:'需要幂等保存的答案'});loseAck=true;await server.cloud.syncNow('admin');const count=remote.db.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n;
    expect((await server.cloud.status('admin')).pending).toBe(true);await server.close();server=await start();await server.cloud.syncNow('admin');expect(remote.db.raw.prepare('SELECT count(*) n FROM user_card_revisions').get()!.n).toBe(count);expect((await server.cloud.status('admin')).phase).toBe('idle');
  });
  it('公网请求等待期间本地仍可保存，上传途中新增的修改不会被回执覆盖',async()=>{
    await link();await edit('local',{answer_md:'第一次修改'});let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>started=r);pushGate=async()=>{started();await gate;};
    const work=server.cloud.syncNow('admin');await seen;
    try{const base=await local(),launch=await fetch(server.bootstrapUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
      const response=await fetch(server.origin+'/api/v1/changes',{method:'POST',headers:{Origin:server.origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({expected_revision:base.revision,changes:{schema_version:1,cards:[{...base.cards[0],answer_md:'上传期间的第二次修改'}]}}),signal:AbortSignal.timeout(2000)});
      expect(response.status).toBe(200);expect((await local()).cards[0].answer_md).toBe('上传期间的第二次修改');}finally{release();await work;pushGate=undefined;}
    expect((await server.cloud.status('admin')).pending).toBe(true);await server.cloud.syncNow('admin');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('上传期间的第二次修改');
  });
  it('网站或本机恢复备份后暂停，不自动覆盖另一个题库',async()=>{
    await link();await edit('local',{answer_md:'尚未上传'});const base=await readLibrary(remote.db.asD1(),'admin');await commitLibrary(remote.db.asD1(),'admin',base,base,{restore:true});await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('recovery');expect((await local()).cards[0].answer_md).toBe('尚未上传');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('初始讲解');
  });
  it('解除连接保留两端题库，撤销设备后不再上传本地数据',async()=>{
    await link();await server.cloud.pause('admin');const before=await local();await server.cloud.disconnect('admin');expect((await local()).cards).toEqual(before.cards);expect((await server.cloud.status('admin')).connected).toBe(false);expect((await readLibrary(remote.db.asD1(),'admin')).cards).toHaveLength(1);
  });
  it('本地账号停用后暂停后台上传，启用后仍保留待同步修改',async()=>{
    await link();await edit('local',{answer_md:'停用账号前的本地修改'});server.db.raw.prepare("UPDATE users SET status='disabled' WHERE id='admin'").run();await server.cloud.syncNow('admin');
    expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('初始讲解');expect((await server.cloud.status('admin')).pending).toBe(true);
    server.db.raw.prepare("UPDATE users SET status='active' WHERE id='admin'").run();await server.cloud.syncNow('admin');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('停用账号前的本地修改');
  });
  it('首次读取网站失败会撤销刚建立的授权，不混合本地题库',async()=>{
    const failed=await startDesktopServer({dataDir:mkdtempSync(join(tmpdir(),'cards-cloud-fail-')),assets:resolve('dist'),migrations,port:0,lan:false,cloud:{autoStart:false,codec,fetch:async(input,init)=>String(input).endsWith('/snapshot')?new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}):transport(input,init)}});
    try {await expect(failed.cloud.connect('admin',{site,code:await remote.code(),name:'读取失败的电脑'})).rejects.toThrow();expect((await failed.cloud.status('admin')).connected).toBe(false);expect(remote.db.raw.prepare('SELECT count(*) n FROM cloud_sync_devices').get()!.n).toBe(0);}finally{await failed.close();}
  });
  it.each(['local','remote'] as const)('上传时网站又改同字段，冲突选择 %s 不覆盖另一份未确认内容',async choice=>{
    await link();await edit('local',{answer_md:'本地并发修改'});beforePush=async()=>{await edit('remote',{answer_md:'网站并发修改'});};await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('conflict');await server.cloud.resolve('admin',choice);await server.cloud.syncNow('admin');const answer=choice==='local'?'本地并发修改':'网站并发修改';expect((await local()).cards[0].answer_md).toBe(answer);expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe(answer);
  });
  it('网站的删除正常同步；删除与本地编辑并发时不自动丢弃编辑',async()=>{
    await link();await edit('local',{answer_md:'本机尚未同步的修改'});const base=await readLibrary(remote.db.asD1(),'admin');await commitLibrary(remote.db.asD1(),'admin',base,{...base,cards:[],revisions:[]});await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('conflict');expect((await local()).cards[0].answer_md).toBe('本机尚未同步的修改');await server.cloud.resolve('admin','remote');await server.cloud.syncNow('admin');expect((await local()).cards).toEqual([]);
  });
  it('本机恢复后不把旧改动上传，账号凭证不向手机或 AI 暴露',async()=>{
    await link();await edit('local',{answer_md:'恢复后的本地内容'});server.db.raw.prepare("UPDATE sync_state SET epoch='restored' WHERE user_id='admin'").run();await server.cloud.syncNow('admin');expect((await server.cloud.status('admin')).phase).toBe('recovery');expect((await readLibrary(remote.db.asD1(),'admin')).cards[0].answer_md).toBe('初始讲解');
    expect((await fetch(server.origin+'/api/v1/desktop/cloud-sync',{headers:{Authorization:'Bearer '+lastToken}})).status).toBe(401);
    expect((await fetch(server.origin+'/api/v1/desktop/cloud-sync',{method:'POST',headers:{Origin:'https://wrong.example.test','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
  });
});
