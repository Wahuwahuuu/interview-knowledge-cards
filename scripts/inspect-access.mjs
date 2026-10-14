import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Read deployment authentication in memory. Never write or print credentials.
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const auth = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' },
});
if (auth.status !== 0) throw new Error('请先授权 Cloudflare 部署工具。');
const { token } = JSON.parse(auth.stdout);
if (!token || !config.account_id) throw new Error('缺少已授权账户或部署记录。');
for (const path of ['/access/organizations', '/access/identity_providers', '/access/apps']) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  const result = path.endsWith('organizations')
    ? { auth_domain: body.result?.auth_domain, name: body.result?.name }
    : path.endsWith('identity_providers')
      ? body.result?.map(value => ({ id: value.id, type: value.type }))
      : body.result?.filter(value => value.name?.startsWith('面试知识卡') || value.domain?.startsWith(config.name + '.'))
        .map(value => ({ id: value.id, name: value.name, domain: value.domain, aud: value.aud }));
  console.log(JSON.stringify({ path, status: response.status, success: body.success, result, errors: body.errors?.map(error => ({ code: error.code, message: error.message })) }));
}
