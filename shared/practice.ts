import type { Card, Library } from './model';

export type PracticeMode = 'sequential' | 'random';
export type PracticeSession = {
  mode: PracticeMode;
  ids: string[];
  history: string[];
  historyIndex: number;
  remaining: string[];
};

const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** Numbered titles follow their question number; other questions use their stable ID. */
export function practiceCards(library: Library, projectId?: string): Card[] {
  return library.cards.filter(card => !card.archived && (!projectId || card.project_id === projectId)).sort((a, b) => {
    const projectOrder = naturalOrder.compare(a.project_id, b.project_id);
    if (projectOrder) return projectOrder;
    const aNumber = a.title.match(/^\s*(\d+)(?:[.．、·:\s-]|$)/u)?.[1];
    const bNumber = b.title.match(/^\s*(\d+)(?:[.．、·:\s-]|$)/u)?.[1];
    if (aNumber && bNumber) {
      const numberOrder = naturalOrder.compare(aNumber, bNumber);
      if (numberOrder) return numberOrder;
    } else if (aNumber || bNumber) {
      return aNumber ? -1 : 1;
    }
    return naturalOrder.compare(a.id, b.id);
  });
}

export function practiceMainCards(library: Library, projectId?: string): Card[] {
  const cards = practiceCards(library, projectId), ids = new Set(cards.map(card => card.id));
  const projects = new Map(cards.map(card => [card.id, card.project_id]));
  const followups = library.relations.filter(r => r.kind === 'followup' && ids.has(r.from_card_id) && ids.has(r.to_card_id) && projects.get(r.from_card_id) === projects.get(r.to_card_id));
  const children = new Set(followups.map(r => r.to_card_id));
  const roots = cards.filter(card => !children.has(card.id));
  const links = new Map<string, string[]>();
  for (const relation of followups) {
    if (!links.has(relation.from_card_id)) links.set(relation.from_card_id, []);
    links.get(relation.from_card_id)!.push(relation.to_card_id);
  }
  const reachable = new Set<string>();
  function visit(id: string) {
    const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (reachable.has(next)) continue;
      reachable.add(next); pending.push(...(links.get(next) ?? []));
    }
  }
  for (const root of roots) visit(root.id);
  // Keep legacy cyclic groups reachable without repeating their questions forever.
  for (const card of cards) if (!reachable.has(card.id)) {
    roots.push(card); visit(card.id);
  }
  return roots;
}

function shuffled(ids: string[], random: () => number): string[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function startPractice(ids: string[], mode: PracticeMode, random: () => number = Math.random): PracticeSession {
  const orderedIds = [...new Set(ids)];
  const choices = mode === 'random' ? shuffled(orderedIds, random) : orderedIds;
  return { mode, ids: orderedIds, history: choices.length ? [choices[0]] : [], historyIndex: 0, remaining: choices.slice(1) };
}

export function currentPracticeId(session: PracticeSession): string | undefined {
  return session.history[session.historyIndex];
}

/** Keep a running session usable when cards are removed or followups become roots. */
export function reconcilePractice(session: PracticeSession, ids: string[], random: () => number = Math.random): PracticeSession {
  const orderedIds = [...new Set(ids)];
  if (orderedIds.length === session.ids.length && orderedIds.every((id, index) => id === session.ids[index])) return session;
  if (!orderedIds.length) return { ...session, ids: [], history: [], historyIndex: 0, remaining: [] };
  const available = new Set(orderedIds), current = currentPracticeId(session);
  const added = orderedIds.filter(id => !session.ids.includes(id));
  const remaining = [...new Set([...session.remaining.filter(id => available.has(id)), ...added])];
  const visited = session.history.slice(0, session.historyIndex + 1).filter(id => available.has(id));
  if (current && available.has(current)) return {
    ...session, ids: orderedIds,
    history: [...visited, ...session.history.slice(session.historyIndex + 1).filter(id => available.has(id))],
    historyIndex: visited.length - 1,
    remaining: remaining.filter(id => id !== current),
  };
  const oldIndex = current ? session.ids.indexOf(current) : 0;
  const nextIndex = session.ids.slice(0, Math.max(oldIndex, 0)).filter(id => available.has(id)).length;
  const next = session.mode === 'random'
    ? shuffled(remaining.length ? remaining : orderedIds, random)[0]
    : orderedIds[Math.min(nextIndex, orderedIds.length - 1)];
  const history = visited.at(-1) === next ? visited : [...visited, next];
  return { ...session, ids: orderedIds, history, historyIndex: history.length - 1, remaining: remaining.filter(id => id !== next) };
}

export function setPracticeMode(session: PracticeSession, mode: PracticeMode): PracticeSession {
  if (session.mode === mode) return session;
  const current = currentPracticeId(session);
  return { ...session, mode, remaining: session.ids.filter(id => id !== current) };
}

export function canAdvancePractice(session: PracticeSession): boolean {
  const current = currentPracticeId(session);
  if (!current) return false;
  return session.mode === 'random' ? session.ids.length > 1 : session.ids.indexOf(current) < session.ids.length - 1;
}

export function nextPractice(session: PracticeSession, random: () => number = Math.random): PracticeSession {
  if (!canAdvancePractice(session)) return session;
  const current = currentPracticeId(session)!;
  let next: string, remaining = session.remaining;
  if (session.mode === 'sequential') {
    next = session.ids[session.ids.indexOf(current) + 1];
  } else {
    const unvisited = remaining.filter(id => id !== current);
    const candidates = unvisited.length ? unvisited : session.ids.filter(id => id !== current);
    const choices = shuffled(candidates, random);
    next = choices[0];
    remaining = choices.slice(1);
  }
  const history = [...session.history.slice(0, session.historyIndex + 1), next];
  return { ...session, remaining, history, historyIndex: history.length - 1 };
}

export function previousPractice(session: PracticeSession): PracticeSession {
  return session.historyIndex > 0 ? { ...session, historyIndex: session.historyIndex - 1 } : session;
}
