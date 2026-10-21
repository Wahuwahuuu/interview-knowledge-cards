import type { Card, Library } from './model';
import { practiceMainCards } from './practice';

export type QuestionChild = { card: Card; depth: number };
export type QuestionGroup = { main: Card; children: QuestionChild[]; expandForMatches?: boolean; mainMatches?: boolean };

/** Group before searching: a matching child must never turn into a second main card. */
export function questionGroups(library: Library, projectId?: string, includeArchived = false): QuestionGroup[] {
  const scope = library.cards.filter(card => (!projectId || card.project_id === projectId) && (includeArchived || !card.archived));
  const cards = new Map(scope.map(card => [card.id, card]));
  const links = new Map<string, string[]>();
  const relations = library.relations.filter(relation => relation.kind === 'followup')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const relation of relations) {
    const parent = cards.get(relation.from_card_id), child = cards.get(relation.to_card_id);
    if (!parent || !child || parent.project_id !== child.project_id) continue;
    if (!links.has(parent.id)) links.set(parent.id, []);
    links.get(parent.id)!.push(child.id);
  }
  const roots = practiceMainCards({ ...library, cards: scope.map(card => card.archived ? { ...card, archived: false } : card) }, projectId);
  return roots.map(root => {
    const children: QuestionChild[] = [], seen = new Set([root.id]);
    const pending = [...(links.get(root.id) ?? [])].reverse().map(id => ({ id, depth: 1 }));
    while (pending.length) {
      const { id, depth } = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); children.push({ card: cards.get(id)!, depth });
      pending.push(...[...(links.get(id) ?? [])].reverse().map(id => ({ id, depth: depth + 1 })));
    }
    return { main: cards.get(root.id)!, children };
  });
}

export function filterQuestionGroups(groups: QuestionGroup[], matches: (card: Card) => boolean, filtering: boolean): QuestionGroup[] {
  if (!filtering) return groups;
  return groups.flatMap(group => {
    const mainMatches = matches(group.main), children = group.children.filter(child => matches(child.card));
    if (!mainMatches && !children.length) return [];
    return [{ ...group, children: mainMatches ? group.children : children, expandForMatches: children.length > 0, mainMatches }];
  });
}
