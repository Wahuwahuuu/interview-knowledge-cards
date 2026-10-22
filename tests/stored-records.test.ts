import { describe, expect, it } from 'vitest';
import { schemas, type Kind } from '../shared/model';
import { decodeStoredRecord } from '../worker/stored-records';

const examples = {
  projects: { id: 'p', name: '项目' },
  topics: { id: 't', name: '知识点' },
  sources: { id: 's', name: '来源', kind: 'note' },
  cards: { id: 'q', project_id: 'p', title: '01. ⭐ 索引', question: '什么是索引？' },
  occurrences: { id: 'o', card_id: 'q', source_id: 's', asked_question: '原始问法？' },
  relations: { id: 'r', from_card_id: 'q', to_card_id: 'q2', kind: 'followup' },
};
describe('已校验存储记录的读取兼容', () => {
  it.each(Object.keys(examples) as Kind[])('%s 补齐历史可选字段，与原读取契约一致', kind => {
    expect(decodeStoredRecord(kind, JSON.stringify(examples[kind]))).toEqual(schemas[kind].parse(examples[kind]));
    const complete = schemas[kind].parse(examples[kind]);
    expect(decodeStoredRecord(kind, JSON.stringify(complete))).toEqual(complete);
  });
  it('旧星号迁移保留显式重点，未提供的集合不在卡片间共享', () => {
    const a = decodeStoredRecord('cards', JSON.stringify({ ...examples.cards, important: false })) as ReturnType<typeof schemas.cards.parse>;
    const b = decodeStoredRecord('cards', JSON.stringify(examples.cards)) as typeof a;
    expect(a.title).toBe('01. 索引'); expect(a.important).toBe(false); expect(b.important).toBe(true);
    a.topic_ids.push('t'); expect(b.topic_ids).toEqual([]);
    a.evidence.push({ label: '旧证据', path: '', url: '' }); expect(b.evidence).toEqual([]);
  });
});
