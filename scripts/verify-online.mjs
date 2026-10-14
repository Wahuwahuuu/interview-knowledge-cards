import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readAgentCredential } from './private-credential.mjs';
import { useSystemProxy } from './system-proxy.mjs';
const credential = await readAgentCredential();
if (!credential) throw new Error('本机还没有配置 AI 服务凭证。');
const site = new URL(credential.site_url);
useSystemProxy(site);
const machineHeaders = { 'CF-Access-Client-Id': credential.client_id, 'CF-Access-Client-Secret': credential.client_secret };
const checks = [];
async function request(path, options = {}, machine = true) {
  try {
    return await fetch(new URL(path, site), { ...options, headers: { ...(machine ? machineHeaders : {}), ...options.headers }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (error) { throw new Error('线上连接未完成：' + (error.cause?.code || error.name)); }
}
async function data(response) {
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('机器请求没有进入 JSON 接口，请核对 Access 的机器路径。');
  const value = await response.json();
  if (!response.ok) throw new Error('线上接口未通过：' + (value.error?.message || response.status));
  return value;
}
const anonymous = await request('/api/v1/library', {}, false);
if (![301, 302, 303, 307, 308, 401, 403].includes(anonymous.status)) throw new Error('未登录访问没有被拒绝，停止导入。');
checks.push('未登录读取题库被拒绝');
const before = await data(await request('/api/v1/agent/library'));
checks.push('真实 AI 服务凭证可以读取题库');
const seed = await readFile('examples/demo-import.json', 'utf8');
const preview = await data(await request('/api/v1/agent/imports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: seed }));
if (!preview.id) throw new Error('线上导入草稿未保存。');
const repeated = await data(await request('/api/v1/agent/imports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: seed }));
if (repeated.id !== preview.id) throw new Error('重复提交没有复用同一批次。');
checks.push('首批两题已作为草稿提交，重复批次复用');
for (const path of [`/api/v1/agent/imports/${preview.id}/apply`, `/api/v1/imports/${preview.id}/apply`]) {
  const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.origin }, body: JSON.stringify({ expected_revision: before.revision }) });
  if (![301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw new Error('机器身份的人工确认路径没有被拒绝。');
}
checks.push('真实机器凭证不能通过机器或人工路径确认导入');
const after = await data(await request('/api/v1/agent/library'));
if (after.revision !== before.revision || after.cards.length !== before.cards.length) throw new Error('草稿改变了正式题库，停止继续。');
checks.push('提交草稿没有改变正式卡片');
await mkdir('test-results', { recursive: true });
await writeFile('test-results/online-verification.json', JSON.stringify({ passed: true, at: new Date().toISOString(), site_url: site.origin, batch_id: preview.id, checks }, null, 2));
console.log(JSON.stringify({ passed: true, batch_id: preview.id, checks, next: '请用本人邮箱登录，在维护与备份中预览并确认首批两题。' }, null, 2));
