import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const origin = 'http://127.0.0.1:8788', reports = [], stamp = crypto.randomUUID();
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
const migration = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.test.jsonc'], { encoding: 'utf8', env, windowsHide: true });
if (migration.status !== 0) throw new Error('测试数据库初始化失败：' + migration.stderr);
const server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.test.jsonc', '--local', '--port', '8788', '--ip', '127.0.0.1'], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
let logs = ''; server.stdout.on('data', value => { logs = (logs + value).slice(-8000); }); server.stderr.on('data', value => { logs = (logs + value).slice(-8000); });
async function request(path, method = 'GET', body, agent = false) {
  const response = await fetch(origin + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(agent ? { 'x-local-role': 'agent' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); return { status: response.status, value };
}
async function ok(path, method = 'GET', body, agent = false) { const result = await request(path, method, body, agent); assert.equal(result.status, 200, `${path}：${result.value.error?.message ?? result.status}`); return result.value; }
const library = () => ok('/library');
async function apply(envelope) { const batch = await ok('/imports/preview', 'POST', envelope); return (await ok('/imports/' + batch.id + '/apply', 'POST', { expected_revision: batch.base_revision })).library; }
const report = name => { reports.push(name); console.log('通过：' + name); };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (i === 99) throw new Error('测试服务未就绪：' + logs); await new Promise(resolve => setTimeout(resolve, 200)); }
  await apply({ schema_version: 1, mode: 'restore', batch_id: 'reset-' + stamp });
  const seed = JSON.parse(await readFile('examples/demo-import.json', 'utf8')); seed.batch_id = 'test-seed-' + stamp;
  const staged = await ok('/agent/imports/preview', 'POST', seed, true);
  assert.equal((await library()).cards.length, 0); report('AI 提交草稿不改变正式题库');
  assert.equal((await request('/imports/' + staged.id + '/apply', 'POST', { expected_revision: staged.base_revision }, true)).status, 403);
  assert.equal((await request('/agent/imports/' + staged.id + '/apply', 'POST', { expected_revision: staged.base_revision }, true)).status, 403); report('机器身份不能通过任一路径确认导入');
  const applied = await ok('/imports/' + staged.id + '/apply', 'POST', { expected_revision: staged.base_revision });
  let state = applied.library; assert.equal(state.cards.length, 2); assert.equal(state.projects.length, 1); assert.equal(state.relations.length, 1);
  for (const occurrence of seed.occurrences) assert.equal(state.occurrences.find(v => v.id === occurrence.id).original_answer_md, occurrence.original_answer_md);
  assert.ok(state.cards[0].answer_md.includes('单进程') || state.cards[1].answer_md.includes('单进程')); assert.equal(state.sources[0].company, ''); report('两题完整原文、关键限制及问答整理来源正确入库');
  const repeated = await ok('/imports/' + staged.id + '/apply', 'POST', { expected_revision: 0 }); assert.equal(repeated.library.revision, state.revision);
  const again = await ok('/agent/imports/preview', 'POST', seed, true); assert.equal(again.status, 'applied'); assert.equal((await library()).cards.length, 2); report('重复预览和确认保持幂等');
  assert.equal((await request('/imports/preview', 'POST', { ...seed, cards: [{ ...seed.cards[0], project_id: 'missing' }], batch_id: 'bad-ref-' + stamp })).status, 422); report('非法引用整批拒绝');
  assert.equal((await request('/imports/preview', 'POST', { schema_version: 1, sources: [{ ...state.sources[0], original_markdown: '覆盖' }] })).status, 422); report('原始来源不能被普通导入覆盖');
  let card = state.cards.find(c => c.id === 'demo-performance'); const beforeEdit = state.revision;
  state = await ok('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...card, summary_md: '测试中的新提纲' } });
  assert.equal(state.cards.find(c => c.id === card.id).revision, 2); assert.equal(state.occurrences.find(o => o.card_id === card.id).original_answer_md, seed.occurrences[0].original_answer_md);
  assert.equal((await request('/cards/' + card.id, 'PUT', { expected_revision: beforeEdit, value: card })).status, 409); report('编辑保留历史，过期提交不会覆盖新答案');
  card = state.cards.find(c => c.id === card.id);
  const attempts = await Promise.all(['A', 'B'].map(tag => request('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...card, summary_md: '并发提交 ' + tag } })));
  assert.deepEqual(attempts.map(v => v.status).sort(), [200, 409]); state = await library(); assert.equal(state.revisions.filter(v => v.card_id === card.id).length, 3); report('真实 D1 并发事务只接受一份修改，失败事务不留下历史');
  card = state.cards.find(c => c.id === card.id);
  const pending = await ok('/agent/imports/preview', 'POST', { schema_version: 1, batch_id: 'stale-' + stamp, cards: [{ ...card, summary_md: '待确认的 AI 提纲' }] }, true);
  state = await ok('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...card, summary_md: '人工后续修改' } });
  const beforeStaleApply = await library();
  assert.ok(pending.base_revision < beforeStaleApply.revision);
  const staleConfirmation = await request('/imports/' + pending.id + '/apply', 'POST', { expected_revision: pending.base_revision });
  assert.equal(staleConfirmation.status, 409); assert.equal(staleConfirmation.value.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(await library(), beforeStaleApply);
  const rejectedBatch = await ok('/imports/' + pending.id); assert.equal(rejectedBatch.status, 'pending'); assert.equal(rejectedBatch.applied_at, null);
  report('旧草稿确认被明确拒绝，正式题库和待确认状态保持不变');
  assert.equal((await request('/imports/' + pending.id + '/apply', 'POST', { expected_revision: state.revision })).status, 409);
  assert.equal((await library()).cards.find(c => c.id === card.id).summary_md, '人工后续修改');
  const fresh = await ok('/imports/' + pending.id + '/repreview', 'POST', {}); assert.equal(fresh.base_revision, state.revision); assert.equal(fresh.status, 'pending');
  assert.deepEqual(await library(), beforeStaleApply); report('预览过期后必须重新核对差异，重新预览不会自动写入');
  const confirmedFresh = await ok('/imports/' + fresh.id + '/apply', 'POST', { expected_revision: fresh.base_revision });
  assert.equal(confirmedFresh.batch.status, 'applied'); assert.equal(confirmedFresh.already_applied, false);
  state = await library(); assert.deepEqual(state.cards, confirmedFresh.library.cards); assert.equal(state.revision, confirmedFresh.library.revision);
  assert.equal(state.revision, beforeStaleApply.revision + 1); assert.equal(state.cards.length, beforeStaleApply.cards.length);
  assert.equal(state.cards.find(c => c.id === card.id).summary_md, '待确认的 AI 提纲');
  assert.equal(state.revisions.length, beforeStaleApply.revisions.length + 1);
  const confirmedBatch = await ok('/imports/' + fresh.id); assert.equal(confirmedBatch.status, 'applied'); assert.ok(confirmedBatch.applied_at);
  report('人工重新确认后，独立读取题库及批次都证明导入已持久保存');
  state = await ok('/changes', 'POST', { expected_revision: state.revision, changes: { schema_version: 1, sources: [{ id: 'test-source-' + stamp, name: '测试面试来源', kind: 'real', date: '2026-10-14', company: '测试公司', job: '后端', round: '一面' }], occurrences: [{ id: 'test-occurrence-' + stamp, card_id: card.id, source_id: 'test-source-' + stamp, asked_question: '测试问法', original_answer_md: '测试回答' }] } });
  assert.equal(state.occurrences.filter(v => v.card_id === card.id).length, 2); report('同一道题可以关联多场面试，来源与出现记录原子保存');
  card = state.cards.find(c => c.id === card.id);
  state = await ok('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...card, important: true } });
  state = await library(); const markedCard = state.cards.find(c => c.id === card.id);
  assert.equal(markedCard.important, true); assert.equal(markedCard.favorite, card.favorite); assert.equal(markedCard.answer_md, card.answer_md); report('重点属性保存后独立读取仍保持，收藏与正文不被改动');
  const restored = await ok('/cards/' + card.id + '/restore', 'POST', { expected_revision: state.revision, card_revision: 1 });
  assert.equal(restored.cards.find(c => c.id === card.id).important, true);
  assert.equal(restored.cards.find(c => c.id === card.id).summary_md, seed.cards[0].summary_md); state = restored; report('历史答案恢复为新版本');
  state = await ok('/changes', 'POST', { expected_revision: state.revision, changes: { schema_version: 1, projects: [{ id: 'test-project-' + stamp, name: '独立测试项目' }], cards: [{ ...seed.cards[0], id: 'test-card-' + stamp, project_id: 'test-project-' + stamp }] } });
  assert.equal(state.cards.length, 3); const graph = await ok('/graph?project_id=demo-backend'); assert.ok(!graph.elements.some(v => v.data.id === 'c:test-card-' + stamp));
  const priorityLegacy = state.cards.find(c => c.id === 'test-card-' + stamp);
  const legacyValue = { ...priorityLegacy, title: '03. ⭐ 使用 `EXPLAIN`' }; delete legacyValue.important;
  state = await ok('/cards/' + priorityLegacy.id, 'PUT', { expected_revision: state.revision, value: legacyValue });
  state = await library(); const prioritySaved = state.cards.find(c => c.id === priorityLegacy.id);
  assert.equal(prioritySaved.title, '03. 使用 `EXPLAIN`'); assert.equal(prioritySaved.important, true);
  state = await ok('/cards/' + prioritySaved.id, 'PUT', { expected_revision: state.revision, value: { ...prioritySaved, important: false } });
  assert.equal((await library()).cards.find(c => c.id === prioritySaved.id).important, false); report('旧星号标题转换为重点且可取消，重读后不会恢复星号或重点');
  const snapshot = await ok('/projects/demo-backend/snapshot'); assert.equal(snapshot.snapshot.cards.length, 2); report('同名问题不合并，图谱和离线快照按项目隔离');
  const backup = await ok('/export'); const savedCard = backup.cards.find(c => c.id === card.id);
  state = await ok('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...savedCard, answer_md: '备份后修改' } });
  state = await apply({ ...backup, batch_id: 'restore-' + stamp });
  assert.deepEqual(state.cards, backup.cards); assert.deepEqual(state.revisions, backup.revisions); assert.deepEqual(state.sources, backup.sources); assert.deepEqual(state.occurrences, backup.occurrences); assert.deepEqual(state.relations, backup.relations); report('完整 JSON 往返恢复内容、原文、关系与历史');
  const markdown = await fetch(origin + '/api/v1/export?format=markdown'); assert.equal(markdown.status, 200); assert.ok((await markdown.text()).includes('演示内容')); report('Markdown 阅读版保留关键限制');
  assert.equal((await request('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: savedCard }, true)).status, 403); report('机器凭证不能直接编辑正式卡片');
  const staticFiles = await readdir('dist/assets'); let staticText = await readFile('dist/index.html', 'utf8'); for (const name of staticFiles) if (name.endsWith('.js')) staticText += await readFile(join('dist/assets', name), 'utf8');
  assert.ok(!staticText.includes(seed.occurrences[0].original_answer_md.slice(0, 55))); assert.ok(!staticText.includes('admin@example.com')); report('公开构建资源不包含私有问答或账户邮箱');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/api-verification.json', JSON.stringify({ passed: true, at: new Date().toISOString(), database: 'interview-cards-tests', scenarios: reports }, null, 2));
  console.log('实际数据库验证完成：' + reports.length + ' 项全部通过。');
} finally {
  if (server.pid) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else server.kill('SIGTERM'); }
}
