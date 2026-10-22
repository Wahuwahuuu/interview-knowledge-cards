import { startDesktopServer } from './server';
import { join, resolve } from 'node:path';
const options = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
const root = process.cwd(), dataDir = resolve(options.get('data') || join(process.env.APPDATA ?? root, 'InterviewKnowledgeCards'));
void startDesktopServer({ dataDir, assets: resolve(root, 'dist'), migrations: resolve(root, 'migrations'), port: Number(options.get('port') || 47391), tlsPort: Number(options.get('tls-port') || 47392), guidePort: Number(options.get('guide-port') || 47393), lan: !options.has('no-lan'), bootstrap: !options.has('no-bootstrap') }).then(server => {
  console.log('本地服务已启动：' + server.origin);
  // No bootstrap credential or pairing token is emitted into logs.
  if (server.connectionError) console.error(server.connectionError);
  const stop = () => { void server.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
});
