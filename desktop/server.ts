import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import app from '../worker/index';
import { authenticate, sessionCookie, tokenHash, type Env } from '../worker/auth';
import { AppError } from '../shared/model';
import { z } from 'zod';
import { LocalDatabase } from './database';
import { certificates } from './certificates';
import { hash, randomToken, sameSecret, SyncServer } from './sync-server';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
export async function startDesktopServer(options: { dataDir: string; assets: string; migrations: string; port?: number; tlsPort?: number; guidePort?: number; lan?: boolean; bootstrap?: boolean }) {
  mkdirSync(options.dataDir, { recursive: true });
  const db = new LocalDatabase(join(options.dataDir, 'knowledge-cards.sqlite'), options.migrations);
  const today = new Date().toISOString().slice(0, 10), daily = join(options.dataDir, 'backups', `daily-${today}.sqlite`);
  if (!existsSync(daily)) await db.saveBackup(daily);
  const certs = options.lan === false ? undefined : await certificates(join(options.dataDir, 'certificates'));
  const credentialFile = join(options.dataDir, 'agent-credential.json');
  let agentToken: string;
  if (existsSync(credentialFile)) agentToken = JSON.parse(readFileSync(credentialFile, 'utf8')).token;
  else { agentToken = randomToken(); writeFileSync(credentialFile, JSON.stringify({ token: agentToken }), { mode: 0o600 }); }
  const ownerKey = randomToken(), launchToken = randomToken(); let bootstrapUsed = false;
  let origin = '', tlsPort = options.tlsPort ?? 47392, guidePort = options.guidePort ?? 47393;
  const assetsRoot = resolve(options.assets);
  const env: Env = { DB: db.asD1(), APP_ENV: 'desktop', OWNER_EMAIL: String(db.raw.prepare("SELECT email FROM users WHERE id='admin'").get()?.email ?? 'local@knowledge-cards.local'), DESKTOP_AGENT_HASH: hash(agentToken), DESKTOP_OWNER_KEY: ownerKey,
    ASSETS: { fetch: async (request: Request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname), filename = resolve(assetsRoot, '.' + pathname);
      if (!filename.startsWith(assetsRoot + sep) && filename !== assetsRoot) return new Response('Forbidden', { status: 403 });
      let target = filename;
      if (!extname(pathname) || pathname === '/') target = join(assetsRoot, 'index.html');
      if (pathname.includes('/.')) return new Response('Not found', { status: 404 });
      try { return new Response(await readFile(target), { headers: { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Service-Worker-Allowed': '/' } }); }
      catch { return new Response('Not found', { status: 404 }); }
    } } as unknown as Fetcher,
  };
  let connectionError = '';
  const info = () => ({ dataDir: options.dataDir, database: db.filename, fingerprint: certs?.fingerprint, rootName: certs?.rootName, addresses: certs?.addresses ?? [], links: certs?.addresses.map(ip => ({ ip, setup: `http://${ip}:${guidePort}`, app: `https://${ip}:${tlsPort}` })) ?? [], hostname: certs?.names[0], tlsPort, guidePort, backupDir: join(options.dataDir, 'backups'), agentCredential: credentialFile, connectionError });
  const sync = new SyncServer(db, env, '', info);
  let serial = Promise.resolve();
  async function dispatch(request: Request, remoteAddress: string) {
    const url = new URL(request.url), path = url.pathname;
    const hostAllowed = url.origin === origin || certs && (certs.addresses.includes(url.hostname) || certs.names.includes(url.hostname) || url.hostname === '127.0.0.1') && url.protocol === 'https:' && url.port === String(tlsPort);
    if (!hostAllowed) throw new AppError(403, '连接地址不正确');
    if (path === '/desktop-bootstrap') {
      if (options.bootstrap === false || url.origin !== origin || bootstrapUsed || !sameSecret(url.searchParams.get('key') ?? '', launchToken)) throw new AppError(403, '客户端启动凭证已失效');
      bootstrapUsed = true; const token = randomToken(), now = new Date().toISOString();
      db.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(token), 'admin', now, new Date(Date.now() + 30 * 86400000).toISOString());
      return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(request, env, token), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    // Phone devices use the limited sync protocol; account administration and AI stay on loopback.
    if (url.origin !== origin && (path.startsWith('/api/') && !path.startsWith('/api/v1/sync/') && path !== '/api/v1/runtime' || path.startsWith('/bootstrap-admin/'))) throw new AppError(403, '请在电脑客户端管理账户或导入凭证');
    const result = await sync.handle(request, remoteAddress); if (result) return result;
    if (path.startsWith('/bootstrap-admin/')) {
      const identity = await authenticate(request, env); if (identity.user_id !== 'admin' || identity.role !== 'admin') throw new AppError(403, '请在管理员客户端设置密码');
      const headers = new Headers(request.headers); headers.set('x-desktop-owner', ownerKey); request = new Request(request, { headers });
    }
    const isRestore = request.method === 'POST' ? path.match(/^\/api\/v1\/imports\/([^/]+)\/apply$/) : null;
    let restoreUser: string | undefined;
    if (isRestore) {
      const identity = await authenticate(request, env), row = db.raw.prepare('SELECT payload,status FROM user_import_batches WHERE user_id=? AND id=?').get(identity.user_id, decodeURIComponent(isRestore[1]));
      if (row?.status === 'pending' && JSON.parse(String(row.payload)).mode === 'restore') { restoreUser = identity.user_id; await db.saveBackup(join(options.dataDir, 'backups', `before-restore-${Date.now()}.sqlite`)); }
    }
    if (restoreUser) return db.transaction(async () => {
      const response = await app.fetch(request, env);
      if (response.ok) db.raw.prepare('UPDATE sync_state SET epoch=? WHERE user_id=?').run(crypto.randomUUID(), restoreUser!);
      return response;
    });
    return app.fetch(request, env);
  }
  function handler(secure: boolean) {
    return (incoming: IncomingMessage, outgoing: ServerResponse) => {
      const run = async () => {
        try {
          const syncPush = incoming.url?.split('?')[0] === '/api/v1/sync/push';
          if (syncPush) {
            const token = incoming.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
            if (!token || !db.raw.prepare("SELECT d.id FROM sync_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND u.status='active'").get(hash(token))) throw new AppError(401, '设备未配对或已撤销，手机修改仍保留', 'PAIRING_REQUIRED');
          }
          const buffers: Buffer[] = []; let length = 0;
          const maximum = (syncPush ? 64 : 20) * 1024 * 1024;
          for await (const chunk of incoming) { length += chunk.length; if (length > maximum) throw new AppError(413, '单次请求过大，请拆分导入'); buffers.push(chunk); }
          const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          // No trust in caller-supplied privileged headers or proxy IPs.
          headers.delete('x-desktop-owner'); headers.delete('x-local-role'); headers.delete('cf-access-jwt-assertion'); headers.set('cf-connecting-ip', incoming.socket.remoteAddress ?? '');
          const method = incoming.method ?? 'GET', request = new Request(`${secure ? 'https' : 'http'}://${incoming.headers.host}${incoming.url}`, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(buffers) });
          // Slow network uploads must not hold the SQLite operation queue.
          const task = serial.then(() => dispatch(request, incoming.socket.remoteAddress ?? ''));
          serial = task.then(() => undefined, () => undefined);
          const response = await task;
          outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          const status = error instanceof AppError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 500;
          outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          outgoing.end(JSON.stringify({ error: { code: error instanceof AppError ? error.code : 'INVALID_DATA', message: status === 500 ? '本机操作未完成，请查看客户端日志' : error instanceof Error ? error.message : '请求未完成' } }));
          if (status === 500) console.error(error);
        }
      };
      void run();
    };
  }
  const server = createServer({ requestTimeout: 60000, headersTimeout: 10000 }, handler(false));
  await listen(server, options.port ?? 47391, '127.0.0.1');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The sync server now knows the exact loopback origin (including a chosen test port).
  Object.assign(sync, { desktopOrigin: origin });
  let httpsServer: Server | undefined, guideServer: Server | undefined;
  if (certs) {
    try {
      httpsServer = createHttpsServer({ key: certs.key, cert: certs.cert, minVersion: 'TLSv1.2', requestTimeout: 60000, headersTimeout: 10000 }, handler(true));
      await listen(httpsServer, tlsPort, '0.0.0.0'); tlsPort = (httpsServer.address() as { port: number }).port;
      guideServer = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/root.cer') { res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="Interview-Cards-Local.cer"' }); res.end(certs.root); return; }
        const ip = req.headers.host?.split(':')[0];
        if (!ip || !certs.addresses.includes(ip) || req.method !== 'GET' || req.url !== '/') { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接面试知识卡</title><style>body{font:17px/1.8 system-ui;background:#f5f6f0;color:#244737;max-width:640px;margin:40px auto;padding:24px}a{color:#244737}code{overflow-wrap:anywhere;font-size:12px}</style><h1>连接这台电脑</h1><ol><li><a href="/root.cer">下载本机证书</a>。到 iPhone 设置 → 已下载描述文件，安装证书。</li><li>设置 → 通用 → 关于本机 → 证书信任设置，启用对「${certs.rootName}」的完全信任。</li><li>核对下面的证书指纹与电脑设置中一致。</li><li><a href="https://${ip}:${tlsPort}">打开知识卡</a>，在 Safari 分享菜单中选择「添加到主屏幕」。从主屏幕应用打开，再输入电脑显示的配对码。</li></ol><p>只信任你自己的电脑生成的证书。本机私钥不会传到手机。</p><code>${certs.fingerprint}</code></html>`);
      });
      await listen(guideServer, guidePort, '0.0.0.0'); guidePort = (guideServer.address() as { port: number }).port;
    } catch (error) { connectionError = '手机连接服务未启动：' + (error instanceof Error ? error.message : String(error)); httpsServer?.close(); guideServer?.close(); }
  }
  writeFileSync(join(options.dataDir, 'connection.json'), JSON.stringify({ origin, ...info(), connectionError }, null, 2));
  return { db, origin, bootstrapUrl: `${origin}/desktop-bootstrap?key=${launchToken}`, info, sync, connectionError, async close() { await serial; await Promise.all([server, httpsServer, guideServer].filter(Boolean).map(item => new Promise<void>(resolve => item!.close(() => resolve())))); db.close(); } };
}
function listen(server: Server, port: number, host: string) { return new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); }); }
