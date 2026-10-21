import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { filterQuestionGroups, questionGroups } from '../shared/question-groups';
import { followupCards } from '../shared/followups';
import { practiceMainCards } from '../shared/practice';

function fixture() {
  return prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
    projects: [{ id: 'p1', name: '缓存' }, { id: 'p2', name: '网络' }],
    cards: ['root', 'child', 'grandchild', 'independent', 'external'].map(id => ({ id, project_id: id === 'external' ? 'p2' : 'p1', title: id, question: id, mastery: id === 'child' ? 'mastered' : 'review', favorite: id === 'child' })),
    relations: [
      { id: 'a', from_card_id: 'root', to_card_id: 'child', kind: 'followup', order: 1 },
      { id: 'b', from_card_id: 'child', to_card_id: 'grandchild', kind: 'followup', order: 1 },
      { id: 'c', from_card_id: 'root', to_card_id: 'external', kind: 'followup' },
    ],
  }));
}

describe('主问题统计与折叠分组', () => {
  it('子问题和孙问题折叠到所属主问题，统计口径与自测一致', () => {
    const library = fixture(), groups = questionGroups(library, 'p1');
    expect(groups.map(group => group.main.id)).toEqual(practiceMainCards(library, 'p1').map(card => card.id));
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.main.id === 'root')!.children.map(child => [child.card.id, child.depth])).toEqual([['child', 1], ['grandchild', 2]]);
    expect(groups.filter(group => group.main.mastery === 'mastered')).toHaveLength(0);
  });
  it('全库统计等于各题库主问题之和，跨题库关系不会吞掉另一题库的问题', () => {
    const library = fixture();
    expect(questionGroups(library)).toHaveLength(3);
    expect(questionGroups(library).length).toBe(library.projects.reduce((count, project) => count + questionGroups(library, project.id).length, 0));
    expect(followupCards(library, 'root').map(card => card.id)).not.toContain('external');
  });
  it('搜索或收藏命中子问题时保留主问题并请求自动展开', () => {
    const groups = questionGroups(fixture(), 'p1');
    const matches = filterQuestionGroups(groups, card => card.favorite, true);
    expect(matches).toHaveLength(1);
    expect(matches[0].main.id).toBe('root');
    expect(matches[0].children.map(child => child.card.id)).toEqual(['child']);
    expect(matches[0]).toMatchObject({ expandForMatches: true, mainMatches: false });
    expect(filterQuestionGroups(groups, () => true, false)).toBe(groups);
  });
  it('父卡归档后子问题仍可独立找到，显示归档时恢复完整分组', () => {
    const library = fixture(); library.cards.find(card => card.id === 'root')!.archived = true;
    expect(questionGroups(library, 'p1').map(group => group.main.id)).toEqual(['child', 'independent']);
    const all = questionGroups(library, 'p1', true);
    expect(all.find(group => group.main.id === 'root')!.main.archived).toBe(true);
    expect(all.find(group => group.main.id === 'root')!.children).toHaveLength(2);
  });
  it('历史循环不会重复列出或让任何问题不可达', () => {
    const library = fixture();
    library.relations.push({ id: 'old-cycle', from_card_id: 'grandchild', to_card_id: 'root', kind: 'followup', revision: 1, updated_at: '' });
    const groups = questionGroups(library, 'p1');
    const reachable = groups.flatMap(group => [group.main.id, ...group.children.map(child => child.card.id)]);
    expect(new Set(reachable).size).toBe(4);
    expect(reachable).toHaveLength(4);
  });
});
