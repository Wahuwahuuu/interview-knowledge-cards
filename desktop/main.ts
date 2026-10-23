import { app, BrowserWindow, dialog, Menu, shell, session, safeStorage } from 'electron';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startDesktopServer } from './server';
import electronUpdater from 'electron-updater';
import { DesktopUpdater, UpdatePreparationError } from './updater';
import { windowsCodec } from './cloud-sync';

app.setName('InterviewKnowledgeCards');
const dataDir = process.env.INTERVIEW_CARDS_DATA || join(app.getPath('appData'), 'InterviewKnowledgeCards');
mkdirSync(dataDir, { recursive: true });
const log = (error: unknown) => appendFileSync(join(dataDir, 'desktop.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`);
let server: Awaited<ReturnType<typeof startDesktopServer>> | undefined, window: BrowserWindow | undefined, closing = false;
let updates: DesktopUpdater | undefined, updateTimer: ReturnType<typeof setInterval> | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const portable = !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
    const installed = app.isPackaged && !portable && existsSync(join(dirname(app.getPath('exe')), 'Uninstall 面试知识卡.exe'));
    const backend = installed ? electronUpdater.autoUpdater : undefined;
    if (backend) {
      backend.disableWebInstaller = true;
      backend.logger = { info() {}, debug() {}, warn(message) { log(message); }, error(message) { log(message); } };
    }
    updates = new DesktopUpdater({ version: app.getVersion(), backend,
      disabledReason: installed ? undefined : '当前为便携版或开发版，可以直接运行。自动更新请首次安装安装版，原题库会继续保留。',
      log,
      beforeInstall: async () => {
        if (!server || !window || window.isDestroyed()) throw new UpdatePreparationError('请重新打开客户端后更新。');
        const blocked = await window.webContents.executeJavaScript('Boolean(document.querySelector(\'[data-update-blocked="true"]\'))');
        if (blocked) throw new UpdatePreparationError('请先保存正在编辑的卡片、导入已填写的题目，并等待当前操作结束，再重启更新。');
        const backup = join(dataDir, 'backups', `before-update-${app.getVersion()}-${Date.now()}.sqlite`);
        await server.prepareUpdateBackup(backup);
        await server.close(); server = undefined; closing = true;
      },
      onInstallFailure: () => {
        if (!server) {
          dialog.showErrorBox('更新未完成', '题库与更新前备份均已保留，将重新打开当前版本。');
          app.relaunch(); app.quit();
        }
      },
      onReady: () => { if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'info', title: '新版本已准备好', message: '新版本已在后台下载完成', detail: '保存正在编辑的内容后，打开左下角齿轮 → 软件更新，点击“重启更新”。更新前会自动备份题库。', buttons: ['稍后更新'] }); },
    });
    server = await startDesktopServer({ dataDir, assets: join(root, 'dist'), migrations: join(root, 'migrations'), cloud: { codec: {
      encrypt:async value=>{if(!await safeStorage.isAsyncEncryptionAvailable())throw new Error('本机安全存储暂不可用，请稍后重试');return 'electron:'+ (await safeStorage.encryptStringAsync(value)).toString('base64');},
      decrypt:async value=>value.startsWith('dpapi:')?windowsCodec.decrypt(value):(await safeStorage.decryptStringAsync(Buffer.from(value.slice(9),'base64'))).result,
    } }, updates: {
      status: () => updates!.status(), check: () => { void updates!.check(); }, install: () => { void updates!.install(); },
    } });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '打开数据目录', click: () => { void shell.openPath(dataDir); } }, { label: '打开备份目录', click: () => { void shell.openPath(join(dataDir, 'backups')); } }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '帮助', submenu: [{ label: '检查软件更新', click: () => { void updates!.check().then(() => { if (window) void dialog.showMessageBox(window, { type: 'info', title: '软件更新', message: updates!.status().message, detail: '更新进度及重启入口位于左下角齿轮 → 软件更新。' }); }); } }] },
    ]));
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 800, minHeight: 600, title: '面试知识卡', backgroundColor: '#f5f6f0', icon: join(root, 'dist', 'icon-192.png'), autoHideMenuBar: true, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
    window.webContents.setWindowOpenHandler(({ url }) => { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== server!.origin) event.preventDefault(); });
    window.once('ready-to-show', () => window?.show());
    await window.loadURL(server.bootstrapUrl);
    if (server.connectionError) void dialog.showMessageBox(window, { type: 'warning', title: '手机连接服务暂不可用', message: server.connectionError, detail: '电脑题库仍可正常使用。关闭占用连接端口的程序，再重新打开客户端。' });
    if (!existsSync(join(dataDir, 'knowledge-cards.sqlite'))) throw new Error('本机数据库未创建');
    if (installed) {
      void updates.check();
      updateTimer = setInterval(() => { void updates?.check(); }, 2 * 60 * 60 * 1000); updateTimer.unref();
    }
  }).catch(error => { log(error); dialog.showErrorBox('面试知识卡启动失败', `本机题库没有被删除。请查看日志：${join(dataDir, 'desktop.log')}\n${error instanceof Error ? error.message : String(error)}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (updateTimer) clearInterval(updateTimer);
    if (closing || !server) return;
    event.preventDefault(); closing = true;
    void server.close().catch(log).finally(() => app.quit());
  });
}
