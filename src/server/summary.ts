import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { saveSummary } from "./appDb";
import { getSessionDetail } from "./scanner";
import type { DetailItem } from "../shared/types";

export async function generateSessionSummary(sessionId: string): Promise<string> {
  const detail = await getSessionDetail(sessionId);
  const fallback = buildFallbackSummary(detail.items, detail.session.lastUserMessage || detail.session.firstUserMessage || detail.session.title);
  try {
    const summary = normalizeAiSummary(await generateAiSummary(detail.items, fallback));
    saveSummary(sessionId, summary);
    return summary;
  } catch {
    saveSummary(sessionId, fallback);
    return fallback;
  }
}

function buildFallbackSummary(items: DetailItem[], fallbackText: string): string {
  const lastConversation = [...items]
    .reverse()
    .find((item) => (item.kind === "user" || item.kind === "assistant") && isMeaningfulText(item.text));
  return compact(lastConversation?.text || fallbackText || "최근 대화를 찾지 못했습니다.", 320);
}

async function generateAiSummary(items: DetailItem[], fallback: string): Promise<string> {
  const codexBin = process.env.CODEX_CLI_PATH || "codex";
  const prompt = buildAiPrompt(items, fallback);
  const outputPath = path.join(os.tmpdir(), `codex-session-summary-${process.pid}-${Date.now()}.txt`);
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath
  ];
  if (process.env.CODEX_SUMMARY_MODEL) args.push("--model", process.env.CODEX_SUMMARY_MODEL);
  args.push("-");

  try {
    await runCodex(codexBin, args, prompt, Number(process.env.CODEX_SUMMARY_TIMEOUT_MS || 60000));
    const output = await fs.readFile(outputPath, "utf8");
    if (!output.trim()) throw new Error("Codex summary output was empty.");
    return output;
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

function buildAiPrompt(items: DetailItem[], fallback: string): string {
  const conversation = items.filter(
    (item) => (item.kind === "user" || item.kind === "assistant") && isMeaningfulText(item.text) && !isTechnicalContext(item.text)
  );
  const useful = sampleConversationForSummary(conversation)
    .map(({ item, section }) => `[${section}] ${item.label}: ${compact(item.text, 850)}`)
    .join("\n\n");

  return [
    "너는 Codex 세션 관리 앱의 요약 생성기다.",
    "아래 대화 내용을 읽고 한국어 세션 요약 하나만 작성해라.",
    "최근 대화에 치우치지 말고 전체 세션의 목적, 중간 변경사항, 마지막 상태를 균형 있게 반영해라.",
    "아래 대화는 전체 세션에서 초반/중반/후반을 고르게 뽑은 것이다.",
    "출력은 제목, 라벨, 항목, 마크다운, 코드블록 없이 순수 요약 문장만 사용해라.",
    "요약은 2~4문장으로, 전체적으로 무엇을 하려던 세션인지와 최종 상태를 자연스럽게 포함해라.",
    "",
    "대화가 부족하면 아래 fallback 내용을 자연스러운 한 문장 요약으로 다듬어라.",
    `fallback=${fallback}`,
    "",
    "대화:",
    useful || fallback
  ].join("\n");
}

function sampleConversationForSummary(items: DetailItem[]): Array<{ item: DetailItem; section: "초반" | "중반" | "후반" }> {
  if (items.length <= 36) {
    return items.map((item, index) => ({ item, section: getConversationSection(index, items.length) }));
  }

  const middleStart = Math.max(10, Math.floor(items.length / 2) - 6);
  const candidates = [
    ...items.slice(0, 10).map((item, index) => ({ item, index })),
    ...items.slice(middleStart, middleStart + 12).map((item, offset) => ({ item, index: middleStart + offset })),
    ...items.slice(-14).map((item, offset) => ({ item, index: items.length - 14 + offset }))
  ];

  const byIndex = new Map<number, DetailItem>();
  for (const candidate of candidates) byIndex.set(candidate.index, candidate.item);
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, item]) => ({ item, section: getConversationSection(index, items.length) }));
}

function getConversationSection(index: number, total: number): "초반" | "중반" | "후반" {
  if (index < total / 3) return "초반";
  if (index < (total / 3) * 2) return "중반";
  return "후반";
}

