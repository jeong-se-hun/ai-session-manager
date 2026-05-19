import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeHome = process.env.CLAUDE_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalGeminiHome = process.env.GEMINI_HOME;
const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;
const originalAppHome = process.env.CODEX_SESSION_MANAGER_HOME;

afterEach(() => {
  vi.resetModules();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = originalClaudeHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalGeminiHome === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = originalGeminiHome;
  if (originalGeminiCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = originalGeminiCliHome;
  if (originalAppHome === undefined) delete process.env.CODEX_SESSION_MANAGER_HOME;
  else process.env.CODEX_SESSION_MANAGER_HOME = originalAppHome;
});

describe("setup path discovery", () => {
  it("detects usable Codex, Claude, and Gemini homes from the configured defaults", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-detect-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "setup-app-"));
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude");
    const geminiHome = path.join(root, "gemini");
    createCodexFixture(codexHome, "detect-thread");
    createClaudeFixture(claudeHome, "detect_claude");
    createGeminiFixture(geminiHome, "detect-gemini");
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.GEMINI_HOME = geminiHome;
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const { browseSetupDirectory, getSetupState } = await import("./setup");
    const state = getSetupState();

    expect(state.completed).toBe(false);
    expect(state.sources.codex.candidates.find((candidate) => candidate.path === codexHome)).toMatchObject({
      status: "ready",
      confidence: "high",
      sessionCount: 1,
      recommended: true
    });
    expect(state.sources.claude.candidates.find((candidate) => candidate.path === claudeHome)).toMatchObject({
      status: "ready",
      confidence: "medium",
      sessionCount: 1,
      recommended: true
    });
    expect(state.sources.gemini.candidates.find((candidate) => candidate.path === geminiHome)).toMatchObject({
      status: "ready",
      confidence: "high",
      sessionCount: 1,
      recommended: true
    });

    const browse = browseSetupDirectory("codex", root);
    expect(browse.currentPath).toBe(root);
    expect(browse.entries.map((entry) => entry.name)).toContain("codex");
    expect(browse.candidate.status).toBe("missing");

    const codexBrowse = browseSetupDirectory("codex", codexHome);
    expect(codexBrowse.candidate).toMatchObject({ status: "ready", sessionCount: 1 });
  });

  it("persists selected homes and listSessions reads from those paths without restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-save-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "setup-app-"));
    const emptyCodexHome = path.join(root, "empty-codex");
    const emptyClaudeHome = path.join(root, "empty-claude");
    const emptyGeminiHome = path.join(root, "empty-gemini");
    const selectedCodexHome = path.join(root, "selected-codex");
    const selectedClaudeHome = path.join(root, "selected-claude");
    const selectedGeminiHome = path.join(root, "selected-gemini");
    fs.mkdirSync(emptyCodexHome, { recursive: true });
    fs.mkdirSync(emptyClaudeHome, { recursive: true });
    fs.mkdirSync(emptyGeminiHome, { recursive: true });
    createCodexFixture(selectedCodexHome, "selected-thread");
    createClaudeFixture(selectedClaudeHome, "selected_claude");
    createGeminiFixture(selectedGeminiHome, "selected-gemini");
    process.env.CODEX_HOME = emptyCodexHome;
    process.env.CLAUDE_HOME = emptyClaudeHome;
    process.env.GEMINI_HOME = emptyGeminiHome;
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const setup = await import("./setup");
    const scanner = await import("./scanner");
    expect((await scanner.listSessions({ source: "all", trash: "all", archive: "all" })).totals.all).toBe(0);

    const saved = setup.saveSetupState({
      codexHome: selectedCodexHome,
      claudeHome: selectedClaudeHome,
      geminiHome: selectedGeminiHome,
      completed: true
    });
    expect(saved.completed).toBe(true);

    const list = await scanner.listSessions({ source: "all", trash: "all", archive: "all", sort: "updatedDesc" });
    expect(list.totals.sources.codex.all).toBe(1);
    expect(list.totals.sources.claude.all).toBe(1);
    expect(list.totals.sources.gemini.all).toBe(1);
    expect(list.sessions.map((session) => session.id).sort()).toEqual([
      "claude:selected_claude",
      "gemini:proj:chats:session-selected",
      "selected-thread"
    ]);
  });

  it("uses Claude and Gemini CLI config env vars when direct home env vars are absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-env-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "setup-app-"));
    const codexHome = path.join(root, "codex");
    const claudeHome = path.join(root, "claude-config");
    const geminiHome = path.join(root, "gemini-cli");
    createCodexFixture(codexHome, "env-thread");
    createClaudeFixture(claudeHome, "env_claude");
    createGeminiFixture(geminiHome, "env-gemini");
    process.env.CODEX_HOME = codexHome;
    delete process.env.CLAUDE_HOME;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    delete process.env.GEMINI_HOME;
    process.env.GEMINI_CLI_HOME = geminiHome;
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const { getSetupState } = await import("./setup");
    const state = getSetupState();

    expect(state.sources.claude.envPath).toBe(claudeHome);
    expect(state.sources.gemini.envPath).toBe(geminiHome);
    expect(state.sources.claude.candidates.find((candidate) => candidate.path === claudeHome)).toMatchObject({
      status: "ready",
      recommended: true
    });
    expect(state.sources.gemini.candidates.find((candidate) => candidate.path === geminiHome)).toMatchObject({
      status: "ready",
      recommended: true
    });
  });

  it("lists Gemini JSONL chat files as sessions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-gemini-jsonl-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "setup-app-"));
    const geminiHome = path.join(root, "gemini");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.CLAUDE_HOME = path.join(root, "claude");
    process.env.GEMINI_HOME = geminiHome;
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    createGeminiJsonlFixture(geminiHome);
    vi.resetModules();

    const scanner = await import("./scanner");
    const list = await scanner.listSessions({ source: "gemini", trash: "all", archive: "all" });

    expect(list.totals.sources.gemini.all).toBe(1);
    expect(list.sessions[0]).toMatchObject({
      id: "gemini:proj:chats:session-jsonl",
      title: "Gemini JSONL 테스트",
      firstUserMessage: "Gemini JSONL 테스트",
      tokensUsed: 5
    });
  });
});

