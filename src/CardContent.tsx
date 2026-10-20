import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { InlineMarkdown, Markdown } from './Markdown';

export function CardFullAnswer({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="answer-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>完整答案</summary>
    {expanded && <Markdown text={text} />}
  </details>;
}

export function CardDeleteConfirmation({ title, busy, error, onCancel, onConfirm }: {
  title: string; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <section className="card-delete-confirm" aria-labelledby="card-delete-title" aria-describedby="card-delete-description" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (!busy) onCancel(); } }}>
    <h3 id="card-delete-title">删除这张知识卡？</h3>
    <p className="card-delete-name"><InlineMarkdown text={title} questionTitle /></p>
    <p id="card-delete-description">这张卡片的来源关联与问题连线会一并移除，原始来源仍然保留。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="button-row"><button ref={cancel} type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}><Trash2 size={15} />{busy ? '正在删除…' : '确认删除'}</button></div>
  </section>;
}
