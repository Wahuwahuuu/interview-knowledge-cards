import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';

const initial = () => prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1, projects: [{ id: 'p', name: '示例项目' }], cards: [{ id: 'q', project_id: 'p', title: '事务', question: '事务是什么？', summary_md: '旧口述', answer_md: '旧讲解' }] }));
async function seed() {
  const replica = await import('../src/local-replica'), library = initial();
  await replica.importReplica(JSON.stringify({ type: 'interview-cards-device-backup', version: 1, server: 'https://local.invalid', token: 'a'.repeat(64), deviceId: 'device', account: { user_id: 'admin', email: 'test@example.invalid', role: 'admin' }, snapshot: { epoch: 'epoch', cursor: 0, imports: [], library }, library, pending: [], lastSync: '' }));
  return replica;
}
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('location', { origin: 'https://local.invalid' }); vi.stubGlobal('navigator', { storage: { persist: async () => true } });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => vi.unstubAllGlobals());
describe('iPhone 持久化副本', () => {
  it('解除配对后可以重新导入设备备份，不受旧存储版本阻止', async () => {
    const client = await seed(), backup = client.exportReplica();
    await client.forgetReplica(); expect(client.getReplica()).toBeUndefined();
    await client.importReplica(backup); expect(client.getReplica()!.library.cards).toHaveLength(1);
  });
  it('离线编辑及掌握标记写入 IndexedDB，重新打开后仍有题库和待同步操作', async () => {
    let client = await seed();
    const before = client.getReplica()!.library, card = before.cards[0];
    await client.replicaApi('/cards/q', { method: 'PUT', body: JSON.stringify({ expected_revision: before.revision, value: { ...card, summary_md: '**简洁**口述' } }) });
    const next = client.getReplica()!.library;
    await client.replicaApi('/cards/q/state', { method: 'PATCH', body: JSON.stringify({ expected_revision: next.revision, card_revision: next.cards[0].revision, patch: { mastery: 'mastered' } }) });
    vi.resetModules(); client = await import('../src/local-replica'); await client.initializeRuntime();
    expect(client.getReplica()!.library.cards[0]).toMatchObject({ summary_md: '**简洁**口述', mastery: 'mastered' }); expect(client.getReplica()!.pending).toHaveLength(2);
    await expect(client.forgetReplica()).rejects.toThrow('待同步');
  });
  it('电脑不可达时保持队列，导出文件包含未同步答案', async () => {
    const client = await seed(), before = client.getReplica()!.library;
    await client.replicaApi('/cards/q', { method: 'PUT', body: JSON.stringify({ expected_revision: before.revision, value: { ...before.cards[0], answer_md: '离线新增答案' } }) });
    await client.synchronizePhone(); expect(client.getReplica()!.pending).toHaveLength(1); expect(client.exportReplica()).toContain('离线新增答案');
  });
  it('仅在电脑确认后移除待同步项，并拉回电脑变化', async () => {
    const client = await seed(), before = client.getReplica()!.library;
    await client.replicaApi('/cards/q/state', { method: 'PATCH', body: JSON.stringify({ expected_revision: before.revision, card_revision: before.cards[0].revision, patch: { mastery: 'mastered' } }) });
    const updated = { ...before.cards[0], answer_md: '电脑修改', mastery: 'mastered' };
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => Response.json(path.includes('/push') ? { id: JSON.parse(String(init.body)).id, status: 'applied', conflicts: [] } : { logs: [{ seq: 1, kind: 'cards', id: 'q', payload: JSON.stringify(updated) }], cursor: 1, more: false, revision: 2 })));
    await client.synchronizePhone(); expect(client.getReplica()!.pending).toHaveLength(0); expect(client.getReplica()!.library.cards[0]).toMatchObject(updated);
  });
  it('解决同字段冲突时保留电脑修改的其他字段', async () => {
    const client = await seed(), before = client.getReplica()!.library;
    await client.replicaApi('/cards/q', { method: 'PUT', body: JSON.stringify({ expected_revision: before.revision, value: { ...before.cards[0], summary_md: '手机口述' } }) });
    const computer = { ...before, cards: [{ ...before.cards[0], summary_md: '电脑口述', answer_md: '电脑新讲解' }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ epoch: 'epoch', cursor: 2, imports: [], library: computer })));
    await client.resolveSyncConflict(client.getReplica()!.pending[0].operation.id, 'phone', { 'q:summary_md': '合并口述' });
    expect(client.getReplica()!.library.cards[0]).toMatchObject({ summary_md: '合并口述', answer_md: '电脑新讲解' });
  });
});
