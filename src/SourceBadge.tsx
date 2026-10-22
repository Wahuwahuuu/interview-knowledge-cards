import type { Card } from '../shared/model';
import { cardSource } from '../shared/card-source';
import './source-badge.css';

export function SourceBadge({ card }: { card: Card }) {
  const source = cardSource(card);
  return source ? <span className={`source-badge source-badge-${source.kind}`} title={source.description} aria-label={`题目来源：${source.label}。${source.description}`}>{source.label}</span> : null;
}
