// server.js
// WebSocket server with SQLite storage (better-sqlite3).
// Run: npm install && node server.js

const WebSocket = require('ws');
const path = require('path');
const Database = require('better-sqlite3');
const os = require('os');

const HOST = '10.170.67.131';
const PORT = 8080;
const DB_PATH = path.join(__dirname, 'messenger.db');

// Open / create DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better concurrency

// Initialize schema (id autoincrement, messages store text or file base64)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  last_seen INTEGER,
  connected INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  "from" TEXT NOT NULL,
  "to" TEXT,
  text TEXT,
  filename TEXT,
  filetype TEXT,
  data TEXT, -- base64 or NULL
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_from_to_ts ON messages("from", "to", ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
`);

// Prepared statements
const stmtUpsertUser = db.prepare(`
  INSERT INTO users(name, last_seen, connected) VALUES(@name, @ts, 1)
  ON CONFLICT(name) DO UPDATE SET last_seen=@ts, connected=1
`);
const stmtSetUserDisconnected = db.prepare(`UPDATE users SET connected=0, last_seen=@ts WHERE name=@name`);
const stmtGetUsers = db.prepare(`SELECT name FROM users WHERE connected=1 ORDER BY name COLLATE NOCASE`);
const stmtInsertMessage = db.prepare(`
  INSERT INTO messages("from","to",text,filename,filetype,data,ts)
  VALUES(@from,@to,@text,@filename,@filetype,@data,@ts)
`);
const stmtGetHistoryBetween = db.prepare(`
  SELECT id,"from","to",text,filename,filetype,data,ts
  FROM messages
  WHERE (("from" = @a AND "to" = @b) OR ("from" = @b AND "to" = @a))
  ORDER BY ts ASC
  LIMIT @limit
`);
const stmtGetGlobalHistory = db.prepare(`
  SELECT id,"from","to",text,filename,filetype,data,ts
  FROM messages
  WHERE "to" IS NULL
  ORDER BY ts ASC
  LIMIT @limit
`);

// WebSocket server
const wss = new WebSocket.Server({ host: HOST, port: PORT }, () => {
  console.log(`WebSocket server running on ws://${HOST}:${PORT}`);
});

// Map username -> ws
const users = new Map();

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors
  }
}

function broadcast(obj, except = null) {
  const raw = JSON.stringify(obj);
  for (const [name, client] of users) {
    if (client.readyState === WebSocket.OPEN && client !== except) {
      client.send(raw);
    }
  }
}

// Helper: get current list of connected usernames
function getConnectedUsernames() {
  return Array.from(users.keys());
}

wss.on('connection', (ws, req) => {
  let name = null;
  console.log('connection from', req.socket.remoteAddress);

  // Send hello
  send(ws, { type: 'hello', msg: 'welcome' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    // ---- Register
    if (msg.type === 'register') {
      const ts = Date.now();
      name = String(msg.name || '').trim() || ('User' + Math.floor(Math.random()*9000+1000));

      // avoid duplicate connected name: if someone else connected with same name, append suffix
      if (users.has(name)) {
        let i = 1;
        while (users.has(name + '#' + i)) i++;
        name = name + '#' + i;
      }

      users.set(name, ws);

      // upsert into DB
      try {
        stmtUpsertUser.run({ name, ts });
      } catch (e) {
        console.error('DB upsert user error', e && e.message);
      }

      console.log('registered', name);

      // reply to the registering client with their final name and user list
      send(ws, { type: 'registered', yourName: name, users: getConnectedUsernames() });

      // notify others
      broadcast({ type: 'presence', event: 'join', name }, ws);
      return;
    }

    // ---- Request list of users
    if (msg.type === 'requestUsers') {
      send(ws, { type: 'users', users: getConnectedUsernames() });
      return;
    }

    // ---- Get history
    // { type:'getHistory', with: '<username>' } or { type:'getHistory', with: 'Global', limit:50 }
    if (msg.type === 'getHistory') {
      const limit = Math.min(500, Math.max(1, parseInt(msg.limit || 100, 10)));
      if (msg.with === 'Global') {
        const rows = stmtGetGlobalHistory.all({ limit });
        send(ws, { type: 'history', with: 'Global', messages: rows });
      } else {
        const other = String(msg.with || '');
        // message between name and other
        const a = name;
        const b = other;
        if (!a || !b) { send(ws, { type: 'history', with: other, messages: [] }); return; }
        const rows = stmtGetHistoryBetween.all({ a, b, limit });
        send(ws, { type: 'history', with: other, messages: rows });
      }
      return;
    }

    // ---- Text message
    if (msg.type === 'message') {
      const payload = {
        type: 'message',
        from: name || 'Anonymous',
        to: msg.to || null,
        text: msg.text ? String(msg.text) : '',
        ts: Date.now()
      };

      // persist
      try {
        stmtInsertMessage.run({
          from: payload.from,
          to: payload.to,
          text: payload.text,
          filename: null,
          filetype: null,
          data: null,
          ts: payload.ts
        });
      } catch (e) {
        console.error('DB insert message error', e && e.message);
      }

      if (payload.to) {
        const recipient = users.get(payload.to);
        if (recipient && recipient.readyState === WebSocket.OPEN) send(recipient, payload);
        // send back to sender so the sender also shows sent message
        const sender = users.get(name);
        if (sender && sender.readyState === WebSocket.OPEN) send(sender, payload);
      } else {
        // global
        broadcast(payload);
      }
      return;
    }

    // ---- File message
    // msg: { type:'file', filename, filetype, data (base64), to? }
    if (msg.type === 'file') {
      const payload = {
        type: 'file',
        from: name || 'Anonymous',
        to: msg.to || null,
        filename: msg.filename ? String(msg.filename) : 'file',
        filetype: msg.filetype ? String(msg.filetype) : 'application/octet-stream',
        data: msg.data ? String(msg.data) : '',
        ts: Date.now()
      };

      // persist
      try {
        stmtInsertMessage.run({
          from: payload.from,
          to: payload.to,
          text: null,
          filename: payload.filename,
          filetype: payload.filetype,
          data: payload.data,
          ts: payload.ts
        });
      } catch (e) {
        console.error('DB insert file error', e && e.message);
      }

      if (payload.to) {
        const recipient = users.get(payload.to);
        if (recipient && recipient.readyState === WebSocket.OPEN) send(recipient, payload);
        const sender = users.get(name);
        if (sender && sender.readyState === WebSocket.OPEN) send(sender, payload);
      } else {
        broadcast(payload);
      }
      return;
    }

    // unknown type -> ignore
  });

  ws.on('close', () => {
    if (name) {
      users.delete(name);
      try {
        stmtSetUserDisconnected.run({ name, ts: Date.now() });
      } catch (e) { /* ignore */ }
      broadcast({ type: 'presence', event: 'leave', name });
      console.log(name, 'disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error('ws err', err && err.message);
  });
});
