import type { DesktopUpdateStatus } from '../shared/desktop-update';

export class UpdatePreparationError extends Error {}

export type UpdateBackend = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null; cancellationToken?: { cancel(): void } } | null>;
  quitAndInstall(silent: boolean, runAfter: boolean): void;
};

export class DesktopUpdater {
  private state: DesktopUpdateStatus;
  private checking?: Promise<void>;
  private installing = false;
  private downloadTimer?: ReturnType<typeof setTimeout>;
  private cancelDownload?: () => void;

  constructor(private options: {
    version: string;
    backend?: UpdateBackend;
    disabledReason?: string;
    beforeInstall: () => Promise<void>;
    onInstallFailure?: () => void;
    onReady?: () => void;
    log?: (error: unknown) => void;
  }) {
    this.state = { version: options.version, phase: options.backend ? 'idle' : 'disabled', message: options.disabledReason ?? '启动后自动检查更新，下载完成后可重启安装。' };
    const backend = options.backend;
    if (!backend) return;
    backend.autoDownload = true;
    // The application backs up and drains SQLite before explicitly installing.
    // Installing implicitly on quit could bypass that protection during shutdown.
    backend.autoInstallOnAppQuit = false;
    backend.allowDowngrade = false;
    backend.allowPrerelease = false;
    backend.on('checking-for-update', () => this.set({ phase: 'checking', message: '正在检查新版本…', progress: undefined }));
    backend.on('update-not-available', () => this.set({ phase: 'idle', checkedAt: new Date().toISOString(), availableVersion: undefined, message: '已是最新版本。' }));
    backend.on('update-available', (info: { version: string }) => { this.set({ phase: 'downloading', availableVersion: info.version, progress: 0, checkedAt: new Date().toISOString(), message: '发现新版本，正在后台下载；可以继续使用题库。' }); this.watchDownload(); });
    backend.on('download-progress', (info: { percent: number }) => { this.set({ phase: 'downloading', progress: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : 0 }); this.watchDownload(); });
    backend.on('update-downloaded', (info: { version: string }) => {
      this.set({ phase: 'ready', availableVersion: info.version, progress: 100, message: '新版本已下载并校验。保存编辑后，点击“重启更新”。' });
      options.onReady?.();
    });
    backend.on('error', error => this.failed(error));
  }

  status() { return { ...this.state }; }
  private set(patch: Partial<DesktopUpdateStatus>) {
    this.state = { ...this.state, ...patch };
    if (patch.phase && patch.phase !== 'downloading') { if (this.downloadTimer) clearTimeout(this.downloadTimer); this.downloadTimer = undefined; this.cancelDownload = undefined; }
  }
  private watchDownload() {
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer = setTimeout(() => {
      if (this.state.phase !== 'downloading') return;
      this.cancelDownload?.(); this.failed(new Error('Update download made no progress for two minutes'));
    }, 120000);
    this.downloadTimer.unref?.();
  }
  private failed(error: unknown) {
    this.options.log?.(error);
    const duringInstall = this.state.phase === 'installing';
    this.set({ phase: 'error', message: duringInstall ? '更新未完成，题库和更新前备份已保留，请重新打开客户端后重试。' : '暂时无法检查或下载更新，请联网后重试。本地题库可以继续使用。' });
    if (duringInstall) this.options.onInstallFailure?.();
  }

  check(): Promise<void> {
    if (this.checking) return this.checking;
    const backend = this.options.backend;
    if (!backend || ['downloading', 'ready', 'installing'].includes(this.state.phase)) return Promise.resolve();
    this.set({ phase: 'checking', message: '正在检查新版本…' });
    const work = (async () => {
      try {
        const result = await backend.checkForUpdates();
        if (this.state.phase === 'downloading' && result?.cancellationToken) this.cancelDownload = () => result.cancellationToken!.cancel();
        // Downloads continue after the check returns. Observe their errors too.
        if (result?.downloadPromise) void result.downloadPromise.catch(error => this.failed(error));
      } catch (error) { this.failed(error); }
    })();
    this.checking = work;
    void work.finally(() => { if (this.checking === work) this.checking = undefined; });
    return work;
  }

  async install() {
    const backend = this.options.backend;
    if (!backend || this.installing || this.state.phase !== 'ready') return;
    this.installing = true;
    this.set({ phase: 'installing', message: '正在备份题库并准备重启，请稍候…' });
    try {
      await this.options.beforeInstall();
      backend.quitAndInstall(true, true);
    } catch (error) {
      this.options.log?.(error);
      // A failed backup must leave the current app running and allow a retry.
      this.set({ phase: 'ready', message: error instanceof UpdatePreparationError ? error.message : '备份或关闭题库未完成，本次未启动更新。请稍后重试。' });
    } finally { this.installing = false; }
  }
}
