import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CheckSquare,
  Eye,
  FolderOpen,
  ListFilter,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import type {
  ArchiveFilter,
  BrowseDirectoryResponse,
  DetailItem,
  SessionDetailResponse,
  SessionListResponse,
  SessionSummaryRow,
  SessionSource,
  SetupPathCandidate,
  SetupStateResponse,
  SourceFilter,
  SortKey,
  TrashFilter
} from "../shared/types";
import anthropicIcon from "./assets/brand-icons/anthropic.svg";
import geminiIcon from "./assets/brand-icons/googlegemini.svg";
import openAiIcon from "./assets/brand-icons/openai.svg";
import "./styles.css";

declare global {
  interface Window {
    __codexSessionManagerRoot?: Root;
  }
}

const api = {
  async list(filters: FilterState): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== "" && value !== "all" && value !== undefined) params.set(key, String(value));
    }
    const response = await fetch(`/api/sessions?${params.toString()}`);
    return readResponse(response);
  },
  async detail(id: string): Promise<SessionDetailResponse> {
    const params = new URLSearchParams({ id });
    return readResponse(await fetch(`/api/session-detail?${params.toString()}`));
  },
  async summary(id: string): Promise<{ summary: string }> {
    return readResponse(
      await fetch("/api/session-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id })
      })
    );
  },
  async setup(): Promise<SetupStateResponse> {
    return readResponse(await fetch("/api/setup"));
  },
  async browseDirectory(source: SessionSource, pathValue: string): Promise<BrowseDirectoryResponse> {
    const params = new URLSearchParams({ source, path: pathValue });
    return readResponse(await fetch(`/api/setup/browse?${params.toString()}`));
  },
  async saveSetup(body: SetupDraft): Promise<SetupStateResponse> {
    return readResponse(
      await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, completed: true })
      })
    );
  },
  async post(path: string, body: unknown): Promise<{ results: Array<{ sessionId: string; status: string; reason?: string }> }> {
    return readResponse(
      await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
    );
  }
};

interface FilterState {
  search: string;
  source: SourceFilter;
  cwd: string;
  from: string;
  to: string;
  archive: ArchiveFilter;
  trash: TrashFilter;
  sort: SortKey;
  limit: number;
}

interface OperationState {
  label: string;
  total: number | null;
  done: number;
}

type ProgressHandler = (done: number) => void;
type SetupDraft = Record<`${SessionSource}Home`, string>;

const defaultFilters: FilterState = {
  search: "",
  source: "all",
  cwd: "",
  from: "",
  to: "",
  archive: "active",
  trash: "normal",
  sort: "updatedDesc",
  limit: 100000
};

const sourceOptions: Array<{
  value: SourceFilter;
  label: string;
  caption?: string;
  icon?: string;
  Icon?: typeof SlidersHorizontal;
}> = [
  { value: "all", label: "전체", Icon: SlidersHorizontal },
  { value: "codex", label: "Codex", caption: "OpenAI", icon: openAiIcon },
  { value: "claude", label: "Claude", caption: "Anthropic", icon: anthropicIcon },
  { value: "gemini", label: "Gemini", caption: "Google", icon: geminiIcon }
];

const sourceLabel: Record<SessionSource, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini"
};

const sortLabel: Record<SortKey, string> = {
  updatedDesc: "마지막 대화 최신순",
  updatedAsc: "마지막 대화 오래된순",
  createdDesc: "생성 최신순",
  tokensDesc: "토큰 많은순",
  tokensAsc: "토큰 적은순",
  sizeDesc: "크기 큰순",
  sizeAsc: "크기 작은순"
};

