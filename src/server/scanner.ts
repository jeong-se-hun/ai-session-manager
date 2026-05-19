import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getSummaryMap, getTrashMap } from "./appDb";
import { getStoragePaths } from "./config";
import { readJsonl, truncateText } from "./jsonl";
import { toIsoFromSeconds } from "./paths";
import type {
  DetailItem,
  SessionDetailResponse,
  SessionFilters,
  SessionListResponse,
  SessionSource,
  SessionSummaryRow
} from "../shared/types";

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms: number | null;
  updated_at_ms: number | null;
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

const SESSION_SOURCES: SessionSource[] = ["codex", "claude", "gemini"];
const SOURCE_LABELS: Record<SessionSource, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini"
};

export function openStateDb(readonly = true): Database.Database {
  const { stateDbPath } = getStoragePaths();
  if (!fs.existsSync(stateDbPath)) {
    throw new Error(`Codex 목록 저장소 파일을 찾지 못했습니다: ${stateDbPath}`);
  }
  return new Database(stateDbPath, { readonly });
}

export function listThreadRows(): ThreadRow[] {
  const { stateDbPath } = getStoragePaths();
  if (!fs.existsSync(stateDbPath)) return [];
  const db = openStateDb(true);
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((column) => column.name));
    const createdAtMs = columns.has("created_at_ms") ? "created_at_ms" : "created_at * 1000";
    const updatedAtMs = columns.has("updated_at_ms") ? "updated_at_ms" : "updated_at * 1000";
    return db
      .prepare(
        `SELECT id, rollout_path, created_at, updated_at,
                ${createdAtMs} AS created_at_ms, ${updatedAtMs} AS updated_at_ms,
                source, cwd, title, tokens_used, archived,
                archived_at, cli_version, first_user_message, model, reasoning_effort
         FROM threads
         ORDER BY updated_at_ms DESC, updated_at DESC`
      )
      .all() as ThreadRow[];
  } finally {
    db.close();
  }
}

export async function buildHistoryMap(): Promise<Map<string, string>> {
  const { historyPath } = getStoragePaths();
  const history = new Map<string, string>();
  await readJsonl<AnyPayload>(historyPath, ({ value }) => {
    const sessionId = typeof value.session_id === "string" ? value.session_id : "";
    const text = typeof value.text === "string" ? value.text : "";
    if (sessionId && text) history.set(sessionId, truncateText(text, 240));
  });
  return history;
}

function toIsoFromMillis(value: number | null | undefined): string | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

export async function listSessions(filters: SessionFilters = {}): Promise<SessionListResponse> {
  const paths = getStoragePaths();
  const history = await buildHistoryMap();
  const summaries = getSummaryMap();
  const trash = getTrashMap();
  const rows = listThreadRows();
  const geminiProjectRoots = readGeminiProjectRoots();

  const allSessions = [
    ...(await listCodexSessions(rows, history, summaries, trash)),
    ...(await listClaudeSessions(summaries, trash)),
    ...listGeminiSessions(geminiProjectRoots, summaries, trash)
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

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
      sources: buildSourceTotals(allSessions, filtered),
      codexHome: paths.codexHome,
      claudeHome: paths.claudeHome,
      geminiHome: paths.geminiHome,
      appHome: paths.appHome
    },
    projects: buildProjectOptions(allSessions, filters)
  };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  const list = await listSessions({ trash: "all", archive: "all", source: "all", limit: 100000 });
  const session = list.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const { items, rawLineCount } =
    session.source === "claude"
      ? await parseClaudeDetail(session.rolloutPath)
      : session.source === "gemini"
        ? parseGeminiDetail(session.rolloutPath)
        : await parseCodexDetail(session.rolloutPath);

  return { session, items: dedupeAdjacentMessages(items), rawLineCount };
}

