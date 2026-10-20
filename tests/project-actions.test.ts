import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport, validateLibrary } from '../shared/model';
import { projectExport, removeProject } from '../shared/project-actions';
import { parseImportFile } from '../shared/import-file';

const fixture = () => prepareImport(emptyLibrary(), importSchema.parse({
  schema_version: 1,
  projects: [{ id: 'a', name: '待删除项目' }, { id: 'b', name: '保留项目' }, { id: 'empty', name: '空项目' }],
  topics: [{ id: 'shared', name: '共用知识点' }],
  cards: [
    { id: 'a1', project_id: 'a', title: '活动题', question: '问题', topic_ids: ['shared'] },
    { id: 'a2', project_id: 'a', title: '归档题', question: '问题', archived: true },
    { id: 'b1', project_id: 'b', title: '保留题', question: '问题', topic_ids: ['shared'] },
    { id: 'b2', project_id: 'b', title: '另一保留题', question: '问题' },
  ],
  sources: [{ id: 'source', name: '共享来源', kind: 'note', original_markdown: '完整原文' }],
  occurrences: ['a1', 'a2', 'b1'].map(id => ({ id: 'o-' + id, card_id: id, source_id: 'source', asked_question: '原始问法' })),
  relations: [
    { id: 'inside', from_card_id: 'a1', to_card_id: 'a2', kind: 'related' },
    { id: 'outgoing', from_card_id: 'a1', to_card_id: 'b1', kind: 'followup' },
    { id: 'incoming', from_card_id: 'b1', to_card_id: 'a2', kind: 'related' },
    { id: 'keep', from_card_id: 'b1', to_card_id: 'b2', kind: 'related' },
  ],
}));

describe('删除项目', () => {
  it('项目导出包含归档题、来源与内部连线，普通导入可重新读取且不带入其他项目', () => {
    const before = fixture(), bundle = projectExport(before, 'a');
    expect(bundle.cards.map(card => card.id)).toEqual(['a1', 'a2']);
    expect(bundle.cards[1].archived).toBe(true); expect(bundle.sources[0].original_markdown).toBe('完整原文');
    expect(bundle.relations.map(relation => relation.id)).toEqual(['inside']); expect(bundle.revisions).toEqual([]);
    const imported = prepareImport(emptyLibrary(), parseImportFile(JSON.stringify(bundle), 'import', emptyLibrary()));
    expect(imported.projects.map(project => project.id)).toEqual(['a']);
    expect(imported.cards.map(card => card.id)).toEqual(['a1', 'a2']);
    expect(() => validateLibrary(imported)).not.toThrow();
  });

  it('空项目可独立导出，不存在的项目不能生成误导性的空包', () => {
    const bundle = projectExport(fixture(), 'empty');
    expect(bundle.projects[0].id).toBe('empty');
    for (const kind of ['cards', 'topics', 'sources', 'occurrences', 'relations'] as const) expect(bundle[kind]).toEqual([]);
    expect(() => projectExport(fixture(), 'missing')).toThrow('项目不存在');
  });

  it('同时删除活动与归档卡片及依赖，保留其他项目、共用知识点与来源原文', () => {
    const before = fixture(), copy = structuredClone(before), next = removeProject(before, 'a');
    expect(next.projects.map(project => project.id)).toEqual(['b', 'empty']);
    expect(next.cards.map(card => card.id)).toEqual(['b1', 'b2']);
    expect(next.occurrences.map(record => record.card_id)).toEqual(['b1']);
    expect(next.relations.map(relation => relation.id)).toEqual(['keep']);
    expect(next.revisions.map(entry => entry.card_id)).toEqual(['b1', 'b2']);
    expect(next.sources).toEqual(copy.sources); expect(next.topics).toEqual(copy.topics);
    expect(next.cards).toEqual(copy.cards.slice(2)); expect(before).toEqual(copy);
    expect(() => validateLibrary(next)).not.toThrow();
  });

  it('空项目和最后一个项目均可删除，原始来源仍可从备份中读取', () => {
    let library = fixture();
    const next = removeProject(library, 'empty');
    expect(next.cards).toEqual(library.cards); expect(next.relations).toEqual(library.relations);
    library = removeProject(removeProject(next, 'a'), 'b');
    expect(library.projects).toEqual([]); expect(library.cards).toEqual([]);
    expect(library.sources[0].original_markdown).toBe('完整原文');
    expect(() => validateLibrary(library)).not.toThrow();
  });

  it('不存在或重复删除返回不存在，不改变题库', () => {
    const library = fixture();
    expect(() => removeProject(library, 'missing')).toThrow('项目不存在');
    expect(() => removeProject(removeProject(library, 'a'), 'a')).toThrow('项目不存在');
    expect(library.projects).toHaveLength(3);
  });
});
