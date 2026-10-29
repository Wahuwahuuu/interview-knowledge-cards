import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { currentPracticeId, nextPractice, practiceMainCards, practiceReviewIds, previousPractice, reconcilePractice, setPracticeMode, startPractice } from '../shared/practice';

const keepOrder = () => 0.999999;
function fixture() {
  return prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
    projects: [{ id: 'p1', name: '测试题库一' }, { id: 'p2', name: '测试题库二' }],
    cards: [
      { id: 'known', mastery: 'mastered' },
      { id: 'weak', mastery: 'review' },
      { id: 'context', mastery: 'mastered' },
      { id: 'child', mastery: 'mastered' },
      { id: 'nested', mastery: 'review' },
      { id: 'complete', mastery: 'mastered' },
      { id: 'complete-child', mastery: 'mastered' },
      { id: 'archived', mastery: 'review', archived: true },
      { id: 'external', mastery: 'review', project_id: 'p2' },
    ].map(value => ({ project_id: 'p1', title: value.id, question: value.id, ...value })),
    relations: [
      { id: 'context-child', from_card_id: 'context', to_card_id: 'child', kind: 'followup' },
      { id: 'child-nested', from_card_id: 'child', to_card_id: 'nested', kind: 'followup' },
      { id: 'complete-child-link', from_card_id: 'complete', to_card_id: 'complete-child', kind: 'followup' },
      { id: 'archived-link', from_card_id: 'known', to_card_id: 'archived', kind: 'followup' },
      { id: 'cross-project', from_card_id: 'known', to_card_id: 'external', kind: 'followup' },
      { id: 'only-related', from_card_id: 'known', to_card_id: 'weak', kind: 'related' },
    ],
  }));
}

describe('随机自测优先未掌握的问题组', () => {
  it('已掌握主问题下的多层未掌握追问仍使主问题进入优先队列', () => {
    const library = fixture();
    expect(practiceReviewIds(library, 'p1')).toEqual(['context', 'weak']);
    const roots = practiceMainCards(library, 'p1').map(card => card.id);
    const session = startPractice(roots, 'random', keepOrder, practiceReviewIds(library, 'p1'));
    expect(currentPracticeId(session)).toBe('context');
    expect(session.ids).not.toContain('child');
    expect(session.ids).not.toContain('nested');
  });

  it('优先级遵守题库范围，忽略归档、仅相关及跨题库追问', () => {
    expect(practiceReviewIds(fixture(), 'p1')).not.toContain('known');
    expect(practiceReviewIds(fixture(), 'p2')).toEqual(['external']);
    expect(practiceReviewIds(fixture())).toEqual(['context', 'weak', 'external']);
    expect(practiceReviewIds(fixture(), 'absent')).toEqual([]);
  });

  it('一轮中先随机完未掌握组，再出已掌握组，每组只出现一次', () => {
    const ids = ['known-a', 'weak-a', 'known-b', 'weak-b'], priority = ['weak-a', 'weak-b'];
    let session = startPractice(ids, 'random', keepOrder, priority);
    const visited = [currentPracticeId(session)];
    for (let i = 1; i < ids.length; i++) {
      session = nextPractice(session, () => 0, priority);
      visited.push(currentPracticeId(session));
    }
    expect(new Set(visited.slice(0, 2))).toEqual(new Set(priority));
    expect(new Set(visited)).toEqual(new Set(ids));
    const last = currentPracticeId(session);
    const next = nextPractice(session, keepOrder, priority);
    expect(priority).toContain(currentPracticeId(next));
    expect(currentPracticeId(next)).not.toBe(last);
    expect(ids).toEqual(['known-a', 'weak-a', 'known-b', 'weak-b']);
  });

  it('优先队列内部仍随机，不固定从第一道未掌握题开始', () => {
    const ids = ['known', 'weak-a', 'weak-b'];
    expect(currentPracticeId(startPractice(ids, 'random', keepOrder, ['weak-a', 'weak-b']))).toBe('weak-a');
    expect(currentPracticeId(startPractice(ids, 'random', () => 0.5, ['weak-a', 'weak-b']))).toBe('weak-b');
  });

  it('掌握状态改变后不跳当前题，下一题使用最新优先级', () => {
    const library = fixture(), ids = practiceMainCards(library, 'p1').map(card => card.id);
    const first = startPractice(ids, 'random', keepOrder, practiceReviewIds(library, 'p1'));
    expect(currentPracticeId(first)).toBe('context');
    library.cards.find(card => card.id === 'weak')!.mastery = 'mastered';
    library.cards.find(card => card.id === 'known')!.mastery = 'review';
    const priority = practiceReviewIds(library, 'p1');
    const reconciled = reconcilePractice(first, ids, keepOrder, priority);
    expect(reconciled).toBe(first);
    expect(currentPracticeId(reconciled)).toBe('context');
    expect(currentPracticeId(nextPractice(reconciled, keepOrder, priority))).toBe('known');
    library.cards.find(card => card.id === 'nested')!.mastery = 'mastered';
    expect(practiceReviewIds(library, 'p1')).not.toContain('context');
  });

  it('切换随机模式只影响下一题，上一题仍返回实际访问历史，顺序模式保持题序', () => {
    const first = startPractice(['known-a', 'known-b', 'weak'], 'sequential', keepOrder, ['weak']);
    expect(currentPracticeId(first)).toBe('known-a');
    expect(currentPracticeId(nextPractice(first, keepOrder, ['weak']))).toBe('known-b');
    const random = setPracticeMode(first, 'random');
    expect(currentPracticeId(random)).toBe('known-a');
    const next = nextPractice(random, keepOrder, ['weak']);
    expect(currentPracticeId(next)).toBe('weak');
    expect(currentPracticeId(previousPractice(next))).toBe('known-a');
  });

  it('删除当前题后优先接续未掌握组，新增的未掌握组也可参与本轮', () => {
    const first = startPractice(['known', 'weak-a', 'weak-b'], 'random', keepOrder, ['weak-a', 'weak-b']);
    const next = reconcilePractice(first, ['known', 'weak-b', 'new-weak'], keepOrder, ['weak-b', 'new-weak']);
    expect(currentPracticeId(next)).toBe('weak-b');
    expect(currentPracticeId(nextPractice(next, keepOrder, ['new-weak']))).toBe('new-weak');
    expect(next.history).not.toContain('weak-a');
  });

  it('全已掌握、空库及单组仍可正常开始', () => {
    const library = fixture();
    for (const card of library.cards) card.mastery = 'mastered';
    expect(practiceReviewIds(library, 'p1')).toEqual([]);
    const ids = practiceMainCards(library, 'p1').map(card => card.id);
    let session = startPractice(ids, 'random', keepOrder, []);
    const visited = [currentPracticeId(session)];
    for (let i = 1; i < ids.length; i++) { session = nextPractice(session, keepOrder, []); visited.push(currentPracticeId(session)); }
    expect(new Set(visited)).toEqual(new Set(ids));
    expect(currentPracticeId(startPractice([], 'random', keepOrder, ['absent']))).toBeUndefined();
    const only = startPractice(['one'], 'random', keepOrder, ['one']);
    expect(currentPracticeId(only)).toBe('one');
    expect(nextPractice(only, keepOrder, ['one'])).toBe(only);
  });

  it('历史循环关联仍能判断组内未掌握内容，不会无限追溯', () => {
    const library = fixture();
    library.relations.push({ id: 'old-cycle', from_card_id: 'nested', to_card_id: 'context', kind: 'followup', revision: 1, updated_at: '' });
    expect(practiceReviewIds(library, 'p1')).toEqual(['weak', 'child']);
  });
});
