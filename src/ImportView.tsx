import { useEffect, useRef, useState } from 'react';
import { Upload, Download, Check, RotateCcw, FileJson, RefreshCw, ChevronUp, ChevronDown, X } from 'lucide-react';
import { type Change, type ImportBatch, type ImportEnvelope, type Library } from '../shared/model';
import { importFileLimit, parseImportFile, validateMergeImport, type ImportPage } from '../shared/import-file';
import { summarizeChanges } from '../shared/import-summary';
import { ApiError, api, downloadFile, exportMarkdownText, loadLibrary } from './api';
import { ImportPreview } from './ImportPreview';
import { ManualImportForm } from './ManualImportForm';
import { applyImportBatch, cancelImportBatch, createImportSubmitter, refreshImportBatch, type ImportResult } from './import-actions';
import { ConfirmationDialog } from './ConfirmationDialog';
import { applyMutationReply, deltaPath, refreshChangedRecords } from './record-mutation-actions';

function changeLabel(changes: Change[]) { const summary = summarizeChanges(changes); return summary.questions ? `${summary.questions} 道题` : '题库资料更新'; }
function batchLabel(batch: ImportBatch) {
  if (batch.mode === 'restore') return '完整备份恢复';
  const project = batch.preview.find(change => change.kind === 'projects');
  const cards = batch.preview.filter(change => change.kind === 'cards');
  if (project) return project.name + (cards.length ? ` · ${cards.length} 个问题` : '');
  if (cards.length) return cards.slice(0, 2).map(card => card.name).join('、') + (cards.length > 2 ? ` 等 ${cards.length} 个问题` : '');
  return batch.label || '问答与来源导入';
}
function statusLabel(batch: ImportBatch) {
  if (batch.status === 'applied') return batch.mode === 'restore' ? '已恢复' : '已导入';
  if (batch.status === 'failed') return '导入失败';
  if (batch.status === 'cancelled') return '已取消';
  return batch.mode === 'restore' ? '待确认' : '未导入';
}
type Props = { library: Library; view: ImportPage; offline: boolean; pendingStateSave?: boolean; onLibrary: (library: Library) => void; onError: (error: unknown) => void; notify: (text: string) => void };

