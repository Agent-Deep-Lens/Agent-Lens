import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('inventory', {
  scan: (project?: string) => ipcRenderer.invoke('inventory:scan', project),
  directories: (path?: string) => ipcRenderer.invoke('inventory:directories', path),
  chooseDirectory: () => ipcRenderer.invoke('inventory:choose'),
  reveal: (id: string) => ipcRenderer.invoke('inventory:reveal', id),
});
