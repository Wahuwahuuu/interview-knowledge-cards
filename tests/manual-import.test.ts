import { describe, expect, it } from 'vitest';
import { buildManualImportEnvelope, createManualImportDraft, createManualImportQuestion } from '../shared/manual-import';
import { emptyLibrary, importSchema, prepareImport, projectSchema } from '../shared/model';

function setup(projectId = 'existing-bank') {
  let nextId = 0;
  const idFactory = (prefix: string) => `${prefix}-manual-${++nextId}`;
  const library = emptyLibrary();
  if (projectId) library.projects.push(projectSchema.parse({ id: projectId, name: '已有题库', description: '保留说明', revision: 7, updated_at: '2026-01-01' }));
  const draft = createManualImportDraft(projectId, idFactory);
  draft.questions[0] = { ...draft.questions[0], title: '事务', question: '什么是事务？', summary: '面试口述', answer: '详细讲解' };
  return { library, draft, idFactory };
}

describe('人工填写导入', () => {
  it('只生成合并草稿，现有题库的说明和版本不进入导入', () => {
    const { library, draft } = setup(), before = structuredClone(library);
    const envelope = buildManualImportEnvelope(library, draft);
    expect(envelope.mode).toBe('merge'); expect(envelope.schema_version).toBe(1);
    expect(envelope.projects).toEqual([]); expect(envelope.revisions).toEqual([]); expect(envelope.batch_id).toBeUndefined();
    expect(envelope.cards[0]).toMatchObject({ project_id: 'existing-bank', title: '事务', question: '什么是事务？', summary_md: '面试口述', answer_md: '详细讲解', mastery: 'review' });
    expect(library).toEqual(before);
    expect(prepareImport(library, envelope).projects).toEqual(library.projects);
  });

  it('空库中可填写新题库，并使用同一新题库归属所有题目', () => {
    const { library, draft, idFactory } = setup('');
    expect(draft.destination).toBe('new');
    draft.newProjectName = '  数据库基础  ';
    draft.questions.push({ ...createManualImportQuestion(idFactory), title: '索引', question: '索引有什么作用？' });
    const envelope = buildManualImportEnvelope(library, draft);
    expect(envelope.projects).toHaveLength(1); expect(envelope.projects[0].name).toBe('数据库基础');
    expect(envelope.cards.every(card => card.project_id === envelope.projects[0].id)).toBe(true);
    expect(prepareImport(library, envelope).cards).toHaveLength(2);
  });

  it('重复预览和修改文字不会重造卡片或新题库 ID', () => {
    const { library, draft } = setup(''); draft.newProjectName = '新题库';
    const first = buildManualImportEnvelope(library, draft);
    expect(buildManualImportEnvelope(library, draft)).toEqual(first);
    draft.questions[0].answer = '更新后的详细讲解'; draft.newProjectName = '新题库名称';
    const edited = buildManualImportEnvelope(library, draft);
    expect(edited.cards[0].id).toBe(first.cards[0].id); expect(edited.projects[0].id).toBe(first.projects[0].id);
    expect(edited.cards[0].answer_md).toBe('更新后的详细讲解');
  });

  it('多道题标识不同，移除后新增题目不会复用已删除题目标识', () => {
    const { library, draft, idFactory } = setup();
    const second = { ...createManualImportQuestion(idFactory), title: '索引', question: '什么是索引？' };
    draft.questions.push(second);
    const removedId = draft.questions.shift()!.id;
    draft.questions.push({ ...createManualImportQuestion(idFactory), title: '锁', question: '锁有什么作用？' });
    const envelope = buildManualImportEnvelope(library, draft);
    expect(new Set(envelope.cards.map(card => card.id)).size).toBe(2); expect(envelope.cards.some(card => card.id === removedId)).toBe(false);
  });

  it('标题和问题不能只有空白，答案允许留空并保留 Markdown 排版', () => {
    const { library, draft } = setup();
    draft.questions[0].title = ' \t\n　'; expect(() => buildManualImportEnvelope(library, draft)).toThrow('第 1 题的标题');
    draft.questions[0].title = '  事务  '; draft.questions[0].question = '\n\t '; expect(() => buildManualImportEnvelope(library, draft)).toThrow('第 1 题的问题');
    draft.questions[0].question = '  什么是事务？\n'; draft.questions[0].summary = ''; draft.questions[0].answer = '  ```sql\nSELECT 1;\n```\n';
    expect(buildManualImportEnvelope(library, draft).cards[0]).toMatchObject({ title: '事务', question: '什么是事务？', summary_md: '', answer_md: draft.questions[0].answer });
    draft.questions[0].answer = ''; expect(importSchema.safeParse(buildManualImportEnvelope(library, draft)).success).toBe(true);
  });

  it('题库名称、题库选择与空题目列表都必须有效', () => {
    const { library, draft } = setup(''); draft.newProjectName = '   '; expect(() => buildManualImportEnvelope(library, draft)).toThrow('新题库的名称');
    draft.destination = 'existing'; draft.projectId = ''; expect(() => buildManualImportEnvelope(library, draft)).toThrow('请选择');
    draft.projectId = 'removed-bank'; expect(() => buildManualImportEnvelope(library, draft)).toThrow('请选择');
    draft.destination = 'new'; draft.newProjectName = '题库'; draft.questions = []; expect(() => buildManualImportEnvelope(library, draft)).toThrow('至少填写一道题');
  });

  it('不允许重复 ID 或把同一 ID 卡片改到另一个题库', () => {
    const { library, draft } = setup();
    draft.questions.push({ ...draft.questions[0] }); expect(() => buildManualImportEnvelope(library, draft)).toThrow('已失效');
    draft.questions.pop(); library.cards = buildManualImportEnvelope(library, draft).cards;
    library.cards[0].project_id = 'another-bank';
    expect(() => buildManualImportEnvelope(library, draft)).toThrow('已失效');
  });

  it('确认较早预览后，可继续预览保留的修改，保留已入库题库与卡片 metadata', () => {
    const { library, draft, idFactory } = setup(''); draft.newProjectName = '已经导入的题库';
    const applied = prepareImport(library, buildManualImportEnvelope(library, draft));
    applied.projects[0].description = '保留题库说明'; applied.projects[0].revision = 4;
    applied.cards[0].favorite = true; applied.cards[0].mastery = 'mastered';
    draft.newProjectName = '不应覆盖已有名称'; draft.questions[0].summary = '预览后修改的口述版';
    draft.questions.push({ ...createManualImportQuestion(idFactory), title: '索引', question: '索引是什么？' });
    const continued = buildManualImportEnvelope(applied, draft);
    expect(continued.projects).toEqual([]); expect(continued.cards).toHaveLength(2);
    expect(continued.cards[0]).toMatchObject({ summary_md: '预览后修改的口述版', favorite: true, mastery: 'mastered' });
    expect(prepareImport(applied, continued).projects).toEqual(applied.projects);
    expect(prepareImport(applied, continued).cards).toHaveLength(2);
  });

  it('超长名称、标题、答案和超过单批题数上限给出可理解的错误', () => {
    const { library, draft } = setup();
    draft.questions[0].title = '题'.repeat(151); expect(() => buildManualImportEnvelope(library, draft)).toThrow('最多 150');
    draft.questions[0].title = '题'; draft.questions[0].answer = '答'.repeat(400_001); expect(() => buildManualImportEnvelope(library, draft)).toThrow('完整答案最多');
    draft.questions[0].answer = ''; draft.destination = 'new'; draft.newProjectName = '库'.repeat(101); expect(() => buildManualImportEnvelope(library, draft)).toThrow('最多 100');
    draft.questions = Array.from({ length: 2001 }, () => draft.questions[0]); expect(() => buildManualImportEnvelope(library, draft)).toThrow('最多导入 2000');
  });
});
