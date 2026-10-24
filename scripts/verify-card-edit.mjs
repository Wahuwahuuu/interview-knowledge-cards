import assert from 'node:assert/strict';

export async function verifyCardEdit({ ok, request, library, report, stamp }) {
  const before = await library(), id = 'single-edit-' + stamp;
  const created = await ok('/cards/' + id, 'PATCH', { expected_revision: before.revision, card_revision: null, patch: { project_id: before.projects[0].id, title: '单卡保存测试', question: '如何按记录保存？', summary_md: '只改当前题', answer_md: '示例讲解', favorite: true, important: true } });
  assert.deepEqual(Object.keys(created).sort(), ['card', 'revision']); assert.equal(created.card.id, id); assert.equal(created.card.revision, 1);
  let delta = await ok('/library/changes?cursor=' + before.revision); assert.equal(delta.records.length, 1); assert.equal(delta.records[0].id, id);
  report('单卡新增只返回当前卡片，真实 D1 增量日志只包含新卡');
  const base = await library(), input = { expected_revision: base.revision, card_revision: created.card.revision, patch: { question: '新的具体问题？', summary_md: '**简洁**口述' } };
  const edited = await ok('/cards/' + id, 'PATCH', input), saved = await library();
  assert.deepEqual(edited.card, saved.cards.find(card => card.id === id));
  assert.equal(edited.card.answer_md, '示例讲解'); assert.equal(edited.card.favorite, true); assert.equal(edited.card.important, true);
  for (const kind of ['projects','sources','topics','occurrences','relations']) assert.deepEqual(saved[kind], base[kind]);
  assert.deepEqual(saved.cards.filter(card => card.id !== id), base.cards.filter(card => card.id !== id));
  assert.equal(saved.revisions.length, base.revisions.length + 1); delta = await ok('/library/changes?cursor=' + base.revision); assert.equal(delta.records.length, 1);
  report('单卡修改持久保存并保留未提交答案、标记、来源和其他题目，历史及日志同事务提交');
  assert.equal((await request('/cards/' + id, 'PATCH', input)).status, 409);
  assert.equal((await request('/cards/' + id, 'PATCH', { expected_revision: saved.revision, card_revision: edited.card.revision, patch: { id: 'forged' } })).status, 422);
  assert.equal((await request('/cards/' + id, 'PATCH', { expected_revision: saved.revision, card_revision: edited.card.revision, patch: { answer_md: '越权覆盖' } }, true)).status, 403);
  assert.deepEqual(await library(), saved); report('新单卡入口拒绝过期提交、伪造字段及机器直接编辑，失败不改变题库');
  const attempts = await Promise.all(['A','B'].map(tag => request('/cards/' + id, 'PATCH', { expected_revision: saved.revision, card_revision: edited.card.revision, patch: { answer_md: '并发讲解 ' + tag } })));
  assert.deepEqual(attempts.map(value => value.status).sort(), [200,409]);
  const final = await library(); assert.equal(final.revision, saved.revision + 1); assert.equal(final.revisions.length, saved.revisions.length + 1);
  report('真实 D1 单卡并发只接受一次，失败方不留下历史或同步日志');
  const child = await ok('/cards/child-' + stamp, 'PATCH', { expected_revision: final.revision, card_revision: null, patch: { project_id: final.projects[0].id, title: '具体追问', question: '具体追问？', summary_md: '简短口述' }, followup: { id: 'child-link-' + stamp, parent_id: id, order: 1 } });
  assert.equal(child.relation.to_card_id, child.card.id); assert.equal(child.relation.from_card_id, id);
  delta = await ok('/library/changes?cursor=' + final.revision); assert.deepEqual(delta.records.map(row => row.kind).sort(), ['cards','relations']);
  report('真实 D1 新建追问只保存新卡与关系，增量提交保持完整');
}
