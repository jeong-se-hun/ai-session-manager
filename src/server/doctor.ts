import fs from "node:fs";
import path from "node:path";
import { getTrashMap } from "./appDb";
import { getStoragePaths } from "./config";
import { appDbPath } from "./paths";
import { listThreadRows } from "./scanner";
import type { DoctorIssue, DoctorResponse } from "../shared/types";

export function runDoctor(): DoctorResponse {
  const paths = getStoragePaths();
  const rows = listThreadRows();
  const rolloutPaths = new Set(rows.map((row) => row.rollout_path));
  const files = collectRolloutFiles(paths.sessionsRoot);
  const missing = rows.filter((row) => !fs.existsSync(row.rollout_path));
  const orphan = files.filter((file) => !rolloutPaths.has(file));
  const trash = getTrashMap();
  const issues: DoctorIssue[] = [];

  if (!fs.existsSync(paths.codexHome)) {
    issues.push({ level: "danger", title: "Codex 홈 없음", detail: `${paths.codexHome} 경로가 없습니다.` });
  }
  if (!fs.existsSync(paths.claudeHome)) {
    issues.push({ level: "info", title: "Claude 기록 폴더 없음", detail: `${paths.claudeHome} 경로가 없어 Claude 세션은 표시하지 않습니다.` });
  }
  if (!fs.existsSync(paths.geminiHome)) {
    issues.push({ level: "info", title: "Gemini 기록 폴더 없음", detail: `${paths.geminiHome} 경로가 없어 Gemini 세션은 표시하지 않습니다.` });
  }
  if (missing.length > 0) {
    issues.push({
      level: "warn",
      title: "목록에는 있으나 대화 파일이 없는 세션",
      detail: `${missing.length}개 세션의 rollout 파일을 찾지 못했습니다.`
    });
  }
  if (orphan.length > 0) {
    issues.push({
      level: "info",
      title: "대화 파일은 있으나 목록에는 없는 세션",
      detail: `${orphan.length}개 대화 파일이 Codex 목록 기록에 연결되어 있지 않습니다.`
    });
  }
  if (trash.size > 0) {
    issues.push({
      level: "info",
      title: "삭제 대기 항목",
      detail: `${trash.size}개 세션이 삭제 대기에 있습니다. 복구 또는 삭제를 선택할 수 있습니다.`
    });
  }
  if (issues.length === 0) {
    issues.push({ level: "info", title: "정합성 양호", detail: "Codex 목록 저장소와 대화 파일 연결에 즉시 보이는 문제가 없습니다." });
  }

  return {
    checkedAt: new Date().toISOString(),
    issues,
    stats: {
      threadRows: rows.length,
      rolloutFiles: files.length,
      missingRolloutFiles: missing.length,
      orphanRolloutFiles: orphan.length,
      trashedItems: trash.size,
      appDbPath,
      codexHome: paths.codexHome,
      claudeHome: paths.claudeHome,
      geminiHome: paths.geminiHome
    }
  };
}

function collectRolloutFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) result.push(next);
    }
  }
  return result.sort();
}
