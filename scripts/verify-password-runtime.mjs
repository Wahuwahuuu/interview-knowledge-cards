import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { useSystemProxy } from './system-proxy.mjs';
// An ephemeral Worker checks real platform limits; it has no DB or user information.
const source=JSON.parse(await readFile('wrangler.jsonc','utf8'));
const name='interview-cards-hash-check-'+crypto.randomUUID().slice(0,8), key=crypto.randomUUID();
const configPath='.private/hash-check.json', mainPath='.private/hash-check.ts';
const env={...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_CF_FETCH_ENABLED:'false'};
function command(args) { const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{env,encoding:'utf8',windowsHide:true}); if(result.status!==0)throw new Error('密码运行环境检查工具未完成：'+result.stderr.replaceAll(key,'[redacted]')); return result.stdout; }
await mkdir('.private',{recursive:true});
await writeFile(mainPath,`import { hashPassword, verifyPassword } from '../worker/password';
export default { async fetch(request: Request, env: { PROBE_KEY: string }) { if(request.headers.get('x-probe-key')!==env.PROBE_KEY)return new Response('Not found',{status:404}); try { const hash=await hashPassword('test-only-long-password'); const ok=await verifyPassword('test-only-long-password',hash); return Response.json({ok}); } catch(error) { return Response.json({ok:false,error:String(error)},{status:500}); } } };
`);
await writeFile(configPath,JSON.stringify({name,main:'./hash-check.ts',account_id:source.account_id,compatibility_date:source.compatibility_date,compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,vars:{PROBE_KEY:key}},null,2));
let created=false;
try {
  const deployed=command(['deploy','--config',configPath]); created=true;
  const published=deployed.match(new RegExp(`https://${name}\\.[a-zA-Z0-9-]+\\.workers\\.dev`))?.[0];
  if(!published)throw new Error('没有返回本次临时检查的网址');
  const site=new URL(published); useSystemProxy(site);
  for(let i=0;i<3;i++) {
    let response;
    for(let attempt=0;attempt<20;attempt++) { response=await fetch(site,{headers:{'x-probe-key':key},signal:AbortSignal.timeout(15000)}); if(response.status!==404)break; await new Promise(resolve=>setTimeout(resolve,1000)); }
    const text=await response.text(); if(!response.ok)throw new Error('Cloudflare 密码计算检查失败（'+response.status+'）：'+text.slice(0,350)); const value=JSON.parse(text); if(!value.ok)throw new Error('密码计算未通过');
  }
  await mkdir('test-results',{recursive:true}); await writeFile('test-results/password-runtime.json',JSON.stringify({passed:true,at:new Date().toISOString(),platform:'Cloudflare Workers',algorithm:'scrypt N=32768 r=8 p=3',requests:3},null,2));
  console.log('真实 Cloudflare 环境的密码计算与校验：3 次通过。');
} finally {
  if(created) { command(['delete','--config',configPath,'--force']); console.log('已清理本次临时检查资源。'); }
  await unlink(mainPath).catch(()=>{}); await unlink(configPath).catch(()=>{});
}
