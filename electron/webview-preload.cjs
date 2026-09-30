const { contextBridge, ipcRenderer } = require('electron');

// This preload is used only by native WebContentsView pages. It exposes a
// narrow, explicit bridge so an injected page toolbar can ask the local
// workbench runner to execute a user-clicked code block.
contextBridge.exposeInMainWorld('__workbenchRunCode', {
  request: (payload) => ipcRenderer.invoke('desktop:run-web-code', payload),
  project: (payload) => ipcRenderer.invoke('desktop:web-project', payload),
  onProjectProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:web-project-progress', handler);
    return () => ipcRenderer.removeListener('desktop:web-project-progress', handler);
  },
});
