import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { InventoryService } from '../../packages/core/service';
app.setName('Agent Lens');
const service = new InventoryService();
let window: BrowserWindow | null = null;
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid sender');
}
app.whenReady().then(() => {
  ipcMain.handle('inventory:scan', (event, project: unknown) => { assertSender(event); if (project !== undefined && typeof project !== 'string') throw new Error('Invalid path'); return service.scan(project || undefined); });
  ipcMain.handle('inventory:directories', (event, input: unknown) => { assertSender(event); if (input !== undefined && typeof input !== 'string') throw new Error('Invalid path'); return service.directories(input); });
  ipcMain.handle('inventory:choose', async event => { assertSender(event); const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: '选择项目目录' }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle('inventory:reveal', (event, id: unknown) => { assertSender(event); if (typeof id !== 'string') throw new Error('Invalid id'); const p = service.resourcePath(id); if (p) shell.showItemInFolder(p); });
  const createWindow = () => {
    window = new BrowserWindow({ width: 1440, height: 920, minWidth: 880, minHeight: 600, title: 'Agent Lens', icon: path.join(__dirname, '../web/agent-lens.png'), backgroundColor: '#f7f7f5',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadFile(path.join(__dirname, '../web/index.html'));
    window.on('closed', () => { window = null; });
  };
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { void service.close(); });
