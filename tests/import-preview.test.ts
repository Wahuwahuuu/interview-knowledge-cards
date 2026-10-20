import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Change, diffLibraries, emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { ImportPreview } from '../src/ImportPreview';

function render(changes: Change[], mode: 'merge' | 'restore' = 'merge') {
  return renderToStaticMarkup(createElement(ImportPreview, { changes, mode }));
}

// The secondary section can contain nested <details>, so split at its opening
// rather than accidentally treating one nested closing tag as its boundary.
function sections(html: string) {
  const secondaryStart = html.indexOf('<details class="import-secondary"');
  return secondaryStart < 0
    ? { primary: html, secondary: '' }
    : { primary: html.slice(0, secondaryStart), secondary: html.slice(secondaryStart) };
}

function fieldLabels(html: string) {
  return [...html.matchAll(/<h4>(.*?)<\/h4>/g)].map(match => match[1]);
}

function addedQuestion(id = 'question-internal-id', title = 'Redis 数据类型'): Change {
  return {
    kind: 'cards', id, name: title, operation: 'add', fields: [
      { field: 'id', before: undefined, after: id },
      { field: 'project_id', before: undefined, after: 'project-internal-id' },
      { field: 'title', before: undefined, after: title },
      { field: 'question', before: undefined, after: '五大类型适合什么场景？' },
      { field: 'summary_md', before: undefined, after: '## 面试口述版\n\n先讲 **访问方式**，再讲场景。' },
      { field: 'answer_md', before: undefined, after: '## 详细讲解\n\n- String 用来缓存对象\n- Hash 用来按字段读写\n\n`GET key`' },
      { field: 'revision', before: undefined, after: 1 },
      { field: 'limitations_md', before: undefined, after: 'metadata-only-limitations' },
      { field: 'topic_ids', before: undefined, after: ['topic-internal-id'] },
    ],
  };
}

