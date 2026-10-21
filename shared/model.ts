import { z } from 'zod';
import { normalizeCardPriority } from './card-priority';
import { canLinkFollowup } from './followups';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, 'ID 只能包含字母、数字及 . _ : -');
const text = z.string().max(400_000);
const base = { id, revision: z.number().int().positive().default(1), updated_at: z.string().default('') };
export const projectSchema = z.object({ ...base, name: z.string().trim().min(1).max(100), description: text.default('') });
export const topicSchema = z.object({ ...base, name: z.string().trim().min(1).max(100) });
export const evidenceSchema = z.object({ label: z.string().min(1), path: z.string().default(''), line: z.number().int().positive().optional(), url: z.string().default('') });
export const cardSchema = z.preprocess(normalizeCardPriority, z.object({
  ...base, project_id: id, title: z.string().trim().min(1).max(150), question: text.min(1),
  summary_md: text.default(''), answer_md: text.default(''), limitations_md: text.default(''),
  source_baseline: z.string().default(''), evidence: z.array(evidenceSchema).max(100).default([]),
  topic_ids: z.array(id).max(100).default([]), favorite: z.boolean().default(false),
  important: z.boolean().default(false),
  mastery: z.enum(['review', 'mastered']).default('review'), archived: z.boolean().default(false),
}));
export const sourceSchema = z.object({
  ...base, name: z.string().trim().min(1).max(150), kind: z.enum(['real', 'mock', 'note']),
  date: z.string().refine(v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v), '日期格式为 YYYY-MM-DD').default(''),
  company: z.string().default(''), job: z.string().default(''), round: z.string().default(''),
  notes: text.default(''), source_path: z.string().default(''), original_markdown: text.default(''),
});
export const occurrenceSchema = z.object({
  ...base, card_id: id, source_id: id, asked_question: text.min(1), original_answer_md: text.default(''),
  section: z.string().default(''), notes: text.default(''),
});
export const relationSchema = z.object({ ...base, from_card_id: id, to_card_id: id, kind: z.enum(['followup', 'related']), order: z.number().int().nonnegative().optional() });
export const revisionSchema = z.object({ card_id: id, revision: z.number().int().positive(), saved_at: z.string(), action: z.string(), snapshot: cardSchema });
const arrays = {
  projects: z.array(projectSchema).max(1000).default([]), topics: z.array(topicSchema).max(2000).default([]),
  cards: z.array(cardSchema).max(2000).default([]), sources: z.array(sourceSchema).max(2000).default([]),
  occurrences: z.array(occurrenceSchema).max(5000).default([]), relations: z.array(relationSchema).max(5000).default([]),
  revisions: z.array(revisionSchema).max(20_000).default([]),
};
export const librarySchema = z.object({ schema_version: z.literal(1), revision: z.number().int().nonnegative(), ...arrays });
export const importSchema = z.object({ schema_version: z.literal(1), batch_id: id.optional(), mode: z.enum(['merge', 'restore']).default('merge'), ...arrays });
export type Project = z.infer<typeof projectSchema>;
export type Topic = z.infer<typeof topicSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type Relation = z.infer<typeof relationSchema>;
export type CardRevision = z.infer<typeof revisionSchema>;
export type Library = z.infer<typeof librarySchema>;
export type ImportEnvelope = z.infer<typeof importSchema>;
export const kinds = ['projects', 'topics', 'sources', 'cards', 'occurrences', 'relations'] as const;
export type Kind = typeof kinds[number];
export const schemas = { projects: projectSchema, topics: topicSchema, sources: sourceSchema, cards: cardSchema, occurrences: occurrenceSchema, relations: relationSchema };
export type Entity = Project | Topic | Card | Source | Occurrence | Relation;
export type Change = { kind: Kind; id: string; name: string; operation: 'add' | 'update' | 'remove'; fields: { field: string; before: unknown; after: unknown }[] };
export type ImportBatch = { id: string; status: 'pending' | 'failed' | 'applied' | 'cancelled'; base_revision: number; created_at: string; applied_at: string | null; mode: 'merge' | 'restore'; preview: Change[]; error?: string; label?: string; question_count?: number };
export const emptyLibrary = (): Library => ({ schema_version: 1, revision: 0, projects: [], topics: [], sources: [], cards: [], occurrences: [], relations: [], revisions: [] });

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'INVALID_DATA') { super(message); }
}
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function content(value: Entity): Record<string, unknown> {
  const { revision: _revision, updated_at: _updated, ...rest } = value;
  return rest;
}
export function sameContent(a: Entity, b: Entity) { return canonical(content(a)) === canonical(content(b)); }

