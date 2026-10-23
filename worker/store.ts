import { AppError, canonical, cardSchema, kinds, projectSchema, revisionSchema, validateLibrary, type Library, type Kind, type Entity } from '../shared/model';
import { cardState, type CardStateRequest, type CardStateResult } from '../shared/card-state';
import { applyProjectOrder, type ProjectOrderRequest, type ProjectOrderResult } from '../shared/project-order';
import { decodeStoredRecord } from './stored-records';

export async function updateProjectOrder(db: D1Database, userId: string, input: ProjectOrderRequest): Promise<ProjectOrderResult> {
  const [meta, records] = await db.batch([
    db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(userId),
    db.prepare('SELECT payload FROM user_projects WHERE user_id=? ORDER BY id').bind(userId),
  ]);
  const revision = (meta.results[0] as { revision: number } | undefined)?.revision ?? 0;
  if (input.expected_revision !== revision) throw new AppError(409, '题库已更新，请刷新后重新调整顺序', 'REVISION_CONFLICT');
  const previous = records.results.map(row => projectSchema.parse(JSON.parse((row as { payload: string }).payload)));
  const projects = applyProjectOrder(previous, input.project_ids);
  const changed = projects.filter(project => previous.find(old => old.id === project.id)?.revision !== project.revision);
  if (!changed.length) return { revision, projects };
  const guard = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT revision FROM user_library_meta WHERE user_id=?)=? THEN 1 ELSE 0 END)').bind(userId, guard, userId, revision),
      ...changed.map(project => upsert(db, userId, 'projects', project)),
      db.prepare('UPDATE user_library_meta SET revision=revision+1 WHERE user_id=?').bind(userId),
      db.prepare('DELETE FROM user_mutation_guard WHERE user_id=? AND id=?').bind(userId, guard),
    ]);
  } catch (error) {
    if (String(error).includes('ok=1') || String(error).includes('mutation_guard')) throw new AppError(409, '题库刚有更新，请刷新后重新调整顺序', 'REVISION_CONFLICT');
    throw error;
  }
  return { revision: revision + 1, projects };
}

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
  const queries = [db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(userId), ...kinds.map(kind => db.prepare(`SELECT payload FROM user_${kind} WHERE user_id=? ORDER BY id`).bind(userId))];
  const results = await db.batch(queries);
  const values: Record<string, unknown> = { schema_version: 1, revision: (results[0].results[0] as { revision: number })?.revision ?? 0 };
  kinds.forEach((kind, index) => { values[kind] = results[index + 1].results.map(row => decodeStoredRecord(kind, (row as { payload: string }).payload)); });
  // Daily reads and edits do not need every historical answer in memory.
  // commitLibrary appends new revisions without removing stored history.
  values.revisions = [];
  return values as Library;
}

export async function readCardHistory(db: D1Database, userId: string, cardId: string) {
  const result = await db.prepare('SELECT payload FROM user_card_revisions WHERE user_id=? AND card_id=? ORDER BY revision DESC').bind(userId, cardId).all<{ payload: string }>();
  return result.results.map(row => revisionSchema.parse(JSON.parse(row.payload)));
}

/** One consistent DB snapshot, emitted without parsing and cloning all old answers. */
export async function exportLibrary(db: D1Database, userId: string): Promise<ReadableStream<Uint8Array>> {
  const tables = [...kinds, 'card_revisions'];
  const results = await db.batch([db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(userId), ...tables.map(table => db.prepare(`SELECT payload FROM user_${table} WHERE user_id=? ORDER BY ${table === 'card_revisions' ? 'card_id,revision' : 'id'}`).bind(userId))]);
  const revision = (results[0].results[0] as { revision: number } | undefined)?.revision ?? 0;
  function* chunks() {
    yield JSON.stringify({ schema_version: 1, revision, mode: 'restore', exported_at: new Date().toISOString() }).slice(0, -1);
    for (let i = 0; i < tables.length; i++) {
      yield `,${JSON.stringify(tables[i] === 'card_revisions' ? 'revisions' : tables[i])}:[`;
      for (let j = 0; j < results[i + 1].results.length; j++) yield (j ? ',' : '') + (results[i + 1].results[j] as { payload: string }).payload;
      yield ']';
    }
    yield '}';
  }
  const iterator = chunks(), encoder = new TextEncoder();
  return new ReadableStream({ pull(controller) { const next = iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); } });
}

export function upsert(db: D1Database, userId: string, kind: Kind, value: Entity): D1PreparedStatement {
  const extra = kind === 'cards' ? ['project_id'] : kind === 'occurrences' ? ['card_id', 'source_id'] : kind === 'relations' ? ['from_card_id', 'to_card_id'] : [];
  const record = value as unknown as Record<string, unknown>;
  const columns = ['user_id', 'id', 'revision', 'payload', ...extra];
  const values = [userId, value.id, value.revision, JSON.stringify(value), ...extra.map(k => record[k] as string)];
  return db.prepare(`INSERT INTO user_${kind} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(user_id,id) DO UPDATE SET ${columns.slice(2).map(c => `${c}=excluded.${c}`).join(',')}`).bind(...values);
}

export async function commitLibrary(db: D1Database, userId: string, base: Library, target: Library, options: { restore?: boolean; batchId?: string; extra?: D1PreparedStatement[] } = {}) {
  validateLibrary(target);
  const guard = crypto.randomUUID();
  const pendingBatch = options.batchId ? " AND EXISTS (SELECT 1 FROM user_import_batches WHERE user_id=? AND id=? AND status='pending' AND base_revision=?)" : '';
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO user_mutation_guard(user_id,id,ok) VALUES (?,?,CASE WHEN (SELECT revision FROM user_library_meta WHERE user_id=?)=?${pendingBatch} THEN 1 ELSE 0 END)`).bind(userId, guard, userId, base.revision, ...(options.batchId ? [userId, options.batchId, base.revision] : []))];
  if (options.restore) {
    statements.push(db.prepare('UPDATE cloud_sync_state SET epoch=? WHERE user_id=?').bind(crypto.randomUUID(),userId));
    for (const table of ['relations', 'occurrences', 'card_topics', 'card_revisions', 'cards', 'sources', 'topics', 'projects']) statements.push(db.prepare(`DELETE FROM user_${table} WHERE user_id=?`).bind(userId));
  } else {
    const remainingCards = new Set(target.cards.map(card => card.id));
    for (const kind of [...kinds].reverse()) {
      const nextIds = new Set(target[kind].map(v => v.id));
      for (const old of base[kind]) if (!nextIds.has(old.id) || (kind === 'relations' && (!remainingCards.has((old as Library['relations'][number]).from_card_id) || !remainingCards.has((old as Library['relations'][number]).to_card_id)))) {
        // A surviving relation may be reparented. Remove its old FK before deleting
        // the parent card; the replacement is upserted below in the same transaction.
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
      const previous = old.get(value.id);
      // Cloned unchanged entities retain property order. Native serialization is
      // much cheaper here than recursively sorting every key in the whole library.
      if (!options.restore && (previous === value || JSON.stringify(previous) === JSON.stringify(value) || canonical(previous) === canonical(value))) continue;
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
  statements.push(...(options.extra ?? []));
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
  return { ...target, revisions: [] };
}
