import { ArrowRight, ChevronDown, GitBranch, LayoutGrid, List, Star } from 'lucide-react';
import { useEffect, useId, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Card, Library } from '../shared/model';
import type { QuestionGroup } from '../shared/question-groups';
import { InlineMarkdown } from './Markdown';
import { MoreActionsButton } from './ContextMenu';
import { isSourceTopic } from '../shared/card-source';
import { SourceBadge } from './SourceBadge';
import './question-groups.css';

export type CardLayout = 'cards' | 'list';
type Props = {
  cards: Card[]; groups?: QuestionGroup[]; library: Library; layout: CardLayout;
  onOpen: (id: string) => void; onFavorite: (card: Card) => void; disabled: boolean;
  onMenu?: (event: MouseEvent<HTMLElement>, card: Card) => void; menuCardId?: string;
};
const label = (card: Card) => card.question || card.title;

export function CardLayoutToggle({ layout, onChange }: { layout: CardLayout; onChange: (layout: CardLayout) => void }) {
  return <div className="card-layout-toggle" role="group" aria-label="题目显示方式">
    <button type="button" aria-pressed={layout === 'cards'} onClick={() => onChange('cards')}><LayoutGrid size={15} />卡片</button>
    <button type="button" aria-pressed={layout === 'list'} onClick={() => onChange('list')}><List size={16} />列表</button>
  </div>;
}

function QuestionGroupCard({ group, index, ...props }: Omit<Props, 'cards' | 'groups'> & { group: QuestionGroup; index: number }) {
  const { main, children } = group, panelId = useId();
  const [expanded, setExpanded] = useState(Boolean(group.expandForMatches));
  const [visited, setVisited] = useState(Boolean(group.expandForMatches));
  useEffect(() => { if (group.expandForMatches) { setExpanded(true); setVisited(true); } }, [group.expandForMatches]);
  const isList = props.layout === 'list', hasChildren = children.length > 0;
  const technicalTopics = main.topic_ids.filter(id => !isSourceTopic(id));
  function toggle() { setVisited(true); setExpanded(value => !value); }
  const status = (card: Card) => <span className={'status ' + card.mastery}>{card.archived ? '已归档' : card.mastery === 'mastered' ? '已掌握' : '待复习'}</span>;
  const more = (card: Card) => props.onMenu && <MoreActionsButton label={`知识卡操作：${label(card)}`} expanded={props.menuCardId === card.id} onOpen={event => props.onMenu!(event, card)} />;
  return <article className={`question-group ${isList ? 'question-group-list' : 'question-group-card'} ${hasChildren ? 'has-children' : ''} ${expanded && hasChildren ? 'is-expanded' : ''}`} onContextMenu={event => props.onMenu?.(event, main)}>
    <div className="question-group-surface">
      {isList ? <div className="group-list-heading"><button className="group-main-question question-list-row" onClick={() => props.onOpen(main.id)}><InlineMarkdown text={label(main)} questionTitle /></button><SourceBadge card={main} />{more(main)}</div> : <>
        <div className="card-tile-top"><span className="card-number">{String(index + 1).padStart(2, '0')}</span>{status(main)}{main.important && <span className="priority-badge">重点</span>}<SourceBadge card={main} /><button type="button" className={'icon-button favorite ' + (main.favorite ? 'is-favorite' : '')} aria-label={`${main.favorite ? '取消收藏' : '收藏'} ${label(main)}`} disabled={props.disabled} onClick={() => props.onFavorite(main)}><Star size={18} fill={main.favorite ? 'currentColor' : 'none'} /></button>{more(main)}</div>
        <button type="button" className="group-main-question" onClick={() => props.onOpen(main.id)}><h3><InlineMarkdown text={label(main)} questionTitle /></h3></button>
        <div className="card-tags">{technicalTopics.slice(0, 3).map(id => <span key={id}>{props.library.topics.find(topic => topic.id === id)?.name}</span>)}{technicalTopics.length > 3 && <span>+{technicalTopics.length - 3}</span>}</div>
        <div className="group-card-footer"><button className="text-button" onClick={() => props.onOpen(main.id)}>查看答案<ArrowRight size={14} /></button></div>
      </>}
      {hasChildren && <button type="button" className="group-disclosure" aria-expanded={expanded} aria-controls={panelId} onClick={toggle}><span><GitBranch size={15} />{expanded ? '收起' : '展开'} {children.length} 条子问题{group.mainMatches === false && <small>匹配结果</small>}</span><ChevronDown size={16} /></button>}
      <div id={panelId} className="group-reveal" aria-hidden={!expanded || !hasChildren} inert={!expanded || !hasChildren}>
        <div className="group-reveal-inner">{visited && hasChildren && <div className="group-children">{children.map(({ card, depth }, childIndex) => <div className="group-child" key={card.id} style={{ '--child-depth': Math.min(depth - 1, 2) } as CSSProperties} onContextMenu={event => { event.stopPropagation(); props.onMenu?.(event, card); }}>
          <span className="group-child-number">{String(childIndex + 1).padStart(2, '0')}</span><button className="group-child-question" onClick={() => props.onOpen(card.id)}><InlineMarkdown text={label(card)} questionTitle /><small className="group-child-meta">{!isList && <span>{card.mastery === 'mastered' ? '已掌握' : '待复习'}{card.important ? ' · 重点' : ''}</span>}<SourceBadge card={card} /></small></button>{more(card)}
        </div>)}</div>}</div>
      </div>
    </div>
  </article>;
}

export function CardCollection({ cards, groups, ...props }: Props) {
  const collection = groups ?? cards.map(main => ({ main, children: [] }));
  if (!collection.length) return null;
  return <div className={props.layout === 'list' ? 'grouped-question-list' : 'cards-grid grouped-cards-grid'} aria-label={props.layout === 'list' ? '题目列表' : '主问题卡片'}>{collection.map((group, index) => <QuestionGroupCard key={group.main.id} group={group} index={index} {...props} />)}</div>;
}
