#!/usr/bin/env node
/* Seed SQLite từ dữ liệu Firebase export (User.json, Admin.json) */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode=WAL');

// Tạo bảng nếu chưa có (giống server.js)
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

// --- Seed users ---
const userPath = path.join(__dirname, 'User.json');
if (fs.existsSync(userPath)) {
  const users = JSON.parse(fs.readFileSync(userPath, 'utf-8'));
  const insert = db.prepare('INSERT OR IGNORE INTO users (tentk, pass, sdt, hoten, permisson) VALUES (?, ?, ?, ?, ?)');
  let count = 0;
  const tx = db.transaction(() => {
    for (const u of users) {
      const info = insert.run(u.tentk, u.pass, u.sdt || '', u.hoten || '', parseInt(u.permisson) || 0);
      if (info.changes > 0) count++;
    }
  });
  tx();
  console.log(`Users: ${count} imported (${users.length} total in file)`);
} else {
  console.log('User.json not found, skipping users');
}

// --- Seed admins ---
const adminPath = path.join(__dirname, 'Admin.json');
if (fs.existsSync(adminPath)) {
  const admins = JSON.parse(fs.readFileSync(adminPath, 'utf-8'));
  const insert = db.prepare('INSERT OR IGNORE INTO admins (username, matkhau) VALUES (?, ?)');
  let count = 0;
  const tx = db.transaction(() => {
    for (const a of admins) {
      const info = insert.run(a.username, a.matkhau);
      if (info.changes > 0) count++;
    }
  });
  tx();
  console.log(`Admins: ${count} imported (${admins.length} total in file)`);
} else {
  console.log('Admin.json not found, skipping admins');
}

// Seed config mặc định nếu chưa có
const cfgCount = db.prepare('SELECT COUNT(*) as c FROM config').get().c;
if (cfgCount === 0) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('webviewUrl', '');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('linkContact', '');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('powerby', '');
  console.log('Config: defaults seeded');
}

db.close();
console.log('Done.');
