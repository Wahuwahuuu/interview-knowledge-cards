import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, importSchema, kinds, markdownExport, prepareImport, schemas, type Card, type Entity, type Library } from '../shared/model';
import { assertOrigin, assertOwner, authenticate, resolveIdentity, type Env, type Identity } from './auth';
import { commitLibrary, exportLibrary, readCardHistory, readLibrary, updateCardState, updateProjectOrder } from './store';
import { cardStateRequestSchema } from '../shared/card-state';
import { projectOrderRequestSchema } from '../shared/project-order';
import accountRoutes from './accounts';
import { batchView, draft, getBatch, listBatches, submitImport } from './imports';
import { handleCloudSync, isCloudSyncProtocol } from './cloud-sync';
import { readJournal } from './change-journal';
import { cardEditRequestSchema } from '../shared/card-edit';
import { saveCardEdit } from './card-edit';
import { checkRevision, deleteRecord, libraryRevision, mutationResponse, planRecordMerge } from './record-mutations';
import { commitIncremental } from './incremental-store';
import { readRecords } from './change-journal';
import { decodeStoredRecord } from './stored-records';
import { readGraph, readProjectSnapshot } from './scoped-reads';
import { projectExport } from '../shared/project-actions';

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
  if (isCloudSyncProtocol(c.req.path)) { assertOrigin(c.req.raw,c.env); return handleCloudSync(c.req.raw,c.env); }
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
app.all('/api/v1/device-sync/*', c => handleCloudSync(c.req.raw,c.env,c.get('identity')));

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
app.get('/api/v1/me', c => c.json(c.get('identity')));
app.post('/api/v1/changes', async c => {
  const input=await body(c.req.raw),user=c.get('identity').user_id,plan=await planRecordMerge(c.env.DB,user,importSchema.parse(input.changes),{expectedRevision:input.expected_revision});
  await commitIncremental(c.env.DB,user,plan.revision,plan.changes);
  return c.json(await mutationResponse(c.env.DB,user,c.req.raw));
});
app.get('/api/v1/library', async c => c.json(await readLibrary(c.env.DB, c.get('identity').user_id)));
app.get('/api/v1/library/revision', async c => c.json(await c.env.DB.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(c.get('identity').user_id).first() ?? {revision:0}));
app.get('/api/v1/library/changes',async c=>c.json(await readJournal(c.env.DB,c.get('identity').user_id,Number(c.req.query('cursor')),c.req.query('epoch'))));
app.put('/api/v1/projects/order', async c => {
  const input = projectOrderRequestSchema.parse(await body(c.req.raw));
  return c.json(await updateProjectOrder(c.env.DB, c.get('identity').user_id, input));
});
app.patch('/api/v1/cards/:id/state', async c => {
  const input = cardStateRequestSchema.parse(await body(c.req.raw));
  return c.json(await updateCardState(c.env.DB, c.get('identity').user_id, c.req.param('id'), input));
});
app.patch('/api/v1/cards/:id', async c => {
  const input = cardEditRequestSchema.parse(await body(c.req.raw));
  return c.json(await saveCardEdit(c.env.DB, c.get('identity').user_id, c.req.param('id'), input));
});
app.get('/api/v1/graph', async c => c.json(await readGraph(c.env.DB,c.get('identity').user_id,c.req.query('project_id')||undefined)));
app.get('/api/v1/projects/:id/snapshot', async c => c.json({ downloaded_at: new Date().toISOString(), owner: c.get('identity').email, snapshot: await readProjectSnapshot(c.env.DB,c.get('identity').user_id,c.req.param('id')) }));
app.get('/api/v1/projects/:id/export',async c=>c.json(projectExport(await readProjectSnapshot(c.env.DB,c.get('identity').user_id,c.req.param('id'),true),c.req.param('id'))));
app.get('/api/v1/cards/:id/history', async c => c.json(await readCardHistory(c.env.DB, c.get('identity').user_id, c.req.param('id'))));
app.post('/api/v1/cards/:id/restore', async c => {
  const input=await body(c.req.raw),user=c.get('identity').user_id,id=c.req.param('id'),revision=await libraryRevision(c.env.DB,user);
  checkRevision(revision,input.expected_revision);
  if(typeof input.card_revision!=='number'||!Number.isInteger(input.card_revision)||input.card_revision<1)throw new AppError(404,'历史版本不存在');
  const card=(await readRecords(c.env.DB,user,[{kind:'cards',id}]))[0].value as Card|null;
  const saved=await c.env.DB.prepare('SELECT payload FROM user_card_revisions WHERE user_id=? AND card_id=? AND revision=?').bind(user,id,input.card_revision).first<{payload:string}>();
  const entry=saved?JSON.parse(saved.payload) as {snapshot:Card;revision:number}:undefined;
  if (!card || !entry) throw new AppError(404, '卡片或历史版本不存在');
  const restored = { ...entry.snapshot, favorite: card.favorite, important: card.important, mastery: card.mastery, revision: card.revision + 1, updated_at: new Date().toISOString() };
  const plan=await planRecordMerge(c.env.DB,user,importSchema.parse({schema_version:1,cards:[restored]}),{expectedRevision:input.expected_revision});
  if(!plan.changes.length)plan.changes.push({kind:'cards',id,before:card,after:restored});
  await commitIncremental(c.env.DB,user,revision,plan.changes,[],`恢复版本 ${entry.revision}`);
  return c.json(await mutationResponse(c.env.DB,user,c.req.raw));
});

