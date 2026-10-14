import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readAgentCredential, saveAgentCredential } from './private-credential.mjs';
import { useSystemProxy } from './system-proxy.mjs';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if(process.platform!=='win32')throw new Error('自动配置与加密凭证保存仅支持 Windows；其他系统请按 docs/deployment.md 手动配置 Access。');
useSystemProxy(new URL('https://api.cloudflare.com'));
const team = process.argv[2] || config.vars.ACCESS_TEAM_DOMAIN;
if (!/^[a-zA-Z0-9-]+\.cloudflareaccess\.com$/.test(team ?? '')) throw new Error('请提供账户本人确认的完整团队域名。');
if (!config.account_id || config.vars.APP_ENV !== 'production' || config.d1_databases[0].database_id.startsWith('00000000-')) throw new Error('请先完成独立资源部署。');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
function capture(args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('部署授权读取失败，请先完成账户授权。');
  return JSON.parse(result.stdout);
}
const identity = capture(['whoami', '--json']);
if (!identity.accounts?.some(account => account.id === config.account_id)) throw new Error('当前授权不属于题库部署账户。');
const auth = capture(['auth', 'token', '--json']);
const apiToken = process.env.CLOUDFLARE_ACCESS_SETUP_TOKEN || auth.token;
const deployment = JSON.parse(readFileSync('.cloudflare-deployment.json', 'utf8'));
const statePath = '.cloudflare-access.json';
const existingState = existsSync(statePath) ? JSON.parse(readFileSync(statePath,'utf8')) : null;
const siteUrl = deployment.site_url ?? existingState?.site_url;
if(!siteUrl)throw new Error('部署记录尚未包含网址，请先运行 npm run deploy -- --bootstrap。');
const url = new URL(siteUrl), hostname = url.hostname, site = url.origin;
if(url.protocol!=='https:'||!hostname.startsWith(config.name+'.')||!hostname.endsWith('.workers.dev')||url.username||url.password)throw new Error('部署网址与当前 Worker 不一致。');
if (deployment.account_id !== config.account_id || deployment.name !== config.name) throw new Error('独立资源记录不匹配，停止配置。');
const state = existingState ?? { account_id: config.account_id, team_domain: team, site_url: site };
if (state.account_id !== config.account_id || state.site_url !== site || state.team_domain !== team) throw new Error('已有 Access 记录不属于这次部署，停止配置。');
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
async function cloud(path, method = 'GET', data) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/access${path}`, {
    method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Access 配置未完成（${response.status}）：${body.errors?.map(error => error.message).join('；') || '请求失败'}`);
  return body.result;
}
const providers = await cloud('/identity_providers');
let otp = providers.find(provider => provider.type === 'onetimepin');
if (!otp) otp = await cloud('/identity_providers', 'POST', { name: '面试知识卡邮箱验证码', type: 'onetimepin', config: {} });
state.otp_id = otp.id; persist();

async function ensureApp(name, domain, options = {}) {
  const apps = await cloud('/apps');
  let app = apps.find(value => value.domain === domain);
  if (app && app.name !== name) throw new Error('该网址已由其他 Access 应用保护，请先核对；不会替换其他应用。');
  if (!app) app = await cloud('/apps', 'POST', { name, type: 'self_hosted', domain, session_duration: '720h', ...options });
  return app;
}
async function ensurePolicy(app, name, decision, include) {
  const policies = await cloud(`/apps/${app.id}/policies`);
  if (policies.some(policy => policy.name !== name)) throw new Error('题库应用存在未识别的访问策略，停止以便核对。');
  const current = policies.find(policy => policy.name === name);
  const desired = { name, decision, include, exclude: [], require: [], precedence: 1 };
  return cloud(`/apps/${app.id}/policies${current ? '/' + current.id : ''}`, current ? 'PUT' : 'POST', desired);
}
const ownerDomain = state.auth_mode === 'password' ? `${hostname}/bootstrap-admin/*` : hostname;
const ownerApp = await ensureApp(`面试知识卡 ${config.name}`, ownerDomain, { allowed_idps: [otp.id], auto_redirect_to_identity: true });
state.owner_app_id = ownerApp.id; state.owner_aud = ownerApp.aud; persist();
await ensurePolicy(ownerApp, '仅本人邮箱', 'allow', [{ email: { email: config.vars.OWNER_EMAIL } }]);
console.log('邮箱应用已配置：只允许 ' + config.vars.OWNER_EMAIL);

let credential = await readAgentCredential();
if (credential && credential.site_url !== site) throw new Error('已保存的机器凭证属于不同题库。');
if (!credential) {
  const name = `面试知识卡 AI 草稿 ${config.name}`;
  const tokens = await cloud('/service_tokens');
  if (tokens.some(token => token.name === name)) throw new Error('已有同名机器凭证但本机未保存密钥，请由账户本人恢复凭证后再继续，不会重复创建。');
  const service = await cloud('/service_tokens', 'POST', { name, duration: '8760h' });
  if (!service.client_id || !service.client_secret || !service.id) throw new Error('机器凭证创建结果不完整。');
  credential = { site_url: site, token_id: service.id, client_id: service.client_id, client_secret: service.client_secret, expires_at: service.expires_at };
  await saveAgentCredential(credential);
}
const agentApp = await ensureApp(`面试知识卡 AI ${config.name}`, `${hostname}/api/v1/agent/*`);
state.agent_app_id = agentApp.id; state.agent_aud = agentApp.aud; state.agent_token_id = credential.token_id; persist();
await ensurePolicy(agentApp, 'AI 仅查询及提交草稿', 'non_identity', [{ service_token: { token_id: credential.token_id } }]);
config.vars.ACCESS_TEAM_DOMAIN = team;
config.vars.ACCESS_AUD = ownerApp.aud;
config.vars.AGENT_ACCESS_AUD = agentApp.aud;
writeFileSync('wrangler.jsonc', JSON.stringify(config, null, 2) + '\n');
console.log('机器应用已配置，凭证使用本 Windows 用户加密保存，不输出密钥。');
console.log('登录设置已写入配置；请运行 npm run deploy。');
