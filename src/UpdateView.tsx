import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { DesktopUpdateStatus } from '../shared/desktop-update';
import { api } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';

export function UpdateView() {
  const [status, setStatus] = useState<DesktopUpdateStatus>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try { const next = await api<DesktopUpdateStatus>('/desktop/update'); if (active) { setStatus(next); setError(''); } }
      catch { if (active) setError('暂时无法读取更新状态，请稍后重试。'); }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function run(install = false) {
    setBusy(true); setError('');
    try { setStatus(await api<DesktopUpdateStatus>(`/desktop/update/${install ? 'install' : 'check'}`, { method: 'POST', body: JSON.stringify(install ? { confirmed: true } : {}) })); setConfirm(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成，请重试。'); }
    finally { setBusy(false); }
  }
  const working = busy || status?.phase === 'checking' || status?.phase === 'downloading' || status?.phase === 'installing';
  return <section className="panel update-panel"><h3>软件更新</h3>
    {status ? <>
      <p className="update-version">当前版本 <strong>{status.version || '本机服务'}</strong>{status.availableVersion && <span> · 新版本 {status.availableVersion}</span>}</p>
      <p role="status">{status.message}</p>
      {status.phase === 'downloading' && <div className="update-progress"><progress max={100} value={status.progress ?? 0} aria-label="更新下载进度" /><span>{Math.round(status.progress ?? 0)}%</span></div>}
      <div className="button-row"><button className="secondary" disabled={working || status.phase === 'disabled'} onClick={() => void run()}><RefreshCw size={16} />检查更新</button>{status.phase === 'ready' && <button className="primary" disabled={busy} onClick={() => setConfirm(true)}><Download size={16} />重启更新</button>}</div>
      <p className="microcopy">安装版启动时自动检查新版本并在后台下载。题库、账户和手机配对保存在独立的数据目录；更新前会自动备份，不用重新导入题库。</p>
      {status.checkedAt && <p className="microcopy">上次检查：{new Date(status.checkedAt).toLocaleString('zh-CN')}</p>}
    </> : <p>正在读取版本信息…</p>}
    {error && status?.phase !== 'installing' && <p className="notice error" role="alert">{error}</p>}
    {confirm && <ConfirmationDialog title="现在重启并更新？" description="请先保存编辑或导入填写的题目。客户端将自动备份题库，关闭本机连接，安装新版后重新打开；手机待同步修改会继续保留。" busy={busy} confirmLabel="重启更新" onCancel={() => setConfirm(false)} onConfirm={() => void run(true)} />}
  </section>;
}
