import { AppError, canonical, diffLibraries, importSchema, kinds, librarySchema, prepareImport, sameContent, type Entity, type ImportBatch, type ImportEnvelope, type Library } from '../shared/model';
import { commitLibrary, readLibrary } from './store';

// Failed attempts stay retryable in storage; the API exposes their error as a failed result.
export type BatchRow = { id: string; status: 'pending' | 'applied' | 'cancelled'; base_revision: number; created_at: string; applied_at: string | null; digest: string; payload: string; preview: string; error_message: string };
export function batchView(row: BatchRow): ImportBatch {
  // Stored payloads were validated on submission. Listing records should not
  // revalidate every answer in every historical batch.
  const envelope = JSON.parse(row.payload) as ImportEnvelope;
  const projects = envelope.projects ?? [], cards = envelope.cards ?? [];
  return {
    id: row.id, status: row.status === 'pending' && row.error_message ? 'failed' : row.status,
    base_revision: row.base_revision, created_at: row.created_at, applied_at: row.applied_at,
    mode: envelope.mode ?? 'merge', preview: JSON.parse(row.preview), error: row.error_message || undefined,
    label: projects[0]?.name || cards.slice(0, 2).map(card => card.title).join('、') || '问答与来源导入',
    question_count: cards.length,
  };
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
  const library = await readLibrary(db, userId), target = prepareImport(library, envelope);
  const preview = diffLibraries(library, target);
  await db.prepare("INSERT INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,payload,preview) VALUES (?,?,'pending',?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET base_revision=excluded.base_revision,payload=excluded.payload,preview=excluded.preview,error_message='' WHERE user_import_batches.digest=excluded.digest AND user_import_batches.status='pending'")
    .bind(userId, id, library.revision, digest, new Date().toISOString(), JSON.stringify({ ...envelope, batch_id: id }), JSON.stringify(preview)).run();
  const saved = await getBatch(db, userId, id); checkBatch(saved, digest);
  return batchView(saved);
}

function checkExistingTargets(library: Library, envelope: ImportEnvelope) {
  for (const kind of kinds) {
    const existing = new Map<string, Entity>((library[kind] as Entity[]).map(value => [value.id, value]));
    for (const value of envelope[kind]) {
      const previous = existing.get(value.id);
      if (!previous || sameContent(previous, value)) continue;
      // An update must be based on the current complete object. Review flags also change
      // updated_at without advancing the answer revision, so both tokens matter.
      if (value.revision !== previous.revision || !value.updated_at || value.updated_at !== previous.updated_at) {
        throw new AppError(409, '要更新的内容已有变化，或缺少当前版本信息。请读取最新题库后重新整理并提交。', 'IMPORT_TARGET_CONFLICT');
      }
    }
  }
}

/** Merge and record the result in one request, with atomic commit and stable batch IDs. */
export async function submitImport(db: D1Database, userId: string, input: unknown) {
  const envelope = importSchema.parse(input);
  if (envelope.mode !== 'merge') throw new AppError(403, '直接导入只支持普通题目，完整备份请在网页预览并确认恢复', 'FORBIDDEN');
  const id = envelope.batch_id ?? crypto.randomUUID(), digest = await digestEnvelope(envelope);
  const previous = await db.prepare('SELECT * FROM user_import_batches WHERE user_id=? AND id=?').bind(userId, id).first<BatchRow>();
  if (previous) {
    checkBatch(previous, digest);
    if (previous.status === 'applied') return { batch: batchView(previous), library: await readLibrary(db, userId), already_applied: true };
  }
  let library = await readLibrary(db, userId);
  await db.prepare("INSERT INTO user_import_batches(user_id,id,status,base_revision,digest,created_at,payload,preview) VALUES (?,?,'pending',?,?,?,?, '[]') ON CONFLICT(user_id,id) DO NOTHING")
    .bind(userId, id, library.revision, digest, new Date().toISOString(), JSON.stringify({ ...envelope, batch_id: id })).run();
  checkBatch(await getBatch(db, userId, id), digest);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) library = await readLibrary(db, userId);
      const current = await getBatch(db, userId, id); checkBatch(current, digest);
      if (current.status === 'applied') return { batch: batchView(current), library: await readLibrary(db, userId), already_applied: true };
      checkExistingTargets(library, envelope);
      const target = prepareImport(library, envelope);
      if (!librarySchema.safeParse(target).success) throw new AppError(422, '导入后的题库超过当前容量限制，请整理现有题库后重试', 'LIBRARY_LIMIT');
      const preview = diffLibraries(library, target);
      await db.prepare("UPDATE user_import_batches SET base_revision=?,preview=?,error_message='' WHERE user_id=? AND id=? AND digest=? AND status='pending'")
        .bind(library.revision, JSON.stringify(preview), userId, id, digest).run();
      try {
        const next = await commitLibrary(db, userId, library, target, { batchId: id });
        return { batch: batchView(await getBatch(db, userId, id)), library: next, already_applied: false };
      } catch (error) {
        if (error instanceof AppError && error.code === 'REVISION_CONFLICT' && attempt < 3) continue;
        throw error;
      }
    }
    throw new AppError(409, '题库正在更新，请稍后从导入记录重试', 'REVISION_CONFLICT');
  } catch (error) {
    const latest = await getBatch(db, userId, id);
    // Another identical request may have completed while this request was waiting.
    if (latest.status === 'applied') return { batch: batchView(latest), library: await readLibrary(db, userId), already_applied: true };
    const message = error instanceof AppError ? error.message : '导入未完成，请稍后重试；本次没有写入部分题目。';
    await db.prepare("UPDATE user_import_batches SET error_message=? WHERE user_id=? AND id=? AND digest=? AND status='pending'").bind(message, userId, id, digest).run();
    throw error;
  }
}
