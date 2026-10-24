import { AppError, projectSchema, type Card } from '../shared/model';
import { cardEditRelation, cardEditValue, type CardEditRequest, type CardEditResult } from '../shared/card-edit';
import { commitIncremental, planIncremental } from './incremental-store';
import { decodeStoredRecord } from './stored-records';
import type { SyncChange } from '../shared/sync';

/** Human card saves share the indexed validator and transaction journal used by device sync. */
export async function saveCardEdit(db: D1Database, user: string, id: string, input: CardEditRequest): Promise<CardEditResult> {
  projectSchema.shape.id.parse(id);
  const [meta, rows] = await db.batch([
    db.prepare('SELECT revision FROM user_library_meta WHERE user_id=?').bind(user),
    db.prepare('SELECT payload FROM user_cards WHERE user_id=? AND id=?').bind(user, id),
  ]);
  const revision = (meta.results[0] as { revision: number } | undefined)?.revision ?? 0;
  if (revision !== input.expected_revision) throw new AppError(409, '题库已更新，请重新核对后保存；本次输入仍保留', 'REVISION_CONFLICT');
  const stored = rows.results[0] as { payload: string } | undefined;
  const before = stored ? decodeStoredRecord('cards', stored.payload) as Card : null;
  const after = cardEditValue(id, before, input), relation = cardEditRelation(id, input);
  const changes: SyncChange[] = [{ kind: 'cards', id, before, after }];
  if (relation) changes.push({ kind: 'relations', id: relation.id, before: null, after: relation });
  const plan = await planIncremental(db, user, changes);
  if (plan.conflicts.length) {
    const conflict = plan.conflicts[0];
    if (conflict.kind === 'library') throw new AppError(422, typeof conflict.computer === 'string' ? conflict.computer : '卡片的关联资料不正确');
    throw new AppError(409, '知识卡刚有修改，请重新核对；本次输入仍保留', 'REVISION_CONFLICT');
  }
  const nextRevision = await commitIncremental(db, user, revision, plan.changes);
  const savedRelation = plan.changes.find(row => row.kind === 'relations')?.after;
  return { revision: nextRevision, card: (plan.changes.find(row => row.kind === 'cards')?.after ?? before) as Card, ...(savedRelation ? { relation: savedRelation as unknown as NonNullable<CardEditResult['relation']> } : {}) };
}
