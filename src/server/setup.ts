import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getConfiguredHomes,
  getDefaultHomes,
  getEnvHomes,
  getSetupCompleted,
  normalizeHome,
  saveConfiguredHomes
} from "./config";
import type {
  BrowseDirectoryResponse,
  DirectoryEntry,
  SessionSource,
  SetupCandidateStatus,
  SetupPathCandidate,
  SetupSaveRequest,
  SetupStateResponse
} from "../shared/types";

const SOURCE_LABELS: Record<SessionSource, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini"
};

export function getSetupState(): SetupStateResponse {
  const current = getConfiguredHomes();
  const defaults = getDefaultHomes();
  const env = getEnvHomes();
  const isWsl = detectWsl();

  return {
    completed: getSetupCompleted(),
    platform: process.platform,
    isWsl,
    homeDir: os.homedir(),
    sources: {
      codex: buildSourceInfo("codex", current.codexHome, env.codexHome, defaults.codexHome, isWsl),
      claude: buildSourceInfo("claude", current.claudeHome, env.claudeHome, defaults.claudeHome, isWsl),
      gemini: buildSourceInfo("gemini", current.geminiHome, env.geminiHome, defaults.geminiHome, isWsl)
    }
  };
}

export function saveSetupState(request: SetupSaveRequest): SetupStateResponse {
  saveConfiguredHomes(request);
  return getSetupState();
}

export function browseSetupDirectory(source: SessionSource, requestedPath: string | undefined): BrowseDirectoryResponse {
  const currentPath = resolveBrowsePath(source, requestedPath);
  const parentPath = getParentPath(currentPath);
  const entries = listDirectoryEntries(currentPath);
  return {
    source,
    currentPath,
    parentPath,
    entries,
    candidate: inspectCandidate(source, currentPath, "현재 폴더")
  };
}

function buildSourceInfo(
  source: SessionSource,
  currentPath: string,
  envPath: string | null,
  defaultPath: string,
  isWsl: boolean
): SetupStateResponse["sources"][SessionSource] {
  const candidatePaths = [
    { path: currentPath, label: "현재 사용 중" },
    envPath ? { path: envPath, label: "환경변수" } : null,
    { path: defaultPath, label: "기본 경로" },
    ...getWslWindowsHomeCandidates(source, isWsl)
  ].filter((candidate): candidate is { path: string; label: string } => Boolean(candidate));

  const byPath = new Map<string, string[]>();
  for (const candidate of candidatePaths) {
    const normalized = normalizeHome(candidate.path);
    byPath.set(normalized, [...(byPath.get(normalized) ?? []), candidate.label]);
  }

  const candidates = [...byPath.entries()].map(([candidatePath, labels]) => inspectCandidate(source, candidatePath, labels.join(" / ")));
  const bestReady = candidates
    .filter((candidate) => candidate.status === "ready")
    .sort((a, b) => b.sessionCount - a.sessionCount || Number(b.path === currentPath) - Number(a.path === currentPath))[0];
  const bestPartial = candidates
    .filter((candidate) => candidate.status === "partial")
    .sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath))[0];
  const recommendedPath = (bestReady ?? bestPartial)?.path;

  return {
    source,
    label: SOURCE_LABELS[source],
    currentPath,
    envPath,
    defaultPath,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      recommended: candidate.path === recommendedPath
    }))
  };
}

function inspectCandidate(source: SessionSource, rootPath: string, label: string): SetupPathCandidate {
  if (source === "codex") return inspectCodexCandidate(rootPath, label);
  if (source === "claude") return inspectClaudeCandidate(rootPath, label);
  return inspectGeminiCandidate(rootPath, label);
}

function resolveBrowsePath(source: SessionSource, requestedPath: string | undefined): string {
  const fallback = getConfiguredHomes()[`${source}Home` as keyof ReturnType<typeof getConfiguredHomes>];
  const normalized = normalizeHome(requestedPath?.trim() || fallback || os.homedir());
  if (fs.existsSync(normalized)) {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) return normalized;
    return path.dirname(normalized);
  }
  let current = normalized;
  while (current && current !== path.dirname(current)) {
    current = path.dirname(current);
    if (fs.existsSync(current) && fs.statSync(current).isDirectory()) return current;
  }
  return os.homedir();
}

function getParentPath(currentPath: string): string | null {
  const parentPath = path.dirname(currentPath);
  return parentPath === currentPath ? null : parentPath;
}

function listDirectoryEntries(currentPath: string): DirectoryEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(currentPath, entry.name),
      hidden: entry.name.startsWith(".")
    }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name))
    .slice(0, 300);
}

