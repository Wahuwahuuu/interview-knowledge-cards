import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { useSystemProxy } from './system-proxy.mjs';
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const bootstrap = process.argv.includes('--bootstrap');
if (config.vars.APP_ENV !== 'production') throw new Error('发布必须使用 production 配置；禁止发布本地免登录模式');
if (!config.vars.OWNER_EMAIL || /@example\.(com|org|net)$|\.invalid$/i.test(config.vars.OWNER_EMAIL)) throw new Error('请先在 wrangler.jsonc 填写自己的真实管理员 OWNER_EMAIL。');
useSystemProxy(new URL('https://api.cloudflare.com'));
if (!bootstrap && (!config.vars.ACCESS_TEAM_DOMAIN || !config.vars.ACCESS_AUD)) throw new Error('请先完成邮箱验证码设置并填入 ACCESS_TEAM_DOMAIN、ACCESS_AUD，见 docs/部署说明.md；未配置时不会开放题库。');
if (!existsSync('dist/sw.js')) throw new Error('请先运行 npm run build');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
function run(args) { const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'inherit', env, windowsHide: true }); if (result.status !== 0) process.exit(result.status ?? 1); }
function capture(args) { const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { encoding: 'utf8', env, windowsHide: true }); if (result.status !== 0) throw new Error('尚未完成账户授权，或部署工具读取失败。请先运行 npx wrangler login。'); return JSON.parse(result.stdout); }
const identity = capture(['whoami', '--json']);
const accounts = identity.accounts ?? [];
const accountId = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? (accounts.length === 1 ? accounts[0].id : undefined);
if (!accountId) throw new Error('无法唯一确定 Cloudflare 账户，请在配置中设置 account_id；不会自行选择另一个账户。');
env.CLOUDFLARE_ACCOUNT_ID = accountId;
if (config.d1_databases[0].database_id.startsWith('00000000-')) {
  if (!bootstrap) throw new Error('请先运行 npm run deploy -- --bootstrap，在自己的账户内初始化独立资源。');
  const statePath = '.cloudflare-deployment.json';
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { account_id: accountId, name: 'interview-cards-' + crypto.randomUUID().slice(0, 8) };
  if (state.account_id !== accountId) throw new Error('已有部署记录属于不同账户，停止以避免连接到错误数据库。');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const credential = capture(['auth', 'token', '--json']);
  if (!credential.token) throw new Error('部署需要 OAuth 或 API Token 认证，不接受全局账户密钥。');
  async function cloud(path, method = 'GET', data) {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + accountId + path, { method, headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json();
    if (!response.ok || !value.success) throw new Error('Cloudflare 资源初始化失败：' + (value.errors?.map(e => e.message).join('；') ?? response.status));
    return value.result;
  }
  const databases = await cloud('/d1/database?name=' + encodeURIComponent(state.name));
  let database = databases.find(db => db.name === state.name);
  if (!database) database = await cloud('/d1/database', 'POST', { name: state.name });
  state.database_id = database.uuid;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  config.name = state.name; config.account_id = accountId;
  config.d1_databases[0].database_name = state.name; config.d1_databases[0].database_id = database.uuid;
  writeFileSync('wrangler.jsonc', JSON.stringify(config, null, 2) + '\n');
}
run(['d1', 'migrations', 'apply', 'DB', '--remote']);
const published = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js','deploy'], {encoding:'utf8',env,windowsHide:true});
process.stdout.write(published.stdout ?? ''); process.stderr.write(published.stderr ?? '');
if(published.status!==0) process.exit(published.status ?? 1);
const siteUrl=published.stdout.match(/https:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.workers\.dev/g)?.find(url=>new URL(url).hostname.startsWith(config.name+'.'));
if(!siteUrl)throw new Error('发布完成但没有返回当前 Worker 的网址，请保留部署输出以便核对。');
writeFileSync('.cloudflare-deployment.json',JSON.stringify({account_id:accountId,name:config.name,database_id:config.d1_databases[0].database_id,site_url:siteUrl},null,2)+'\n');
console.log(bootstrap ? '独立资源已初始化。请按 docs/部署说明.md 配置管理员和 AI 访问入口。' : '发布完成。已有账号使用邮箱和密码登录；首次设置管理员及开放注册见 docs/账号与管理员说明.md。');
