import type { Card, Library, Relation } from './model';

export function orderedFollowups(library: Library, cardId: string): Relation[] {
  const active = new Set(library.cards.filter(card => !card.archived).map(card => card.id));
  return library.relations.filter(relation => relation.kind === 'followup' && relation.from_card_id === cardId && active.has(relation.to_card_id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** A stable, depth-first question sequence; old cyclic links cannot trap a session. */
export function followupCards(library: Library, rootId: string, projectId?: string): Card[] {
  const cards = new Map(library.cards.filter(card => !card.archived && (!projectId || card.project_id === projectId)).map(card => [card.id, card]));
  const children = new Map<string, string[]>();
  for (const relation of [...library.relations].filter(r => r.kind === 'followup').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    if (!children.has(relation.from_card_id)) children.set(relation.from_card_id, []);
    children.get(relation.from_card_id)!.push(relation.to_card_id);
  }
  const visited = new Set([rootId]), result: Card[] = [];
  const pending = [...(children.get(rootId) ?? [])].reverse();
  while (pending.length) {
    const id = pending.pop()!, card = cards.get(id);
    if (!card || visited.has(id)) continue;
    visited.add(id); result.push(card);
    pending.push(...[...(children.get(id) ?? [])].reverse());
  }
  return result;
}

export function canLinkFollowup(library: Library, parentId: string, childId: string): boolean {
  if (parentId === childId) return false;
  const seen = new Set<string>(), pending = [childId];
  const links = library.relations.filter(r => r.kind === 'followup');
  while (pending.length) {
    const id = pending.pop()!;
    if (id === parentId) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...links.filter(r => r.from_card_id === id).map(r => r.to_card_id));
  }
  return true;
}
