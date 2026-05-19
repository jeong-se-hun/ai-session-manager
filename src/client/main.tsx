import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CheckSquare,
  Eye,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import type {
  ArchiveFilter,
  DetailItem,
  DoctorIssue,
  DoctorResponse,
  SessionDetailResponse,
  SessionListResponse,
  SessionSummaryRow,
  SortKey,
  TrashFilter
} from "../shared/types";
import "./styles.css";

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
    return readResponse(await fetch(`/api/sessions/${id}`));
  },
  async summary(id: string): Promise<{ summary: string }> {
    return readResponse(await fetch(`/api/sessions/${id}/summary`, { method: "POST" }));
  },
  async doctor(): Promise<DoctorResponse> {
    return readResponse(await fetch("/api/doctor"));
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

const defaultFilters: FilterState = {
  search: "",
  cwd: "",
  from: "",
  to: "",
  archive: "active",
  trash: "normal",
  sort: "updatedDesc",
  limit: 500
};

function App() {
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [notice, setNotice] = useState<string>("");
  const busy = operation?.label ?? null;

  async function refresh(nextFilters = filters) {
    setLoading(true);
    try {
      const response = await api.list(nextFilters);
      setData(response);
      setSelected((prev) => new Set([...prev].filter((id) => response.sessions.some((session) => session.id === id))));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshDoctor() {
    try {
      setDoctor(await api.doctor());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "진단을 불러오지 못했습니다.");
    }
  }

  async function refreshAll() {
    const nextFilters = { ...filters, cwd: "" };
    setFilters(nextFilters);
    await Promise.all([refresh(nextFilters), refreshDoctor()]);
  }

  useEffect(() => {
    void refresh();
    void refreshDoctor();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(filters), 250);
    return () => window.clearTimeout(timer);
  }, [filters]);

  useEffect(() => {
    if (!activeId) return;
    api
      .detail(activeId)
      .then(setDetail)
      .catch((error) => setNotice(error instanceof Error ? error.message : "상세를 불러오지 못했습니다."));
  }, [activeId]);

  const selectedRows = useMemo(
    () => data?.sessions.filter((session) => selected.has(session.id)) ?? [],
    [data?.sessions, selected]
  );

  async function runBulk(
    label: string,
    action: (onProgress: ProgressHandler) => Promise<unknown>,
    options: { closeDetail?: boolean; preserveSelection?: boolean; resetProject?: boolean; total?: number | null } = {}
  ) {
    setOperation({ label, total: options.total ?? null, done: 0 });
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
      await refreshDoctor();
      if (options.closeDetail) {
        setActiveId(null);
        setDetail(null);
      } else if (activeId) {
        setDetail(await api.detail(activeId));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label} 작업에 실패했습니다.`);
    } finally {
      setOperation(null);
    }
  }

  const sessions = data?.sessions ?? [];
  const allVisibleSelected = sessions.length > 0 && sessions.every((session) => selected.has(session.id));
  const currentView = getCurrentView(filters);
  const selectedHasTrash = selectedRows.some((row) => row.trashed);
  const selectedHasNormal = selectedRows.some((row) => !row.trashed);

  return (
    <main className="app-shell" aria-busy={Boolean(operation)}>
      <section className="topbar" aria-labelledby="page-title">
        <div>
          <h1 id="page-title">Codex 세션 관리자</h1>
          <p className="subtitle">
            {data
              ? `전체 ${data.totals.all.toLocaleString("ko-KR")}개 · 삭제 대기 ${data.totals.trashed.toLocaleString("ko-KR")}개 · 누락 ${data.totals.missingFiles.toLocaleString("ko-KR")}개`
              : "Codex 세션을 불러오는 중입니다."}
          </p>
        </div>
        <div className="top-actions">
          <button className="secondary-button inline" onClick={() => setShowAdvanced((value) => !value)}>
            <SlidersHorizontal size={18} /> 고급
          </button>
          <button className="primary-button" onClick={() => void refreshAll()} disabled={loading} aria-label="세션 목록과 기록 상태 새로고침">
            <RefreshCw size={18} /> 새로고침
          </button>
        </div>
      </section>

      <section className="command-panel" aria-label="세션 검색과 보기 전환">
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
          <label className="project-label">
            <span>프로젝트</span>
            <select value={filters.cwd} onChange={(event) => setFilters({ ...filters, cwd: event.target.value })}>
              <option value="">전체 프로젝트</option>
              {(data?.projects ?? []).map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </label>
        </div>

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

        <div className="delete-help">
          <strong>삭제 방식</strong>
          <span>삭제 대기로 보내면 복구할 수 있고, 삭제를 누르면 바로 실제 Codex 기록이 삭제됩니다.</span>
        </div>

        {showAdvanced && (
          <div className="advanced-panel">
            <div className="advanced-group">
              <span className="advanced-label">기간</span>
              <div className="segmented">
                <button className={!filters.from && !filters.to ? "selected" : ""} onClick={() => setPeriod("all", filters, setFilters)}>
                  전체 기간
                </button>
                <button className={isPeriod(filters, 7) ? "selected" : ""} onClick={() => setPeriod("7", filters, setFilters)}>
                  최근 7일
                </button>
                <button className={isPeriod(filters, 30) ? "selected" : ""} onClick={() => setPeriod("30", filters, setFilters)}>
                  최근 30일
                </button>
              </div>
            </div>
            <label>
              정렬
              <select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value as SortKey })}>
                <option value="updatedDesc">최신순</option>
                <option value="updatedAsc">오래된순</option>
                <option value="createdDesc">생성일순</option>
                <option value="tokensDesc">토큰 많은순</option>
                <option value="tokensAsc">토큰 적은순</option>
                <option value="sizeDesc">파일 큰순</option>
                <option value="sizeAsc">파일 작은순</option>
              </select>
            </label>
            <label>
              표시
              <select value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: Number(event.target.value) })}>
                <option value={100}>100개</option>
                <option value={300}>300개</option>
                <option value={500}>500개</option>
                <option value={1000}>1000개</option>
                <option value={2000}>2000개</option>
              </select>
            </label>
            <button className="secondary-button inline" onClick={() => setFilters(defaultFilters)}>
              <RotateCcw size={16} /> 초기화
            </button>
            <details className="manual-date">
              <summary>직접 날짜 지정</summary>
              <div>
                <label>
                  시작일
                  <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
                </label>
                <label>
                  종료일
                  <input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
                </label>
              </div>
            </details>
            <DoctorPanel doctor={doctor} compact />
          </div>
        )}
      </section>

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {operation && <OperationBanner operation={operation} />}

      <section className={`workspace ${detail ? "with-detail" : ""}`}>
        <section className="session-panel" aria-label="세션 목록">
          <div className="table-toolbar">
            <div>
              <strong>{sessions.length.toLocaleString("ko-KR")}개 표시</strong>
              <span>{filters.search ? `"${filters.search}" 검색 결과` : "최근 대화 기준"}</span>
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

        {detail && (
          <DetailPanel
            detail={detail}
            busy={busy}
            onClose={() => {
              setActiveId(null);
              setDetail(null);
            }}
            onSummarize={(id) => void runBulk("요약", () => api.summary(id))}
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
  if (operation.label === "삭제") return `${suffix}실제 Codex 기록을 삭제하고 있습니다. 큰 세션이나 여러 개는 시간이 걸릴 수 있습니다.`;
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

function DoctorPanel({ doctor, compact = false }: { doctor: DoctorResponse | null; compact?: boolean }) {
  return (
    <div className={`doctor ${compact ? "compact" : ""}`}>
      <div className="panel-heading">
        <ShieldAlert size={18} />
        <h2>정합성 진단</h2>
      </div>
      <p className="doctor-note">Codex 목록 기록과 실제 대화 파일이 서로 맞는지 확인한 결과입니다. 자동으로 삭제되지는 않습니다.</p>
      {!doctor && <p className="muted">진단 대기 중</p>}
      {doctor?.issues.map((issue) => {
        const copy = getDoctorCopy(issue);
        return (
          <div key={`${issue.title}-${issue.detail}`} className={`doctor-issue ${issue.level}`}>
            <strong>{copy.title}</strong>
            <p>{copy.short}</p>
            <details className="doctor-more">
              <summary>자세히</summary>
              <p>{copy.detail}</p>
            </details>
          </div>
        );
      })}
    </div>
  );
}

function getDoctorCopy(issue: DoctorIssue): { title: string; short: string; detail: string } {
  if (issue.title.includes("목록에는 있으나 대화 파일이 없는 세션")) {
    return {
      title: "목록만 남고 대화 파일이 없는 세션",
      short: countPrefix(issue.detail, "개") + " 목록에는 있지만 대화 파일이 없어 상세/요약이 안 될 수 있습니다.",
      detail: "Codex가 세션 목록에는 이 기록을 알고 있는데, 실제 대화가 저장된 rollout JSONL 파일은 못 찾은 상태입니다. 필요 없는 항목이면 삭제 대기로 보내거나 삭제로 목록 흔적까지 정리합니다."
    };
  }
  if (issue.title.includes("대화 파일은 있으나 목록에는 없는 세션")) {
    return {
      title: "대화 파일만 남고 목록에는 없는 세션",
      short: countPrefix(issue.detail, "개") + " 목록에는 안 보이지만 파일만 남아 용량을 차지할 수 있습니다.",
      detail: "실제 대화 파일은 디스크에 남아 있는데 Codex 목록 기록과 연결되지 않은 상태입니다. 아직 앱에서 직접 정리하지 않고, 필요한 파일인지 확인한 뒤 고아 파일 정리 대상으로 다루는 편이 안전합니다."
    };
  }
  if (issue.title.includes("정합성 양호")) {
    return {
      title: "문제 없음",
      short: "목록 기록과 대화 파일 연결에 눈에 띄는 문제가 없습니다.",
      detail: "별도 조치 없이 사용하면 됩니다."
    };
  }
  if (issue.title.includes("삭제 대기")) {
    return {
      title: "삭제 대기 중인 세션",
      short: countPrefix(issue.detail, "개") + " 아직 실제 삭제된 것은 아니며 복구할 수 있습니다.",
      detail: "삭제 대기 탭에서 복구하거나, 실제로 지울 항목만 선택해서 삭제하면 됩니다."
    };
  }
  return {
    title: issue.title,
    short: issue.detail,
    detail: "내용을 확인한 뒤 필요할 때만 삭제 대기 또는 삭제를 실행합니다."
  };
}

function countPrefix(text: string, suffix: string): string {
  const match = text.match(/(\d+)\s*개/);
  return match ? `${Number(match[1]).toLocaleString("ko-KR")}${suffix}` : "";
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
          <span>{session.title}</span>
          <small>{session.lastUserMessage || session.firstUserMessage || session.id}</small>
        </button>
      </td>
      <td className="path-cell" title={session.cwd}>
        {shortPath(session.cwd)}
      </td>
      <td className="date-cell">{formatDate(session.updatedAt)}</td>
      <td className="number-cell">
        <MetricValue value={session.tokensUsed.toLocaleString("ko-KR")} />
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
  busy,
  onClose,
  onSummarize,
  onMoveToTrash,
  onRestore,
  onDelete
}: {
  detail: SessionDetailResponse | null;
  busy: string | null;
  onClose: () => void;
  onSummarize: (id: string) => void;
  onMoveToTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isSummarizing = busy === "요약";
  return (
    <aside className="detail-panel" aria-label="세션 상세">
      <div className="panel-heading">
        <Eye size={18} />
        <h2>상세</h2>
        <button className="icon-button close-button" onClick={onClose} aria-label="상세 닫기">
          <X size={17} />
        </button>
      </div>
      {!detail && <p className="empty">목록에서 세션을 선택하면 대화와 요약을 확인할 수 있습니다.</p>}
      {detail && (
        <>
          <div className="detail-head">
            <strong>{detail.session.title}</strong>
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
            <span>생성 {formatDate(detail.session.createdAt)}</span>
            <span>모델 {detail.session.model || "unknown"}</span>
            <span title={detail.session.rolloutPath}>{shortPath(detail.session.rolloutPath)}</span>
          </div>
          <div className="messages">
            {detail.items.slice(-80).map((item) => (
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
            <span>Codex CLI가 세션 내용을 읽고 있습니다. 큰 세션은 조금 걸릴 수 있습니다.</span>
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

function setPeriod(
  period: "all" | "7" | "30",
  filters: FilterState,
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>
) {
  if (period === "all") {
    setFilters({ ...filters, from: "", to: "" });
    return;
  }
  const days = Number(period);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  setFilters({ ...filters, from: toDateInput(start), to: toDateInput(end) });
}

function isPeriod(filters: FilterState, days: number): boolean {
  if (!filters.from || !filters.to) return false;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  return filters.from === toDateInput(start) && filters.to === toDateInput(end);
}

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

createRoot(document.getElementById("root")!).render(<App />);
