import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DesktopUpdater, UpdatePreparationError } from '../desktop/updater';

class Backend extends EventEmitter {
  autoDownload = false; autoInstallOnAppQuit = true; allowDowngrade = true; allowPrerelease = true;
  checkForUpdates = vi.fn(async (): Promise<{ downloadPromise?: Promise<unknown> } | null> => null);
  quitAndInstall = vi.fn();
}
const setup = (beforeInstall = vi.fn(async () => {})) => {
  const backend = new Backend(), failure = vi.fn(), ready = vi.fn();
  const manager = new DesktopUpdater({ version: '2.0.2', backend, beforeInstall, onReady: ready, onInstallFailure: failure });
  return { manager, backend, beforeInstall, failure, ready };
};
describe('Windows 自动更新保护', () => {
  it('便携版与开发运行不尝试检查或安装', async () => {
    const backup = vi.fn(); const manager = new DesktopUpdater({ version: '2.0.2', disabledReason: '请使用安装版', beforeInstall: backup });
    await manager.check(); await manager.install();
    expect(manager.status()).toMatchObject({ phase: 'disabled', message: '请使用安装版' }); expect(backup).not.toHaveBeenCalled();
  });
  it('后台下载，仅正式新版本，禁止退出时绕过备份直接安装', () => {
    const { backend } = setup();
    expect(backend).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false });
  });
  it('同时检查只发起一次请求，下载时不重复请求', async () => {
    const { backend, manager } = setup(); let finish!: () => void;
    backend.checkForUpdates.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null); }));
    const first = manager.check(), second = manager.check(); expect(first).toBe(second); expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    backend.emit('update-available', { version: '2.0.3' }); finish(); await first;
    await manager.check(); expect(backend.checkForUpdates).toHaveBeenCalledTimes(1); expect(manager.status().phase).toBe('downloading');
  });
  it('显示下载进度，只有校验完成事件才允许安装', async () => {
    const { backend, manager, beforeInstall, ready } = setup();
    await manager.install(); expect(beforeInstall).not.toHaveBeenCalled();
    backend.emit('update-available', { version: '2.0.3' }); backend.emit('download-progress', { percent: 150 });
    expect(manager.status()).toMatchObject({ phase: 'downloading', progress: 100, availableVersion: '2.0.3' });
    await manager.install(); expect(backend.quitAndInstall).not.toHaveBeenCalled();
    backend.emit('update-downloaded', { version: '2.0.3' }); expect(ready).toHaveBeenCalledTimes(1); expect(manager.status().phase).toBe('ready');
  });
  it('备份和关闭完成以后才能安装，重复安装请求无效', async () => {
    let finish!: () => void; const order: string[] = [];
    const { manager, backend } = setup(vi.fn(() => new Promise<void>(resolve => { order.push('backup'); finish = () => { order.push('closed'); resolve(); }; })));
    backend.quitAndInstall.mockImplementation(() => order.push('install'));
    backend.emit('update-downloaded', { version: '2.0.3' });
    const first = manager.install(); await manager.install(); expect(order).toEqual(['backup']);
    finish(); await first; expect(order).toEqual(['backup', 'closed', 'install']); expect(backend.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });
  it('备份失败或有未保存编辑时不启动安装，仍可重试', async () => {
    const blocked = vi.fn(async (): Promise<void> => { throw new UpdatePreparationError('请先保存编辑'); });
    const { backend, manager } = setup(blocked); backend.emit('update-downloaded', { version: '2.0.3' });
    await manager.install(); expect(manager.status()).toMatchObject({ phase: 'ready', message: '请先保存编辑' }); expect(backend.quitAndInstall).not.toHaveBeenCalled();
    blocked.mockImplementation(async () => { throw new Error('disk full'); }); await manager.install();
    expect(manager.status().phase).toBe('ready'); expect(backend.quitAndInstall).not.toHaveBeenCalled();
    blocked.mockResolvedValue(undefined); await manager.install(); expect(backend.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('离线检查及下载校验错误可恢复，不启动安装', async () => {
    const { backend, manager } = setup(); backend.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await manager.check(); expect(manager.status().phase).toBe('error'); expect(backend.quitAndInstall).not.toHaveBeenCalled();
    backend.checkForUpdates.mockImplementationOnce(async () => ({ downloadPromise: Promise.reject(new Error('checksum mismatch')) }));
    await manager.check(); await Promise.resolve(); expect(manager.status().phase).toBe('error');
    backend.checkForUpdates.mockImplementationOnce(async () => { backend.emit('update-not-available'); return null; });
    await manager.check(); expect(manager.status()).toMatchObject({ phase: 'idle', availableVersion: undefined });
  });
  it('安装器启动错误通知恢复流程，状态读出不能修改控制器', async () => {
    const { backend, manager, failure } = setup(); backend.emit('update-downloaded', { version: '2.0.3' });
    const copy = manager.status(); copy.phase = 'disabled'; expect(manager.status().phase).toBe('ready');
    await manager.install(); backend.emit('error', new Error('installer blocked'));
    expect(manager.status().phase).toBe('error'); expect(failure).toHaveBeenCalledTimes(1);
  });
});
