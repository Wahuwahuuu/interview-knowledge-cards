import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Edit3, Folder, LayoutGrid, ListOrdered, RefreshCw, Shuffle } from 'lucide-react';
import type { Card, Library } from '../shared/model';
import { canAdvancePractice, currentPracticeId, nextPractice, practiceMainCards, previousPractice, setPracticeMode, startPractice, type PracticeMode, type PracticeSession } from '../shared/practice';
import { followupCards } from '../shared/followups';
import { InlineMarkdown, Markdown } from './Markdown';
import './practice-edit.css';

type Props = {
  library: Library;
  initialProjectId?: string;
  offline: boolean;
  busy: boolean;
  editDisabled: boolean;
  saveStatus?: Record<string, 'saving' | 'error'>;
  onMark: (card: Card, mastery: Card['mastery']) => Promise<void>;
  onEdit: (card: Card) => void;
  onScopeChange: (projectId: string | undefined) => void;
  onOpenProject: (projectId: string) => void;
};

function ModeToggle({ mode, onChange }: { mode: PracticeMode; onChange: (mode: PracticeMode) => void }) {
  return <div className="segmented practice-mode-toggle" role="group" aria-label="出题方式">
    <button className={mode === 'sequential' ? 'selected' : ''} aria-pressed={mode === 'sequential'} onClick={() => onChange('sequential')}><ListOrdered size={16} />顺序出题</button>
    <button className={mode === 'random' ? 'selected' : ''} aria-pressed={mode === 'random'} onClick={() => onChange('random')}><Shuffle size={16} />随机出题</button>
  </div>;
}

