import assert from 'node:assert/strict';

export async function verifyProjectOrder({ request, ok, library, report }) {
  const before = await library(), ids = before.projects.map(project => project.id).reverse();
  assert.ok(ids.length > 1);
  const payload = { expected_revision: before.revision, project_ids: ids };
  assert.equal((await request('/projects/order', 'PUT', payload, true)).status, 403);
  assert.equal((await request('/projects/order', 'PUT', { ...payload, expected_revision: before.revision - 1 })).status, 409);
  for (const project_ids of [ids.slice(1), [...ids.slice(1), ids[1]], [...ids.slice(1), 'another-account-project']]) assert.equal((await request('/projects/order', 'PUT', { ...payload, project_ids })).status, 422);
  assert.deepEqual(await library(), before);
  const result = await ok('/projects/order', 'PUT', payload);
  assert.equal(result.revision, before.revision + 1);
  assert.deepEqual(result.projects.map(project => project.id), ids);
  assert.equal(result.cards, undefined);
  const saved = await library();
  assert.deepEqual([...saved.projects].sort((a, b) => a.sort_order - b.sort_order).map(project => project.id), ids);
  for (const key of ['cards', 'sources', 'topics', 'occurrences', 'relations', 'revisions']) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual((await ok('/projects/order', 'PUT', { ...payload, expected_revision: saved.revision })).projects, result.projects);
  assert.equal((await library()).revision, saved.revision);
  report('项目排序持久保存；拒绝旧版本、重复/缺失/外部项目及机器凭证；答案不受影响');
}
