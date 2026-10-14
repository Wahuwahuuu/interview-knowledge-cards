import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('dist/index.html')) { console.error('首次使用请先运行 npm run build 和 npm run db:local'); process.exit(1); }
const children = [
  spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.local.jsonc', '--local', '--ip', '127.0.0.1', '--port', '8787'], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
function stop() { for (const child of children) child.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const child of children) child.on('exit', code => { if (code) { stop(); process.exit(code); } });
