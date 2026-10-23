import { readFileSync, existsSync, openAsBlob } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';

// Publishing credentials belong only to this maintenance process, never to the app.
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('发布需要维护者的 GH_TOKEN；普通客户端检查更新不需要令牌。');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
assert(/^\d+\.\d+\.\d+$/.test(version), '只发布正式版本');
const repo = 'Wahuwahuuu/interview-knowledge-cards', tag = 'v' + version;
const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function request(path, method = 'GET', body) {
  const response = await fetch('https://api.github.com/repos/' + repo + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error('GitHub 发布请求未完成：' + response.status);
  return response.status === 204 ? undefined : response.json();
}
const existing = await request('/releases/tags/' + tag);
if (existing && !existing.draft) { console.log('正式版 ' + tag + ' 已发布，保留原安装包。'); process.exit(0); }
if (process.argv.includes('--check-only')) { console.log('需要发布 ' + tag); process.exit(0); }

const marker = '<!-- interview-cards-auto-release -->';
assert(!existing || existing.body?.includes(marker), '同版本存在人工创建的草稿，请维护者核对后再发布');
const setup = `Interview-Knowledge-Cards-${version}-Setup.exe`, portable = `Interview-Knowledge-Cards-${version}-Portable.exe`;
const names = [setup, setup + '.blockmap', portable, 'latest.yml'];
for (const name of names) assert(existsSync(join('releases', name)), '缺少发布文件：' + name);
const metadata = readFileSync('releases/latest.yml', 'utf8');
assert(metadata.match(/^version:\s*(\S+)\s*$/m)?.[1] === version, '更新清单版本不匹配');
assert(metadata.includes(setup), '更新清单没有指向本版本的安装包');
const hash = createHash('sha512'); for await (const chunk of createReadStream(join('releases', setup))) hash.update(chunk);
const digest = hash.digest('base64'), hashes = [...metadata.matchAll(/sha512:\s*(\S+)/g)].map(match => match[1]);
assert(hashes.length && hashes.every(value => value === digest), '安装包与更新清单校验值不一致');
const sha = process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
assert(/^[a-f0-9]{40}$/.test(sha), '发布必须绑定源码提交');
const body = `${marker}\nWindows 安装版支持自动检查与后台下载，保存编辑后在“设置 → 软件更新”中重启安装。更新前自动备份，保留现有题库、账户和手机配对。\n\n首次使用自动更新，请下载安装 Setup.exe；Portable.exe 可免安装运行。题库内容在本机独立保存，不包含在安装包中。`;
const release = existing || await request('/releases', 'POST', { tag_name: tag, target_commitish: sha, name: '面试知识卡 ' + version, body, draft: true, prerelease: false });
for (const name of names) {
  // Only an unpublished release owned by this workflow may have assets replaced.
  const previous = release.assets?.find(asset => asset.name === name);
  if (previous) await request('/releases/assets/' + previous.id, 'DELETE');
  const content = await openAsBlob(join('releases', name));
  const response = await fetch(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: content, signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error('上传未完成，草稿尚未公开：' + name + ' (' + response.status + ')');
  console.log('已上传：' + name);
}
const complete = await request('/releases/' + release.id);
assert(names.every(name => complete.assets.some(asset => asset.name === name && asset.state === 'uploaded')), '发布资料尚未全部上传');
await request('/releases/' + release.id, 'PATCH', { draft: false, make_latest: 'true' });
console.log('已发布：' + complete.html_url);
