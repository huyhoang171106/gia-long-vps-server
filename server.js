const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

// ─── DB setup ───
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode=WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tentk TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    sdt TEXT DEFAULT '',
    hoten TEXT DEFAULT '',
    permisson INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    matkhau TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );
`);

// Seed admin default
const adminCount = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
if (adminCount === 0) {
  db.prepare('INSERT INTO admins (username, matkhau) VALUES (?, ?)').run('admin', 'admin123');
}

// Seed config default
const cfgCount = db.prepare('SELECT COUNT(*) as c FROM config').get().c;
if (cfgCount === 0) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('webviewUrl', '');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('linkContact', '');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('powerby', '');
}

// ─── Token store (memory) ───
const tokens = new Map(); // token -> { type: 'user'|'admin', id, username }

function createToken(type, id, username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { type, id, username });
  return token;
}

function verifyToken(token) {
  return tokens.get(token) || null;
}

// ─── Express app ───
const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware
function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Thiếu token' });
  const user = verifyToken(auth.slice(7));
  if (!user) return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
  req.authUser = user;
  next();
}

// POST /api/login
app.post('/api/login', (req, res) => {
  const { tentk, pass } = req.body;
  if (!tentk || !pass) return res.json({ success: false, message: 'Thiếu thông tin' });
  const row = db.prepare('SELECT * FROM users WHERE tentk = ? AND pass = ?').get(tentk, pass);
  if (!row) return res.json({ success: false, message: 'Sai tài khoản hoặc mật khẩu' });
  if (row.permisson === 0) return res.json({ success: false, message: 'Tài khoản chưa kích hoạt' });
  if (row.permisson === 2) return res.json({ success: false, message: 'Tài khoản đã bị khóa' });
  const token = createToken('user', row.id, row.tentk);
  res.json({ success: true, token, user: { tentk: row.tentk, sdt: row.sdt, hoten: row.hoten, permisson: row.permisson } });
});

// POST /api/register
app.post('/api/register', (req, res) => {
  const { tentk, pass, sdt, hoten } = req.body;
  if (!tentk || !pass || !sdt) return res.json({ success: false, message: 'Thiếu thông tin' });
  if (pass.length < 5) return res.json({ success: false, message: 'Mật khẩu phải >=5 ký tự' });
  if (sdt.length < 10 || sdt.length > 11) return res.json({ success: false, message: 'Số điện thoại không hợp lệ' });
  try {
    db.prepare('INSERT INTO users (tentk, pass, sdt, hoten, permisson) VALUES (?, ?, ?, ?, 0)').run(tentk, pass, sdt, hoten || '');
    res.json({ success: true, message: 'Đăng ký thành công' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.json({ success: false, message: 'Tên đăng nhập đã tồn tại' });
    res.json({ success: false, message: 'Lỗi server' });
  }
});

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { username, matkhau } = req.body;
  const row = db.prepare('SELECT * FROM admins WHERE username = ? AND matkhau = ?').get(username, matkhau);
  if (!row) return res.json({ success: false, message: 'Sai tài khoản admin' });
  const token = createToken('admin', row.id, row.username);
  res.json({ success: true, token });
});

// GET /api/config
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  rows.forEach(r => cfg[r.key] = r.value);
  res.json({ success: true, config: cfg });
});

// GET /api/users (admin only)
app.get('/api/users', authRequired, (req, res) => {
  if (req.authUser.type !== 'admin') return res.status(403).json({ success: false, message: 'Từ chối' });
  const { permisson } = req.query;
  let rows;
  if (permisson !== undefined) {
    rows = db.prepare('SELECT id, tentk, sdt, hoten, permisson FROM users WHERE permisson = ?').all(Number(permisson));
  } else {
    rows = db.prepare('SELECT id, tentk, sdt, hoten, permisson FROM users').all();
  }
  res.json({ success: true, users: rows });
});

// PUT /api/users/:id/permission (admin only)
app.put('/api/users/:id/permission', authRequired, (req, res) => {
  if (req.authUser.type !== 'admin') return res.status(403).json({ success: false, message: 'Từ chối' });
  const { permisson } = req.body;
  db.prepare('UPDATE users SET permisson = ? WHERE id = ?').run(permisson, req.params.id);
  res.json({ success: true });
});

// DELETE /api/users/:id (admin only)
app.delete('/api/users/:id', authRequired, (req, res) => {
  if (req.authUser.type !== 'admin') return res.status(403).json({ success: false, message: 'Từ chối' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── HTTP server ───
const server = http.createServer(app);

// ─── WebSocket ───
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory state
const lastCommands = new Map();   // path -> { text, timestamp }
const userSockets = new Map();    // ws -> { username, room, name, authenticated, token }
const roomUsers = new Map();      // room -> Map<username, ws>

function broadcast(room, data, excludeWs) {
  const clients = roomUsers.get(room);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const [_, ws] of clients) {
    if (ws === excludeWs) continue;
    if (ws.readyState === 1) ws.send(msg);
  }
}

function sendPresenceList(room) {
  const clients = roomUsers.get(room);
  if (!clients) return;
  const users = [];
  for (const [username, ws] of clients) {
    const info = userSockets.get(ws);
    if (info && info.type !== 'admin') users.push({ username, name: info.name || username, room: info.room, status: 'online', onlineAt: new Date().toISOString() });
  }
  const msg = JSON.stringify({ type: 'presence:list', room, users });
  console.log(`[PRESENCE] sendPresenceList room=${room} users=${users.length} -> ${users.map(u => u.username).join(',')}`);
  for (const [_, ws] of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  userSockets.set(ws, { authenticated: false });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); }

    // Auth first
    if (!userSockets.get(ws).authenticated) {
      if (msg.type !== 'auth') return ws.send(JSON.stringify({ type: 'error', message: 'Cần auth trước' }));
      const user = verifyToken(msg.token);
      if (!user) return ws.send(JSON.stringify({ type: 'error', message: 'Token không hợp lệ' }));
      userSockets.set(ws, { authenticated: true, ...user, room: null, name: msg.name || '' });
      return ws.send(JSON.stringify({ type: 'ok' }));
    }

    const info = userSockets.get(ws);

    switch (msg.type) {
      case 'subscribe': {
        const room = msg.path;
        // Leave old room
        if (info.room && roomUsers.has(info.room)) {
          roomUsers.get(info.room).delete(info.username);
          if (roomUsers.get(info.room).size === 0) roomUsers.delete(info.room);
          else sendPresenceList(info.room);
        }
        // Join new room
        info.room = room;
        if (!roomUsers.has(room)) roomUsers.set(room, new Map());
        roomUsers.get(room).set(info.username, ws);
        sendPresenceList(room);
        ws.send(JSON.stringify({ type: 'ok' }));
        break;
      }

      case 'unsubscribe': {
        if (info.room && roomUsers.has(info.room)) {
          roomUsers.get(info.room).delete(info.username);
          if (roomUsers.get(info.room).size === 0) roomUsers.delete(info.room);
          else sendPresenceList(info.room);
          info.room = null;
        }
        ws.send(JSON.stringify({ type: 'ok' }));
        break;
      }

      case 'command': {
        if (info.type !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Chỉ admin mới gửi lệnh' }));
        const cmdPath = msg.path;
        if (!cmdPath) return ws.send(JSON.stringify({ type: 'error', message: 'Thiếu path' }));
        const data = { text: msg.text || '', timestamp: new Date().toISOString() };
        lastCommands.set(cmdPath, data);
        broadcast(cmdPath, { type: 'command', path: cmdPath, ...data }, ws);
        ws.send(JSON.stringify({ type: 'ok' }));
        break;
      }

      case 'presence:list': {
        const pRoom = msg.room || info.room;
        if (pRoom) sendPresenceList(pRoom);
        break;
      }

      case 'heartbeat': {
        const hbRoom = msg.path || info.room;
        if (hbRoom) {
          sendPresenceList(hbRoom);
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown type' }));
    }
  });

  ws.on('close', () => {
    const info = userSockets.get(ws);
    if (info && info.room && roomUsers.has(info.room)) {
      roomUsers.get(info.room).delete(info.username);
      if (roomUsers.get(info.room).size === 0) roomUsers.delete(info.room);
    }
    userSockets.delete(ws);
  });
});

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`VPS server running on port ${PORT}`);
  console.log(`REST: http://0.0.0.0:${PORT}/api/`);
  console.log(`WS:   ws://0.0.0.0:${PORT}/ws`);
});
