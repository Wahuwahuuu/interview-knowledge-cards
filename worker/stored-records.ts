import { schemas, type Entity, type Kind } from '../shared/model';
import { normalizeCardPriority } from '../shared/card-priority';

// Writes validate complete entities before persistence. Reads only need to hydrate
// old optional fields, rather than validate and clone every answer on every request.
const seeds = {
  projects: { id: 'defaults', name: 'defaults' },
  topics: { id: 'defaults', name: 'defaults' },
  sources: { id: 'defaults', name: 'defaults', kind: 'note' },
  cards: { id: 'defaults', project_id: 'defaults', title: 'defaults', question: 'defaults' },
  occurrences: { id: 'defaults', card_id: 'defaults', source_id: 'defaults', asked_question: 'defaults' },
  relations: { id: 'defaults', from_card_id: 'defaults', to_card_id: 'defaults', kind: 'related' },
} as const;
const defaults = Object.fromEntries(Object.entries(seeds).map(([kind, seed]) => {
  const parsed = schemas[kind as Kind].parse(seed) as unknown as Record<string, unknown>;
  return [kind, Object.fromEntries(Object.entries(parsed).filter(([key]) => !(key in seed)))];
})) as Record<Kind, Record<string, unknown>>;
const arrayKeys = Object.fromEntries(Object.entries(defaults).map(([kind, fields]) => [kind, Object.keys(fields).filter(key => Array.isArray(fields[key]))])) as Record<Kind, string[]>;

export function decodeStoredRecord(kind: Kind, payload: string): Entity {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  const record = (kind === 'cards' ? normalizeCardPriority(parsed) : parsed) as Record<string, unknown>;
  const value = { ...defaults[kind], ...record };
  if (typeof value.name === 'string') value.name = value.name.trim();
  if (kind === 'cards' && typeof value.title === 'string') value.title = value.title.trim();
  for (const key of arrayKeys[kind]) if (record[key] === undefined) value[key] = [];
  return value as Entity;
}
