import { AppError, type Library, type Relation } from './model';
import { canLinkFollowup, orderedFollowups } from './followups';

/** Delete a card and its dependent records, while retaining original source documents. */
export function removeCard(library: Library, cardId: string): Library {
  const removed = library.cards.find(card => card.id === cardId);
  if (!removed) throw new AppError(404, '知识卡不存在');
  const sameScope = new Set(library.cards.filter(card => !card.archived && card.project_id === removed.project_id).map(card => card.id));
  const children = orderedFollowups(library, cardId).filter(relation => sameScope.has(relation.to_card_id));
  const promoted = children[0]?.to_card_id;
  const next = {
    ...library,
    cards: library.cards.filter(card => card.id !== cardId),
    occurrences: library.occurrences.filter(occurrence => occurrence.card_id !== cardId),
    relations: library.relations.filter(relation => relation.from_card_id !== cardId && relation.to_card_id !== cardId),
    revisions: library.revisions.filter(entry => entry.card_id !== cardId),
  };
  if (!promoted) return next;
  const timestamp = new Date().toISOString();
  const existing = orderedFollowups(next, promoted);
  const offset = Math.max(-1, ...existing.map(relation => relation.order ?? 0)) + 1;
  function reconnect(relation: Relation, from: string, to: string, order = relation.order) {
    if (next.relations.some(value => value.kind === 'followup' && value.from_card_id === from && value.to_card_id === to)) return;
    if (!canLinkFollowup(next, from, to)) return;
    next.relations.push({ ...relation, from_card_id: from, to_card_id: to, order, revision: relation.revision + 1, updated_at: timestamp });
  }
  // Keep the first child's existing branch, then attach its former siblings in order.
  children.slice(1).forEach((relation, index) => reconnect(relation, promoted, relation.to_card_id, offset + index));
  // If this was a nested question, its replacement occupies the same parent slot.
  library.relations.filter(relation => relation.kind === 'followup' && relation.to_card_id === cardId && sameScope.has(relation.from_card_id))
    .forEach(relation => reconnect(relation, relation.from_card_id, promoted));
  return next;
}
