import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeHome = process.env.CLAUDE_HOME;
const originalGeminiHome = process.env.GEMINI_HOME;
const originalAppHome = process.env.CODEX_SESSION_MANAGER_HOME;
const originalCodexCliPath = process.env.CODEX_CLI_PATH;
const originalCodexSummaryTimeout = process.env.CODEX_SUMMARY_TIMEOUT_MS;

afterEach(() => {
  vi.resetModules();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = originalClaudeHome;
  if (originalGeminiHome === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = originalGeminiHome;
  if (originalAppHome === undefined) delete process.env.CODEX_SESSION_MANAGER_HOME;
  else process.env.CODEX_SESSION_MANAGER_HOME = originalAppHome;
  if (originalCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = originalCodexCliPath;
  if (originalCodexSummaryTimeout === undefined) delete process.env.CODEX_SUMMARY_TIMEOUT_MS;
  else process.env.CODEX_SUMMARY_TIMEOUT_MS = originalCodexSummaryTimeout;
});

describe("session operations", () => {
  it("skips direct deletion for sessions that may still be running", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-"));
    process.env.CODEX_HOME = root;
    process.env.CLAUDE_HOME = path.join(root, "claude");
    process.env.GEMINI_HOME = path.join(root, "gemini");
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const sessionId = "recent-thread";
    createSummaryFixture(root, sessionId, "최근 실행 중 테스트", "아직 실행 중일 수 있습니다.");
    const rolloutPath = path.join(root, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
    const stateDb = new Database(path.join(root, "state_5.sqlite"));
    stateDb.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), sessionId);
    stateDb.close();

    const { permanentlyDeleteSessions } = await import("./operations");
    expect(await permanentlyDeleteSessions([sessionId])).toMatchObject([
      { sessionId, status: "skipped", reason: "최근 30분 내 갱신되어 실행 중일 수 있습니다." }
    ]);
    expect(fs.existsSync(rolloutPath)).toBe(true);

    const verifyState = new Database(path.join(root, "state_5.sqlite"));
    expect(verifyState.prepare("SELECT count(*) AS count FROM threads WHERE id = ?").get(sessionId)).toEqual({ count: 1 });
    verifyState.close();
  });

  it("moves to delete-pending, deletes, and directly deletes fixture sessions consistently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-"));
    process.env.CODEX_HOME = root;
    process.env.CLAUDE_HOME = path.join(root, "claude");
    process.env.GEMINI_HOME = path.join(root, "gemini");
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const sessionId = "thread-1";
    const directSessionId = "thread-2";
    const rolloutDir = path.join(root, "sessions", "2026", "01", "01");
    const rolloutPath = path.join(rolloutDir, "rollout-2026-01-01T00-00-00-thread-1.jsonl");
    const directRolloutPath = path.join(rolloutDir, "rollout-2026-01-01T00-00-02-thread-2.jsonl");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "정리 테스트" } }),
        JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "완료" } })
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      directRolloutPath,
      [
        JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "바로 삭제 테스트" } }),
        JSON.stringify({ timestamp: "2026-01-01T00:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "완료" } })
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "history.jsonl"),
      [
        JSON.stringify({ session_id: sessionId, ts: 1, text: "정리 테스트" }),
        JSON.stringify({ session_id: directSessionId, ts: 2, text: "바로 삭제 테스트" })
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "session_index.jsonl"),
      [
        JSON.stringify({ id: sessionId, thread_name: "정리 테스트" }),
        JSON.stringify({ id: directSessionId, thread_name: "바로 삭제 테스트" })
      ].join("\n") + "\n",
      "utf8"
    );

    const stateDb = new Database(path.join(root, "state_5.sqlite"));
    stateDb.exec(`
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
      CREATE TABLE thread_goals (thread_id TEXT NOT NULL, note TEXT);
    `);
    stateDb
      .prepare(
        `INSERT INTO threads
          (id, rollout_path, created_at, updated_at, source, cwd, title, tokens_used, archived, archived_at, cli_version, first_user_message, model, reasoning_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, rolloutPath, 1, 1, "cli", "/tmp/project", "정리 테스트", 10, 0, null, "test", "정리 테스트", null, null);
    stateDb
      .prepare(
        `INSERT INTO threads
          (id, rollout_path, created_at, updated_at, source, cwd, title, tokens_used, archived, archived_at, cli_version, first_user_message, model, reasoning_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(directSessionId, directRolloutPath, 2, 2, "cli", "/tmp/project", "바로 삭제 테스트", 20, 0, null, "test", "바로 삭제 테스트", null, null);
    stateDb.prepare("INSERT INTO thread_goals (thread_id, note) VALUES (?, ?)").run(sessionId, "goal");
    stateDb.prepare("INSERT INTO thread_goals (thread_id, note) VALUES (?, ?)").run(directSessionId, "goal");
    stateDb.close();

    const logsDb = new Database(path.join(root, "logs_2.sqlite"));
    logsDb.exec("CREATE TABLE logs (thread_id TEXT, message TEXT)");
    logsDb.prepare("INSERT INTO logs (thread_id, message) VALUES (?, ?)").run(sessionId, "log");
    logsDb.prepare("INSERT INTO logs (thread_id, message) VALUES (?, ?)").run(directSessionId, "log");
    logsDb.close();

    const backupDir = path.join(app, "backups", "fixture-backup");
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of ["state_5.sqlite", "logs_2.sqlite", "history.jsonl", "session_index.jsonl"]) {
      fs.copyFileSync(path.join(root, file), path.join(backupDir, file));
    }

    const { trashSessions, permanentlyDeleteSessions } = await import("./operations");
    const { getAppDb, getTrashMap, saveSummary } = await import("./appDb");
    saveSummary(sessionId, "요청: 정리 테스트");
    saveSummary(directSessionId, "요청: 바로 삭제 테스트");
    getAppDb().prepare("INSERT INTO tags (session_id, tag, created_at) VALUES (?, ?, ?)").run(sessionId, "old", "2026-01-01T00:00:00.000Z");
    getAppDb()
      .prepare("INSERT INTO tags (session_id, tag, created_at) VALUES (?, ?, ?)")
      .run(directSessionId, "old", "2026-01-01T00:00:00.000Z");

    expect(await trashSessions([sessionId])).toMatchObject([{ sessionId, status: "trashed" }]);
    expect(fs.existsSync(rolloutPath)).toBe(true);
    expect(getTrashMap().has(sessionId)).toBe(true);
    const trashRow = getAppDb().prepare("SELECT trash_dir FROM trash_items WHERE session_id = ?").get(sessionId) as { trash_dir: string };
    expect(fs.existsSync(trashRow.trash_dir)).toBe(true);

    expect(await permanentlyDeleteSessions([sessionId])).toMatchObject([{ sessionId, status: "deleted" }]);
    expect(fs.existsSync(rolloutPath)).toBe(false);
    expect(getTrashMap().has(sessionId)).toBe(false);
    expect(fs.existsSync(trashRow.trash_dir)).toBe(false);

    expect(await permanentlyDeleteSessions([directSessionId])).toMatchObject([{ sessionId: directSessionId, status: "deleted" }]);
    expect(fs.existsSync(directRolloutPath)).toBe(false);
    expect(getTrashMap().has(directSessionId)).toBe(false);
    expect(getAppDb().prepare("SELECT count(*) AS count FROM trash_items").get()).toEqual({ count: 0 });
    expect(getAppDb().prepare("SELECT count(*) AS count FROM summaries").get()).toEqual({ count: 0 });
    expect(getAppDb().prepare("SELECT count(*) AS count FROM tags").get()).toEqual({ count: 0 });

    expect(fs.readFileSync(path.join(root, "history.jsonl"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(root, "session_index.jsonl"), "utf8")).toBe("");

    const verifyState = new Database(path.join(root, "state_5.sqlite"));
    expect(verifyState.prepare("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 });
    expect(verifyState.prepare("SELECT count(*) AS count FROM thread_goals").get()).toEqual({ count: 0 });
    verifyState.close();
    expect(fileContains(path.join(root, "state_5.sqlite"), sessionId)).toBe(false);
    expect(fileContains(path.join(root, "state_5.sqlite"), directSessionId)).toBe(false);

    const verifyLogs = new Database(path.join(root, "logs_2.sqlite"));
    expect(verifyLogs.prepare("SELECT count(*) AS count FROM logs").get()).toEqual({ count: 0 });
    verifyLogs.close();
    expect(fileContains(path.join(root, "logs_2.sqlite"), sessionId)).toBe(false);
    expect(fileContains(path.join(root, "logs_2.sqlite"), directSessionId)).toBe(false);

    expect(fs.readFileSync(path.join(backupDir, "history.jsonl"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(backupDir, "session_index.jsonl"), "utf8")).toBe("");

    const verifyBackupState = new Database(path.join(backupDir, "state_5.sqlite"));
    expect(verifyBackupState.prepare("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 });
    expect(verifyBackupState.prepare("SELECT count(*) AS count FROM thread_goals").get()).toEqual({ count: 0 });
    verifyBackupState.close();
    expect(fileContains(path.join(backupDir, "state_5.sqlite"), sessionId)).toBe(false);
    expect(fileContains(path.join(backupDir, "state_5.sqlite"), directSessionId)).toBe(false);

    const verifyBackupLogs = new Database(path.join(backupDir, "logs_2.sqlite"));
    expect(verifyBackupLogs.prepare("SELECT count(*) AS count FROM logs").get()).toEqual({ count: 0 });
    verifyBackupLogs.close();
    expect(fileContains(path.join(backupDir, "logs_2.sqlite"), sessionId)).toBe(false);
    expect(fileContains(path.join(backupDir, "logs_2.sqlite"), directSessionId)).toBe(false);
  });

  it("lists and deletes Claude and Gemini session files inside their own roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-ai-home-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "multi-ai-app-"));
    const claudeHome = path.join(root, "claude");
    const geminiHome = path.join(root, "gemini");
    process.env.CODEX_HOME = path.join(root, "codex");
    process.env.CLAUDE_HOME = claudeHome;
    process.env.GEMINI_HOME = geminiHome;
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    vi.resetModules();

    const claudeDir = path.join(claudeHome, "transcripts");
    const claudePath = path.join(claudeDir, "ses_fixture.jsonl");
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeHeadFiller = Array.from({ length: 1600 }, (_, index) =>
      JSON.stringify({ type: "system", timestamp: "2026-01-01T00:00:00.000Z", content: `head-${index}-${"x".repeat(500)}` })
    );
    const claudeTailFiller = Array.from({ length: 2000 }, (_, index) =>
      JSON.stringify({ type: "system", timestamp: "2026-01-01T00:00:02.000Z", content: `tail-${index}-${"x".repeat(500)}` })
    );
    fs.writeFileSync(
      claudePath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", content: "Claude 정리 테스트" }),
        ...claudeHeadFiller,
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          content: "완료",
          usage: { input_tokens: 10, output_tokens: 5 }
        }),
        ...claudeTailFiller
      ].join("\n"),
      "utf8"
    );

    const claudeProjectDir = path.join(claudeHome, "projects", "-tmp-project");
    const claudeProjectPath = path.join(claudeProjectDir, "c-project.jsonl");
    const claudeSubagentDir = path.join(claudeProjectDir, "c-project", "subagents");
    const claudeSubagentPath = path.join(claudeSubagentDir, "agent-a1.jsonl");
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.mkdirSync(claudeSubagentDir, { recursive: true });
    fs.writeFileSync(
      claudeProjectPath,
      [
        JSON.stringify({ type: "permission-mode", sessionId: "c-project" }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-01-03T00:00:00.000Z",
          cwd: "/tmp/project",
          sessionId: "c-project",
          message: { role: "user", content: "Claude 프로젝트 최신 테스트" }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-03T00:00:01.000Z",
          cwd: "/tmp/project",
          sessionId: "c-project",
          requestId: "req-project-1",
          message: {
            id: "msg-project-1",
            role: "assistant",
            content: [{ type: "text", text: "완료" }],
            usage: { input_tokens: 11, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 7 }
          }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-03T00:00:02.000Z",
          cwd: "/tmp/project",
          sessionId: "c-project",
          requestId: "req-project-1",
          message: {
            id: "msg-project-1",
            role: "assistant",
            content: [{ type: "tool_use", name: "Read", input: {} }],
            usage: { input_tokens: 11, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 7 }
          }
        })
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      claudeSubagentPath,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-01-03T00:00:02.000Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Claude 하위 작업 로그" }
        })
      ].join("\n"),
      "utf8"
    );

    const geminiProjectRoot = path.join(root, "project");
    const geminiMarkerDir = path.join(geminiHome, "history", "proj");
    const geminiChatDir = path.join(geminiHome, "tmp", "proj", "chats");
    const geminiPath = path.join(geminiChatDir, "session-fixture.json");
    fs.mkdirSync(geminiMarkerDir, { recursive: true });
    fs.mkdirSync(geminiChatDir, { recursive: true });
    fs.writeFileSync(path.join(geminiMarkerDir, ".project_root"), geminiProjectRoot, "utf8");
    fs.writeFileSync(
      geminiPath,
      JSON.stringify({
        sessionId: "g-session",
        startTime: "2026-01-02T00:00:00.000Z",
        lastUpdated: "2026-01-02T00:00:01.000Z",
        messages: [
          { type: "user", timestamp: "2026-01-02T00:00:00.000Z", content: [{ text: "Gemini 정리 테스트" }] },
          {
            type: "gemini",
            timestamp: "2026-01-02T00:00:01.000Z",
            content: "완료",
            model: "gemini-test",
            tokens: { total: 123 }
          },
          {
            type: "gemini",
            timestamp: "2026-01-02T00:00:02.000Z",
            content: "추가 완료",
            model: "gemini-test",
            tokens: { input: 10, output: 7 }
          }
        ],
        kind: "main"
      }),
      "utf8"
    );

    const { getSessionDetail, listSessions } = await import("./scanner");
    const { getAppDb, getTrashMap } = await import("./appDb");
    const { trashSessions, permanentlyDeleteSessions } = await import("./operations");
    const initial = await listSessions({ source: "all", trash: "all", archive: "all" });
    expect(initial.totals.sources.claude.all).toBe(2);
    expect(initial.totals.sources.gemini.all).toBe(1);
    expect(initial.sessions.find((session) => session.id === "claude:ses_fixture")?.firstUserMessage).toContain("Claude 정리");
    expect(initial.sessions.find((session) => session.id === "claude:project:-tmp-project:c-project")?.firstUserMessage).toContain(
      "Claude 프로젝트"
    );
    expect(initial.sessions.find((session) => session.id === "claude:project:-tmp-project:c-project")?.fileSize).toBeGreaterThan(
      fs.statSync(claudeProjectPath).size
    );
    expect(initial.sessions.find((session) => session.id === "claude:ses_fixture")?.tokensUsed).toBe(15);
    expect(initial.sessions.find((session) => session.id === "claude:project:-tmp-project:c-project")?.tokensUsed).toBe(25);
    expect(initial.sessions.find((session) => session.id === "gemini:proj:chats:session-fixture")?.cwd).toBe(geminiProjectRoot);
    expect(initial.sessions.find((session) => session.id === "gemini:proj:chats:session-fixture")?.tokensUsed).toBe(140);
    await expect(getSessionDetail("claude:project:-tmp-project:c-project")).resolves.toMatchObject({
      session: { id: "claude:project:-tmp-project:c-project", source: "claude" },
      rawLineCount: 4
    });

    expect(await trashSessions(["claude:ses_fixture", "claude:project:-tmp-project:c-project", "gemini:proj:chats:session-fixture"])).toMatchObject([
      { sessionId: "claude:ses_fixture", status: "trashed" },
      { sessionId: "claude:project:-tmp-project:c-project", status: "trashed" },
      { sessionId: "gemini:proj:chats:session-fixture", status: "trashed" }
    ]);
    expect(fs.existsSync(claudePath)).toBe(true);
    expect(fs.existsSync(claudeProjectPath)).toBe(true);
    expect(fs.existsSync(claudeSubagentPath)).toBe(true);
    expect(fs.existsSync(geminiPath)).toBe(true);
    expect(getTrashMap().size).toBe(3);

    expect(await permanentlyDeleteSessions(["claude:ses_fixture", "claude:project:-tmp-project:c-project", "gemini:proj:chats:session-fixture"])).toMatchObject([
      { sessionId: "claude:ses_fixture", status: "deleted" },
      { sessionId: "claude:project:-tmp-project:c-project", status: "deleted" },
      { sessionId: "gemini:proj:chats:session-fixture", status: "deleted" }
    ]);
    expect(fs.existsSync(claudePath)).toBe(false);
    expect(fs.existsSync(claudeProjectPath)).toBe(false);
    expect(fs.existsSync(claudeSubagentPath)).toBe(false);
    expect(fs.existsSync(path.dirname(claudeSubagentDir))).toBe(false);
    expect(fs.existsSync(geminiPath)).toBe(false);
    expect(getTrashMap().size).toBe(0);
    expect(getAppDb().prepare("SELECT count(*) AS count FROM trash_items").get()).toEqual({ count: 0 });
  });
});