async function listCodexSessions(
  rows: ThreadRow[],
  history: Map<string, string>,
  summaries: Map<string, string>,
  trash: Map<string, { deleted_at: string }>
): Promise<SessionSummaryRow[]> {
  const sessions: SessionSummaryRow[] = [];
  const rowIds = new Set(rows.map((row) => row.id));
  const rowPaths = new Set(rows.map((row) => row.rollout_path));

  for (const row of rows) {
    const stat = safeStat(row.rollout_path);
    const trashRecord = trash.get(row.id);
    const fallbackMeta = stat && !history.has(row.id) ? await readCodexSessionMeta(row.rollout_path, stat) : null;
    sessions.push({
      id: row.id,
      title: row.title || row.first_user_message || row.id,
      firstUserMessage: row.first_user_message || "",
      cwd: row.cwd,
      source: "codex",
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      cliVersion: row.cli_version,
      createdAt: toIsoFromMillis(row.created_at_ms) ?? toIsoFromSeconds(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: toIsoFromMillis(row.updated_at_ms) ?? toIsoFromSeconds(row.updated_at) ?? new Date(0).toISOString(),
      archived: Boolean(row.archived),
      archivedAt: toIsoFromSeconds(row.archived_at),
      tokensUsed: row.tokens_used,
      rolloutPath: row.rollout_path,
      fileExists: Boolean(stat),
      fileSize: stat?.size ?? 0,
      lastUserMessage: history.get(row.id) ?? fallbackMeta?.lastUserMessage ?? "",
      trashed: Boolean(trashRecord),
      trashDeletedAt: trashRecord?.deleted_at ?? null,
      summary: summaries.get(row.id) ?? null
    });
  }

  const orphanFiles = collectCodexRolloutFiles().filter((filePath) => !rowPaths.has(filePath));
  for (const filePath of orphanFiles) {
    const stat = safeStat(filePath);
    if (!stat) continue;
    const meta = await readCodexSessionMeta(filePath, stat);
    if (rowIds.has(meta.id)) continue;
    const trashRecord = trash.get(meta.id);
    sessions.push({
      id: meta.id,
      title: meta.title,
      firstUserMessage: meta.firstUserMessage,
      cwd: meta.cwd,
      source: "codex",
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      cliVersion: meta.cliVersion,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: false,
      archivedAt: null,
      tokensUsed: meta.tokensUsed,
      rolloutPath: filePath,
      fileExists: true,
      fileSize: stat.size,
      lastUserMessage: meta.lastUserMessage,
      trashed: Boolean(trashRecord),
      trashDeletedAt: trashRecord?.deleted_at ?? null,
      summary: summaries.get(meta.id) ?? null
    });
  }

  return sessions;
}

async function listClaudeSessions(
  summaries: Map<string, string>,
  trash: Map<string, { deleted_at: string }>
): Promise<SessionSummaryRow[]> {
  const { claudeProjectsRoot, claudeTranscriptsRoot } = getStoragePaths();
  const files = [
    ...collectFiles(claudeTranscriptsRoot, (filePath, entry) => entry.isFile() && filePath.endsWith(".jsonl")),
    ...collectFiles(
      claudeProjectsRoot,
      (filePath, entry) => entry.isFile() && filePath.endsWith(".jsonl") && path.dirname(path.dirname(filePath)) === claudeProjectsRoot
    )
  ];
  const sessions: SessionSummaryRow[] = [];

  for (const filePath of files) {
    const stat = safeStat(filePath);
    if (!stat) continue;
    const nativeId = path.basename(filePath, ".jsonl");
    const id = getClaudeSessionId(filePath);
    const meta = await readClaudeSessionMeta(filePath, stat);
    const relatedSize = getClaudeRelatedSize(filePath);
    const trashRecord = trash.get(id);
    sessions.push({
      id,
      title: meta.title || nativeId,
      firstUserMessage: meta.firstUserMessage,
      cwd: meta.cwd || inferClaudeProjectPath(filePath),
      source: "claude",
      model: meta.model,
      reasoningEffort: null,
      cliVersion: "",
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: false,
      archivedAt: null,
      tokensUsed: meta.tokensUsed,
      rolloutPath: filePath,
      fileExists: true,
      fileSize: stat.size + relatedSize,
      lastUserMessage: meta.lastUserMessage,
      trashed: Boolean(trashRecord),
      trashDeletedAt: trashRecord?.deleted_at ?? null,
      summary: summaries.get(id) ?? null
    });
  }

  return sessions;
}

function listGeminiSessions(
  projectRoots: Map<string, string>,
  summaries: Map<string, string>,
  trash: Map<string, { deleted_at: string }>
): SessionSummaryRow[] {
  const { geminiTmpRoot } = getStoragePaths();
  const files = collectFiles(
    geminiTmpRoot,
    (filePath, entry) =>
      entry.isFile() && path.basename(path.dirname(filePath)) === "chats" && (filePath.endsWith(".json") || filePath.endsWith(".jsonl"))
  );

  return files.flatMap((filePath) => {
    const stat = safeStat(filePath);
    const conversation = readGeminiConversation(filePath);
    if (!stat || !conversation) return [];

    const projectKey = getGeminiProjectKey(filePath);
    const sessionId = typeof conversation.raw.sessionId === "string" ? conversation.raw.sessionId : getSessionFileBaseName(filePath);
    const id = `gemini:${getGeminiFileKey(filePath)}`;
    const meta = readGeminiSessionMeta(conversation.raw, conversation.messages, stat);
    const trashRecord = trash.get(id);

    return [
      {
        id,
        title: meta.title || sessionId,
        firstUserMessage: meta.firstUserMessage,
        cwd: projectRoots.get(projectKey) ?? path.join(geminiTmpRoot, projectKey),
        source: "gemini" as const,
        model: meta.model,
        reasoningEffort: null,
        cliVersion: "",
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        archived: false,
        archivedAt: null,
        tokensUsed: meta.tokensUsed,
        rolloutPath: filePath,
        fileExists: true,
        fileSize: stat.size,
        lastUserMessage: meta.lastUserMessage,
        trashed: Boolean(trashRecord),
        trashDeletedAt: trashRecord?.deleted_at ?? null,
        summary: summaries.get(id) ?? null
      }
    ];
  });
}

async function parseCodexDetail(filePath: string): Promise<{ items: DetailItem[]; rawLineCount: number }> {
  const items: DetailItem[] = [];
  const rawLineCount = await readJsonl<AnyPayload>(filePath, ({ line, value }) => {
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
      if (payloadType === "web_search_end") {
        items.push({
          id: `${line}`,
          kind: "tool",
          label: "웹 검색 완료",
          text: truncateText(extractAnyText(payload) || "웹 검색이 완료되었습니다.", 900),
          timestamp
        });
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
      if (payloadType === "web_search_call") {
        items.push({
          id: `${line}`,
          kind: "tool",
          label: "도구 호출: web_search",
          text: truncateText(extractAnyText(payload.action) || JSON.stringify(payload), 900),
          timestamp
        });
      }
      if (payloadType === "reasoning") {
        const summary = extractAnyText(payload.summary);
        if (summary) {
          items.push({
            id: `${line}`,
            kind: "system",
            label: "추론 요약",
            text: truncateText(summary, 900),
            timestamp
          });
        }
      }
      return;
    }

  });

  return { items, rawLineCount };
}

async function readCodexSessionMeta(filePath: string, stat: fs.Stats): Promise<{
  id: string;
  title: string;
  firstUserMessage: string;
  lastUserMessage: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  cliVersion: string;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}> {
  let id = getCodexSessionIdFromPath(filePath);
  let firstUserMessage = "";
  let lastUserMessage = "";
  let cwd = "";
  let model: string | null = null;
  let reasoningEffort: string | null = null;
  let cliVersion = "";
  let tokensUsed = 0;
  let firstTimestampMs: number | null = null;
  let lastTimestampMs: number | null = null;

  await readJsonl<AnyPayload>(filePath, ({ value }) => {
    updateTimestampBounds(value.timestamp, (next) => {
      firstTimestampMs = firstTimestampMs === null ? next : Math.min(firstTimestampMs, next);
      lastTimestampMs = lastTimestampMs === null ? next : Math.max(lastTimestampMs, next);
    });

    const type = typeof value.type === "string" ? value.type : "";
    const payload = isRecord(value.payload) ? value.payload : {};
    if (type === "session_meta") {
      if (typeof payload.id === "string") id = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.cli_version === "string") cliVersion = payload.cli_version;
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.reasoning_effort === "string") reasoningEffort = payload.reasoning_effort;
    }

    tokensUsed = Math.max(
      tokensUsed,
      extractTokenTotal(value.tokens),
      extractTokenTotal(value.usage),
      extractTokenTotal(payload.tokens),
      extractTokenTotal(payload.usage)
    );

    const userText = extractCodexUserText(value);
    if (userText && !isTechnicalContextText(userText)) {
      if (!firstUserMessage) firstUserMessage = truncateText(userText, 240);
      lastUserMessage = truncateText(userText, 240);
    }
  });

  return {
    id,
    title: firstUserMessage || id,
    firstUserMessage,
    lastUserMessage,
    cwd,
    model,
    reasoningEffort,
    cliVersion,
    tokensUsed,
    createdAt: toIsoFromMillis(firstTimestampMs) ?? stat.birthtime.toISOString(),
    updatedAt: toIsoFromMillis(lastTimestampMs) ?? stat.mtime.toISOString()
  };
}

