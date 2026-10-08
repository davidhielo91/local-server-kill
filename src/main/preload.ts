import { contextBridge, ipcRenderer } from 'electron';
import type { Api, ScanResult } from '../shared/types';

const api: Api = {
  list: () => ipcRenderer.invoke('servers:list'),
  kill: (pid) => ipcRenderer.invoke('servers:kill', pid),
  killAll: () => ipcRenderer.invoke('servers:killAll'),
  open: (port) => ipcRenderer.invoke('servers:open', port),
  copyUrl: (port) => ipcRenderer.invoke('servers:copyUrl', port),
  openFolder: (pid) => ipcRenderer.invoke('servers:openFolder', pid),
  openEditor: (pid) => ipcRenderer.invoke('servers:openEditor', pid),
  restart: (pid) => ipcRenderer.invoke('servers:restart', pid),
  onUpdate: (cb) => {
    ipcRenderer.on('servers:update', (_event, result: ScanResult) => cb(result));
  },
};

contextBridge.exposeInMainWorld('api', api);
