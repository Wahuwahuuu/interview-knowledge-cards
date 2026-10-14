import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { useSystemProxy } from './system-proxy.mjs';
import { readAgentCredential } from './private-credential.mjs';
const credential=await readAgentCredential();
if(!credential)throw new Error('缺少本机独立机器凭证');
const site=new URL(credential.site_url), config=JSON.parse(await readFile('wrangler.jsonc','utf8')), stamp=crypto.randomUUID(), reports=[], created=[];
const password='verification-only-'+crypto.randomUUID();
useSystemProxy(site);
const machineHeaders={'CF-Access-Client-Id':credential.client_id,'CF-Access-Client-Secret':credential.client_secret};
async function req(path,{method='GET',value,cookie,agent=false}={}) {
  const response=await fetch(new URL(path,site),{method,headers:{Origin:site.origin,'Content-Type':'application/json',...(agent?machineHeaders:{}),...(cookie?{Cookie:cookie}:{})},...(value?{body:JSON.stringify(value)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});
  return {status:response.status,value:response.headers.get('content-type')?.includes('json')?await response.json():null,cookie:response.headers.get('set-cookie')};
}
async function ok(path,options) { const result=await req(path,options); assert.equal(result.status,200,path+': '+(result.value?.error?.message||result.status)); return result; }
const report=name=>{reports.push(name);console.log('通过：'+name);};
const before=(await ok('/api/v1/agent/library',{agent:true})).value;
try {
  assert.equal((await req('/')).status,200); const status=(await ok('/api/v1/auth/status')).value; assert.equal(status.admin_ready,true); assert.equal(status.registration_open,true);
  for(const path of ['/api/v1/library','/api/v1/export','/api/v1/imports','/api/v1/admin/users'])assert.equal((await req(path)).status,401);
  assert.equal((await req('/bootstrap-admin/')).status,302); report('登录注册页开放；匿名不能读取题库或管理用户，管理员验证入口独立保护');
  for(const label of ['a','b']) {
    const email='verification-'+label+'-'+stamp+'@example.invalid';
    const account=await ok('/api/v1/auth/register',{method:'POST',value:{email,password,display_name:'上线验证临时账户'}});
    assert.match(account.value.user_id,/^[a-f0-9-]{36}$/); assert.equal(account.value.role,'member');
    created.push({id:account.value.user_id,email,cookie:account.cookie.split(';')[0]});
    for(const attribute of ['__Host-interview_session=','HttpOnly','Secure','SameSite=Lax'])assert.ok(account.cookie.includes(attribute));
    assert.equal((await ok('/api/v1/library',{cookie:created.at(-1).cookie})).value.cards.length,0);
  }
  const [a,b]=created; report('真实线上注册建立独立空题库，会话 Cookie 安全属性正确');
  const envelope={schema_version:1,batch_id:'verification-'+stamp,projects:[{id:'verification-project',name:'上线验证测试项目'}],cards:[{id:'verification-card',project_id:'verification-project',title:'测试题',question:'测试问题',answer_md:'测试答案'}]};
  const draftA=(await ok('/api/v1/imports/preview',{method:'POST',cookie:a.cookie,value:envelope})).value;
  assert.equal((await req('/api/v1/imports/'+draftA.id,{cookie:b.cookie})).status,404);
  const draftB=(await ok('/api/v1/imports/preview',{method:'POST',cookie:b.cookie,value:{...envelope,cards:[{...envelope.cards[0],answer_md:'乙的测试答案'}]}})).value;
  for(const [user,draft] of [[a,draftA],[b,draftB]])await ok('/api/v1/imports/'+draft.id+'/apply',{method:'POST',cookie:user.cookie,value:{expected_revision:0}});
  const aLibrary=(await ok('/api/v1/library',{cookie:a.cookie})).value,bLibrary=(await ok('/api/v1/library',{cookie:b.cookie})).value;
  assert.equal(aLibrary.cards[0].answer_md,'测试答案'); assert.equal(bLibrary.cards[0].answer_md,'乙的测试答案');
  assert.equal((await req('/api/v1/admin/users',{cookie:a.cookie})).status,403);
  assert.equal((await req('/api/v1/admin/registration',{method:'PUT',cookie:a.cookie,value:{registration_open:false}})).status,403);
  assert.equal((await req('/api/v1/agent/library',{cookie:a.cookie})).status,403); report('线上相同卡片和批次 ID 独立保存，普通用户不能管理用户或冒用机器入口');
  const login=await ok('/api/v1/auth/login',{method:'POST',value:{email:a.email,password}}); const loginCookie=login.cookie.split(';')[0];
  assert.equal(login.value.user_id,a.id); assert.equal((await req('/api/v1/auth/login',{method:'POST',value:{email:a.email,password:'wrong-password'}})).status,401);
  await ok('/api/v1/auth/logout',{method:'POST',cookie:loginCookie,value:{}}); assert.equal((await req('/api/v1/library',{cookie:loginCookie})).status,401); report('线上密码登录、错误密码拒绝和退出会话撤销通过');
  for(const path of ['/api/v1/agent/imports/anything/apply','/api/v1/imports/anything/apply'])assert.ok([401,403].includes((await req(path,{method:'POST',agent:true,value:{expected_revision:before.revision}})).status));
  const after=(await ok('/api/v1/agent/library',{agent:true})).value; assert.deepEqual(after,before); report('管理员原题库未变化；机器凭证仍不能正式应用导入');
} finally {
  // Delete only accounts created by this verification, never existing users.
  if(created.length) {
    const values=created.map(user=>"'"+user.id+"'").join(','), emails=created.map(user=>"'"+user.email+"'").join(',');
    const scope=`SELECT id FROM users WHERE id IN (${values}) AND email IN (${emails}) AND role='member'`;
    const tables=['user_relations','user_occurrences','user_card_topics','user_card_revisions','user_cards','user_sources','user_topics','user_projects','user_import_batches','user_mutation_guard','sessions','user_library_meta'];
    const sql=tables.map(table=>`DELETE FROM ${table} WHERE user_id IN (${scope})`).join(';')+`;DELETE FROM users WHERE id IN (${values}) AND email IN (${emails}) AND role='member';`;
    const cleanup=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--remote','--json','--command',sql],{encoding:'utf8',windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_CF_FETCH_ENABLED:'false'}});
    if(cleanup.status!==0)throw new Error('临时验证账号清理未完成，请保留本次编号 '+stamp+'；未触碰管理员资料。');
    console.log('已清理本次创建的临时账号与测试题库。');
  }
}
await mkdir('test-results',{recursive:true});await writeFile('test-results/online-accounts-verification.json',JSON.stringify({passed:true,at:new Date().toISOString(),site:site.origin,reports,test_accounts_cleaned:true},null,2));
console.log('线上账户验证完成：'+reports.length+' 项通过。');
