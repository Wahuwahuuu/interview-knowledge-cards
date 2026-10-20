import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Folder, LayoutGrid, ListOrdered, Shuffle } from 'lucide-react';
import type { Card, Library } from '../shared/model';
import { canAdvancePractice, currentPracticeId, nextPractice, practiceCards, previousPractice, setPracticeMode, startPractice, type PracticeMode, type PracticeSession } from '../shared/practice';
import { Markdown } from './Markdown';

type Props = {
  library: Library;
  initialProjectId?: string;
  offline: boolean;
  busy: boolean;
  onMark: (card: Card, mastery: Card['mastery']) => Promise<void>;
  onScopeChange: (projectId: string | undefined) => void;
  onOpenProject: (projectId: string) => void;
};

function ModeToggle({ mode, onChange }: { mode: PracticeMode; onChange: (mode: PracticeMode) => void }) {
  return <div className="segmented practice-mode-toggle" role="group" aria-label="出题方式">
    <button className={mode === 'sequential' ? 'selected' : ''} aria-pressed={mode === 'sequential'} onClick={() => onChange('sequential')}><ListOrdered size={16} />顺序出题</button>
    <button className={mode === 'random' ? 'selected' : ''} aria-pressed={mode === 'random'} onClick={() => onChange('random')}><Shuffle size={16} />随机出题</button>
  </div>;
}

export function PracticeView({ library, initialProjectId, offline, busy, onMark, onScopeChange, onOpenProject }: Props) {
  const [scope, setScope] = useState<'all' | 'project'>(initialProjectId ? 'project' : 'all');
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? library.projects[0]?.id ?? '');
  const [mode, setMode] = useState<PracticeMode>('sequential');
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [fullAnswerOpen, setFullAnswerOpen] = useState(false);
  const projectId = scope === 'project' ? selectedProjectId : undefined;
  const cards = useMemo(() => scope === 'project' && !selectedProjectId ? [] : practiceCards(library, projectId), [library, projectId, scope, selectedProjectId]);
  const card = session ? library.cards.find(value => value.id === currentPracticeId(session) && !value.archived) : undefined;
  const selectedProject = library.projects.find(value => value.id === selectedProjectId);

  function chooseScope(next: 'all' | 'project') {
    setScope(next);
    onScopeChange(next === 'project' ? selectedProjectId || undefined : undefined);
  }

  function start() {
    if (!cards.length) return;
    onScopeChange(projectId);
    setSession(startPractice(cards.map(value => value.id), mode));
    setRevealed(false);
    setFullAnswerOpen(false);
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
        {library.projects.map(project => <option key={project.id} value={project.id}>{project.name}（{library.cards.filter(value => value.project_id === project.id && !value.archived).length} 题）</option>)}
      </select></label>}
      <div><span className="muted">出题方式</span><ModeToggle mode={mode} onChange={changeMode} /></div>
      <div className="button-row"><span className="muted">{scope === 'all' ? '全库' : selectedProject?.name ?? '所选题库'} · {cards.length} 道题</span><button className="primary" disabled={!cards.length} onClick={start}><BookOpen size={17} />开始发问<ArrowRight size={17} /></button></div>
      {!cards.length && <p className="microcopy practice-empty">{scope === 'all' ? '题库中还没有可复习的问题，请先添加或导入问题。' : '这个题库还没有可复习的问题，可以选择其他题库。'}</p>}
    </div>
  </section>;

  return <section>
    <div className="practice-session-toolbar">
      <div className="button-row"><button className="text-button" onClick={() => { setSession(null); setRevealed(false); }}><ArrowLeft size={16} />选择复习范围</button><span className="practice-scope-name">{scope === 'all' ? '全库发问' : selectedProject?.name}</span></div>
      <ModeToggle mode={session.mode} onChange={changeMode} />
    </div>
    {card ? <>
      <div className="practice-progress"><span>{session.mode === 'sequential' ? `第 ${session.ids.indexOf(card.id) + 1} / ${session.ids.length} 题` : `第 ${session.historyIndex + 1} 次发问 · 共 ${session.ids.length} 题`}</span><button className="text-button" onClick={() => onOpenProject(card.project_id)}>{library.projects.find(project => project.id === card.project_id)?.name}</button></div>
      <article className={'practice-card ' + (revealed ? 'revealed' : '')}>
        <div className="practice-card-label"><span /> <span className={'status ' + card.mastery}>{card.mastery === 'mastered' ? '已掌握' : '待复习'}</span></div>
        <h2>{card.question}</h2>
        {revealed ? <div className="practice-answer"><Markdown text={card.summary_md || card.answer_md} /><details className="answer-details" open={fullAnswerOpen} onToggle={event => setFullAnswerOpen(event.currentTarget.open)}><summary>展开完整答案</summary>{fullAnswerOpen && <Markdown text={card.answer_md} />}</details>{card.limitations_md && <div className="boundary-note"><strong>记住这些边界</strong><Markdown text={card.limitations_md} /></div>}</div> : <div className="reveal-area"><button className="primary" onClick={() => setRevealed(true)}><BookOpen size={17} />揭晓答案</button></div>}
      </article>
      <div className="practice-actions">
        <button className="secondary" disabled={session.historyIndex === 0} onClick={() => { setSession(value => value ? previousPractice(value) : null); setRevealed(false); setFullAnswerOpen(false); }}><ArrowLeft size={16} />上一题</button>
        <div className="button-row"><button className="secondary" disabled={offline || busy} onClick={() => void onMark(card, 'review')}>再复习一下</button><button className="primary" disabled={offline || busy} onClick={() => void onMark(card, 'mastered')}><Check size={16} />已掌握</button></div>
        <button className="secondary" disabled={!canAdvancePractice(session)} onClick={() => { setSession(value => value ? nextPractice(value) : null); setRevealed(false); setFullAnswerOpen(false); }}>下一题<ArrowRight size={16} /></button>
      </div>
      {offline && <p className="microcopy centered">离线可阅读和翻卡；掌握状态需要联网保存。</p>}
    </> : <div className="empty-state"><BookOpen size={30} /><h3>这道题已不在复习范围内</h3><button className="secondary" onClick={() => setSession(null)}>重新选择复习范围</button></div>}
  </section>;
}
