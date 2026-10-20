import { readdir, readFile, writeFile, unlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

// 小尺寸应用图标由固定几何图形生成，不需要远程图片或字体。
function crc(buffer) { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(name, bytes) { const type = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, sum]); }
function icon(size) {
  const data = Buffer.alloc((size * 4 + 1) * size);
  const rounded = (x, y, a, b, w, h, r) => { const dx = Math.max(a + r - x, 0, x - (a + w - r)), dy = Math.max(b + r - y, 0, y - (b + h - r)); return x >= a && x <= a + w && y >= b && y <= b + h && dx * dx + dy * dy <= r * r; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * 192, v = y / size * 192;
    let color = [36, 71, 55];
    if (rounded(u, v, 59, 46, 80, 108, 12)) color = [229, 184, 90];
    if (rounded(u, v, 44, 39, 80, 108, 12)) color = [245, 246, 238];
    if ([76, 94, 112].some((line, i) => rounded(u, v, 64, line - 3, 40 - i * 8, 6, 3))) color = [36, 71, 55];
    const offset = y * (size * 4 + 1) + 1 + x * 4; data.set([...color, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
await Promise.all([writeFile('dist/icon-192.png', icon(192)), writeFile('dist/icon-512.png', icon(512)), writeFile('dist/apple-touch-icon.png', icon(180))]);
async function files(dir, prefix = '') { const entries = await readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]))).flat(); }
// Only include the current build. Windows can leave old hashed files behind.
const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'));
const currentAssets = new Set(Object.values(manifest).flatMap(entry => [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]));
// Vite's public manifest omits unnamed assets such as module workers.
// The build plugin records every file emitted by this build, including workers.
for (const path of JSON.parse(await readFile('dist/.vite/build-assets.json', 'utf8'))) currentAssets.add(path);
const distDirectory = resolve('dist');
if (await realpath(distDirectory) !== distDirectory) throw new Error('构建目录不能是指向其他位置的链接');
for (const path of await files('dist/assets', 'assets/')) {
  if (currentAssets.has(path)) continue;
  const target = resolve(distDirectory, path);
  if (!target.startsWith(distDirectory + sep)) throw new Error('构建资源路径越界');
  await unlink(target);
}
const paths = (await files('dist')).filter(p => p !== 'sw.js' && !p.startsWith('.vite/'));
const digest = createHash('sha256'); for (const path of paths.sort()) digest.update(await readFile(join('dist', path)));
const version = digest.digest('hex').slice(0, 12);
const assets = [...new Set(['/', ...paths.filter(p => p !== 'index.html').map(p => '/' + p)])];
const worker = `const CACHE='interview-cards-shell-${version}';
const ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE);for(const path of ASSETS){const response=await fetch(path,{credentials:'same-origin',redirect:'error',cache:'reload'});if(!response.ok||response.redirected)throw new Error('Shell authentication required');await cache.put(path,response);}await self.skipWaiting();})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('interview-cards-shell-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})());});
self.addEventListener('message',event=>{if(event.data?.type==='CLEAR_PRIVATE_CACHE')event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('interview-cards-'))await caches.delete(name);})());});
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/bootstrap-admin/')||url.pathname.startsWith('/cdn-cgi/'))return;event.respondWith((async()=>{const cache=await caches.open(CACHE);if(request.mode==='navigate'){try{return await fetch(request);}catch{return (await cache.match('/'))||new Response('请联网打开一次题库并下载项目后再离线复习。',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}}return (await cache.match(request))||fetch(request);})());});
`;
await writeFile('dist/sw.js', worker);
console.log('离线页面资源已生成：' + assets.length + ' 个，版本 ' + version);
