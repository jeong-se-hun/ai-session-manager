import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { saveSummary } from "./appDb";
import { getSessionDetail } from "./scanner";
import { cleanSessionText, isMeaningfulSessionText, isTechnicalContextText, pickDisplayTitle, summarizeTextFragment } from "./textQuality";
import type { DetailItem } from "../shared/types";

type SummaryEntry = {
  item: DetailItem;
  index: number;
  section: "초반" | "중반" | "후반";
};

type SummaryBrief = {
  userEntries: SummaryEntry[];
  assistantEntries: SummaryEntry[];
  request: string;
  middleRequest: string;
  lastRequest: string;
  result: string;
  fallbackText: string;
};

export async function generateSessionSummary(sessionId: string): Promise<string> {
  const detail = await getSessionDetail(sessionId);
  const brief = buildSummaryBrief(
    detail.items,
    detail.session.lastUserMessage || detail.session.firstUserMessage || detail.session.title,
    detail.session.title,
    detail.session.firstUserMessage,
    detail.session.lastUserMessage
  );
  const fallback = buildFallbackSummary(brief);
  try {
    const summary = normalizeAiSummary(await generateAiSummary(brief, fallback));
    saveSummary(sessionId, summary);
    return summary;
  } catch {
    saveSummary(sessionId, fallback);
    return fallback;
  }
}

function buildSummaryBrief(
  items: DetailItem[],
  fallbackText: string,
  title = "",
  firstUserMessage = "",
  lastUserMessage = ""
): SummaryBrief {
  const indexedEntries = items
    .map((item, index) => ({ item, index, section: getConversationSection(index, items.length) }))
    .filter(({ item }) => isSummaryConversationItem(item));
  const userEntries = indexedEntries.filter(({ item }) => item.kind === "user");
  const assistantEntries = indexedEntries.filter(({ item }) => item.kind === "assistant" && !isProgressMessage(item.text));
  const userTexts = userEntries.map(({ item }) => item.text);
  const assistantTexts = assistantEntries.map(({ item }) => item.text);
  const request = pickRequest(title, firstUserMessage, userTexts);
  const lastRequest = pickDisplayTitle([lastUserMessage, ...[...userTexts].reverse()], request);
  const middleRequest = pickMiddleRequest(userTexts, request, lastRequest);
  const result = pickAssistantResult(assistantTexts);

  return {
    userEntries,
    assistantEntries,
    request,
    middleRequest,
    lastRequest,
    result,
    fallbackText
  };
}

function buildFallbackSummary(brief: SummaryBrief): string {
  const request = summarizeTextFragment(brief.request, 150);
  const middle = brief.middleRequest ? summarizeTextFragment(brief.middleRequest, 140) : "";
  const last = brief.lastRequest ? summarizeTextFragment(brief.lastRequest, 150) : "";
  const result = brief.result ? summarizeTextFragment(brief.result, 150) : "";
  const fallback = summarizeTextFragment(brief.fallbackText, 180);

  if (!request || request === "요약할 텍스트가 없습니다.") {
    return compact(fallback || "최근 대화를 찾지 못했습니다.", 320);
  }

  const sentences = [`이 세션의 핵심 주제는 "${request}"입니다.`];
  if (middle && !isSimilarText(middle, request) && !isSimilarText(middle, last)) {
    sentences.push(`중간에 다룬 내용은 "${middle}"입니다.`);
  }
  if (last && !isSimilarText(last, request)) {
    sentences.push(`후반 요청은 "${last}"입니다.`);
  }
  if (result && result !== "아직 Codex 응답이 충분히 기록되지 않았습니다.") {
    sentences.push(`마지막 응답은 "${result}"로 정리됐습니다.`);
  }

  return compact(sentences.join(" "), 520);
}

