import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport, validateLibrary } from '../shared/model';
import { removeCard } from '../shared/card-actions';

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
});