function App() {
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [summarizingSessionId, setSummarizingSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [setup, setSetup] = useState<SetupStateResponse | null>(null);
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({ codexHome: "", claudeHome: "", geminiHome: "" });
  const [showSetup, setShowSetup] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [pickerSource, setPickerSource] = useState<SessionSource | null>(null);
  const refreshSeq = useRef(0);
  const didInitialRefresh = useRef(false);
  const busy = operation?.label ?? null;

  async function refresh(nextFilters = filters) {
    const requestId = ++refreshSeq.current;
    setLoading(true);
    try {
      let effectiveFilters = nextFilters;
      let response = await api.list(effectiveFilters);
      if (effectiveFilters.cwd && !response.projects.includes(effectiveFilters.cwd)) {
        effectiveFilters = { ...effectiveFilters, cwd: "" };
        setFilters(effectiveFilters);
        response = await api.list(effectiveFilters);
      }
      if (requestId !== refreshSeq.current) return;
      setData(response);
      setSelected((prev) => new Set([...prev].filter((id) => response.sessions.some((session) => session.id === id))));
      if (activeId && !response.sessions.some((session) => session.id === activeId)) {
        setActiveId(null);
        setDetail(null);
        setDetailError("");
        setDetailLoading(false);
      }
    } catch (error) {
      if (requestId === refreshSeq.current) setNotice(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.");
    } finally {
      if (requestId === refreshSeq.current) setLoading(false);
    }
  }

  async function refreshAll() {
    const nextFilters = { ...filters, cwd: "" };
    setFilters(nextFilters);
    await refresh(nextFilters);
  }

  async function saveSetup(nextDraft = setupDraft) {
    setSetupBusy(true);
    try {
      const response = await api.saveSetup(nextDraft);
      setSetup(response);
      setSetupDraft(getDraftFromSetup(response));
      setShowSetup(false);
      setSelected(new Set());
      setActiveId(null);
      setDetail(null);
      setDetailError("");
      const nextFilters = { ...filters, cwd: "" };
      setFilters(nextFilters);
      await refresh(nextFilters);
      setNotice("기록 경로를 저장하고 다시 스캔했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "기록 경로 저장에 실패했습니다.");
    } finally {
      setSetupBusy(false);
    }
  }

  useEffect(() => {
    api
      .setup()
      .then((response) => {
        setSetup(response);
        setSetupDraft(getDraftFromSetup(response));
        if (!response.completed) setShowSetup(true);
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "기록 경로 설정을 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    if (!didInitialRefresh.current) {
      didInitialRefresh.current = true;
      void refresh(filters);
      return;
    }
    const timer = window.setTimeout(() => void refresh(filters), 250);
    return () => window.clearTimeout(timer);
  }, [filters]);

  useEffect(() => {
    if (!activeId) return;
    let canceled = false;
    setDetailLoading(true);
    setDetail(null);
    setDetailError("");
    api
      .detail(activeId)
      .then((response) => {
        if (!canceled) setDetail(response);
      })
      .catch((error) => {
        if (!canceled) setDetailError(error instanceof Error ? error.message : "상세를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!canceled) setDetailLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedRows = useMemo(
    () => data?.sessions.filter((session) => selected.has(session.id)) ?? [],
    [data?.sessions, selected]
  );

  async function runBulk(
    label: string,
    action: (onProgress: ProgressHandler) => Promise<unknown>,
    options: { closeDetail?: boolean; preserveSelection?: boolean; resetProject?: boolean; total?: number | null; sessionId?: string } = {}
  ) {
    setOperation({ label, total: options.total ?? null, done: 0 });
    if (label === "요약") setSummarizingSessionId(options.sessionId ?? null);
    try {
      const result = await action((done) => {
        setOperation((current) => (current?.label === label ? { ...current, done } : current));
      });
      setOperation((current) =>
        current?.label === label && current.total !== null ? { ...current, done: current.total } : current
      );
      setNotice(formatResult(label, result));
      if (!options.preserveSelection) setSelected(new Set());
      const nextFilters = options.resetProject && filters.cwd ? { ...filters, cwd: "" } : filters;
      if (nextFilters !== filters) setFilters(nextFilters);
      await refresh(nextFilters);
      if (options.closeDetail) {
        setActiveId(null);
        setDetail(null);
        setDetailError("");
      } else if (activeId) {
        setDetail(await api.detail(activeId));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label} 작업에 실패했습니다.`);
    } finally {
      setOperation(null);
      if (label === "요약") setSummarizingSessionId(null);
    }
  }

  const sessions = data?.sessions ?? [];
  const allVisibleSelected = sessions.length > 0 && sessions.every((session) => selected.has(session.id));
  const currentView = getCurrentView(filters);
  const selectedHasTrash = selectedRows.some((row) => row.trashed);
  const selectedHasNormal = selectedRows.some((row) => !row.trashed);

  return (
    <main className="app-shell" aria-busy={Boolean(operation)}>
      {setup && (showSetup || !setup.completed) && (
        <SetupPanel
          setup={setup}
          draft={setupDraft}
          busy={setupBusy}
          onDraftChange={setSetupDraft}
          onBrowse={(source) => setPickerSource(source)}
          onUseRecommended={() => void saveSetup(getRecommendedDraft(setup, setupDraft))}
          onSave={() => void saveSetup()}
          onClose={() => setShowSetup(false)}
        />
      )}
      {pickerSource && (
        <FolderPicker
          source={pickerSource}
          initialPath={setupDraft[getHomeKey(pickerSource)]}
          onPick={(pathValue) => {
            setSetupDraft({ ...setupDraft, [getHomeKey(pickerSource)]: pathValue });
            setPickerSource(null);
          }}
          onClose={() => setPickerSource(null)}
        />
      )}

      <section className="command-panel" aria-label="세션 검색과 보기 전환">
        <section className="platform-panel" aria-label="도구 선택">
          <div className="source-tabs" role="tablist" aria-label="AI 도구 선택">
            {sourceOptions.map(({ value, label, caption, icon, Icon }) => {
              const selectedSource = filters.source === value;
              const total = value === "all" ? data?.totals.all : data?.totals.sources[value as SessionSource].all;
              return (
                <button
                  key={value}
                  className={selectedSource ? "selected" : ""}
                  aria-label={`${label} 세션 보기`}
                  onClick={() => setFilters({ ...filters, source: value, cwd: "" })}
                >
                  <span className="source-icon" aria-hidden="true">
                    {icon ? <img src={icon} alt="" /> : Icon ? <Icon size={17} /> : null}
                  </span>
                  <span className="source-copy">
                    <strong>{label}</strong>
                    {caption ? <small>{caption}</small> : null}
                  </span>
                  <span className="source-count" aria-label={`${(total ?? 0).toLocaleString("ko-KR")}개`}>
                    {(total ?? 0).toLocaleString("ko-KR")}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="search-row">
          <label className="search-label">
            <span>검색</span>
            <span className="input-with-icon">
              <Search size={16} />
              <input
                value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                placeholder="제목, 메시지, 경로"
              />
            </span>
          </label>
          <label className="select-filter project-label">
            <span className="filter-title">
              <FolderOpen size={15} /> 프로젝트
            </span>
            <span className="select-shell">
              <select value={filters.cwd} onChange={(event) => setFilters({ ...filters, cwd: event.target.value })}>
                <option value="">전체 프로젝트</option>
                {(data?.projects ?? []).map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="select-filter sort-label">
            <span className="filter-title">
              <ListFilter size={15} /> 정렬
            </span>
            <span className="select-shell">
              <select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value as SortKey })}>
                <option value="updatedDesc">마지막 대화 최신순</option>
                <option value="updatedAsc">마지막 대화 오래된순</option>
                <option value="createdDesc">생성일순</option>
                <option value="tokensDesc">토큰 많은순</option>
                <option value="tokensAsc">토큰 적은순</option>
                <option value="sizeDesc">파일 큰순</option>
                <option value="sizeAsc">파일 작은순</option>
              </select>
            </span>
          </label>
        </div>

        <div className="view-row">
          <div className="view-tabs" role="tablist" aria-label="세션 상태">
            <button
              aria-label="전체 보기"
              className={currentView === "all" ? "selected" : ""}
              onClick={() => setView("all", filters, setFilters)}
            >
              전체
              <small>삭제 대기 포함</small>
            </button>
            <button
              aria-label="활성 보기"
              className={currentView === "active" ? "selected" : ""}
              onClick={() => setView("active", filters, setFilters)}
            >
              활성
              <small>정리 전 기본 목록</small>
            </button>
            <button
              aria-label="삭제 대기 보기"
              className={currentView === "trash" ? "selected" : ""}
              onClick={() => setView("trash", filters, setFilters)}
            >
              삭제 대기
              <small>복구 또는 삭제</small>
            </button>
          </div>
          <button className="primary-button refresh-button" onClick={() => void refreshAll()} disabled={loading} aria-label="세션 목록 새로고침">
            <RefreshCw className={loading ? "loading-icon" : ""} size={18} /> 새로고침
          </button>
          {setup?.completed && (
            <button className="icon-text-button" onClick={() => setShowSetup(true)} aria-label="기록 경로 설정 열기">
              <Settings size={17} /> 경로 설정
            </button>
          )}
        </div>

        <div className="delete-help">
          <strong>삭제 방식</strong>
          <span>삭제 대기는 되돌릴 수 있고, 삭제는 선택한 AI의 실제 기록 파일까지 제거합니다.</span>
        </div>
      </section>

      {notice && (
        <div className="toast-region" aria-live="polite">
          <div className="toast" role="status">
            <span>{notice}</span>
            <button className="toast-close" onClick={() => setNotice("")} aria-label="알림 닫기">
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      {operation && <OperationBanner operation={operation} />}

      <section className={`workspace ${activeId ? "with-detail" : ""}`}>
        <section className="session-panel" aria-label="세션 목록">
          <div className="table-toolbar">
            <div>
              <strong>{sessions.length.toLocaleString("ko-KR")}개 표시</strong>
              <span>{filters.search ? `"${filters.search}" 검색 결과` : sortLabel[filters.sort]}</span>
            </div>
            <button
              className="icon-button"
              aria-label="표시된 세션 전체 선택"
              onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(sessions.map((session) => session.id)))}
            >
              <CheckSquare size={18} />
            </button>
          </div>

          {selected.size > 0 && (
            <div className="selection-bar">
              <div>
                <strong>{selected.size.toLocaleString("ko-KR")}개 선택</strong>
                {operation && <span>{formatOperationProgress(operation)}</span>}
              </div>
              <div className="bulk-actions">
                <button
                  className={selectedHasNormal ? "" : "hidden-action"}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void runBulk("삭제 대기 이동", (onProgress) => {
                      const ids = [...selected];
                      return postSessionIds("/api/trash", ids, onProgress);
                    }, {
                      preserveSelection: currentView === "all",
                      resetProject: true,
                      total: selected.size
                    })
                  }
                >
                  {busy === "삭제 대기 이동" ? <RefreshCw className="loading-icon" size={16} /> : <Trash2 size={16} />}
                  {busy === "삭제 대기 이동" ? "이동 중" : "삭제 대기로 이동"}
                </button>
                <button
                  className={selectedHasTrash ? "" : "hidden-action"}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void runBulk("복구", (onProgress) => {
                      const ids = [...selected];
                      return postSessionIds("/api/restore", ids, onProgress);
                    }, { total: selected.size })
                  }
                >
                  {busy === "복구" ? <RefreshCw className="loading-icon" size={16} /> : <RotateCcw size={16} />}
                  {busy === "복구" ? "복구 중" : "복구"}
                </button>
                <button
                  className="danger-button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    const ids = [...selected];
                    void runBulk("삭제", (onProgress) => postSessionIds("/api/delete-permanent", ids, onProgress), {
                      closeDetail: activeId ? ids.includes(activeId) : false,
                      resetProject: true,
                      total: ids.length
                    });
                  }}
                >
                  {busy === "삭제" ? <RefreshCw className="loading-icon" size={16} /> : <Trash2 size={16} />}
                  {busy === "삭제" ? "삭제 중" : "삭제"}
                </button>
                <button className="icon-button" aria-label="선택 해제" disabled={Boolean(busy)} onClick={() => setSelected(new Set())}>
                  <X size={17} />
                </button>
              </div>
            </div>
          )}

          <div className="table-wrap">
            <table>
              <colgroup>
                <col className="select-col" />
                <col className="title-col" />
                <col className="project-col" />
                <col className="date-col" />
                <col className="token-col" />
                <col className="size-col" />
                <col className="status-col" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="선택" />
                  <th>제목</th>
                  <th>프로젝트</th>
                  <th className="date-heading">
                    <SortHeader label="마지막 대화" descKey="updatedDesc" ascKey="updatedAsc" filters={filters} setFilters={setFilters} align="center" />
                  </th>
                  <th className="number-heading">
                    <SortHeader label="토큰" descKey="tokensDesc" ascKey="tokensAsc" filters={filters} setFilters={setFilters} align="end" />
                  </th>
                  <th className="number-heading">
                    <SortHeader label="크기" descKey="sizeDesc" ascKey="sizeAsc" filters={filters} setFilters={setFilters} align="end" />
                  </th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    selected={selected.has(session.id)}
                    active={activeId === session.id}
                    onToggle={() => toggleSelected(session.id, setSelected)}
                    onOpen={() => setActiveId(session.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {activeId && (
          <DetailPanel
            detail={detail}
            isLoading={detailLoading}
            error={detailError}
            busy={busy}
            isSummarizing={detail ? summarizingSessionId === detail.session.id : false}
            onClose={() => {
              setActiveId(null);
              setDetail(null);
              setDetailError("");
              setDetailLoading(false);
            }}
            onSummarize={(id) => void runBulk("요약", () => api.summary(id), { sessionId: id })}
            onMoveToTrash={(id) =>
              void runBulk("삭제 대기 이동", (onProgress) => postSessionIds("/api/trash", [id], onProgress), {
                preserveSelection: currentView === "all",
                resetProject: true,
                total: 1
              })
            }
            onRestore={(id) => void runBulk("복구", (onProgress) => postSessionIds("/api/restore", [id], onProgress), { total: 1 })}
            onDelete={(id) => {
              void runBulk("삭제", (onProgress) => postSessionIds("/api/delete-permanent", [id], onProgress), {
                closeDetail: true,
                resetProject: true,
                total: 1
              });
            }}
          />
        )}
      </section>
    </main>
  );
}

async function postSessionIds(path: string, sessionIds: string[], onProgress?: ProgressHandler) {
  const results: Array<{ sessionId: string; status: string; reason?: string }> = [];
  const chunkSize = 100;
  for (let index = 0; index < sessionIds.length; index += chunkSize) {
    const chunk = sessionIds.slice(index, index + chunkSize);
    const response = await api.post(path, { sessionIds: chunk });
    results.push(...response.results);
    onProgress?.(Math.min(index + chunk.length, sessionIds.length));
  }
  return { results };
}

function SetupPanel({
  setup,
  draft,
  busy,
  onDraftChange,
  onBrowse,
  onUseRecommended,
  onSave,
  onClose
}: {
  setup: SetupStateResponse;
  draft: SetupDraft;
  busy: boolean;
  onDraftChange: (draft: SetupDraft) => void;
  onBrowse: (source: SessionSource) => void;
  onUseRecommended: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const platformLabel = `${setup.platform}${setup.isWsl ? " / WSL" : ""}`;
  const readyCount = sourceOptions
    .filter((option) => option.value !== "all")
    .filter((option) => setup.sources[option.value as SessionSource].candidates.some((candidate) => candidate.status === "ready")).length;

  return (
    <section className="setup-panel" aria-label="첫 실행 기록 경로 설정">
      <div className="setup-heading">
        <div>
          <strong>기록 경로 설정</strong>
          <span>
            {platformLabel} 환경에서 AI 기록 폴더를 찾았습니다. 자동 추천을 저장하거나 경로를 직접 입력한 뒤 다시 스캔하세요.
          </span>
        </div>
        <div className="setup-actions">
          <button onClick={onUseRecommended} disabled={busy || readyCount === 0}>
            <RefreshCw className={busy ? "loading-icon" : ""} size={16} /> 추천 경로 저장
          </button>
          <button className="primary-button" onClick={onSave} disabled={busy}>
            {busy ? <RefreshCw className="loading-icon" size={16} /> : <Settings size={16} />} 저장 후 스캔
          </button>
          {setup.completed && (
            <button className="icon-button" onClick={onClose} disabled={busy} aria-label="경로 설정 닫기">
              <X size={17} />
            </button>
          )}
        </div>
      </div>

      <div className="setup-grid">
        {(["codex", "claude", "gemini"] as SessionSource[]).map((source) => {
          const sourceInfo = setup.sources[source];
          const homeKey = getHomeKey(source);
          return (
            <section className={`setup-source ${source}`} key={source}>
              <div className="setup-source-title">
                <SourceBadge source={source} />
                <strong>{sourceLabel[source]} 기록 위치</strong>
              </div>
              <label className="path-input-label">
                <span>{getFolderHint(source)}</span>
                <span className="path-edit-row">
                  <input
                    value={draft[homeKey]}
                    onChange={(event) => onDraftChange({ ...draft, [homeKey]: event.target.value })}
                    placeholder={sourceInfo.defaultPath}
                    aria-label={`${sourceLabel[source]} 기록 경로`}
                  />
                  <button type="button" onClick={() => onBrowse(source)} aria-label={`${sourceLabel[source]} 폴더 선택`}>
                    <FolderOpen size={16} /> 선택
                  </button>
                </span>
              </label>
              <div className="candidate-list">
                {sourceInfo.candidates.map((candidate) => (
                  <CandidateButton
                    key={`${source}:${candidate.path}`}
                    candidate={candidate}
                    active={candidate.path === draft[homeKey]}
                    onClick={() => onDraftChange({ ...draft, [homeKey]: candidate.path })}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function CandidateButton({
  candidate,
  active,
  onClick
}: {
  candidate: SetupPathCandidate;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`candidate-button ${candidate.status} ${active ? "selected" : ""}`} onClick={onClick}>
      <span className="candidate-status">{getCandidateStatusLabel(candidate)}</span>
      <span className="candidate-path">{candidate.path}</span>
      <small>{candidate.signals.length > 0 ? candidate.signals.join(" · ") : candidate.reason}</small>
    </button>
  );
}

function getDraftFromSetup(setup: SetupStateResponse): SetupDraft {
  return {
    codexHome: setup.sources.codex.currentPath,
    claudeHome: setup.sources.claude.currentPath,
    geminiHome: setup.sources.gemini.currentPath
  };
}

function getRecommendedDraft(setup: SetupStateResponse, fallback: SetupDraft): SetupDraft {
  const next = { ...fallback };
  for (const source of ["codex", "claude", "gemini"] as SessionSource[]) {
    const recommended = setup.sources[source].candidates.find((candidate) => candidate.recommended);
    if (recommended) next[getHomeKey(source)] = recommended.path;
  }
  return next;
}

function getHomeKey(source: SessionSource): keyof SetupDraft {
  return `${source}Home` as keyof SetupDraft;
}

function getFolderHint(source: SessionSource): string {
  if (source === "codex") return "state_5.sqlite 또는 sessions 폴더가 있는 폴더";
  if (source === "claude") return "projects 또는 transcripts 폴더가 있는 폴더";
  return "tmp 또는 history 폴더가 있는 폴더";
}

function getCandidateStatusLabel(candidate: SetupPathCandidate): string {
  const prefix = candidate.recommended ? "추천" : candidate.label;
  if (candidate.status === "ready") return `${prefix} · ${candidate.sessionCount.toLocaleString("ko-KR")}개`;
  if (candidate.status === "partial") return `${prefix} · 구조 확인`;
  return `${prefix} · 없음`;
}

function FolderPicker({
  source,
  initialPath,
  onPick,
  onClose
}: {
  source: SessionSource;
  initialPath: string;
  onPick: (pathValue: string) => void;
  onClose: () => void;
}) {
  const [pathValue, setPathValue] = useState(initialPath);
  const [browse, setBrowse] = useState<BrowseDirectoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(nextPath = pathValue) {
    setLoading(true);
    setError("");
    try {
      const response = await api.browseDirectory(source, nextPath);
      setBrowse(response);
      setPathValue(response.currentPath);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "폴더를 읽지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath);
  }, [source, initialPath]);

  const candidate = browse?.candidate;
  const sourceName = sourceLabel[source];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`${sourceName} 기록 폴더 선택`}>
      <section className={`folder-picker ${source}`}>
        <div className="folder-picker-head">
          <div>
            <span className="folder-picker-kicker">
              <SourceBadge source={source} />
              <span>로컬 기록 위치</span>
            </span>
            <strong>{sourceName} 기록 폴더 선택</strong>
            <span>{getFolderHint(source)}를 선택하세요.</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="폴더 선택 닫기">
            <X size={17} />
          </button>
        </div>

        <div className="folder-path-row">
          <input
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load(pathValue);
            }}
            aria-label={`${sourceName} 폴더 경로`}
          />
          <button onClick={() => void load(pathValue)} disabled={loading}>
            <RefreshCw className={loading ? "loading-icon" : ""} size={16} /> 열기
          </button>
        </div>

        {candidate && (
          <div className={`folder-current ${candidate.status}`}>
            <strong>{getCandidateStatusLabel(candidate)}</strong>
            <span>{candidate.signals.length > 0 ? candidate.signals.join(" · ") : candidate.reason}</span>
          </div>
        )}
        {error && <p className="folder-error">{error}</p>}

        <div className="folder-list" aria-label="하위 폴더 목록">
          {loading && (
            <div className="folder-loading">
              <RefreshCw className="loading-icon" size={16} /> 폴더를 읽고 있습니다.
            </div>
          )}
          {browse?.parentPath && (
            <button className="folder-row parent" onClick={() => void load(browse.parentPath || pathValue)} aria-label="상위 폴더 열기">
              <span>..</span>
              <small>상위 폴더</small>
            </button>
          )}
          {(browse?.entries ?? []).map((entry) => (
            <button className="folder-row" key={entry.path} onClick={() => void load(entry.path)} aria-label={`${entry.name} 폴더 열기`}>
              <span>{entry.name}</span>
              <small>{entry.hidden ? "숨김 폴더" : entry.path}</small>
            </button>
          ))}
          {browse && browse.entries.length === 0 && <p className="folder-empty">표시할 하위 폴더가 없습니다.</p>}
        </div>

        <div className="folder-picker-actions">
          <button onClick={onClose}>취소</button>
          <button className="primary-button" onClick={() => onPick(browse?.currentPath || pathValue)}>
            이 폴더 선택
          </button>
        </div>
      </section>
    </div>
  );
}

function OperationBanner({ operation }: { operation: OperationState }) {
  return (
    <div className="operation-banner" role="status" aria-live="polite">
      <RefreshCw className="loading-icon" size={18} />
      <div>
        <strong>{operation.label} 중</strong>
        <span>{getOperationMessage(operation)}</span>
      </div>
    </div>
  );
}

function getOperationMessage(operation: OperationState): string {
  const progress = formatOperationProgress(operation);
  const suffix = progress ? `${progress} ` : "";
  if (operation.label === "삭제") return `${suffix}실제 AI 기록 파일을 삭제하고 있습니다. 큰 세션이나 여러 개는 시간이 걸릴 수 있습니다.`;
  if (operation.label === "삭제 대기 이동") return `${suffix}선택한 세션을 삭제 대기로 이동하고 있습니다.`;
  if (operation.label === "복구") return `${suffix}선택한 세션을 복구하고 있습니다.`;
  if (operation.label === "요약") return "세션 내용을 읽고 요약을 생성하고 있습니다.";
  return `${suffix}작업을 처리하고 있습니다.`;
}

function formatOperationProgress(operation: OperationState): string {
  if (operation.total === null) return "";
  if (operation.total <= 1) return "처리 중";
  return `${operation.done.toLocaleString("ko-KR")} / ${operation.total.toLocaleString("ko-KR")}개 처리`;
}

function SessionRow({
  session,
  selected,
  active,
  onToggle,
  onOpen
}: {
  session: SessionSummaryRow;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <tr className={active ? "active-row" : ""}>
      <td>
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`${session.title} 선택`} />
      </td>
      <td>
        <button className="title-button" onClick={onOpen}>
          <span className="title-line">
            <SourceBadge source={session.source} />
            <span className="title-text">{session.title}</span>
          </span>
          <small>{session.lastUserMessage || session.firstUserMessage || session.id}</small>
        </button>
      </td>
      <td className="path-cell" title={session.cwd}>
        {shortPath(session.cwd)}
      </td>
      <td className="date-cell">{formatDate(session.updatedAt)}</td>
      <td className="number-cell token-cell" title={formatTokenTitle(session.tokensUsed)}>
        <MetricValue {...formatTokenParts(session.tokensUsed)} />
      </td>
      <td className="number-cell">
        <MetricValue {...formatBytesParts(session.fileSize)} />
      </td>
      <td>
        <StatusPills session={session} />
      </td>
    </tr>
  );
}

function SourceBadge({ source }: { source: SessionSource }) {
  return <span className={`source-badge ${source}`}>{sourceLabel[source]}</span>;
}

function SortHeader({
  label,
  descKey,
  ascKey,
  filters,
  setFilters,
  align
}: {
  label: string;
  descKey: SortKey;
  ascKey: SortKey;
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  align: "center" | "end";
}) {
  const activeDesc = filters.sort === descKey;
  const activeAsc = filters.sort === ascKey;
  const active = activeDesc || activeAsc;
  const next = activeDesc ? ascKey : descKey;
  return (
    <button
      className={`sort-header ${active ? "selected" : ""} ${align === "end" ? "end" : "center"}`}
      onClick={() => setFilters({ ...filters, sort: next })}
      aria-label={`${label} ${activeDesc ? "오름차순" : "내림차순"} 정렬`}
    >
      <span>{label}</span>
      {activeDesc ? <ArrowDown size={13} /> : activeAsc ? <ArrowUp size={13} /> : <ArrowDownUp size={13} />}
    </button>
  );
}

function MetricValue({ value, unit }: { value: string; unit?: string }) {
  return (
    <span className="metric-value">
      <span>{value}</span>
      {unit && <small>{unit}</small>}
    </span>
  );
}

function StatusPills({ session }: { session: SessionSummaryRow }) {
  return (
    <div className="pills">
      {session.archived && <span className="pill neutral">보관</span>}
      {session.trashed && <span className="pill danger">삭제 대기</span>}
      {!session.fileExists && <span className="pill warn">파일 없음</span>}
      {!session.archived && !session.trashed && session.fileExists && <span className="pill ok">정상</span>}
    </div>
  );
}

function DetailPanel({
  detail,
  isLoading,
  error,
  busy,
  isSummarizing,
  onClose,
  onSummarize,
  onMoveToTrash,
  onRestore,
  onDelete
}: {
  detail: SessionDetailResponse | null;
  isLoading: boolean;
  error: string;
  busy: string | null;
  isSummarizing: boolean;
  onClose: () => void;
  onSummarize: (id: string) => void;
  onMoveToTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showAllMessages, setShowAllMessages] = useState(false);
  useEffect(() => {
    setShowAllMessages(false);
  }, [detail?.session.id]);
  const visibleItems = detail && !showAllMessages ? detail.items.slice(-80) : detail?.items ?? [];
  const hiddenMessageCount = detail ? detail.items.length - visibleItems.length : 0;

  return (
    <aside className="detail-panel" aria-label="세션 상세">
      <div className="panel-heading">
        <Eye size={18} />
        <h2>상세</h2>
        <button className="icon-button close-button" onClick={onClose} aria-label="상세 닫기">
          <X size={17} />
        </button>
      </div>
      {!detail && (
        error ? (
          <p className="detail-error">상세를 불러오지 못했습니다: {error}</p>
        ) : (
          <p className="empty">
            {isLoading ? "세션 상세를 불러오는 중입니다." : "목록에서 세션을 선택하면 대화와 요약을 확인할 수 있습니다."}
          </p>
        )
      )}
      {detail && (
        <>
          <div className="detail-head">
            <strong>
              <SourceBadge source={detail.session.source} />
              {detail.session.title}
            </strong>
            <span>{detail.rawLineCount.toLocaleString("ko-KR")} lines · {formatBytes(detail.session.fileSize)}</span>
          </div>
          <div className="detail-actions">
            <button disabled={Boolean(busy)} onClick={() => onSummarize(detail.session.id)}>
              {isSummarizing ? <RefreshCw className="loading-icon" size={16} /> : <Sparkles size={16} />}
              {isSummarizing ? "요약 생성 중" : "요약 생성"}
            </button>
            {detail.session.trashed ? (
              <>
                <button disabled={Boolean(busy)} onClick={() => onRestore(detail.session.id)}>
                  <RotateCcw size={16} /> 복구
                </button>
                <button className="danger-button" disabled={Boolean(busy)} onClick={() => onDelete(detail.session.id)}>
                  <Trash2 size={16} /> 삭제
                </button>
              </>
            ) : (
              <>
                <button disabled={Boolean(busy)} onClick={() => onMoveToTrash(detail.session.id)}>
                  <Trash2 size={16} /> 삭제 대기로 이동
                </button>
                <button className="danger-button" disabled={Boolean(busy)} onClick={() => onDelete(detail.session.id)}>
                  <Trash2 size={16} /> 삭제
                </button>
              </>
            )}
          </div>
          <p className="delete-state-note">
            {detail.session.trashed
              ? "삭제 대기 상태입니다. 삭제를 누르면 바로 실제 기록을 삭제합니다."
              : "삭제 대기로 보내면 복구할 수 있고, 삭제를 누르면 바로 실제 기록을 삭제합니다."}
          </p>
          <SummaryView summary={detail.session.summary} isLoading={isSummarizing} />
          <div className="meta-list">
            <span>도구 {sourceLabel[detail.session.source]}</span>
            <span>생성 {formatDate(detail.session.createdAt)}</span>
            <span>모델 {detail.session.model || "unknown"}</span>
            <span title={detail.session.rolloutPath}>{shortPath(detail.session.rolloutPath)}</span>
          </div>
          <div className="messages">
            {hiddenMessageCount > 0 && (
              <div className="message-window-note">
                <span>최근 80개만 표시 중입니다. 전체 {detail.items.length.toLocaleString("ko-KR")}개 대화 항목이 있습니다.</span>
                <button onClick={() => setShowAllMessages(true)}>전체 보기</button>
              </div>
            )}
            {showAllMessages && detail.items.length > 80 && (
              <div className="message-window-note">
                <span>전체 대화 항목을 표시 중입니다.</span>
                <button onClick={() => setShowAllMessages(false)}>최근만 보기</button>
              </div>
            )}
            {visibleItems.map((item) => (
              <MessageItem key={item.id} item={item} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function SummaryView({ summary, isLoading }: { summary: string | null; isLoading: boolean }) {
  if (isLoading) {
    return (
      <section className="summary-card loading" aria-label="세션 요약" aria-busy="true">
        <div className="summary-loading">
          <RefreshCw className="loading-icon" size={18} />
          <div>
            <strong>요약 생성 중</strong>
            <span>요약 AI가 세션 내용을 읽고 있습니다. 큰 세션은 조금 걸릴 수 있습니다.</span>
          </div>
        </div>
      </section>
    );
  }

  if (!summary) {
    return (
      <section className="summary-card" aria-label="세션 요약">
        <div className="summary-empty">
          <strong>요약 없음</strong>
          <span>요약 생성을 누르면 세션 내용을 짧게 정리합니다.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="summary-card" aria-label="세션 요약">
      <div className="summary-section primary">
        <span>세션 요약</span>
        <p>{formatSummaryText(summary)}</p>
      </div>
    </section>
  );
}

function formatSummaryText(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => line.replace(/^(핵심 요청|최근 흐름|Codex 응답|주요 단서|요청|최근|응답|단서)\s*[:：]\s*/, ""))
    .join(" ");
}

function MessageItem({ item }: { item: DetailItem }) {
  return (
    <article className={`message ${item.kind}`}>
      <header>
        <strong>{item.label}</strong>
        {item.timestamp && <time>{formatDate(item.timestamp)}</time>}
      </header>
      <p>{item.text}</p>
    </article>
  );
}

type ViewMode = "active" | "all" | "trash";

function getCurrentView(filters: FilterState): ViewMode {
  if (filters.trash === "trashed") return "trash";
  if (filters.archive === "all" && filters.trash === "all") return "all";
  return "active";
}

function setView(
  view: ViewMode,
  filters: FilterState,
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>
) {
  const next: FilterState = { ...filters };
  if (view === "active") {
    next.archive = "active";
    next.trash = "normal";
  }
  if (view === "all") {
    next.archive = "all";
    next.trash = "all";
  }
  if (view === "trash") {
    next.archive = "all";
    next.trash = "trashed";
  }
  setFilters(next);
}

function toggleSelected(id: string, setSelected: React.Dispatch<React.SetStateAction<Set<string>>>) {
  setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "요청 실패");
  return body as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatBytesParts(value: number): { value: string; unit: string } {
  if (value < 1024) return { value: value.toLocaleString("ko-KR"), unit: "B" };
  if (value < 1024 * 1024) return { value: (value / 1024).toFixed(1), unit: "KB" };
  return { value: (value / 1024 / 1024).toFixed(1), unit: "MB" };
}

function formatTokenParts(value: number): { value: string; unit?: string } {
  if (value <= 0) return { value: "-" };
  if (value >= 1_000_000_000) return { value: trimDecimal(value / 1_000_000_000), unit: "B" };
  if (value >= 1_000_000) return { value: trimDecimal(value / 1_000_000), unit: "M" };
  if (value < 100_000) return { value: value.toLocaleString("ko-KR") };
  if (value >= 10_000) return { value: trimDecimal(value / 1_000), unit: "K" };
  if (value >= 1_000) return { value: trimDecimal(value / 1_000), unit: "K" };
  return { value: value.toLocaleString("ko-KR") };
}

function formatTokenTitle(value: number): string {
  if (value <= 0) return "원문에 토큰 정보가 없습니다.";
  return `${value.toLocaleString("ko-KR")} 토큰`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function shortPath(value: string): string {
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function formatResult(label: string, result: unknown): string {
  if (!result || typeof result !== "object" || !("results" in result)) return `${label} 완료`;
  const results = (result as { results: Array<{ status: string; reason?: string }> }).results;
  const done = results.filter((item) => item.status !== "skipped").length;
  const skipped = results.length - done;
  const reason = results.find((item) => item.reason)?.reason;
  return `${label} 완료: ${done}개 처리${skipped ? `, ${skipped}개 건너뜀` : ""}${reason ? ` · ${reason}` : ""}`;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found.");
window.__codexSessionManagerRoot ??= createRoot(rootElement);
window.__codexSessionManagerRoot.render(<App />);
