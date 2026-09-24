import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  storage: {
    get: (keys: any) => ipcRenderer.invoke('chrome:storage-get', keys),
    set: (obj: any) => ipcRenderer.invoke('chrome:storage-set', obj),
    remove: (keys: any) => ipcRenderer.invoke('chrome:storage-remove', keys),
    clear: () => ipcRenderer.invoke('chrome:storage-clear'),
    onChanged: (callback: (changes: any, areaName: string) => void) => {
      const wrappedCallback = (_event: any, changes: any, areaName: string) => callback(changes, areaName);
      ipcRenderer.on('chrome:storage-changed', wrappedCallback);
      return () => ipcRenderer.removeListener('chrome:storage-changed', wrappedCallback);
    }
  },
  runtime: {
    sendMessage: (msg: any) => ipcRenderer.invoke('chrome:send-message', msg),
    onMessage: (callback: (msg: any, sender: any, sendResponse: (resp: any) => void) => void) => {
      const wrappedCallback = (event: any, msg: any, replyChannel: string) => {
        const sendResponse = (resp: any) => {
          if (replyChannel) {
            ipcRenderer.send('chrome:service-worker-reply', replyChannel, resp);
          }
        };
        callback(msg, { id: 'electron-main' }, sendResponse);
      };
      ipcRenderer.on('chrome:service-worker-message', wrappedCallback);
      ipcRenderer.on('chrome:broadcast-message', (event, msg) => callback(msg, { id: 'electron-main' }, () => {}));
    }
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url)
  }
});
