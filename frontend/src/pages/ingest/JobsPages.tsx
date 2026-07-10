import { Fragment, useCallback, useMemo, useState } from "react";
import type React from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Header,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  CircleUser,
  Clock3,
  Database,
  Download,
  ExternalLink,
  HardDrive,
  Info,
  LayoutGrid,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Star,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
  X,
} from "lucide-react";
import { Field, PageTitle } from "../../components/common";
import { getCellphonesReviewAnalysis, runCellphonesReviewAnalysis, type ReviewAnalysisSummary } from "../../services/reviewAnalysisApi";
import type { AuditResult, JobCommand, JobDagStep, JobDagStepStatus, JobExecutionEvidence, JobRowData, JobRunStatus, JobRunSummary, JobStats, JobStatus } from "../../types";
import { canRunJobCommand, permissionDeniedMessage } from "../../utils/permissions";
import { jobStatusMeta } from "../../utils/statusMeta";

const runStatusMeta: Record<JobRunStatus, { className: string; label: string }> = {
  queued: { className: "scheduled", label: "대기 중" },
  running: { className: "running", label: "실행 중" },
  failed: { className: "failed", label: "실패" },
  success: { className: "success", label: "성공" },
  canceled: { className: "failed", label: "취소됨" },
};

const dagStepStatusMeta: Record<JobDagStepStatus, { className: string; label: string }> = {
  pending: { className: "paused", label: "대기" },
  running: { className: "running", label: "진행" },
  success: { className: "success", label: "성공" },
  failed: { className: "failed", label: "실패" },
  blocked: { className: "paused", label: "중단" },
};

function dagStepStatusDisplay(status: JobDagStepStatus | string | undefined) {
  return dagStepStatusMeta[(status as JobDagStepStatus) || "pending"] ?? dagStepStatusMeta.blocked;
}

type JobMetricTone = "total" | "running" | "scheduled" | "failed" | "attention";

type JobMetric = {
  active?: boolean;
  label: string;
  tone: JobMetricTone;
  value: string;
};

function getJobMetrics(jobs: JobRowData[]): JobMetric[] {
  return [
    { active: true, label: "전체 작업", tone: "total", value: String(jobs.length) },
    { label: jobStatusMeta.running.label, tone: "running", value: String(jobs.filter((job) => job.status === "running").length) },
    { label: jobStatusMeta.scheduled.label, tone: "scheduled", value: String(jobs.filter((job) => job.status === "scheduled").length) },
    { label: jobStatusMeta.failed.label, tone: "failed", value: String(jobs.filter((job) => job.status === "failed").length) },
    { label: "확인 필요", tone: "attention", value: String(jobs.filter((job) => job.status === "failed" || job.status === "canceled").length) },
  ];
}

function jobCreatorLabel(job: JobRowData) {
  return job.createdByProfile?.displayName || job.createdBy || job.owner;
}

function jobActionDisabled(job: JobRowData, action: JobListActionKind | JobCommand) {
  if (action === "detail" || action === "runs") return false;
  return !canRunJobCommand(job, action);
}

function jobActionTitle(job: JobRowData, action: JobListActionKind | JobCommand) {
  if (!jobActionDisabled(job, action)) return undefined;
  return permissionDeniedMessage("작업", action === "run" || action === "retry" ? "실행" : "관리");
}

