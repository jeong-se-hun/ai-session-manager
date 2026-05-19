import fs from "node:fs";
import Database from "better-sqlite3";
import { appDbPath, appHome, backupRoot, trashRoot } from "./paths";

export interface TrashRecord {
  session_id: string;
  title: string;
  original_rollout_path: string;
  trash_dir: string;
  manifest_path: string;
  deleted_at: string;
  restored_at: string | null;
  permanently_deleted_at: string | null;
}

let db: Database.Database | null = null;

export function getAppDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(trashRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  db = new Database(appDbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trash_items (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      original_rollout_path TEXT NOT NULL,
      trash_dir TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      restored_at TEXT,
      permanently_deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tags (
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, tag)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function getSummaryMap(): Map<string, string> {
  const rows = getAppDb().prepare("SELECT session_id, summary FROM summaries").all() as Array<{
    session_id: string;
    summary: string;
  }>;
  return new Map(rows.map((row) => [row.session_id, row.summary]));
}

export function saveSummary(sessionId: string, summary: string): void {
  getAppDb()
    .prepare(
      `INSERT INTO summaries (session_id, summary, generated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, generated_at = excluded.generated_at`
    )
    .run(sessionId, summary, new Date().toISOString());
}

export function getTrashMap(): Map<string, TrashRecord> {
  const rows = getAppDb()
    .prepare("SELECT * FROM trash_items WHERE restored_at IS NULL AND permanently_deleted_at IS NULL")
    .all() as TrashRecord[];
  return new Map(rows.map((row) => [row.session_id, row]));
}

export function getSetting(key: string): string | null {
  const row = getAppDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getSettings(keys: string[]): Map<string, string> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = getAppDb()
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .all(...keys) as Array<{ key: string; value: string }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function saveSettings(values: Record<string, string>): void {
  const now = new Date().toISOString();
  const stmt = getAppDb().prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const tx = getAppDb().transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) stmt.run(key, value, now);
  });
  tx(Object.entries(values));
}
