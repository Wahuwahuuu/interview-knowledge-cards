import { AppError, type Library } from './model';

/** Delete a card and its dependent records, while retaining original source documents. */
export function removeCard(library: Library, cardId: string): Library {
  if (!library.cards.some(card => card.id === cardId)) throw new AppError(404, '知识卡不存在');
  return {
    ...library,
    cards: library.cards.filter(card => card.id !== cardId),
    occurrences: library.occurrences.filter(occurrence => occurrence.card_id !== cardId),
    relations: library.relations.filter(relation => relation.from_card_id !== cardId && relation.to_card_id !== cardId),
    revisions: library.revisions.filter(entry => entry.card_id !== cardId),
  };
}
