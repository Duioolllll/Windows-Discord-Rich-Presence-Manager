import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('autoPresence', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  pause: (paused: boolean) => ipcRenderer.invoke('activity:pause', paused),
  quit: () => ipcRenderer.invoke('app:quit'),
  testRule: (rule: unknown) => ipcRenderer.invoke('rule:test', rule),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