function extractCodexUserText(value: AnyPayload): string {
  const type = typeof value.type === "string" ? value.type : "";
  const payload = isRecord(value.payload) ? value.payload : {};
  if (type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
    return payload.message.trim();
  }
  if (type === "response_item" && payload.type === "message" && payload.role === "user") {
    return extractContentText(payload.content);
  }
  return "";
}

async function parseClaudeDetail(filePath: string): Promise<{ items: DetailItem[]; rawLineCount: number }> {
  const items: DetailItem[] = [];
  const rawLineCount = await readJsonl<AnyPayload>(filePath, ({ line, value }) => {
    const type = typeof value.type === "string" ? value.type : "";
    const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
    const role = isRecord(value.message) && typeof value.message.role === "string" ? value.message.role : "";
    const messageContent = isRecord(value.message) ? value.message.content : undefined;

    if (type === "user" || type === "assistant" || role === "user" || role === "assistant") {
      const messageRole = role || type;
      const text = extractMessageText(messageContent ?? value.content);
      if (text) {
        items.push({
          id: `${line}`,
          kind: messageRole === "assistant" ? "assistant" : "user",
          label: messageRole === "assistant" ? "Claude" : "사용자",
          text,
          timestamp
        });
      }
      const toolText = extractClaudeToolText(messageContent);
      if (toolText) {
        items.push({
          id: `${line}-tool`,
          kind: "tool",
          label: messageRole === "assistant" ? "도구 호출" : "도구 결과",
          text: toolText,
          timestamp
        });
      }
      return;
    }

    if (type === "tool_use") {
      const name = typeof value.tool_name === "string" ? value.tool_name : "tool";
      items.push({
        id: `${line}`,
        kind: "tool",
        label: `도구 호출: ${name}`,
        text: truncateText(extractAnyText(value.tool_input) || JSON.stringify(value.tool_input ?? {}), 900),
        timestamp
      });
      return;
    }

    if (type === "tool_result") {
      items.push({
        id: `${line}`,
        kind: "tool",
        label: "도구 결과",
        text: truncateText(extractAnyText(value.tool_output) || JSON.stringify(value.tool_output ?? {}), 1200),
        timestamp
      });
    }
  });

  return { items, rawLineCount };
}

