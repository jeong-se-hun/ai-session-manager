import { truncateText } from "./jsonl";

const INTENT_MARKERS = [
  "해줘",
  "해주세요",
  "검토",
  "분석",
  "수정",
  "작업",
  "추가",
  "삭제",
  "정리",
  "추천",
  "계획",
  "테스트",
  "빌드",
  "커밋",
  "푸시",
  "구현",
  "만들",
  "확인",
  "개선",
  "조회",
  "연결",
  "바꿔",
  "세워줘",
  "세워죠",
  "세워",
  "찾아",
  "취소",
  "돌려",
  "알려",
  "설명",
  "리뷰",
  "audit",
  "analyze",
  "fix",
  "implement",
  "update",
  "review",
  "test",
  "build",
  "commit",
  "push"
];

export function pickDisplayTitle(candidates: Array<string | null | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    const title = extractTitleCandidate(candidate ?? "");
    if (title) return truncateText(title, 110);
  }
  return truncateText(fallback, 110);
}

export function summarizeTextFragment(value: string, max = 140): string {
  return truncateText(extractTitleCandidate(value) || cleanSessionText(value) || "요약할 텍스트가 없습니다.", max);
}

export function cleanSessionText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s+/, "")
        .replace(/^❯\s+/, "")
    )
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMeaningfulSessionText(value: string): boolean {
  const clean = cleanSessionText(value);
  if (!clean || clean.length < 2) return false;
  if (isTechnicalContextText(clean)) return false;
  if (isLowSignalTitleLine(clean)) return false;
  return true;
}

export function isTechnicalContextText(value: string): boolean {
  const clean = value.trim();
  return (
    clean.startsWith("<environment_context>") ||
    clean.startsWith("<turn_aborted>") ||
    clean.startsWith("<developer_context>") ||
    clean.startsWith("<permissions instructions>") ||
    clean.startsWith("<skills_instructions>") ||
    clean.startsWith("<apps_instructions>") ||
    clean.startsWith("<plugins_instructions>") ||
    clean.startsWith("<local-command-caveat>") ||
    clean.startsWith("<command-name>") ||
    clean.startsWith("<command-message>") ||
    clean.startsWith("<command-args>") ||
    clean.startsWith("<local-command-stdout>") ||
    clean.startsWith("<local-command-stderr>") ||
    clean.startsWith("<task-notification>") ||
    clean.startsWith("[SYSTEM REMINDER") ||
    clean.startsWith("This session is being continued from a previous conversation") ||
    clean.startsWith("# AGENTS.md instructions") ||
    clean.startsWith("### Ran Playwright code") ||
    clean.includes("Knowledge cutoff:") ||
    clean.includes("Current date:")
  );
}

function extractTitleCandidate(value: string): string {
  const clean = cleanSessionText(value);
  if (!clean) return "";
  const special = extractSpecialTitleCandidate(clean);
  if (special) return special;
  const lines = splitTitleLines(value);
  const intentLine = lines.find((line) => isIntentLine(line));
  const firstUseful = intentLine || lines.find((line) => !isLowSignalTitleLine(line));
  if (!firstUseful) return "";
  return trimLongTitleLine(normalizeTitleLine(firstUseful));
}

function extractSpecialTitleCandidate(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const auditMatch = oneLine.match(/^You are auditing\s+(.+?)\.\s*(?:Read-only task\.\s*)?(Focus(?: only)?(?: on)?\s+.+?)(?:\.|$)/i);
  if (auditMatch) {
    const target = auditMatch[1].split(/[\\/]/).filter(Boolean).pop() || auditMatch[1];
    const focus = auditMatch[2].replace(/^Focus(?: only)?(?: on)?\s+/i, "").trim();
    return normalizeTitleLine(`읽기 전용 감사: ${target} ${focus}`);
  }

  const subjectMatch = oneLine.match(/(?:^|\s)Subject:\s*(.+?)(?:\s+To:|\s+Cc:|$)/i);
  if (subjectMatch) return normalizeTitleLine(`메일 검토: ${subjectMatch[1]}`);

  return "";
}

function splitTitleLines(value: string): string[] {
  const hardLines = value
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
    .map((line) => normalizeTitleLine(line))
    .filter(Boolean);
  if (hardLines.length > 0) return hardLines;
  return [normalizeTitleLine(value)].filter(Boolean);
}

function normalizeTitleLine(value: string): string {
  return value
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimLongTitleLine(value: string): string {
  const clean = normalizeTitleLine(value);
  const boundary = clean.search(/\s(?:#|📋|작성일|수정일|변경사항|Base Path|Date:|Subject:)\s*/i);
  if (boundary > 20) return clean.slice(0, boundary).trim();
  const commandMatch = /(해주세요|해줘|해봐|세워줘|세워죠|세워|찾아줘|알려줘|돌려줘|취소해줘)/.exec(clean);
  if (commandMatch && clean.length > 90) {
    const end = Math.min(clean.length, commandMatch.index + commandMatch[0].length);
    return clean.slice(0, end).trim();
  }
  if (clean.length <= 130) return clean;
  const lower = clean.toLowerCase();
  const markerHits = INTENT_MARKERS.map((marker) => {
    const index = lower.indexOf(marker.toLowerCase());
    return index >= 0 ? { marker, index } : null;
  })
    .filter((hit): hit is { marker: string; index: number } => Boolean(hit))
    .sort((a, b) => a.index - b.index);

  if (markerHits.length > 0) {
    const strongMarkers = new Set(["해줘", "해주세요", "세워", "찾아", "돌려", "알려"]);
    const hit = markerHits.find(({ marker }) => strongMarkers.has(marker)) ?? markerHits[0];
    const end = Math.min(clean.length, hit.index + hit.marker.length + 22);
    return clean.slice(0, end).replace(/\s+[#>*-].*$/, "").trim();
  }

  return clean;
}

function isIntentLine(value: string): boolean {
  const lower = value.toLowerCase();
  if (isLowSignalTitleLine(value)) return false;
  return INTENT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

function isLowSignalTitleLine(value: string): boolean {
  const clean = value.trim();
  if (!clean) return true;
  if (isTechnicalContextText(clean)) return true;
  if (/^called the .+ tool/i.test(clean)) return true;
  if (/^(width|height|angle|opacity|border|gap|padding|font|color|background)[\s:-]/i.test(clean)) return true;
  if (/^\{.*\}$/.test(clean) || /^\[.*\]$/.test(clean)) return true;
  if (/^\|?[-: ]+\|[-: |]+$/.test(clean)) return true;
  if (/^(task|summary|primary request and intent|relevant files|current work|next steps)\s*[:：]/i.test(clean)) return true;
  if (/^(task|summary|primary request and intent|relevant files|current work|next steps)$/i.test(clean)) return true;
  if (clean.length > 800 && !INTENT_MARKERS.some((marker) => clean.toLowerCase().includes(marker.toLowerCase()))) return true;
  return false;
}
