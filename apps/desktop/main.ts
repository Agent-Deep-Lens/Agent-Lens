import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { InventoryService } from '../../packages/core/service';
import { resources } from '../../packages/i18n';
import { isLocale, resolveLocale } from '../../packages/i18n/locale';
import { captureResult, InventoryError, message, type Message } from '../../packages/contracts/messages';
app.setName('Agent Lens');
const service = new InventoryService();
let window: BrowserWindow | null = null;
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new InventoryError(message('errors.invalidSender'));
}
app.whenReady().then(() => {
  function handle(channel: string, operation: (input: unknown) => unknown, fallback?: Message) {
    ipcMain.handle(channel, (event, input: unknown) => captureResult(() => { assertSender(event); return operation(input); }, fallback));
  }
  function validatePath(input: unknown): asserts input is string | undefined {
    if (input !== undefined && (typeof input !== 'string' || input.length > 4096)) throw new InventoryError(message('errors.invalidRequest'));
  }
  handle('inventory:scan', project => { validatePath(project); return service.scan(project || undefined); });
  handle('inventory:directories', input => { validatePath(input); return service.directories(input); });
  handle('inventory:choose', async requestedLocale => {
    if (requestedLocale !== undefined && !isLocale(requestedLocale)) throw new InventoryError(message('errors.invalidRequest'));
    const locale = requestedLocale ?? resolveLocale('system', [app.getLocale()]);
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: resources[locale].translation['directory.title'] });
    return result.canceled ? null : result.filePaths[0];
  }, message('errors.directoryPicker'));
  handle('inventory:reveal', id => {
    if (typeof id !== 'string') throw new InventoryError(message('errors.invalidRequest'));
    const p = service.resourcePath(id);
    if (!p) throw new InventoryError(message('errors.resourceNotFound'));
    shell.showItemInFolder(p);
  }, message('errors.revealFailed'));
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
