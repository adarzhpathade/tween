'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('flow', {
  caps: () => ipcRenderer.invoke('caps'),
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  pickOutput: (suggested) => ipcRenderer.invoke('pick-output', suggested),
  start: (req) => ipcRenderer.invoke('start', req),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  openFile: (file) => ipcRenderer.invoke('open-file', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onFinished: (cb) => ipcRenderer.on('finished', (_e, d) => cb(d)),
});
