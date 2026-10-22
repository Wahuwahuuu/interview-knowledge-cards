import { app, BrowserWindow, dialog, Menu, shell, session } from 'electron';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDesktopServer } from './server';

app.setName('InterviewKnowledgeCards');
const dataDir = process.env.INTERVIEW_CARDS_DATA || join(app.getPath('appData'), 'InterviewKnowledgeCards');
mkdirSync(dataDir, { recursive: true });
const log = (error: unknown) => appendFileSync(join(dataDir, 'desktop.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`);
let server: Awaited<ReturnType<typeof startDesktopServer>> | undefined, window: BrowserWindow | undefined, closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
    server = await startDesktopServer({ dataDir, assets: join(root, 'dist'), migrations: join(root, 'migrations') });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '打开数据目录', click: () => { void shell.openPath(dataDir); } }, { label: '打开备份目录', click: () => { void shell.openPath(join(dataDir, 'backups')); } }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 800, minHeight: 600, title: '面试知识卡', backgroundColor: '#f5f6f0', icon: join(root, 'dist', 'icon-192.png'), autoHideMenuBar: true, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
    window.webContents.setWindowOpenHandler(({ url }) => { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== server!.origin) event.preventDefault(); });
    window.once('ready-to-show', () => window?.show());
    await window.loadURL(server.bootstrapUrl);
    if (server.connectionError) void dialog.showMessageBox(window, { type: 'warning', title: '手机连接服务暂不可用', message: server.connectionError, detail: '电脑题库仍可正常使用。关闭占用连接端口的程序，再重新打开客户端。' });
    if (!existsSync(join(dataDir, 'knowledge-cards.sqlite'))) throw new Error('本机数据库未创建');
  }).catch(error => { log(error); dialog.showErrorBox('面试知识卡启动失败', `本机题库没有被删除。请查看日志：${join(dataDir, 'desktop.log')}\n${error instanceof Error ? error.message : String(error)}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing || !server) return;
    event.preventDefault(); closing = true;
    void server.close().catch(log).finally(() => app.quit());
  });
}
