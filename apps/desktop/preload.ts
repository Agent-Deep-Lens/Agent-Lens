import type { Locale } from '../../packages/i18n/locale';
import type { InventoryBridge } from '../../packages/contracts';
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inventory', {
  scan: (project?: string) => ipcRenderer.invoke('inventory:scan', project),
  directories: (path?: string) => ipcRenderer.invoke('inventory:directories', path),
  chooseDirectory: (locale?: Locale) => ipcRenderer.invoke('inventory:choose', locale),
  reveal: (id: string) => ipcRenderer.invoke('inventory:reveal', id),
} satisfies InventoryBridge);