export function validateProjectNames(base: Project[], target: Project[]) {
  const previous = new Map(base.map(project => [project.id, project.name.trim()]));
  const counts = new Map<string, number>();
  for (const project of target) {
    const name = project.name.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const project of target) {
    const name = project.name.trim();
    // Existing duplicates must not block unrelated edits or prevent users from renaming them.
    if (previous.get(project.id) === name) continue;
    if ((counts.get(name) ?? 0) > 1) throw new AppError(422, `项目“${name}”已存在，请使用其他名称或选择已有项目`, 'DUPLICATE_PROJECT_NAME');
  }
}

export function validateLibrary(library: Library) {
  const maps = Object.fromEntries(kinds.map(k => [k, new Set(library[k].map(v => v.id))])) as Record<Kind, Set<string>>;
  for (const kind of kinds) if (maps[kind].size !== library[kind].length) throw new AppError(422, `${kind} 中存在重复 ID`);
  for (const card of library.cards) {
    if (!maps.projects.has(card.project_id)) throw new AppError(422, `卡片 ${card.id} 引用了不存在的项目 ${card.project_id}`);
    if (new Set(card.topic_ids).size !== card.topic_ids.length) throw new AppError(422, `卡片 ${card.id} 的知识点重复`);
    for (const topic of card.topic_ids) if (!maps.topics.has(topic)) throw new AppError(422, `卡片 ${card.id} 引用了不存在的知识点 ${topic}`);
  }
  for (const occurrence of library.occurrences) {
    if (!maps.cards.has(occurrence.card_id) || !maps.sources.has(occurrence.source_id)) throw new AppError(422, `出现记录 ${occurrence.id} 的卡片或来源不存在`);
  }
  const relationKeys = new Set<string>();
  for (const relation of library.relations) {
    if (!maps.cards.has(relation.from_card_id) || !maps.cards.has(relation.to_card_id)) throw new AppError(422, `关系 ${relation.id} 引用了不存在的卡片`);
    if (relation.from_card_id === relation.to_card_id) throw new AppError(422, '问题不能关联自身');
    const endpoints = relation.kind === 'related' ? [relation.from_card_id, relation.to_card_id].sort() : [relation.from_card_id, relation.to_card_id];
    const key = `${relation.kind}:${endpoints.join(':')}`;
    if (relationKeys.has(key)) throw new AppError(422, '同一问题关系重复');
    relationKeys.add(key);
  }
  const historyKeys = new Set<string>();
  for (const entry of library.revisions) {
    const card = library.cards.find(c => c.id === entry.card_id);
    const key = `${entry.card_id}:${entry.revision}`;
    if (!card || entry.snapshot.id !== entry.card_id || entry.snapshot.revision !== entry.revision || entry.revision > card.revision || historyKeys.has(key)) throw new AppError(422, '历史版本引用、版本号或唯一性不正确');
    historyKeys.add(key);
  }
}

