import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { startDesktopServer } from '../desktop/server';
import { hashPassword } from '../worker/password';
import { changesBetween, type SyncSnapshot } from '../shared/sync';
import { importSchema, prepareImport } from '../shared/model';

describe('SQLite 本机服务与设备同步', () => {
  let server: Awaited<ReturnType<typeof startDesktopServer>>, cookie = '', token = '', snapshot: SyncSnapshot, savedOperation: unknown;
  async function request(path: string, value?: unknown, device = false, cookieOverride?: string) {
    const response = await fetch(server.origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { Origin: server.origin, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(device ? { Authorization: `Bearer ${token}` } : { Cookie: cookieOverride ?? cookie }) }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { response, value: await response.json() as any };
  }
  beforeAll(async () => {
    server = await startDesktopServer({ dataDir: mkdtempSync(join(tmpdir(), 'knowledge-sync-')), assets: resolve('dist'), migrations: resolve('migrations'), port: 0, lan: false });
    server.db.raw.prepare("UPDATE users SET email='test@example.invalid',password_hash=? WHERE id='admin'").run(await hashPassword('fictional-password-123'));
    const launch = await fetch(server.bootstrapUrl, { redirect: 'manual' }); cookie = launch.headers.get('set-cookie')!.split(';')[0];
    const seed = await request('/api/v1/imports/submit', { schema_version: 1, batch_id: 'seed', projects: [{ id: 'p', name: '示例项目' }], cards: [{ id: 'q', project_id: 'p', title: '事务', question: '事务是什么？', answer_md: '最初答案' }] });
    expect(seed.response.status).toBe(200);
    const pair = await request('/api/v1/desktop/pair', {}), paired = await request('/api/v1/sync/pair', { code: pair.value.code, name: '测试手机' });
    expect(paired.response.status).toBe(200); token = paired.value.token; snapshot = paired.value.snapshot;
  });
  afterAll(async () => { await server?.close(); });
  it('独立 SQLite 提供现有题库和完整历史导出', async () => {
    expect(snapshot.library.cards).toHaveLength(1); expect(snapshot.library.revisions).toHaveLength(1);
    expect((await request('/api/v1/imports')).value[0].status).toBe('applied');
  });
  it('重复推送幂等，增量拉取包含电脑修改，字段独立合并', async () => {
    const phone = prepareImport(snapshot.library, importSchema.parse({ schema_version: 1, cards: [{ ...snapshot.library.cards[0], mastery: 'mastered' }] }));
    const current = (await request('/api/v1/library')).value;
    await request('/api/v1/changes', { expected_revision: current.revision, changes: { schema_version: 1, cards: [{ ...current.cards[0], answer_md: '电脑的新讲解' }] } });
    const operation = { id: 'op-once', epoch: snapshot.epoch, changes: changesBetween(snapshot.library, phone) };
    savedOperation = operation;
    const once = await request('/api/v1/sync/push', operation, true), twice = await request('/api/v1/sync/push', operation, true);
    expect(once.value.status).toBe('applied'); expect(twice.value).toEqual(once.value);
    const card = (await request('/api/v1/library')).value.cards[0]; expect(card.mastery).toBe('mastered'); expect(card.answer_md).toBe('电脑的新讲解');
    const pull = await request(`/api/v1/sync/pull?epoch=${snapshot.epoch}&cursor=${snapshot.cursor}`, undefined, true); expect(pull.value.logs.some((v: any) => v.kind === 'cards')).toBe(true);
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM sync_receipts').get()?.n).toBe(1);
  });
  it('修改已删除记录产生冲突；不写入部分数据或回执', async () => {
    const phone = prepareImport(snapshot.library, importSchema.parse({ schema_version: 1, cards: [{ ...snapshot.library.cards[0], answer_md: '手机的新答案' }] }));
    const result = await request('/api/v1/sync/push', { id: 'op-conflict', epoch: snapshot.epoch, changes: changesBetween(snapshot.library, phone) }, true);
    expect(result.value.status).toBe('conflict'); expect(result.value.conflicts[0].field).toBe('answer_md');
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM sync_receipts').get()?.n).toBe(1);
  });
  it('成员设备只能同步自己的题库；无会话不能生成配对码', async () => {
    const member = await request('/api/v1/auth/register', { email: 'member@example.invalid', password: 'fictional-password-456', display_name: '示例用户' }, false, '');
    const memberCookie = member.response.headers.get('set-cookie')!.split(';')[0];
    const pair = await request('/api/v1/desktop/pair', {}, false, memberCookie);
    const paired = await request('/api/v1/sync/pair', { code: pair.value.code, name: '成员手机' });
    expect(paired.value.snapshot.library.cards).toHaveLength(0); expect(paired.value.account.role).toBe('member');
    expect((await request('/api/v1/desktop/pair', {}, false, '')).response.status).toBe(401);
  });
  it('错误配对码、跨来源写请求、旧题库代次都被阻止', async () => {
    expect((await request('/api/v1/sync/pair', { code: 'bad', name: '测试' })).response.status).toBe(401);
    const cross = await fetch(server.origin + '/api/v1/desktop/pair', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' }); expect(cross.status).toBe(403);
    server.db.raw.prepare("UPDATE sync_state SET epoch='new-epoch' WHERE user_id='admin'").run();
    expect((await request('/api/v1/sync/push', { id: 'stale', epoch: snapshot.epoch, changes: [] }, true)).value.error.code).toBe('EPOCH_CHANGED');
    // A previously committed acknowledgement remains available even after restore.
    expect((await request('/api/v1/sync/push', savedOperation, true)).value.status).toBe('applied');
  });
  it('修改密码同时撤销已配对的设备，手机本地副本由手机保留', async () => {
    const result = await request('/api/v1/account/password', { current_password: 'fictional-password-123', password: 'fictional-new-password-789' });
    expect(result.response.status).toBe(200);
    expect((await request('/api/v1/sync/snapshot', undefined, true)).response.status).toBe(401);
  });
});
