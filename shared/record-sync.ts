import { AppError, canonical, content, schemas, type Entity, type Kind } from './model';
import type { SyncChange, SyncConflict } from './sync';

export type RecordKey = { kind: Kind; id: string };
export type SyncRecord = RecordKey & { value: Entity | null; revision?: number };
export const recordKey = (row: RecordKey) => `${row.kind}:${row.id}`;
export const recordMap = (rows: SyncRecord[]) => new Map(rows.map(row => [recordKey(row), row]));
export const sameRecord = (a: Entity | null | undefined, b: Entity | null | undefined) => canonical(a ? content(a) : null) === canonical(b ? content(b) : null);

/** Merge only the supplied records. Reference/uniqueness checks belong to the indexed store. */
export function mergeRecords(current: SyncRecord[], changes: SyncChange[], now = new Date().toISOString()) {
  const saved = recordMap(current), seen = new Set<string>(), conflicts: SyncConflict[] = [], merged: SyncChange[] = [];
  for (const change of changes) {
    const key = recordKey(change);
    if (seen.has(key)) throw new AppError(422, '同一同步操作不能重复修改同一记录');
    seen.add(key);
    const before = change.before ? schemas[change.kind].parse(change.before) as Entity : null;
    const after = change.after ? schemas[change.kind].parse(change.after) as Entity : null;
    if (before && before.id !== change.id || after && after.id !== change.id) throw new AppError(422, '同步记录 ID 不一致');
    const old = saved.get(key)?.value ?? null;
    const conflict = (field: string, a: unknown, b: unknown, c: unknown) => conflicts.push({kind:change.kind,id:change.id,field,before:a,computer:b,phone:c});
    let next: Entity | null = old;
    if (!before) {
      if (!after) continue;
      if (old && !sameRecord(old,after)) { conflict('record',null,old,after); continue; }
      next = old ?? after;
    } else if (!after) {
      if (old && !sameRecord(old,before)) { conflict('delete',before,old,null); continue; }
      next = null;
    } else if (!old) { conflict('deleted',before,null,after); continue; }
    else {
      const value = {...old} as Record<string,unknown>;
      for (const field of Object.keys(content(after)).filter(key=>key!=='id')) {
        const a=(before as unknown as Record<string,unknown>)[field], b=(after as unknown as Record<string,unknown>)[field];
        if (canonical(a)===canonical(b)) continue;
        if (canonical(value[field])!==canonical(a) && canonical(value[field])!==canonical(b)) conflict(field,a,value[field],b);
        else value[field]=b;
      }
      next = value as Entity;
    }
    if (sameRecord(old,next)) continue;
    if (next) {
      const fields = Object.keys(content(next)).filter(field=>canonical((old as unknown as Record<string,unknown>|null)?.[field])!==canonical((next as unknown as Record<string,unknown>)[field]));
      const flagsOnly = old && change.kind==='cards' && fields.every(field=>['mastery','favorite','important'].includes(field));
      next = {...next,revision:flagsOnly?old.revision:(old?.revision??0)+1,updated_at:now};
    }
    merged.push({kind:change.kind,id:change.id,before:old as unknown as SyncChange['before'],after:next as unknown as SyncChange['after']});
  }
  return {changes:conflicts.length?[]:merged,conflicts};
}

export function resolveRecords(current: SyncRecord[], changes: SyncChange[], incomingWins: boolean) {
  const copy=structuredClone(changes), records=recordMap(current), checked=mergeRecords(current,copy);
  for (const conflict of checked.conflicts) {
    const change=copy.find(row=>row.kind===conflict.kind&&row.id===conflict.id)!;
    const value=records.get(recordKey(change))?.value??null;
    if (['record','delete','deleted'].includes(conflict.field)) {
      if (incomingWins) change.before=value as unknown as SyncChange['before'];
      else copy.splice(copy.indexOf(change),1);
    } else if (incomingWins) change.before![conflict.field]=(value as unknown as Record<string,unknown>)[conflict.field];
    else change.after![conflict.field]=(value as unknown as Record<string,unknown>)[conflict.field];
  }
  const result=mergeRecords(current,copy);
  if (result.conflicts.length) throw new AppError(409,'记录仍有冲突，请重新检查');
  return result.changes;
}
