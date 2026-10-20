import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function safeHref(href: string) { return /^https?:\/\//i.test(href) ? href : ''; }
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeHref} components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span className="local-link" title="本地定位信息请在源码依据中复制">{children}</span>,
    img: ({ alt }) => <span className="muted">{alt ? `[图片：${alt}]` : '[图片引用]'}</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{text || '暂未填写。'}</ReactMarkdown></div>;
});
