import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, Plus, Trash2 } from 'lucide-react';
import type { ImportEnvelope, Library } from '../shared/model';
import { buildManualImportEnvelope, createManualImportDraft, createManualImportQuestion, ManualImportError, type ManualImportQuestion } from '../shared/manual-import';

type Props = {
  library: Library;
  offline: boolean;
  busy: boolean;
  resetKey: number;
  onPreview: (envelope: ImportEnvelope) => Promise<void>;
  onEdit?: () => void;
};

export function ManualImportForm({ library, offline, busy, resetKey, onPreview, onEdit }: Props) {
  const [draft, setDraft] = useState(() => createManualImportDraft(library.projects[0]?.id));
  const [error, setError] = useState(''), [errorField, setErrorField] = useState<string>(), [submitting, setSubmitting] = useState(false);
  const lastResetKey = useRef(resetKey), form = useRef<HTMLFormElement>(null);
  const disabled = busy || submitting || offline;
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    setDraft(createManualImportDraft(library.projects[0]?.id));
    setError(''); setErrorField(undefined);
  }, [resetKey, library.projects]);
  useEffect(() => {
    if (draft.destination === 'new' && library.projects.some(project => project.id === draft.newProjectId)) {
      setDraft(current => current.destination === 'new' && library.projects.some(project => project.id === current.newProjectId) ? { ...current, destination: 'existing', projectId: current.newProjectId } : current);
    }
  }, [library.projects, draft.destination, draft.newProjectId]);

  function editQuestion<K extends Exclude<keyof ManualImportQuestion, 'id'>>(id: string, field: K, value: ManualImportQuestion[K]) {
    onEdit?.();
    setDraft(current => ({ ...current, questions: current.questions.map(question => question.id === id ? { ...question, [field]: value } : question) }));
    if (errorField === `${field}-${id}`) { setError(''); setErrorField(undefined); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || offline) return;
    setError(''); setErrorField(undefined); setSubmitting(true);
    try { await onPreview(buildManualImportEnvelope(library, draft)); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '预览未生成，请重试；填写的内容已保留。');
      if (failure instanceof ManualImportError && failure.field) {
        setErrorField(failure.field);
        const control = form.current?.elements.namedItem(failure.field);
        if (control instanceof HTMLElement) control.focus();
      }
    } finally { setSubmitting(false); }
  }

  return <form ref={form} className="manual-import-form" onSubmit={event => void submit(event)}>
    <div className="manual-import-heading"><h3>填写问答</h3><p className="muted">选择题库，填写题目和答案，再预览确认导入。答案可以留空，之后补充。</p></div>
    <fieldset className="manual-import-fields" disabled={disabled}>
      <div className="manual-import-destination">
        <label className="field"><span>导入到题库</span><select name="project" value={draft.destination === 'new' ? '' : draft.projectId} aria-invalid={errorField === 'project' || undefined} onChange={event => { onEdit?.(); const projectId = event.target.value; setDraft(current => ({ ...current, destination: projectId ? 'existing' : 'new', projectId })); setError(''); setErrorField(undefined); }}>
          {library.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          <option value="">新建题库</option>
        </select></label>
        {draft.destination === 'new' && <label className="field"><span>新题库名称 <span className="manual-import-required">（必填）</span></span><input name="new-project-name" required maxLength={100} value={draft.newProjectName} aria-invalid={errorField === 'new-project-name' || undefined} onChange={event => { onEdit?.(); setDraft(current => ({ ...current, newProjectName: event.target.value })); if (errorField === 'new-project-name') { setError(''); setErrorField(undefined); } }} placeholder="例如：MySQL 八股" /></label>}
      </div>
      <div className="manual-import-questions">{draft.questions.map((question, index) => <section className="manual-import-question" key={question.id} aria-labelledby={`manual-question-${question.id}`}>
        <div className="manual-import-question-heading"><h4 id={`manual-question-${question.id}`}>第 {index + 1} 题</h4><button type="button" className="text-button" disabled={draft.questions.length === 1} aria-label={`移除第 ${index + 1} 题`} onClick={() => { onEdit?.(); setDraft(current => ({ ...current, questions: current.questions.filter(row => row.id !== question.id) })); setError(''); setErrorField(undefined); }}><Trash2 size={15} />移除</button></div>
        <label className="field"><span>标题 <span className="manual-import-required">（必填）</span></span><input name={`title-${question.id}`} required maxLength={150} value={question.title} aria-invalid={errorField === `title-${question.id}` || undefined} onChange={event => editQuestion(question.id, 'title', event.target.value)} placeholder="例如：事务的四大特性" /></label>
        <label className="priority-checkbox"><input type="checkbox" checked={!!question.important} onChange={event => editQuestion(question.id, 'important', event.target.checked)} />重点</label>
        <label className="field"><span>问题 <span className="manual-import-required">（必填）</span></span><textarea name={`question-${question.id}`} required maxLength={400_000} rows={3} value={question.question} aria-invalid={errorField === `question-${question.id}` || undefined} onChange={event => editQuestion(question.id, 'question', event.target.value)} placeholder="例如：MySQL 事务的 ACID 特性分别是什么？" /></label>
        <label className="field"><span>复习提纲（面试口述版）</span><textarea name={`summary-${question.id}`} maxLength={400_000} rows={4} value={question.summary} aria-invalid={errorField === `summary-${question.id}` || undefined} onChange={event => editQuestion(question.id, 'summary', event.target.value)} placeholder="填写面试时准备如何回答，可稍后补充" /></label>
        <label className="field"><span>完整答案（详细讲解）</span><textarea name={`answer-${question.id}`} maxLength={400_000} rows={6} value={question.answer} aria-invalid={errorField === `answer-${question.id}` || undefined} onChange={event => editQuestion(question.id, 'answer', event.target.value)} placeholder="补充原理、示例和注意事项，可使用 Markdown" /></label>
      </section>)}</div>
      <button type="button" className="secondary manual-import-add" disabled={draft.questions.length >= 2000} onClick={() => { onEdit?.(); const question = createManualImportQuestion(); setDraft(current => ({ ...current, questions: [...current.questions, question] })); }}><Plus size={16} />再加一道题</button>
    </fieldset>
    {error && <p className="form-error manual-import-error" role="alert">{error}</p>}
    {offline && <p className="microcopy">当前离线，联网后可填写并导入。</p>}
    <div className="manual-import-footer"><span className="microcopy">共 {draft.questions.length} 道题，预览后由你确认导入。</span><button className="primary" disabled={disabled || offline}><Eye size={16} />{submitting ? '正在生成预览…' : '预览导入'}</button></div>
  </form>;
}
