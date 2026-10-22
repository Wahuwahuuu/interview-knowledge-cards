import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, canonical } from '../shared/model';
import { mergeOperation, syncOperationSchema, type SyncSnapshot, type SyncResult } from '../shared/sync';
import { authenticate, resolveIdentity, type Env } from '../worker/auth';
import { batchView, type BatchRow } from '../worker/imports';
import { commitLibrary, exportLibrary, readLibrary } from '../worker/store';
import type { LocalDatabase } from './database';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
type Device = { id: string; user_id: string; name: string };
export class SyncServer {
  private attempts = new Map<string, { time: number; count: number }>();
  constructor(private db: LocalDatabase, private env: Env, private desktopOrigin: string, private info: () => unknown) {}
  private epoch(user: string) { return String(this.db.raw.prepare('SELECT epoch FROM sync_state WHERE user_id=?').get(user)?.epoch); }
  private cursor(user: string) { return Number(this.db.raw.prepare('SELECT coalesce(max(seq),0) AS cursor FROM sync_log WHERE user_id=?').get(user)?.cursor); }
  async snapshot(user: string): Promise<SyncSnapshot> {
    return this.db.transaction(async () => {
      const library = await new Response(await exportLibrary(this.db.asD1(), user)).json() as SyncSnapshot['library'];
      const imports = (await this.db.prepare('SELECT * FROM user_import_batches WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user).all<BatchRow>()).results.map(batchView);
      return { library, imports, epoch: this.epoch(user), cursor: this.cursor(user) };
    });
  }
  private async device(request: Request): Promise<Device> {
    const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const row = token && this.db.raw.prepare("SELECT d.id,d.user_id,d.name FROM sync_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND u.status='active'").get(hash(token));
    if (!row) throw new AppError(401, '设备未配对或已被撤销。离线修改仍保留，请重新配对。', 'PAIRING_REQUIRED');
    this.db.raw.prepare('UPDATE sync_devices SET last_seen=? WHERE id=?').run(new Date().toISOString(), row.id);
    return row as Device;
  }
  private async desktop(request: Request) {
    if (new URL(request.url).origin !== this.desktopOrigin) throw new AppError(403, '请在电脑客户端中操作');
    return resolveIdentity(await authenticate(request, this.env), request, this.env);
  }
  async handle(request: Request, remoteAddress = ''): Promise<Response | undefined> {
    const url = new URL(request.url), path = url.pathname;
    const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { 'Cache-Control': 'no-store' } });
    if (path === '/api/v1/runtime') return json({ mode: url.origin === this.desktopOrigin ? 'desktop' : 'phone', pairing: true });
    if (!path.startsWith('/api/v1/sync/') && !path.startsWith('/api/v1/desktop/')) return;
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) throw new AppError(403, '连接来源不正确', 'BAD_ORIGIN');
    if (path.startsWith('/api/v1/desktop/')) {
      const identity = await this.desktop(request), user = identity.user_id;
      if (path === '/api/v1/desktop/revision' && request.method === 'GET') return json({ revision: this.db.raw.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').get(user)?.revision, epoch: this.epoch(user) });
      if (path === '/api/v1/desktop/status' && request.method === 'GET') return json({ info: this.info(), devices: this.db.raw.prepare('SELECT id,name,created_at,last_seen FROM sync_devices WHERE user_id=? ORDER BY created_at').all(user) });
      if (path === '/api/v1/desktop/pair' && request.method === 'POST') {
        const code = Array.from({ length: 3 }, () => String(randomInt(0, 10000)).padStart(4, '0')).join('');
        this.db.raw.prepare('DELETE FROM sync_pairing WHERE expires<? OR user_id=?').run(Date.now(), user);
        this.db.raw.prepare('INSERT INTO sync_pairing VALUES (?,?,?)').run(hash(code), user, Date.now() + 300000);
        return json({ code: code.match(/.{4}/g)!.join(' '), expires: new Date(Date.now() + 300000).toISOString() });
      }
      if (path === '/api/v1/desktop/revoke' && request.method === 'POST') {
        const input = z.object({ id: z.string().max(128), confirmed: z.literal(true) }).strict().parse(await request.json());
        this.db.raw.prepare('DELETE FROM sync_devices WHERE user_id=? AND id=?').run(user, input.id); return json({ ok: true });
      }
      throw new AppError(404, '接口不存在');
    }
    if (path === '/api/v1/sync/pair' && request.method === 'POST') {
      const key = remoteAddress || 'unknown', old = this.attempts.get(key), now = Date.now();
      const attempt = old && now - old.time < 300000 ? old : { time: now, count: 0 };
      attempt.count++; this.attempts.set(key, attempt);
      if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value!);
      if (attempt.count > 10) throw new AppError(429, '配对尝试过多，请五分钟后再试');
      const input = z.object({ code: z.string().max(32), name: z.string().trim().min(1).max(80) }).strict().parse(await request.json());
      const code = input.code.replace(/\s/g, ''), stored = this.db.raw.prepare("SELECT p.user_id FROM sync_pairing p JOIN users u ON u.id=p.user_id WHERE p.hash=? AND p.expires>? AND u.status='active'").get(hash(code), now);
      if (!stored) throw new AppError(401, '配对码错误或已过期，请在电脑上重新生成');
      const token = randomToken(), deviceId = crypto.randomUUID(), date = new Date().toISOString(), user = String(stored.user_id);
      return this.db.transaction(async () => {
        this.db.raw.prepare('INSERT INTO sync_devices VALUES (?,?,?,?,?,?)').run(deviceId, user, input.name, hash(token), date, date);
        this.db.raw.prepare('DELETE FROM sync_pairing WHERE hash=?').run(hash(code));
        const account = this.db.raw.prepare('SELECT id AS user_id,email,display_name,role FROM users WHERE id=?').get(user)!;
        return json({ token, deviceId, account: { ...account, email: account.email ?? this.env.OWNER_EMAIL, local: true, needs_password_setup: false }, snapshot: await this.snapshot(user) });
      });
    }
    const device = await this.device(request), user = device.user_id;
    if (path === '/api/v1/sync/snapshot' && request.method === 'GET') return json(await this.snapshot(user));
    if (path === '/api/v1/sync/pull' && request.method === 'GET') {
      if (url.searchParams.get('epoch') !== this.epoch(user)) throw new AppError(409, '电脑题库已从完整备份恢复。手机修改仍保留，请处理后重新接收题库。', 'EPOCH_CHANGED');
      const cursor = Number(url.searchParams.get('cursor'));
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.cursor(user)) throw new AppError(422, '同步游标无效');
      const logs = this.db.raw.prepare('SELECT seq,kind,id,payload FROM sync_log WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500').all(user, cursor);
      const next = logs.length ? Number(logs.at(-1)!.seq) : cursor;
      return json({ logs, cursor: next, more: next < this.cursor(user), revision: (await readLibrary(this.db.asD1(), user)).revision });
    }
    if (path === '/api/v1/sync/push' && request.method === 'POST') {
      const operation = syncOperationSchema.parse(await request.json()), digest = hash(canonical(operation));
      // Receipts must be checked before the epoch: a lost acknowledgement may straddle a restore.
      const receipt = this.db.raw.prepare('SELECT digest,result FROM sync_receipts WHERE user_id=? AND device_id=? AND op_id=?').get(user, device.id, operation.id);
      if (receipt) { if (receipt.digest !== digest) throw new AppError(409, '同步操作编号已用于其他内容'); return json(JSON.parse(String(receipt.result))); }
      if (operation.epoch !== this.epoch(user)) throw new AppError(409, '题库已恢复，请处理手机待同步内容', 'EPOCH_CHANGED');
      return this.db.transaction(async () => {
        const base = await readLibrary(this.db.asD1(), user), merged = mergeOperation(base, operation);
        const result: SyncResult = { id: operation.id, status: merged.conflicts.length ? 'conflict' : 'applied', conflicts: merged.conflicts };
        if (!merged.conflicts.length) {
          await commitLibrary(this.db.asD1(), user, base, merged.target);
          if (operation.record !== undefined) {
            const record = z.object({ id: z.string().max(128), created_at: z.string(), preview: z.array(z.unknown()).max(10000) }).passthrough().parse(operation.record);
            this.db.raw.prepare("INSERT OR IGNORE INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,applied_at,payload,preview) VALUES (?,?,'applied',?,?,?,?,?,?)")
              .run(user, record.id, base.revision, digest, record.created_at, new Date().toISOString(), JSON.stringify(operation.input ?? { schema_version: 1 }), JSON.stringify(record.preview));
          }
          this.db.raw.prepare('INSERT INTO sync_receipts VALUES (?,?,?,?,?)').run(user, device.id, operation.id, digest, JSON.stringify(result));
        }
        return json(result);
      });
    }
    throw new AppError(404, '接口不存在');
  }
}
