#!/usr/bin/env python3
"""Seed SQLite từ Firebase export JSON files."""
import json, os, sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), 'data.db')

conn = sqlite3.connect(DB_PATH)
conn.executescript('''
  PRAGMA journal_mode=WAL;
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
''')

# Users
user_path = os.path.join(os.path.dirname(__file__), 'User.json')
if os.path.exists(user_path):
    with open(user_path) as f:
        users = json.load(f)
    count = 0
    for u in users:
        try:
            conn.execute(
                'INSERT OR IGNORE INTO users (tentk, pass, sdt, hoten, permisson) VALUES (?, ?, ?, ?, ?)',
                (u['tentk'], u['pass'], u.get('sdt', ''), u.get('hoten', ''), int(u.get('permisson', 0)))
            )
            if conn.total_changes > 0:
                count += 1
        except Exception as e:
            print(f"  Skip user {u.get('tentk')}: {e}")
    print(f"Users: {count} imported ({len(users)} in file)")
    conn.commit()

# Admins
admin_path = os.path.join(os.path.dirname(__file__), 'Admin.json')
if os.path.exists(admin_path):
    with open(admin_path) as f:
        admins = json.load(f)
    count = 0
    for a in admins:
        try:
            conn.execute('INSERT OR IGNORE INTO admins (username, matkhau) VALUES (?, ?)', (a['username'], a['matkhau']))
            if conn.total_changes > 0:
                count += 1
        except Exception as e:
            print(f"  Skip admin {a.get('username')}: {e}")
    print(f"Admins: {count} imported ({len(admins)} in file)")

# Config defaults
cfg_count = conn.execute('SELECT COUNT(*) FROM config').fetchone()[0]
if cfg_count == 0:
    for k in ('webviewUrl', 'linkContact', 'powerby'):
        conn.execute('INSERT INTO config (key, value) VALUES (?, ?)', (k, ''))
    print("Config: defaults seeded")

conn.commit()
conn.close()
print('Done.')