export function ImportView({ library, view, offline, pendingStateSave = false, onLibrary, onError, notify }: Props) {
  const [batches, setBatches] = useState<ImportBatch[]>([]), [selected, setSelected] = useState<ImportBatch | null>(null);
  const [running, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [fileName, setFileName] = useState('');
  const busy = running || pendingStateSave;
  const [manualResetKey, setManualResetKey] = useState(0), [manualDirty, setManualDirty] = useState(false);
  const [confirmationBatch, setConfirmationBatch] = useState<ImportBatch | null>(null);
  const [cancellationBatch, setCancellationBatch] = useState<ImportBatch | null>(null);
  const cancelling = useRef(false);
  const manualEditVersion = useRef(0), submitImport = useRef(createImportSubmitter());
  const file = useRef<HTMLInputElement>(null), restoreFile = useRef<HTMLInputElement>(null), selectedRecord = useRef<HTMLDivElement>(null);
  const activeView = useRef(view); activeView.current = view;
  const pageMode = view === 'backup' ? 'restore' : 'merge';
  const selectedHere = selected?.mode === pageMode ? selected : null;
  async function refresh() {
    if (offline) return;
    try {
      const next = await api<ImportBatch[]>('/imports');
      const expanded=selected&&next.find(batch=>batch.id===selected.id);
      if(expanded&&selected.preview_loaded!==false&&(expanded.status!==selected.status||expanded.base_revision!==selected.base_revision))next[next.indexOf(expanded)]=await api<ImportBatch>(`/imports/${encodeURIComponent(expanded.id)}`);
      setBatches(next);
      setSelected(current => {
        if (!current) return current;
        const latest = next.find(batch => batch.id === current.id);
        if (!latest || ['applied', 'cancelled'].includes(current.status) && !['applied', 'cancelled'].includes(latest.status) || latest.status === current.status && latest.base_revision < current.base_revision) return current;
        return current.preview_loaded!==false&&latest.status===current.status&&latest.base_revision===current.base_revision?{...latest,preview:current.preview,preview_loaded:true}:latest;
      });
    } catch (e) { onError(e); }
  }
  useEffect(() => { void refresh(); }, [offline]);
  useEffect(() => { setSelected(null); setError(''); setNotice(''); setFileName(''); setConfirmationBatch(null); setCancellationBatch(null); }, [view]);
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
  async function previewEnvelope(envelope: ImportEnvelope) {
    const batch = await api<ImportBatch>('/imports/preview', { method: 'POST', body: JSON.stringify(envelope) });
    showPreview(batch);
    await refresh();
  }
  async function importEnvelope(envelope: ImportEnvelope, manual = false) {
    const submittedVersion = manualEditVersion.current;
    setSelected(null);
    try {
      const result = await submitImport.current(envelope,library);
      onLibrary(result.library); showPreview(result.batch);
      notify(result.already_applied ? '这批内容已导入，记录已更新' : '导入成功，题库已更新');
      if (manual && submittedVersion === manualEditVersion.current) { setManualResetKey(key => key + 1); setManualDirty(false); }
    } finally { await refresh(); }
  }
  async function retryBatch(batch: ImportBatch) {
    if (busy || offline) return;
    await run(async () => {
      try {
        const result = await api<ImportResult>(deltaPath(`/imports/${encodeURIComponent(batch.id)}/retry`,library.revision), { method: 'POST', body: '{}' });
        onLibrary(await applyMutationReply(library,result)); showPreview(result.batch); notify('导入成功，题库已更新');
      } finally { await refresh(); }
    });
  }
  async function upload(selectedFile: File, target: ImportPage) {
    await run(async () => {
      if (selectedFile.size > importFileLimit) throw new Error(target === 'backup' ? '备份文件超过当前 8 MB 恢复上限，请保留完整文件，不要拆分恢复。' : '文件超过 8 MB，请减少单次导入的问题数量。');
      const envelope = parseImportFile(await selectedFile.text(), target, library);
      if (activeView.current === target) setFileName(selectedFile.name);
      if (target === 'backup') await previewEnvelope(envelope);
      else await importEnvelope(envelope);
    });
  }
  function template() {
    downloadFile('import-template-v1.json', JSON.stringify({ schema_version: 1, mode: 'merge', projects: [{ id: 'example-project', name: '示例题库' }], cards: [{ id: 'example-question-1', project_id: 'example-project', title: '填写卡片标题', question: '填写面试问题', summary_md: '填写面试口述版', answer_md: '填写详细讲解', important: false }], topics: [], sources: [], occurrences: [], relations: [] }, null, 2), 'application/json');
  }
  function requestCancel(batch: ImportBatch) {
    if (busy || offline || batch.status !== 'pending') return;
    setError(''); setConfirmationBatch(null); setCancellationBatch(batch);
  }
  async function cancelBatch(batch: ImportBatch) {
    if (busy || offline || cancelling.current) return;
    cancelling.current = true;
    let finished = false;
    try {
      await run(async () => {
        const result = await cancelImportBatch(batch);
        setBatches(current => current.map(value => value.id === result.id ? result : value));
        setSelected(current => current?.id === result.id ? result : current);
        setCancellationBatch(null); finished = true;
        if (result.status === 'applied') {
          notify('这条记录已完成导入，无法取消；已更新记录状态');
          onLibrary(result.mode==='merge'?await refreshChangedRecords(library):await loadLibrary());
        } else {
          notify(result.mode === 'restore' ? '这次恢复已取消，题库保持原样' : '这次导入已取消，题库保持原样');
        }
      });
    } finally {
      cancelling.current = false;
      if (finished) requestAnimationFrame(() => document.getElementById(`import-record-${batch.id}`)?.focus());
    }
  }
  async function applyBatch(batch: ImportBatch) {
    if (busy || offline) return;
    await run(async () => {
      const result = await applyImportBatch(batch,library);
      setConfirmationBatch(null); showPreview(result.batch);
      if (result.kind === 'refreshed') {
        const message = '题库刚有更新，已重新生成预览，本次尚未导入。请核对后再次点击确认。';
        if ((activeView.current === 'backup') === (result.batch.mode === 'restore')) setNotice(message);
        notify(message);
      } else if (result.kind === 'cancelled') {
        const message = '这条记录已取消，题库保持原样。需要导入时请生成新的预览。';
        setNotice(message); notify(message);
      } else {
        onLibrary(result.library); notify(result.batch.mode === 'restore' ? '备份已恢复，题库已更新' : '导入已应用，题库已更新');
      }
      await refresh();
    });
  }
  const listed = selectedHere ? batches.some(batch => batch.id === selectedHere.id) ? batches.map(batch => batch.id === selectedHere.id ? selectedHere : batch) : [selectedHere, ...batches] : batches;
  const visibleBatches = listed.filter(batch => batch.mode === pageMode);
  const preview = selectedHere && <section id={`import-preview-${selectedHere.id}`} aria-labelledby={`import-record-${selectedHere.id}`} className="import-preview batch-preview">
    <div className="section-title"><h4>{selectedHere.mode === 'restore' ? '完整备份恢复预览' : '导入内容'}</h4><div className="button-row"><span className="muted">{statusLabel(selectedHere)}</span><button className="text-button" disabled={busy} onClick={closePreview}><ChevronUp size={16} />收起内容</button></div></div>
    {selectedHere.mode === 'restore' && selectedHere.status === 'pending' && <div className="notice warning">确认恢复后，将用备份替换当前账号的整个题库，包括答案历史。请核对所有新增、修改和移除内容。</div>}
    {selectedHere.error && <div className="notice error" role="alert">{selectedHere.error}</div>}
    {selectedHere.preview_loaded===false?<p className="muted">正在读取导入内容…</p>:selectedHere.preview.length > 0 ? <ImportPreview key={selectedHere.id} changes={selectedHere.preview} mode={selectedHere.mode} review={selectedHere.mode === 'restore' && selectedHere.status === 'pending'} /> : <p className="muted">{selectedHere.status === 'failed' ? '本次未写入题库。请根据错误提示修改内容后重新提交，或在问题解决后重试。' : '本批内容与题库一致，没有新增或修改。'}</p>}
    {notice && <div className="notice warning import-action-message" role="status">{notice}</div>}
    {error && <div className="notice error import-action-message" role="alert">{error}</div>}
    {selectedHere.mode === 'restore' && <div className="split-actions"><span className="microcopy">核对后确认，确认前不会修改正式题库。</span><div className="button-row">
      {selectedHere.status === 'pending' && <button className="secondary" disabled={busy || offline} onClick={() => requestCancel(selectedHere)}><X size={15} />{selectedHere.mode === 'restore' ? '取消恢复' : '取消导入'}</button>}
      <button className="secondary" disabled={busy || offline || selectedHere.status !== 'pending'} onClick={() => void run(async () => { showPreview(await refreshImportBatch(selectedHere)); await refresh(); })}><RefreshCw size={15} />重新预览</button>
      <button className="primary" disabled={busy || offline || selectedHere.status !== 'pending' || !selectedHere.preview.length} onClick={() => {
        if (selectedHere.mode === 'restore' || selectedHere.preview.some(change => change.operation === 'remove')) { setError(''); setConfirmationBatch(selectedHere); }
        else void applyBatch(selectedHere);
      }}><Check size={16} />{busy ? '处理中…' : selectedHere.mode === 'restore' ? '确认恢复备份' : '确认导入'}</button>
    </div></div>}
    {selectedHere.mode === 'merge' && ['pending', 'failed'].includes(selectedHere.status) && <div className="split-actions"><span className="microcopy">{selectedHere.status === 'failed' ? '填写的内容和这条记录会保留。' : '这条记录尚未导入，点击导入后直接保存。'}</span><div className="button-row"><button className="primary" disabled={busy || offline} onClick={() => void retryBatch(selectedHere)}><Upload size={16} />{busy ? '正在导入…' : selectedHere.status === 'failed' ? '重试导入' : '导入这条记录'}</button></div></div>}
  </section>;
  return <div className="import-view" data-update-blocked={manualDirty || busy || undefined}>
    <div hidden={view !== 'import'} className="human-import-page">
      <ManualImportForm library={library} offline={offline} busy={busy} resetKey={manualResetKey} onEdit={() => { manualEditVersion.current++; setManualDirty(true); }} onImport={envelope => run(() => importEnvelope(validateMergeImport(envelope, library), true))} />
      <section className="panel json-import-tools" aria-label="JSON 文件导入">
        <div><h3><FileJson size={19} />使用 JSON 文件导入</h3><p className="muted">上传后自动解析并直接导入，结果保存在下方记录中。</p></div>
        <div className="button-row"><button className="secondary" onClick={template}><Download size={16} />下载 JSON 模板</button><button className="secondary" disabled={offline || busy} onClick={() => file.current?.click()}><Upload size={16} />上传 JSON</button></div>
        <input ref={file} type="file" aria-label="上传 JSON 导入文件" accept="application/json,.json" className="visually-hidden" disabled={offline || busy} onChange={event => { const next = event.target.files?.[0]; event.target.value = ''; if (next) void upload(next, 'import'); }} />
      </section>
    </div>
    {view === 'backup' && <div className="backup-page">
      <section className="panel"><div className="section-title"><h3><Download size={19} />下载备份</h3></div><p className="muted">完整 JSON 可恢复题目、来源、关联和答案历史；Markdown 适合直接阅读。</p><div className="backup-buttons">
        <button className="primary" disabled={offline || busy} onClick={() => void run(async () => { const backup = await api<Record<string, unknown>>('/export'); downloadFile(`面试知识卡-完整备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), 'application/json'); notify('完整备份已下载'); })}><Download size={16} />导出完整备份</button>
        <button className="secondary" disabled={offline || busy} onClick={() => void run(async () => { downloadFile(`面试知识卡-阅读版-${new Date().toISOString().slice(0, 10)}.md`, await exportMarkdownText(), 'text/markdown'); notify('Markdown 阅读版已下载'); })}>导出 Markdown 阅读版</button>
      </div></section>
      <section className="panel backup-restore"><div className="section-title"><h3><RotateCcw size={19} />恢复完整备份</h3></div><p className="muted">上传之前下载的完整 JSON 备份，先预览，再确认恢复。</p><p className="notice warning">恢复会替换当前账号的整个题库。移除的题目与资料会列在预览中。</p><button className="secondary" disabled={offline || busy} onClick={() => restoreFile.current?.click()}><Upload size={16} />选择备份并预览</button>
        <input ref={restoreFile} type="file" aria-label="上传完整备份文件" accept="application/json,.json" className="visually-hidden" disabled={offline || busy} onChange={event => { const next = event.target.files?.[0]; event.target.value = ''; if (next) void upload(next, 'backup'); }} />
      </section>
    </div>}
    {fileName && <p className="import-file-name muted">已解析文件：{fileName}</p>}
    {!selectedHere && error && <div className="notice error" role="alert">{error}</div>}
    <section className="panel import-records"><div className="section-title"><h3>{view === 'backup' ? '恢复记录' : '导入记录'}</h3><button className="text-button" disabled={offline || busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>
      {!visibleBatches.length ? <p className="muted">{view === 'backup' ? '还没有恢复记录。上传完整备份后可查看恢复预览。' : '还没有导入记录。填写问答、上传文件或 AI 提交后，结果会出现在这里。'}</p> : <div className="batch-list">{visibleBatches.map(batch => <div key={batch.id} ref={selectedHere?.id === batch.id ? selectedRecord : undefined} className={'batch-entry ' + (selectedHere?.id === batch.id ? 'expanded' : '')}>
        <div className="batch-entry-header"><button id={`import-record-${batch.id}`} className="batch-row" disabled={offline || busy} aria-expanded={selectedHere?.id === batch.id} aria-controls={`import-preview-${batch.id}`} onClick={() => {
          if (selectedHere?.id === batch.id) closePreview();
          else { showPreview(batch); void run(async () => { const current = batch.mode === 'restore' ? await refreshImportBatch(batch) : await api<ImportBatch>(`/imports/${encodeURIComponent(batch.id)}`); showPreview(current); if (batch.mode === 'restore' && activeView.current === 'backup' && current.status === 'pending' && current.base_revision !== batch.base_revision) setNotice('题库已更新，已为你刷新预览。核对后即可确认。'); }); }
        }}><span>{batchLabel(batch)}<small>{new Date(batch.created_at).toLocaleString('zh-CN')} · {batch.question_count ? `${batch.question_count} 道题` : changeLabel(batch.preview)}</small></span><span className="button-row"><span className={'status ' + (batch.status === 'applied' ? 'mastered' : batch.status === 'failed' ? 'import-failed' : '')}>{statusLabel(batch)}</span>{selectedHere?.id === batch.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span></button>{batch.mode === 'restore' && batch.status === 'pending' && <button type="button" className="secondary batch-cancel" aria-label={`取消恢复：${batchLabel(batch)}`} disabled={offline || busy} onClick={() => requestCancel(batch)}>取消</button>}</div>
        {selectedHere?.id === batch.id && preview}
      </div>)}</div>}
    </section>
    {confirmationBatch && <ConfirmationDialog title="确认恢复整个题库？" description={`将用这份备份替换当前账号的整个题库，其中 ${confirmationBatch.preview.filter(change => change.kind === 'cards' && change.operation === 'remove').length} 道题会被移除。当前资料的修改也可能被覆盖，请核对预览并保留需要的备份。`} busy={busy} confirmDisabled={offline} error={offline ? '当前离线，请联网后再次确认。' : error} confirmLabel="确认恢复" onCancel={() => setConfirmationBatch(null)} onConfirm={() => void applyBatch(confirmationBatch)} />}
    {cancellationBatch && <ConfirmationDialog title={cancellationBatch.mode === 'restore' ? '取消这次恢复？' : '取消这次导入？'} name={batchLabel(cancellationBatch)} description="记录将保留并标记为「已取消」，正式题库保持原样。需要导入时，可以重新填写或上传文件生成新的预览。" busy={busy} confirmDisabled={offline} error={offline ? '当前离线，请联网后再次确认。' : error} cancelLabel="继续保留" confirmLabel="确认取消" confirmIcon={<X size={15} />} onCancel={() => setCancellationBatch(null)} onConfirm={() => void cancelBatch(cancellationBatch)} />}
  </div>;
}
