/** Convert only a decorative star at the beginning of a title (after an optional question number). */
export function legacyPriorityTitle(title: string): { title: string; marked: boolean } {
  const match = title.match(/^(\s*(?:\d+\s*[.．、)）·:-]\s*)?)(?:[⭐🌟★☆✩✪✫✬✭✮✯✰]\uFE0F?\s*)+/u);
  return match ? { title: (match[1] + title.slice(match[0].length)).trim(), marked: true } : { title, marked: false };
}

/** Old backups and stored cards acquire the same priority semantics without altering source records. */
export function normalizeCardPriority(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const card = value as Record<string, unknown>;
  if (typeof card.title !== 'string') return value;
  const normalized = legacyPriorityTitle(card.title);
  return { ...card, title: normalized.title, important: card.important === undefined ? normalized.marked : card.important };
}