for (const kind of kinds) {
  app.get(`/api/v1/${kind}`, async c => c.json((await c.env.DB.prepare(`SELECT payload FROM user_${kind} WHERE user_id=? ORDER BY id`).bind(c.get('identity').user_id).all<{payload:string}>()).results.map(row=>decodeStoredRecord(kind,row.payload))));
  app.put(`/api/v1/${kind}/:id`, async c => {
    const input = await body(c.req.raw), user=c.get('identity').user_id,revision=await libraryRevision(c.env.DB,user);
    checkRevision(revision,input.expected_revision);
    const value = schemas[kind].parse(input.value) as Entity;
    if (value.id !== c.req.param('id')) throw new AppError(422, '路径与记录 ID 不一致');
    const old = (await readRecords(c.env.DB,user,[{kind,id:value.id}]))[0].value;
    if (old && value.revision !== old.revision) throw new AppError(409, '此记录已有新版本，请刷新后再修改', 'REVISION_CONFLICT');
    const envelope = importSchema.parse({ schema_version: 1, [kind]: [value] });
    const plan=await planRecordMerge(c.env.DB,user,envelope,{expectedRevision:input.expected_revision});
    await commitIncremental(c.env.DB,user,plan.revision,plan.changes);
    return c.json(await mutationResponse(c.env.DB,user,c.req.raw));
  });
  app.delete(`/api/v1/${kind}/:id`, async c => {
    const input=await body(c.req.raw),user=c.get('identity').user_id;
    await deleteRecord(c.env.DB,user,kind,c.req.param('id'),input.expected_revision);
    return c.json(await mutationResponse(c.env.DB,user,c.req.raw));
  });
}