describe('导入审阅只默认呈现需要核对的问答正文', () => {
  it('真实导入差异中，四字段与渲染后的 Markdown 在正文，ID、标签及关联在默认收起的资料区', () => {
    const base = emptyLibrary();
    const target = prepareImport(base, importSchema.parse({
      schema_version: 1,
      projects: [{ id: 'project-internal-id', name: 'Redis 八股' }],
      topics: [{ id: 'topic-internal-id', name: '数据类型知识点' }],
      cards: [
        { id: 'question-internal-id', project_id: 'project-internal-id', title: 'Redis 数据类型', question: '五大类型适合什么场景？', summary_md: '## 面试口述版\n\n优先说明 **访问方式**。', answer_md: '## 详细讲解\n\n- String 缓存对象\n\n`GET key`', topic_ids: ['topic-internal-id'], limitations_md: 'metadata-only-limitations' },
        { id: 'second-question-id', project_id: 'project-internal-id', title: 'Redis 底层实现', question: '什么是 SDS？' },
      ],
      relations: [{ id: 'relation-internal-id', from_card_id: 'question-internal-id', to_card_id: 'second-question-id', kind: 'related' }],
    }));
    const { primary, secondary } = sections(render(diffLibraries(base, target)));

    expect(primary).toContain('2 道题需要审阅');
    expect(primary).toContain('question-changes');
    expect(fieldLabels(primary)).toEqual(['标题', '问题', '复习提纲', '完整答案', '标题', '问题', '复习提纲', '完整答案']);
    expect(primary).toContain('<h2>面试口述版</h2>');
    expect(primary).toContain('<strong>访问方式</strong>');
    expect(primary).toContain('<li>String 缓存对象</li>');
    expect(primary).toContain('<code>GET key</code>');
    for (const value of ['question-internal-id', 'project-internal-id', 'topic-internal-id', 'relation-internal-id', 'metadata-only-limitations', '历史版本编号', '关系起点', '数据类型知识点', 'Redis 数据类型 ↔ Redis 底层实现']) {
      expect(primary).not.toContain(value);
      expect(secondary).toContain(value);
    }
    expect(secondary.match(/^<details[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
    const questionOpeners = [...primary.matchAll(/<details class="change-row question-change"[^>]*>/g)].map(match => match[0]);
    expect(questionOpeners).toHaveLength(2);
    for (const opener of questionOpeners) expect(opener).not.toMatch(/\sopen(?:\s|=|>)/);
  });

  it('只更新元数据或历史版本时，不生成缺少问答正文的空卡片', () => {
    const changes: Change[] = [{
      kind: 'cards', id: 'question-internal-id', name: 'Redis 数据类型', operation: 'update', fields: [
        { field: 'topic_ids', before: [], after: ['topic-internal-id'] },
        { field: 'revision', before: 1, after: 2 },
        { field: 'history', before: 1, after: 2 },
      ],
    }];
    const { primary, secondary } = sections(render(changes));
    expect(primary).toContain('没有题目正文变化');
    expect(primary).not.toContain('question-changes');
    expect(primary).not.toContain('暂未填写');
    expect(primary).not.toContain('没有需要应用的变化');
    expect(secondary).toContain('历史版本数量');
    expect(secondary).toContain('topic-internal-id');
  });

  it('修改答案保留前后对照及 Markdown，不把未变字段误呈现为空', () => {
    const { primary, secondary } = sections(render([{
      kind: 'cards', id: 'question-internal-id', name: 'Redis 持久化', operation: 'update', fields: [
        { field: 'answer_md', before: '旧答案 **RDB 快照**\n\n`SAVE`', after: '新答案 **AOF 日志**\n\n| 方式 | 内容 |\n| --- | --- |\n| AOF | 写命令 |' },
        { field: 'revision', before: 1, after: 2 },
      ],
    }]));
    expect(fieldLabels(primary)).toEqual(['完整答案']);
    expect(primary).toContain('当前内容');
    expect(primary).toContain('导入后');
    expect(primary).toContain('<strong>RDB 快照</strong>');
    expect(primary).toContain('<strong>AOF 日志</strong>');
    expect(primary).toContain('<code>SAVE</code>');
    expect(primary).toContain('<table>');
    expect(primary).not.toContain('暂未填写');
    expect(primary).not.toContain('历史版本编号');
    expect(secondary).toContain('历史版本编号');
  });

  it('删除问题即使没有字段差异，也保留题名和移除提示且默认收起', () => {
    const { primary } = sections(render([{ kind: 'cards', id: 'removed-id', name: '准备移除的 Redis 问题', operation: 'remove', fields: [] }]));
    expect(primary).toContain('1 道题需要审阅');
    expect(primary).toContain('准备移除的 Redis 问题');
    expect(primary).toContain('这道题将从题库中移除');
    expect(primary.match(/<details class="change-row question-change"[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
  });

  it('完整恢复在折叠区外明确提示问题和其他资料的删除数量', () => {
    const { primary, secondary } = sections(render([
      { kind: 'cards', id: 'removed-question', name: '旧问题', operation: 'remove', fields: [] },
      { kind: 'topics', id: 'removed-topic', name: '旧知识点', operation: 'remove', fields: [] },
      { kind: 'relations', id: 'removed-relation', name: '旧关联', operation: 'remove', fields: [] },
    ], 'restore'));
    expect(primary).toContain('此次恢复将移除 1 道题及 2 条其他资料');
    expect(primary).toContain('这道题将从题库中移除');
    expect(primary).not.toContain('旧关联');
    expect(secondary).toContain('旧关联');
    expect(secondary.match(/^<details[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
  });

  it('只有辅助资料删除的恢复仍提示风险，不误称题库完全没有变化', () => {
    const { primary, secondary } = sections(render([{ kind: 'sources', id: 'removed-source', name: '旧面试来源', operation: 'remove', fields: [] }], 'restore'));
    expect(primary).toContain('没有题目正文变化');
    expect(primary).toContain('此次恢复将移除 0 道题及 1 条其他资料');
    expect(primary).not.toContain('没有需要应用的变化');
    expect(primary).not.toContain('question-changes');
    expect(secondary).toContain('旧面试来源');
  });

  it('完全相同的题库才显示没有需要应用的变化', () => {
    const html = render([]);
    expect(html).toContain('内容相同，没有需要应用的变化');
    expect(html).not.toContain('question-changes');
    expect(html).not.toContain('import-secondary');
  });

  it('问答中的 HTML 和不安全链接不可执行，正常链接和代码仍可读', () => {
    const change = addedQuestion();
    change.fields = change.fields.map(field => field.field === 'summary_md' ? {
      ...field,
      after: '<script>alert(1)</script>\n\n<img src="https://external.example/track" onerror="alert(1)" />\n\n[危险链接](javascript:alert(1))',
    } : field.field === 'answer_md' ? {
      ...field,
      after: '[本地文件](F:/private/secret.md)\n\n[官方资料](https://redis.io/docs/)\n\n`SET key value`',
    } : field);
    const { primary } = sections(render([change]));
    expect(primary).not.toContain('<script');
    expect(primary).not.toContain('<img');
    expect(primary).not.toContain('onerror=');
    expect(primary).not.toContain('javascript:');
    expect(primary).not.toContain('href="F:');
    expect(primary).toContain('危险链接');
    expect(primary).toContain('本地文件');
    expect(primary).toContain('href="https://redis.io/docs/"');
    expect(primary).toContain('rel="noopener noreferrer"');
    expect(primary).toContain('<code>SET key value</code>');
  });
});
