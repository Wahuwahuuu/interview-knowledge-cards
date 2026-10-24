import { AppError, canonical, diffLibraries, importSchema, prepareImport, type ImportBatch, type ImportEnvelope } from '../shared/model';
import { readLibrary } from './store';
import { libraryRevision, planRecordMerge } from './record-mutations';
import { commitIncremental } from './incremental-store';

// Failed attempts stay retryable in storage; the API exposes their error as a failed result.
export type BatchRow = { id: string; status: 'pending' | 'applied' | 'cancelled'; base_revision: number; created_at: string; applied_at: string | null; digest: string; payload: string; preview: string; error_message: string; mode?:'merge'|'restore';label?:string;question_count?:number };
export function batchView(row: BatchRow): ImportBatch {
  // Stored payloads were validated on submission. Listing records should not
  // revalidate every answer in every historical batch.
  const envelope = row.mode===undefined?JSON.parse(row.payload) as ImportEnvelope:undefined;
  const projects = envelope?.projects ?? [], cards = envelope?.cards ?? [];
  return {
    id: row.id, status: row.status === 'pending' && row.error_message ? 'failed' : row.status,
    base_revision: row.base_revision, created_at: row.created_at, applied_at: row.applied_at,
    mode: row.mode??envelope?.mode??'merge', preview: JSON.parse(row.preview), preview_loaded:true,error: row.error_message || undefined,
    label: row.label??(projects[0]?.name || cards.slice(0, 2).map(card => card.title).join('、') || '问答与来源导入'),
    question_count: row.question_count??cards.length,
  };
}
export async function listBatches(db:D1Database,userId:string){
  const rows=await db.prepare('SELECT id,status,base_revision,created_at,applied_at,error_message,mode,label,question_count FROM user_import_batches WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(userId).all<BatchRow>();
  return rows.results.map(row=>({...row,status:row.status==='pending'&&row.error_message?'failed':row.status,error:row.error_message||undefined,error_message:undefined,preview:[],preview_loaded:false})) as ImportBatch[];
}
export async function getBatch(db: D1Database, userId: string, id: string) {
  const row = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId, id).first<BatchRow>();
  if (!row) throw new AppError(404, '导入批次不存在');
  return row;
}
async function digestEnvelope(envelope: ImportEnvelope) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ ...envelope, batch_id: undefined }))))).map(v => v.toString(16).padStart(2, '0')).join('');
}
function checkBatch(row: BatchRow, digest: string) {
  if (row.digest !== digest) throw new AppError(409, '这个批次 ID 已用于其他内容，请更换批次 ID', 'BATCH_ID_REUSED');
  if (row.status === 'cancelled') throw new AppError(409, '批次已取消，请使用新的批次 ID', 'IMPORT_CANCELLED');
}

/** Backup previews and legacy staged requests remain available to human accounts. */
export async function draft(db: D1Database, userId: string, input: unknown) {
  const envelope = importSchema.parse(input);
  const digest = await digestEnvelope(envelope), id = envelope.batch_id ?? crypto.randomUUID();
  const previous = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId, id).first<BatchRow>();
  if (previous) { checkBatch(previous, digest); if (previous.status === 'applied') return batchView(previous); }
  const plan=envelope.mode==='merge'?await planRecordMerge(db,userId,envelope):undefined;
  const library=plan?undefined:await readLibrary(db,userId),revision=plan?.revision??library!.revision;
  const preview=plan?.preview??diffLibraries(library!,prepareImport(library!,envelope));
  await db.prepare("INSERT INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,payload,preview) VALUES (?,?,'pending',?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET base_revision=excluded.base_revision,payload=excluded.payload,preview=excluded.preview,error_message='' WHERE user_import_batches.digest=excluded.digest AND user_import_batches.status='pending'")
    .bind(userId, id, revision, digest, new Date().toISOString(), JSON.stringify({ ...envelope, batch_id: id }), JSON.stringify(preview)).run();
  const saved = await getBatch(db, userId, id); checkBatch(saved, digest);
  return batchView(saved);
}


/** Merge and record the result in one request, with atomic commit and stable batch IDs. */
export async function submitImport(db: D1Database, userId: string, input: unknown) {
  const envelope = importSchema.parse(input);
  if (envelope.mode !== 'merge') throw new AppError(403, '直接导入只支持普通题目，完整备份请在网页预览并确认恢复', 'FORBIDDEN');
  const id = envelope.batch_id ?? crypto.randomUUID(), digest = await digestEnvelope(envelope);
  const previous = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId, id).first<BatchRow>();
  if (previous) {
    checkBatch(previous, digest);
    if (previous.status === 'applied') return { batch: batchView(previous), already_applied: true };
  }
  const revision=await libraryRevision(db,userId);
  await db.prepare("INSERT INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,payload,preview) VALUES (?,?,'pending',?,?,?,?, '[]') ON CONFLICT(user_id,id) DO NOTHING")
    .bind(userId, id, revision, digest, new Date().toISOString(), JSON.stringify({ ...envelope, batch_id: id })).run();
  checkBatch(await getBatch(db, userId, id), digest);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await getBatch(db, userId, id); checkBatch(current, digest);
      if (current.status === 'applied') return { batch: batchView(current), already_applied: true };
      const plan=await planRecordMerge(db,userId,envelope,{strictTargets:true}),preview=plan.preview;
      await db.prepare("UPDATE user_import_batches SET base_revision=?,preview=?,error_message='' WHERE user_id=? AND id=? AND digest=? AND status='pending'")
        .bind(plan.revision, JSON.stringify(preview), userId, id, digest).run();
      try {
        const guard=crypto.randomUUID();
        await commitIncremental(db,userId,plan.revision,plan.changes,[
          db.prepare("INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN EXISTS(SELECT 1 FROM user_import_batches WHERE user_id=? AND id=? AND digest=? AND status='pending' AND base_revision=?) THEN 1 ELSE 0 END)").bind(userId,guard,userId,id,digest,plan.revision),
          db.prepare("UPDATE user_import_batches SET status='applied',applied_at=?,error_message='' WHERE user_id=? AND id=?").bind(new Date().toISOString(),userId,id),
          db.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(userId,guard),
        ]);
        return { batch: batchView(await getBatch(db, userId, id)), already_applied: false };
      } catch (error) {
        if (error instanceof AppError && error.code === 'REVISION_CONFLICT' && attempt < 3) continue;
        throw error;
      }
    }
    throw new AppError(409, '题库正在更新，请稍后从导入记录重试', 'REVISION_CONFLICT');
  } catch (error) {
    const latest = await getBatch(db, userId, id);
    // Another identical request may have completed while this request was waiting.
    if (latest.status === 'applied') return { batch: batchView(latest), already_applied: true };
    const message = error instanceof AppError ? error.message : '导入未完成，请稍后重试；本次没有写入部分题目。';
    await db.prepare("UPDATE user_import_batches SET error_message=? WHERE user_id=? AND id=? AND digest=? AND status='pending'").bind(message, userId, id, digest).run();
    throw error;
  }
}
