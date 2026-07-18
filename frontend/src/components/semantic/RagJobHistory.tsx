import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, History, Loader2, RefreshCw } from "lucide-react";
import { listRagJobs, type RagJob } from "../../services/semanticApi";
import "../../styles/rag-job-history.css";

export type RagJobHistoryProps = {
  datasetId: string;
  refreshToken?: string | number;
  onLatestJobSettled?: (job: RagJob) => void;
};

type HistoryState = {
  datasetId: string;
  jobs: RagJob[];
  loading: boolean;
  error: string | null;
};

type TimelineState = "active" | "cancelled" | "complete" | "failed" | "pending";

type SettledDedupeScope = {
  datasetId: string;
  notifiedJobIds: Set<string>;
  snapshotKeys: Set<string>;
};

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

const TIMELINE_STAGES = [
  { key: "queued", label: "대기" },
  { key: "staging", label: "원문 준비" },
  { key: "chunking", label: "청킹" },
  { key: "embedding", label: "임베딩" },
  { key: "indexing", label: "VectorDB 저장" },
  { key: "validating", label: "검증" },
  { key: "ready", label: "완료" },
] as const;

const STAGE_INDEX: Record<string, number> = {
  queued: 0,
  pending: 0,
  requested: 0,
  dispatching: 0,
  staging: 1,
  parent_staging: 1,
  parent_staged: 1,
  preparing_source: 1,
  source_preparation: 1,
  source_ready: 1,
  reading_source: 1,
  chunking: 2,
  chunked: 2,
  embedding: 3,
  embeddings: 3,
  embedding_generation: 3,
  indexing: 4,
  storing: 4,
  vector_indexing: 4,
  vector_db: 4,
  vector_db_storage: 4,
  validating: 5,
  validation: 5,
  activating: 5,
  ready: 6,
  complete: 6,
  completed: 6,
  done: 6,
  success: 6,
  succeeded: 6,
};

const STATUS_LABELS: Record<string, string> = {
  queued: "대기",
  pending: "대기",
  staging: "원문 준비 중",
  chunking: "청킹 중",
  embedding: "임베딩 중",
  indexing: "VectorDB 저장 중",
  validating: "검증 중",
  activating: "활성화 중",
  running: "진행 중",
  ready: "완료",
  complete: "완료",
  completed: "완료",
  done: "완료",
  success: "완료",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
  canceled: "취소됨",
  aborted: "중단됨",
};

const VALIDATION_LABELS: Record<string, string> = {
  none: "검증 전",
  pending: "검증 대기",
  validating: "검증 중",
  passed: "검증 통과",
  success: "검증 통과",
  succeeded: "검증 통과",
  failed: "검증 실패",
};

const ACTIVATION_LABELS: Record<string, string> = {
  none: "활성화 전",
  pending: "활성화 중",
  activating: "활성화 중",
  in_progress: "활성화 중",
  committed: "활성화 완료",
  active: "활성화 완료",
  failed: "활성화 실패",
};

const COMPLETION_STAGE_VALUES = new Set(["ready", "complete", "completed", "done", "success", "succeeded"]);

const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const COUNT_FORMATTER = new Intl.NumberFormat("ko-KR");
const PERCENT_FORMATTER = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isFailedJob(job: RagJob) {
  return normalize(job.status) === "failed";
}

function isCancelledJob(job: RagJob) {
  return normalize(job.status) === "canceled";
}

function isSuccessfulJob(job: RagJob) {
  return job.isComplete === true
    && normalize(job.status) === "ready"
    && normalize(job.stage) === "ready"
    && normalize(job.validationStatus) === "passed"
    && normalize(job.activationStatus) === "committed"
    && Boolean(job.completedAt);
}

function isTerminalJob(job: RagJob) {
  return isSuccessfulJob(job) || isFailedJob(job) || isCancelledJob(job);
}

function isSettledCallbackJob(job: RagJob) {
  return isTerminalJob(job);
}

function statusLabel(value: string) {
  const normalized = normalize(value);
  return STATUS_LABELS[normalized] ?? (value ? `알 수 없음 · ${value}` : "상태 미확인");
}

function jobStatusLabel(job: RagJob) {
  if (isSuccessfulJob(job)) return "완료";
  if (normalize(job.status) === "ready" || normalize(job.stage) === "ready") return "완료 확인 중";
  return statusLabel(job.status);
}