export function PracticeView({ library, initialProjectId, offline, busy, editDisabled, saveStatus, onMark, onEdit, onScopeChange, onOpenProject }: Props) {
  const [scope, setScope] = useState<'all' | 'project'>(initialProjectId ? 'project' : 'all');
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? library.projects[0]?.id ?? '');
  const [mode, setMode] = useState<PracticeMode>('sequential');
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [fullAnswerOpen, setFullAnswerOpen] = useState(false);
  const [followupIndex, setFollowupIndex] = useState(-1);
  const projectId = scope === 'project' ? selectedProjectId : undefined;
  const cards = useMemo(() => scope === 'project' && !selectedProjectId ? [] : practiceMainCards(library, projectId), [library, projectId, scope, selectedProjectId]);
  const root = session ? library.cards.find(value => value.id === currentPracticeId(session) && !value.archived) : undefined;
  const followups = useMemo(() => root ? followupCards(library, root.id, projectId) : [], [library, root?.id, projectId]);
  const card = followupIndex >= 0 ? followups[followupIndex] ?? root : root;
  const selectedProject = library.projects.find(value => value.id === selectedProjectId);

  function showQuestion(index = -1) { setFollowupIndex(index); setRevealed(false); setFullAnswerOpen(false); }

  function chooseScope(next: 'all' | 'project') {
    setScope(next);
    onScopeChange(next === 'project' ? selectedProjectId || undefined : undefined);
  }

  function start() {
    if (!cards.length) return;
    onScopeChange(projectId);
    setSession(startPractice(cards.map(value => value.id), mode));
    showQuestion();
  }

  function changeMode(next: PracticeMode) {
    setMode(next);
    setSession(value => value ? setPracticeMode(value, next) : null);
  }

  if (!session) return <section className="practice-setup">
    <div className="page-heading"><h1>选择复习范围</h1></div>
    <div className="practice-scope-options" role="group" aria-label="复习范围">
      <button className={'practice-scope-option ' + (scope === 'all' ? 'selected' : '')} aria-pressed={scope === 'all'} onClick={() => chooseScope('all')}><LayoutGrid size={24} /><strong>全库发问</strong><span>从全部题库中出题</span></button>
      <button className={'practice-scope-option ' + (scope === 'project' ? 'selected' : '')} aria-pressed={scope === 'project'} onClick={() => chooseScope('project')}><Folder size={24} /><strong>按题库发问</strong><span>选择一个已配置的题库</span></button>
    </div>
    <div className="practice-setup-controls panel">
      {scope === 'project' && <label>选择题库<select aria-label="选择题库" value={selectedProjectId} onChange={event => { setSelectedProjectId(event.target.value); onScopeChange(event.target.value || undefined); }}>
        {!library.projects.length && <option value="">还没有题库</option>}
        {library.projects.map(project => <option key={project.id} value={project.id}>{project.name}（{practiceMainCards(library, project.id).length} 道主问题）</option>)}
      </select></label>}
      <div><span className="muted">出题方式</span><ModeToggle mode={mode} onChange={changeMode} /></div>
      <div className="button-row"><span className="muted">{scope === 'all' ? '全库' : selectedProject?.name ?? '所选题库'} · {cards.length} 道主问题</span><button className="primary" disabled={!cards.length} onClick={start}><BookOpen size={17} />开始发问<ArrowRight size={17} /></button></div>
      {!cards.length && <p className="microcopy practice-empty">{scope === 'all' ? '题库中还没有可复习的问题，请先添加或导入问题。' : '这个题库还没有可复习的问题，可以选择其他题库。'}</p>}
    </div>
  </section>;

  return <section>
    <div className="practice-session-toolbar">
      <div className="button-row"><button className="text-button" onClick={() => { setSession(null); setRevealed(false); }}><ArrowLeft size={16} />选择复习范围</button><span className="practice-scope-name">{scope === 'all' ? '全库发问' : selectedProject?.name}</span></div>
      <ModeToggle mode={session.mode} onChange={changeMode} />
    </div>
    {card ? <>
      <div className="practice-progress"><span>{session.mode === 'sequential' ? `第 ${session.ids.indexOf(root!.id) + 1} / ${session.ids.length} 组` : `第 ${session.historyIndex + 1} 次发问 · 共 ${session.ids.length} 组`}{followupIndex >= 0 ? ` · 追问 ${followupIndex + 1} / ${followups.length}` : ' · 主问题'}</span><button className="text-button" onClick={() => onOpenProject(card.project_id)}>{library.projects.find(project => project.id === card.project_id)?.name}</button></div>
      <article className={'practice-card ' + (revealed ? 'revealed' : '')}>
        <div className="practice-card-label"><span>{card.important && <span className="priority-badge">重点</span>}{saveStatus?.[card.id] === 'saving' && <span className="practice-save-status" role="status"><RefreshCw size={13} className="spin" />正在保存…</span>}{saveStatus?.[card.id] === 'error' && <span className="practice-save-status save-failed">标记未保存</span>}</span><div className="practice-card-tools"><span className={'status ' + card.mastery}>{card.mastery === 'mastered' ? '已掌握' : '待复习'}</span><button type="button" className="text-button practice-edit-button" disabled={editDisabled} onClick={() => onEdit(card)}><Edit3 size={15} />编辑</button></div></div>
        {followupIndex >= 0 && <p className="practice-parent">主问题：<InlineMarkdown text={root!.question} /></p>}
        <h2><InlineMarkdown text={card.question} /></h2>
        {revealed ? <div className="practice-answer"><Markdown text={card.summary_md || card.answer_md} /><details className="answer-details" open={fullAnswerOpen} onToggle={event => setFullAnswerOpen(event.currentTarget.open)}><summary>展开完整答案</summary>{fullAnswerOpen && <Markdown text={card.answer_md} />}</details></div> : <div className="reveal-area"><button className="primary" onClick={() => setRevealed(true)}><BookOpen size={17} />揭晓答案</button></div>}
      </article>
      {followups.length > 0 && <div className="practice-followups">
        <div className="button-row">{followupIndex >= 0 ? <><button className="text-button" onClick={() => showQuestion()}>返回主问题</button><button className="text-button" onClick={() => showQuestion(followupIndex - 1)}><ArrowLeft size={14} />上一问</button></> : <span className="muted">这道主问题有 {followups.length} 条追问</span>}</div>
        {followupIndex < followups.length - 1 ? <button className="secondary" onClick={() => showQuestion(followupIndex + 1)}>继续追问<ArrowRight size={16} /></button> : <span className="muted">本组追问已结束</span>}
      </div>}
      <div className="practice-actions">
        <button className="secondary" disabled={session.historyIndex === 0} onClick={() => { setSession(value => value ? previousPractice(value) : null); showQuestion(); }}><ArrowLeft size={16} />上一题</button>
        <div className="button-row"><button className="secondary" aria-pressed={card.mastery === 'review'} disabled={offline || busy} onClick={() => void onMark(card, 'review')}>再复习一下</button><button className="primary" aria-pressed={card.mastery === 'mastered'} disabled={offline || busy} onClick={() => void onMark(card, 'mastered')}><Check size={16} />已掌握</button></div>
        <button className="secondary" disabled={!canAdvancePractice(session)} onClick={() => { setSession(value => value ? nextPractice(value) : null); showQuestion(); }}>下一题<ArrowRight size={16} /></button>
      </div>
      {offline && <p className="microcopy centered">离线可阅读和翻卡；掌握状态需要联网保存。</p>}
    </> : <div className="empty-state"><BookOpen size={30} /><h3>这道题已不在复习范围内</h3><button className="secondary" onClick={() => setSession(null)}>重新选择复习范围</button></div>}
  </section>;
}
