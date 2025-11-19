// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = 'ws://10.170.67.131:8080';

let mainWindow = null;
let ws = null;
let username = null;
let reconnectDelay = 1000;

// simple outgoing queue for messages when ws is not ready
const outgoingQueue = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // For debugging: uncomment the next line to auto-open DevTools
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  connectWs();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function sendToRenderer(obj) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('fromMain', obj);
  }
}

// -------------------- Telegram Auth Helpers --------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''; // задайте в окружении!

function verifyTelegramAuth(data, botToken) {
  // data: object from widget (id, first_name, last_name?, username?, photo_url?, auth_date, hash)
  if (!data || !data.hash) return false;

  // 1) sort keys except hash
  const checkKeys = Object.keys(data).filter(k => k !== 'hash').sort();
  const dataCheckArr = [];
  for (const k of checkKeys) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    dataCheckArr.push(`${k}=${v}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  // 2) secret_key = SHA256(botToken)
  const secret = crypto.createHash('sha256').update(botToken).digest();

  // 3) hmac = HMAC_SHA256(data_check_string, secret)
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // 4) compare
  return hmac === data.hash;
}

let authWin = null;

function openTelegramAuthWindow() {
  if (authWin && !authWin.isDestroyed()) {
    authWin.focus();
    return;
  }

  authWin = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    show: true, // Убедитесь, что окно показывается
    webPreferences: {
      preload: path.join(__dirname, 'preload_telegram.js'), // Файл в корне
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  authWin.on('closed', () => {
    authWin = null;
  });

  // Загружаем auth.html из корневой папки
  authWin.loadFile(path.join(__dirname, 'auth.html'));
  console.log('Telegram auth window created and loaded');
}

// receive from auth preload (auth.html -> preload_telegram -> main)
ipcMain.on('telegram-auth', (ev, user) => {
  try {
    let ok = false;
    if (TELEGRAM_BOT_TOKEN) {
      try {
        ok = verifyTelegramAuth(user, TELEGRAM_BOT_TOKEN);
      } catch (e) {
        ok = false;
      }
    } else {
      console.warn('Telegram bot token not provided; skipping signature verification (NOT RECOMMENDED)');
      ok = true; // if you want to force verification, set to false here
    }

    if (!ok) {
      sendToRenderer({ type: 'telegram-auth', status: 'failed' });
    } else {
      const userName = user.username || (user.first_name + (user.last_name ? (' ' + user.last_name) : '')) || ('tg' + user.id);
      username = userName;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'register', name: username }));
      }

      sendToRenderer({ type: 'telegram-auth', status: 'ok', user: user, username });

      if (authWin && !authWin.isDestroyed()) {
        try {
          authWin.close();
        } catch(e){}
      }
    }
  } catch (e) {
    console.error('telegram-auth handler error', e && e.message);
    sendToRenderer({ type: 'telegram-auth', status: 'error' });
    if (authWin && !authWin.isDestroyed()) {
      try {
        authWin.close();
      } catch(e){}
    }
  }
});

ipcMain.on('telegram-auth-cancel', () => {
  if (authWin && !authWin.isDestroyed()) {
    try {
      authWin.close();
    } catch(e){}
  }
});

// -------------------- End Telegram Auth Helpers --------------------

function connectWs() {
  try {
    console.log('WS: connecting to', WS_URL);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('WS: connected');
      reconnectDelay = 1000;
      sendToRenderer({ type: 'ws-status', status: 'connected' });

      // if we have username (registered in renderer before ws connected), register now
      if (username) {
        const reg = { type: 'register', name: username };
        ws.send(JSON.stringify(reg));
        console.log('WS: sent register for', username);
      } else {
        // request users if no username yet
        ws.send(JSON.stringify({ type: 'requestUsers' }));
      }

      // flush queue
      while (outgoingQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        const toSend = outgoingQueue.shift();
        try {
          ws.send(JSON.stringify(toSend));
          console.log('WS: flushed queued message', toSend.type);
        } catch (e) {
          console.warn('WS: failed to flush message, re-queueing', e && e.message);
          outgoingQueue.unshift(toSend);
          break;
        }
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.warn('WS: invalid JSON', e && e.message);
        return;
      }
      // forward to renderer
      sendToRenderer({ type: 'ws-message', payload: msg });
    });

    ws.on('close', () => {
      console.log('WS: closed');
      sendToRenderer({ type: 'ws-status', status: 'disconnected' });
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('WS: error', err && err.message);
      sendToRenderer({ type: 'ws-status', status: 'error', error: String(err && err.message) });
      try { ws.terminate(); } catch(e){}
      scheduleReconnect();
    });

  } catch (e) {
    console.error('WS connect exception', e && e.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    connectWs();
  }, reconnectDelay);
}

// IPC from renderer
ipcMain.on('toMain', (event, msg) => {
  if (!msg || !msg.type) return;

  // handle openTelegramAuth request
  if (msg.type === 'openTelegramAuth') {
    openTelegramAuthWindow();
    return;
  }

  // save username immediately so open handler will register on connect
  if (msg.type === 'register') {
    username = msg.name;
    // if ws is open — send immediately; otherwise it will be sent when ws opens (see on 'open')
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'register', name: username }));
      console.log('IPC: forwarded register to WS for', username);
    } else {
      console.log('IPC: queued register until WS open for', username);
    }
    return;
  }

  // send messages and files — if ws ready, send; otherwise queue
  if (msg.type === 'message' || msg.type === 'file' || msg.type === 'requestUsers' || msg.type === 'getHistory') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
        console.log('IPC: sent to WS', msg.type, msg.filename ? msg.filename : '');
      } catch (e) {
        // push to queue on failure
        outgoingQueue.push(msg);
        console.warn('IPC: send failed, queued', e && e.message);
      }
    } else {
      outgoingQueue.push(msg);
      console.log('IPC: WS not open, queued message', msg.type);
      // notify renderer that message is queued / disconnected
      sendToRenderer({ type: 'ws-status', status: 'disconnected' });
    }
    return;
  }
});