import { useEffect, useRef, useState } from 'react';
import { Upload, Download, Check, RotateCcw, FileJson, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { type Change, type ImportBatch, type Library } from '../shared/model';
import { summarizeChanges } from '../shared/import-summary';
import { ApiError, api, downloadFile } from './api';
import { ImportPreview } from './ImportPreview';

function changeLabel(changes: Change[]) { const summary = summarizeChanges(changes); return summary.questions ? `${summary.questions} 道题` : '题库资料更新'; }
function batchLabel(batch: ImportBatch) {
  if (batch.mode === 'restore') return '完整备份恢复';
  const project = batch.preview.find(change => change.kind === 'projects');
  const cards = batch.preview.filter(change => change.kind === 'cards');
  if (project) return project.name + (cards.length ? ` · ${cards.length} 个问题` : '');
  if (cards.length) return cards.slice(0, 2).map(card => card.name).join('、') + (cards.length > 2 ? ` 等 ${cards.length} 个问题` : '');
  return '问答与来源导入';
}
export function ImportView({ offline, onLibrary, onError, notify }: { offline: boolean; onLibrary: (library: Library) => void; onError: (error: unknown) => void; notify: (text: string) => void }) {
  const [text, setText] = useState(''), [batches, setBatches] = useState<ImportBatch[]>([]), [selected, setSelected] = useState<ImportBatch | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const previewSection = useRef<HTMLElement>(null);
  async function refresh() { if (!offline) { try { setBatches(await api<ImportBatch[]>('/imports')); } catch (e) { onError(e); } } }
  useEffect(() => { void refresh(); }, [offline]);
  useEffect(() => { if (selected) previewSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [selected?.id]);
  async function run(task: () => Promise<void>) {
    setBusy(true); setError('');
    try { await task(); }
    catch (e) { setError(e instanceof ApiError && e.details.length ? e.message + '：' + e.details.map(v => `${v.path} ${v.message}`).join('；') : e instanceof Error ? e.message : '操作失败'); onError(e); }
    finally { setBusy(false); }
  }
  return <div className="import-view">
    <div className="two-panels"><section className="panel"><div className="section-title"><h3>导入整理好的问答</h3><FileJson size={19} /></div><p className="muted">选择 AI 整理的 JSON 文件，或粘贴内容。先预览，确认后才写入题库。</p>
      <input ref={file} type="file" accept="application/json,.json" className="visually-hidden" onChange={e => { const selected = e.target.files?.[0]; if (selected) void run(async () => { if (selected.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MB，请拆分导入'); setText(await selected.text()); setSelected(null); }); e.target.value = ''; }} />
      <button className="secondary" disabled={offline || busy} onClick={() => file.current?.click()}><Upload size={16} />选择 JSON 文件</button><label className="field mt"><span>或粘贴 JSON</span><textarea rows={7} value={text} onChange={e => { setText(e.target.value); setSelected(null); }} placeholder={'{\n  "schema_version": 1,\n  "mode": "merge",\n  "cards": […]\n}'} /></label>
      <div className="split-actions"><button className="text-button" onClick={() => downloadFile('import-template-v1.json', JSON.stringify({ schema_version: 1, mode: 'merge', projects: [], topics: [], cards: [], sources: [], occurrences: [], relations: [] }, null, 2), 'application/json')}><Download size={15} />下载空白模板</button><button className="primary" disabled={offline || busy || !text.trim()} onClick={() => void run(async () => { const batch = await api<ImportBatch>('/imports/preview', { method: 'POST', body: JSON.stringify(JSON.parse(text)) }); setSelected(batch); await refresh(); })}>{busy ? '处理中…' : '预览导入'}</button></div>
    </section><section className="panel"><div className="section-title"><h3>把题库保留一份</h3><Download size={19} /></div><p className="muted">完整 JSON 包含卡片、来源、关系和历史版本。Markdown 适合直接阅读。</p><div className="backup-buttons"><button className="secondary" disabled={offline || busy} onClick={() => void run(async () => { const backup = await api<Record<string, unknown>>('/export'); downloadFile(`面试知识卡-完整备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), 'application/json'); notify('完整备份已下载'); })}><Download size={16} />导出完整备份</button><button className="secondary" disabled={offline || busy} onClick={() => void run(async () => { const response = await fetch('/api/v1/export?format=markdown', { credentials: 'same-origin', redirect: 'error' }); if (!response.ok || !response.headers.get('content-type')?.includes('text/markdown')) throw new Error('导出失败，请检查登录状态'); downloadFile(`面试知识卡-阅读版-${new Date().toISOString().slice(0, 10)}.md`, await response.text(), 'text/markdown'); notify('Markdown 阅读版已下载'); })}>导出 Markdown 阅读版</button></div><div className="inset-panel"><h4><RotateCcw size={16} />恢复备份</h4><p>选择之前导出的完整 JSON，在左侧预览恢复。恢复会替换当前题库，移除内容也会列在预览中。</p></div><p className="microcopy">AI 接口只提交草稿。待确认的数据在下方可见，你决定何时应用。</p></section></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {selected && <section ref={previewSection} id="import-preview" className="panel import-preview"><div className="section-title"><h3>{selected.mode === 'restore' ? '完整备份恢复预览' : '导入预览'}</h3><div className="button-row"><span className="muted">{selected.status === 'applied' ? '已应用' : selected.status === 'cancelled' ? '已取消' : '等待确认'}</span><button className="text-button" onClick={() => setSelected(null)}><ChevronUp size={16} />收起预览</button></div></div>
      {selected.mode === 'restore' && <div className="notice warning">这是完整恢复：当前题库将回到备份中的内容和历史版本。请查看包括“移除”在内的变化。</div>}
      <ImportPreview key={selected.id} changes={selected.preview} mode={selected.mode} />
      <div className="split-actions"><span className="microcopy">核对题目内容后确认；确认前不会修改正式题库。</span><div className="button-row"><button className="secondary" disabled={busy || offline || selected.status !== 'pending'} onClick={() => void run(async () => { setSelected(await api<ImportBatch>(`/imports/${selected.id}/repreview`, { method: 'POST', body: '{}' })); await refresh(); })}><RefreshCw size={15} />重新预览</button><button className="primary" disabled={busy || offline || selected.status !== 'pending' || !selected.preview.length} onClick={() => void run(async () => { const result = await api<{ library: Library; batch: ImportBatch }>(`/imports/${selected.id}/apply`, { method: 'POST', body: JSON.stringify({ expected_revision: selected.base_revision }) }); setSelected(result.batch); onLibrary(result.library); await refresh(); notify('导入已应用，题库已更新'); })}><Check size={16} />{selected.mode === 'restore' ? '确认恢复备份' : '确认导入'}</button></div></div>
    </section>}
    <section className="panel"><div className="section-title"><h3>导入记录</h3><button className="text-button" disabled={offline} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>{!batches.length ? <p className="muted">暂无导入草稿。AI 提交的草稿也会出现在这里。</p> : <div className="batch-list">{batches.map(batch => <button key={batch.id} className="batch-row" aria-expanded={selected?.id === batch.id} aria-controls="import-preview" onClick={() => setSelected(previous => previous?.id === batch.id ? null : batch)}><span>{batchLabel(batch)}<small>{new Date(batch.created_at).toLocaleString('zh-CN')} · {changeLabel(batch.preview)}</small></span><span className="button-row"><span className={'status ' + (batch.status === 'applied' ? 'mastered' : '')}>{batch.status === 'applied' ? '已应用' : batch.status === 'cancelled' ? '已取消' : '待确认'}</span>{selected?.id === batch.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span></button>)}</div>}</section>
  </div>;
}
