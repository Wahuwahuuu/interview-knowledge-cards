import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cardSchema, emptyLibrary, graphElements, importSchema, prepareImport, projectSchema, topicSchema } from '../shared/model';
import { cardCategories, knowledgeCategories, withCategory } from '../shared/topic-categories';
import { buildManualImportEnvelope, createManualImportDraft } from '../shared/manual-import';
import { CardForm, FollowupForm } from '../src/Editors';
import { ManualImportForm } from '../src/ManualImportForm';

const sourceId = 'source-audit-20261022-original';
function fixture() {
  const library = emptyLibrary();
  library.projects = [projectSchema.parse({ id: 'bank', name: '示例题库' })];
  library.topics = [
    topicSchema.parse({ id: 'mysql', name: 'MySQL' }),
    topicSchema.parse({ id: 'redis', name: 'Redis 与缓存' }),
    topicSchema.parse({ id: 'old-index', name: '旧的索引细分类', archived: true }),
    topicSchema.parse({ id: sourceId, name: '来源：面经原题' }),
  ];
  library.cards = [cardSchema.parse({ id: 'card', project_id: 'bank', title: '索引', question: '为什么使用索引？', topic_ids: ['mysql', sourceId] })];
  return library;
}

describe('知识大类单选', () => {
  it('分类列表和图谱隐藏归档细类与来源标记，修改分类保留来源', () => {
    const library = fixture(), card = library.cards[0];
    expect(knowledgeCategories(library.topics).map(t => t.id)).toEqual(['mysql', 'redis']);
    expect(cardCategories(card, library.topics).map(t => t.id)).toEqual(['mysql']);
    expect(withCategory(card, 'redis')).toEqual([sourceId, 'redis']);
    expect(withCategory(card, '')).toEqual([sourceId]);
    card.topic_ids.push('old-index');
    const graph = JSON.stringify(graphElements(library));
    expect(graph).toContain('t:mysql');
    expect(graph).not.toContain('old-index'); expect(graph).not.toContain(sourceId);
  });

  it('新建和更改分类禁止多选，JSON和人工保存使用同一规则', () => {
    const library = fixture(), card = library.cards[0];
    expect(() => prepareImport(library, importSchema.parse({ schema_version: 1, cards: [{ ...card, topic_ids: ['mysql', 'redis', sourceId] }] }))).toThrow('只能选择一个知识大类');
    expect(() => prepareImport(library, importSchema.parse({ schema_version: 1, cards: [{ ...card, id: 'new', topic_ids: ['mysql', 'redis'] }] }))).toThrow('只能选择一个知识大类');
    const updated = prepareImport(library, importSchema.parse({ schema_version: 1, cards: [{ ...card, topic_ids: withCategory(card, 'redis') }] }));
    expect(updated.cards[0].topic_ids).toEqual([sourceId, 'redis']);
    expect(updated.revisions[0].snapshot.topic_ids).toEqual([sourceId, 'redis']);
  });

  it('旧备份和历史不被改写，旧多标签不阻塞答案编辑', () => {
    const library = fixture(); library.cards[0].topic_ids = ['mysql', 'redis', sourceId];
    const restored = prepareImport(emptyLibrary(), importSchema.parse({ ...library, mode: 'restore' }));
    expect(restored.cards[0]).toEqual(library.cards[0]);
    expect(restored.revisions[0].snapshot).toEqual(library.cards[0]);
    const edited = prepareImport(library, importSchema.parse({ schema_version: 1, cards: [{ ...library.cards[0], answer_md: '新的答案' }] }));
    expect(edited.cards[0].answer_md).toBe('新的答案');
  });

  it('新增大类不允许重复名称，归档小类可以与在用大类同名', () => {
    const library = fixture();
    expect(() => prepareImport(library, importSchema.parse({ schema_version: 1, topics: [{ id: 'duplicate', name: 'MySQL' }] }))).toThrow('已存在');
    expect(() => prepareImport(library, importSchema.parse({ schema_version: 1, topics: [{ id: 'retired', name: 'MySQL', archived: true }] }))).not.toThrow();
  });

  it('编辑卡片和新建追问都是下拉单选，不再罗列知识点或来源', () => {
    const library = fixture(), props = { library, expectedRevision: 0, onSaved() {}, onDirty() {}, onError() {} };
    for (const html of [renderToStaticMarkup(createElement(CardForm, { ...props, initial: library.cards[0] })), renderToStaticMarkup(createElement(FollowupForm, { ...props, card: library.cards[0] }))]) {
      expect(html).toContain('知识大类</span><select');
      expect(html).toContain('value="mysql" selected');
      for (const hidden of [' multiple', 'topic-check', '新增知识点', '旧的索引细分类', '来源：面经原题']) expect(html).not.toContain(hidden);
    }
  });

  it('填写导入可选一个大类，错误引用不提交；更新仍保留来源', () => {
    const library = fixture(), draft = createManualImportDraft('bank');
    draft.questions[0] = { ...draft.questions[0], id: 'card', title: '索引', question: '为什么使用索引？', categoryId: 'redis' };
    expect(buildManualImportEnvelope(library, draft).cards[0].topic_ids).toEqual([sourceId, 'redis']);
    draft.questions[0].categoryId = 'old-index';
    expect(() => buildManualImportEnvelope(library, draft)).toThrow('现有知识大类');
    draft.questions[0].categoryId = '';
    expect(buildManualImportEnvelope(library, draft).cards[0].topic_ids).toEqual([sourceId]);
    const html = renderToStaticMarkup(createElement(ManualImportForm, { library, offline: false, busy: false, resetKey: 0, async onImport() {} }));
    expect(html).toContain('知识大类'); expect(html).toContain('value="redis"');
    expect(html).not.toContain('旧的索引细分类'); expect(html).not.toContain('来源：面经原题');
  });
});
