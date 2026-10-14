import { readFileSync,writeFileSync } from 'node:fs';
import { useSystemProxy } from './system-proxy.mjs';
const state=JSON.parse(readFileSync('.cloudflare-access.json','utf8')),site=new URL(state.site_url);
useSystemProxy(site);
for(const [path,expected] of [['/',200],['/api/v1/library',401],['/bootstrap-admin/',302]]) {
  const response=await fetch(new URL(path,site),{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.status!==expected)throw new Error('访问范围尚未切换或尚未生效：'+path+' 返回 '+response.status);
}
const agent=await fetch(new URL('/api/v1/agent/library',site),{redirect:'manual',signal:AbortSignal.timeout(15000)});
if(![302,401,403].includes(agent.status))throw new Error('机器入口没有拒绝匿名请求');
state.auth_mode='password';state.owner_domain=site.hostname+'/bootstrap-admin/*';
writeFileSync('.cloudflare-access.json',JSON.stringify(state,null,2)+'\n');
console.log('已核对入口并保存本机账号密码模式记录。');
