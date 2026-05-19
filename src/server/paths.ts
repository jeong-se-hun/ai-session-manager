import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export const codexHome = path.resolve(expandHome(process.env.CODEX_HOME ?? "~/.codex"));
export const claudeHome = path.resolve(expandHome(process.env.CLAUDE_HOME ?? "~/.claude"));
export const geminiHome = path.resolve(expandHome(process.env.GEMINI_HOME ?? "~/.gemini"));
export const appHome = path.resolve(expandHome(process.env.CODEX_SESSION_MANAGER_HOME ?? "~/.codex-session-manager"));

export const stateDbPath = path.join(codexHome, "state_5.sqlite");
export const logsDbPath = path.join(codexHome, "logs_2.sqlite");
export const historyPath = path.join(codexHome, "history.jsonl");
export const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
export const sessionsRoot = path.join(codexHome, "sessions");
export const claudeProjectsRoot = path.join(claudeHome, "projects");
export const claudeTranscriptsRoot = path.join(claudeHome, "transcripts");
export const geminiHistoryRoot = path.join(geminiHome, "history");
export const geminiTmpRoot = path.join(geminiHome, "tmp");
export const appDbPath = path.join(appHome, "app.sqlite");
export const trashRoot = path.join(appHome, "trash");
export const backupRoot = path.join(appHome, "backups");

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toIsoFromSeconds(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}
