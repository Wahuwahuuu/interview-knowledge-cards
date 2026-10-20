import { z } from 'zod';
import type { Card } from './model';

export const cardStatePatchSchema = z.object({
  mastery: z.enum(['review', 'mastered']).optional(),
  favorite: z.boolean().optional(),
  important: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, '请指定要修改的状态');

export const cardStateRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  card_revision: z.number().int().positive(),
  patch: cardStatePatchSchema,
}).strict();

export type CardStatePatch = z.infer<typeof cardStatePatchSchema>;
export type CardStateRequest = z.infer<typeof cardStateRequestSchema>;
export type CardState = Pick<Card, 'id' | 'revision' | 'updated_at' | 'mastery' | 'favorite' | 'important'>;
export type CardStateResult = { revision: number; card: CardState };

export function cardState(card: Card): CardState {
  const { id, revision, updated_at, mastery, favorite, important } = card;
  return { id, revision, updated_at, mastery, favorite, important };
}
