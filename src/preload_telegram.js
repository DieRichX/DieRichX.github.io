// preload_telegram.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teleAuth', {
  send: (user) => {
    ipcRenderer.send('telegram-auth', user);
  },
  cancel: () => {
    ipcRenderer.send('telegram-auth-cancel');
  }
});