function parseGeminiDetail(filePath: string): { items: DetailItem[]; rawLineCount: number } {
  const conversation = readGeminiConversation(filePath);
  if (!conversation) return { items: [], rawLineCount: 0 };
  const items: DetailItem[] = [];

  conversation.messages.forEach((message, index) => {
    const type = getGeminiMessageType(message);
    const timestamp = typeof message.timestamp === "string" ? message.timestamp : null;
    const text = extractGeminiMessageText(message);
    if (type === "user" && text) {
      items.push({ id: `${index}`, kind: "user", label: "사용자", text, timestamp });
    } else if ((type === "gemini" || type === "assistant" || type === "model") && text) {
      items.push({ id: `${index}`, kind: "assistant", label: "Gemini", text, timestamp });
    }

    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      message.toolCalls.forEach((toolCall, toolIndex) => {
        if (!isRecord(toolCall)) return;
        const functionCall = isRecord(toolCall.functionCall) ? toolCall.functionCall : null;
        const functionResponse = isRecord(toolCall.functionResponse) ? toolCall.functionResponse : null;
        const name =
          (functionCall && typeof functionCall.name === "string" ? functionCall.name : "") ||
          (functionResponse && typeof functionResponse.name === "string" ? functionResponse.name : "") ||
          "tool";
        items.push({
          id: `${index}-tool-${toolIndex}`,
          kind: "tool",
          label: functionResponse ? `도구 결과: ${name}` : `도구 호출: ${name}`,
          text: truncateText(
            extractAnyText(functionResponse?.response) ||
              extractAnyText(functionCall?.args) ||
              extractAnyText(toolCall) ||
              JSON.stringify(toolCall),
            1200
          ),
          timestamp
        });
      });
    }
  });

  return { items, rawLineCount: conversation.rawLineCount };
}

