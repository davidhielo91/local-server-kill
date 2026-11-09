import { contextBridge, ipcRenderer } from 'electron';
import type { Api, ScanResult } from '../shared/types';

const api: Api = {
  list: () => ipcRenderer.invoke('servers:list'),
  kill: (server) => ipcRenderer.invoke('servers:kill', server),
  killAll: (servers) => ipcRenderer.invoke('servers:killAll', servers),
  open: (port) => ipcRenderer.invoke('servers:open', port),
  copyUrl: (port) => ipcRenderer.invoke('servers:copyUrl', port),
  openFolder: (server) => ipcRenderer.invoke('servers:openFolder', server),
  openEditor: (server) => ipcRenderer.invoke('servers:openEditor', server),
  restart: (server) => ipcRenderer.invoke('servers:restart', server),
  onUpdate: (cb) => {
    ipcRenderer.on('servers:update', (_event, result: ScanResult) => cb(result));
  },
};

contextBridge.exposeInMainWorld('api', api);
