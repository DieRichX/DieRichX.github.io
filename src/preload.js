// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    if (channel === 'toMain') ipcRenderer.send('toMain', data);
  },
  on: (channel, cb) => {
    if (channel === 'fromMain') ipcRenderer.on('fromMain', (e, data) => cb(data));
  },
  once: (channel, cb) => {
    if (channel === 'fromMain') ipcRenderer.once('fromMain', (e, data) => cb(data));
  }
});