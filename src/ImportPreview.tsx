import { useState } from 'react';
import type { Change } from '../shared/model';
import { InlineMarkdown, Markdown } from './Markdown';

const reviewFields = [
  ['title', '标题'], ['question', '问题'], ['summary_md', '复习提纲'], ['answer_md', '完整答案'],
  ['important', '重点'],
] as const;
const reviewFieldNames = new Set<string>(reviewFields.map(([field]) => field));
const kindNames: Record<string, string> = { projects: '项目', cards: '问题资料', topics: '知识点', sources: '面试来源', occurrences: '出现记录', relations: '问题关系' };
const fieldNames: Record<string, string> = { id: 'ID', name: '名称', limitations_md: '实现边界', original_markdown: '原始记录', original_answer_md: '当时的回答', source_path: '来源文件', source_baseline: '源码基线', company: '公司', job: '岗位', round: '轮次', notes: '备注', date: '日期', kind: '类型', project_id: '所属项目', topic_ids: '知识点', evidence: '源码依据', card_id: '问题', source_id: '来源', asked_question: '原始问法', section: '原记录章节', from_card_id: '关系起点', to_card_id: '关系终点', mastery: '掌握状态', favorite: '收藏', archived: '归档', revision: '历史版本编号', history: '历史版本数量' };
const operationNames = { add: '新增', update: '修改', remove: '移除' };

function print(value: unknown) {
  if (value === undefined) return '未填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value || '（空）';
  return JSON.stringify(value, null, 2);
}

function ReviewValue({ value, markdown, inline }: { value: unknown; markdown: boolean; inline: boolean }) {
  return <div className="review-value">{markdown ? <Markdown text={print(value)} /> : <p>{inline ? <InlineMarkdown text={print(value)} /> : print(value)}</p>}</div>;
}

export function QuestionReview({ change }: { change: Change }) {
  const fields = reviewFields.flatMap(([name, label]) => {
    const field = change.fields.find(field => field.field === name);
    if (field) return [{ ...field, label }];
    if (name === 'title' && change.operation !== 'update') return [{ field: name, before: change.operation === 'remove' ? change.name : undefined, after: change.operation === 'add' ? change.name : undefined, label }];
    return [];
  });
  return <div className="change-fields review-fields">
      {change.operation === 'remove' && <p className="notice warning">这道题将从题库中移除。</p>}
      {fields.map(field => <section className="review-field" key={field.field}>
        <h4>{field.label}</h4>
        {change.operation === 'update' ? <div className="diff-columns">
          <div><small>当前内容</small><ReviewValue value={field.before} markdown={field.field.endsWith('_md')} inline={field.field === 'title' || field.field === 'question'} /></div>
          <div><small>导入后</small><ReviewValue value={field.after} markdown={field.field.endsWith('_md')} inline={field.field === 'title' || field.field === 'question'} /></div>
        </div> : <ReviewValue value={change.operation === 'remove' ? field.before : field.after} markdown={field.field.endsWith('_md')} inline={field.field === 'title' || field.field === 'question'} />}
      </section>)}
  </div>;
}

function QuestionChange({ change }: { change: Change }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="change-row question-change" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className={'change-badge ' + change.operation}>{operationNames[change.operation]}</span><span>{change.name}</span></summary>
    {expanded && <QuestionReview change={change} />}
  </details>;
}

function SupportingChange({ change }: { change: Change }) {
  return <details className="change-row"><summary><span className={'change-badge ' + change.operation}>{operationNames[change.operation]}</span><span>{change.name}</span><small>{kindNames[change.kind]}</small></summary>
    <div className="change-fields">{change.operation === 'remove' && <p>这条{kindNames[change.kind]}将被移除。</p>}{change.fields.map(field => <div key={field.field}>
      <h4>{fieldNames[field.field] ?? field.field}</h4>
      {change.operation === 'update' ? <div className="diff-columns"><div><small>当前内容</small><pre>{print(field.before)}</pre></div><div><small>导入后</small><pre>{print(field.after)}</pre></div></div> : <pre>{print(field.after)}</pre>}
    </div>)}</div>
  </details>;
}

export function ImportPreview({ changes, mode }: { changes: Change[]; mode: 'merge' | 'restore' }) {
  const questions = changes.filter(change => change.kind === 'cards' && (change.operation !== 'update' || change.fields.some(field => reviewFieldNames.has(field.field))));
  const supporting = changes.flatMap(change => {
    if (change.kind !== 'cards') return [change];
    const fields = change.fields.filter(field => !reviewFieldNames.has(field.field));
    return fields.length ? [{ ...change, fields }] : [];
  });
  const removedQuestions = questions.filter(change => change.operation === 'remove').length;
  const removedSupporting = changes.filter(change => change.kind !== 'cards' && change.operation === 'remove').length;
  return <>
    <div className="import-summary">
      <strong>{questions.length ? `${questions.length} 道题需要审阅` : changes.length ? '本次没有题目正文变化' : '内容相同，没有需要应用的变化。'}</strong>
      {!!questions.length && <p className="muted">核对标题、问题、复习提纲、完整答案及重点标记。修改已有题目时，会对照显示本次改动。</p>}
      {!questions.length && !!changes.length && <p className="muted">本次更新其他题库资料，详情已收起。</p>}
    </div>
    {mode === 'restore' && (removedQuestions > 0 || removedSupporting > 0) && <p className="notice warning">此次恢复将移除 {removedQuestions} 道题及 {removedSupporting} 条其他资料，请确认这些内容不再需要。</p>}
    {!!questions.length && <div className="change-list question-changes">{questions.map(change => <QuestionChange key={change.id} change={change} />)}</div>}
    {!!supporting.length && <details className="import-secondary">
      <summary>{mode === 'restore' ? '其他资料与恢复明细' : '其他导入资料（无需逐项审阅）'}</summary>
      <p className="muted">分类、知识点、来源、问题关联及系统字段会随本批保存，通常可以跳过。</p>
      <div className="change-list">{supporting.map(change => <SupportingChange key={`${change.kind}:${change.id}`} change={change} />)}</div>
    </details>}
  </>;
}
