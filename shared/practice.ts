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
