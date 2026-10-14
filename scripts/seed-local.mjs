import { readFile } from 'node:fs/promises';
const origin = 'http://127.0.0.1:8787';
const seed = JSON.parse(await readFile(process.argv.find(value => value.endsWith('.json')) ?? 'examples/demo-import.json', 'utf8'));
const response = await fetch(origin + '/api/v1/imports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(seed) });
const result = await response.json();
if (!response.ok) throw new Error(result.error?.message ?? '预览失败');
console.log(JSON.stringify({ batch: result.id, status: result.status, changes: result.preview.map(v => ({ kind: v.kind, name: v.name, operation: v.operation })) }));
if (process.argv.includes('--apply') && result.status === 'pending') {
  const apply = await fetch(origin + '/api/v1/imports/' + result.id + '/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ expected_revision: result.base_revision }) });
  const value = await apply.json();
  if (!apply.ok) throw new Error(value.error?.message ?? '导入失败');
  console.log(JSON.stringify({ applied: true, cards: value.library.cards.length, projects: value.library.projects.length, revision: value.library.revision }));
}