app.get('/api/v1/imports', async c => c.json(await listBatches(c.env.DB,c.get('identity').user_id)));
app.get('/api/v1/imports/:id', async c => c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id')))));
app.post('/api/v1/imports/submit', async c => {const user=c.get('identity').user_id,result=await submitImport(c.env.DB,user,await body(c.req.raw));return c.json(await mutationResponse(c.env.DB,user,c.req.raw,result));});
app.post('/api/v1/imports/:id/retry', async c => {
  const batch = await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'));
  const user=c.get('identity').user_id,result=await submitImport(c.env.DB,user,{...JSON.parse(batch.payload),batch_id:batch.id});
  return c.json(await mutationResponse(c.env.DB,user,c.req.raw,result));
});
app.post('/api/v1/imports/preview', async c => c.json(await draft(c.env.DB, c.get('identity').user_id, await body(c.req.raw))));
app.post('/api/v1/imports/:id/repreview', async c => {
  const batch = await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'));
  return c.json(await draft(c.env.DB, c.get('identity').user_id, { ...JSON.parse(batch.payload), batch_id: batch.id }));
});
app.post('/api/v1/imports/:id/apply', async c => {
  assertOwner(c.get('identity'));
  const input = await body(c.req.raw), batch = await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'));
  if (batch.status === 'applied') return c.json(await mutationResponse(c.env.DB,c.get('identity').user_id,c.req.raw,{batch:batchView(batch),already_applied:true}));
  if (batch.status !== 'pending') throw new AppError(409, '这个导入批次已经取消', 'IMPORT_CANCELLED');
  const envelope = importSchema.parse(JSON.parse(batch.payload));
  if(envelope.mode==='merge'){
    const user=c.get('identity').user_id,plan=await planRecordMerge(c.env.DB,user,envelope,{expectedRevision:input.expected_revision});
    checkRevision(plan.revision,batch.base_revision);
    const guard=crypto.randomUUID();
    await commitIncremental(c.env.DB,user,plan.revision,plan.changes,[c.env.DB.prepare("INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN EXISTS(SELECT 1 FROM user_import_batches WHERE user_id=? AND id=? AND status='pending' AND base_revision=?) THEN 1 ELSE 0 END)").bind(user,guard,user,batch.id,plan.revision),c.env.DB.prepare("UPDATE user_import_batches SET status='applied',applied_at=?,error_message='' WHERE user_id=? AND id=?").bind(new Date().toISOString(),user,batch.id),c.env.DB.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(user,guard)]);
    return c.json(await mutationResponse(c.env.DB,user,c.req.raw,{batch:batchView(await getBatch(c.env.DB,user,batch.id)),already_applied:false}));
  }
  const library = await readLibrary(c.env.DB, c.get('identity').user_id);
  expectedRevision(input, library);
  if (batch.base_revision !== library.revision) throw new AppError(409, '预览后题库发生了变化，请重新预览', 'REVISION_CONFLICT');
  const target = prepareImport(library, envelope);
  const next = await commitLibrary(c.env.DB, c.get('identity').user_id, library, target, { restore: envelope.mode === 'restore', batchId: batch.id });
  return c.json({ batch: batchView(await getBatch(c.env.DB, c.get('identity').user_id, batch.id)), library: next, already_applied: false });
});
app.post('/api/v1/imports/:id/cancel', async c => {
  await c.env.DB.prepare("UPDATE user_import_batches SET status='cancelled' WHERE user_id=? AND id=? AND status='pending'").bind(c.get('identity').user_id,c.req.param('id')).run();
  return c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id'))));
});
app.get('/api/v1/export', async c => {
  const markdown = c.req.query('format') === 'markdown';
  c.header('Content-Disposition', `attachment; filename="interview-cards-${new Date().toISOString().slice(0, 10)}.${markdown ? 'md' : 'json'}"`);
  if (markdown) { c.header('Content-Type', 'text/markdown; charset=utf-8'); return c.body(markdownExport(await readLibrary(c.env.DB, c.get('identity').user_id))); }
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.body(await exportLibrary(c.env.DB, c.get('identity').user_id));
});

app.get('/api/v1/agent/library', async c => {
  const library = await readLibrary(c.env.DB, c.get('identity').user_id);
  return c.json({ ...library, revisions: [] });
});
app.get('/api/v1/agent/schema', c => c.json(z.toJSONSchema(importSchema)));
app.get('/api/v1/agent/imports/:id', async c => c.json(batchView(await getBatch(c.env.DB, c.get('identity').user_id, c.req.param('id')))));
app.post('/api/v1/agent/imports/submit', async c => c.json((await submitImport(c.env.DB, c.get('identity').user_id, await body(c.req.raw))).batch));
// Existing integrations also import immediately; there is no longer an AI approval queue.
app.post('/api/v1/agent/imports/preview', async c => c.json((await submitImport(c.env.DB, c.get('identity').user_id, await body(c.req.raw))).batch));
app.all('/api/v1/agent/*', () => { throw new AppError(403, '机器入口只提供题库查询和普通导入，不提供删除、账号管理或完整恢复', 'FORBIDDEN'); });
app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));

app.all('*', async c => {
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, { status: response.status, headers: new Headers([...response.headers, ...Object.entries({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': c.res.headers.get('Content-Security-Policy') ?? '' })]) });
});
export default app;
