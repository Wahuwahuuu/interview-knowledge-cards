import { describe, it, expect } from 'vitest';
import { summarizeChanges } from '../shared/import-summary';
import { hashPassword, verifyPassword } from '../worker/password';
import { sessionCookie, type Env } from '../worker/auth';
import type { Change } from '../shared/model';
describe('账户与导入摘要', () => {
  it('13 条记录准确显示为两道题和 11 条附属资料', () => {
    const kinds: Change['kind'][] = ['projects','cards','cards',...Array<Change['kind']>(6).fill('topics'),'sources','occurrences','occurrences','relations'];
    const summary = summarizeChanges(kinds.map(kind => ({ kind, id: kind, name: kind, operation: 'add', fields: [] })));
    expect(summary).toEqual({ counts: { projects:1, topics:6, cards:2, sources:1, occurrences:2, relations:1 }, questions:2, supporting:11, total:13 });
  });
  it('密码有独立随机盐，正确密码通过，错误密码及非法摘要拒绝', async () => {
    const first = await hashPassword('testing-password-2026'), second = await hashPassword('testing-password-2026');
    expect(first).not.toBe(second); expect(first).not.toContain('testing-password');
    expect(await verifyPassword('testing-password-2026', first)).toBe(true);
    expect(await verifyPassword('wrong-password', first)).toBe(false);
    expect(await verifyPassword('wrong-password', null)).toBe(false);
    expect(await verifyPassword('wrong-password', 'scrypt-v1$invalid$invalid')).toBe(false);
  });
  it('线上会话限定主机，并禁止脚本读取 Cookie', () => {
    const cookie = sessionCookie(new Request('https://app.example.com'), { APP_ENV:'production' } as Env, 'test');
    expect(cookie).toContain('__Host-interview_session='); expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).not.toContain('Domain=');
  });
});
