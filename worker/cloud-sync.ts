import { z } from 'zod';
import { AppError, canonical } from '../shared/model';
import { mergeOperation, syncOperationSchema, type SyncResult } from '../shared/sync';
import type { CloudAccount, CloudLinkReply, CloudSnapshot } from '../shared/cloud-sync';
import { tokenHash, type Env, type Identity } from './auth';
import { commitLibrary, readLibrary } from './store';

const prefix = '/api/v1/device-sync/';
const protocol = new Set(['connect','snapshot','push','disconnect']);
export const isCloudSyncProtocol = (path: string) => path.startsWith(prefix) && protocol.has(path.slice(prefix.length));
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer' } });
async function input(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError(415,'请提交 JSON 数据');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 8*1024*1024) throw new AppError(413,'单次同步内容过大，请分批整理；本地修改仍保留');
  return JSON.parse(text);
}
async function head(env: Env, user: string) {
  const row = await env.DB.prepare('SELECT s.epoch,m.revision FROM cloud_sync_state s JOIN user_library_meta m ON m.user_id=s.user_id WHERE s.user_id=?').bind(user).first<{epoch:string;revision:number}>();
  if (!row) throw new AppError(503,'网站同步尚未准备好，请检查数据库迁移');
  return row;
}
async function device(request: Request, env: Env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const row = token && await env.DB.prepare("SELECT d.id,d.user_id FROM cloud_sync_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND d.expires_at>? AND u.status='active'").bind(await tokenHash(token),new Date().toISOString()).first<{id:string;user_id:string}>();
  if (!row) throw new AppError(401,'网站连接已过期或已撤销，本地修改仍保留，请重新连接','CLOUD_RECONNECT');
  await env.DB.prepare('UPDATE cloud_sync_devices SET last_seen=? WHERE id=? AND last_seen<?').bind(new Date().toISOString(),row.id,new Date(Date.now()-300000).toISOString()).run();
  return row;
}
export async function handleCloudSync(request: Request, env: Env, identity?: Identity): Promise<Response> {
  if (env.APP_ENV === 'desktop') throw new AppError(403,'请在已登录的线上网站管理连接码');
  const url = new URL(request.url), action = url.pathname.slice(prefix.length);
  if (!protocol.has(action)) {
    if (!identity || !['admin','member'].includes(identity.role) || identity.needs_password_setup || identity.via !== 'session' && env.APP_ENV !== 'local') throw new AppError(403,'请先登录网站账号并设置密码','FORBIDDEN');
    const user = identity.user_id;
    if (action === 'devices' && request.method === 'GET') {
      const devices = await env.DB.prepare('SELECT id,name,created_at,last_seen,expires_at FROM cloud_sync_devices WHERE user_id=? ORDER BY created_at').bind(user).all();
      return json({devices:devices.results});
    }
    if (action === 'code' && request.method === 'POST') {
      z.object({}).strict().parse(await input(request));
      const code = randomToken(), expires = Date.now()+300000;
      await env.DB.prepare('INSERT INTO cloud_sync_codes(user_id,token_hash,expires_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at').bind(user,await tokenHash(code),expires).run();
      return json({code,expires:new Date(expires).toISOString()});
    }
    if (action === 'revoke' && request.method === 'POST') {
      const value = z.object({id:z.string().max(128),confirmed:z.literal(true)}).strict().parse(await input(request));
      await env.DB.prepare('DELETE FROM cloud_sync_devices WHERE user_id=? AND id=?').bind(user,value.id).run();
      return json({ok:true});
    }
    throw new AppError(404,'网站同步接口不存在');
  }
  if (action === 'connect' && request.method === 'POST') {
    const value = z.object({code:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().trim().min(1).max(80)}).strict().parse(await input(request));
    const key = await tokenHash(value.code), token = randomToken(), id = crypto.randomUUID(), now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_sync_devices(id,user_id,name,token_hash,created_at,last_seen,expires_at) SELECT ?,c.user_id,?,?,?,?,? FROM cloud_sync_codes c JOIN users u ON u.id=c.user_id WHERE c.token_hash=? AND c.expires_at>? AND u.status='active'").bind(id,value.name,await tokenHash(token),now,now,new Date(Date.now()+365*86400000).toISOString(),key,Date.now()),
      env.DB.prepare('DELETE FROM cloud_sync_codes WHERE token_hash=?').bind(key),
    ]);
    if (results[0].meta.changes !== 1) throw new AppError(401,'连接码错误、已使用或已过期，请在网站重新生成','INVALID_CONNECTION_CODE');
    const account = await env.DB.prepare('SELECT u.id AS user_id,u.email,u.display_name FROM users u JOIN cloud_sync_devices d ON d.user_id=u.id WHERE d.id=?').bind(id).first<CloudAccount>();
    if(!account)throw new AppError(401,'账号已不可用，请重新连接');
    return json({token,deviceId:id,account} satisfies CloudLinkReply);
  }
  const linked = await device(request,env), user = linked.user_id;
  if (action === 'snapshot' && request.method === 'GET') {
    const meta = await head(env,user);
    if (url.searchParams.get('revision') === String(meta.revision) && url.searchParams.get('epoch') === meta.epoch) return json({...meta,unchanged:true} satisfies CloudSnapshot);
    const library = await readLibrary(env.DB,user), after = await head(env,user);
    if (library.revision !== after.revision || meta.epoch !== after.epoch) throw new AppError(409,'网站刚有更新，将自动重新读取','SNAPSHOT_CHANGED');
    return json({...after,library} satisfies CloudSnapshot);
  }
  if (action === 'disconnect' && request.method === 'POST') {
    z.object({confirmed:z.literal(true)}).strict().parse(await input(request));
    await env.DB.prepare('DELETE FROM cloud_sync_devices WHERE user_id=? AND id=?').bind(user,linked.id).run();
    return json({ok:true});
  }
  if (action === 'push' && request.method === 'POST') {
    const operation = syncOperationSchema.parse(await input(request));
    if (operation.record !== undefined || operation.input !== undefined) throw new AppError(403,'网站同步仅接受题库修改，不接受导入记录或账户操作');
    const digest = await tokenHash(canonical(operation));
    const receipt = await env.DB.prepare('SELECT digest,result FROM cloud_sync_receipts WHERE user_id=? AND device_id=? AND op_id=?').bind(user,linked.id,operation.id).first<{digest:string;result:string}>();
    if (receipt) { if(receipt.digest!==digest) throw new AppError(409,'操作编号已用于其他内容'); return json(JSON.parse(receipt.result)); }
    const meta = await head(env,user);
    if (meta.epoch !== operation.epoch) throw new AppError(409,'网站题库已恢复备份，需要重新核对；本地修改仍保留','CLOUD_EPOCH_CHANGED');
    const base = await readLibrary(env.DB,user), merged = mergeOperation(base,operation);
    const result: SyncResult = {id:operation.id,status:merged.conflicts.length?'conflict':'applied',conflicts:merged.conflicts};
    if (!merged.conflicts.length) {
      const guard = crypto.randomUUID();
      await commitLibrary(env.DB,user,base,merged.target,{extra:[
        env.DB.prepare("INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT epoch FROM cloud_sync_state WHERE user_id=?)=? AND EXISTS(SELECT 1 FROM cloud_sync_devices d JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.user_id=? AND u.status='active' AND d.expires_at>?) THEN 1 ELSE 0 END)").bind(user,guard,user,operation.epoch,linked.id,user,new Date().toISOString()),
        env.DB.prepare('INSERT INTO cloud_sync_receipts(user_id,device_id,op_id,digest,result) VALUES (?,?,?,?,?)').bind(user,linked.id,operation.id,digest,JSON.stringify(result)),
        env.DB.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(user,guard),
      ]});
    }
    return json(result);
  }
  throw new AppError(404,'网站同步接口不存在');
}