export function prepareImport(base: Library, envelope: ImportEnvelope, now = new Date().toISOString()): Library {
  for (const kind of kinds) if (new Set(envelope[kind].map(v => v.id)).size !== envelope[kind].length) throw new AppError(422, `${kind} 中存在重复 ID`);
  if (envelope.mode === 'restore') {
    const target = librarySchema.parse({ ...envelope, revision: base.revision });
    validateProjectNames(base.projects, target.projects);
    validateLibrary(target);
    for (const card of target.cards) if (!target.revisions.some(v => v.card_id === card.id && v.revision === card.revision)) {
      target.revisions.push({ card_id: card.id, revision: card.revision, snapshot: card, saved_at: now, action: '备份恢复' });
    }
    return target;
  }
  if (envelope.revisions.length) throw new AppError(422, '普通导入不能修改历史版本；完整备份请使用 restore 模式');
  const target = structuredClone(base);
  for (const kind of kinds) {
    const list = target[kind] as Entity[];
    for (const proposed of envelope[kind]) {
      const index = list.findIndex(v => v.id === proposed.id);
      const previous = index >= 0 ? list[index] : undefined;
      if (previous && kind === 'sources' && (previous as Source).original_markdown !== (proposed as Source).original_markdown) throw new AppError(422, '已有来源的原始记录不能被覆盖');
      if (previous && kind === 'occurrences') {
        const old = previous as Occurrence, next = proposed as Occurrence;
        if (old.asked_question !== next.asked_question || old.original_answer_md !== next.original_answer_md || old.card_id !== next.card_id || old.source_id !== next.source_id) throw new AppError(422, '已有出现记录的原始问答及归属不能被覆盖；请新增记录');
      }
      if (previous && sameContent(previous, proposed)) continue;
      const next = { ...proposed, revision: (previous?.revision ?? 0) + 1, updated_at: now } as Entity;
      if (index < 0) list.push(next); else list[index] = next;
      if (kind === 'cards') target.revisions.push({ card_id: next.id, revision: next.revision, saved_at: now, action: previous ? '编辑答案或卡片' : '新建卡片', snapshot: structuredClone(next as Card) });
    }
  }
  for (const relation of envelope.relations.filter(r => r.kind === 'followup')) {
    const previous = base.relations.find(r => r.id === relation.id);
    if (previous?.kind === 'followup' && previous.from_card_id === relation.from_card_id && previous.to_card_id === relation.to_card_id) continue;
    const withoutThisLink = { ...target, relations: target.relations.filter(r => r.id !== relation.id) };
    if (!canLinkFollowup(withoutThisLink, relation.from_card_id, relation.to_card_id)) throw new AppError(422, '这条追问会形成循环，请选择其他问题');
  }
  validateProjectNames(base.projects, target.projects);
  validateLibrary(target);
  return target;
}

export function diffLibraries(base: Library, target: Library): Change[] {
  const changes: Change[] = [];
  function displayName(kind: Kind, value: Entity) {
    if ('title' in value) return value.title;
    if ('name' in value) return value.name;
    if (kind === 'occurrences') { const occurrence = value as Occurrence; return (target.cards.find(c => c.id === occurrence.card_id)?.title ?? base.cards.find(c => c.id === occurrence.card_id)?.title ?? '问题') + ' · ' + (target.sources.find(s => s.id === occurrence.source_id)?.name ?? base.sources.find(s => s.id === occurrence.source_id)?.name ?? '来源'); }
    const relation = value as Relation;
    return (target.cards.find(c => c.id === relation.from_card_id)?.title ?? base.cards.find(c => c.id === relation.from_card_id)?.title ?? '问题') + (relation.kind === 'followup' ? ' → ' : ' ↔ ') + (target.cards.find(c => c.id === relation.to_card_id)?.title ?? base.cards.find(c => c.id === relation.to_card_id)?.title ?? '问题');
  }
  for (const kind of kinds) {
    const old = new Map<string, Entity>((base[kind] as Entity[]).map(v => [v.id, v]));
    const next = new Map<string, Entity>((target[kind] as Entity[]).map(v => [v.id, v]));
    for (const [key, value] of next) {
      const previous = old.get(key);
      if (previous && sameContent(previous, value) && previous.revision === value.revision) continue;
      const before: Record<string, unknown> = previous ? { ...content(previous), revision: previous.revision } : {}, after: Record<string, unknown> = { ...content(value), revision: value.revision };
      changes.push({ kind, id: key, name: displayName(kind, value), operation: previous ? 'update' : 'add', fields: [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => canonical(before[k]) !== canonical(after[k])).map(field => ({ field, before: before[field], after: after[field] })) });
    }
    for (const [key, value] of old) if (!next.has(key)) changes.push({ kind, id: key, name: displayName(kind, value), operation: 'remove', fields: [] });
  }
  for (const card of target.cards) {
    const before = base.revisions.filter(v => v.card_id === card.id), after = target.revisions.filter(v => v.card_id === card.id);
    if (canonical(before) !== canonical(after) && !changes.some(v => v.kind === 'cards' && v.id === card.id)) changes.push({ kind: 'cards', id: card.id, name: card.title, operation: 'update', fields: [{ field: 'history', before: before.length, after: after.length }] });
  }
  return changes;
}

