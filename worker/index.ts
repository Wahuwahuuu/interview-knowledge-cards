import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, canonical, diffLibraries, graphElements, importSchema, kinds, markdownExport, prepareImport, projectSnapshot, schemas, type Entity, type ImportBatch, type ImportEnvelope, type Kind, type Library } from '../shared/model';
import { assertOrigin, assertOwner, authenticate, resolveIdentity, type Env, type Identity } from './auth';
import { commitLibrary, readLibrary } from './store';
import accountRoutes from './accounts';
import { removeCard } from '../shared/card-actions';
import { removeProject } from '../shared/project-actions';

const app = new Hono<{ Bindings: Env; Variables: { identity: Identity } }>();
app.onError((error, c) => {
  if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_DATA', message: '导入或表单格式不正确', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } }, 422);
  if (error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_JSON', message: '文件不是有效的 JSON' } }, 422);
  console.error(JSON.stringify({ event: 'request_failed', path: c.req.path, type: error.name }));
  return c.json({ error: { code: 'SERVER_ERROR', message: '保存或读取失败，请重试；若刚部署，请检查数据库迁移是否完成' } }, 500);
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Cache-Control', 'private, no-store');
  if (!c.req.path.startsWith('/api/') || c.req.path === '/api/health' || ['/api/v1/auth/status','/api/v1/auth/login','/api/v1/auth/register','/api/v1/auth/logout'].includes(c.req.path)) { assertOrigin(c.req.raw, c.env); await next(); return; }
  const identity = await authenticate(c.req.raw, c.env);
  if (!c.req.path.startsWith('/api/v1/agent/')) {
    assertOwner(identity);
    assertOrigin(c.req.raw, c.env);
  }
  c.set('identity', await resolveIdentity(identity, c.req.raw, c.env));
  await next();
});
app.get('/api/health', c => c.json({ ok: true }));
app.route('/', accountRoutes);

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError(415, '请使用 application/json 提交数据');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8 * 1024 * 1024) throw new AppError(413, '单批数据不能超过 8 MB，请拆分导入');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(422, 'JSON 顶层应是对象');
  return value;
}
function expectedRevision(input: Record<string, unknown>, library: Library) {
  if (typeof input.expected_revision !== 'number' || input.expected_revision !== library.revision) throw new AppError(409, '题库已更新，请刷新后重新编辑或预览', 'REVISION_CONFLICT');
}
type BatchRow = { id: string; status: ImportBatch['status']; base_revision: number; created_at: string; applied_at: string | null; digest: string; payload: string; preview: string };
function batchView(row: BatchRow): ImportBatch { return { id: row.id, status: row.status, base_revision: row.base_revision, created_at: row.created_at, applied_at: row.applied_at, mode: JSON.parse(row.payload).mode, preview: JSON.parse(row.preview) }; }
async function getBatch(db: D1Database, userId: string, id: string) {
  const row = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId,id).first<BatchRow>();
  if (!row) throw new AppError(404, '导入批次不存在');
  return row;
}
async function draft(db: D1Database, userId: string, input: unknown, role: Identity['role']) {
  const envelope = importSchema.parse(input);
  if (role === 'agent' && envelope.mode !== 'merge') throw new AppError(403, '机器入口只允许提交普通导入草稿，完整恢复请在网页操作', 'FORBIDDEN');
  const library = await readLibrary(db, userId);
  const target = prepareImport(library, envelope);
  const preview = diffLibraries(library, target);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ ...envelope, batch_id: undefined }))))).map(v => v.toString(16).padStart(2, '0')).join('');
  const id = envelope.batch_id ?? crypto.randomUUID();
  const previous = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId,id).first<BatchRow>();
  if (previous && previous.digest !== digest) throw new AppError(409, '这个批次 ID 已用于其他内容，请更换批次 ID', 'BATCH_ID_REUSED');
  if (previous?.status === 'applied') return batchView(previous);
  if (previous?.status === 'cancelled') throw new AppError(409, '批次已取消，请使用新的批次 ID');
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,payload,preview) VALUES (?,?,'pending',?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET base_revision=excluded.base_revision,payload=excluded.payload,preview=excluded.preview WHERE user_import_batches.digest=excluded.digest AND user_import_batches.status='pending'").bind(userId,id, library.revision, digest, now, JSON.stringify(envelope), JSON.stringify(preview)).run();
  const saved = await getBatch(db, userId, id);
  if (saved.digest !== digest) throw new AppError(409, '这个批次 ID 已用于其他内容，请更换批次 ID', 'BATCH_ID_REUSED');
  if (saved.status === 'cancelled') throw new AppError(409, '批次已取消，请使用新的批次 ID');
  return batchView(saved);
}

