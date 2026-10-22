import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport, validateLibrary } from '../shared/model';
import { removeCard } from '../shared/card-actions';
import { followupCards } from '../shared/followups';
import { practiceMainCards } from '../shared/practice';

const fixture = () => prepareImport(emptyLibrary(), importSchema.parse({
  schema_version: 1,
  projects: [{ id: 'bank', name: '测试题库' }],
  topics: [{ id: 'topic', name: '知识点' }],
  cards: ['a', 'b', 'c'].map(id => ({ id, project_id: 'bank', title: id, question: '问题 ' + id, topic_ids: ['topic'] })),
  sources: [{ id: 'source', name: '原始来源', kind: 'note', original_markdown: '保留完整原文' }],
  occurrences: ['a', 'b'].map(id => ({ id: 'occurrence-' + id, card_id: id, source_id: 'source', asked_question: '原始问法 ' + id })),
  relations: [{ id: 'outgoing', from_card_id: 'a', to_card_id: 'b', kind: 'followup' }, { id: 'incoming', from_card_id: 'c', to_card_id: 'a', kind: 'related' }, { id: 'other', from_card_id: 'b', to_card_id: 'c', kind: 'related' }],
}));

describe('知识卡删除', () => {
  it('移除卡片与自身依赖，其他题目和来源原文保持完整', () => {
    const library = fixture(), before = structuredClone(library), next = removeCard(library, 'a');
    expect(next.cards.map(card => card.id)).toEqual(['b', 'c']);
    expect(next.occurrences.map(record => record.card_id)).toEqual(['b']);
    expect(next.relations.map(relation => relation.id)).toEqual(['other']);
    expect(next.revisions.map(entry => entry.card_id)).toEqual(['b', 'c']);
    expect(next.sources).toEqual(before.sources); expect(next.topics).toEqual(before.topics); expect(next.projects).toEqual(before.projects);
    expect(next.cards).toEqual(before.cards.slice(1)); expect(library).toEqual(before);
    expect(() => validateLibrary(next)).not.toThrow();
  });

  it('没有来源记录的卡片可以删除，不会误删共享来源或无关关系', () => {
    const library = fixture(), next = removeCard(library, 'c');
    expect(next.occurrences).toEqual(library.occurrences);
    expect(next.relations.map(relation => relation.id)).toEqual(['outgoing']);
    expect(next.sources[0].original_markdown).toBe('保留完整原文');
    expect(() => validateLibrary(next)).not.toThrow();
  });

  it('重复或不存在的删除明确返回不存在，不改变题库', () => {
    const library = fixture();
    expect(() => removeCard(library, 'missing')).toThrow('知识卡不存在');
    const next = removeCard(library, 'a');
    expect(() => removeCard(next, 'a')).toThrow('知识卡不存在');
    expect(library.cards).toHaveLength(3);
  });

  it('删除主问题提升按追问顺序的第一题，其他追问归到它下面并保留原有子问题', () => {
    const library = fixture();
    library.cards.push({ ...library.cards[2], id: 'd', title: 'd', question: 'd' });
    library.relations = [
      { id: 'a-c', from_card_id: 'a', to_card_id: 'c', kind: 'followup', order: 2, revision: 1, updated_at: '' },
      { id: 'a-b', from_card_id: 'a', to_card_id: 'b', kind: 'followup', order: 1, revision: 1, updated_at: '' },
      { id: 'b-d', from_card_id: 'b', to_card_id: 'd', kind: 'followup', order: 10, revision: 1, updated_at: '' },
    ];
    const next = removeCard(library, 'a');
    expect(practiceMainCards(next).map(card => card.id)).toEqual(['b']);
    expect(followupCards(next, 'b').map(card => card.id)).toEqual(['d', 'c']);
    expect(next.cards).toEqual(library.cards.filter(card => card.id !== 'a'));
    expect(next.relations.find(relation => relation.id === 'a-c')).toMatchObject({ from_card_id: 'b', to_card_id: 'c', revision: 2 });
    expect(() => validateLibrary(next)).not.toThrow();
  });

  it('连续删除时跳过已删追问，删除嵌套问题时保留原主问题', () => {
    const library = fixture();
    library.cards.push({ ...library.cards[2], id: 'd', title: 'd', question: 'd' });
    library.relations = ['a-b', 'b-c', 'b-d'].map((id, order) => ({ id, from_card_id: id[0], to_card_id: id[2], kind: 'followup' as const, order, revision: 1, updated_at: '' }));
    const nested = removeCard(library, 'b');
    expect(practiceMainCards(nested).map(card => card.id)).toEqual(['a']);
    expect(followupCards(nested, 'a').map(card => card.id)).toEqual(['c', 'd']);
    expect(practiceMainCards(removeCard(nested, 'a')).map(card => card.id)).toEqual(['c']);
    expect(() => validateLibrary(nested)).not.toThrow();
  });

  it('不会把归档卡片或其他项目追问提升为本题主问题', () => {
    const library = fixture();
    library.cards[1].archived = true;
    library.projects.push({ ...library.projects[0], id: 'other', name: '其他题库' });
    library.cards[2].project_id = 'other';
    library.relations.push({ id: 'cross', from_card_id: 'a', to_card_id: 'c', kind: 'followup', revision: 1, updated_at: '' });
    const next = removeCard(library, 'a');
    expect(next.relations).toEqual(library.relations.filter(relation => relation.from_card_id !== 'a' && relation.to_card_id !== 'a'));
    expect(next.cards).toEqual(library.cards.slice(1));
  });
});