async function readClaudeSessionMeta(filePath: string, stat: fs.Stats): Promise<{
  title: string;
  firstUserMessage: string;
  lastUserMessage: string;
  model: string | null;
  tokensUsed: number;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}> {
  let firstUserMessage = "";
  let lastUserMessage = "";
  let firstTimestampMs: number | null = null;
  let lastTimestampMs: number | null = null;
  let model: string | null = null;
  let cwd = "";
  let legacyTokensUsed = 0;
  const usageTokensByKey = new Map<string, number>();

  await readJsonl<AnyPayload>(filePath, ({ value }) => {
    const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
    updateTimestampBounds(timestamp, (next) => {
      firstTimestampMs = firstTimestampMs === null ? next : Math.min(firstTimestampMs, next);
      lastTimestampMs = lastTimestampMs === null ? next : Math.max(lastTimestampMs, next);
    });
    if (typeof value.model === "string") model = value.model;
    if (!cwd && typeof value.cwd === "string") cwd = value.cwd;
    if (!model && isRecord(value.message) && typeof value.message.model === "string") model = value.message.model;
    legacyTokensUsed = Math.max(legacyTokensUsed, extractTokenTotal(value.tokens));

    const usageTotal = extractTokenTotal(extractClaudeUsage(value));
    if (usageTotal > 0) {
      const usageKey = getClaudeUsageKey(value) ?? `${timestamp ?? "unknown"}:${usageTotal}:${usageTokensByKey.size}`;
      usageTokensByKey.set(usageKey, Math.max(usageTokensByKey.get(usageKey) ?? 0, usageTotal));
    }

    const role = isRecord(value.message) && typeof value.message.role === "string" ? value.message.role : "";
    if (value.type === "user" || role === "user") {
      const text = extractMessageText(isRecord(value.message) ? value.message.content : value.content);
      if (isUsefulClaudeUserText(text, value)) {
        if (!firstUserMessage) firstUserMessage = truncateText(text, 240);
        lastUserMessage = truncateText(text, 240);
      }
    }
  });

  return {
    title: firstUserMessage || path.basename(filePath, ".jsonl"),
    firstUserMessage,
    lastUserMessage,
    model,
    tokensUsed: Math.max(legacyTokensUsed, [...usageTokensByKey.values()].reduce((sum, value) => sum + value, 0)),
    cwd,
    createdAt: toIsoFromMillis(firstTimestampMs) ?? stat.birthtime.toISOString(),
    updatedAt: toIsoFromMillis(lastTimestampMs) ?? stat.mtime.toISOString()
  };
}

function readGeminiSessionMeta(
  raw: Record<string, unknown>,
  messages: Record<string, unknown>[],
  stat: fs.Stats
): {
  title: string;
  firstUserMessage: string;
  lastUserMessage: string;
  model: string | null;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
} {
  let firstUserMessage = "";
  let lastUserMessage = "";
  let model: string | null = null;
  let tokensUsed = 0;
  let firstTimestampMs: number | null = null;
  let lastTimestampMs: number | null = null;

  updateTimestampBounds(raw.startTime, (next) => {
    firstTimestampMs = firstTimestampMs === null ? next : Math.min(firstTimestampMs, next);
  });
  updateTimestampBounds(raw.lastUpdated, (next) => {
    lastTimestampMs = lastTimestampMs === null ? next : Math.max(lastTimestampMs, next);
  });

  for (const message of messages) {
    if (typeof message.model === "string") model = message.model;
    if (!model && typeof message.modelVersion === "string") model = message.modelVersion;
    tokensUsed += extractTokenTotal(message.tokens);
    tokensUsed += extractTokenTotal(message.usage);
    updateTimestampBounds(message.timestamp, (next) => {
      firstTimestampMs = firstTimestampMs === null ? next : Math.min(firstTimestampMs, next);
      lastTimestampMs = lastTimestampMs === null ? next : Math.max(lastTimestampMs, next);
    });
    if (getGeminiMessageType(message) === "user") {
      const text = extractGeminiMessageText(message);
      if (text) {
        if (!firstUserMessage) firstUserMessage = truncateText(text, 240);
        lastUserMessage = truncateText(text, 240);
      }
    }
  }

  return {
    title: firstUserMessage,
    firstUserMessage,
    lastUserMessage,
    model,
    tokensUsed,
    createdAt: toIsoFromMillis(firstTimestampMs) ?? stat.birthtime.toISOString(),
    updatedAt: toIsoFromMillis(lastTimestampMs) ?? stat.mtime.toISOString()
  };
}

