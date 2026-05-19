import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getSummaryMap, getTrashMap } from "./appDb";
import { readJsonl, truncateText } from "./jsonl";
import { appHome, codexHome, historyPath, sessionsRoot, stateDbPath, toIsoFromSeconds } from "./paths";
import type {
  DetailItem,
  SessionDetailResponse,
  SessionFilters,
  SessionListResponse,
  SessionSummaryRow
} from "../shared/types";

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  cwd: string;
  title: string;
  tokens_used: number;
  archived: number;
  archived_at: number | null;
  cli_version: string;
  first_user_message: string;
  model: string | null;
  reasoning_effort: string | null;
}

type AnyPayload = Record<string, unknown>;

export function openStateDb(readonly = true): Database.Database {
  if (!fs.existsSync(stateDbPath)) {
    throw new Error(`Codex 목록 저장소 파일을 찾지 못했습니다: ${stateDbPath}`);
  }
  return new Database(stateDbPath, { readonly });
}

export function listThreadRows(): ThreadRow[] {
  const db = openStateDb(true);
  try {
    return db
      .prepare(
        `SELECT id, rollout_path, created_at, updated_at, source, cwd, title, tokens_used, archived,
                archived_at, cli_version, first_user_message, model, reasoning_effort
         FROM threads
         ORDER BY updated_at DESC`
      )
      .all() as ThreadRow[];
  } finally {
    db.close();
  }
}

export async function buildHistoryMap(): Promise<Map<string, string>> {
  const history = new Map<string, string>();
  await readJsonl<AnyPayload>(historyPath, ({ value }) => {
    const sessionId = typeof value.session_id === "string" ? value.session_id : "";
    const text = typeof value.text === "string" ? value.text : "";
    if (sessionId && text) history.set(sessionId, truncateText(text, 240));
  });
  return history;
}

export async function listSessions(filters: SessionFilters = {}): Promise<SessionListResponse> {
  const rows = listThreadRows();
  const history = await buildHistoryMap();
  const summaries = getSummaryMap();
  const trash = getTrashMap();
  const projects = Array.from(new Set(rows.map((row) => row.cwd).filter(Boolean))).sort();

  const allSessions = rows.map<SessionSummaryRow>((row) => {
    const stat = safeStat(row.rollout_path);
    const trashRecord = trash.get(row.id);
    return {
      id: row.id,
      title: row.title || row.first_user_message || row.id,
      firstUserMessage: row.first_user_message || "",
      cwd: row.cwd,
      source: row.source,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      cliVersion: row.cli_version,
      createdAt: toIsoFromSeconds(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: toIsoFromSeconds(row.updated_at) ?? new Date(0).toISOString(),
      archived: Boolean(row.archived),
      archivedAt: toIsoFromSeconds(row.archived_at),
      tokensUsed: row.tokens_used,
      rolloutPath: row.rollout_path,
      fileExists: Boolean(stat),
      fileSize: stat?.size ?? 0,
      lastUserMessage: history.get(row.id) ?? "",
      trashed: Boolean(trashRecord),
      trashDeletedAt: trashRecord?.deleted_at ?? null,
      summary: summaries.get(row.id) ?? null
    };
  });

  const filtered = applyFilters(allSessions, filters);

  return {
    sessions: filtered,
    totals: {
      all: allSessions.length,
      visible: filtered.length,
      archived: allSessions.filter((session) => session.archived).length,
      trashed: allSessions.filter((session) => session.trashed).length,
      missingFiles: allSessions.filter((session) => !session.fileExists).length,
      totalBytes: allSessions.reduce((sum, session) => sum + session.fileSize, 0),
      codexHome,
      appHome
    },
    projects
  };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  const list = await listSessions({ trash: "all", archive: "all" });
  const session = list.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const items: DetailItem[] = [];
  let rawLineCount = 0;

  rawLineCount = await readJsonl<AnyPayload>(session.rolloutPath, ({ line, value }) => {
    const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
    const type = typeof value.type === "string" ? value.type : "";
    const payload = isRecord(value.payload) ? value.payload : {};

    if (type === "event_msg") {
      const payloadType = typeof payload.type === "string" ? payload.type : "";
      const message = typeof payload.message === "string" ? payload.message : "";
      if (payloadType === "user_message" && message) {
        items.push({ id: `${line}`, kind: "user", label: "사용자", text: message, timestamp });
      }
      if (payloadType === "agent_message" && message) {
        items.push({ id: `${line}`, kind: "assistant", label: "Codex", text: message, timestamp });
      }
      return;
    }

    if (type === "response_item") {
      const payloadType = typeof payload.type === "string" ? payload.type : "";
      if (payloadType === "message") {
        const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : "system";
        const text = extractContentText(payload.content);
        if (text) {
          items.push({
            id: `${line}`,
            kind: role,
            label: role === "assistant" ? "Codex" : role === "user" ? "사용자" : "시스템",
            text,
            timestamp
          });
        }
      }
      if (payloadType === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        items.push({
          id: `${line}`,
          kind: "tool",
          label: `도구 호출: ${name}`,
          text: truncateText(typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {}), 900),
          timestamp
        });
      }
      if (payloadType === "function_call_output") {
        items.push({
          id: `${line}`,
          kind: "tool",
          label: "도구 결과",
          text: truncateText(String(payload.output ?? ""), 1200),
          timestamp
        });
      }
    }
  });

  return { session, items: dedupeAdjacentMessages(items), rawLineCount };
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function applyFilters(sessions: SessionSummaryRow[], filters: SessionFilters): SessionSummaryRow[] {
  const search = filters.search?.trim().toLowerCase();
  const from = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : null;
  const to = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : null;

  let next = sessions.filter((session) => {
    const updated = new Date(session.updatedAt).getTime();
    if (filters.cwd && session.cwd !== filters.cwd) return false;
    if (from && updated < from) return false;
    if (to && updated > to) return false;
    if (filters.archive === "active" && session.archived) return false;
    if (filters.archive === "archived" && !session.archived) return false;
    if (filters.trash === "normal" && session.trashed) return false;
    if (filters.trash === "trashed" && !session.trashed) return false;
    if (!search) return true;
    const haystack = `${session.title}\n${session.firstUserMessage}\n${session.lastUserMessage}\n${session.cwd}\n${session.id}`.toLowerCase();
    return haystack.includes(search);
  });

  const sort = filters.sort ?? "updatedDesc";
  next = [...next].sort((a, b) => {
    if (sort === "updatedAsc") return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    if (sort === "createdDesc") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (sort === "tokensDesc") return b.tokensUsed - a.tokensUsed;
    if (sort === "tokensAsc") return a.tokensUsed - b.tokensUsed;
    if (sort === "sizeDesc") return b.fileSize - a.fileSize;
    if (sort === "sizeAsc") return a.fileSize - b.fileSize;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  return next.slice(0, filters.limit ?? 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function dedupeAdjacentMessages(items: DetailItem[]): DetailItem[] {
  const result: DetailItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (previous && previous.kind === item.kind && previous.text === item.text) continue;
    result.push(item);
  }
  return result;
}
