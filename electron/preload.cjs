const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  ping: () => ipcRenderer.invoke('desktop:ping'),
  openWeb: (id, url, bounds) => ipcRenderer.invoke('desktop:open-web', { id, url, bounds }),
  focusWeb: (id, bounds) => ipcRenderer.invoke('desktop:focus-web', { id, bounds }),
  hideWeb: () => ipcRenderer.invoke('desktop:hide-web'),
  closeWeb: (id) => ipcRenderer.invoke('desktop:close-web', { id }),
  setBounds: (id, bounds) => ipcRenderer.invoke('desktop:set-bounds', { id, bounds }),
  reloadWeb: (id) => ipcRenderer.invoke('desktop:reload-web', { id }),
  goBackWeb: (id) => ipcRenderer.invoke('desktop:go-back-web', { id }),
  goForwardWeb: (id) => ipcRenderer.invoke('desktop:go-forward-web', { id }),
  getWebState: (id) => ipcRenderer.invoke('desktop:get-web-state', { id }),
  extractWebContent: (id) => ipcRenderer.invoke('desktop:extract-web-content', { id }),
  extractWebSegments: (id) => ipcRenderer.invoke('desktop:extract-web-segments', { id }),
  applyWebTranslations: (id, mode, translations) => ipcRenderer.invoke('desktop:apply-web-translations', { id, mode, translations }),
  webChat: (id, prompt, timeoutMs) => ipcRenderer.invoke('desktop:web-chat', { id, prompt, timeoutMs }),
  onWebChatProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('desktop:web-chat-progress', handler);
    return () => ipcRenderer.removeListener('desktop:web-chat-progress', handler);
  },
  onWebLink: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:web-link', handler);
    return () => ipcRenderer.removeListener('desktop:web-link', handler);
  },
  onWebSelectionTranslate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:translate-selection', handler);
    return () => ipcRenderer.removeListener('desktop:translate-selection', handler);
  },
  newWebChat: (id) => ipcRenderer.invoke('desktop:new-web-chat', { id }),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', { url }),
  openTarget: (payload) => ipcRenderer.invoke('desktop:open-target', payload),
  openFusion: () => ipcRenderer.invoke('desktop:open-fusion'),
  ensureFusion: () => ipcRenderer.invoke('desktop:ensure-fusion'),
  fusionStatus: () => ipcRenderer.invoke('desktop:fusion-status'),
  launchAgent: (payload) => ipcRenderer.invoke('desktop:launch-agent', payload),
});
