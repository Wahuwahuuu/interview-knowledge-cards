import { useState } from 'react';
import { Markdown } from './Markdown';

export function CardFullAnswer({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="answer-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>完整答案</summary>
    {expanded && <Markdown text={text} />}
  </details>;
}