app.get('/api/v1/me', c => c.json(c.get('identity')));
app.post('/api/v1/changes', async c => {
  const input = await body(c.req.raw), library = await readLibrary(c.env.DB, c.get('identity').user_id);
  expectedRevision(input, library);
  const target = prepareImport(library, importSchema.parse(input.changes));
  return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, target));
});
app.get('/api/v1/library', async c => c.json(await readLibrary(c.env.DB, c.get('identity').user_id)));
app.get('/api/v1/graph', async c => c.json({ elements: graphElements(await readLibrary(c.env.DB, c.get('identity').user_id), c.req.query('project_id') || undefined) }));
app.get('/api/v1/projects/:id/snapshot', async c => c.json({ downloaded_at: new Date().toISOString(), owner: c.get('identity').email, snapshot: projectSnapshot(await readLibrary(c.env.DB, c.get('identity').user_id), c.req.param('id')) }));
app.get('/api/v1/cards/:id/history', async c => c.json((await readLibrary(c.env.DB, c.get('identity').user_id)).revisions.filter(v => v.card_id === c.req.param('id')).sort((a, b) => b.revision - a.revision)));
app.post('/api/v1/cards/:id/restore', async c => {
  const input = await body(c.req.raw), library = await readLibrary(c.env.DB, c.get('identity').user_id);
  expectedRevision(input, library);
  const card = library.cards.find(v => v.id === c.req.param('id'));
  const entry = library.revisions.find(v => v.card_id === card?.id && v.revision === input.card_revision);
  if (!card || !entry) throw new AppError(404, '卡片或历史版本不存在');
  const target = structuredClone(library);
  const restored = { ...entry.snapshot, favorite: card.favorite, important: card.important, mastery: card.mastery, revision: card.revision + 1, updated_at: new Date().toISOString() };
  target.cards[target.cards.findIndex(v => v.id === card.id)] = restored;
  target.revisions.push({ card_id: card.id, revision: restored.revision, saved_at: restored.updated_at, action: `恢复版本 ${entry.revision}`, snapshot: restored });
  return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, target));
});

for (const kind of kinds) {
  app.get(`/api/v1/${kind}`, async c => c.json((await readLibrary(c.env.DB, c.get('identity').user_id))[kind]));
  app.put(`/api/v1/${kind}/:id`, async c => {
    const input = await body(c.req.raw), library = await readLibrary(c.env.DB, c.get('identity').user_id);
    expectedRevision(input, library);
    const value = schemas[kind].parse(input.value) as Entity;
    if (value.id !== c.req.param('id')) throw new AppError(422, '路径与记录 ID 不一致');
    const old = (library[kind] as Entity[]).find(v => v.id === value.id);
    if (old && value.revision !== old.revision) throw new AppError(409, '此记录已有新版本，请刷新后再修改', 'REVISION_CONFLICT');
    const envelope = importSchema.parse({ schema_version: 1, [kind]: [value] });
    const target = prepareImport(library, envelope);
    return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, target));
  });
  app.delete(`/api/v1/${kind}/:id`, async c => {
    const input = await body(c.req.raw), library = await readLibrary(c.env.DB, c.get('identity').user_id);
    expectedRevision(input, library);
    if (!library[kind].some(v => v.id === c.req.param('id'))) throw new AppError(404, '记录不存在');
    if (kind === 'cards') return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, removeCard(library, c.req.param('id'))));
    if (kind === 'projects') return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, removeProject(library, c.req.param('id'))));
    if (kind === 'sources' || kind === 'occurrences') throw new AppError(422, '原始问答与来源记录保留供追溯');
    const target = structuredClone(library);
    (target[kind] as Entity[]) = (target[kind] as Entity[]).filter(v => v.id !== c.req.param('id'));
    return c.json(await commitLibrary(c.env.DB, c.get('identity').user_id, library, target));
  });
}