function readGeminiConversation(filePath: string): {
  raw: Record<string, unknown>;
  messages: Record<string, unknown>[];
  rawLineCount: number;
} | null {
  if (filePath.endsWith(".jsonl")) return readGeminiJsonlConversation(filePath);
  const raw = safeReadJson(filePath);
  if (!isRecord(raw)) return null;
  const messages = Array.isArray(raw.messages) ? raw.messages.filter(isRecord) : [];
  return { raw, messages, rawLineCount: messages.length };
}

function readGeminiJsonlConversation(filePath: string): {
  raw: Record<string, unknown>;
  messages: Record<string, unknown>[];
  rawLineCount: number;
} | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }

  const raw: Record<string, unknown> = {};
  const messages: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    mergeGeminiSessionFields(raw, value);
    if (Array.isArray(value.messages)) {
      messages.push(...value.messages.filter(isRecord));
      continue;
    }
    if (looksLikeGeminiMessage(value)) messages.push(value);
  }

  return { raw, messages, rawLineCount: lines.length };
}

function mergeGeminiSessionFields(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const key of ["sessionId", "model", "modelVersion", "startTime"] as const) {
    if (target[key] === undefined && value[key] !== undefined) target[key] = value[key];
  }
  if (value.lastUpdated !== undefined) target.lastUpdated = value.lastUpdated;
  if (target.startTime === undefined && value.timestamp !== undefined) target.startTime = value.timestamp;
  if (value.timestamp !== undefined) target.lastUpdated = value.timestamp;
}

function looksLikeGeminiMessage(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === "string" ||
    typeof value.role === "string" ||
    value.content !== undefined ||
    value.parts !== undefined ||
    value.text !== undefined ||
    value.usage !== undefined ||
    value.tokens !== undefined
  );
}

function getGeminiMessageType(message: Record<string, unknown>): string {
  const explicit = typeof message.type === "string" ? message.type : "";
  const role = typeof message.role === "string" ? message.role : "";
  if (explicit === "user" || role === "user") return "user";
  if (explicit === "gemini" || explicit === "assistant" || explicit === "model" || role === "model" || role === "assistant") return explicit || role;
  return explicit || role;
}

function extractGeminiMessageText(message: Record<string, unknown>): string {
  return extractAnyText(message.content) || extractAnyText(message.parts) || extractAnyText(message.text);
}

function readGeminiProjectRoots(): Map<string, string> {
  const { geminiHistoryRoot } = getStoragePaths();
  const result = new Map<string, string>();
  if (!fs.existsSync(geminiHistoryRoot)) return result;
  for (const entry of safeReadDir(geminiHistoryRoot)) {
    if (!entry.isDirectory()) continue;
    const marker = path.join(geminiHistoryRoot, entry.name, ".project_root");
    try {
      const value = fs.readFileSync(marker, "utf8").trim();
      if (value) result.set(entry.name, value);
    } catch {
      // Project root markers are optional.
    }
  }
  return result;
}

function buildProjectOptions(sessions: SessionSummaryRow[], filters: SessionFilters): string[] {
  return Array.from(
    new Set(
      sessions
        .filter((session) => !filters.source || filters.source === "all" || session.source === filters.source)
        .map((session) => session.cwd)
        .filter(Boolean)
    )
  ).sort();
}