export function projectSnapshot(library: Library, projectId: string): Library {
  if (!library.projects.some(p => p.id === projectId)) throw new AppError(404, '项目不存在');
  const cards = library.cards.filter(c => c.project_id === projectId && !c.archived);
  const ids = new Set(cards.map(c => c.id));
  const topicIds = new Set(cards.flatMap(c => c.topic_ids));
  const occurrences = library.occurrences.filter(o => ids.has(o.card_id));
  const sourceIds = new Set(occurrences.map(o => o.source_id));
  return { ...library, projects: library.projects.filter(p => p.id === projectId), cards, topics: library.topics.filter(t => topicIds.has(t.id)), sources: library.sources.filter(s => sourceIds.has(s.id)), occurrences, relations: library.relations.filter(r => ids.has(r.from_card_id) && ids.has(r.to_card_id)), revisions: [] };
}

export function graphElements(library: Library, projectId?: string) {
  const cards = library.cards.filter(c => !c.archived && (!projectId || c.project_id === projectId));
  const cardIds = new Set(cards.map(c => c.id));
  const projectIds = new Set(cards.map(c => c.project_id));
  const topicIds = new Set(cards.flatMap(c => c.topic_ids));
  return [
    ...library.projects.filter(p => projectIds.has(p.id)).map(p => ({ data: { id: `p:${p.id}`, entity_id: p.id, label: p.name, type: 'project' } })),
    ...cards.map(c => ({ data: { id: `c:${c.id}`, entity_id: c.id, label: c.title, type: 'card', mastered: c.mastery === 'mastered' ? 'yes' : 'no' } })),
    ...library.topics.filter(t => topicIds.has(t.id)).map(t => ({ data: { id: `t:${t.id}`, entity_id: t.id, label: t.name, type: 'topic' } })),
    ...cards.flatMap(c => [{ data: { id: `pc:${c.id}`, source: `p:${c.project_id}`, target: `c:${c.id}`, kind: 'project' } }, ...c.topic_ids.map(t => ({ data: { id: `ct:${c.id}:${t}`, source: `c:${c.id}`, target: `t:${t}`, kind: 'topic' } }))]),
    ...library.relations.filter(r => cardIds.has(r.from_card_id) && cardIds.has(r.to_card_id)).map(r => ({ data: { id: `r:${r.id}`, source: `c:${r.from_card_id}`, target: `c:${r.to_card_id}`, kind: r.kind, label: r.kind === 'followup' ? '追问' : '相关' } })),
  ];
}

export function markdownExport(library: Library) {
  const lines = ['# 面试知识卡', '', `导出时间：${new Date().toISOString()}`, ''];
  for (const project of library.projects) {
    lines.push(`## ${project.name}`, '', project.description, '');
    for (const card of library.cards.filter(c => c.project_id === project.id)) {
      lines.push(`### ${card.title}${card.important ? '（重点）' : ''}${card.archived ? '（已归档）' : ''}`, '', card.question, '', '#### 复习提纲', '', card.summary_md, '', '#### 完整答案', '', card.answer_md, '', '#### 出现记录', '');
      for (const occurrence of library.occurrences.filter(o => o.card_id === card.id)) {
        const source = library.sources.find(s => s.id === occurrence.source_id)!;
        lines.push(`- ${source.date} ${source.name}｜${source.company} ${source.job} ${source.round}`, '', `原始问法：${occurrence.asked_question}`, '', occurrence.notes, '', occurrence.original_answer_md, '');
      }
    }
  }
  return lines.join('\n');
}
