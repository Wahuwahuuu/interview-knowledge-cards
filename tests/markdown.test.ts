import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineMarkdown, Markdown } from '../src/Markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('中文 Markdown 强调', () => {
  it.each([
    ['**举一反三：**先列边界。', '<strong>举一反三：</strong>先列边界。'],
    ['正文**（必要条件）**紧接中文。', '正文<strong>（必要条件）</strong>紧接中文。'],
    ['正文**“记忆提示”**继续。', '正文<strong>“记忆提示”</strong>继续。'],
    ['前文*「简短提示」*后文。', '前文<em>「简短提示」</em>后文。'],
  ])('正文与题目都能显示中文标点旁的强调：%s', (text, expected) => {
    expect(render(text)).toContain(expected);
    expect(renderToStaticMarkup(createElement(InlineMarkdown, { text }))).toContain(expected);
  });

  it('口述列表之后的迁移提示正常加粗，不显示多余星号', () => {
    const html = render('- **结论**：先检查输入。\n- 分别处理两个分支。\n\n**举一反三：**先列边界。');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li><strong>结论</strong>：先检查输入。</li>');
    expect(html).toContain('<p><strong>举一反三：</strong>先列边界。</p>');
    expect(html).not.toContain('**');
  });

  it('代码与明确转义的星号仍按原文显示', () => {
    const html = render('`**提示：**内容`\n\n~~~sql\nSELECT * FROM demo; -- **原样：**说明\n~~~\n\n\\*\\*提示：\\*\\*内容\n\n2 * 3 = 6');
    expect(html).toContain('<code>**提示：**内容</code>');
    expect(html).toContain('<code class="language-sql">SELECT * FROM demo; -- **原样：**说明');
    expect(html).toContain('<p>**提示：**内容</p>');
    expect(html).toContain('<p>2 * 3 = 6</p>');
    expect(html).not.toContain('<strong>');
  });

  it('继续支持表格和链接，同时保留原有 HTML 与危险链接限制', () => {
    const html = render('| 提示 | 内容 |\n| --- | --- |\n| **注意：**条件 | `x * y` |\n\n[文档](https://example.test/docs) [无效](javascript:alert)\n\n<img src="https://example.test/tracker">');
    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain('<strong>注意：</strong>条件');
    expect(html).toContain('<code>x * y</code>');
    expect(html).toContain('href="https://example.test/docs" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('class="local-link"');
    expect(html).not.toMatch(/<img|javascript:/);
  });
});