function buildSourceTotals(
  allSessions: SessionSummaryRow[],
  filtered: SessionSummaryRow[]
): SessionListResponse["totals"]["sources"] {
  return Object.fromEntries(
    SESSION_SOURCES.map((source) => {
      const all = allSessions.filter((session) => session.source === source);
      const visible = filtered.filter((session) => session.source === source);
      return [
        source,
        {
          all: all.length,
          visible: visible.length,
          trashed: all.filter((session) => session.trashed).length,
          totalBytes: all.reduce((sum, session) => sum + session.fileSize, 0)
        }
      ];
    })
  ) as SessionListResponse["totals"]["sources"];
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadDir(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function collectFiles(root: string, predicate: (filePath: string, entry: fs.Dirent) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of safeReadDir(current)) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (predicate(next, entry)) result.push(next);
    }
  }
  return result.sort();
}

function collectCodexRolloutFiles(): string[] {
  const { sessionsRoot } = getStoragePaths();
  return collectFiles(sessionsRoot, (filePath, entry) => {
    return entry.isFile() && path.basename(filePath).startsWith("rollout-") && filePath.endsWith(".jsonl");
  });
}

function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getClaudeRelatedSize(filePath: string): number {
  const relatedDir = getClaudeRelatedDir(filePath);
  if (!relatedDir || !fs.existsSync(relatedDir)) return 0;
  return collectFiles(relatedDir, (_filePath, entry) => entry.isFile()).reduce((sum, relatedPath) => {
    return sum + (safeStat(relatedPath)?.size ?? 0);
  }, 0);
}

function getClaudeRelatedDir(filePath: string): string | null {
  const { claudeProjectsRoot } = getStoragePaths();
  if (!isInsidePath(claudeProjectsRoot, filePath)) return null;
  if (path.dirname(path.dirname(filePath)) !== claudeProjectsRoot) return null;
  return path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"));
}

function getGeminiProjectKey(filePath: string): string {
  const { geminiTmpRoot } = getStoragePaths();
  const relative = path.relative(geminiTmpRoot, filePath);
  return relative.split(path.sep)[0] || "unknown";
}

function getGeminiFileKey(filePath: string): string {
  const { geminiTmpRoot } = getStoragePaths();
  const withoutExtension = path.relative(geminiTmpRoot, filePath).replace(/\.jsonl?$/, "");
  return withoutExtension
    .split(path.sep)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .join(":");
}

function getSessionFileBaseName(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl?$/, "");
}

function getClaudeSessionId(filePath: string): string {
  const { claudeProjectsRoot, claudeTranscriptsRoot } = getStoragePaths();
  if (isInsidePath(claudeTranscriptsRoot, filePath)) return `claude:${path.basename(filePath, ".jsonl")}`;
  const relative = path.relative(claudeProjectsRoot, filePath).replace(/\.jsonl$/, "");
  return `claude:project:${relative
    .split(path.sep)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .join(":")}`;
}

function getCodexSessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? base.replace(/^rollout-/, "");
}

function inferClaudeProjectPath(filePath: string): string {
  const { claudeProjectsRoot, claudeTranscriptsRoot } = getStoragePaths();
  if (isInsidePath(claudeTranscriptsRoot, filePath)) return claudeTranscriptsRoot;
  const projectSlug = path.relative(claudeProjectsRoot, filePath).split(path.sep)[0];
  if (!projectSlug) return claudeProjectsRoot;
  return projectSlug.startsWith("-") ? `/${projectSlug.slice(1).replace(/-/g, "/")}` : path.join(claudeProjectsRoot, projectSlug);
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function updateTimestampBounds(value: unknown, onTimestamp: (timestampMs: number) => void): void {
  if (typeof value !== "string") return;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) onTimestamp(parsed);
}

function isTechnicalContextText(value: string): boolean {
  const clean = value.trim();
  return (
    clean.startsWith("<environment_context>") ||
    clean.startsWith("<developer_context>") ||
    clean.startsWith("<permissions instructions>") ||
    clean.startsWith("<skills_instructions>") ||
    clean.startsWith("<apps_instructions>") ||
    clean.startsWith("<plugins_instructions>") ||
    clean.startsWith("# AGENTS.md instructions") ||
    clean.includes("Knowledge cutoff:") ||
    clean.includes("Current date:")
  );
}

