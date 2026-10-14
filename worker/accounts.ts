import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../shared/model';
import { assertAdmin, authenticateAccess, resolveIdentity, sessionCookie, sessionToken, tokenHash, userIdentity, type Env, type Identity, type UserRow } from './auth';
import { hashPassword, verifyPassword } from './password';

const routes = new Hono<{ Bindings: Env; Variables: { identity: Identity } }>();
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const password = z.string().min(12, '密码至少 12 个字符').max(128, '密码最多 128 个字符');
const registration = z.object({ email, password, display_name: z.string().trim().min(1).max(40) }).strict();
const credentials = z.object({ email, password: z.string().min(1).max(128) }).strict();
routes.get('/bootstrap-admin/identity', async c => c.json(await resolveIdentity(await authenticateAccess(c.req.raw, c.env), c.req.raw, c.env)));
async function input(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError(415, '请通过页面提交');
  const text = await request.text(); if (text.length > 8192) throw new AppError(413, '表单内容过长'); return JSON.parse(text);
}
async function limit(env: Env, request: Request, action: string, account = '') {
  const now = Date.now(), windowStart = Math.floor(now / 900000) * 900000;
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  for (const [label, value, maximum] of [['ip', ip, action === 'register' ? 12 : 60], ['account', account, 12]] as const) {
    if (!value) continue;
    const key = await tokenHash(`${action}:${label}:${value}`);
    const row = await env.DB.prepare('INSERT INTO auth_limits(key,window_start,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.window_start=excluded.window_start THEN auth_limits.attempts+1 ELSE 1 END,window_start=excluded.window_start RETURNING attempts').bind(key, windowStart).first<{ attempts: number }>();
    if (!row || row.attempts > maximum) throw new AppError(429, '尝试次数过多，请 15 分钟后重试', 'RATE_LIMITED');
  }
  await env.DB.prepare('DELETE FROM auth_limits WHERE window_start<?').bind(windowStart - 86400000).run();
}
async function newSession(env: Env, userId: string) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(v => v.toString(16).padStart(2, '0')).join('');
  const now = new Date().toISOString(), expires = new Date(Date.now() + 30 * 86400000).toISOString();
  return { token, statement: env.DB.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await tokenHash(token), userId, now, expires) };
}
routes.get('/api/v1/auth/status', async c => {
  const setting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key='registration_open'").first<{ value: string }>();
  const admin = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id='admin'").first<{ password_hash: string | null }>();
  return c.json({ registration_open: setting?.value === 'true', admin_ready: Boolean(admin?.password_hash) });
});
routes.post('/api/v1/auth/register', async c => {
  const value = registration.parse(await input(c.req.raw));
  await limit(c.env, c.req.raw, 'register', value.email);
  const setting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key='registration_open'").first<{ value: string }>();
  if (setting?.value !== 'true') throw new AppError(403, '管理员暂时关闭了新用户注册', 'REGISTRATION_CLOSED');
  if (value.email === c.env.OWNER_EMAIL.toLowerCase()) throw new AppError(409, '这个账号已保留，请登录或使用管理员验证入口', 'ACCOUNT_EXISTS');
  if (await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(value.email).first()) throw new AppError(409, '这个账号已经注册，请直接登录', 'ACCOUNT_EXISTS');
  const user: UserRow = { id: crypto.randomUUID(), email: value.email, display_name: value.display_name, role: 'member', status: 'active', password_hash: await hashPassword(value.password), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const session = await newSession(c.env, user.id);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users(id,email,display_name,role,status,password_hash,created_at,updated_at) VALUES (?,?,?,\'member\',\'active\',?,?,?)').bind(user.id, user.email, user.display_name, user.password_hash, user.created_at, user.updated_at),
      c.env.DB.prepare('INSERT INTO user_library_meta(user_id,revision) VALUES (?,0)').bind(user.id), session.statement,
    ]);
  } catch (error) { if (String(error).includes('users.email')) throw new AppError(409, '这个账号已经注册，请直接登录', 'ACCOUNT_EXISTS'); throw error; }
  c.header('Set-Cookie', sessionCookie(c.req.raw, c.env, session.token));
  return c.json(userIdentity(user, c.req.raw, c.env));
});
routes.post('/api/v1/auth/login', async c => {
  const value = credentials.parse(await input(c.req.raw)); await limit(c.env, c.req.raw, 'login', value.email);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(value.email).first<UserRow>();
  if (!await verifyPassword(value.password, user?.password_hash ?? null) || !user) throw new AppError(401, '账号或密码不正确', 'BAD_CREDENTIALS');
  if (user.status !== 'active') throw new AppError(403, '账户已停用，请联系管理员', 'ACCOUNT_DISABLED');
  const session = await newSession(c.env, user.id); await session.statement.run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(new Date().toISOString()).run();
  c.header('Set-Cookie', sessionCookie(c.req.raw, c.env, session.token)); return c.json(userIdentity(user, c.req.raw, c.env));
});
routes.post('/api/v1/auth/logout', async c => {
  const token = sessionToken(c.req.raw, c.env);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await tokenHash(token)).run();
  c.header('Set-Cookie', sessionCookie(c.req.raw, c.env, '', 0)); return c.json({ ok: true });
});
routes.post('/bootstrap-admin/claim', async c => {
  // This endpoint always verifies the owner's signed Access assertion, even with a member session.
  const identity = await authenticateAccess(c.req.raw, c.env);
  if (identity.role !== 'owner') throw new AppError(403, '需要管理员邮箱验证');
  const value = z.object({ password, display_name: z.string().trim().min(1).max(40).default('管理员') }).strict().parse(await input(c.req.raw));
  await limit(c.env, c.req.raw, 'bootstrap', c.env.OWNER_EMAIL);
  const stored = await c.env.DB.prepare("SELECT * FROM users WHERE id='admin'").first<UserRow>();
  if (!stored || stored.password_hash) throw new AppError(409, '管理员已设置密码，请使用账号密码登录', 'ADMIN_ALREADY_READY');
  const hash = await hashPassword(value.password), now = new Date().toISOString(), session = await newSession(c.env, 'admin');
  // Guard concurrent claims; a failed guard rolls back both password and session.
  const guard = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO user_mutation_guard(user_id,id,ok) VALUES ('admin',?,CASE WHEN (SELECT password_hash FROM users WHERE id='admin') IS NULL THEN 1 ELSE 0 END)").bind(guard),
    c.env.DB.prepare("UPDATE users SET email=?,display_name=?,password_hash=?,updated_at=? WHERE id='admin' AND password_hash IS NULL").bind(c.env.OWNER_EMAIL.toLowerCase(), value.display_name, hash, now), session.statement,
    c.env.DB.prepare("DELETE FROM user_mutation_guard WHERE user_id='admin' AND id=?").bind(guard),
  ]);
  c.header('Set-Cookie', sessionCookie(c.req.raw, c.env, session.token)); return c.json({ ok: true });
});
routes.post('/api/v1/account/password', async c => {
  const identity = c.get('identity');
  const value = z.object({ current_password: z.string().min(1).max(128), password }).strict().parse(await input(c.req.raw));
  await limit(c.env, c.req.raw, 'password', identity.user_id);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(identity.user_id).first<UserRow>();
  if (!user || !await verifyPassword(value.current_password, user.password_hash)) throw new AppError(401, '当前密码不正确', 'BAD_PASSWORD');
  const hash = await hashPassword(value.password), session = await newSession(c.env, user.id), guard = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT password_hash FROM users WHERE id=?)=? THEN 1 ELSE 0 END)').bind(user.id, guard, user.id, user.password_hash),
    c.env.DB.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(hash, new Date().toISOString(), user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id), session.statement,
    c.env.DB.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(user.id, guard),
  ]);
  c.header('Set-Cookie', sessionCookie(c.req.raw, c.env, session.token)); return c.json({ ok: true });
});
routes.get('/api/v1/admin/users', async c => {
  assertAdmin(c.get('identity'));
  const result = await c.env.DB.prepare('SELECT id,email,display_name,role,status,created_at,updated_at FROM users ORDER BY created_at').all();
  return c.json(result.results.map(user => ({ ...user, email: user.email ?? c.env.OWNER_EMAIL })));
});
routes.put('/api/v1/admin/users/:id', async c => {
  assertAdmin(c.get('identity'));
  const value = z.object({ status: z.enum(['active','disabled']), expected_updated_at: z.string() }).strict().parse(await input(c.req.raw));
  if (c.req.param('id') === 'admin') throw new AppError(422, '管理员账户不能在这里停用');
  const result = await c.env.DB.prepare("UPDATE users SET status=?,updated_at=? WHERE id=? AND role='member' AND updated_at=?").bind(value.status, new Date().toISOString(), c.req.param('id'), value.expected_updated_at).run();
  if (!result.meta.changes) throw new AppError(409, '用户不存在或已经更新，请刷新列表', 'REVISION_CONFLICT');
  if (value.status === 'disabled') await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
routes.put('/api/v1/admin/registration', async c => {
  assertAdmin(c.get('identity'));
  const value = z.object({ registration_open: z.boolean() }).strict().parse(await input(c.req.raw));
  await c.env.DB.prepare("UPDATE app_settings SET value=? WHERE key='registration_open'").bind(String(value.registration_open)).run();
  return c.json(value);
});
export default routes;
