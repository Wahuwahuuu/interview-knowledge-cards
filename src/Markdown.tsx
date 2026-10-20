import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function safeHref(href: string) { return /^https?:\/\//i.test(href) ? href : ''; }
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeHref} components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span className="local-link" title="此链接暂时无法打开">{children}</span>,
    img: ({ alt }) => <span className="muted">{alt ? `[图片：${alt}]` : '[图片引用]'}</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{text || '暂未填写。'}</ReactMarkdown></div>;
});

/** Titles and question buttons need inline markup, without nested links or block elements. */
export const InlineMarkdown = memo(function InlineMarkdown({ text, questionTitle = false }: { text: string; questionTitle?: boolean }) {
  const visibleText = questionTitle ? text.replace(/^\s*\d+\s*[.．、)）·:-]\s+/u, '') : text;
  const inlineText = visibleText.replace(/^(\s*\d+)([.)])(?=\s)/gm, '$1\\$2');
  return <span className="inline-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml allowedElements={['p', 'strong', 'em', 'code', 'del', 'br']} unwrapDisallowed components={{ p: ({ children }) => <span>{children}</span> }}>{inlineText}</ReactMarkdown></span>;
});
