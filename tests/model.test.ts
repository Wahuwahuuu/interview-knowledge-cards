import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardSchema, diffLibraries, emptyLibrary, graphElements, importSchema, prepareImport, projectSnapshot, sourceSchema, validateLibrary } from '../shared/model';
import { authorizePayload, authenticate, type Env } from '../worker/auth';
import app from '../worker/index';

function fixture() {
  return prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
    projects: [{ id: 'p1', name: '证书' }, { id: 'p2', name: '其他项目' }],
    topics: [{ id: 't1', name: '异步任务' }],
    cards: [{ id: 'c1', project_id: 'p1', title: '性能调优', question: '怎么优化？', answer_md: '原回答', topic_ids: ['t1'] }, { id: 'c2', project_id: 'p1', title: '降级', question: '怎么降级？', answer_md: '降级回答' }],
    sources: [{ id: 's1', name: '问答记录', kind: 'note', original_markdown: '原始文档' }],
    occurrences: [{ id: 'o1', card_id: 'c1', source_id: 's1', asked_question: '原始问题', original_answer_md: '原回答' }],
    relations: [{ id: 'r1', from_card_id: 'c1', to_card_id: 'c2', kind: 'followup' }],
  }));
}
describe('导入、来源和历史边界', () => {
  it('只按稳定 ID 合并，同名问题属于不同项目时保留', () => {
    const base = fixture(), next = prepareImport(base, importSchema.parse({ schema_version: 1, cards: [{ ...base.cards[0], id: 'c3', project_id: 'p2' }] }));
    expect(next.cards).toHaveLength(3); expect(next.cards.filter(c => c.title === '性能调优')).toHaveLength(2);
  });
  it('修改当前答案保留来源原文，并保存新历史', () => {
    const base = fixture(), next = prepareImport(base, importSchema.parse({ schema_version: 1, cards: [{ ...base.cards[0], answer_md: '新答案' }] }));
    expect(base.cards[0].answer_md).toBe('原回答'); expect(next.cards[0].revision).toBe(2);
    expect(next.occurrences[0].original_answer_md).toBe('原回答'); expect(next.revisions.filter(r => r.card_id === 'c1')).toHaveLength(2);
  });
  it('合并模式不能覆盖原始来源或当时的回答', () => {
    const base = fixture();
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, sources: [{ ...base.sources[0], original_markdown: '覆盖原文' }] }))).toThrow('原始记录');
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, occurrences: [{ ...base.occurrences[0], original_answer_md: '覆盖回答' }] }))).toThrow('原始问答');
  });
  it('缺失引用、重复 ID 和逆向重复相关关系被拒绝', () => {
    const base = fixture();
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, cards: [{ ...base.cards[0], project_id: 'missing' }] }))).toThrow('项目');
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, topics: [{ id: 't2', name: 'A' }, { id: 't2', name: 'B' }] }))).toThrow('重复');
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, relations: [{ id: 'r2', from_card_id: 'c1', to_card_id: 'c2', kind: 'related' }, { id: 'r3', from_card_id: 'c2', to_card_id: 'c1', kind: 'related' }] }))).toThrow('重复');
  });
  it('历史数量变更也出现在完整恢复预览中', () => {
    const base = fixture(), target = structuredClone(base); target.revisions = [];
    expect(diffLibraries(base, target).some(v => v.fields.some(f => f.field === 'history'))).toBe(true);
  });
  it('完整恢复保持问题 ID、出现记录和历史快照', () => {
    const base = fixture(), target = prepareImport(emptyLibrary(), importSchema.parse({ ...base, mode: 'restore' }));
    expect(target.cards).toEqual(base.cards); expect(target.occurrences).toEqual(base.occurrences); expect(target.revisions).toEqual(base.revisions); validateLibrary(target);
  });
  it('非法日期和历史版本编号被拒绝', () => {
    expect(sourceSchema.safeParse({ id: 's', name: '来源', kind: 'real', date: '2026-02-30' }).success).toBe(false);
    expect(sourceSchema.safeParse({ id: 's', name: '来源', kind: 'real', date: '2026-13-30' }).success).toBe(false);
    const base = fixture(); base.revisions[0].revision = 99; expect(() => validateLibrary(base)).toThrow('历史版本');
  });
  it('相同导入内容不会无故生成新卡片版本', () => {
    const base = fixture(), next = prepareImport(base, importSchema.parse({ schema_version: 1, cards: base.cards }));
    expect(next.revisions).toHaveLength(base.revisions.length); expect(diffLibraries(base, next)).toEqual([]);
  });
});
describe('项目图谱与离线快照', () => {
  it('图谱区分知识点、项目和有向追问', () => {
    const base = fixture(), graph = graphElements(base, 'p1');
    expect(graph.some(e => e.data.id === 'p:p2')).toBe(false);
    expect(graph.find(e => e.data.id === 'r:r1')?.data).toMatchObject({ source: 'c:c1', target: 'c:c2', kind: 'followup' });
    expect(graph.some(e => e.data.id === 't:t1')).toBe(true);
  });
  it('下载项目只包括该项目卡片和实际引用的来源', () => {
    const base = fixture(); base.sources.push(sourceSchema.parse({ id: 'unused', name: '无关来源', kind: 'note' }));
    const snapshot = projectSnapshot(base, 'p1'); expect(snapshot.projects).toHaveLength(1); expect(snapshot.cards).toHaveLength(2); expect(snapshot.sources).toHaveLength(1); expect(snapshot.revisions).toHaveLength(0);
    expect(() => projectSnapshot(base, 'unknown')).toThrow('项目不存在');
  });
});
describe('访问权限必须在服务端成立', () => {
  it('用户邮箱白名单与服务身份不能混用', () => {
    expect(authorizePayload({ email: 'owner@example.com', sub: 'owner' }, false, 'owner@example.com').role).toBe('owner');
    expect(() => authorizePayload({ email: 'other@example.com' }, false, 'owner@example.com')).toThrow('权限');
    expect(() => authorizePayload({ common_name: 'service' }, false, 'owner@example.com')).toThrow('权限');
    expect(() => authorizePayload({ email: 'owner@example.com' }, true, 'owner@example.com')).toThrow('独立服务凭证');
    expect(authorizePayload({ common_name: 'service', sub: 'service' }, true, 'owner@example.com').role).toBe('agent');
  });
  it('未配置生产登录时关闭访问，不能降级为本地预览身份', async () => {
    const env = { APP_ENV: 'production', OWNER_EMAIL: 'owner@example.com' } as Env;
    const response = await app.request('https://app.example.com/api/v1/library', {}, env);
    expect(response.status).toBe(503);
    await expect(authenticate(new Request('https://app.example.com/api/v1/library'), { ...env, APP_ENV: 'local' })).rejects.toThrow('配置');
  });
  it('本机测试可以读，机器角色仍不能进入人工确认接口', async () => {
    const env = { APP_ENV: 'local', OWNER_EMAIL: 'owner@example.com' } as Env;
    const response = await app.request('http://127.0.0.1/api/v1/imports/test/apply', { method: 'POST', headers: { 'x-local-role': 'agent', 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(response.status).toBe(403);
  });
  it('HTML、脚本和本地文件链接不会成为可执行网页链接', async () => {
    const { safeHref, Markdown } = await import('../src/Markdown');
    expect(safeHref('javascript:alert(1)')).toBe(''); expect(safeHref('F:/private/file.md')).toBe(''); expect(safeHref('https://docs.example.com')).toBe('https://docs.example.com');
    const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script>\n\n<img src="https://external.example/track" onerror="alert(1)" />\n\n[危险链接](javascript:alert(1))' }));
    expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toContain('javascript:');
  });
  it('真实 JWT 签名、受众和有效期都必须通过验证', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    const env = { APP_ENV: 'production', OWNER_EMAIL: 'owner@example.com', ACCESS_TEAM_DOMAIN: 'unit-test-jwt.cloudflareaccess.com', ACCESS_AUD: 'human', AGENT_ACCESS_AUD: 'agent' } as Env;
    const make = (audience = 'human', expired = false) => new SignJWT({ email: env.OWNER_EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://' + env.ACCESS_TEAM_DOMAIN).setAudience(audience).setSubject('owner').setIssuedAt().setExpirationTime(expired ? 946684800 : '5m').sign(privateKey);
    const request = (token: string) => new Request('https://app.example.com/api/v1/library', { headers: { 'cf-access-jwt-assertion': token } });
    try {
      expect((await authenticate(request(await make()), env)).role).toBe('owner');
      await expect(authenticate(request(await make('wrong')), env)).rejects.toThrow('登录');
      await expect(authenticate(request(await make('human', true)), env)).rejects.toThrow('登录');
      const signed = await make(); const parts = signed.split('.'); parts[1] = Buffer.from('{"email":"owner@example.com"}').toString('base64url');
      await expect(authenticate(request(parts.join('.')), env)).rejects.toThrow('登录');
    } finally { vi.unstubAllGlobals(); }
  });
});
