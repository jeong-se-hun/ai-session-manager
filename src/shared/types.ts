export type SortKey =
  | "updatedDesc"
  | "updatedAsc"
  | "createdDesc"
  | "tokensDesc"
  | "tokensAsc"
  | "sizeDesc"
  | "sizeAsc";

export type ArchiveFilter = "all" | "active" | "archived";

export type TrashFilter = "all" | "normal" | "trashed";

export type SessionSource = "codex" | "claude" | "gemini";

export type SourceFilter = "all" | SessionSource;

export type SetupCandidateStatus = "ready" | "partial" | "missing";

export interface SourcePathInfo {
  source: SessionSource;
  label: string;
  currentPath: string;
  envPath: string | null;
  defaultPath: string;
  candidates: SetupPathCandidate[];
}

export interface SetupPathCandidate {
  path: string;
  source: SessionSource;
  label: string;
  status: SetupCandidateStatus;
  exists: boolean;
  sessionCount: number;
  signals: string[];
  reason: string;
  recommended: boolean;
}

export interface SetupStateResponse {
  completed: boolean;
  platform: NodeJS.Platform;
  isWsl: boolean;
  homeDir: string;
  sources: Record<SessionSource, SourcePathInfo>;
}

export interface SetupSaveRequest {
  codexHome: string;
  claudeHome: string;
  geminiHome: string;
  completed?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface BrowseDirectoryResponse {
  source: SessionSource;
  currentPath: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
  candidate: SetupPathCandidate;
}

export interface SessionFilters {
  search?: string;
  source?: SourceFilter;
  cwd?: string;
  from?: string;
  to?: string;
  archive?: ArchiveFilter;
  trash?: TrashFilter;
  sort?: SortKey;
  limit?: number;
}

export interface SessionSummaryRow {
  id: string;
  title: string;
  firstUserMessage: string;
  cwd: string;
  source: SessionSource;
  model: string | null;
  reasoningEffort: string | null;
  cliVersion: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string | null;
  tokensUsed: number;
  rolloutPath: string;
  fileExists: boolean;
  fileSize: number;
  lastUserMessage: string;
  trashed: boolean;
  trashDeletedAt: string | null;
  summary: string | null;
}

export interface SessionListResponse {
  sessions: SessionSummaryRow[];
  totals: {
    all: number;
    visible: number;
    archived: number;
    trashed: number;
    missingFiles: number;
    totalBytes: number;
    sources: Record<
      SessionSource,
      {
        all: number;
        visible: number;
        trashed: number;
        totalBytes: number;
      }
    >;
    codexHome: string;
    claudeHome: string;
    geminiHome: string;
    appHome: string;
  };
  projects: string[];
}

export type DetailItemKind = "user" | "assistant" | "tool" | "system";

export interface DetailItem {
  id: string;
  kind: DetailItemKind;
  label: string;
  text: string;
  timestamp: string | null;
}

export interface SessionDetailResponse {
  session: SessionSummaryRow;
  items: DetailItem[];
  rawLineCount: number;
}

export interface TrashResult {
  sessionId: string;
  status: "trashed" | "restored" | "archived" | "unarchived" | "skipped" | "deleted";
  reason?: string;
}

export interface DoctorIssue {
  level: "info" | "warn" | "danger";
  title: string;
  detail: string;
}

export interface DoctorResponse {
  checkedAt: string;
  issues: DoctorIssue[];
  stats: {
    threadRows: number;
    rolloutFiles: number;
    missingRolloutFiles: number;
    orphanRolloutFiles: number;
    trashedItems: number;
    appDbPath: string;
    codexHome: string;
    claudeHome: string;
    geminiHome: string;
  };
}
