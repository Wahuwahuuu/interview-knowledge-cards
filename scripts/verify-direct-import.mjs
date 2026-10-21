import assert from 'node:assert/strict';

export async function verifyDirectImport({ ok, request, library, report, stamp }) {
  const id = name => `direct-${name}-${stamp}`;
  const project = { id: id('project'), name: '直接导入验收题库' };
  const card = { id: id('card'), project_id: project.id, title: '直接导入题目', question: '提交后是否保存？', summary_md: '提交后直接保存。' };
  const input = { schema_version: 1, batch_id: id('batch'), projects: [project], cards: [card] };
  const result = await ok('/imports/submit', 'POST', input);
  assert.equal(result.batch.status, 'applied'); assert.ok(result.batch.applied_at); assert.equal(result.already_applied, false);
  let state = await library(); assert.equal(state.cards.find(value => value.id === card.id).summary_md, card.summary_md);
  assert.equal((await ok('/imports/' + input.batch_id)).status, 'applied');
  report('网页普通导入一次请求直接入库，独立读取题库和记录证明持久保存');

  const repeat = await ok('/imports/submit', 'POST', input);
  assert.equal(repeat.already_applied, true); assert.deepEqual(await library(), state);
  const mismatch = await request('/imports/submit', 'POST', { ...input, cards: [{ ...card, title: '同批次不同内容' }] });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.value.error.code, 'BATCH_ID_REUSED'); assert.deepEqual(await library(), state);
  report('重复直接提交保持同一结果，不增加卡片、历史或版本；复用批次修改内容被拒绝');

  const simultaneous = { schema_version: 1, batch_id: id('same-race'), cards: [{ ...card, id: id('same-race-card') }] };
  const beforeSame = state;
  const identical = await Promise.all([1, 2, 3].map(() => ok('/agent/imports/submit', 'POST', simultaneous, true)));
  assert.ok(identical.every(batch => batch.status === 'applied'));
  state = await library(); assert.equal(state.revision, beforeSame.revision + 1); assert.equal(state.cards.length, beforeSame.cards.length + 1); assert.equal(state.revisions.length, beforeSame.revisions.length + 1);
  report('同一 AI 批次并发提交只入库一次，所有请求取得相同成功终态');

  const disjoint = await Promise.all(['a', 'b', 'c'].map(tag => ok('/imports/submit', 'POST', { schema_version: 1, batch_id: id('disjoint-' + tag), cards: [{ ...card, id: id('disjoint-card-' + tag) }] })));
  assert.ok(disjoint.every(result => result.batch.status === 'applied'));
  state = await library(); assert.ok(['a', 'b', 'c'].every(tag => state.cards.some(card => card.id === id('disjoint-card-' + tag))));
  report('不同题目并发直接导入自动处理题库版本变化，无需人工再次确认');

  const baseCard = state.cards.find(value => value.id === card.id);
  const competing = await Promise.all(['a', 'b'].map(tag => request('/imports/submit', 'POST', { schema_version: 1, batch_id: id('target-race-' + tag), cards: [{ ...baseCard, summary_md: '并发修改 ' + tag }] })));
  assert.deepEqual(competing.map(value => value.status).sort(), [200, 409]);
  state = await library(); const winner = competing.find(value => value.status === 200).value;
  assert.equal(state.cards.find(value => value.id === card.id).summary_md, winner.library.cards.find(value => value.id === card.id).summary_md);
  const stale = await request('/agent/imports/submit', 'POST', { schema_version: 1, batch_id: id('stale'), cards: [{ ...baseCard, summary_md: '不能覆盖新答案' }] }, true);
  assert.equal(stale.status, 409); assert.equal(stale.value.error.code, 'IMPORT_TARGET_CONFLICT');
  assert.equal((await ok('/agent/imports/' + id('stale'), 'GET', undefined, true)).status, 'failed');
  assert.deepEqual(await library(), state);
  report('同时修改同一题及旧版本 AI 提交均拒绝覆盖新答案，失败原因保留在记录中');

  const currentCard = state.cards.find(value => value.id === card.id);
  await ok('/cards/' + card.id + '/state', 'PATCH', { expected_revision: state.revision, card_revision: currentCard.revision, patch: { mastery: 'mastered' } });
  state = await library();
  const staleFlags = await request('/imports/submit', 'POST', { schema_version: 1, batch_id: id('stale-flags'), cards: [{ ...currentCard, answer_md: '旧快照修改答案' }] });
  assert.equal(staleFlags.status, 409); assert.deepEqual(await library(), state);
  const unversioned = await request('/imports/submit', 'POST', { schema_version: 1, batch_id: id('unversioned'), cards: [{ ...card, title: '缺少当前版本信息' }] });
  assert.equal(unversioned.status, 409); assert.deepEqual(await library(), state);
  report('直接更新要求当前完整对象，同时保护未增加答案版本的复习标记');

  const invalid = { schema_version: 1, batch_id: id('failed'), cards: [{ ...card, id: id('valid-part') }, { ...card, id: id('bad-ref'), project_id: id('missing-project') }] };
  assert.equal((await request('/imports/submit', 'POST', invalid)).status, 422);
  assert.deepEqual(await library(), state);
  let failed = await ok('/imports/' + invalid.batch_id); assert.equal(failed.status, 'failed'); assert.ok(failed.error); assert.equal(failed.question_count, 2);
  assert.equal((await request('/imports/' + invalid.batch_id + '/retry', 'POST', {})).status, 422); assert.deepEqual(await library(), state);
  report('引用校验失败整批不写入，保留失败记录，失败重试也不留下部分题目');

  await ok('/imports/submit', 'POST', { schema_version: 1, batch_id: id('repair-reference'), projects: [{ id: id('missing-project'), name: '补齐引用的测试题库' }] });
  const retried = await ok('/imports/' + invalid.batch_id + '/retry', 'POST', {});
  failed = await ok('/imports/' + invalid.batch_id); assert.equal(failed.status, 'applied'); assert.equal(failed.error, undefined); assert.ok(failed.applied_at);
  state = await library(); assert.ok(state.cards.some(value => value.id === id('valid-part'))); assert.ok(state.cards.some(value => value.id === id('bad-ref')));
  assert.equal(retried.batch.id, invalid.batch_id);
  report('问题修复后从原记录直接重试，原批次更新为成功并清除失败信息');

  const oldDraft = await ok('/imports/preview', 'POST', { schema_version: 1, batch_id: id('legacy'), cards: [{ ...card, id: id('legacy-card') }] });
  await ok('/imports'); await ok('/imports/' + oldDraft.id);
  assert.deepEqual(await library(), state);
  assert.equal((await ok('/imports/' + oldDraft.id + '/retry', 'POST', {})).batch.status, 'applied');
  const cancelled = await ok('/imports/preview', 'POST', { schema_version: 1, batch_id: id('cancelled'), cards: [{ ...card, id: id('cancelled-card') }] });
  await ok('/imports/' + cancelled.id + '/cancel', 'POST', {});
  state = await library(); assert.equal((await request('/imports/' + cancelled.id + '/retry', 'POST', {})).status, 409); assert.deepEqual(await library(), state);
  report('旧待确认记录只读时不自动导入，主动导入后生效；已取消记录不能被重试复活');

  const beforeRejected = await library();
  for (const path of ['/imports/submit', '/agent/imports/submit', '/agent/imports/preview']) {
    assert.equal((await request(path, 'POST', { schema_version: 1, mode: 'restore', batch_id: id('restore') }, path.includes('/agent/'))).status, 403);
  }
  const restore = await ok('/imports/preview', 'POST', { schema_version: 1, mode: 'restore', batch_id: id('restore-preview') });
  assert.equal(restore.status, 'pending'); assert.equal((await request('/imports/' + restore.id + '/retry', 'POST', {})).status, 403);
  assert.deepEqual(await library(), beforeRejected);
  assert.equal((await request('/agent/imports/' + input.batch_id + '/retry', 'POST', {}, true)).status, 403);
  assert.equal((await request('/imports/submit', 'POST', input, true)).status, 403);
  report('直接导入和 AI 兼容入口均禁止完整恢复；备份仍只生成待确认预览，机器不能调用人工接口');

  const overLimit = await request('/agent/imports/submit', 'POST', { schema_version: 1, batch_id: id('capacity'), cards: Array.from({ length: 2000 }, (_, index) => ({ ...card, id: id('capacity-' + index) })) }, true);
  assert.equal(overLimit.status, 422); assert.equal(overLimit.value.error.code, 'LIBRARY_LIMIT');
  assert.equal((await ok('/imports/' + id('capacity'))).status, 'failed'); assert.deepEqual(await library(), beforeRejected);
  report('AI 导入校验合并后题库总量，超过读取上限整批拒绝，原题库仍可正常读取');
}