async function generateAiSummary(brief: SummaryBrief, fallback: string): Promise<string> {
  const codexBin = process.env.CODEX_CLI_PATH || "codex";
  const prompt = buildAiPrompt(brief, fallback);
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

function buildAiPrompt(brief: SummaryBrief, fallback: string): string {
  const userFlow = sampleEntriesForSummary(brief.userEntries, 18)
    .map(({ item, section }) => `[${section}] 사용자: ${compactForPrompt(item.text, 700)}`)
    .join("\n\n");
  const resultFlow = sampleEntriesForSummary(brief.assistantEntries, 10)
    .map(({ item, section }) => `[${section}] 응답: ${compactForPrompt(item.text, 520)}`)
    .join("\n\n");

  return [
    "너는 AI 세션 관리 앱의 요약 생성기다.",
    "목표는 사용자가 세션 목록에서 내용을 바로 이해하도록 자연스러운 한국어 세션 요약 하나만 만드는 것이다.",
    "반드시 전체 세션 기준으로 판단해라.",
    "최근 대화에 치우치지 말고 초반 목적, 중간 변경사항, 후반 상태를 균형 있게 반영해라.",
    "긴 API 명세, 이메일, Figma 속성, 터미널 로그는 본문 자료로 보고 사용자의 실제 요청과 작업 흐름을 우선해라.",
    "진행 예고나 '확인하겠습니다' 같은 중간 상태보다 완료, 검토 결과, 커밋, 빌드, 삭제, 오류 원인을 우선 반영해라.",
    "출력은 제목, 라벨, 항목, 마크다운, 코드블록 없이 순수 요약 문장만 사용해라.",
    "요약은 2~3문장으로 작성하고, '요청/최근/응답/단서' 같은 4줄 형식은 절대 쓰지 마라.",
    "",
    "대표 단서:",
    `대표 요청: ${brief.request}`,
    `중간 흐름: ${brief.middleRequest || "뚜렷한 중간 변경사항 없음"}`,
    `마지막 요청: ${brief.lastRequest || "마지막 요청 없음"}`,
    `결과 단서: ${brief.result || "결과 단서 부족"}`,
    `fallback: ${fallback}`,
    "",
    "사용자 요청 흐름:",
    userFlow || fallback,
    "",
    "응답/결과 단서:",
    resultFlow || "응답 단서 부족"
  ].join("\n");
}

function sampleEntriesForSummary(entries: SummaryEntry[], maxCount: number): SummaryEntry[] {
  if (entries.length <= maxCount) return entries;
  const headCount = Math.max(3, Math.floor(maxCount * 0.34));
  const tailCount = Math.max(4, Math.floor(maxCount * 0.38));
  const middleCount = Math.max(2, maxCount - headCount - tailCount);
  const middleStart = Math.max(headCount, Math.floor(entries.length / 2) - Math.floor(middleCount / 2));
  const candidates = [
    ...entries.slice(0, headCount),
    ...entries.slice(middleStart, middleStart + middleCount),
    ...entries.slice(-tailCount)
  ];

  const byIndex = new Map<number, SummaryEntry>();
  for (const candidate of candidates) byIndex.set(candidate.index, candidate);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
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
  return pickDisplayTitle([title, firstUserMessage, ...userItems], "요청 내용을 찾지 못했습니다.");
}

function pickMiddleRequest(userItems: string[], request: string, lastRequest: string): string {
  if (userItems.length <= 2) return "";
  const center = Math.floor(userItems.length / 2);
  const candidates = [
    ...userItems.slice(Math.max(1, center - 3), Math.min(userItems.length - 1, center + 4)),
    ...userItems.slice(1, -1)
  ];
  for (const candidate of candidates) {
    const clean = summarizeTextFragment(candidate, 140);
    if (clean && !isWeakSummarySignal(clean) && !isSimilarText(clean, request) && !isSimilarText(clean, lastRequest)) return clean;
  }
  return "";
}

function pickAssistantResult(items: string[]): string {
  const finalLike = [...items].reverse().find((item) => {
    const clean = item.trim();
    return clean.length >= 20 && !isProgressMessage(clean) && !isWeakSummarySignal(clean);
  });
  const fallback = [...items].reverse().find((item) => !isWeakSummarySignal(item));
  return finalLike || fallback || "아직 Codex 응답이 충분히 기록되지 않았습니다.";
}

function isSummaryConversationItem(item: DetailItem): boolean {
  return (item.kind === "user" || item.kind === "assistant") && isMeaningfulText(item.text) && !isTechnicalContext(item.text);
}

function isWeakSummarySignal(value: string): boolean {
  const clean = value.trim();
  if (clean.length < 8) return true;
  if (/^일반 대화\s*\d+$/i.test(clean)) return true;
  if (/^(ok|okay|done|완료|확인|테스트|빌드 테스트)$/i.test(clean)) return true;
  if (isProgressMessage(clean)) return true;
  return false;
}

function compactForPrompt(value: string, max: number): string {
  const clean = cleanSessionText(value);
  if (!clean) return "";
  if (clean.length <= max) return clean;

  const headline = summarizeTextFragment(clean, 180);
  const tail = clean.slice(Math.max(0, clean.length - Math.floor(max * 0.45)));
  return compact(`${headline} / 후반 일부: ${tail}`, max);
}

function compact(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "요약할 텍스트가 없습니다.";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function isSimilarText(a: string, b: string): boolean {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 16 && right.includes(left)) return true;
  if (right.length >= 16 && left.includes(right)) return true;
  return false;
}

function normalizeForCompare(value: string): string {
  return summarizeTextFragment(value, 90)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function isMeaningfulText(value: string): boolean {
  return isMeaningfulSessionText(value);
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
  return isTechnicalContextText(value);
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