function modeLabel(value: string) {
  const normalized = normalize(value);
  if (normalized === "reindex") return "재색인";
  if (normalized === "index") return "색인";
  return value ? `RAG 작업 · ${value}` : "RAG 작업";
}

function currentStageLabel(job: RagJob) {
  if (isFailedJob(job)) return "작업 실패";
  if (isCancelledJob(job)) return "작업 취소";
  if (isSuccessfulJob(job)) return "완료";
  if (normalize(job.status) === "ready" || normalize(job.stage) === "ready") return "완료 조건 확인";
  const index = STAGE_INDEX[normalize(job.stage)];
  if (index !== undefined) return TIMELINE_STAGES[index].label;
  return job.stage ? `단계 미확인 · ${job.stage}` : "단계 미확인";
}

function translatedValue(value: string, labels: Record<string, string>, fallback: string) {
  const normalized = normalize(value);
  return labels[normalized] ?? (value ? `${fallback} · ${value}` : fallback);
}

function progressValue(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function determinateProgress(job: RagJob) {
  if (job.progressDeterminate !== true || typeof job.progressPercent !== "number" || !Number.isFinite(job.progressPercent)) {
    return null;
  }
  return progressValue(job.progressPercent);
}

function formatProgress(value: number) {
  return `${PERCENT_FORMATTER.format(value)}%`;
}

function progressAnnouncement(job: RagJob) {
  const progress = determinateProgress(job);
  return progress === null
    ? "수치 진행률이 제공되지 않아 단계 상태로 표시됩니다"
    : `처리 진행률 ${formatProgress(progress)}입니다`;
}

function formatCount(value: number) {
  return Number.isFinite(value) ? COUNT_FORMATTER.format(value) : "-";
}

function timestamp(value: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRecentJobs(left: RagJob, right: RagJob) {
  const createdDifference = timestamp(right.createdAt) - timestamp(left.createdAt);
  if (createdDifference !== 0) return createdDifference;
  const updatedDifference = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (updatedDifference !== 0) return updatedDifference;
  return left.jobId.localeCompare(right.jobId);
}

function formatDate(value: string | null) {
  const parsed = timestamp(value);
  return parsed ? DATE_FORMATTER.format(parsed) : "기록 없음";
}

function embeddingLabel(job: RagJob) {
  const values = [job.embeddingProvider, job.embeddingModel].filter((value): value is string => Boolean(value?.trim()));
  if (Number.isFinite(job.embeddingDimensions) && Number(job.embeddingDimensions) > 0) {
    values.push(`${COUNT_FORMATTER.format(Number(job.embeddingDimensions))}차원`);
  }
  return values.length > 0 ? values.join(" · ") : "임베딩 모델 정보 없음";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "RAG 작업 이력을 불러오지 못했습니다.";
}

function timelineIndex(job: RagJob) {
  if (isSuccessfulJob(job)) return TIMELINE_STAGES.length - 1;
  const normalizedStage = normalize(job.stage);
  if (COMPLETION_STAGE_VALUES.has(normalizedStage)) return TIMELINE_STAGES.length - 2;
  const directIndex = STAGE_INDEX[normalizedStage];
  if (directIndex !== undefined) return directIndex;
  if (normalize(job.validationStatus) === "failed" || normalize(job.activationStatus) === "failed") return 5;
  return -1;
}

function timelineState(job: RagJob, stageIndex: number, currentIndex: number): TimelineState {
  if (isSuccessfulJob(job)) return "complete";
  if (currentIndex >= 0 && stageIndex < currentIndex) return "complete";
  if (currentIndex !== stageIndex) return "pending";
  if (isFailedJob(job)) return "failed";
  if (isCancelledJob(job)) return "cancelled";
  return "active";
}

function toneFor(job: RagJob) {
  if (isFailedJob(job)) return "failed";
  if (isCancelledJob(job)) return "cancelled";
  if (isSuccessfulJob(job)) return "complete";
  return "active";
}

function JobTimeline({ job }: { job: RagJob }) {
  const currentIndex = timelineIndex(job);
  const hasUnknownStop = currentIndex < 0 && (isFailedJob(job) || isCancelledJob(job));

  return (
    <div className="rag-job-history-timeline-wrap">
      <ol className="rag-job-history-timeline" aria-label={`${modeLabel(job.requestedMode)} 단계 타임라인`}>
        {TIMELINE_STAGES.map((stage, index) => {
          const state = timelineState(job, index, currentIndex);
          return (
            <li
              className={`rag-job-history-timeline-step is-${state}`}
              key={stage.key}
              aria-current={["active", "cancelled", "failed"].includes(state) ? "step" : undefined}
            >
              <span className="rag-job-history-timeline-dot" aria-hidden="true" />
              <span>{stage.label}</span>
              <span className="rag-job-history-sr-only">
                {state === "complete" ? "완료" : state === "active" ? "진행 중" : state === "failed" ? "실패" : state === "cancelled" ? "취소" : "대기"}
              </span>
            </li>
          );
        })}
      </ol>
      {hasUnknownStop && (
        <p className="rag-job-history-timeline-note">
          중단된 단계가 API에 기록되지 않아 완료 단계를 임의로 추정하지 않습니다.
        </p>
      )}
    </div>
  );
}

function JobProgress({ job, progress, terminal }: { job: RagJob; progress: number | null; terminal: boolean }) {
  return (
    <>
      <div className="rag-job-history-progress-head">
        <div>
          <span>현재 단계</span>
          <strong>{currentStageLabel(job)}</strong>
        </div>
        <strong>{progress === null ? "측정값 없음" : formatProgress(progress)}</strong>
      </div>
      {progress === null ? (
        <div
          className={`rag-job-history-indeterminate${terminal ? " is-settled" : " is-active"}`}
          role="status"
          aria-label={`${modeLabel(job.requestedMode)} 수치 진행률 미제공`}
        >
          <span className="rag-job-history-indeterminate-track" aria-hidden="true"><span /></span>
          <span>{terminal ? "수치 진행률 없이 종료됨" : "처리량 측정값을 기다리는 중"}</span>
        </div>
      ) : (
        <div
          className="rag-job-history-progress-track"
          role="progressbar"
          aria-label={`${modeLabel(job.requestedMode)} 실측 처리 진행률`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={formatProgress(progress)}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
    </>
  );
}

function JobFacts({ job }: { job: RagJob }) {
  return (
    <>
      <dl className="rag-job-history-counts" aria-label="작업 처리 수량">
        <div><dt>문서 수</dt><dd>{formatCount(job.documentCount)}</dd></div>
        <div><dt>원문 수</dt><dd>{formatCount(job.parentCount)}</dd></div>
        <div><dt>청크 수</dt><dd>{formatCount(job.chunkCount)}</dd></div>
        <div><dt>색인 수</dt><dd>{formatCount(job.indexedCount)}</dd></div>
        <div className={job.failedCount > 0 ? "has-warning" : undefined}><dt>실패 수</dt><dd>{formatCount(job.failedCount)}</dd></div>
        <div className={job.fallbackCount > 0 ? "has-fallback" : undefined}><dt>대체 처리 수</dt><dd>{formatCount(job.fallbackCount)}</dd></div>
      </dl>
      <dl className="rag-job-history-metadata">
        <div><dt>임베딩 모델</dt><dd>{embeddingLabel(job)}</dd></div>
        <div><dt>검증</dt><dd>{translatedValue(job.validationStatus, VALIDATION_LABELS, "검증 상태 미확인")}</dd></div>
        <div><dt>색인 활성화</dt><dd>{translatedValue(job.activationStatus, ACTIVATION_LABELS, "활성화 상태 미확인")}</dd></div>
      </dl>
      {(job.error || isFailedJob(job)) && (
        <div className="rag-job-history-job-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div><strong>오류 내용</strong><p>{job.error || "오류 상세가 기록되지 않았습니다."}</p></div>
        </div>
      )}
      <footer className="rag-job-history-footer">
        <code title={job.jobId}>작업 ID · {job.jobId}</code>
        <span>요청 · {formatDate(job.createdAt)}</span>
        <span>최근 갱신 · {formatDate(job.updatedAt)}</span>
        {job.completedAt && <span>종료 · {formatDate(job.completedAt)}</span>}
      </footer>
    </>
  );
}

function JobDetails({ job, index }: { job: RagJob; index: number }) {
  const progress = determinateProgress(job);
  const terminal = isTerminalJob(job);
  const tone = toneFor(job);
  const [open, setOpen] = useState(index === 0 || !terminal);

  return (
    <li className="rag-job-history-item">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="rag-job-history-summary">
          <span className="rag-job-history-identity">
            <span className="rag-job-history-mode">{modeLabel(job.requestedMode)}</span>
            <strong>{formatDate(job.createdAt)}</strong>
            <code title={job.jobId}>{job.jobId}</code>
          </span>
          <span className="rag-job-history-summary-status">
            <span className={`rag-job-history-status is-${tone}`}>{jobStatusLabel(job)}</span>
            <span>{currentStageLabel(job)}</span>
          </span>
          <span className="rag-job-history-summary-progress">
            <strong>{progress === null ? (terminal ? "종료" : "진행 중") : formatProgress(progress)}</strong>
            <span>{progress === null ? "수치 진행률 없음" : "실측 처리 진행률"}</span>
          </span>
          <ChevronDown className="rag-job-history-chevron" aria-hidden="true" />
        </summary>

        <div className="rag-job-history-detail">
          <JobProgress job={job} progress={progress} terminal={terminal} />
          <JobTimeline job={job} />
          <JobFacts job={job} />
        </div>
      </details>
    </li>
  );
}

function useRagHistory(requestDatasetId: string, refreshToken: string | number | undefined, retryToken: number) {
  const [history, setHistory] = useState<HistoryState>({ datasetId: "", jobs: [], loading: false, error: null });
  const latestSuccessfulJobsRef = useRef<{ datasetId: string; jobs: RagJob[] }>({ datasetId: "", jobs: [] });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let requestController: AbortController | null = null;

    if (latestSuccessfulJobsRef.current.datasetId !== requestDatasetId) {
      latestSuccessfulJobsRef.current = { datasetId: requestDatasetId, jobs: [] };
    }
    let lastSuccessfulJobs = latestSuccessfulJobsRef.current.jobs;
    setHistory((current) => current.datasetId === requestDatasetId
      ? { ...current, loading: Boolean(requestDatasetId), error: null }
      : { datasetId: requestDatasetId, jobs: [], loading: Boolean(requestDatasetId), error: null });
    if (!requestDatasetId) return undefined;

    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const loadJobs = async () => {
      clearTimer();
      const controller = new AbortController();
      requestController = controller;
      try {
        const response = await listRagJobs(requestDatasetId, { signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS });
        if (cancelled || controller.signal.aborted) return;
        if (!Array.isArray(response)) throw new Error("RAG 작업 이력 응답 형식이 올바르지 않습니다.");
        lastSuccessfulJobs = response;
        latestSuccessfulJobsRef.current = { datasetId: requestDatasetId, jobs: response };
        setHistory({ datasetId: requestDatasetId, jobs: response, loading: false, error: null });
        if (response.some((job) => !isTerminalJob(job))) {
          timer = window.setTimeout(() => void loadJobs(), POLL_INTERVAL_MS);
        }
      } catch (requestError) {
        if (cancelled || controller.signal.aborted) return;
        setHistory((current) => current.datasetId === requestDatasetId
          ? { ...current, loading: false, error: errorMessage(requestError) }
          : current);
        if (lastSuccessfulJobs.some((job) => !isTerminalJob(job))) {
          timer = window.setTimeout(() => void loadJobs(), POLL_INTERVAL_MS);
        }
      } finally {
        if (requestController === controller) requestController = null;
      }
    };

    void loadJobs();
    return () => {
      cancelled = true;
      clearTimer();
      requestController?.abort();
    };
  }, [refreshToken, requestDatasetId, retryToken]);

  return history.datasetId === requestDatasetId
    ? history
    : { datasetId: requestDatasetId, jobs: [], loading: Boolean(requestDatasetId), error: null };
}

function useLatestSettledNotification(
  requestDatasetId: string,
  latestJob: RagJob | undefined,
  onLatestJobSettled: RagJobHistoryProps["onLatestJobSettled"],
) {
  const settledDedupeRef = useRef<SettledDedupeScope>({
    datasetId: "",
    notifiedJobIds: new Set(),
    snapshotKeys: new Set(),
  });
  useEffect(() => {
    if (settledDedupeRef.current.datasetId !== requestDatasetId) {
      settledDedupeRef.current = { datasetId: requestDatasetId, notifiedJobIds: new Set(), snapshotKeys: new Set() };
    }
    if (!latestJob || !onLatestJobSettled || !isSettledCallbackJob(latestJob)) return;
    const scope = settledDedupeRef.current;
    const snapshotKey = `${latestJob.jobId}\u0000${normalize(latestJob.status)}\u0000${latestJob.updatedAt}`;
    if (scope.snapshotKeys.has(snapshotKey) || scope.notifiedJobIds.has(latestJob.jobId)) return;
    scope.snapshotKeys.add(snapshotKey);
    scope.notifiedJobIds.add(latestJob.jobId);
    onLatestJobSettled(latestJob);
  }, [latestJob, onLatestJobSettled, requestDatasetId]);
}

export function RagJobHistory({ datasetId, refreshToken, onLatestJobSettled }: RagJobHistoryProps) {
  const titleId = useId();
  const requestDatasetId = datasetId.trim();
  const [retryToken, setRetryToken] = useState(0);
  const visibleHistory = useRagHistory(requestDatasetId, refreshToken, retryToken);
  const sortedJobs = useMemo(
    () => [...visibleHistory.jobs].sort(compareRecentJobs),
    [visibleHistory.jobs],
  );
  const hasActiveJobs = sortedJobs.some((job) => !isTerminalJob(job));
  const latestJob = sortedJobs[0];
  useLatestSettledNotification(requestDatasetId, latestJob, onLatestJobSettled);

  return (
    <section className="rag-job-history" aria-busy={visibleHistory.loading} aria-labelledby={titleId}>
      <header className="rag-job-history-header">
        <div className="rag-job-history-heading">
          <span className="rag-job-history-heading-icon" aria-hidden="true"><History /></span>
          <div>
            <h2 id={titleId}>RAG 작업 이력</h2>
            <p>최근 재색인·청킹·임베딩·색인·검증 작업을 최대 30건까지 표시합니다.</p>
          </div>
        </div>
        {(hasActiveJobs || (visibleHistory.loading && sortedJobs.length > 0)) && (
          <span className="rag-job-history-live-status">
            <Loader2 aria-hidden="true" />
            {hasActiveJobs ? "진행 중 · 자동 갱신" : "새로고침 중"}
          </span>
        )}
      </header>

      {!requestDatasetId ? (
        <div className="rag-job-history-state">
          <History aria-hidden="true" />
          <strong>데이터셋을 선택해 주세요</strong>
          <p>선택한 데이터셋의 RAG 작업 이력이 여기에 표시됩니다.</p>
        </div>
      ) : visibleHistory.loading && sortedJobs.length === 0 ? (
        <div className="rag-job-history-state" role="status">
          <Loader2 className="rag-job-history-spinner" aria-hidden="true" />
          <strong>작업 이력을 불러오는 중입니다</strong>
          <p>최근 RAG 작업 상태를 확인하고 있습니다.</p>
        </div>
      ) : visibleHistory.error && sortedJobs.length === 0 ? (
        <div className="rag-job-history-state is-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>작업 이력을 불러오지 못했습니다</strong>
          <p>{visibleHistory.error}</p>
          <button type="button" onClick={() => setRetryToken((value) => value + 1)}>
            <RefreshCw aria-hidden="true" /> 다시 시도
          </button>
        </div>
      ) : sortedJobs.length === 0 ? (
        <div className="rag-job-history-state">
          <History aria-hidden="true" />
          <strong>아직 RAG 작업 이력이 없습니다</strong>
          <p>색인 또는 재색인을 시작하면 작업 단계와 처리 결과가 표시됩니다.</p>
        </div>
      ) : (
        <>
          {visibleHistory.error && (
            <div className="rag-job-history-refresh-error" role="alert">
              <AlertTriangle aria-hidden="true" />
              <span><strong>최신 상태를 갱신하지 못했습니다.</strong> 진행 중 작업은 자동으로 다시 확인합니다. {visibleHistory.error}</span>
              <button type="button" onClick={() => setRetryToken((value) => value + 1)}>
                <RefreshCw aria-hidden="true" /> 지금 재시도
              </button>
            </div>
          )}
          {latestJob && (
            <p className="rag-job-history-sr-only" aria-live="polite">
              최신 RAG 작업은 {jobStatusLabel(latestJob)}, {currentStageLabel(latestJob)}이며, {progressAnnouncement(latestJob)}
            </p>
          )}
          <ol className="rag-job-history-list">
            {sortedJobs.map((job, index) => (
              <JobDetails job={job} index={index} key={`${requestDatasetId}:${job.jobId}`} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
