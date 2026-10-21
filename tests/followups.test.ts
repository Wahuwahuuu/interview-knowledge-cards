import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { canLinkFollowup, followupCards } from '../shared/followups';
import { practiceMainCards } from '../shared/practice';
import { FollowupList } from '../src/FollowupList';

function fixture() {
  return prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
    projects: [{ id: 'p1', name: '缓存' }, { id: 'p2', name: '网络' }],
    cards: ['root', 'child1', 'child2', 'grandchild', 'other'].map(id => ({ id, project_id: id === 'other' ? 'p2' : 'p1', title: id, question: id, summary_md: 'HIDDEN_OUTLINE', answer_md: 'HIDDEN_ANSWER' })),
    relations: [
      { id: 'r2', from_card_id: 'root', to_card_id: 'child2', kind: 'followup', order: 2 },
      { id: 'r1', from_card_id: 'root', to_card_id: 'child1', kind: 'followup', order: 1 },
      { id: 'r3', from_card_id: 'child1', to_card_id: 'grandchild', kind: 'followup' },
    ],
  }));
}

describe('主问题与逐条追问', () => {
  it('主问题列表不重复包含追问，逐层追问遵循顺序', () => {
    const library = fixture();
    expect(practiceMainCards(library, 'p1').map(c => c.id)).toEqual(['root']);
    expect(followupCards(library, 'root').map(c => c.id)).toEqual(['child1', 'grandchild', 'child2']);
  });
  it('跨项目及归档父卡不会让当前题库的问题消失', () => {
    const library = fixture();
    library.relations.push({ id: 'r4', from_card_id: 'root', to_card_id: 'other', kind: 'followup', revision: 1, updated_at: '' });
    expect(practiceMainCards(library, 'p2').map(c => c.id)).toEqual(['other']);
    expect(followupCards(library, 'root', 'p1').some(c => c.id === 'other')).toBe(false);
    library.cards.find(c => c.id === 'root')!.archived = true;
    expect(practiceMainCards(library, 'p1').map(c => c.id)).toEqual(['child1', 'child2']);
  });
  it('拒绝新增循环追问，历史循环仍能复习且不会无限遍历', () => {
    const library = fixture();
    expect(canLinkFollowup(library, 'grandchild', 'root')).toBe(false);
    const cycle = { id: 'cycle', from_card_id: 'grandchild', to_card_id: 'root', kind: 'followup' as const, revision: 1, updated_at: '' };
    expect(() => prepareImport(library, importSchema.parse({ schema_version: 1, relations: [cycle] }))).toThrow('循环');
    library.relations.push(cycle);
    const roots = practiceMainCards(library, 'p1');
    expect(roots.length).toBeGreaterThan(0);
    expect(new Set([roots[0].id, ...followupCards(library, roots[0].id).map(c => c.id)]).size).toBe(4);
  });
  it('新增卡片与追问关系一起保存，重试不会重复生成', () => {
    const library = fixture(), envelope = importSchema.parse({ schema_version: 1,
      cards: [{ id: 'new-child', project_id: 'p1', title: '追问', question: '为什么？' }],
      relations: [{ id: 'new-link', from_card_id: 'root', to_card_id: 'new-child', kind: 'followup', order: 3 }],
    });
    const next = prepareImport(library, envelope);
    expect(prepareImport(next, envelope).cards).toHaveLength(library.cards.length + 1);
    expect(followupCards(next, 'root').at(-1)?.id).toBe('new-child');
  });
  it('修改追问方向按保存后的关系判断，不受旧方向影响', () => {
    const library = fixture();
    const next = prepareImport(library, importSchema.parse({ schema_version: 1, relations: [
      { ...library.relations.find(r => r.id === 'r1'), from_card_id: 'child1', to_card_id: 'root' },
    ] }));
    expect(practiceMainCards(next, 'p1').map(c => c.id)).toEqual(['child1']);
  });
  it('详情默认只显示追问问题，未展开时不渲染答案', () => {
    const library = fixture();
    const html = renderToStaticMarkup(createElement(FollowupList, { library, card: library.cards[0], disabled: false, stateDisabled: false, onAdd() {}, onEdit() {}, onOpen() {}, onRemove() {}, onMark() {} }));
    expect(html).toContain('child1');
    expect(html).toContain('添加追问');
    expect(html).not.toContain('HIDDEN_OUTLINE');
    expect(html).not.toContain('HIDDEN_ANSWER');
  });
});
