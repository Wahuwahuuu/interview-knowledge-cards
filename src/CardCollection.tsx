import { ArrowRight, LayoutGrid, List, Star } from 'lucide-react';
import type { Card, Library } from '../shared/model';
import { InlineMarkdown } from './Markdown';

export type CardLayout = 'cards' | 'list';

export function CardLayoutToggle({ layout, onChange }: { layout: CardLayout; onChange: (layout: CardLayout) => void }) {
  return <div className="card-layout-toggle" role="group" aria-label="题目显示方式">
    <button type="button" aria-pressed={layout === 'cards'} onClick={() => onChange('cards')}><LayoutGrid size={15} />卡片</button>
    <button type="button" aria-pressed={layout === 'list'} onClick={() => onChange('list')}><List size={16} />列表</button>
  </div>;
}

export function CardCollection({ cards, library, layout, onOpen, onFavorite, disabled }: {
  cards: Card[]; library: Library; layout: CardLayout; onOpen: (id: string) => void; onFavorite: (card: Card) => void; disabled: boolean;
}) {
  if (!cards.length) return null;
  if (layout === 'list') return <div className="question-list" aria-label="题目列表">{cards.map(card => <button type="button" className="question-list-row" key={card.id} onClick={() => onOpen(card.id)}><InlineMarkdown text={card.title} questionTitle /></button>)}</div>;
  return <div className="cards-grid">{cards.map((card, index) => <article className="card-tile" key={card.id}>
    <div className="card-tile-top"><span className="card-number">{String(index + 1).padStart(2, '0')}</span><span className={'status ' + card.mastery}>{card.archived ? '已归档' : card.mastery === 'mastered' ? '已掌握' : '待复习'}</span>{card.important && <span className="priority-badge">重点</span>}<button type="button" className={'icon-button favorite ' + (card.favorite ? 'is-favorite' : '')} aria-label={`${card.favorite ? '取消收藏' : '收藏'} ${card.title}`} disabled={disabled} onClick={() => onFavorite(card)}><Star size={18} fill={card.favorite ? 'currentColor' : 'none'} /></button></div>
    <button type="button" className="card-open" onClick={() => onOpen(card.id)}><h3><InlineMarkdown text={card.title} questionTitle /></h3><p className="card-question"><InlineMarkdown text={card.question} /></p><div className="card-tags">{card.topic_ids.slice(0, 3).map(id => <span key={id}>{library.topics.find(topic => topic.id === id)?.name}</span>)}{card.topic_ids.length > 3 && <span>+{card.topic_ids.length - 3}</span>}</div><div className="card-tile-bottom"><span>{library.occurrences.filter(item => item.card_id === card.id).length} 条来源记录</span><span>打开卡片 <ArrowRight size={15} /></span></div></button>
  </article>)}</div>;
}
