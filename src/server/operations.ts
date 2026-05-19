import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getAppDb } from "./appDb";
import type { TrashRecord } from "./appDb";
import { listSessions, openStateDb } from "./scanner";
import {
  backupRoot,
  claudeHome,
  claudeProjectsRoot,
  codexHome,
  geminiTmpRoot,
  historyPath,
  isInside,
  logsDbPath,
  sessionIndexPath,
  sessionsRoot,
  stateDbPath,
  trashRoot
} from "./paths";
import type { SessionSource, TrashResult } from "../shared/types";

const RECENT_GUARD_MS = 30 * 60 * 1000;

export async function trashSessions(sessionIds: string[]): Promise<TrashResult[]> {
  const list = await listSessions({ archive: "all", trash: "all", limit: 100000 });
  const byId = new Map(list.sessions.map((session) => [session.id, session]));
  const appDb = getAppDb();
  const insert = appDb.prepare(
    `INSERT INTO trash_items
      (session_id, title, original_rollout_path, trash_dir, manifest_path, deleted_at, restored_at, permanently_deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
      title = excluded.title,
      original_rollout_path = excluded.original_rollout_path,
      trash_dir = excluded.trash_dir,
      manifest_path = excluded.manifest_path,
      deleted_at = excluded.deleted_at,
      restored_at = NULL,
      permanently_deleted_at = NULL`
  );

  return sessionIds.map((sessionId) => {
    const session = byId.get(sessionId);
    if (!session) return { sessionId, status: "skipped", reason: "세션을 찾을 수 없습니다." };
    if (Date.now() - Date.parse(session.updatedAt) < RECENT_GUARD_MS) {
      return { sessionId, status: "skipped", reason: "최근 30분 내 갱신되어 실행 중일 수 있습니다." };
    }

    const deletedAt = new Date().toISOString();
    const trashDir = path.join(trashRoot, `${deletedAt.replace(/[:.]/g, "-")}-${safeFileName(sessionId)}`);
    const manifestPath = path.join(trashDir, "manifest.json");
    fs.mkdirSync(trashDir, { recursive: true });

    const sourceRoot = getSourceFileRoot(session.source);
    if (session.fileExists && isInside(sourceRoot, session.rolloutPath)) {
      fs.copyFileSync(session.rolloutPath, path.join(trashDir, path.basename(session.rolloutPath)));
    }
    copyRelatedSessionPaths(session.source, session.rolloutPath, trashDir);

    const manifest = {
      session,
      deletedAt,
      relatedPaths: getRelatedSessionPaths(session.source, session.rolloutPath),
      note: "삭제 대기 단계는 원본 AI 기록 파일을 삭제하지 않고 복구용 사본과 앱 상태만 기록합니다."
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    insert.run(session.id, session.title, session.rolloutPath, trashDir, manifestPath, deletedAt);
    return { sessionId, status: "trashed" };
  });
}

export function restoreSessions(sessionIds: string[]): TrashResult[] {
  const db = getAppDb();
  const stmt = db.prepare("UPDATE trash_items SET restored_at = ? WHERE session_id = ? AND restored_at IS NULL");
  const restoredAt = new Date().toISOString();
  return sessionIds.map((sessionId) => {
    const result = stmt.run(restoredAt, sessionId);
    return result.changes > 0
      ? { sessionId, status: "restored" }
      : { sessionId, status: "skipped", reason: "복구할 삭제 대기 항목이 없습니다." };
  });
}

export async function setArchived(sessionIds: string[], archived: boolean): Promise<TrashResult[]> {
  const list = await listSessions({ archive: "all", trash: "all", source: "all", limit: 100000 });
  const byId = new Map(list.sessions.map((session) => [session.id, session]));
  const codexIds = sessionIds.filter((id) => byId.get(id)?.source === "codex" || (!byId.has(id) && inferSourceFromSessionId(id) === "codex"));
  const skipped = sessionIds
    .filter((id) => !codexIds.includes(id))
    .map<TrashResult>((id) => ({ sessionId: id, status: "skipped", reason: "보관 처리는 Codex 세션만 지원합니다." }));
  if (codexIds.length === 0) return skipped;

  createBackup("archive");
  const db = openStateDb(false);
  try {
    const stmt = db.prepare("UPDATE threads SET archived = ?, archived_at = ? WHERE id = ?");
    const archivedAt = archived ? Math.floor(Date.now() / 1000) : null;
    const tx = db.transaction((ids: string[]) => {
      return ids.map((id) => {
        const result = stmt.run(archived ? 1 : 0, archivedAt, id);
        return result.changes > 0
          ? { sessionId: id, status: archived ? "archived" : "unarchived" }
          : { sessionId: id, status: "skipped", reason: "Codex 목록 저장소에서 세션을 찾을 수 없습니다." };
      });
    });
    return [...(tx(codexIds) as TrashResult[]), ...skipped];
  } finally {
    db.close();
  }
}

export async function permanentlyDeleteSessions(sessionIds: string[]): Promise<TrashResult[]> {
  const list = await listSessions({ archive: "all", trash: "all", source: "all", limit: 100000 });
  const byId = new Map(list.sessions.map((session) => [session.id, session]));
  const hasCodexTarget = sessionIds.some((id) => byId.get(id)?.source === "codex" || (!byId.has(id) && inferSourceFromSessionId(id) === "codex"));
  const stateDb = hasCodexTarget ? openStateDb(false) : null;
  const logsDb = hasCodexTarget && fs.existsSync(logsDbPath) ? new Database(logsDbPath) : null;
  const appDb = getAppDb();
  const trashStmt = appDb.prepare("SELECT * FROM trash_items WHERE session_id = ?");

  try {
    const results = sessionIds.map<TrashResult>((sessionId) => {
      const session = byId.get(sessionId);
      const trashRecord = trashStmt.get(sessionId) as TrashRecord | undefined;
      const rolloutPath = session?.rolloutPath || trashRecord?.original_rollout_path || "";
      const source = session?.source ?? inferSourceFromSessionId(sessionId);
      if (!session && !trashRecord) return { sessionId, status: "skipped", reason: "세션을 찾을 수 없습니다." };
      if (session && Date.now() - Date.parse(session.updatedAt) < RECENT_GUARD_MS) {
        return { sessionId, status: "skipped", reason: "최근 30분 내 갱신되어 실행 중일 수 있습니다." };
      }
      if (rolloutPath && !isInside(getSourceFileRoot(source), rolloutPath)) {
        return { sessionId, status: "skipped", reason: "세션 파일 경로가 해당 AI 기록 폴더 밖입니다." };
      }

      if (source === "codex") {
        if (!stateDb) return { sessionId, status: "skipped", reason: "Codex 목록 저장소를 열 수 없습니다." };
        deleteThreadState(stateDb, sessionId);
        if (logsDb && tableExists(logsDb, "logs")) {
          prepareSqliteForHardDelete(logsDb);
          logsDb.prepare("DELETE FROM logs WHERE thread_id = ?").run(sessionId);
        }
        rewriteJsonlWithoutSession(historyPath, "session_id", sessionId);
        rewriteJsonlWithoutSession(sessionIndexPath, "id", sessionId);
        scrubSessionFromBackups(sessionId);
      }

      for (const relatedPath of getRelatedSessionPaths(source, rolloutPath)) {
        if (fs.existsSync(relatedPath)) fs.rmSync(relatedPath, { recursive: true, force: true });
      }
      if (rolloutPath && fs.existsSync(rolloutPath)) fs.rmSync(rolloutPath, { force: true });

      deleteAppState(appDb, sessionId, trashRecord);
      return { sessionId, status: "deleted" };
    });
    if (stateDb) compactSqliteAfterHardDelete(stateDb);
    if (logsDb) compactSqliteAfterHardDelete(logsDb);
    return results;
  } finally {
    stateDb?.close();
    logsDb?.close();
  }
}

function getSourceFileRoot(source: SessionSource): string {
  if (source === "claude") return claudeHome;
  if (source === "gemini") return geminiTmpRoot;
  return sessionsRoot;
}

function inferSourceFromSessionId(sessionId: string): SessionSource {
  if (sessionId.startsWith("claude:")) return "claude";
  if (sessionId.startsWith("gemini:")) return "gemini";
  return "codex";
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_");
}

function getRelatedSessionPaths(source: SessionSource, rolloutPath: string): string[] {
  if (source !== "claude" || !rolloutPath) return [];
  if (!isInside(claudeProjectsRoot, rolloutPath)) return [];
  if (path.dirname(path.dirname(rolloutPath)) !== claudeProjectsRoot) return [];
  const relatedDir = path.join(path.dirname(rolloutPath), path.basename(rolloutPath, ".jsonl"));
  return fs.existsSync(relatedDir) && isInside(claudeHome, relatedDir) ? [relatedDir] : [];
}

function copyRelatedSessionPaths(source: SessionSource, rolloutPath: string, trashDir: string): void {
  const relatedRoot = path.join(trashDir, "related");
  for (const relatedPath of getRelatedSessionPaths(source, rolloutPath)) {
    fs.mkdirSync(relatedRoot, { recursive: true });
    fs.cpSync(relatedPath, path.join(relatedRoot, path.basename(relatedPath)), { recursive: true });
  }
}

function deleteAppState(appDb: Database.Database, sessionId: string, trashRecord: TrashRecord | undefined): void {
  if (trashRecord?.trash_dir && isInside(trashRoot, trashRecord.trash_dir) && fs.existsSync(trashRecord.trash_dir)) {
    fs.rmSync(trashRecord.trash_dir, { recursive: true, force: true });
  }
  prepareSqliteForHardDelete(appDb);
  const tx = appDb.transaction(() => {
    appDb.prepare("DELETE FROM summaries WHERE session_id = ?").run(sessionId);
    appDb.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
    appDb.prepare("DELETE FROM trash_items WHERE session_id = ?").run(sessionId);
  });
  tx();
  compactSqliteAfterHardDelete(appDb);
}

function scrubSessionFromBackups(sessionId: string): void {
  if (!fs.existsSync(backupRoot)) return;
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupRoot, entry.name);
    const backupStateDb = path.join(dir, path.basename(stateDbPath));
    const backupLogsDb = path.join(dir, path.basename(logsDbPath));
    if (fs.existsSync(backupStateDb)) {
      const db = new Database(backupStateDb);
      try {
        deleteThreadState(db, sessionId);
        compactSqliteAfterHardDelete(db);
      } finally {
        db.close();
      }
    }
    if (fs.existsSync(backupLogsDb)) {
      const db = new Database(backupLogsDb);
      try {
        prepareSqliteForHardDelete(db);
        if (tableExists(db, "logs")) db.prepare("DELETE FROM logs WHERE thread_id = ?").run(sessionId);
        compactSqliteAfterHardDelete(db);
      } finally {
        db.close();
      }
    }
    rewriteJsonlWithoutSession(path.join(dir, path.basename(historyPath)), "session_id", sessionId);
    rewriteJsonlWithoutSession(path.join(dir, path.basename(sessionIndexPath)), "id", sessionId);
  }
}

