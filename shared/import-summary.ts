import { type Change, kinds } from './model';
export function summarizeChanges(changes: Change[]) {
  const counts = Object.fromEntries(kinds.map(kind => [kind, changes.filter(c => c.kind === kind).length])) as Record<(typeof kinds)[number], number>;
  return { counts, questions: counts.cards, supporting: changes.length - counts.cards, total: changes.length };
}
