import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import app from '../worker/index';
import { LocalDatabase } from '../desktop/database';
import { tokenHash, type Env } from '../worker/auth';
import { commitLibrary, readLibrary } from '../worker/store';
import { readJournal } from '../worker/change-journal';
import { cardEditRequest, cardEditRequestSchema } from '../shared/card-edit';
import { cardSchema, emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { saveCard } from '../src/card-edit-actions';

const site = 'https://card-edit.example.test', session = 'e'.repeat(64);
const fixture = () => prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
  projects: [{ id: 'p', name: '示例项目' }], topics: [{ id: 'category', name: '示例大类' }],
  cards: [{ id: 'q', project_id: 'p', title: '事务', question: '事务是什么？', summary_md: '旧口述', answer_md: '旧讲解', favorite: true, important: true, mastery: 'mastered', topic_ids: ['category'], limitations_md: '保留说明', evidence: [{ label: '保留依据', path: 'example.md' }] }],
}));

describe('单卡保存接口', () => {
  let db: LocalDatabase, env: Env, sql: string[];
  const request = (id: string, input: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(`${site}/api/v1/cards/${id}`, { method: 'PATCH', headers: { Origin: site, 'Content-Type': 'application/json', Cookie: '__Host-interview_session=' + session, ...headers }, body: JSON.stringify(input) }), env);
  beforeEach(async () => {
    db = new LocalDatabase(':memory:', resolve('migrations'));
    db.raw.prepare("UPDATE users SET email='owner@example.test',password_hash='test-only' WHERE id='admin'").run();
    db.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(session), 'admin', new Date().toISOString(), new Date(Date.now() + 3600000).toISOString());
    env = { DB: db.asD1(), APP_ENV: 'production', OWNER_EMAIL: 'owner@example.test', ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: 'test', ASSETS: { fetch: async () => new Response('test') } as unknown as Fetcher };
    await commitLibrary(db.asD1(), 'admin', await readLibrary(db.asD1(), 'admin'), fixture());
    sql = []; const prepare = db.prepare.bind(db); db.prepare = text => { sql.push(text); return prepare(text); };
  });
  afterEach(() => db.close());
  it('数百条无关卡片存在时，改口述只读当前卡片和必要引用，返回单卡并保留其余属性及历史', async () => {
    let base = await readLibrary(db.asD1(), 'admin');
    await commitLibrary(db.asD1(), 'admin', base, prepareImport(base, importSchema.parse({ schema_version: 1, cards: Array.from({ length: 350 }, (_, i) => ({ id: 'other-' + i, project_id: 'p', title: '其他题 ' + i, question: '其他问题？', answer_md: '无关答案' })) })));
    base = await readLibrary(db.asD1(), 'admin'); const old = base.cards.find(card => card.id === 'q')!;
    sql.length = 0;
    const response = await request('q', { expected_revision: base.revision, card_revision: old.revision, patch: { summary_md: '**短句**口述' } });
    expect(response.status).toBe(200); const result = await response.json() as any;
    expect(Object.keys(result).sort()).toEqual(['card', 'revision']); expect(JSON.stringify(result)).not.toContain('无关答案');
    expect(result.card).toEqual({ ...old, summary_md: '**短句**口述', revision: old.revision + 1, updated_at: result.card.updated_at });
    const reads = sql.filter(text => /SELECT payload FROM user_(cards|projects|topics|sources|occurrences|relations)/.test(text));
    expect(reads.length).toBeGreaterThan(0); expect(reads.every(text => /\bid(?:=\?| IN \()/.test(text))).toBe(true);
    expect(sql.some(text => text.includes('ORDER BY id'))).toBe(false);
    const delta = await readJournal(db.asD1(), 'admin', base.revision); expect(delta.records).toHaveLength(1); expect(delta.records[0]).toMatchObject({ id: 'q', value: result.card });
    expect(db.raw.prepare("SELECT count(*) n FROM user_card_revisions WHERE user_id='admin' AND card_id='q'").get()!.n).toBe(2);
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('讲解与题目可清空或修改指定字段，不把未提交字段重置为默认值', async () => {
    const base = await readLibrary(db.asD1(), 'admin'), old = base.cards[0];
    const response = await request('q', { expected_revision: base.revision, card_revision: old.revision, patch: { question: '新的具体问题？', answer_md: '' } });
    expect(response.status).toBe(200); const result = await response.json() as any;
    expect(result.card).toMatchObject({ question: '新的具体问题？', answer_md: '', summary_md: old.summary_md, favorite: true, mastery: 'mastered', important: true, evidence: old.evidence, limitations_md: old.limitations_md });
  });
  it('过期题库或卡片版本拒绝保存，并发提交只有一份生效', async () => {
    const base = await readLibrary(db.asD1(), 'admin'), old = base.cards[0];
    const input = { expected_revision: base.revision, card_revision: old.revision, patch: { answer_md: '新讲解' } };
    expect((await request('q', { ...input, expected_revision: base.revision - 1 })).status).toBe(409);
    expect((await request('q', { ...input, card_revision: old.revision + 1 })).status).toBe(409);
    const attempts = await Promise.all([request('q', input), request('q', { ...input, patch: { answer_md: '另一个讲解' } })]);
    expect(attempts.map(row => row.status).sort()).toEqual([200, 409]);
    expect((await readJournal(db.asD1(), 'admin', base.revision)).records).toHaveLength(1);
    expect(db.raw.prepare("SELECT count(*) n FROM user_card_revisions WHERE card_id='q'").get()!.n).toBe(2);
  });
  it('无效引用、重复分类或伪造元数据整项拒绝，原题库和游标保持', async () => {
    const base = await readLibrary(db.asD1(), 'admin'), old = base.cards[0];
    for (const patch of [{ project_id: 'foreign-project' }, { topic_ids: ['category', 'category'] }, { id: 'other' }, { user_id: 'other' }, { revision: 100 }, { evidence: [] }, { title: '' }]) {
      expect((await request('q', { expected_revision: base.revision, card_revision: old.revision, patch })).status).toBe(422);
    }
    expect(await readLibrary(db.asD1(), 'admin')).toEqual(base); expect((await readJournal(db.asD1(), 'admin', base.revision)).records).toEqual([]);
  });
  it('新建卡片只返回新卡，重复 ID 和已删除的旧卡不能被隐式覆盖或重建', async () => {
    const base = await readLibrary(db.asD1(), 'admin');
    const response = await request('new', { expected_revision: base.revision, card_revision: null, patch: { project_id: 'p', title: '新题', question: '新问题？', summary_md: '新口述' } });
    expect(response.status).toBe(200); const result = await response.json() as any;
    expect(result.card).toMatchObject({ id: 'new', revision: 1, summary_md: '新口述', answer_md: '' });
    expect((await request('new', { expected_revision: result.revision, card_revision: null, patch: { question: '覆盖' } })).status).toBe(409);
    expect((await request('deleted', { expected_revision: result.revision, card_revision: 1, patch: { question: '重建' } })).status).toBe(404);
  });
  it('新建追问只保存新卡和关联，缺失主问题时两者都不入库', async () => {
    const base = await readLibrary(db.asD1(), 'admin');
    const input = { expected_revision: base.revision, card_revision: null, patch: { project_id: 'p', title: '追问', question: '具体追问？', answer_md: '对应讲解' }, followup: { id: 'followup-link', parent_id: 'q', order: 1 } };
    sql.length = 0; const response = await request('child', input); expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.relation).toMatchObject({ id: 'followup-link', from_card_id: 'q', to_card_id: 'child', kind: 'followup' });
    expect(sql.some(text => text.includes('ORDER BY id'))).toBe(false);
    expect((await readJournal(db.asD1(), 'admin', base.revision)).records.map(row => row.kind).sort()).toEqual(['cards', 'relations']);
    const saved = await readLibrary(db.asD1(), 'admin');
    expect((await request('orphan', { ...input, expected_revision: saved.revision, followup: { id: 'missing-parent', parent_id: 'missing', order: 1 } })).status).toBe(422);
    expect(await readLibrary(db.asD1(), 'admin')).toEqual(saved);
  });
  it('不变内容不生成新答案版本或增量；仅改标记保留答案版本', async () => {
    const base = await readLibrary(db.asD1(), 'admin'), old = base.cards[0];
    const noop = await request('q', { expected_revision: base.revision, card_revision: old.revision, patch: { answer_md: old.answer_md } });
    expect(await noop.json()).toEqual({ revision: base.revision, card: old });
    expect((await readJournal(db.asD1(), 'admin', base.revision)).records).toEqual([]);
    const flags = await request('q', { expected_revision: base.revision, card_revision: old.revision, patch: { important: false } });
    expect((await flags.json() as any).card.revision).toBe(old.revision);
    expect(db.raw.prepare("SELECT count(*) n FROM user_card_revisions WHERE card_id='q'").get()!.n).toBe(1);
  });
  it('匿名和机器身份不能借单卡保存接口绕过权限', async () => {
    const base = await readLibrary(db.asD1(), 'admin'), input = { expected_revision: base.revision, card_revision: 1, patch: { answer_md: '覆盖' } };
    expect((await request('q', input, { Cookie: '' })).status).toBe(401);
    const localEnv = { ...env, APP_ENV: 'local' };
    const response = await app.fetch(new Request('http://127.0.0.1/api/v1/cards/q', { method: 'PATCH', headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', 'x-local-role': 'agent' }, body: JSON.stringify(input) }), localEnv);
    expect(response.status).toBe(403);
  });
  it('普通账户不能读取、编辑或引用其他账户的卡片和项目', async () => {
    const now = new Date().toISOString(), member = 'f'.repeat(64);
    db.raw.prepare("INSERT INTO users(id,email,display_name,role,password_hash,created_at,updated_at) VALUES ('member','member@example.test','示例用户','member','test-only',?,?)").run(now, now);
    db.raw.prepare("INSERT INTO user_library_meta VALUES ('member',0)").run();
    db.raw.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(await tokenHash(member), 'member', now, new Date(Date.now() + 3600000).toISOString());
    const headers = { Cookie: '__Host-interview_session=' + member };
    expect((await request('q', { expected_revision: 0, card_revision: 1, patch: { answer_md: '越权修改' } }, headers)).status).toBe(404);
    expect((await request('new', { expected_revision: 0, card_revision: null, patch: { project_id: 'p', title: '越权关联', question: '示例？' } }, headers)).status).toBe(422);
    expect((await readLibrary(db.asD1(), 'admin')).cards[0].answer_md).toBe('旧讲解');
    expect((await readLibrary(db.asD1(), 'member')).cards).toEqual([]);
  });
});

describe('编辑页面的稀疏请求', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('只发送改动字段，不补默认值，拒绝客户端自定归属和修订号', () => {
    const card = fixture().cards[0], request = cardEditRequest(card, { ...card, answer_md: '新讲解' }, 8);
    expect(request).toEqual({ expected_revision: 8, card_revision: card.revision, patch: { answer_md: '新讲解' } });
    expect(cardEditRequestSchema.parse(request).patch).toEqual({ answer_md: '新讲解' });
    expect(() => cardEditRequestSchema.parse({ ...request, user_id: 'other' })).toThrow();
  });
  it('保存只请求单卡接口并在内存替换当前卡，不重新下载题库', async () => {
    const library = fixture(), before = library.cards[0], after = { ...before, summary_md: '新口述', revision: before.revision + 1, updated_at: 'now' };
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ revision: library.revision + 1, card: after })); vi.stubGlobal('fetch', fetch);
    const result = await saveCard(library, library.revision, before, { ...before, summary_md: '新口述' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toBe('/api/v1/cards/q');
    expect(JSON.parse(String((fetch.mock.calls[0] as any)[1].body)).patch).toEqual({ summary_md: '新口述' });
    expect(result.cards[0]).toEqual(after); expect(result.projects).toBe(library.projects); expect(result.sources).toBe(library.sources); expect(library.cards[0]).toBe(before);
  });
  it('未修改不请求，失败保留输入与原题库，错配响应不能替换页面数据', async () => {
    const library = fixture(), before = library.cards[0], fetch = vi.fn(async () => Response.json({ error: { message: '已有新版本', code: 'REVISION_CONFLICT' } }, { status: 409 })); vi.stubGlobal('fetch', fetch);
    expect(await saveCard(library, library.revision, before, before)).toBe(library); expect(fetch).not.toHaveBeenCalled();
    const draft = { ...before, answer_md: '未保存草稿' }; await expect(saveCard(library, library.revision, before, draft)).rejects.toMatchObject({ status: 409 });
    expect(draft.answer_md).toBe('未保存草稿'); expect(library.cards[0]).toBe(before);
    fetch.mockImplementationOnce(async () => Response.json({ revision: library.revision + 1, card: { ...before, id: 'mismatch' } }));
    await expect(saveCard(library, library.revision, before, draft)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
});
