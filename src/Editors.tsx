import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X, Plus, Save, Link2 } from 'lucide-react';
import { cardSchema, occurrenceSchema, projectSchema, relationSchema, sourceSchema, topicSchema, type Card, type Entity, type Kind, type Library, type Source } from '../shared/model';
import { api, newId } from './api';

export function Modal({ title, children, onClose, wide = false, role = 'dialog', closeDisabled = false, initialFocusRef, descriptionId }: { title: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; role?: 'dialog' | 'alertdialog'; closeDisabled?: boolean; initialFocusRef?: RefObject<HTMLElement | null>; descriptionId?: string }) {
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    (initialFocusRef?.current ?? dialog.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')];
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div ref={dialog} tabIndex={-1} role={role} aria-modal="true" aria-labelledby="modal-title" aria-describedby={descriptionId} className={'modal ' + (wide ? 'modal-wide' : '')}><div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="关闭弹窗" disabled={closeDisabled} onClick={onClose}><X size={21} /></button></div><div className="modal-content">{children}</div></div></div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
type FormProps = { library: Library; expectedRevision: number; onSaved: (library: Library) => void; onDirty: (dirty: boolean) => void; onError: (error: unknown) => void };
function useSubmit(props: FormProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return { busy, error, submit: async (changes: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { const next = await api<Library>('/changes', { method: 'POST', body: JSON.stringify({ expected_revision: props.expectedRevision, changes: { schema_version: 1, ...changes } }) }); props.onDirty(false); props.onSaved(next); }
    catch (error) { setError(error instanceof Error ? error.message : '保存失败'); props.onError(error); }
    finally { setBusy(false); }
  } };
}
export function CardForm(props: FormProps & { initial: Card }) {
  const [value, setValue] = useState(props.initial), [newTopics, setNewTopics] = useState('');
  const { busy, error, submit } = useSubmit(props);
  function set<K extends keyof Card>(key: K, next: Card[K]) { setValue(v => ({ ...v, [key]: next })); props.onDirty(true); }
  return <form onSubmit={event => {
    event.preventDefault();
    const topics = newTopics.split(/[,，\n]/).map(v => v.trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const added = topics.filter(name => !props.library.topics.some(t => t.name === name)).map(name => topicSchema.parse({ id: newId('topic'), name }));
    const ids = topics.map(name => [...props.library.topics, ...added].find(t => t.name === name)!.id);
    void submit({ topics: added, cards: [{ ...value, topic_ids: [...new Set([...value.topic_ids, ...ids])] }] });
  }}>
    <div className="form-row"><Field label="所属项目"><select value={value.project_id} onChange={e => set('project_id', e.target.value)}>{props.library.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><Field label="卡片标题"><input required value={value.title} onChange={e => set('title', e.target.value)} placeholder="例如：并发增长与性能调优" /></Field></div>
    <Field label="问题"><textarea required rows={3} value={value.question} onChange={e => set('question', e.target.value)} placeholder="让问题在脱离原对话时也能理解" /></Field>
    <Field label="复习提纲" hint="写下口述时的主线和关键词，支持 Markdown。"><textarea rows={7} value={value.summary_md} onChange={e => set('summary_md', e.target.value)} /></Field>
    <Field label="完整答案"><textarea rows={12} value={value.answer_md} onChange={e => set('answer_md', e.target.value)} /></Field>
    <label className="priority-checkbox"><input type="checkbox" checked={value.important} onChange={event => set('important', event.target.checked)} />重点</label>
    <Field label="知识点"><div className="topic-options">{props.library.topics.map(t => <label key={t.id} className={'topic-check ' + (value.topic_ids.includes(t.id) ? 'checked' : '')}><input type="checkbox" checked={value.topic_ids.includes(t.id)} onChange={e => set('topic_ids', e.target.checked ? [...value.topic_ids, t.id] : value.topic_ids.filter(id => id !== t.id))} />{t.name}</label>)}</div></Field>
    <Field label="新增知识点" hint="多个知识点用逗号分隔，保存时会同时添加。"><input value={newTopics} onChange={e => { setNewTopics(e.target.value); props.onDirty(true); }} placeholder="例如：幂等、故障隔离" /></Field>
    <div className="form-row"><Field label="复习状态"><select value={value.mastery} onChange={e => set('mastery', e.target.value as Card['mastery'])}><option value="review">待复习</option><option value="mastered">已掌握</option></select></Field><Field label="归档状态"><select value={String(value.archived)} onChange={e => set('archived', e.target.value === 'true')}><option value="false">正常显示</option><option value="true">归档保留</option></select></Field></div>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-footer"><span className="muted">保存后更新当前卡片。</span><button className="primary" disabled={busy}><Save size={16} />{busy ? '保存中…' : '保存卡片'}</button></div>
  </form>;
}

export function RecordForm(props: FormProps & { kind: 'projects' | 'topics' | 'sources'; initial: Entity }) {
  const [value, setValue] = useState(props.initial as unknown as Record<string, string | number>);
  const { busy, error, submit } = useSubmit(props);
  function set(key: string, next: string) { setValue(v => ({ ...v, [key]: next })); props.onDirty(true); }
  return <form onSubmit={e => { e.preventDefault(); void submit({ [props.kind]: [value] }); }}>
    <Field label={props.kind === 'projects' ? '项目名称' : props.kind === 'topics' ? '知识点名称' : '来源名称'}><input required value={String(value.name ?? '')} onChange={e => set('name', e.target.value)} /></Field>
    {props.kind === 'projects' && <Field label="项目说明"><textarea rows={5} value={String(value.description ?? '')} onChange={e => set('description', e.target.value)} /></Field>}
    {props.kind === 'sources' && <SourceFields value={value} set={set} />}
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-footer"><span /> <button className="primary" disabled={busy}><Save size={16} />{busy ? '保存中…' : '保存'}</button></div>
  </form>;
}
function SourceFields({ value, set }: { value: Record<string, unknown>; set: (key: string, value: string) => void }) {
  return <><div className="form-row"><Field label="来源类型"><select value={String(value.kind ?? 'real')} onChange={e => set('kind', e.target.value)}><option value="real">真实面试</option><option value="mock">模拟面试</option><option value="note">问答整理</option></select></Field><Field label="日期"><input type="date" value={String(value.date ?? '')} onChange={e => set('date', e.target.value)} /></Field></div><div className="form-row"><Field label="公司（可选）"><input value={String(value.company ?? '')} onChange={e => set('company', e.target.value)} /></Field><Field label="岗位（可选）"><input value={String(value.job ?? '')} onChange={e => set('job', e.target.value)} /></Field></div><Field label="轮次（可选）"><input value={String(value.round ?? '')} onChange={e => set('round', e.target.value)} placeholder="例如：技术一面" /></Field><Field label="来源备注"><textarea rows={3} value={String(value.notes ?? '')} onChange={e => set('notes', e.target.value)} /></Field></>;
}
export function OccurrenceForm(props: FormProps & { card: Card }) {
  const [sourceId, setSourceId] = useState('new');
  const [source, setSource] = useState<Source>(sourceSchema.parse({ id: newId('source'), name: '新来源', kind: 'real' }));
  const [question, setQuestion] = useState(props.card.question), [answer, setAnswer] = useState(''), [notes, setNotes] = useState('');
  const { busy, error, submit } = useSubmit(props);
  const dirty = () => props.onDirty(true);
  return <form onSubmit={e => { e.preventDefault(); const id = sourceId === 'new' ? source.id : sourceId; void submit({ sources: sourceId === 'new' ? [source] : [], occurrences: [occurrenceSchema.parse({ id: newId('occurrence'), card_id: props.card.id, source_id: id, asked_question: question, original_answer_md: answer, notes })] }); }}>
    <Field label="出现在哪个面试或记录中"><select value={sourceId} onChange={e => { setSourceId(e.target.value); dirty(); }}><option value="new">＋ 新增来源</option>{props.library.sources.map(s => <option value={s.id} key={s.id}>{s.date} {s.name}</option>)}</select></Field>
    {sourceId === 'new' && <div className="inset-panel"><Field label="来源名称"><input required value={source.name} onChange={e => { setSource(s => ({ ...s, name: e.target.value })); dirty(); }} placeholder="例如：某公司 · 后端开发 · 技术一面" /></Field><SourceFields value={source} set={(key, value) => { setSource(s => ({ ...s, [key]: value })); dirty(); }} /></div>}
    <Field label="当时的问法"><textarea required rows={3} value={question} onChange={e => { setQuestion(e.target.value); dirty(); }} /></Field>
    <Field label="当时的回答（可选）" hint="保存后作为原始记录保留；当前复习答案仍可在卡片中修改。"><textarea rows={5} value={answer} onChange={e => { setAnswer(e.target.value); dirty(); }} /></Field>
    <Field label="本题备注"><textarea rows={3} value={notes} onChange={e => { setNotes(e.target.value); dirty(); }} placeholder="例如：面试官继续追问了超时后的恢复策略" /></Field>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-footer"><span /><button className="primary" disabled={busy}><Save size={16} />{busy ? '保存中…' : '保存出现记录'}</button></div>
  </form>;
}
export function RelationForm(props: FormProps & { card: Card }) {
  const [target, setTarget] = useState(''), [kind, setKind] = useState<'followup' | 'related'>('followup'), [direction, setDirection] = useState('out');
  const { busy, error, submit } = useSubmit(props);
  return <form onSubmit={e => { e.preventDefault(); void submit({ relations: [relationSchema.parse({ id: newId('relation'), from_card_id: direction === 'out' ? props.card.id : target, to_card_id: direction === 'out' ? target : props.card.id, kind })] }); }}>
    <p className="muted">当前问题：{props.card.title}</p><Field label="关联问题"><select required value={target} onChange={e => { setTarget(e.target.value); props.onDirty(true); }}><option value="">选择一个问题</option>{props.library.cards.filter(c => c.id !== props.card.id && !c.archived).map(c => <option key={c.id} value={c.id}>{props.library.projects.find(p => p.id === c.project_id)?.name} · {c.title}</option>)}</select></Field>
    <Field label="关系类型"><select value={kind} onChange={e => { setKind(e.target.value as typeof kind); props.onDirty(true); }}><option value="followup">追问</option><option value="related">相关问题</option></select></Field>
    {kind === 'followup' && <Field label="追问方向"><select value={direction} onChange={e => { setDirection(e.target.value); props.onDirty(true); }}><option value="out">所选问题是当前问题的追问</option><option value="in">当前问题是所选问题的追问</option></select></Field>}
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-footer"><span /><button className="primary" disabled={busy || !target}><Link2 size={16} />{busy ? '保存中…' : '保存关系'}</button></div>
  </form>;
}
export function blankRecord(kind: Kind, projectId?: string): Entity {
  if (kind === 'cards') return cardSchema.parse({ id: newId('card'), project_id: projectId || 'unset', title: '新问题', question: '请填写问题' });
  if (kind === 'projects') return projectSchema.parse({ id: newId('project'), name: '新项目' });
  if (kind === 'topics') return topicSchema.parse({ id: newId('topic'), name: '新知识点' });
  return sourceSchema.parse({ id: newId('source'), name: '新来源', kind: 'real' });
}
