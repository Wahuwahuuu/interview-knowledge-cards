import { z } from 'zod';
import { AppError, canonical, cardSchema, projectSchema, relationSchema, type Card, type Library, type Relation } from './model';

const text = z.string().max(400_000);
export const cardEditPatchSchema = z.object({
  project_id: projectSchema.shape.id.optional(),
  title: z.string().trim().min(1).max(150).optional(),
  question: text.min(1).optional(),
  summary_md: text.optional(),
  answer_md: text.optional(),
  topic_ids: z.array(projectSchema.shape.id).max(100).optional(),
  important: z.boolean().optional(),
  favorite: z.boolean().optional(),
  mastery: z.enum(['review', 'mastered']).optional(),
  archived: z.boolean().optional(),
}).strict();
export const cardEditRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  card_revision: z.number().int().positive().nullable(),
  patch: cardEditPatchSchema,
  followup: z.object({ id: projectSchema.shape.id, parent_id: projectSchema.shape.id, order: z.number().int().nonnegative() }).strict().optional(),
}).strict();
export type CardEditRequest = z.infer<typeof cardEditRequestSchema>;
export type CardEditResult = { revision: number; card: Card; relation?: Relation };

/** Omitted fields remain on the server; clients cannot set IDs, versions or source metadata. */
export function cardEditValue(id: string, before: Card | null, input: CardEditRequest): Card {
  projectSchema.shape.id.parse(id);
  if (input.followup && input.card_revision !== null) throw new AppError(422, '新增追问只能关联本次新建的卡片');
  if (before && input.card_revision === null) throw new AppError(409, '知识卡已存在，请刷新后编辑', 'REVISION_CONFLICT');
  if (!before && input.card_revision !== null) throw new AppError(404, '知识卡已被移除，本次修改尚未保存');
  if (before && before.revision !== input.card_revision) throw new AppError(409, '知识卡已有新版本，请重新核对', 'REVISION_CONFLICT');
  return cardSchema.parse({ ...before, ...input.patch, id });
}

export function cardEditRelation(id: string, input: CardEditRequest): Relation | undefined {
  return input.followup ? relationSchema.parse({ id: input.followup.id, from_card_id: input.followup.parent_id, to_card_id: id, kind: 'followup', order: input.followup.order }) : undefined;
}

export function cardEditRequest(before: Card | null, after: Card, expectedRevision: number): CardEditRequest {
  const fields = Object.keys(cardEditPatchSchema.shape) as (keyof z.infer<typeof cardEditPatchSchema>)[];
  const patch = Object.fromEntries(fields.filter(field => !before || canonical(before[field]) !== canonical(after[field])).map(field => [field, after[field]]));
  return cardEditRequestSchema.parse({ expected_revision: expectedRevision, card_revision: before?.revision ?? null, patch });
}

export function applyCardEditResult(library: Library, expectedRevision: number, id: string, result: CardEditResult): Library {
  const parsed = z.object({ revision: z.number().int().nonnegative(), card: cardSchema, relation: relationSchema.optional() }).strict().parse(result);
  if (library.revision !== expectedRevision || parsed.card.id !== id || parsed.revision < expectedRevision || parsed.revision > expectedRevision + 1) throw new AppError(409, '题库刚有更新，请重新核对保存结果', 'REVISION_CONFLICT');
  const exists = library.cards.some(card => card.id === id), relation = parsed.relation;
  if (relation && (exists || relation.kind !== 'followup' || relation.to_card_id !== id || !library.cards.some(card => card.id === relation.from_card_id) || library.relations.some(row => row.id === relation.id))) throw new AppError(409, '追问关联已改变，请重新核对保存结果', 'REVISION_CONFLICT');
  return { ...library, revision: parsed.revision, cards: exists ? library.cards.map(card => card.id === id ? parsed.card : card) : [...library.cards, parsed.card], ...(relation ? { relations: [...library.relations, relation] } : {}) };
}
