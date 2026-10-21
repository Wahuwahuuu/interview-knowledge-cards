import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '../shared/model';
export type Env = { DB: D1Database; ASSETS: Fetcher; APP_ENV: string; OWNER_EMAIL: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; AGENT_ACCESS_AUD?: string };
export type Identity = { role: 'owner' | 'admin' | 'member' | 'agent'; email: string; subject: string; local: boolean; user_id: string; display_name?: string; needs_password_setup?: boolean; via?: 'session' | 'access' | 'local' };
export type UserRow = { id: string; email: string | null; display_name: string; role: 'admin' | 'member'; status: 'active' | 'disabled'; password_hash: string | null; created_at: string; updated_at: string };
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const isLoopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
export const localMode = (request: Request, env: Env) => env.APP_ENV === 'local' && isLoopback(request.url);
export const cookieName = (request: Request, env: Env) => localMode(request, env) ? 'interview_session_local' : '__Host-interview_session';
export async function tokenHash(token: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).map(v => v.toString(16).padStart(2, '0')).join(''); }
export function sessionToken(request: Request, env: Env) { return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName(request, env) + '='))?.slice(cookieName(request, env).length + 1); }
export function sessionCookie(request: Request, env: Env, token: string, maxAge = 30 * 86400) { return `${cookieName(request, env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${localMode(request, env) ? '' : '; Secure'}`; }
export function userIdentity(user: UserRow, request: Request, env: Env, via: Identity['via'] = 'session'): Identity { return { role: user.role, email: user.email ?? env.OWNER_EMAIL.toLowerCase(), subject: user.id, user_id: user.id, display_name: user.display_name, needs_password_setup: !user.password_hash, local: localMode(request, env), via }; }
export function authorizePayload(payload: JWTPayload, agent: boolean, ownerEmail: string): Identity {
  if (agent) {
    if (typeof payload.common_name !== 'string' || !payload.common_name || payload.email) throw new AppError(403, '机器入口需要独立服务凭证', 'FORBIDDEN');
    return { role: 'agent', email: '', subject: String(payload.sub ?? payload.common_name), user_id: 'admin', local: false, via: 'access' };
  }
  if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== ownerEmail.toLowerCase() || payload.common_name) throw new AppError(403, '这个邮箱没有管理员验证权限', 'FORBIDDEN');
  return { role: 'owner', email: payload.email.toLowerCase(), subject: String(payload.sub ?? payload.email), user_id: 'admin', local: false, via: 'access' };
}
export async function authenticateAccess(request: Request, env: Env, agent = false): Promise<Identity> {
  if (localMode(request, env)) return { role: agent ? 'agent' : 'owner', email: agent ? '' : env.OWNER_EMAIL.toLowerCase(), subject: 'local-preview', user_id: 'admin', local: true, via: 'local' };
  const domain = env.ACCESS_TEAM_DOMAIN ?? '', audience = agent ? env.AGENT_ACCESS_AUD : env.ACCESS_AUD;
  if (!/^[a-zA-Z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience || !env.OWNER_EMAIL) throw new AppError(503, '访问尚未配置完成，请先完成部署设置', 'AUTH_NOT_CONFIGURED');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new AppError(401, '请登录后继续', 'UNAUTHENTICATED');
  try {
    let keys = keySets.get(domain);
    if (!keys) { keys = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`)); keySets.set(domain, keys); }
    const { payload } = await jwtVerify(token, keys, { issuer: `https://${domain}`, audience, algorithms: ['RS256'] });
    return authorizePayload(payload, agent, env.OWNER_EMAIL);
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED'); }
}
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  if (new URL(request.url).pathname.startsWith('/api/v1/agent/')) return authenticateAccess(request, env, true);
  // Invalid sessions cannot fall back to the legacy administrator identity.
  const token = sessionToken(request, env);
  if (token !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED');
    const user = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await tokenHash(token), new Date().toISOString()).first<UserRow>();
    if (!user) throw new AppError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED');
    if (user.status !== 'active') throw new AppError(403, '账户已停用，请联系管理员', 'ACCOUNT_DISABLED');
    return userIdentity(user, request, env);
  }
  if (localMode(request, env) && request.headers.get('x-require-auth') !== '1') {
    return authenticateAccess(request, env, request.headers.get('x-local-role') === 'agent');
  }
  if (request.headers.has('cf-access-jwt-assertion')) return authenticateAccess(request, env);
  if (!localMode(request, env) && (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)) throw new AppError(503, '访问尚未配置完成，请先完成部署设置', 'AUTH_NOT_CONFIGURED');
  throw new AppError(401, '请使用邮箱和密码登录', 'UNAUTHENTICATED');
}
export async function resolveIdentity(identity: Identity, request: Request, env: Env) {
  if (identity.role !== 'owner') return identity;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id='admin'").first<UserRow>();
  if (!user || user.status !== 'active') throw new AppError(503, '管理员账户尚未初始化');
  return userIdentity(user, request, env, identity.via);
}
export function assertOwner(identity: Identity) { if (identity.role === 'agent') throw new AppError(403, '机器凭证请使用专用查询和普通导入入口，不能调用人工管理接口', 'FORBIDDEN'); }
export function assertAdmin(identity: Identity) { if (identity.role !== 'admin') throw new AppError(403, '这个操作需要管理员权限', 'FORBIDDEN'); }
export function assertOrigin(request: Request, env: Env) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (localMode(request, env) && (!origin || isLoopback(origin))) return;
  if (origin !== new URL(request.url).origin) throw new AppError(403, '请在题库页面内完成这个操作', 'BAD_ORIGIN');
}