function inspectCodexCandidate(rootPath: string, label: string): SetupPathCandidate {
  const exists = fs.existsSync(rootPath);
  const statePath = path.join(rootPath, "state_5.sqlite");
  const sessionsPath = path.join(rootPath, "sessions");
  const rolloutCount = countFiles(sessionsPath, (filePath) => path.basename(filePath).startsWith("rollout-") && filePath.endsWith(".jsonl"));
  const signals = [
    fs.existsSync(statePath) ? "state_5.sqlite" : "",
    fs.existsSync(sessionsPath) ? "sessions/" : "",
    rolloutCount > 0 ? `${rolloutCount.toLocaleString("ko-KR")}개 rollout 파일` : ""
  ].filter(Boolean);
  return buildCandidate("codex", rootPath, label, exists, rolloutCount, signals);
}

function inspectClaudeCandidate(rootPath: string, label: string): SetupPathCandidate {
  const exists = fs.existsSync(rootPath);
  const projectsPath = path.join(rootPath, "projects");
  const transcriptsPath = path.join(rootPath, "transcripts");
  const transcriptCount = countFiles(transcriptsPath, (filePath) => filePath.endsWith(".jsonl"));
  const projectCount = countFiles(projectsPath, (filePath) => {
    if (!filePath.endsWith(".jsonl")) return false;
    return path.dirname(path.dirname(filePath)) === projectsPath;
  });
  const sessionCount = transcriptCount + projectCount;
  const signals = [
    fs.existsSync(projectsPath) ? "projects/" : "",
    fs.existsSync(transcriptsPath) ? "transcripts/" : "",
    sessionCount > 0 ? `${sessionCount.toLocaleString("ko-KR")}개 JSONL 세션` : ""
  ].filter(Boolean);
  return buildCandidate("claude", rootPath, label, exists, sessionCount, signals);
}

function inspectGeminiCandidate(rootPath: string, label: string): SetupPathCandidate {
  const exists = fs.existsSync(rootPath);
  const tmpPath = path.join(rootPath, "tmp");
  const historyPath = path.join(rootPath, "history");
  const sessionCount = countFiles(tmpPath, (filePath) => path.basename(path.dirname(filePath)) === "chats" && filePath.endsWith(".json"));
  const projectRootCount = countFiles(historyPath, (filePath) => path.basename(filePath) === ".project_root");
  const signals = [
    fs.existsSync(tmpPath) ? "tmp/" : "",
    fs.existsSync(historyPath) ? "history/" : "",
    sessionCount > 0 ? `${sessionCount.toLocaleString("ko-KR")}개 chat 파일` : "",
    projectRootCount > 0 ? `${projectRootCount.toLocaleString("ko-KR")}개 project_root` : ""
  ].filter(Boolean);
  return buildCandidate("gemini", rootPath, label, exists, sessionCount, signals);
}

function buildCandidate(
  source: SessionSource,
  rootPath: string,
  label: string,
  exists: boolean,
  sessionCount: number,
  signals: string[]
): SetupPathCandidate {
  const status: SetupCandidateStatus = sessionCount > 0 ? "ready" : signals.length > 0 ? "partial" : "missing";
  return {
    path: rootPath,
    source,
    label,
    status,
    exists,
    sessionCount,
    signals,
    reason: getCandidateReason(status, exists, source),
    recommended: false
  };
}

function getCandidateReason(status: SetupCandidateStatus, exists: boolean, source: SessionSource): string {
  if (status === "ready") return `${SOURCE_LABELS[source]} 기록을 찾았습니다.`;
  if (status === "partial") return "폴더 구조는 보이지만 세션 파일은 아직 적거나 없습니다.";
  return exists ? "폴더는 있지만 기록 구조를 찾지 못했습니다." : "폴더가 없습니다.";
}

function countFiles(root: string, predicate: (filePath: string) => boolean): number {
  if (!fs.existsSync(root)) return 0;
  const stack = [root];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile() && predicate(next)) count += 1;
    }
  }
  return count;
}

function detectWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const version = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return Boolean(process.env.WSL_DISTRO_NAME);
  }
}

function getWslWindowsHomeCandidates(source: SessionSource, isWsl: boolean): Array<{ path: string; label: string }> {
  if (!isWsl || !fs.existsSync("/mnt/c/Users")) return [];
  let users: fs.Dirent[];
  try {
    users = fs.readdirSync("/mnt/c/Users", { withFileTypes: true });
  } catch {
    return [];
  }
  const folderName = source === "codex" ? ".codex" : source === "claude" ? ".claude" : ".gemini";
  return users
    .filter((entry) => entry.isDirectory() && !["All Users", "Default", "Default User", "Public"].includes(entry.name))
    .slice(0, 8)
    .map((entry) => ({
      path: path.join("/mnt/c/Users", entry.name, folderName),
      label: "WSL Windows 홈"
    }));
}
