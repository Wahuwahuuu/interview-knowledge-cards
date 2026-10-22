import { z } from 'zod';
import { AppError, canonical, content, importSchema, kinds, librarySchema, prepareImport, schemas, validateLibrary, type Entity, type ImportBatch, type Kind, type Library } from './model';
import { canLinkFollowup } from './followups';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const syncChangeSchema = z.object({ kind: z.enum(kinds), id, before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()).nullable() }).strict();
export const syncOperationSchema = z.object({ id, epoch: id, changes: z.array(syncChangeSchema).max(10_000), record: z.unknown().optional(), input: z.unknown().optional() }).strict();
export type SyncChange = z.infer<typeof syncChangeSchema>;
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncConflict = { kind: string; id: string; field: string; before: unknown; computer: unknown; phone: unknown };
export type SyncResult = { id: string; status: 'applied' | 'conflict'; conflicts: SyncConflict[] };
export type SyncLog = { seq: number; kind: Kind | 'revisions' | 'imports'; id: string; payload: string | null };
export type SyncSnapshot = { library: Library; imports: ImportBatch[]; cursor: number; epoch: string };

export function changesBetween(before: Library, after: Library): SyncChange[] {
  return kinds.flatMap(kind => {
    const old = new Map((before[kind] as Entity[]).map(value => [value.id, value]));
    const next = new Map((after[kind] as Entity[]).map(value => [value.id, value]));
    return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
      const a = old.get(id), b = next.get(id);
      if (a && b && canonical(content(a)) === canonical(content(b))) return [];
      return [{ kind, id, before: a ? { ...a } : null, after: b ? { ...b } : null }];
    });
  });
}

/** Three-way comparison uses field content, never wall clocks or paragraph positions. */
export function mergeOperation(base: Library, operation: SyncOperation, now = new Date().toISOString()): { target: Library; conflicts: SyncConflict[] } {
  const conflicts: SyncConflict[] = [], envelope = importSchema.parse({ schema_version: 1 });
  const target: Library = structuredClone({ ...base, revisions: [] });
  for (const change of operation.changes) {
    const { kind, id, before, after } = change;
    if (before?.id !== undefined && before.id !== id || after?.id !== undefined && after.id !== id) throw new AppError(422, '同步记录 ID 不一致');
    if (before) schemas[kind].parse(before);
    if (after) schemas[kind].parse(after);
    const current = (base[kind] as Entity[]).find(value => value.id === id);
    const compare = (a: unknown, b: unknown) => canonical(a) === canonical(b);
    const body = (v: Record<string, unknown> | Entity | null | undefined) => v ? content(v as Entity) : null;
    if (!before) {
      if (!after) continue;
      if (current && !compare(body(current), body(after))) conflicts.push({ kind, id, field: 'record', before: null, computer: current, phone: after });
      else if (!current) (envelope[kind] as Entity[]).push(after as Entity);
      continue;
    }
    if (!after) {
      if (kind === 'sources' || kind === 'occurrences' && !operation.changes.some(item => item.kind === 'cards' && item.id === before.card_id && !item.after)) throw new AppError(422, '同步不能删除原始来源记录');
      if (current && !compare(body(current), body(before))) conflicts.push({ kind, id, field: 'delete', before, computer: current, phone: null });
      else (target[kind] as Entity[]) = (target[kind] as Entity[]).filter(value => value.id !== id);
      continue;
    }
    if (!current) { conflicts.push({ kind, id, field: 'deleted', before, computer: null, phone: after }); continue; }
    const next = { ...current } as Record<string, unknown>;
    for (const field of Object.keys(content(after as Entity)).filter(field => field !== 'id')) {
      if (compare(before[field], after[field])) continue;
      if (!compare((current as unknown as Record<string, unknown>)[field], before[field]) && !compare((current as unknown as Record<string, unknown>)[field], after[field])) conflicts.push({ kind, id, field, before: before[field], computer: (current as unknown as Record<string, unknown>)[field], phone: after[field] });
      else next[field] = after[field];
    }
    (envelope[kind] as Entity[]).push(next as Entity);
  }
  if (conflicts.length) return { target: base, conflicts };
  target.revisions = target.revisions.filter(entry => target.cards.some(card => card.id === entry.card_id));
  try {
    const merged = prepareImport(target, envelope, now);
    // Review flags do not create another answer version, matching the existing state API.
    for (const change of operation.changes.filter(item => item.kind === 'cards' && item.before && item.after)) {
      const fields = Object.keys(content(change.after as Entity)).filter(field => canonical(change.before![field]) !== canonical(change.after![field]));
      if (!fields.length || !fields.every(field => ['mastery', 'favorite', 'important'].includes(field))) continue;
      const old = base.cards.find(card => card.id === change.id), card = merged.cards.find(card => card.id === change.id);
      if (old && card) { card.revision = old.revision; merged.revisions = merged.revisions.filter(entry => entry.card_id !== card.id || entry.revision <= old.revision); }
    }
    const remaining = new Set(merged.cards.map(card => card.id));
    merged.revisions = [...base.revisions.filter(entry => remaining.has(entry.card_id)), ...merged.revisions];
    librarySchema.parse(merged); validateLibrary(merged);
    for (const relation of merged.relations.filter(r => r.kind === 'followup')) {
      const other = { ...merged, relations: merged.relations.filter(r => r.id !== relation.id) };
      if (!canLinkFollowup(other, relation.from_card_id, relation.to_card_id)) throw new AppError(422, '同步后的追问关系会形成循环或多个主问题');
    }
    return { target: merged, conflicts: [] };
  } catch (error) {
    return { target: base, conflicts: [{ kind: 'library', id: operation.id, field: 'references', before: null, computer: error instanceof Error ? error.message : '记录引用冲突', phone: operation.changes }] };
  }
}

export function applySyncLogs(snapshot: SyncSnapshot, logs: SyncLog[], cursor: number): SyncSnapshot {
  if (!logs.length) return { ...snapshot, cursor };
  const next = structuredClone(snapshot);
  for (const log of logs) {
    const value = log.payload === null ? null : JSON.parse(log.payload);
    if (log.kind === 'imports') {
      next.imports = next.imports.filter(item => item.id !== log.id);
      if (value) next.imports.push(value);
    } else if (log.kind === 'revisions') {
      next.library.revisions = next.library.revisions.filter(item => `${item.card_id}:${item.revision}` !== log.id);
      if (value) next.library.revisions.push(value);
    } else {
      const list = (next.library[log.kind] as Entity[]).filter(item => item.id !== log.id);
      if (value) list.push(schemas[log.kind].parse(value));
      (next.library[log.kind] as Entity[]) = list;
    }
  }
  next.cursor = cursor;
  return next;
}
