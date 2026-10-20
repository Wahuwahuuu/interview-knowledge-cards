import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cardSchema, emptyLibrary, importSchema, librarySchema, markdownExport, prepareImport } from '../shared/model';
import { legacyPriorityTitle } from '../shared/card-priority';
import { InlineMarkdown } from '../src/Markdown';
import { CardCollection } from '../src/CardCollection';
import { CardForm } from '../src/Editors';
import { CardFullAnswer } from '../src/CardContent';
import { ConfirmationDialog } from '../src/ConfirmationDialog';
import { mergeDownloads, type Download } from '../src/offline';

const question = { id: 'q1', project_id: 'mysql', title: '02. ⭐ 如何使用 `EXPLAIN`？', question: '如何使用 `EXPLAIN` 分析 **执行计划**？', summary_md: '口述内容', answer_md: '详细答案', limitations_md: '旧边界资料', source_baseline: '旧基线', evidence: [{ label: '旧依据', path: 'private-source.ts' }] };
const fixture = () => prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1, projects: [{ id: 'mysql', name: 'MySQL' }], cards: [question] }));

describe('题目展示与重点兼容', () => {
  it('完整答案首次打开不挂载正文，避免在收起时解析答案', () => {
    const html = renderToStaticMarkup(createElement(CardFullAnswer, { text: 'ANSWER_NOT_MOUNTED **详细内容**' }));
    expect(html).toContain('<summary>完整答案</summary>');
    expect(html).not.toContain(' open'); expect(html).not.toContain('ANSWER_NOT_MOUNTED'); expect(html).not.toContain('markdown');
  });

  it('删除确认显示具体题目，初始不执行删除，处理中禁止取消或再次提交', () => {
    let deletes = 0;
    const html = renderToStaticMarkup(createElement(ConfirmationDialog, { title: '删除这张知识卡？', name: createElement(InlineMarkdown, { text: question.title }), description: '删除后无法直接撤销', busy: true, error: '删除失败，请重试', onCancel() {}, onConfirm() { deletes++; } }));
    expect(html).toContain('删除这张知识卡'); expect(html).toContain('<code>EXPLAIN</code>');
    expect(html).toContain('正在处理'); expect(html).toContain('删除失败，请重试'); expect(html).toContain('role="alertdialog"');
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3); expect(deletes).toBe(0);
  });

  it('只移除题首和题号后装饰星号，SQL星号和Markdown强调不受影响', () => {
    for (const title of ['01. ⭐ 事务', '02 · ★★ 事务', '☆ 事务', '⭐️ 事务']) {
      expect(legacyPriorityTitle(title).marked).toBe(true);
      expect(legacyPriorityTitle(title).title).not.toMatch(/[⭐★☆]/u);
    }
    for (const title of ['SELECT * FROM t', '**事务**', '`COUNT(*)`', '字符串中的 ⭐ 字符']) expect(legacyPriorityTitle(title)).toEqual({ title, marked: false });
  });

  it('暂时不能确认时仍允许取消和关闭，并把影响说明关联到弹窗', () => {
    const html = renderToStaticMarkup(createElement(ConfirmationDialog, { title: '确认删除', description: '当前无法提交', confirmDisabled: true, onCancel() {}, onConfirm() {} }));
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(1);
    expect(html).toContain('aria-describedby="delete-description"');
    expect(html).toContain('id="delete-description"'); expect(html).toContain('>取消</button>');
  });

  it('旧题目自动获得重点属性，显式取消重点不会再次被旧格式覆盖', () => {
    const old = structuredClone(question), card = cardSchema.parse(old);
    expect(card).toMatchObject({ title: '02. 如何使用 `EXPLAIN`？', important: true, answer_md: question.answer_md });
    expect(old).toEqual(question);
    expect(cardSchema.parse({ ...question, important: false }).important).toBe(false);
    expect(cardSchema.parse({ ...question, title: '普通题目' }).important).toBe(false);
    expect(() => cardSchema.parse({ ...question, important: 'true' })).toThrow();
  });

  it('重点修改保存历史，旧来源问法保持原文，导出仍保留重点含义', () => {
    const base = fixture();
    base.sources.push({ id: 'source', name: '原始记录', kind: 'note', original_markdown: question.title, revision: 1, updated_at: '', date: '', company: '', job: '', round: '', notes: '', source_path: '' });
    const next = prepareImport(base, importSchema.parse({ schema_version: 1, cards: [{ ...base.cards[0], important: false }] }));
    expect(next.cards[0]).toMatchObject({ important: false, revision: 2 });
    expect(next.revisions.at(-1)?.snapshot.important).toBe(false);
    expect(next.sources[0].original_markdown).toBe(question.title);
    expect(markdownExport(base)).toContain('（重点）');
    expect(markdownExport(base)).not.toContain('#### 实现边界');
    expect(markdownExport(base)).not.toContain('源码基线：');
  });

  it('旧备份、历史快照和离线题库均使用同一转换规则', () => {
    const old = { ...emptyLibrary(), projects: [{ id: 'mysql', name: 'MySQL' }], cards: [question], revisions: [{ card_id: 'q1', revision: 1, saved_at: '', action: '旧记录', snapshot: question }] };
    const parsed = librarySchema.parse(old);
    expect(parsed.cards[0].important).toBe(true); expect(parsed.revisions[0].snapshot.important).toBe(true);
    const offline = mergeDownloads([{ id: 'mysql', owner: 'fixture@example.test', downloaded_at: '', snapshot: old } as unknown as Download], 'fixture@example.test');
    expect(offline.cards[0].title).not.toContain('⭐'); expect(offline.cards[0].important).toBe(true);
  });

  it('机器导入格式仍可生成JSON Schema，并包含boolean重点属性', () => {
    const schema = z.toJSONSchema(importSchema) as any;
    expect(schema.properties.cards.items.properties.important).toMatchObject({ type: 'boolean', default: false });
  });

  it('题目行内代码与加粗能渲染，不生成块级元素、危险链接或远程图片', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: question.question + ' [链接](javascript:alert) <img src="https://example.test/track">' }));
    expect(html).toContain('<code>EXPLAIN</code>'); expect(html).toContain('<strong>执行计划</strong>');
    expect(html).not.toContain('`'); expect(html).not.toMatch(/<p>|<h\d|<a |<img|javascript:/);
  });

  it('题目列表只显示可打开的标题，卡片视图保留其他资料并显示重点', () => {
    const library = fixture(), props = { cards: library.cards, library, onOpen() {}, onFavorite() {}, disabled: false };
    const list = renderToStaticMarkup(createElement(CardCollection, { ...props, layout: 'list' }));
    expect(list).toContain('<code>EXPLAIN</code>'); expect(list).toContain('question-list-row');
    expect(list).not.toContain('02.');
    for (const text of ['待复习', '来源记录', '口述内容', '详细答案', '收藏', 'priority-badge']) expect(list).not.toContain(text);
    const cards = renderToStaticMarkup(createElement(CardCollection, { ...props, layout: 'cards' }));
    expect(cards).toContain('priority-badge'); expect(cards).toContain('重点'); expect(cards).toContain('<strong>执行计划</strong>');
    expect(cards).not.toContain('>02. 如何使用');
  });

  it('卡片属性提供重点，旧边界与源码字段不再作为编辑项目显示', () => {
    const library = fixture();
    const html = renderToStaticMarkup(createElement(CardForm, { library, initial: library.cards[0], expectedRevision: library.revision, onSaved() {}, onDirty() {}, onError() {} }));
    expect(html).toContain('priority-checkbox'); expect(html).toContain('checked'); expect(html).toContain('重点');
    for (const label of ['实现边界与待核实', '源码与文档依据', '源码基线', '旧边界资料', 'private-source.ts']) expect(html).not.toContain(label);
  });
});
