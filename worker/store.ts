import { AppError, canonical, cardSchema, kinds, librarySchema, validateLibrary, type Library, type Kind, type Entity } from '../shared/model';
import { cardState, type CardStateRequest, type CardStateResult } from '../shared/card-state';

export async function updateCardState(db: D1Database, userId: string, id: string, input: CardStateRequest): Promise<CardStateResult> {
  const [meta, records] = await db.batch([
    db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(userId),
    db.prepare('SELECT payload FROM user_cards WHERE user_id=? AND id=?').bind(userId, id),
  ]);
  const revision = (meta.results[0] as { revision: number } | undefined)?.revision ?? 0;
  const row = records.results[0] as { payload: string } | undefined;
  if (!row) throw new AppError(404, '知识卡不存在');
  const old = cardSchema.parse(JSON.parse(row.payload));
  if (input.expected_revision !== revision || input.card_revision !== old.revision) throw new AppError(409, '题库已更新，请重试保存标记', 'REVISION_CONFLICT');
  if (Object.entries(input.patch).every(([key, value]) => old[key as keyof typeof input.patch] === value)) return { revision, card: cardState(old) };
  // Review flags keep the answer version and its history; only the library revision advances.
  const next = { ...old, ...input.patch, updated_at: new Date().toISOString() };
  const guard = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT revision FROM user_library_meta WHERE user_id=?)=? AND (SELECT revision FROM user_cards WHERE user_id=? AND id=?)=? THEN 1 ELSE 0 END)').bind(userId, guard, userId, revision, userId, id, old.revision),
      db.prepare('UPDATE user_cards SET revision=?,payload=? WHERE user_id=? AND id=?').bind(next.revision, JSON.stringify(next), userId, id),
      db.prepare('UPDATE user_library_meta SET revision=revision+1 WHERE user_id=?').bind(userId),
      db.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(userId, guard),
    ]);
  } catch (error) {
    if (String(error).includes('ok=1') || String(error).includes('mutation_guard')) throw new AppError(409, '题库刚有更新，请重试保存标记', 'REVISION_CONFLICT');
    throw error;
  }
  return { revision: revision + 1, card: cardState(next) };
}

export async function readLibrary(db: D1Database, userId: string): Promise<Library> {
  const queries = [db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(userId), ...kinds.map(kind => db.prepare(`SELECT payload FROM user_${kind} WHERE user_id=? ORDER BY id`).bind(userId)), db.prepare('SELECT payload FROM user_card_revisions WHERE user_id=? ORDER BY card_id,revision').bind(userId)];
  const results = await db.batch(queries);
  const values: Record<string, unknown> = { schema_version: 1, revision: (results[0].results[0] as { revision: number })?.revision ?? 0 };
  kinds.forEach((kind, index) => { values[kind] = results[index + 1].results.map(row => JSON.parse((row as { payload: string }).payload)); });
  values.revisions = results.at(-1)!.results.map(row => JSON.parse((row as { payload: string }).payload));
  return librarySchema.parse(values);
}

function upsert(db: D1Database, userId: string, kind: Kind, value: Entity): D1PreparedStatement {
  const extra = kind === 'cards' ? ['project_id'] : kind === 'occurrences' ? ['card_id', 'source_id'] : kind === 'relations' ? ['from_card_id', 'to_card_id'] : [];
  const record = value as unknown as Record<string, unknown>;
  const columns = ['user_id', 'id', 'revision', 'payload', ...extra];
  const values = [userId, value.id, value.revision, JSON.stringify(value), ...extra.map(k => record[k] as string)];
  return db.prepare(`INSERT INTO user_${kind} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(user_id,id) DO UPDATE SET ${columns.slice(2).map(c => `${c}=excluded.${c}`).join(',')}`).bind(...values);
}

export async function commitLibrary(db: D1Database, userId: string, base: Library, target: Library, options: { restore?: boolean; batchId?: string } = {}) {
  validateLibrary(target);
  const guard = crypto.randomUUID();
  const pendingBatch = options.batchId ? " AND EXISTS (SELECT 1 FROM user_import_batches WHERE user_id=? AND id=? AND status='pending' AND base_revision=?)" : '';
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT revision FROM user_library_meta WHERE user_id=?)=?${pendingBatch} THEN 1 ELSE 0 END)`).bind(userId, guard, userId, base.revision, ...(options.batchId ? [userId, options.batchId, base.revision] : []))];
  if (options.restore) {
    for (const table of ['relations', 'occurrences', 'card_topics', 'card_revisions', 'cards', 'sources', 'topics', 'projects']) statements.push(db.prepare(`DELETE FROM user_${table} WHERE user_id=?`).bind(userId));
  } else {
    for (const kind of [...kinds].reverse()) {
      const nextIds = new Set(target[kind].map(v => v.id));
      for (const old of base[kind]) if (!nextIds.has(old.id)) {
        if (kind === 'cards') {
          statements.push(db.prepare('DELETE FROM user_card_topics WHERE user_id=? AND card_id=?').bind(userId,old.id), db.prepare('DELETE FROM user_card_revisions WHERE user_id=? AND card_id=?').bind(userId,old.id));
        }
        statements.push(db.prepare(`DELETE FROM user_${kind} WHERE user_id=? AND id=?`).bind(userId,old.id));
      }
    }
  }
  for (const kind of kinds) {
    const old = new Map<string, Entity>((base[kind] as Entity[]).map(v => [v.id, v]));
    for (const value of target[kind]) {
      if (!options.restore && canonical(old.get(value.id)) === canonical(value)) continue;
      statements.push(upsert(db, userId, kind, value));
      if (kind === 'cards') {
        statements.push(db.prepare('DELETE FROM user_card_topics WHERE user_id=? AND card_id=?').bind(userId,value.id));
        const card = target.cards.find(c => c.id === value.id)!;
        for (const topic of card.topic_ids) statements.push(db.prepare('INSERT INTO user_card_topics(user_id,card_id,topic_id) VALUES (?,?,?)').bind(userId,card.id, topic));
      }
    }
  }
  const oldHistory = new Set(base.revisions.map(v => `${v.card_id}:${v.revision}`));
  for (const entry of target.revisions) if (options.restore || !oldHistory.has(`${entry.card_id}:${entry.revision}`)) {
    statements.push(db.prepare('INSERT INTO user_card_revisions(user_id,card_id,revision,saved_at,action,payload) VALUES (?,?,?,?,?,?)').bind(userId,entry.card_id, entry.revision, entry.saved_at, entry.action, JSON.stringify(entry)));
  }
  statements.push(db.prepare('UPDATE user_library_meta SET revision=revision+1 WHERE user_id=?').bind(userId));
  if (options.batchId) statements.push(db.prepare("UPDATE user_import_batches SET status='applied',applied_at=?,error_message='' WHERE user_id=? AND id=? AND status='pending'").bind(new Date().toISOString(),userId, options.batchId));
  statements.push(db.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(userId,guard));
  try { await db.batch(statements); }
  catch (error) {
    const message = String(error);
    if (message.includes('ok=1') || message.includes('mutation_guard')) {
      if (options.batchId) {
        const batch = await db.prepare('SELECT status FROM user_import_batches WHERE user_id=? AND id=?').bind(userId, options.batchId).first<{ status: string }>();
        if (batch?.status === 'cancelled') throw new AppError(409, '这个导入批次已经取消', 'IMPORT_CANCELLED');
      }
      throw new AppError(409, '题库已在其他操作中更新，请刷新后重新预览或保存', 'REVISION_CONFLICT');
    }
    throw error;
  }
  target.revision = base.revision + 1;
  return target;
}