function deleteThreadState(db: Database.Database, sessionId: string): void {
  prepareSqliteForHardDelete(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const tx = db.transaction(() => {
    for (const { name } of tables) {
      const quotedName = quoteIdentifier(name);
      const columns = db.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{ name: string }>;
      if (name === "threads") continue;
      if (columns.some((column) => column.name === "thread_id")) {
        db.prepare(`DELETE FROM ${quotedName} WHERE thread_id = ?`).run(sessionId);
      }
    }
    if (tableExists(db, "threads")) db.prepare("DELETE FROM threads WHERE id = ?").run(sessionId);
  });
  tx();
}

function prepareSqliteForHardDelete(db: Database.Database): void {
  try {
    db.pragma("secure_delete = ON");
  } catch {
    // Older or busy SQLite builds can reject privacy hardening pragmas; logical deletion still proceeds.
  }
}

function compactSqliteAfterHardDelete(db: Database.Database): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Best effort: the row/file deletion already happened, compaction may be blocked by another connection.
  }
  try {
    db.exec("VACUUM");
  } catch {
    // Best effort: removes free pages when possible so deleted text is less likely to remain in SQLite files.
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { count: number }).count > 0;
}

function createBackup(reason: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupRoot, `${stamp}-${reason}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of [stateDbPath, logsDbPath, historyPath, sessionIndexPath]) {
    if (fs.existsSync(file) && isInside(codexHome, file)) {
      fs.copyFileSync(file, path.join(dir, path.basename(file)));
    }
  }
}

function rewriteJsonlWithoutSession(filePath: string, key: string, sessionId: string): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((line) => {
    if (!line.trim()) return false;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return value[key] !== sessionId;
    } catch {
      return true;
    }
  });
  fs.writeFileSync(filePath, `${kept.join("\n")}${kept.length ? "\n" : ""}`, "utf8");
}
