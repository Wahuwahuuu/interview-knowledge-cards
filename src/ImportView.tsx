import { useEffect, useRef, useState } from 'react';
import { Upload, Download, Check, RotateCcw, FileJson, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { type Change, type ImportBatch, type ImportEnvelope, type Library } from '../shared/model';
import { importFileLimit, parseImportFile, validateMergeImport, type ImportPage } from '../shared/import-file';
import { summarizeChanges } from '../shared/import-summary';
import { ApiError, api, downloadFile } from './api';
import { ImportPreview } from './ImportPreview';
import { ManualImportForm } from './ManualImportForm';
import { applyImportBatch, refreshImportBatch } from './import-actions';

function changeLabel(changes: Change[]) { const summary = summarizeChanges(changes); return summary.questions ? `${summary.questions} 道题` : '题库资料更新'; }
function batchLabel(batch: ImportBatch) {
  if (batch.mode === 'restore') return '完整备份恢复';
  const project = batch.preview.find(change => change.kind === 'projects');
  const cards = batch.preview.filter(change => change.kind === 'cards');
  if (project) return project.name + (cards.length ? ` · ${cards.length} 个问题` : '');
  if (cards.length) return cards.slice(0, 2).map(card => card.name).join('、') + (cards.length > 2 ? ` 等 ${cards.length} 个问题` : '');
  return '问答与来源导入';
}
type Props = { library: Library; view: ImportPage; offline: boolean; onLibrary: (library: Library) => void; onError: (error: unknown) => void; notify: (text: string) => void };

export function ImportView({ library, view, offline, onLibrary, onError, notify }: Props) {
  const [batches, setBatches] = useState<ImportBatch[]>([]), [selected, setSelected] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [fileName, setFileName] = useState('');
  const [manualBatchId, setManualBatchId] = useState(''), [manualResetKey, setManualResetKey] = useState(0);
  const manualEditVersion = useRef(0), manualPreviewVersion = useRef<number | null>(null);
  const file = useRef<HTMLInputElement>(null), restoreFile = useRef<HTMLInputElement>(null), selectedRecord = useRef<HTMLDivElement>(null);
  const activeView = useRef(view); activeView.current = view;
  const pageMode = view === 'backup' ? 'restore' : 'merge';
  const selectedHere = selected?.mode === pageMode ? selected : null;
  async function refresh() {
    if (offline) return;
    try {
      const next = await api<ImportBatch[]>('/imports');
      setBatches(next);
      setSelected(current => {
        if (!current) return current;
        const latest = next.find(batch => batch.id === current.id);
        if (!latest || current.status !== 'pending' && latest.status === 'pending' || latest.status === current.status && latest.base_revision < current.base_revision) return current;
        return latest;
      });
    } catch (e) { onError(e); }
  }
  useEffect(() => { void refresh(); }, [offline]);
  useEffect(() => { setSelected(null); setError(''); setNotice(''); setFileName(''); }, [view]);
  useEffect(() => { if (selectedHere) selectedRecord.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [selectedHere?.id]);
  async function run(task: () => Promise<void>) {
    const startedIn = activeView.current;
    setBusy(true); setError(''); setNotice('');
    try { await task(); }
    catch (e) {
      if (activeView.current === startedIn) setError(e instanceof ApiError && e.details.length ? e.message + '：' + e.details.map(v => `${v.path} ${v.message}`).join('；') : e instanceof Error ? e.message : '操作失败');
      onError(e);
    } finally { setBusy(false); }
  }
  function showPreview(batch: ImportBatch) {
    setBatches(current => current.some(value => value.id === batch.id) ? current.map(value => value.id === batch.id ? batch : value) : [batch, ...current]);
    if ((activeView.current === 'backup') === (batch.mode === 'restore')) setSelected(batch);
  }
  function closePreview() {
    if (busy) return;
    const recordId = selectedHere?.id;
    setSelected(null); setError(''); setNotice('');
    if (recordId) document.getElementById(`import-record-${recordId}`)?.focus();
  }
  async function previewEnvelope(envelope: ImportEnvelope, manual = false) {
    const submittedVersion = manualEditVersion.current;
    const batch = await api<ImportBatch>('/imports/preview', { method: 'POST', body: JSON.stringify(envelope) });
    if (manual) { setManualBatchId(batch.id); manualPreviewVersion.current = submittedVersion; }
    showPreview(batch);
    await refresh();
  }
  async function upload(selectedFile: File, target: ImportPage) {
    await run(async () => {
      if (selectedFile.size > importFileLimit) throw new Error(target === 'backup' ? '备份文件超过当前 8 MB 恢复上限，请保留完整文件，不要拆分恢复。' : '文件超过 8 MB，请减少单次导入的问题数量。');
      const envelope = parseImportFile(await selectedFile.text(), target, library);
      if (activeView.current === target) setFileName(selectedFile.name);
      await previewEnvelope(envelope);
    });
  }
  function template() {
    downloadFile('import-template-v1.json', JSON.stringify({ schema_version: 1, mode: 'merge', projects: [{ id: 'example-project', name: '示例题库' }], cards: [{ id: 'example-question-1', project_id: 'example-project', title: '填写卡片标题', question: '填写面试问题', summary_md: '填写面试口述版', answer_md: '填写详细讲解', important: false }], topics: [], sources: [], occurrences: [], relations: [] }, null, 2), 'application/json');
  }
  const listed = selectedHere ? batches.some(batch => batch.id === selectedHere.id) ? batches.map(batch => batch.id === selectedHere.id ? selectedHere : batch) : [selectedHere, ...batches] : batches;
  const visibleBatches = listed.filter(batch => batch.mode === pageMode);
  const preview = selectedHere && <section id={`import-preview-${selectedHere.id}`} aria-labelledby={`import-record-${selectedHere.id}`} className="import-preview batch-preview">
    <div className="section-title"><h4>{selectedHere.mode === 'restore' ? '完整备份恢复预览' : '导入预览'}</h4><div className="button-row"><span className="muted">{selectedHere.status === 'applied' ? '已应用' : selectedHere.status === 'cancelled' ? '已取消' : '等待确认'}</span><button className="text-button" disabled={busy} onClick={closePreview}><ChevronUp size={16} />收起预览</button></div></div>
    {selectedHere.mode === 'restore' && <div className="notice warning">确认恢复后，将用备份替换当前账号的整个题库，包括答案历史。请核对所有新增、修改和移除内容。</div>}
    <ImportPreview key={selectedHere.id} changes={selectedHere.preview} mode={selectedHere.mode} />
    {notice && <div className="notice warning import-action-message" role="status">{notice}</div>}
    {error && <div className="notice error import-action-message" role="alert">{error}</div>}
    <div className="split-actions"><span className="microcopy">核对后确认，确认前不会修改正式题库。</span><div className="button-row">
      <button className="secondary" disabled={busy || offline || selectedHere.status !== 'pending'} onClick={() => void run(async () => { showPreview(await refreshImportBatch(selectedHere)); await refresh(); })}><RefreshCw size={15} />重新预览</button>
      <button className="primary" disabled={busy || offline || selectedHere.status !== 'pending' || !selectedHere.preview.length} onClick={() => void run(async () => {
        const result = await applyImportBatch(selectedHere);
        showPreview(result.batch);
        if (result.kind === 'refreshed') {
          const message = '题库刚有更新，已重新生成预览，本次尚未导入。请核对后再次点击确认。';
          if ((activeView.current === 'backup') === (result.batch.mode === 'restore')) setNotice(message);
          notify(message);
        } else {
          onLibrary(result.library); notify(result.batch.mode === 'restore' ? '备份已恢复，题库已更新' : '导入已应用，题库已更新');
          if (result.batch.id === manualBatchId) {
            if (manualPreviewVersion.current === manualEditVersion.current) setManualResetKey(key => key + 1);
            else notify('已导入此前预览中的内容；你之后填写的修改已保留，可重新预览。');
            setManualBatchId(''); manualPreviewVersion.current = null;
          }
        }
        await refresh();
      })}><Check size={16} />{busy ? '处理中…' : selectedHere.mode === 'restore' ? '确认恢复备份' : '确认导入'}</button>
    </div></div>
  </section>;
  return <div className="import-view">
    <div hidden={view !== 'import'} className="human-import-page">
      <ManualImportForm library={library} offline={offline} busy={busy} resetKey={manualResetKey} onEdit={() => { manualEditVersion.current++; }} onPreview={envelope => run(() => previewEnvelope(validateMergeImport(envelope, library), true))} />
      <section className="panel json-import-tools" aria-label="JSON 文件导入">
        <div><h3><FileJson size={19} />使用 JSON 文件导入</h3><p className="muted">上传文件后自动解析，并在下方生成导入预览。</p></div>
        <div className="button-row"><button className="secondary" onClick={template}><Download size={16} />下载 JSON 模板</button><button className="secondary" disabled={offline || busy} onClick={() => file.current?.click()}><Upload size={16} />上传 JSON</button></div>
        <input ref={file} type="file" aria-label="上传 JSON 导入文件" accept="application/json,.json" className="visually-hidden" disabled={offline || busy} onChange={event => { const next = event.target.files?.[0]; event.target.value = ''; if (next) void upload(next, 'import'); }} />
      </section>
    </div>
    {view === 'backup' && <div className="backup-page">
      <section className="panel"><div className="section-title"><h3><Download size={19} />下载备份</h3></div><p className="muted">完整 JSON 可恢复题目、来源、关联和答案历史；Markdown 适合直接阅读。</p><div className="backup-buttons">
        <button className="primary" disabled={offline || busy} onClick={() => void run(async () => { const backup = await api<Record<string, unknown>>('/export'); downloadFile(`面试知识卡-完整备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), 'application/json'); notify('完整备份已下载'); })}><Download size={16} />导出完整备份</button>
        <button className="secondary" disabled={offline || busy} onClick={() => void run(async () => { const response = await fetch('/api/v1/export?format=markdown', { credentials: 'same-origin', redirect: 'error' }); if (!response.ok || !response.headers.get('content-type')?.includes('text/markdown')) throw new Error('导出失败，请检查登录状态'); downloadFile(`面试知识卡-阅读版-${new Date().toISOString().slice(0, 10)}.md`, await response.text(), 'text/markdown'); notify('Markdown 阅读版已下载'); })}>导出 Markdown 阅读版</button>
      </div></section>
      <section className="panel backup-restore"><div className="section-title"><h3><RotateCcw size={19} />恢复完整备份</h3></div><p className="muted">上传之前下载的完整 JSON 备份，先预览，再确认恢复。</p><p className="notice warning">恢复会替换当前账号的整个题库。移除的题目与资料会列在预览中。</p><button className="secondary" disabled={offline || busy} onClick={() => restoreFile.current?.click()}><Upload size={16} />选择备份并预览</button>
        <input ref={restoreFile} type="file" aria-label="上传完整备份文件" accept="application/json,.json" className="visually-hidden" disabled={offline || busy} onChange={event => { const next = event.target.files?.[0]; event.target.value = ''; if (next) void upload(next, 'backup'); }} />
      </section>
    </div>}
    {fileName && <p className="import-file-name muted">已解析文件：{fileName}</p>}
    {!selectedHere && error && <div className="notice error" role="alert">{error}</div>}
    <section className="panel import-records"><div className="section-title"><h3>{view === 'backup' ? '恢复记录' : '导入记录'}</h3><button className="text-button" disabled={offline || busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>
      {!visibleBatches.length ? <p className="muted">{view === 'backup' ? '还没有恢复记录。上传完整备份后可查看恢复预览。' : '还没有导入记录。填写问答或上传文件后，预览会出现在这里。'}</p> : <div className="batch-list">{visibleBatches.map(batch => <div key={batch.id} ref={selectedHere?.id === batch.id ? selectedRecord : undefined} className={'batch-entry ' + (selectedHere?.id === batch.id ? 'expanded' : '')}>
        <button id={`import-record-${batch.id}`} className="batch-row" disabled={offline || busy} aria-expanded={selectedHere?.id === batch.id} aria-controls={`import-preview-${batch.id}`} onClick={() => {
          if (selectedHere?.id === batch.id) closePreview();
          else { showPreview(batch); void run(async () => { const current = await refreshImportBatch(batch); showPreview(current); if ((activeView.current === 'backup') === (batch.mode === 'restore') && current.status === 'pending' && current.base_revision !== batch.base_revision) setNotice('题库已更新，已为你刷新预览。核对后即可确认。'); await refresh(); }); }
        }}><span>{batchLabel(batch)}<small>{new Date(batch.created_at).toLocaleString('zh-CN')} · {changeLabel(batch.preview)}</small></span><span className="button-row"><span className={'status ' + (batch.status === 'applied' ? 'mastered' : '')}>{batch.status === 'applied' ? '已应用' : batch.status === 'cancelled' ? '已取消' : '待确认'}</span>{selectedHere?.id === batch.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span></button>
        {selectedHere?.id === batch.id && preview}
      </div>)}</div>}
    </section>
  </div>;
}