export function JobsLandingPage({
  jobs,
  onAction,
  onCommand,
  onCreate,
  onDetail,
  onRuns,
}: {
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: (job: JobRowData) => void;
  onTableDemo?: () => void;
}) {
  const metrics = getJobMetrics(jobs);
  return (
    <div className="jobs-landing">
      <div className="jobs-page-header">
        <PageTitle title="수집/처리" description="데이터 소스를 연결하고 ETL 작업의 상태, 실행, 로그를 관리합니다." />
        <div className="jobs-header-actions">
          <button className="primary-button create-job-button" type="button" onClick={onCreate}><Plus size={16} /> 새 수집/처리 생성</button>
        </div>
      </div>
      <div className="content-main jobs-xflow-stack">
        <section className="jobs-xflow-card jobs-metrics-card">
          <div className="jobs-xflow-card-header">
            <span className="jobs-xflow-icon">
              <BarChart3 size={16} />
            </span>
            <div className="jobs-xflow-heading">
              <h2>작업 현황</h2>
              <p>수집/처리 Job의 현재 상태와 확인이 필요한 항목을 요약합니다.</p>
            </div>
            <span className="jobs-xflow-state">{jobs.length} jobs</span>
          </div>
          <div className="metric-grid jobs-xflow-metrics">
            {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
          </div>
        </section>
        <JobsToolbar onFilter={(filter) => onAction("etl.jobs.filter_opened", `/api/etl/jobs/filters/${filter}`, filter)} onReset={() => onAction("etl.jobs.filter_reset", "/api/etl/jobs", "filters")} />
        <JobsTableSection
          ariaLabel="ETL 작업 목록"
          emptyBody="소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다."
          jobs={jobs}
          logAction="etl.job.log_opened"
          onAction={onAction}
          onCommand={onCommand}
          onCreate={onCreate}
          onDetail={onDetail}
          onRuns={onRuns}
          pageActionPrefix="etl.jobs"
          title="작업 상태 목록"
        />
      </div>
    </div>
  );
}

function CellphonesReviewAnalysisPanel({
  analysis,
  error,
  loading,
  onClose,
  onRefresh,
  onRun,
}: {
  analysis: ReviewAnalysisSummary | null;
  error: string;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRun: () => void;
}) {
  const processedRows = analysis?.processedRows ?? 0;
  const rows = analysis?.rows ?? [];
  const categoryBreakdown = analysis?.categoryBreakdown ?? [];
  const metrics = analysis?.metrics;
  const statusLabel = loading ? "실행 중" : analysis?.status === "success" ? "마지막 결과 있음" : "대기";
  const outputPath = analysis?.output?.jsonlPath ?? "";
  const runId = analysis?.runId ?? "-";
  const finishedAt = analysis?.finishedAt ? new Date(analysis.finishedAt).toLocaleString("ko-KR") : "-";

  return (
    <section className="review-analysis-workspace" aria-label="Amazon Cell Phones 리뷰 정형화 파이프라인">
      <div className="review-analysis-topline">
        <div className="review-analysis-title">
          <span><Bot size={15} /> 비정형 리뷰 정형화</span>
          <h2>Cell Phones 리뷰를 분석 테이블로 변환</h2>
          <p>m3 MinIO의 실제 JSONL 원본을 스트리밍해서 리뷰마다 감정, 이슈, 심각도, 요약 컬럼을 생성합니다.</p>
        </div>
        <div className="review-analysis-controls">
          <span className={["review-analysis-status", loading ? "running" : analysis?.status === "success" ? "success" : ""].filter(Boolean).join(" ")}>
            {statusLabel}
          </span>
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} /> 결과 새로고침
          </button>
          <button className="secondary-button" type="button" onClick={onClose} disabled={loading}>
            <X size={15} /> 닫기
          </button>
          <button className="primary-button" type="button" onClick={onRun} disabled={loading}>
            <PlayCircle size={15} /> {loading ? "실행 중..." : "실제 원본 50,000행 실행"}
          </button>
        </div>
      </div>

      <div className="review-analysis-flow" aria-label="처리 흐름">
        <ReviewAnalysisStep index="1" icon={<HardDrive size={16} />} title="원본" value="MinIO JSONL" detail="Cell_Phones_and_Accessories.jsonl" />
        <ReviewAnalysisStep index="2" icon={<Bot size={16} />} title="정형화" value="row-level 분석" detail="sentiment / issue / severity / summary" />
        <ReviewAnalysisStep index="3" icon={<Check size={16} />} title="대화형 실행" value="실제 50,000행" detail="mock 없이 원본 스트림 처리" />
        <ReviewAnalysisStep index="4" icon={<Database size={16} />} title="출력" value="JSONL 테이블" detail="review_issue_rows.jsonl" />
      </div>

      {error && <div className="review-analysis-error">{error}</div>}

      <div className="review-analysis-layout">
        <aside className="review-analysis-run-panel">
          <div className="review-analysis-panel-heading">
            <span>실행 설정</span>
            <strong>실제 원본 대화형 실행</strong>
          </div>
          <dl className="review-analysis-facts">
            <div>
              <dt>Source object</dt>
              <dd title={analysis?.source?.object}>{analysis?.source?.object ?? "s3://m3-raw/amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl"}</dd>
            </div>
            <div>
              <dt>Run scope</dt>
              <dd>원본 앞 50,000행</dd>
            </div>
            <div>
              <dt>Output schema</dt>
              <dd>review_id, asin, rating, sentiment, issue_category, issue_subcategory, severity, summary, evidence</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{runId} · {finishedAt}</dd>
            </div>
            <div>
              <dt>Output file</dt>
              <dd title={outputPath}>{outputPath || "아직 생성된 출력 파일이 없습니다."}</dd>
            </div>
          </dl>
        </aside>

        <div className="review-analysis-result-panel">
          <div className="review-analysis-panel-heading">
            <span>마지막 결과</span>
            <strong>{processedRows > 0 ? `${processedRows.toLocaleString()} rows processed` : "실행 전"}</strong>
          </div>
          <div className="review-analysis-metrics">
            <ReviewAnalysisMetric label="처리 행수" value={processedRows.toLocaleString()} />
            <ReviewAnalysisMetric label="이슈 행" value={(metrics?.issueRows ?? 0).toLocaleString()} />
            <ReviewAnalysisMetric label="High+ 심각도" value={(metrics?.highSeverityRows ?? 0).toLocaleString()} />
            <ReviewAnalysisMetric label="평균 rating" value={(metrics?.averageRating ?? 0).toLocaleString()} />
          </div>

          <div className="review-analysis-result-grid">
            <div className="review-analysis-breakdown">
              <div className="review-analysis-section-title">
                <HardDrive size={15} />
                <strong>이슈 카테고리 분포</strong>
              </div>
              {categoryBreakdown.length > 0 ? (
                <ul>
                  {categoryBreakdown.slice(0, 6).map((item) => (
                    <li key={item.id}>
                      <span>{reviewCategoryLabel(item)}</span>
                      <strong>{item.count.toLocaleString()} · {formatShare(item.share)}</strong>
                      <i style={{ width: `${Math.max(2, Math.round(item.share * 100))}%` }} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p>아직 실행 결과가 없습니다.</p>
              )}
            </div>
            <div className="review-analysis-table-wrap">
              <div className="review-analysis-section-title">
                <Table2 size={15} />
                <strong>정형 결과 미리보기</strong>
              </div>
              <table className="review-analysis-table">
                <thead>
                  <tr>
                    <th>rating</th>
                    <th>감정</th>
                    <th>이슈</th>
                    <th>심각도</th>
                    <th>요약</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length > 0 ? rows.slice(0, 8).map((row) => (
                    <tr key={row.review_id}>
                      <td>{row.rating}</td>
                      <td>{sentimentLabel(row.sentiment)}</td>
                      <td>{reviewIssueLabel(row.issue_category, row.issue_label)}</td>
                      <td>{severityLabel(row.severity)}</td>
                      <td>{reviewSummary(row)}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={5}>실제 원본 실행을 누르면 결과가 표시됩니다.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewAnalysisStep({ detail, icon, index, title, value }: { detail: string; icon: React.ReactNode; index: string; title: string; value: string }) {
  return (
    <div className="review-analysis-step">
      <span className="review-analysis-step-index">{index}</span>
      <span className="review-analysis-step-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <span>{value}</span>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ReviewAnalysisMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="review-analysis-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function reviewCategoryLabel(item: { id: string; label: string }) {
  return reviewIssueLabel(item.id, item.label);
}

function reviewIssueLabel(id: string, fallback: string) {
  const labels: Record<string, string> = {
    audio_bluetooth: "오디오 / 블루투스",
    charging_power: "충전 / 전원",
    compatibility_fit: "호환성 / 핏",
    delivery_packaging: "배송 / 포장",
    durability_quality: "내구성 / 품질",
    general_negative: "일반 불만",
    listing_accuracy: "상품 정보 불일치",
    positive_value: "긍정 / 가치",
    safety_battery: "안전 / 배터리",
    screen_display: "화면 / 디스플레이",
  };
  return labels[id] ?? fallback;
}

function sentimentLabel(value: string) {
  if (value === "positive") return "긍정";
  if (value === "negative") return "부정";
  if (value === "mixed") return "혼합";
  return value;
}

function severityLabel(value: string) {
  if (value === "critical") return "치명";
  if (value === "high") return "높음";
  if (value === "medium") return "중간";
  if (value === "low") return "낮음";
  if (value === "none") return "없음";
  return value;
}

function reviewSummary(row: { issue_category: string; issue_label: string; summary: string }) {
  const summary = String(row.summary ?? "");
  const issueLabel = String(row.issue_label ?? "");
  return summary
    .replace(`${issueLabel} 이슈`, `${reviewIssueLabel(row.issue_category, issueLabel)} 이슈`)
    .replace("Positive / value", "긍정 / 가치")
    .replace("Charging / power", "충전 / 전원")
    .replace("Screen / display", "화면 / 디스플레이")
    .replace("Durability / quality", "내구성 / 품질")
    .replace("Listing accuracy", "상품 정보 불일치");
}

function formatShare(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function MetricCard({ active, label, tone, value }: JobMetric) {
  const className = ["metric-card", `metric-card-${tone}`, active ? "active" : ""].filter(Boolean).join(" ");

  return (
    <article className={className}>
      <span>{value}</span>
      <strong>{label}</strong>
    </article>
  );
}

function JobsToolbar({ onFilter, onReset }: { onFilter: (filter: string) => void; onReset: () => void }) {
  return (
    <section className="jobs-toolbar jobs-xflow-card">
      <div className="jobs-xflow-card-header">
        <span className="jobs-xflow-icon">
          <SlidersHorizontal size={16} />
        </span>
        <div className="jobs-xflow-heading">
          <h2>검색 및 필터</h2>
          <p>작업명, 소스, 소유자, 태그 기준으로 작업 목록을 좁혀 봅니다.</p>
        </div>
        <span className="jobs-xflow-state">필터</span>
      </div>
      <div className="jobs-toolbar-body">
        <div className="jobs-search">
          <Search size={16} />
          <span>작업명, 소스명, 타깃 데이터셋명 검색</span>
        </div>
        {["상태", "소스", "Owner", "태그"].map((filter) => (
          <button className="filter-chip jobs-filter" key={filter} type="button" onClick={() => onFilter(filter)}>{filter} ▾</button>
        ))}
        <button className="ghost-link reset-filter" type="button" onClick={onReset}>↺ 필터 초기화</button>
      </div>
    </section>
  );
}

function JobViewSwitch({ activeView, onCards, onTable }: { activeView: "cards" | "table"; onCards: () => void; onTable: () => void }) {
  return (
    <div className="jobs-view-switch" aria-label="작업 목록 보기 방식">
      <button className={activeView === "cards" ? "active" : ""} type="button" onClick={onCards} aria-pressed={activeView === "cards"}>
        <LayoutGrid size={15} />
        카드
      </button>
      <button className={activeView === "table" ? "active" : ""} type="button" onClick={onTable} aria-pressed={activeView === "table"}>
        <Table2 size={15} />
        TanStack Table
      </button>
    </div>
  );
}

function JobsCardSection({
  jobs,
  onAction,
  onCommand,
  onCreate,
  onDetail,
  onRuns,
}: {
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: (job: JobRowData) => void;
}) {
  const [activeLogJob, setActiveLogJob] = useState<JobRowData | null>(null);
  const openJobLog = useCallback((job: JobRowData) => {
    onAction("etl.job.log_opened", `/api/etl/jobs/${job.id}/runs/latest/logs`, job.id);
    setActiveLogJob(job);
  }, [onAction]);
  const runAction = useCallback((action: JobListActionKind, job: JobRowData) => {
    if (action === "detail") {
      onDetail(job);
      return;
    }
    if (action === "runs") {
      onRuns(job);
      return;
    }
    onCommand(job, action);
  }, [onCommand, onDetail, onRuns]);

  return (
    <section className="job-table" aria-label="ETL 작업 카드 목록">
      {jobs.length === 0 && (
        <div className="job-empty-state">
          <Plus size={22} />
          <strong>생성된 수집/처리 작업이 없습니다.</strong>
          <p>소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다.</p>
          <button className="primary-button" type="button" onClick={onCreate}>새 수집/처리 생성</button>
        </div>
      )}
      {jobs.map((job) => {
        const statusClass = jobStatusMeta[job.status].className;
        const executionDisplay = getJobExecutionDisplay(job);

        return (
          <article className={`job-row ${statusClass}`} key={job.id}>
            <div className="job-row-status">
              <StatusPill status={job.status} />
            </div>
            <div className="job-row-main">
              <div className="job-title-row">
                <div>
                  <strong>{job.name}</strong>
                  <p>{job.id}</p>
                </div>
                <div className="job-owner">
                  <span className="owner-chip">Owner: {job.owner}</span>
                  <span className="owner-chip">Created: {jobCreatorLabel(job)}</span>
                  <span className="tag-chip">{job.tag}</span>
                </div>
              </div>
              {job.progress && <JobProgress label={job.progress.label} value={job.progress.value} />}
              <dl className="job-row-details">
                <div><dt>소스</dt><dd>{job.source}</dd></div>
                <div><dt>타깃</dt><dd>{job.target}</dd></div>
                <div><dt>스케줄</dt><dd>{job.schedule}</dd></div>
                <div>
                  <dt>마지막 실행</dt>
                  <dd>{formatCompactDateTime(job.lastRun)}</dd>
                  <dd className={executionDisplay.tone === "danger" ? "danger-text job-state-summary" : "job-state-summary"} title={executionDisplay.raw}>
                    {executionDisplay.summary}
                  </dd>
                  {executionDisplay.hasRawLog && (
                    <button className="job-inline-log-button" type="button" onClick={() => openJobLog(job)}>
                      원문 로그
                    </button>
                  )}
                </div>
                <div><dt>다음 실행</dt><dd>{job.nextRun}</dd></div>
              </dl>
              <div className="job-row-actions">
                {getJobListActions(job).map((action) => (
                  <button className={action.className} disabled={jobActionDisabled(job, action.kind)} key={action.label} title={jobActionTitle(job, action.kind)} type="button" onClick={() => runAction(action.kind, job)}>
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </article>
        );
      })}
      {jobs.length > 0 && (
        <div className="job-table-footer">
          <span>1-{jobs.length} of {jobs.length}</span>
          <div>
            <button className="ghost-link" type="button" onClick={() => onAction("etl.jobs.page_previous", "/api/etl/jobs?page=previous", "jobs")}>← 이전</button>
            <button className="ghost-link" type="button" onClick={() => onAction("etl.jobs.page_next", "/api/etl/jobs?page=next", "jobs")}>다음 →</button>
          </div>
        </div>
      )}
      {activeLogJob && <JobLogModal job={activeLogJob} onClose={() => setActiveLogJob(null)} />}
    </section>
  );
}

type JobsTableSectionProps = {
  ariaLabel: string;
  emptyBody: string;
  jobs: JobRowData[];
  logAction: string;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: (job: JobRowData) => void;
  pageActionPrefix: string;
  title: string;
};

function JobsTableSection({
  ariaLabel,
  emptyBody,
  jobs,
  logAction,
  onAction,
  onCommand,
  onCreate,
  onDetail,
  onRuns,
  pageActionPrefix,
  title,
}: JobsTableSectionProps) {
  const [activeLogJob, setActiveLogJob] = useState<JobRowData | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const tableRows = useMemo<JobsTableRow[]>(() => jobs.map((job) => ({
    executionDisplay: getJobExecutionDisplay(job),
    job,
  })), [jobs]);
  const openJobLog = useCallback((job: JobRowData) => {
    onAction(logAction, `/api/etl/jobs/${job.id}/runs/latest/logs`, job.id);
    setActiveLogJob(job);
  }, [logAction, onAction]);
  const runAction = useCallback((action: JobListActionKind, job: JobRowData) => {
    if (action === "detail") {
      onDetail(job);
      return;
    }
    if (action === "runs") {
      onRuns(job);
      return;
    }
    onCommand(job, action);
  }, [onCommand, onDetail, onRuns]);
  const columns = useMemo<ColumnDef<JobsTableRow>[]>(() => [
    {
      accessorFn: (row) => row.job.status,
      cell: ({ row }) => <StatusPill status={row.original.job.status} />,
      header: "상태",
      id: "status",
    },
    {
      accessorFn: (row) => row.job.name,
      cell: ({ row }) => {
        const { job } = row.original;

        return (
          <div className="jobs-table-title-cell">
            <strong>{job.name}</strong>
            <span>{job.id} · {String(job.tag ?? "").replace("[", "").replace("]", "")}</span>
          </div>
        );
      },
      header: "작업명",
      id: "job",
    },
    {
      accessorFn: (row) => row.job.target,
      cell: ({ row }) => {
        const { job } = row.original;

        return (
          <div className="jobs-flow-cell">
            <strong>{job.target}</strong>
            <span>{job.source}</span>
          </div>
        );
      },
      header: "타깃 데이터셋",
      id: "target",
    },
    {
      accessorFn: (row) => row.job.owner,
      cell: ({ row }) => (
        <span className="owner-chip" title={`Created by ${jobCreatorLabel(row.original.job)}`}>
          {row.original.job.owner}
        </span>
      ),
      header: "소유자",
      id: "owner",
    },
    {
      accessorFn: (row) => row.executionDisplay.summary,
      cell: ({ row }) => {
        const { executionDisplay, job } = row.original;
        const showStage = executionDisplay.stage && executionDisplay.stage !== executionDisplay.summary;

        return (
          <div className="jobs-table-run-cell">
            {showStage && <span>{executionDisplay.stage}</span>}
            <strong className={executionDisplay.tone === "danger" ? "danger-text" : ""} title={executionDisplay.raw}>{executionDisplay.summary}</strong>
            {executionDisplay.hasRawLog && (
              <button type="button" onClick={() => openJobLog(job)}>로그</button>
            )}
          </div>
        );
      },
      header: "최근 실행 결과",
      id: "executionResult",
    },
    {
      accessorFn: (row) => row.job.lastRun,
      cell: ({ row }) => {
        const { job } = row.original;

        return (
          <div className="jobs-table-next-cell">
            <strong>{formatCompactDateTime(job.lastRun)}</strong>
            <span>다음: {job.nextRun}</span>
          </div>
        );
      },
      header: "마지막 실행",
      id: "lastRun",
    },
    {
      cell: ({ row }) => {
        const { job } = row.original;

        return (
          <div className="jobs-table-actions">
            {getJobListActions(job).map((action) => (
              <button
                aria-label={action.label}
                className={`${action.className} icon-only`}
                disabled={jobActionDisabled(job, action.kind)}
                key={action.label}
                title={jobActionTitle(job, action.kind) ?? action.label}
                type="button"
                onClick={() => runAction(action.kind, job)}
              >
                <JobListActionIcon action={action} />
              </button>
            ))}
          </div>
        );
      },
      enableSorting: false,
      header: "액션",
      id: "actions",
    },
  ], [openJobLog, runAction]);
  const table = useReactTable({
    columns,
    data: tableRows,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.job.id,
    onSortingChange: setSorting,
    state: { sorting },
  });

  return (
    <section className="jobs-table-preview-card jobs-xflow-card" aria-label={ariaLabel}>
      <div className="jobs-table-preview-header jobs-xflow-card-header">
        <span className="jobs-xflow-icon">
          <Table2 size={16} />
        </span>
        <div className="jobs-xflow-heading">
          <h2>{title}</h2>
          <p>상태, 타깃, 최근 실행 결과를 한 화면에서 확인하고 필요한 작업을 실행합니다.</p>
        </div>
        <strong className="jobs-xflow-state">{jobs.length} jobs</strong>
      </div>
      <div className="jobs-table-scroll">
        <table className="jobs-table-preview">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>{renderJobsTableHeader(header)}</th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td className="jobs-table-empty" colSpan={7}>
                  <div className="job-empty-state table-empty-state">
                    <Plus size={22} />
                    <strong>생성된 수집/처리 작업이 없습니다.</strong>
                    <p>{emptyBody}</p>
                    <button className="primary-button" type="button" onClick={onCreate}>새 수집/처리 생성</button>
                  </div>
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => (
              <tr className={`job-table-row ${jobStatusMeta[row.original.job.status].className}`} key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="jobs-table-preview-footer">
        <span>1-{jobs.length} of {jobs.length}</span>
        <div>
          <button type="button" aria-label="이전 페이지" onClick={() => onAction(`${pageActionPrefix}.page_previous`, "/api/etl/jobs?page=previous", "jobs")}>‹</button>
          <button type="button" aria-label="다음 페이지" onClick={() => onAction(`${pageActionPrefix}.page_next`, "/api/etl/jobs?page=next", "jobs")}>›</button>
        </div>
      </div>
      {activeLogJob && <JobLogModal job={activeLogJob} onClose={() => setActiveLogJob(null)} />}
    </section>
  );
}

type JobListActionKind = Exclude<JobCommand, "delete" | "pause"> | "detail" | "runs";

type JobListAction = {
  className: string;
  kind: JobListActionKind;
  label: string;
};

function getJobListActions(job: JobRowData): JobListAction[] {
  const actions: JobListAction[] = [
    { className: "job-action-button", kind: "detail", label: "작업 정보" },
  ];

  if (job.status === "running") {
    return [
      ...actions,
      { className: "job-action-button primary soft", kind: "runs", label: "실행 단계" },
      { className: "job-action-button danger", kind: "cancelRun", label: "취소" },
    ];
  }

  if (job.status === "failed" || job.status === "canceled") {
    return [
      ...actions,
      { className: "job-action-button primary soft", kind: "retry", label: "재실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
    ];
  }

  if (job.status === "paused") {
    return [
      ...actions,
      { className: "job-action-button primary soft", kind: "run", label: "재개 실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
    ];
  }

  return [
    ...actions,
    { className: "job-action-button primary soft", kind: "run", label: "즉시 실행" },
    { className: "job-action-button", kind: "edit", label: "수정" },
  ];
}

type JobDetailAction = {
  className: string;
  kind: JobCommand;
  label: string;
};

function getJobDetailActions(job: JobRowData): JobDetailAction[] {
  if (job.status === "running") {
    return [
      { className: "job-action-button", kind: "pause", label: "일시정지" },
      { className: "job-action-button danger", kind: "cancelRun", label: "실행 취소" },
    ];
  }

  if (job.status === "failed" || job.status === "canceled") {
    return [
      { className: "job-action-button primary", kind: "retry", label: "재실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  if (job.status === "paused") {
    return [
      { className: "job-action-button primary", kind: "run", label: "재개 실행" },
      { className: "job-action-button", kind: "edit", label: "수정" },
      { className: "job-action-button danger", kind: "delete", label: "삭제" },
    ];
  }

  return [
    { className: "job-action-button primary", kind: "run", label: "즉시 실행" },
    { className: "job-action-button", kind: "edit", label: "수정" },
    { className: "job-action-button danger", kind: "delete", label: "삭제" },
  ];
}

export function JobsTableDemoPage({
  jobs,
  onAction,
  onBack,
  onCommand,
  onCreate,
  onDetail,
  onRuns,
}: {
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onCreate: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: (job: JobRowData) => void;
}) {
  const metrics = getJobMetrics(jobs);

  return (
    <div className="jobs-table-demo-page">
      <div className="jobs-page-header">
        <PageTitle title="수집/처리" description="TanStack Table 버전으로 작업 밀도, 정렬, 액션 배치를 비교합니다." />
        <div className="jobs-header-actions">
          <JobViewSwitch activeView="table" onCards={onBack} onTable={() => undefined} />
          <button className="primary-button create-job-button" type="button" onClick={onCreate}>+ 새 수집/처리 생성</button>
        </div>
      </div>

      <div className="content-main">
        <div className="metric-grid">
          {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
        </div>
        <JobsToolbar onFilter={(filter) => onAction("etl.jobs.table_demo_filter_opened", `/api/etl/jobs/filters/${filter}`, filter)} onReset={() => onAction("etl.jobs.table_demo_filter_reset", "/api/etl/jobs", "filters")} />
        <JobsTableSection
          ariaLabel="ETL 작업 표형 데모"
          emptyBody="소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다."
          jobs={jobs}
          logAction="etl.job.table_demo_log_opened"
          onAction={onAction}
          onCommand={onCommand}
          onCreate={onCreate}
          onDetail={onDetail}
          onRuns={onRuns}
          pageActionPrefix="etl.jobs.table_demo"
          title="작업 상태 중심 목록"
        />
      </div>
    </div>
  );
}

type JobsTableRow = {
  executionDisplay: JobExecutionDisplay;
  job: JobRowData;
};

function renderJobsTableHeader(header: Header<JobsTableRow, unknown>) {
  if (header.isPlaceholder) return null;

  const label = flexRender(header.column.columnDef.header, header.getContext());
  if (!header.column.getCanSort()) return label;

  const sorted = header.column.getIsSorted();
  const SortIcon = sorted === "asc" ? ChevronUp : sorted === "desc" ? ChevronDown : ArrowUpDown;

  return (
    <button className="jobs-table-sort-button" type="button" onClick={header.column.getToggleSortingHandler()}>
      {label}
      <SortIcon size={13} />
    </button>
  );
}

function JobListActionIcon({ action }: { action: JobListAction }) {
  if (action.kind === "detail") return <Info aria-hidden="true" size={15} />;
  if (action.kind === "runs") return <TerminalSquare aria-hidden="true" size={15} />;
  if (action.kind === "edit") return <Pencil aria-hidden="true" size={15} />;
  if (action.kind === "cancelRun") return <X aria-hidden="true" size={15} />;
  if (action.kind === "retry") return <RefreshCw aria-hidden="true" size={15} />;

  return <PlayCircle aria-hidden="true" size={15} />;
}

function JobLogModal({ job, onClose }: { job: JobRowData; onClose: () => void }) {
  const executionDisplay = getJobExecutionDisplay(job);
  const failedRun = getLatestProblemRun(job);

  return (
    <div className="job-log-modal" role="dialog" aria-modal="true" aria-label={`${job.name} 원문 로그`} onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <header className="job-log-modal-header">
          <div>
            <span>{failedRun?.runId ?? job.id}</span>
            <h2>{job.name}</h2>
            <p>{executionDisplay.stage} · {executionDisplay.summary}</p>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose}><X size={16} />닫기</button>
        </header>
        <pre>{executionDisplay.raw}</pre>
      </section>
    </div>
  );
}

type JobExecutionDisplay = {
  hasRawLog: boolean;
  raw: string;
  stage: string;
  summary: string;
  tone: "danger" | "normal";
};

function getJobExecutionDisplay(job: JobRowData): JobExecutionDisplay {
  const problemRun = getLatestProblemRun(job);
  const problemStage = normalizeShortText(problemRun?.failedStage);
  const errorSummary = normalizeShortText(problemRun?.errorSummary);
  const rawCandidates = [job.lastState, problemRun?.errorSummary ?? ""].map((value) => String(value ?? "").trim()).filter(Boolean);
  const raw = rawCandidates.sort((first, second) => second.length - first.length)[0] ?? job.lastState;
  const isProblem = job.status === "failed" || job.status === "canceled";
  const stage = problemStage && problemStage !== "-" ? problemStage : isProblem ? "실패 단계 미확인" : job.progress?.label ?? jobStatusMeta[job.status].summaryLabel;
  const fallbackSummary = isProblem ? compactLogSummary(raw) : normalizeWhitespace(job.lastState);
  const summarySource = errorSummary && errorSummary !== "-" && !isVerboseLogText(errorSummary) ? errorSummary : fallbackSummary;
  const normalizedSummary = summarySource === "실패" || summarySource === "FAILED" ? "실패 원인 확인 필요" : summarySource;
  const summary = truncateText(normalizedSummary || jobStatusMeta[job.status].summaryLabel, isProblem ? 72 : 58);
  const hasRawLog = isVerboseLogText(raw) || normalizeWhitespace(raw).length > summary.length + 24;

  return {
    hasRawLog,
    raw: raw || "-",
    stage,
    summary,
    tone: isProblem ? "danger" : "normal",
  };
}

function getLatestProblemRun(job: JobRowData) {
  return job.runHistory?.find((run) => run.status === "failed" || run.status === "canceled");
}

function normalizeShortText(value?: unknown) {
  if (!value) return "";
  return String(value).trim();
}

function normalizeWhitespace(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function formatCompactDateTime(value: unknown): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === "-") return normalized || "-";

  const dateCandidate = normalized.includes("T")
    ? normalized
    : /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(normalized)
      ? normalized.replace(" ", "T")
      : "";
  if (!dateCandidate) return normalized;

  const safeCandidate = dateCandidate.replace(/\.(\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}|$)/, ".$1");
  const date = new Date(safeCandidate);
  if (Number.isNaN(date.getTime())) return normalized;

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}.${month}.${day} ${hours}:${minutes}`;
}

function isVerboseLogText(value: unknown) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length > 120) return true;
  return /warning:|exception|traceback|spark|ivy|\/opt\/spark|hadoop-aws|jar:file|download|successfully/i.test(normalized);
}

function compactLogSummary(value: unknown) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === "실패") return "실패 원인 확인 필요";

  const priorityPatterns = [
    /(Spark 실행 실패)/i,
    /([A-Za-z0-9_.]*(?:Exception|Error):\s*[^:]{8,120})/,
    /(Connection refused[^:]{0,100})/i,
    /(AccessDenied[^:]{0,100})/i,
    /(failed to [^:]{8,120})/i,
  ];
  const matched = priorityPatterns
    .map((pattern) => normalized.match(pattern)?.[1])
    .find(Boolean);

  return truncateText(matched ?? normalized, 72);
}

function truncateText(value: unknown, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function StatusPill({ status }: { status: JobStatus }) {
  const statusClass = status === "failed" ? "danger" : status === "scheduled" ? "" : jobStatusMeta[status].className;
  return <span className={`status-pill ${statusClass}`}>{jobStatusMeta[status].label}</span>;
}

function JobProgress({ label, value }: { label: string; value: number }) {
  return (
    <div className="job-progress" aria-label={label}>
      <div className="job-progress-label">
        <span>진행 상태</span>
        <strong>{label}</strong>
      </div>
      <span className="job-progress-track">
        <span style={{ width: `${value}%` }} />
      </span>
    </div>
  );
}

type SchemaDetailRow = [string, string, string, string, string, string];
type RuleDetailRow = [string, string, string, string];

function fallbackJobStats(job: JobRowData): JobStats {
  const runs = job.runHistory ?? [];
  const successRuns = runs.filter((run) => run.status === "success").length;
  const latestRun = runs[0];
  const lastSuccess = runs.find((run) => run.status === "success");

  return {
    averageDuration: latestRun?.duration ?? "-",
    currentStage: job.progress?.label ?? jobStatusMeta[job.status].summaryLabel,
    inputRows: latestRun?.inputRows ?? "-",
    lastSuccess: lastSuccess?.endedAt ?? "-",
    outputRows: latestRun?.outputRows ?? "-",
    sampleScope: "-",
    schemaColumns: "-",
    sourceUnits: "-",
    successRate: runs.length > 0 ? `${Math.round((successRuns / runs.length) * 100)}%` : "-",
    totalRuns: String(runs.length),
  };
}

function schemaRowsForJob(job: JobRowData, stats: JobStats): SchemaDetailRow[] {
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const run = job.runHistory?.[0];
  const issue = job.status === "failed" ? getJobExecutionDisplay(job).summary : job.status === "running" ? "처리 중" : "정상";

  return [
    ["1", "source", sourcePath, "raw_payload", "String", issue],
    ["2", "schema columns", stats.schemaColumns, "inferred_schema", "JSON", issue],
    ["3", "input rows", stats.inputRows, "source_rows", "Integer", run?.status === "failed" ? "실패 run 기준" : "최근 run 기준"],
    ["4", "output rows", stats.outputRows, "target_rows", "Integer", run?.status === "failed" ? "실패 run 기준" : "최근 run 기준"],
    ["5", "sample scope", stats.sampleScope, "sample_window", "String", "생성 시점 metadata"],
  ];
}

function ruleRowsForJob(job: JobRowData): RuleDetailRow[] {
  const steps = job.dagSteps ?? [];
  if (steps.length > 0) {
    return steps.map((step) => [
      step.title,
      step.meta,
      step.note ?? "-",
      step.status.toUpperCase(),
    ]);
  }

  const stage = job.progress?.label ?? jobStatusMeta[job.status].summaryLabel;
  const state = job.status === "failed" ? "FAILED" : job.status === "running" ? "RUNNING" : job.status === "canceled" ? "CANCELED" : "PENDING";

  return [
    ["소스 검증", job.source, "백엔드 커넥터 결과", state],
    ["스키마 추론", stage, "추론된 메타데이터", state],
    ["Create handoff", job.target, "job/dataset response", state],
  ];
}

function DetailSummaryStat({ label, tone, value }: { label: string; tone?: "danger" | "running" | "scheduled" | "canceled"; value: string }) {
  return (
    <div className={tone ? `detail-summary-stat ${tone}` : "detail-summary-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type JobNextAction = {
  kind: "run" | "retry";
  label: string;
};

function getJobNextAction(job: JobRowData): JobNextAction {
  if (job.status === "failed" || job.status === "canceled") return { kind: "retry", label: "재실행 요청" };
  if (job.status === "paused") return { kind: "run", label: "재개 실행" };
  return { kind: "run", label: "즉시 실행" };
}

function JobDetailHeader({
  activeTab,
  job,
  onAction,
  onCommand,
  onDetail,
  onEdit,
  onRuns,
}: {
  activeTab: "detail" | "runs";
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDetail: () => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const runAction = (action: JobCommand) => {
    onCommand(job, action);
  };

  return (
    <header className="job-detail-header">
      <button className="job-detail-breadcrumb" type="button" onClick={onDetail}>수집/처리 &gt; 작업 목록</button>
      <div className="job-detail-title-row">
        <div>
          <h1>{job.name}</h1>
          <div className="job-detail-meta">
            <StatusPill status={job.status} />
            <span className="owner-chip">Owner: {job.owner}</span>
            <span className="owner-chip">Created: {jobCreatorLabel(job)}</span>
            <span className="tag-chip">{String(job.tag ?? "").replace("[", "").replace("]", "")}</span>
          </div>
        </div>
        <div className="job-detail-actions">
          {getJobDetailActions(job).map((action) => (
            <button className={action.className} disabled={jobActionDisabled(job, action.kind)} key={action.label} title={jobActionTitle(job, action.kind)} type="button" onClick={() => runAction(action.kind)}>{action.label}</button>
          ))}
        </div>
      </div>
      <nav className="job-detail-tabs" aria-label="작업 상세 탭">
        <button className={activeTab === "detail" ? "active" : ""} type="button" onClick={onDetail}>작업 상세 정보</button>
        <button className={activeTab === "runs" ? "active" : ""} type="button" onClick={onRuns}>실행 이력</button>
      </nav>
    </header>
  );
}

export function JobDetailPage({
  job,
  onAction,
  onBack,
  onCommand,
  onEdit,
  onRuns,
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const sourceType = job.source.split(" / ")[0] ?? job.source;
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const stats = job.stats ?? fallbackJobStats(job);
  const physicalOutputPath = job.targetPath ?? stats.outputPath ?? `lake/${job.target}`;
  const executionDisplay = getJobExecutionDisplay(job);
  const latestRunId = job.runHistory?.[0]?.runId ?? "-";
  const primaryAction = getJobNextAction(job);
  const showPrimaryAction = job.status !== "running";
  const stripTone = job.status === "failed" ? "danger" : job.status === "running" ? "running" : job.status === "canceled" ? "canceled" : "scheduled";
  const stripTitle = job.status === "failed" ? "최근 실행 실패" : job.status === "running" ? "현재 실행 중" : job.status === "paused" ? "작업 일시정지" : job.status === "canceled" ? "최근 실행 취소" : "스케줄 정상";
  const schemaRows = schemaRowsForJob(job, stats);
  const ruleRows = ruleRowsForJob(job);

  return (
    <div className="job-detail-page">
      <JobDetailHeader activeTab="detail" job={job} onAction={onAction} onCommand={onCommand} onDetail={onBack} onEdit={onEdit} onRuns={onRuns} />

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>작업 핵심 정보</h2>
        </div>
        <div className="job-detail-overview-grid">
          <article className={`job-ops-summary-card ${stripTone}`}>
            <div className="job-ops-main">
              <span className="job-ops-kicker">{stripTitle}</span>
              <h3>{executionDisplay.summary}</h3>
            </div>
            {showPrimaryAction && (
              <div className="job-next-actions">
                <button className="job-action-button primary" disabled={jobActionDisabled(job, primaryAction.kind)} title={jobActionTitle(job, primaryAction.kind)} type="button" onClick={() => onCommand(job, primaryAction.kind)}>{primaryAction.label}</button>
              </div>
            )}
            <div className="job-summary-stat-grid">
              <DetailSummaryStat label="최근 Run" value={latestRunId} />
              <DetailSummaryStat label="마지막 실행" value={formatCompactDateTime(job.lastRun)} />
              <DetailSummaryStat label="다음 실행" value={job.nextRun} />
            </div>
          </article>
          <article className="job-detail-card metadata-card">
            <h3>기본 메타</h3>
            <dl className="detail-plain-kv-grid">
              <div><dt>Job ID</dt><dd>{job.id}</dd></div>
              <div><dt>Target</dt><dd>{job.target}</dd></div>
              <div className="wide"><dt>소스</dt><dd>{job.source}</dd></div>
              <div className="wide"><dt>운영 조직</dt><dd>{job.owner === "admin" ? "Data Platform" : "Analytics Ops"}</dd></div>
            </dl>
          </article>
        </div>
      </section>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>소스 / 타겟 설정</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>소스 연결 설정</h3>
            <div className="detail-kv-grid">
              <Field label="소스 유형" value={sourceType} />
              <Field label="소스 경로" value={sourcePath} />
              <Field label="연결 상태" value={job.status === "failed" ? "생성 시 검증됨 · 처리 실패" : "생성 시 소스 검증 완료"} />
              <Field label="인증 방식" value={sourceType.includes("S3") || sourceType.includes("File") ? "S3 호환 access key" : sourceType.includes("Kafka") ? "Backend Kafka connector" : "Backend source connector"} />
              <Field label="읽기 방식" value={job.status === "running" ? "Streaming" : "Batch Scan"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Target 저장 설정</h3>
            <div className="detail-kv-grid">
              <Field label="타깃 데이터셋" value={job.target} />
              <Field label="Lake 경로" value={physicalOutputPath} />
              <Field label="저장 포맷" value="Parquet" />
              <Field label="쓰기 모드" value={job.status === "running" ? "Append Stream" : "Append + compact"} />
              <Field label="품질 체크" value={job.status === "failed" ? "변환 전 중단" : "행 수 / 스키마 검사"} />
            </div>
            <div className="detail-meta-line">
              <span>Downstream: SQL · Dashboard · Catalog</span>
            </div>
          </article>
        </div>
        </div>
      </details>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>스키마 / 변환</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <article className="detail-table-card">
          <div className="detail-table-header">
            <h3>스키마 매핑</h3>
            <span>5 컬럼</span>
          </div>
          <table className="schema-table detail-table">
            <thead>
              <tr>
                <th>순서</th>
                <th>소스 필드</th>
                <th>타깃 필드</th>
                <th>추론 타입</th>
                <th>Nullable</th>
                <th>이슈</th>
              </tr>
            </thead>
            <tbody>
              {schemaRows.map((row) => (
                <tr className={row[5].includes("실패") ? "detail-row-danger" : row[5].includes("처리") || row[5].includes("대기") ? "detail-row-running" : ""} key={row[0]}>{row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </article>
        <article className="detail-table-card">
          <div className="detail-table-header">
            <h3>변환 규칙</h3>
            <span>{ruleRows.length} rules</span>
          </div>
          <table className="schema-table detail-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>대상 필드</th>
                <th>Config</th>
                <th>오류 시</th>
              </tr>
            </thead>
            <tbody>
              {ruleRows.map((row) => (
                <tr className={row[3] === "FAILED" ? "detail-row-danger" : row[3] === "RUNNING" || row[3] === "PENDING" ? "detail-row-running" : ""} key={row[0]}>{row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </article>
        </div>
      </details>

      <details className="job-detail-disclosure">
        <summary>
          <div>
            <h2>Schedule / Permission</h2>
          </div>
          <span className="disclosure-indicator">펼치기</span>
        </summary>
        <div className="job-detail-disclosure-body">
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>Schedule</h3>
            <div className="detail-kv-grid">
              <Field label="실행 유형" value={job.status === "running" ? "실시간 수집" : "반복 스케줄"} />
              <Field label="주기" value={job.schedule} />
              <Field label="다음 실행" value={job.nextRun} />
              <Field label="재시도 정책" value={job.status === "failed" ? "3회 · backoff 10m" : "3회 · backoff 5m"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Permission</h3>
            <div className="detail-kv-grid">
              <Field label="Owner" value={job.owner} />
              <Field label="Created by" value={jobCreatorLabel(job)} />
              <Field label="접근 그룹" value="Data Platform, Analytics" />
              <Field label="canRun" value={job.permissions?.canRun === false ? "false" : "true"} />
              <Field label="canManage" value={job.permissions?.canManage === true ? "true" : "false"} />
              <Field label="승인 상태" value={job.status === "failed" ? "재실행 승인 필요" : "승인됨"} />
            </div>
          </article>
        </div>
        </div>
      </details>
    </div>
  );
}

export function JobRunsPage({
  evidence,
  job,
  onAction,
  onBack,
  onCommand,
}: {
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
}) {
  const [activeRun, setActiveRun] = useState<JobRunSummary | null>(null);
  const [activeLogRun, setActiveLogRun] = useState<JobRunSummary | null>(null);
  const runs = evidence?.runs.length ? evidence.runs : job.runHistory ?? [];
  const openRunDetail = (run: JobRunSummary) => {
    onAction("etl.run.detail_opened", `/api/etl/jobs/${job.id}/runs/${run.runId}`, run.runId);
    setActiveRun(run);
  };
  const openRunLog = (run: JobRunSummary) => {
    onAction("etl.run.log_opened", `/api/etl/jobs/${job.id}/runs/${run.runId}/logs`, run.runId);
    setActiveLogRun(run);
  };

  return (
    <div className="job-detail-page job-runs-page">
      <JobDetailHeader activeTab="runs" job={job} onAction={onAction} onCommand={onCommand} onDetail={onBack} onEdit={onBack} onRuns={() => undefined} />

      <section className="runs-body-content">
        <article className="runs-stats-summary">
          <h2>실행 통계 요약</h2>
          <div>
            <RunSummaryMetric label="성공률" value={job.stats?.successRate ?? "-"} />
            <RunSummaryMetric label="평균 소요시간" value={job.stats?.averageDuration ?? "-"} />
            <RunSummaryMetric label="총 실행" value={job.stats?.totalRuns ?? `${runs.length}회`} />
          </div>
        </article>

        <div className="runs-filter-bar">
          <div className="runs-filters-left">
            <button className="runs-filter-button" type="button" onClick={() => onAction("etl.runs.status_filter_opened", `/api/etl/jobs/${job.id}/runs/filters/status`, job.id)}>상태: 전체 <span>▾</span></button>
            <button className="runs-filter-button date" type="button" onClick={() => onAction("etl.runs.date_filter_opened", `/api/etl/jobs/${job.id}/runs/filters/date`, job.id)}><Calendar size={14} /> 날짜 선택</button>
          </div>
          <div className="runs-filters-right">
            <span>{runs.length} runs total</span>
            <button className="runs-refresh-button" type="button" onClick={() => onAction("etl.runs.refreshed", `/api/etl/jobs/${job.id}/runs`, job.id)}><RefreshCw size={14} /> 새로고침</button>
          </div>
        </div>

        <article className="runs-table-card">
          <div className="runs-table-scroll">
            <table className="runs-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>상태</th>
                <th>시작</th>
                <th>종료</th>
                <th>소요시간</th>
                <th>입력 행</th>
                <th>출력 행</th>
                <th>실패 단계</th>
                <th>로그</th>
                <th>액션</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr className="run-row">
                  <td colSpan={10}>아직 실행 이력이 없습니다. 작업을 실행하면 이 표에 Run이 추가됩니다.</td>
                </tr>
              )}
              {runs.map((row) => (
                <tr className={row.status === "failed" || row.status === "canceled" ? "run-row failed" : "run-row"} key={row.runId}>
                  <td>{row.runId}</td>
                  <td><RunStatusPill status={row.status} /></td>
                  <td>{formatCompactDateTime(row.startedAt)}</td>
                  <td>{formatCompactDateTime(row.endedAt)}</td>
                  <td>{row.duration}</td>
                  <td>{row.inputRows}</td>
                  <td>{row.outputRows}</td>
                  <td>{row.failedStage}</td>
                  <td>
                    <button className="runs-log-button" type="button" onClick={() => openRunLog(row)}>로그 보기</button>
                  </td>
                  <td>
                    <button className="runs-detail-button" type="button" onClick={() => openRunDetail(row)}>실행 단계 보기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="runs-pagination">
            <span>Showing {runs.length ? `1-${runs.length}` : "0"} of {runs.length}</span>
            <div>
              <button type="button" aria-label="이전 페이지" onClick={() => onAction("etl.runs.page_previous", `/api/etl/jobs/${job.id}/runs?page=previous`, job.id)}>‹</button>
              <button type="button" aria-label="다음 페이지" onClick={() => onAction("etl.runs.page_next", `/api/etl/jobs/${job.id}/runs?page=next`, job.id)}>›</button>
            </div>
          </div>
        </article>
      </section>
      {activeRun && <RunDagModal evidence={evidence} job={job} onAction={onAction} onClose={() => setActiveRun(null)} run={activeRun} />}
      {activeLogRun && <RunLogModal job={job} onClose={() => setActiveLogRun(null)} run={activeLogRun} />}
    </div>
  );
}

function RunStatusPill({ status }: { status: JobRunStatus }) {
  const statusMeta = runStatusMeta[status];

  return (
    <span className={`run-status-pill ${statusMeta.className}`}>
      {status === "running" && <span className="run-status-dot" />}
      {statusMeta.label}
    </span>
  );
}

function RunSummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="run-summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RunLogModal({ job, onClose, run }: { job: JobRowData; onClose: () => void; run: JobRunSummary }) {
  const logBody = normalizeWhitespace(run.errorSummary) || "표시할 로그가 없습니다.";

  return (
    <div className="job-log-modal" role="dialog" aria-modal="true" aria-label={`${run.runId} 로그`} onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <header className="job-log-modal-header">
          <div>
            <span>{run.runId} · {runStatusMeta[run.status].label}</span>
            <h2>{job.name}</h2>
            <p>{run.failedStage} · {formatCompactDateTime(run.startedAt)} - {formatCompactDateTime(run.endedAt)}</p>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose}><X size={16} />닫기</button>
        </header>
        <pre>{logBody}</pre>
      </section>
    </div>
  );
}

function RunDagModal({
  evidence,
  job,
  onAction,
  onClose,
  run,
}: {
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onClose: () => void;
  run: JobRunSummary;
}) {
  const [dagSearchOpen, setDagSearchOpen] = useState(false);
  const dagSteps = evidence?.dagSteps.length ? evidence.dagSteps : job.dagSteps ?? [];
  const currentRun = run;
  const textStructuringChecks = currentRun.textStructuringExecution?.columns ?? currentRun.textStructuring ?? [];
  const textStructuringSummary = currentRun.textStructuringExecution;
  const completedSteps = dagSteps.filter((step) => step.status === "success").length;
  const activeOrFailedStep = dagSteps.find((step) => step.status === "running" || step.status === "failed" || step.status === "blocked");
  const toggleSearch = () => {
    setDagSearchOpen((open) => !open);
    onAction("etl.dag.search_opened", `/api/etl/jobs/${job.id}/dag/search`, job.id);
  };

  const dagCanvas = (
    <div className="dag-canvas-expanded">
      <div className="dag-context-row">
        <strong>실행 컨텍스트</strong>
        <span>현재 Run의 단계별 상태와 작업 진행 순서를 확인합니다.</span>
        <div className="dag-legend">
          <DagStatePill status="success" />
          <DagStatePill status="failed" />
          <DagStatePill status="blocked" />
        </div>
      </div>

      <div className="dag-graph">
        <div className="dag-row dag-row-top">
          {dagSteps.slice(0, 4).map((step, index) => (
            <Fragment key={step.id}>
              <DagStepNode onSelect={() => onAction("etl.dag.node_selected", `/api/etl/jobs/${job.id}/dag/${step.id}`, step.id)} step={step} wide={index === 3} />
              {index < 3 && <div className="dag-arrow top" />}
            </Fragment>
          ))}
        </div>
        <div className="dag-down-arrow">
          <span>{currentRun.status === "failed" ? "실패 이후 중단" : "다음 단계"}</span>
        </div>
        <div className="dag-row dag-row-bottom">
          {dagSteps.slice(4).map((step, index) => (
            <Fragment key={step.id}>
              <DagStepNode onSelect={() => onAction("etl.dag.node_selected", `/api/etl/jobs/${job.id}/dag/${step.id}`, step.id)} step={step} wide={index === 3} />
              {index < 3 && <div className="dag-arrow muted bottom" />}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="run-dag-modal" role="dialog" aria-modal="true" aria-label={`${currentRun.runId} 실행 상세`} onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <header className="run-dag-modal-header">
          <div>
            <span>{job.name}</span>
            <h2>{currentRun.runId} 실행 상세</h2>
            <p>{currentRun.startedAt} · {runStatusMeta[currentRun.status].label}</p>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose}><X size={16} />닫기</button>
        </header>
        <div className="run-dag-modal-body">
          <section className="dag-body-content">
            <button className="dag-run-select" type="button" onClick={() => onAction("etl.dag.run_selector_opened", `/api/etl/jobs/${job.id}/runs`, job.id)}>
              {currentRun.runId} · {currentRun.startedAt} · {runStatusMeta[currentRun.status].label}
              <span>▾</span>
            </button>

            <div className="dag-summary-grid">
              <DagSummaryCard label="현재 상태" value={runStatusMeta[currentRun.status].label} />
              <DagSummaryCard label="소요 시간" value={currentRun.duration} />
              <DagSummaryCard label="진행 단계" value={`${completedSteps}/${dagSteps.length} steps`} />
              <DagSummaryCard helper={`→ ${currentRun.outputRows}`} label="처리 행수" value={currentRun.inputRows} />
              <DagSummaryCard label={currentRun.status === "failed" ? "실패 단계" : "현재 단계"} value={currentRun.failedStage !== "-" ? currentRun.failedStage : activeOrFailedStep?.title ?? "-"} />
            </div>

            {textStructuringChecks.length > 0 && (
              <article className="dag-flow-card">
                <div className="dag-flow-topbar">
                  <h2>Text structuring runtime</h2>
                  {textStructuringSummary && (
                    <span>
                      models {textStructuringSummary.modelColumns.length} - fallback {textStructuringSummary.fallbackColumns.length} - missing {textStructuringSummary.missingModelColumns.length}
                    </span>
                  )}
                </div>
                <div className="detail-table-scroll">
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Method</th>
                        <th>Execution</th>
                        <th>Artifact</th>
                        <th>Policy</th>
                        <th>Invalid</th>
                        <th>Distribution</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {textStructuringChecks.map((check, index) => (
                        <tr key={`${check.targetColumn || check.target || "column"}-${index}`}>
                          <td>{check.targetColumn || check.target || "-"}</td>
                          <td>{check.method || "-"}</td>
                          <td>{check.executionMode || (check.fallbackUsed ? "fallback_rule" : "-")}</td>
                          <td>{check.modelArtifact || check.selectedModelArtifact || "-"}</td>
                          <td>{check.modelSelectionPolicy || "-"}{check.fallbackAllowed ? " / fallback allowed" : ""}</td>
                          <td>{Number(check.invalidRows ?? 0).toLocaleString()}</td>
                          <td>{check.distributionWarning || (check.distinctOutputValues ? `${check.distinctOutputValues} values` : "-")}</td>
                          <td>{check.runtimeStatus || check.validationStatus || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            )}

            <article className="dag-flow-card">
              <div className="dag-flow-topbar">
                <h2>작업 진행 순서 / 실행 단계</h2>
                <div className="dag-flow-controls">
                  <button className={dagSearchOpen ? "active" : ""} type="button" aria-label="실행 단계 검색" onClick={toggleSearch}><Search size={16} /></button>
                </div>
              </div>
              {dagSearchOpen && (
                <div className="dag-search-panel">
                  <Search size={15} />
                  <input aria-label="실행 단계 검색" defaultValue="변환 규칙" />
                  <span>1개 단계 발견</span>
                </div>
              )}

              <div className="dag-canvas-scroll">
                {dagCanvas}
              </div>

              <div className="dag-selected-strip">
                <span>선택: 실행 단계 노드를 클릭하면 단계 상세 패널이 열립니다 · ETL 작업 수정 링크는 상세 패널에서 제공합니다</span>
                <strong>선택</strong>
              </div>
            </article>
          </section>
        </div>
      </section>
    </div>
  );
}

function DagSummaryCard({ helper, label, value }: { helper?: string; label: string; value: string }) {
  return (
    <article className="dag-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {helper && <em>{helper}</em>}
    </article>
  );
}

function DagStatePill({ status }: { status: JobDagStepStatus }) {
  const statusMeta = dagStepStatusDisplay(status);
  return <span className={`dag-state-pill ${statusMeta.className}`}>{statusMeta.label}</span>;
}

function DagStepNode({
  onSelect,
  step,
  wide,
}: {
  onSelect: () => void;
  step: JobDagStep;
  wide?: boolean;
}) {
  const tone = dagStepStatusDisplay(step.status).className;

  return (
    <button className={wide ? `dag-step-node ${tone} wide` : `dag-step-node ${tone}`} type="button" onClick={onSelect}>
      <span className="dag-step-dot" />
      <strong>{step.title}</strong>
      <span className="dag-step-meta">{step.meta}</span>
      <span className="dag-step-footer">
        <DagStatePill status={step.status} />
        {step.note && <em>{step.note}</em>}
      </span>
    </button>
  );
}
