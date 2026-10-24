import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDirectImport } from './verify-direct-import.mjs';
import { verifyProjectOrder } from './verify-project-order.mjs';
import { verifyCardEdit } from './verify-card-edit.mjs';
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
// Full-history assertions use the backup endpoint; the daily library is intentionally light.
const library = async () => { const { mode, exported_at, ...value } = await ok('/export'); return value; };
async function apply(envelope) { const batch = await ok('/imports/preview', 'POST', envelope); await ok('/imports/' + batch.id + '/apply', 'POST', { expected_revision: batch.base_revision }); return library(); }
const report = name => { reports.push(name); console.log('通过：' + name); };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} if (i === 99) throw new Error('测试服务未就绪：' + logs); await new Promise(resolve => setTimeout(resolve, 200)); }
  await apply({ schema_version: 1, mode: 'restore', batch_id: 'reset-' + stamp });
  const seed = JSON.parse(await readFile('examples/demo-import.json', 'utf8')); seed.batch_id = 'test-seed-' + stamp;
  const staged = await ok('/agent/imports/preview', 'POST', seed, true);
  assert.equal(staged.status, 'applied'); assert.equal((await library()).cards.length, 2); report('AI 兼容提交入口直接导入，记录和独立读取均确认已保存');
  assert.deepEqual((await ok('/library')).revisions, []); report('日常读取不加载历史答案，完整备份仍保留历史');
  assert.equal((await request('/imports/' + staged.id + '/apply', 'POST', { expected_revision: staged.base_revision }, true)).status, 403);
  assert.equal((await request('/agent/imports/' + staged.id + '/apply', 'POST', { expected_revision: staged.base_revision }, true)).status, 403); report('机器身份仍不能调用人工确认和管理接口');
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
  const pending = await ok('/imports/preview', 'POST', { schema_version: 1, batch_id: 'stale-' + stamp, cards: [{ ...card, summary_md: '兼容旧草稿的提纲' }] });
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
  assert.equal(state.cards.find(c => c.id === card.id).summary_md, '兼容旧草稿的提纲');
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
  await verifyProjectOrder({ request, ok, library, report }); state = await library();
  const backup = await ok('/export'); const savedCard = backup.cards.find(c => c.id === card.id);
  state = await ok('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: { ...savedCard, answer_md: '备份后修改' } });
  state = await apply({ ...backup, batch_id: 'restore-' + stamp });
  assert.deepEqual(state.cards, backup.cards); assert.deepEqual(state.revisions, backup.revisions); assert.deepEqual(state.sources, backup.sources); assert.deepEqual(state.occurrences, backup.occurrences); assert.deepEqual(state.relations, backup.relations); report('完整 JSON 往返恢复内容、原文、关系与历史');
  const markdown = await fetch(origin + '/api/v1/export?format=markdown'); assert.equal(markdown.status, 200); assert.ok((await markdown.text()).includes('演示内容')); report('Markdown 阅读版保留关键限制');
  assert.equal((await request('/cards/' + card.id, 'PUT', { expected_revision: state.revision, value: savedCard }, true)).status, 403); report('机器凭证不能直接编辑正式卡片');
  const beforeState = await library(), stateCard = beforeState.cards.find(value => value.id === card.id);
  const stateInput = { expected_revision: beforeState.revision, card_revision: stateCard.revision, patch: { mastery: 'mastered', favorite: !stateCard.favorite } };
  const stateResult = await ok('/cards/' + card.id + '/state', 'PATCH', stateInput);
  assert.deepEqual(Object.keys(stateResult).sort(), ['card', 'revision']); assert.ok(Buffer.byteLength(JSON.stringify(stateResult)) < 500);
  assert.ok(!JSON.stringify(stateResult).includes('answer_md')); state = await library();
  assert.equal(state.revision, beforeState.revision + 1);
  const expectedStateCard = { ...stateCard, ...stateInput.patch, updated_at: stateResult.card.updated_at };
  assert.deepEqual(state.cards.find(value => value.id === card.id), expectedStateCard);
  for (const kind of ['projects', 'topics', 'sources', 'occurrences', 'relations', 'revisions']) assert.deepEqual(state[kind], beforeState[kind]);
  assert.deepEqual(state.cards.filter(value => value.id !== card.id), beforeState.cards.filter(value => value.id !== card.id));
  report('小型状态接口仅更新当前卡片标记，响应小于500字节，答案版本、历史与其他资料保留');
  const currentStateInput = { ...stateInput, expected_revision: state.revision };
  assert.equal((await ok('/cards/' + card.id + '/state', 'PATCH', currentStateInput)).revision, state.revision);
  assert.deepEqual(await library(), state); report('重复标记幂等，不增加题库或答案版本');
  for (const patch of [{}, { answer_md: '禁止覆盖' }, { mastery: 'invalid' }, { favorite: 'yes' }]) assert.equal((await request('/cards/' + card.id + '/state', 'PATCH', { ...currentStateInput, patch })).status, 422);
  assert.equal((await request('/cards/' + card.id + '/state', 'PATCH', { ...currentStateInput, user_id: 'someone-else' })).status, 422);
  assert.equal((await request('/cards/' + card.id + '/state', 'PATCH', { ...currentStateInput, expected_revision: state.revision - 1 })).status, 409);
  assert.equal((await request('/cards/' + card.id + '/state', 'PATCH', { ...currentStateInput, card_revision: stateCard.revision + 1 })).status, 409);
  assert.equal((await request('/cards/missing/state', 'PATCH', currentStateInput)).status, 404);
  assert.equal((await request('/cards/' + card.id + '/state', 'PATCH', currentStateInput, true)).status, 403);
  assert.deepEqual(await library(), state); report('状态接口拒绝越权字段、正文、过期版本、不存在的题目和机器写入');
  const stateRace = await Promise.all([true, false].map(important => request('/cards/' + card.id + '/state', 'PATCH', { ...currentStateInput, patch: { mastery: 'review', important } })));
  assert.deepEqual(stateRace.map(value => value.status).sort(), [200, 409]);
  const stateWinner = stateRace.find(value => value.status === 200).value; state = await library();
  assert.equal(state.revision, stateWinner.revision); assert.equal(state.cards.find(value => value.id === card.id).important, stateWinner.card.important);
  assert.deepEqual(state.revisions, beforeState.revisions); report('并发状态修改只有一项原子成功，另一个冲突不覆盖或留下部分写入');
  const beforeCancel = await library(), cancelInput = { schema_version: 1, batch_id: 'cancel-test-' + stamp, cards: [{ ...beforeCancel.cards[0], summary_md: '取消后不应出现的提纲' }] };
  const cancelDraft = await ok('/imports/preview', 'POST', cancelInput);
  assert.equal((await request('/imports/' + cancelDraft.id + '/cancel', 'POST', {}, true)).status, 403);
  assert.equal((await ok('/imports/' + cancelDraft.id + '/cancel', 'POST', {})).status, 'cancelled');
  assert.equal((await ok('/imports/' + cancelDraft.id)).status, 'cancelled');
  assert.equal((await ok('/imports/' + cancelDraft.id + '/cancel', 'POST', {})).status, 'cancelled');
  assert.deepEqual(await library(), beforeCancel); report('取消草稿持久保存并保留记录，重复取消幂等，正式题库及版本保持原样');
  assert.equal((await request('/imports/' + cancelDraft.id + '/apply', 'POST', { expected_revision: cancelDraft.base_revision })).status, 409);
  assert.equal((await request('/imports/' + cancelDraft.id + '/repreview', 'POST', {})).status, 409);
  assert.equal((await request('/imports/preview', 'POST', cancelInput)).status, 409);
  assert.equal((await request('/imports/missing-batch/cancel', 'POST', {})).status, 404);
  assert.deepEqual(await library(), beforeCancel); report('已取消草稿无法重新预览、复用或确认，机器和不存在的取消请求被拒绝');
  const restoreDraft = await ok('/imports/preview', 'POST', { schema_version: 1, mode: 'restore', batch_id: 'cancel-restore-' + stamp });
  assert.equal((await ok('/imports/' + restoreDraft.id + '/cancel', 'POST', {})).status, 'cancelled');
  assert.deepEqual(await library(), beforeCancel); report('恢复草稿也可取消，原题库、原文及历史不被移除');
  for (let raceIndex = 0; raceIndex < 4; raceIndex++) {
    const base = await library(), marker = '取消确认竞争-' + raceIndex;
    const proposal = await ok('/imports/preview', 'POST', { schema_version: 1, batch_id: 'cancel-race-' + stamp + '-' + raceIndex, cards: [{ ...base.cards[0], summary_md: marker }] });
    const [confirmation, cancellation] = await Promise.all([request('/imports/' + proposal.id + '/apply', 'POST', { expected_revision: proposal.base_revision }), request('/imports/' + proposal.id + '/cancel', 'POST', {})]);
    assert.equal(cancellation.status, 200);
    const latest = await ok('/imports/' + proposal.id), saved = await library();
    if (latest.status === 'cancelled') { assert.equal(confirmation.status, 409); assert.deepEqual(saved, base); }
    else { assert.equal(latest.status, 'applied'); assert.equal(confirmation.status, 200); assert.equal(cancellation.value.status, 'applied'); assert.equal(saved.revision, base.revision + 1); assert.equal(saved.cards.find(value => value.id === base.cards[0].id).summary_md, marker); }
  }
  state = await library(); report('取消与确认并发只有一个终态，取消成功的批次绝不写入题库');
  const completed = await ok('/imports/' + staged.id + '/cancel', 'POST', {}); assert.equal(completed.status, 'applied'); assert.deepEqual(await library(), state);
  report('已应用批次如实返回已应用，取消不会撤回已入库内容');
  const beforeDelete = await library(), beforeDeleteBackup = await ok('/export');
  assert.equal((await request('/cards/' + card.id, 'DELETE', { expected_revision: beforeDelete.revision - 1 })).status, 409);
  assert.equal((await request('/cards/' + card.id, 'DELETE', { expected_revision: beforeDelete.revision }, true)).status, 403);
  assert.equal((await request('/cards/missing-card', 'DELETE', { expected_revision: beforeDelete.revision })).status, 404);
  assert.deepEqual(await library(), beforeDelete); report('删除仍受并发保护和机器权限限制，拒绝请求不改变题库');
  await ok('/cards/' + card.id, 'DELETE', { expected_revision: beforeDelete.revision });
  state = await library(); const afterDeleteExport = await ok('/export');
  const { mode: exportMode, exported_at: exportTime, ...afterDeleteLibrary } = afterDeleteExport;
  assert.equal(exportMode, 'restore'); assert.ok(exportTime);
  assert.equal(state.revision, beforeDelete.revision + 1); assert.deepEqual(afterDeleteLibrary, state);
  assert.deepEqual(state.cards, beforeDelete.cards.filter(c => c.id !== card.id));
  assert.deepEqual(state.occurrences, beforeDelete.occurrences.filter(o => o.card_id !== card.id));
  assert.deepEqual(state.relations, beforeDelete.relations.filter(r => r.from_card_id !== card.id && r.to_card_id !== card.id));
  assert.deepEqual(state.revisions, beforeDelete.revisions.filter(r => r.card_id !== card.id));
  assert.deepEqual(state.sources, beforeDelete.sources); assert.deepEqual(state.projects, beforeDelete.projects); assert.deepEqual(state.topics, beforeDelete.topics);
  assert.deepEqual(await ok('/cards/' + card.id + '/history'), []); report('删除后独立读取与备份均无该卡及自身关联，其他卡片和来源完整');
  assert.equal((await request('/cards/' + card.id, 'DELETE', { expected_revision: state.revision })).status, 404);
  assert.deepEqual(await library(), state); report('重复删除明确返回不存在且题库不变');
  const afterDeleteGraph = await ok('/graph'), afterDeleteSnapshot = await ok('/projects/' + card.project_id + '/snapshot');
  assert.ok(!afterDeleteGraph.elements.some(element => element.data.id === 'c:' + card.id));
  assert.ok(!afterDeleteSnapshot.snapshot.cards.some(c => c.id === card.id)); report('删除后的图谱和离线项目快照不再包含该题');
  state = await apply({ ...beforeDeleteBackup, batch_id: 'recover-deleted-' + stamp });
  for (const kind of ['cards', 'sources', 'occurrences', 'relations', 'revisions']) assert.deepEqual(state[kind], beforeDelete[kind]);
  report('已有完整备份能够恢复已删除卡片及原有关系');
  const promotionBackup = await ok('/export'), promotionIds = ['root', 'first', 'second'].map(name => 'promotion-' + name + '-' + stamp);
  state = await apply({ schema_version: 1, batch_id: 'promotion-' + stamp,
    cards: promotionIds.map(id => ({ id, project_id: card.project_id, title: id, question: id })),
    relations: [
      { id: 'promotion-second-' + stamp, from_card_id: promotionIds[0], to_card_id: promotionIds[2], kind: 'followup', order: 2 },
      { id: 'promotion-first-' + stamp, from_card_id: promotionIds[0], to_card_id: promotionIds[1], kind: 'followup', order: 1 },
    ],
  });
  const beforePromotion = await library();
  await ok('/cards/' + promotionIds[0], 'DELETE', { expected_revision: beforePromotion.revision });
  state = await library();
  assert.deepEqual(state.cards, beforePromotion.cards.filter(value => value.id !== promotionIds[0]));
  assert.ok(!state.relations.some(relation => relation.from_card_id === promotionIds[0] || relation.to_card_id === promotionIds[0]));
  assert.ok(!state.relations.some(relation => relation.kind === 'followup' && relation.to_card_id === promotionIds[1]));
  assert.equal(state.relations.find(relation => relation.id === 'promotion-second-' + stamp).from_card_id, promotionIds[1]);
  assert.equal(state.relations.find(relation => relation.id === 'promotion-second-' + stamp).revision, 2);
  report('删除主问题后第一条追问提升，其余追问关联持久保存，答案和状态不变');
  state = await apply({ ...promotionBackup, batch_id: 'recover-promotion-' + stamp });
  const projectId = 'test-project-' + stamp;
  state = await ok('/changes', 'POST', { expected_revision: state.revision, changes: {
    schema_version: 1,
    cards: [{ id: 'archived-' + stamp, project_id: projectId, title: '归档题', question: '归档问题', archived: true, topic_ids: state.topics.slice(0, 1).map(topic => topic.id) }],
    occurrences: [{ id: 'project-occurrence-' + stamp, card_id: 'test-card-' + stamp, source_id: state.sources[0].id, asked_question: '项目内原始问题' }],
    relations: [{ id: 'cross-project-' + stamp, from_card_id: card.id, to_card_id: 'test-card-' + stamp, kind: 'related' }, { id: 'archived-link-' + stamp, from_card_id: 'archived-' + stamp, to_card_id: card.id, kind: 'followup' }],
  } });
  const beforeProjectDelete = await library(), projectBackup = await ok('/export');
  assert.equal((await request('/projects/' + projectId, 'DELETE', { expected_revision: state.revision - 1 })).status, 409);
  assert.equal((await request('/projects/' + projectId, 'DELETE', { expected_revision: state.revision }, true)).status, 403);
  assert.equal((await request('/projects/missing-project', 'DELETE', { expected_revision: state.revision })).status, 404);
  assert.deepEqual(await library(), beforeProjectDelete); report('项目删除拒绝过期提交、机器身份和不存在的项目，失败不改变题库');
  await ok('/projects/' + projectId, 'DELETE', { expected_revision: state.revision });
  state = await library();
  const removedIds = new Set(beforeProjectDelete.cards.filter(card => card.project_id === projectId).map(card => card.id));
  assert.equal(removedIds.size, 2);
  assert.equal(state.revision, beforeProjectDelete.revision + 1);
  assert.deepEqual(state.projects, beforeProjectDelete.projects.filter(project => project.id !== projectId));
  assert.deepEqual(state.cards, beforeProjectDelete.cards.filter(card => !removedIds.has(card.id)));
  assert.deepEqual(state.occurrences, beforeProjectDelete.occurrences.filter(record => !removedIds.has(record.card_id)));
  assert.deepEqual(state.relations, beforeProjectDelete.relations.filter(relation => !removedIds.has(relation.from_card_id) && !removedIds.has(relation.to_card_id)));
  assert.deepEqual((await library()).revisions, beforeProjectDelete.revisions.filter(entry => !removedIds.has(entry.card_id)));
  assert.deepEqual(state.sources, beforeProjectDelete.sources); assert.deepEqual(state.topics, beforeProjectDelete.topics);
  assert.deepEqual(await library(), state); report('项目及活动和归档题目一次删除，自身依赖清理，其他项目、知识点和来源原文保留');
  assert.equal((await request('/projects/' + projectId + '/snapshot')).status, 404);
  assert.ok(!(await ok('/graph')).elements.some(element => element.data.id === 'p:' + projectId || [...removedIds].some(id => element.data.id === 'c:' + id)));
  assert.equal((await request('/projects/' + projectId, 'DELETE', { expected_revision: state.revision })).status, 404);
  assert.deepEqual(await library(), state); report('已删项目在独立读取、图谱和离线快照中均不再出现，重复删除不改库');
  state = await ok('/changes', 'POST', { expected_revision: state.revision, changes: { schema_version: 1, projects: [{ id: 'empty-' + stamp, name: '空项目' }] } });
  state = await ok('/projects/empty-' + stamp, 'DELETE', { expected_revision: state.revision });
  for (const project of [...state.projects]) state = await ok('/projects/' + project.id, 'DELETE', { expected_revision: state.revision });
  assert.equal(state.projects.length, 0); assert.equal(state.cards.length, 0); assert.deepEqual(state.sources, beforeProjectDelete.sources);
  report('空项目和最后一个项目都能删除，原始来源仍保留');
  state = await apply({ ...projectBackup, batch_id: 'recover-project-' + stamp });
  for (const kind of ['projects', 'cards', 'sources', 'topics', 'occurrences', 'relations', 'revisions']) assert.deepEqual(state[kind], beforeProjectDelete[kind]);
  report('完整备份能够恢复已删除项目、归档卡片和所有原有关联');
  await verifyDirectImport({ ok, request, library, report, stamp });
  await verifyCardEdit({ ok, request, library, report, stamp });
  const staticFiles = await readdir('dist/assets'); let staticText = await readFile('dist/index.html', 'utf8'); for (const name of staticFiles) if (name.endsWith('.js')) staticText += await readFile(join('dist/assets', name), 'utf8');
  assert.ok(!staticText.includes(seed.occurrences[0].original_answer_md.slice(0, 55))); assert.ok(!staticText.includes('admin@example.com')); report('公开构建资源不包含私有问答或账户邮箱');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/api-verification.json', JSON.stringify({ passed: true, at: new Date().toISOString(), database: 'interview-cards-tests', scenarios: reports }, null, 2));
  console.log('实际数据库验证完成：' + reports.length + ' 项全部通过。');
} finally {
  if (server.pid) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else server.kill('SIGTERM'); }
}