async function runCodex(command: string, args: string[], input: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex summary timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex summary failed with exit code ${code}. ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function normalizeAiSummary(raw: string): string {
  const text = raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^```.*$/, "")
        .replace(/^[-*]\s*/, "")
        .replace(/^(세션\s*요약|요약|요청|최근|응답|단서)\s*[:：]\s*/, "")
    )
    .filter(Boolean)
    .join(" ");
  const summary = compact(text, 420);
  if (!summary || summary === "요약할 텍스트가 없습니다.") throw new Error("Codex summary output was empty.");
  return summary;
}

export async function generateRuleBasedSessionSummary(sessionId: string): Promise<string> {
  const detail = await getSessionDetail(sessionId);
  const userItems = detail.items
    .filter((item) => item.kind === "user" && !isTechnicalContext(item.text))
    .map((item) => item.text)
    .filter(isMeaningfulText);
  const assistantItems = detail.items
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text)
    .filter(isMeaningfulText);
  const toolItems = detail.items.filter((item) => item.kind === "tool");
  const request = pickRequest(detail.session.title, detail.session.firstUserMessage, userItems);
  const recentUser = userItems.at(-1) || detail.session.lastUserMessage || request;
  const result = pickAssistantResult(assistantItems);
  const keywords = extractKeywords([detail.session.cwd, detail.session.title, ...userItems].join(" "));

  const lines = [
    `요청: ${compact(request, 170)}`,
    `최근: ${compact(recentUser, 170)}`,
    `응답: ${compact(result, 190)}`,
    `단서: ${keywords.length ? keywords.join(", ") : "키워드 부족"} · 사용자 ${userItems.length}회 · 도구 ${toolItems.length}회 · 토큰 ${detail.session.tokensUsed.toLocaleString("ko-KR")}`
  ];

  const summary = lines.join("\n");
  saveSummary(sessionId, summary);
  return summary;
}

function pickRequest(title: string, firstUserMessage: string, userItems: string[]): string {
  const candidates = [title, firstUserMessage, ...userItems]
    .map((item) => item.trim())
    .filter((item) => item && !isTechnicalContext(item) && isMeaningfulText(item));
  return candidates.find((item) => item.length >= 12) || candidates[0] || "요청 내용을 찾지 못했습니다.";
}

function pickAssistantResult(items: string[]): string {
  const finalLike = [...items].reverse().find((item) => {
    const clean = item.trim();
    return clean.length >= 20 && !isProgressMessage(clean);
  });
  return finalLike || items.at(-1) || "아직 Codex 응답이 충분히 기록되지 않았습니다.";
}

function compact(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "요약할 텍스트가 없습니다.";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function isMeaningfulText(value: string): boolean {
  const clean = value.trim();
  if (!clean) return false;
  if (clean.length < 2) return false;
  if (clean.startsWith("### Ran Playwright code")) return false;
  if (clean.includes("Knowledge cutoff") && clean.includes("Current date")) return false;
  return true;
}

function isProgressMessage(value: string): boolean {
  const progressPhrases = [
    "하겠습니다",
    "진행합니다",
    "진행하겠습니다",
    "확인하겠습니다",
    "확인했습니다",
    "바꾸겠습니다",
    "수정하겠습니다",
    "고치겠습니다",
    "검증하겠습니다",
    "다시 돌리겠습니다",
    "겠습니다"
  ];
  return progressPhrases.some((phrase) => value.includes(phrase));
}

function isTechnicalContext(value: string): boolean {
  const clean = value.trim();
  return clean.startsWith("<environment_context>") || clean.startsWith("<turn_aborted>") || clean.startsWith("<developer_context>");
}

function extractKeywords(input: string): string[] {
  const preferred = [
    "세션",
    "삭제",
    "삭제 대기",
    "요약",
    "필터링",
    "고급",
    "정합성",
    "진단",
    "전체",
    "활성",
    "코덱스",
    "Codex"
  ].filter((keyword) => input.includes(keyword));
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "해서",
    "하고",
    "있는",
    "없는",
    "으로",
    "으로",
    "좀",
    "더",
    "수정",
    "확인",
    "해줘",
    "해주세요",
    "rollout",
    "Codex",
    "코덱스의"
  ]);
  const tokens = input
    .replace(/[^\p{L}\p{N}_./:-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token.toLowerCase()));
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token);
  return [...new Set([...preferred, ...ranked])].slice(0, 6);
}
