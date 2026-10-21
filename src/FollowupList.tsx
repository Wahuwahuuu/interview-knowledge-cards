import { useState } from 'react';
import { ArrowRight, Check, Edit3, Plus, X } from 'lucide-react';
import type { Card, Library, Relation } from '../shared/model';
import { orderedFollowups } from '../shared/followups';
import { CardFullAnswer } from './CardContent';
import { InlineMarkdown, Markdown } from './Markdown';

type Props = { library: Library; card: Card; disabled: boolean; stateDisabled: boolean; onAdd: () => void; onEdit: (card: Card) => void; onOpen: (id: string) => void; onRemove: (relation: Relation, card: Card) => void; onMark: (card: Card) => void };

function FollowupItem({ card, relation, ...props }: Omit<Props, 'onAdd'> & { relation: Relation }) {
  const [open, setOpen] = useState(false);
  return <details className="followup-item" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><InlineMarkdown text={card.question} /></span><span className={'status ' + card.mastery}>{card.mastery === 'mastered' ? '已掌握' : '待复习'}</span></summary>
    {open && <div className="followup-content">
      <h4>口述答案</h4>{card.summary_md ? <Markdown text={card.summary_md} /> : <p className="muted">还没有口述答案，可以点击编辑补充。</p>}
      <CardFullAnswer text={card.answer_md} />
      <div className="button-row"><button className="text-button" disabled={props.disabled} onClick={() => props.onEdit(card)}><Edit3 size={14} />编辑追问</button><button className="text-button" disabled={props.stateDisabled} aria-pressed={card.mastery === 'mastered'} onClick={() => props.onMark(card)}><Check size={14} />{card.mastery === 'mastered' ? '再复习一下' : '已掌握'}</button><button className="text-button" onClick={() => props.onOpen(card.id)}>打开卡片<ArrowRight size={14} /></button><button className="text-button" disabled={props.disabled} onClick={() => props.onRemove(relation, card)}><X size={14} />移除关联</button></div>
    </div>}
  </details>;
}

export function FollowupList(props: Props) {
  const relations = orderedFollowups(props.library, props.card.id);
  return <section className="detail-section followup-section">
    <div className="section-title"><h3>追问{relations.length > 0 && <span className="count-pill">{relations.length}</span>}</h3><button className="text-button" disabled={props.disabled} onClick={props.onAdd}><Plus size={15} />添加追问</button></div>
    {relations.length ? relations.map(relation => <FollowupItem key={relation.id} {...props} card={props.library.cards.find(card => card.id === relation.to_card_id)!} relation={relation} />) : <p className="muted">还没有追问，可以新建一道或关联已有知识卡。</p>}
  </section>;
}
