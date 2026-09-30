'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fusion', Object.freeze({
  request: (method, path, body, options) => ipcRenderer.invoke('fusion:request', { method, path, body, progressId: options?.progressId }),
  showProvider: id => ipcRenderer.invoke('fusion:showProvider', id),
  openRecoveryProvider: id => ipcRenderer.invoke('fusion:openRecoveryProvider', id),
  setBounds: bounds => ipcRenderer.invoke('fusion:setBounds', bounds),
  setLayout: layout => ipcRenderer.invoke('fusion:setLayout', layout),
  diagnoseSend: id => ipcRenderer.invoke('fusion:diagnoseSend', id),
  reloadProvider: id => ipcRenderer.invoke('fusion:reloadProvider', id),
  listBrowserProfiles: () => ipcRenderer.invoke('fusion:listBrowserProfiles'),
  importBrowserLogin: payload => ipcRenderer.invoke('fusion:importBrowserLogin', payload),
  importLoginFile: payload => ipcRenderer.invoke('fusion:importLoginFile', payload),
  saveMarkdown: payload => ipcRenderer.invoke('fusion:saveMarkdown', payload),
  copyText: text => ipcRenderer.invoke('fusion:copyText', text),
  runtimeInfo: () => ipcRenderer.invoke('fusion:runtimeInfo'),
  launchDesktopAgent: payload => ipcRenderer.invoke('fusion:launchDesktopAgent', payload),
  listWorkbenchProviders: () => ipcRenderer.invoke('fusion:listWorkbenchProviders'),
  saveWorkbenchProviders: payload => ipcRenderer.invoke('fusion:saveWorkbenchProviders', payload),
  listWorkbenchModels: payload => ipcRenderer.invoke('fusion:listWorkbenchModels', payload),
  testWorkbenchProvider: payload => ipcRenderer.invoke('fusion:testWorkbenchProvider', payload),
  workbenchChat: payload => ipcRenderer.invoke('fusion:workbenchChat', payload),
  runCode: payload => ipcRenderer.invoke('fusion:runCode', payload),
  runProject: payload => ipcRenderer.invoke('fusion:runProject', payload),
  launchWorkbenchTool: payload => ipcRenderer.invoke('fusion:launchWorkbenchTool', payload),
  writeWorkbenchTerminal: payload => ipcRenderer.invoke('fusion:writeWorkbenchTerminal', payload),
  stopWorkbenchTerminal: payload => ipcRenderer.invoke('fusion:stopWorkbenchTerminal', payload),
  openWorkbenchTarget: payload => ipcRenderer.invoke('fusion:openWorkbenchTarget', payload),
  openWorkbenchWeb: payload => ipcRenderer.invoke('fusion:openWorkbenchWeb', payload),
  setWorkbenchWeb: payload => ipcRenderer.invoke('fusion:setWorkbenchWeb', payload),
  controlWorkbenchWeb: action => ipcRenderer.invoke('fusion:controlWorkbenchWeb', {action}),
  hideWorkbenchWeb: () => ipcRenderer.invoke('fusion:hideWorkbenchWeb'),
  onStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('fusion:status', listener);
    return () => ipcRenderer.removeListener('fusion:status', listener);
  },
}));