function createCodexFixture(root: string, sessionId: string): void {
  const rolloutDir = path.join(root, "sessions", "2026", "01", "01");
  const rolloutPath = path.join(rolloutDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "설정 테스트" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "완료" } })
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "history.jsonl"), JSON.stringify({ session_id: sessionId, text: "설정 테스트" }) + "\n", "utf8");

  const db = new Database(path.join(root, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      archived_at INTEGER,
      cli_version TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT
    );
  `);
  db
    .prepare(
      `INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, cwd, title, tokens_used, archived, archived_at, cli_version, first_user_message, model, reasoning_effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, rolloutPath, 1, 1, "cli", "/tmp/setup", "설정 테스트", 10, 0, null, "test", "설정 테스트", null, null);
  db.close();
}

function createClaudeFixture(root: string, nativeId: string): void {
  const dir = path.join(root, "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${nativeId}.jsonl`),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", content: "Claude 설정 테스트" }),
    "utf8"
  );
}

function createGeminiFixture(root: string, _nativeId: string): void {
  const markerDir = path.join(root, "history", "proj");
  const chatDir = path.join(root, "tmp", "proj", "chats");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, ".project_root"), "/tmp/setup-gemini", "utf8");
  fs.writeFileSync(
    path.join(chatDir, "session-selected.json"),
    JSON.stringify({
      sessionId: "selected-gemini",
      startTime: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:01.000Z",
      messages: [{ type: "user", timestamp: "2026-01-01T00:00:00.000Z", content: [{ text: "Gemini 설정 테스트" }] }]
    }),
    "utf8"
  );
}

function createGeminiJsonlFixture(root: string): void {
  const markerDir = path.join(root, "history", "proj");
  const chatDir = path.join(root, "tmp", "proj", "chats");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, ".project_root"), "/tmp/setup-gemini-jsonl", "utf8");
  fs.writeFileSync(
    path.join(chatDir, "session-jsonl.jsonl"),
    [
      JSON.stringify({
        sessionId: "session-jsonl",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: [{ text: "Gemini JSONL 테스트" }]
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        content: [{ text: "완료" }],
        usage: { promptTokenCount: 2, candidatesTokenCount: 3 }
      })
    ].join("\n") + "\n",
    "utf8"
  );
}
