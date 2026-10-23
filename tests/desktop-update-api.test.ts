import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startDesktopServer } from '../desktop/server';
import { tokenHash } from '../worker/auth';
import { hashPassword } from '../worker/password';
import type { DesktopUpdateStatus } from '../shared/desktop-update';

describe('本机更新接口与升级前备份', () => {
  let server: Awaited<ReturnType<typeof startDesktopServer>>, data: string, cookie: string, agent: string, memberCookie: string;
  let checks = 0, installs = 0;
  let state: DesktopUpdateStatus = { version: '2.0.2', phase: 'idle', message: '已是最新版本' };
  async function request(path = '', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(server.origin + '/api/v1/desktop/update' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() as any };
  }
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'knowledge-update-'));
    server = await startDesktopServer({ dataDir: data, assets: resolve('dist'), migrations: resolve('migrations'), port: 0, lan: false, updates: {
      status: () => ({ ...state }), check() { checks++; state = { ...state, phase: 'checking' }; }, install() { installs++; state = { ...state, phase: 'installing' }; },
    } });
    cookie = (await fetch(server.bootstrapUrl, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    server.db.raw.prepare("UPDATE users SET password_hash=? WHERE id='admin'").run(await hashPassword('fictional-password-123'));
    agent = JSON.parse(readFileSync(join(data, 'agent-credential.json'), 'utf8')).token;
    const now = new Date().toISOString(), memberToken = '1'.repeat(64);
    server.db.raw.prepare("INSERT INTO users(id,email,display_name,role,status,created_at,updated_at) VALUES ('member','member@example.invalid','测试用户','member','active',?,?)").run(now, now);
    server.db.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(memberToken), 'member', now, '2099-01-01T00:00:00Z');
    memberCookie = 'interview_session_local=' + memberToken;
    const imported = await fetch(server.origin + '/api/v1/imports/submit', { method: 'POST', headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema_version: 1,
      projects: [{ id: 'bank', name: '更新测试题库' }], topics: [{ id: 'category-mysql', name: 'MySQL' }],
      cards: [{ id: 'q1', project_id: 'bank', title: '事务', question: '事务有什么作用？', summary_md: '**原子性**与隔离。', answer_md: '虚构的详细答案', topic_ids: ['category-mysql'], mastery: 'mastered', favorite: true, important: true }, { id: 'q2', project_id: 'bank', title: '隔离', question: '事务隔离是什么？', archived: true }],
      sources: [{ id: 's1', name: '虚构来源', kind: 'note', original_markdown: '完整原文保留' }], occurrences: [{ id: 'o1', card_id: 'q1', source_id: 's1', asked_question: '事务有什么作用？' }], relations: [{ id: 'r1', from_card_id: 'q1', to_card_id: 'q2', kind: 'followup' }],
    }) }); expect(imported.status).toBe(200);
    server.db.raw.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?)').run('phone', 'admin', '测试 iPhone', 'fixture-device-token-hash', now, now);
  });
  afterAll(async () => { await server?.close(); });
  it('版本可读，检查请求立即返回，不等待网络下载或持有数据库队列', async () => {
    expect((await request()).value.version).toBe('2.0.2');
    expect((await request('/check', {})).value.phase).toBe('checking'); expect(checks).toBe(1);
    expect((await fetch(server.origin + '/api/v1/library', { headers: { Cookie: cookie } })).status).toBe(200);
  });
  it('拒绝未登录、普通用户、机器凭证及跨来源控制更新', async () => {
    expect((await request('', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request('/check', {}, { Cookie: memberCookie })).status).toBe(403);
    expect((await request('/check', {}, { Cookie: '', Authorization: 'Bearer ' + agent })).status).toBe(401);
    expect((await request('/check', {}, { Origin: 'https://unrelated.invalid' })).status).toBe(403);
    expect(checks).toBe(1);
  });
  it('拒绝外部更新地址、未确认或未下载完成的安装请求', async () => {
    expect((await request('/check', { url: 'https://unrelated.invalid/update' })).status).toBe(422);
    expect((await request('/install', {})).status).toBe(422);
    expect((await request('/install', { confirmed: true })).status).toBe(409); expect(installs).toBe(0);
  });
  it('确认后只发起一次安装，操作在响应发出后执行', async () => {
    state = { ...state, phase: 'ready' }; expect((await request('/install', { confirmed: true })).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve)); expect(installs).toBe(1);
    expect((await request('/install', { confirmed: true })).status).toBe(409);
  });
  it('备份失败后仍可读写，成功备份包含题库、账户和同步资料并暂停后续写入', async () => {
    const saved = server.db.saveBackup;
    server.db.saveBackup = async () => { throw new Error('test backup failure'); };
    await expect(server.prepareUpdateBackup(join(data, 'backups', 'failed.sqlite'))).rejects.toThrow();
    server.db.saveBackup = saved;
    expect((await request()).status).toBe(200);
    const path = join(data, 'backups', 'before-update.sqlite');
    const before = server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const contents = before.map(row => ({ table: String(row.name), rows: server.db.raw.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all() }));
    await server.prepareUpdateBackup(path);
    const backup = new DatabaseSync(path, { readOnly: true });
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before);
    for (const table of contents) expect(backup.prepare(`SELECT * FROM "${table.table.replaceAll('"', '""')}"`).all(), table.table).toEqual(table.rows);
    expect(backup.prepare('SELECT count(*) AS n FROM users').get()!.n).toBe(2);
    expect(backup.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok'); backup.close();
    expect((await request()).status).toBe(503);
    const phone = await fetch(server.origin + '/api/v1/sync/push', { method: 'POST', headers: { Authorization: 'Bearer ' + '0'.repeat(64), Origin: server.origin }, body: '{}' });
    expect(phone.status).not.toBe(200);
  });
});