app.get('/api/v1/imports', async c => {
  const result = await c.env.DB.prepare('SELECT * FROM user_import_batches WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(c.get('identity').user_id).all<BatchRow>();
  return c.json(result.results.map(batchView));
});
app.get('/api/v1/imports/:id', async c => c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id')))));
app.post('/api/v1/imports/preview', async c => c.json(await draft(c.env.DB, c.get('identity').user_id, await body(c.req.raw), 'owner')));
app.post('/api/v1/imports/:id/repreview', async c => {
  const batch = await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'));
  return c.json(await draft(c.env.DB, c.get('identity').user_id, JSON.parse(batch.payload), 'owner'));
});
app.post('/api/v1/imports/:id/apply', async c => {
  assertOwner(c.get('identity'));
  const input = await body(c.req.raw), batch = await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'));
  if (batch.status === 'applied') return c.json({ batch: batchView(batch), library: await readLibrary(c.env.DB, c.get('identity').user_id), already_applied: true });
  if (batch.status !== 'pending') throw new AppError(409, '这个导入批次已经取消');
  const library = await readLibrary(c.env.DB, c.get('identity').user_id);
  expectedRevision(input, library);
  if (batch.base_revision !== library.revision) throw new AppError(409, '预览后题库发生了变化，请重新预览', 'REVISION_CONFLICT');
  const envelope = importSchema.parse(JSON.parse(batch.payload));
  const target = prepareImport(library, envelope);
  const next = await commitLibrary(c.env.DB, c.get('identity').user_id, library, target, { restore: envelope.mode === 'restore', batchId: batch.id });
  return c.json({ batch: batchView(await getBatch(c.env.DB, c.get('identity').user_id, batch.id)), library: next, already_applied: false });
});
app.post('/api/v1/imports/:id/cancel', async c => {
  await c.env.DB.prepare("UPDATE user_import_batches SET status='cancelled' WHERE user_id=? AND id=? AND status='pending'").bind(c.get('identity').user_id,c.req.param('id')).run();
  return c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'))));
});
app.get('/api/v1/export', async c => {
  const library = await readLibrary(c.env.DB, c.get('identity').user_id);
  const markdown = c.req.query('format') === 'markdown';
  c.header('Content-Disposition', `attachment; filename="interview-cards-${new Date().toISOString().slice(0, 10)}.${markdown ? 'md' : 'json'}"`);
  if (markdown) { c.header('Content-Type', 'text/markdown; charset=utf-8'); return c.body(markdownExport(library)); }
  return c.json({ ...library, mode: 'restore', exported_at: new Date().toISOString() });
});

app.get('/api/v1/agent/library', async c => {
  const library = await readLibrary(c.env.DB, c.get('identity').user_id);
  return c.json({ ...library, revisions: [] });
});
app.get('/api/v1/agent/schema', c => c.json(z.toJSONSchema(importSchema)));
app.get('/api/v1/agent/imports/:id', async c => c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id')))));
app.post('/api/v1/agent/imports/preview', async c => c.json(await draft(c.env.DB, c.get('identity').user_id, await body(c.req.raw), 'agent')));
app.all('/api/v1/agent/*', () => { throw new AppError(403, '机器入口只提供查询及导入预览，确认请在题库页面完成', 'FORBIDDEN'); });
app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));

app.all('*', async c => {
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, { status: response.status, headers: new Headers([...response.headers, ...Object.entries({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': c.res.headers.get('Content-Security-Policy') ?? '' })]) });
});
export default app;
