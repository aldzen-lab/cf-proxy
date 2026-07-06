// ponytail: node:sqlite is experimental. If its API churns, swap to better-sqlite3 —
// same prepare/run/get shape, change is isolated to this file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function initDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      api_key TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      cooldown_until REAL DEFAULT 0,
      last_used REAL DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      created_at REAL DEFAULT (strftime('%s','now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_active ON accounts(is_active, cooldown_until)");

  // node:sqlite has no ADD COLUMN IF NOT EXISTS — add each, ignore "duplicate column".
  for (const col of [
    "neurons_today REAL DEFAULT 0",
    "neurons_day TEXT DEFAULT ''",
    "requests_today INTEGER DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE accounts ADD COLUMN ${col}`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }

  return db;
}