describe("session summary generation", () => {
  it("passes early, middle, and late conversation samples to Codex CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-home-"));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-app-"));
    const sessionId = "balanced-summary-thread";
    const messages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      message:
        index === 0
          ? "초반 목표: Codex 세션 관리 도구를 만들고 싶다."
          : index === 25
            ? "중반 변경: 삭제 동작과 요약 방식을 다시 조정한다."
            : index === 49
              ? "후반 상태: 전체 흐름 기준 요약으로 바꾼다."
              : `일반 대화 ${index}`
    })) as Array<{ role: "user" | "assistant"; message: string }>;
    createSummaryFixture(root, sessionId, messages[0].message, messages.at(-1)?.message || "", messages);

    const fakeCodex = path.join(root, "fake-codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "out=\"\"",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = \"--output-last-message\" ]; then",
        "    shift",
        "    out=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "prompt=$(cat)",
        "printf '%s' \"$prompt\" | grep -q '초반 목표' || exit 10",
        "printf '%s' \"$prompt\" | grep -q '중반 변경' || exit 11",
        "printf '%s' \"$prompt\" | grep -q '후반 상태' || exit 12",
        "printf '%s' \"$prompt\" | grep -q '전체 세션' || exit 13",
        "printf '%s\\n' '이 세션은 Codex 세션 관리 도구의 전체 사용 흐름을 다듬고, 삭제와 요약 동작을 검증한 뒤 전체 흐름 기준 요약으로 조정한 작업이다.' > \"$out\""
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeCodex, 0o755);

    process.env.CODEX_HOME = root;
    process.env.CLAUDE_HOME = path.join(root, "claude");
    process.env.GEMINI_HOME = path.join(root, "gemini");
    process.env.CODEX_SESSION_MANAGER_HOME = app;
    process.env.CODEX_CLI_PATH = fakeCodex;
    process.env.CODEX_SUMMARY_TIMEOUT_MS = "2000";
    vi.resetModules();

    const summaryModule = await import("./summary");
    await expect(summaryModule.generateSessionSummary(sessionId)).resolves.toContain("전체 사용 흐름");
  });

  it("uses Codex CLI output and falls back to a whole-session summary when CLI is unavailable", async () => {
    const successRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-home-"));
    const successApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-app-"));
    const successSessionId = "summary-thread-1";
    createSummaryFixture(successRoot, successSessionId, "마지막 사용자 요청입니다.", "마지막 Codex 응답입니다.");

    const fakeCodex = path.join(successRoot, "fake-codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "out=\"\"",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = \"--output-last-message\" ]; then",
        "    shift",
        "    out=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "cat >/dev/null",
        "printf '%s\\n' '사용자는 AI 요약 방식을 요청했고, Codex는 세션 요약만 생성하도록 설정했습니다.' > \"$out\""
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(fakeCodex, 0o755);

    process.env.CODEX_HOME = successRoot;
    process.env.CLAUDE_HOME = path.join(successRoot, "claude");
    process.env.GEMINI_HOME = path.join(successRoot, "gemini");
    process.env.CODEX_SESSION_MANAGER_HOME = successApp;
    process.env.CODEX_CLI_PATH = fakeCodex;
    process.env.CODEX_SUMMARY_TIMEOUT_MS = "2000";
    vi.resetModules();

    const successSummaryModule = await import("./summary");
    await expect(successSummaryModule.generateSessionSummary(successSessionId)).resolves.toBe(
      "사용자는 AI 요약 방식을 요청했고, Codex는 세션 요약만 생성하도록 설정했습니다."
    );

    const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-home-"));
    const fallbackApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-app-"));
    const fallbackSessionId = "summary-thread-2";
    createSummaryFixture(fallbackRoot, fallbackSessionId, "요약 실패 테스트입니다.", "AI가 실패하면 이 마지막 대화만 보입니다.");

    process.env.CODEX_HOME = fallbackRoot;
    process.env.CLAUDE_HOME = path.join(fallbackRoot, "claude");
    process.env.GEMINI_HOME = path.join(fallbackRoot, "gemini");
    process.env.CODEX_SESSION_MANAGER_HOME = fallbackApp;
    process.env.CODEX_CLI_PATH = "/bin/false";
    process.env.CODEX_SUMMARY_TIMEOUT_MS = "2000";
    vi.resetModules();

    const fallbackSummaryModule = await import("./summary");
    const fallbackSummary = await fallbackSummaryModule.generateSessionSummary(fallbackSessionId);
    expect(fallbackSummary).toContain("요약 실패 테스트입니다.");
    expect(fallbackSummary).toContain("AI가 실패하면 이 마지막 대화만 보입니다.");
  });
});

function createSummaryFixture(
  root: string,
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
  messages: Array<{ role: "user" | "assistant"; message: string }> = [
    { role: "user", message: userMessage },
    { role: "assistant", message: assistantMessage }
  ]
): void {
  const rolloutDir = path.join(root, "sessions", "2026", "01", "01");
  const rolloutPath = path.join(rolloutDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    messages
      .map((message, index) =>
        JSON.stringify({
          timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          type: "event_msg",
          payload: { type: message.role === "user" ? "user_message" : "agent_message", message: message.message }
        })
      )
      .join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "history.jsonl"), JSON.stringify({ session_id: sessionId, ts: 1, text: userMessage }) + "\n", "utf8");

  const stateDb = new Database(path.join(root, "state_5.sqlite"));
  stateDb.exec(`
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
  stateDb
    .prepare(
      `INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, cwd, title, tokens_used, archived, archived_at, cli_version, first_user_message, model, reasoning_effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessionId, rolloutPath, 1, 1, "cli", "/tmp/project", userMessage, 10, 0, null, "test", userMessage, null, null);
  stateDb.close();
}

function fileContains(filePath: string, value: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath).includes(value);
}