function applyFilters(sessions: SessionSummaryRow[], filters: SessionFilters): SessionSummaryRow[] {
  const search = filters.search?.trim().toLowerCase();
  const from = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : null;
  const to = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : null;

  let next = sessions.filter((session) => {
    const updated = new Date(session.updatedAt).getTime();
    if (filters.source && filters.source !== "all" && session.source !== filters.source) return false;
    if (filters.cwd && session.cwd !== filters.cwd) return false;
    if (from && updated < from) return false;
    if (to && updated > to) return false;
    if (filters.archive === "active" && session.archived) return false;
    if (filters.archive === "archived" && !session.archived) return false;
    if (filters.trash === "normal" && session.trashed) return false;
    if (filters.trash === "trashed" && !session.trashed) return false;
    if (!search) return true;
    const haystack =
      `${session.title}\n${session.firstUserMessage}\n${session.lastUserMessage}\n${session.cwd}\n${session.id}\n${SOURCE_LABELS[session.source]}`.toLowerCase();
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

  return next.slice(0, filters.limit ?? 100000);
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

function extractAnyText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractAnyText(item))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return value.content.trim();
    if (Array.isArray(value.content)) return extractAnyText(value.content);
    return JSON.stringify(value);
  }
  return "";
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return extractAnyText(value);
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string" && item.type !== "tool_result") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractClaudeToolText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const toolItems = value
    .filter((item) => isRecord(item) && (item.type === "tool_use" || item.type === "tool_result"))
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "tool_use") {
        const name = typeof item.name === "string" ? item.name : "tool";
        return `${name} ${truncateText(JSON.stringify(item.input ?? {}), 700)}`;
      }
      return truncateText(extractAnyText(item.content) || JSON.stringify(item), 900);
    })
    .filter(Boolean);
  return toolItems.join("\n\n");
}

function extractClaudeUsage(value: AnyPayload): unknown {
  if (isRecord(value.message) && isRecord(value.message.usage)) return value.message.usage;
  if (isRecord(value.usage)) return value.usage;
  return null;
}

function getClaudeUsageKey(value: AnyPayload): string | null {
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const messageId = isRecord(value.message) && typeof value.message.id === "string" ? value.message.id : "";
  const id = [requestId, messageId].filter(Boolean).join(":");
  return id || null;
}

function isUsefulClaudeUserText(text: string, value: AnyPayload): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (value.isMeta === true) return false;
  if (clean.startsWith("<local-command-caveat>")) return false;
  if (clean.startsWith("<command-name>")) return false;
  if (clean.startsWith("<command-message>")) return false;
  if (clean.startsWith("<command-args>")) return false;
  if (clean.startsWith("<local-command-stdout>")) return false;
  if (clean.startsWith("<local-command-stderr>")) return false;
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean) as Record<string, unknown>;
      if (parsed.type === "tool_result" || parsed.type === "tool_use") return false;
      if (typeof parsed.tool_use_id === "string") return false;
    } catch {
      return true;
    }
  }
  return true;
}

function extractTokenTotal(value: unknown): number {
  if (!isRecord(value)) return 0;
  const explicitTotal = firstFiniteNumber(value.total, value.total_tokens, value.totalTokens, value.totalTokenCount);
  if (explicitTotal > 0) return explicitTotal;

  const topLevelTotal = sumFiniteNumbers(
    value.input_tokens,
    value.output_tokens,
    value.cache_creation_input_tokens,
    value.cache_read_input_tokens,
    value.input,
    value.output,
    value.cached,
    value.thoughts,
    value.tool,
    value.prompt_tokens,
    value.completion_tokens,
    value.promptTokenCount,
    value.candidatesTokenCount,
    value.thoughtsTokenCount,
    value.toolUsePromptTokenCount
  );
  if (topLevelTotal > 0) return topLevelTotal;

  if (isRecord(value.cache_creation)) {
    return sumFiniteNumbers(value.cache_creation.ephemeral_1h_input_tokens, value.cache_creation.ephemeral_5m_input_tokens);
  }
  return 0;
}

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function sumFiniteNumbers(...values: unknown[]): number {
  let sum = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) sum += value;
  }
  return sum;
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
