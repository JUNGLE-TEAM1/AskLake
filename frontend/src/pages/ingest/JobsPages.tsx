import { Fragment, useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  Check,
  CircleUser,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Info,
  LayoutGrid,
  Maximize2,
  Minus,
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
} from "lucide-react";
import { Field, PageTitle } from "../../components/common";
import type { AuditResult, FlowId, JobCommand, JobDagStep, JobDagStepStatus, JobExecutionEvidence, JobRowData, JobRunStatus, JobRunSummary, JobStats, JobStatus } from "../../types";
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

export function JobsLandingPage({
  jobs,
  onAction,
  onCommand,
  onCreate,
  onDag,
  onDetail,
  onRuns,
}: {
  jobs: JobRowData[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onCreate: () => void;
  onDag: () => void;
  onDetail: (job: JobRowData) => void;
  onRuns: () => void;
}) {
  const metrics = [
    ["전체 작업", String(jobs.length)],
    ["실행 중", String(jobs.filter((job) => job.status === "running").length)],
    ["스케줄됨", String(jobs.filter((job) => job.status === "scheduled").length)],
    ["실패", String(jobs.filter((job) => job.status === "failed").length)],
    ["최신 아님", "0"],
  ];

  return (
    <div className="jobs-landing">
      <div className="jobs-page-header">
        <PageTitle title="수집/처리" description="데이터 소스를 연결하고 ETL 작업의 상태, 실행, 로그를 관리합니다." />
        <button className="primary-button create-job-button" type="button" onClick={onCreate}>+ 새 수집/처리 생성</button>
      </div>
      <div className="content-main">
        <div className="metric-grid">
          {metrics.map(([label, value], index) => <MetricCard active={index === 0} key={label} label={label} value={value} />)}
        </div>
        <JobsToolbar onFilter={(filter) => onAction("etl.jobs.filter_opened", `/api/etl/jobs/filters/${filter}`, filter)} onReset={() => onAction("etl.jobs.filter_reset", "/api/etl/jobs", "filters")} />
        <section className="job-table" aria-label="ETL 작업 목록">
          {jobs.length === 0 && (
            <div className="job-empty-state">
              <Plus size={22} />
              <strong>생성된 수집/처리 작업이 없습니다.</strong>
              <p>소스 연결과 스키마 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다.</p>
              <button className="primary-button" type="button" onClick={onCreate}>새 수집/처리 생성</button>
            </div>
          )}
          {jobs.map((job) => (
            <JobRow
              job={job}
              key={job.id}
              onCancel={() => onCommand(job, "cancel")}
              onDag={onDag}
              onDetail={() => onDetail(job)}
              onEdit={() => onCommand(job, "edit")}
              onRun={() => onCommand(job, job.status === "failed" ? "retry" : "run")}
            />
          ))}
          {jobs.length > 0 && (
            <div className="job-table-footer">
              <span>1-{jobs.length} of {jobs.length}</span>
              <div>
                <button className="ghost-link" type="button" onClick={() => onAction("etl.jobs.page_previous", "/api/etl/jobs?page=previous", "jobs")}>← 이전</button>
                <button className="ghost-link" type="button" onClick={() => onAction("etl.jobs.page_next", "/api/etl/jobs?page=next", "jobs")}>다음 →</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MetricCard({ active, label, value }: { active?: boolean; label: string; value: string }) {
  return (
    <article className={active ? "metric-card active" : "metric-card"}>
      <span>{value}</span>
      <strong>{label}</strong>
    </article>
  );
}

function JobsToolbar({ onFilter, onReset }: { onFilter: (filter: string) => void; onReset: () => void }) {
  return (
    <section className="jobs-toolbar">
      <div className="jobs-search">
        <Search size={16} />
        <span>작업명, 소스명, 타깃 데이터셋명 검색</span>
      </div>
      {["상태", "소스", "Owner", "태그"].map((filter) => (
        <button className="filter-chip jobs-filter" key={filter} type="button" onClick={() => onFilter(filter)}>{filter} ▾</button>
      ))}
      <button className="ghost-link reset-filter" type="button" onClick={onReset}>↺ 필터 초기화</button>
    </section>
  );
}

function JobRow({
  job,
  onCancel,
  onDag,
  onDetail,
  onEdit,
  onRun,
}: {
  job: JobRowData;
  onCancel: () => void;
  onDag: () => void;
  onDetail: () => void;
  onEdit: () => void;
  onRun: () => void;
}) {
  const actionLabel = job.status === "running" ? "실행 흐름" : job.status === "failed" || job.status === "canceled" ? "다시 실행" : job.status === "paused" ? "재개" : "즉시 실행";
  const lastRunLabel = formatRunTimestamp(job.lastRun);
  const tertiaryLabel = job.status === "running" ? "취소" : "수정";
  const statusClass = jobStatusMeta[job.status].className;

  return (
    <article className={`job-row ${statusClass}`}>
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
            <span className="owner-chip">{job.owner}</span>
            <span className="tag-chip">{job.tag}</span>
          </div>
        </div>
        {job.progress && <JobProgress label={job.progress.label} value={job.progress.value} />}
        <dl className="job-row-details">
          <div><dt>소스</dt><dd title={job.source}>{job.source}</dd></div>
          <div><dt>타깃</dt><dd title={job.target}>{job.target}</dd></div>
          <div><dt>스케줄</dt><dd title={job.schedule}>{job.schedule}</dd></div>
          <div><dt>마지막 실행</dt><dd title={job.lastRun}>{lastRunLabel}</dd><dd className={job.lastState === "실패" ? "danger-text" : ""} title={job.lastState}>{job.lastState}</dd></div>
          <div><dt>다음 실행</dt><dd title={job.nextRun}>{job.nextRun}</dd></div>
        </dl>
        <div className="job-row-actions">
          <button className="job-action-button" type="button" onClick={onDetail}>상세</button>
          <button className="job-action-button primary" type="button" onClick={job.status === "running" ? onDag : onRun}>{actionLabel}</button>
          <button className={job.status === "running" ? "job-action-button danger" : "job-action-button"} type="button" onClick={job.status === "running" ? onCancel : onEdit}>{tertiaryLabel}</button>
        </div>
      </div>
    </article>
  );
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
  const issue = job.status === "failed" ? job.lastState : job.status === "running" ? "처리 중" : "정상";

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

function DetailStatusStrip({ body, title, tone }: { body: string; title: string; tone: "danger" | "running" | "scheduled" | "canceled" }) {
  return (
    <section className={`detail-status-strip ${tone}`}>
      <strong>{title}</strong>
      <span>{body}</span>
    </section>
  );
}

function DetailMetricCard({ label, tone, value }: { label: string; tone?: "danger" | "running" | "scheduled" | "canceled"; value: string }) {
  return (
    <article className={tone ? `detail-metric-card ${tone}` : "detail-metric-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function formatRunTimestamp(value: string) {
  if (!value || value === "-") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function JobDetailHeader({
  activeTab,
  job,
  onAction,
  onCommand,
  onDag,
  onDetail,
  onEdit,
  onRuns,
}: {
  activeTab: "detail" | "runs" | "dag";
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDag: () => void;
  onDetail: () => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  return (
    <header className="job-detail-header">
      <button className="job-detail-breadcrumb" title={`수집/처리 > 작업 목록 > ${job.name}`} type="button" onClick={onDetail}>수집/처리 &gt; 작업 목록 &gt; {job.name}</button>
      <div className="job-detail-title-row">
        <div>
          <h1 title={job.name}>{job.name}</h1>
          <div className="job-detail-meta">
            <StatusPill status={job.status} />
            <span className="owner-chip">Owner: {job.owner}</span>
            <span className="tag-chip">{job.tag.replace("[", "").replace("]", "")}</span>
          </div>
        </div>
        <div className="job-detail-actions">
          <button className="job-action-button" type="button" onClick={() => onCommand(job, "edit")}>수정</button>
          <button className="job-action-button primary" type="button" onClick={() => onCommand(job, "run")}>즉시 실행</button>
          <button className="job-action-button" type="button" onClick={() => onCommand(job, "retry")}>재실행</button>
          <button className="job-action-button" type="button" onClick={() => onCommand(job, "pause")}>일시정지</button>
          <button className="job-action-button" type="button" onClick={() => onCommand(job, "cancel")}>취소</button>
          <button className="job-action-button danger" type="button" onClick={() => onCommand(job, "delete")}>삭제</button>
        </div>
      </div>
      <nav className="job-detail-tabs" aria-label="작업 상세 탭">
        <button className={activeTab === "detail" ? "active" : ""} type="button" onClick={onDetail}>작업 상세 정보</button>
        <button className={activeTab === "runs" ? "active" : ""} type="button" onClick={onRuns}>실행 이력</button>
        <button className={activeTab === "dag" ? "active" : ""} type="button" onClick={onDag}>DAG</button>
      </nav>
    </header>
  );
}

export function JobDetailPage({
  job,
  onAction,
  onBack,
  onCommand,
  onDag,
  onEdit,
  onRuns,
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDag: () => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const sourceType = job.source.split(" / ")[0] ?? job.source;
  const sourcePath = job.source.split(" / ")[1] ?? job.source;
  const statusText = jobStatusMeta[job.status].summaryLabel;
  const stats = job.stats ?? fallbackJobStats(job);
  const physicalOutputPath = job.targetPath ?? stats.outputPath ?? `lake/${job.target}`;
  const issueText = job.status === "failed" ? job.lastState : job.status === "running" || job.status === "paused" || job.status === "canceled" ? stats.currentStage : "실행 전";
  const recentFailure = job.runHistory?.find((run) => run.status === "failed" || run.status === "canceled")?.runId ?? "-";
  const lastChangedBy = job.owner;
  const stripTone = job.status === "failed" ? "danger" : job.status === "running" ? "running" : job.status === "canceled" ? "canceled" : "scheduled";
  const stripTitle = job.status === "failed" ? "최근 실행 실패" : job.status === "running" ? "현재 실행 중" : job.status === "paused" ? "작업 일시정지" : job.status === "canceled" ? "최근 실행 취소" : "스케줄 정상";
  const stripBody = job.status === "failed"
    ? `${job.lastState} · 실행 이력과 DAG에서 영향 단계를 확인하세요.`
    : job.status === "running"
      ? `${job.progress?.label ?? stats.currentStage} · 현재 처리 중이며 실행 흐름에서 단계별 로그를 확인할 수 있습니다.`
      : job.status === "paused"
        ? "사용자 요청으로 실행이 일시정지되었습니다. 즉시 실행 또는 재실행으로 실행을 재개할 수 있습니다."
        : job.status === "canceled"
          ? "사용자 요청으로 실행이 취소되었습니다. 다시 실행하면 새 Run으로 처리 흐름을 재개할 수 있습니다."
          : job.runHistory?.length
            ? `${stats.currentStage} · 최근 실행 이력을 기준으로 표시합니다.`
            : "아직 실행 이력이 없습니다. 생성 시 검증된 소스/스키마 메타데이터만 표시합니다.";
  const schemaRows = schemaRowsForJob(job, stats);
  const ruleRows = ruleRowsForJob(job);

  return (
    <div className="job-detail-page">
      <JobDetailHeader activeTab="detail" job={job} onAction={onAction} onCommand={onCommand} onDag={onDag} onDetail={onBack} onEdit={onEdit} onRuns={onRuns} />

      <DetailStatusStrip body={stripBody} title={stripTitle} tone={stripTone} />

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>작업 핵심 정보</h2>
          <p>작업 요약과 실행 통계를 먼저 확인합니다.</p>
        </div>
        <div className="job-detail-card-grid summary-grid">
          <article className="job-detail-card summary-card">
            <h3>작업 요약</h3>
            <div className="detail-kv-grid summary-kv">
              <Field label="Job ID" value={job.id} />
              <Field label="Owner" value={job.owner} />
              <Field label="상태" value={statusText} />
              <Field label="소스" value={job.source} />
              <Field label="Target" value={job.target} />
              <Field label="최근 상태" value={job.lastState} />
            </div>
            <div className="detail-meta-line">
              <span>마지막 변경: {lastChangedBy}</span>
              <span>담당 그룹: {job.owner === "admin" ? "Data Platform" : "Analytics Ops"}</span>
            </div>
          </article>
          <article className="job-detail-card stats-card">
            <div className="stats-card-heading">
              <h3>실행 통계</h3>
            </div>
            <div className="detail-metric-grid">
              <DetailMetricCard label="성공률" tone={stripTone} value={stats.successRate} />
              <DetailMetricCard label="평균 실행시간" value={stats.averageDuration} />
              <DetailMetricCard label="총 실행" value={stats.totalRuns} />
              <DetailMetricCard label={job.status === "failed" || job.status === "canceled" ? "최근 실패/취소" : "현재 단계"} tone={stripTone} value={job.status === "failed" || job.status === "canceled" ? recentFailure : stats.currentStage} />
            </div>
            <div className="detail-meta-line">
              <span>마지막 성공: {stats.lastSuccess}</span>
              <span>다음 실행: {job.nextRun}</span>
            </div>
            {job.progress && <JobProgress label={job.progress.label} value={job.progress.value} />}
          </article>
        </div>
      </section>

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>소스 / 타겟 설정</h2>
        </div>
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>소스 연결 설정</h3>
            <div className="detail-kv-grid">
              <Field label="소스 유형" value={sourceType} />
              <Field label="소스 경로" value={sourcePath} />
              <Field label="연결 상태" value={job.status === "failed" ? "생성 시 검증됨 · 처리 실패" : "생성 시 소스 검증 완료"} />
              <Field label="인증 방식" value={sourceType.includes("S3") || sourceType.includes("File") ? "MinIO/S3 access key" : sourceType.includes("Kafka") ? "Backend Kafka connector" : "Backend source connector"} />
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
      </section>

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>스키마 / 변환</h2>
        </div>
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
            <span>{issueText}</span>
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
      </section>

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>Schedule / Permission</h2>
        </div>
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>Schedule</h3>
            <div className="detail-kv-grid">
              <Field label="실행 유형" value={job.status === "running" ? "실시간 수집" : "반복 실행"} />
              <Field label="주기" value={job.schedule} />
              <Field label="다음 실행" value={job.nextRun} />
              <Field label="재시도 정책" value={job.status === "failed" ? "3회 · backoff 10m" : "3회 · backoff 5m"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Permission</h3>
            <div className="detail-kv-grid">
              <Field label="Owner" value={job.owner} />
              <Field label="접근 그룹" value="Data Platform, Analytics" />
              <Field label="canRun" value={job.status === "failed" ? "Owner 승인 후 가능" : "true"} />
              <Field label="승인 상태" value={job.status === "failed" ? "재실행 승인 필요" : "승인됨"} />
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}

export function JobRunsPage({
  job,
  onAction,
  onBack,
  onCommand,
  onDag,
  onRunSelect,
  runs,
  selectedRunId,
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDag: () => void;
  onRunSelect: (jobId: string, runId: string) => void;
  runs: JobRunSummary[];
  selectedRunId?: string;
}) {
  const effectiveSelectedRunId = selectedRunId ?? runs[0]?.runId;
  const runStats = useMemo(() => {
    const successCount = runs.filter((run) => run.status === "success").length;
    const runningCount = runs.filter((run) => run.status === "running" || run.status === "queued").length;
    const latestFailure = runs.find((run) => run.status === "failed" || run.status === "canceled");
    return {
      runningCount,
      successRate: runs.length > 0 ? `${Math.round((successCount / runs.length) * 100)}%` : "-",
      totalRuns: `${runs.length}회`,
      latestFailure: latestFailure?.runId ?? "-",
    };
  }, [runs]);

  useEffect(() => {
    if (!selectedRunId && runs[0]?.runId) {
      onRunSelect(job.id, runs[0].runId);
    }
  }, [job.id, onRunSelect, runs, selectedRunId]);

  const selectRun = (run: JobRunSummary) => {
    onRunSelect(job.id, run.runId);
    onAction("etl.run.selected", `/api/etl/jobs/${job.id}/runs/${run.runId}`, run.runId);
  };

  const openDagForRun = (event: React.MouseEvent<HTMLButtonElement>, run: JobRunSummary) => {
    event.stopPropagation();
    onRunSelect(job.id, run.runId);
    onAction("etl.run.dag_opened", `/api/etl/jobs/${job.id}/runs/${run.runId}/dag`, run.runId);
    onDag();
  };

  const handleRunKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, run: JobRunSummary) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectRun(run);
  };

  return (
    <div className="job-detail-page job-runs-page">
      <JobDetailHeader activeTab="runs" job={job} onAction={onAction} onCommand={onCommand} onDag={onDag} onDetail={onBack} onEdit={onBack} onRuns={() => undefined} />

      <section className="runs-body-content">
        <div className="runs-filter-bar">
          <div className="runs-filters-left">
            <button className="runs-filter-button" type="button" onClick={() => onAction("etl.runs.status_filter_opened", `/api/etl/jobs/${job.id}/runs/filters/status`, job.id)}>상태: 전체 <span>▾</span></button>
            <button className="runs-filter-button date" type="button" onClick={() => onAction("etl.runs.date_filter_opened", `/api/etl/jobs/${job.id}/runs/filters/date`, job.id)}><Calendar size={14} /> 날짜 선택</button>
          </div>
          <div className="runs-filters-right">
            <span>총 {runs.length}회 실행</span>
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
                <th>에러 요약</th>
                <th>액션</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td className="runs-empty-cell" colSpan={10}>
                    <div className="runs-empty-state">
                      <Clock3 size={22} />
                      <strong>아직 실행 이력이 없습니다.</strong>
                      <span>작업을 실행하면 실행 중 Run부터 이 표에 표시됩니다.</span>
                    </div>
                  </td>
                </tr>
              )}
              {runs.map((row) => (
                <tr
                  aria-selected={row.runId === effectiveSelectedRunId}
                  className={[
                    "run-row",
                    row.status === "failed" || row.status === "canceled" ? "failed" : "",
                    row.status === "running" || row.status === "queued" ? "running" : "",
                    row.runId === effectiveSelectedRunId ? "selected" : "",
                  ].filter(Boolean).join(" ")}
                  key={row.runId}
                  onClick={() => selectRun(row)}
                  onKeyDown={(event) => handleRunKeyDown(event, row)}
                  tabIndex={0}
                >
                  <td title={row.runId}>{row.runId}</td>
                  <td><RunStatusPill status={row.status} /></td>
                  <td title={row.startedAt}>{formatRunTimestamp(row.startedAt)}</td>
                  <td title={row.endedAt}>{formatRunTimestamp(row.endedAt)}</td>
                  <td>{row.duration}</td>
                  <td>{row.inputRows}</td>
                  <td>{row.outputRows}</td>
                  <td title={row.failedStage}>{row.failedStage}</td>
                  <td title={row.errorSummary}>{row.errorSummary}</td>
                  <td>
                    <button className="runs-detail-button" type="button" onClick={(event) => openDagForRun(event, row)}>DAG 보기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="runs-pagination">
            <span>{runs.length ? `1-${runs.length}` : "0"} / {runs.length} 표시</span>
            <div>
              <button type="button" aria-label="이전 페이지" onClick={() => onAction("etl.runs.page_previous", `/api/etl/jobs/${job.id}/runs?page=previous`, job.id)}>‹</button>
              <button type="button" aria-label="다음 페이지" onClick={() => onAction("etl.runs.page_next", `/api/etl/jobs/${job.id}/runs?page=next`, job.id)}>›</button>
            </div>
          </div>
        </article>

        <article className="runs-stats-summary">
          <h2>실행 통계 요약</h2>
          <div>
            <RunSummaryMetric label="성공률" value={runStats.successRate} />
            <RunSummaryMetric label="평균 소요시간" value={job.stats?.averageDuration ?? "-"} />
            <RunSummaryMetric label="총 실행" value={runStats.totalRuns} />
            <RunSummaryMetric label="진행 중" value={`${runStats.runningCount}회`} />
            <RunSummaryMetric label="최근 실패" value={runStats.latestFailure} />
          </div>
        </article>
      </section>
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

export function JobDagPage({
  evidence,
  job,
  onAction,
  onBack,
  onCommand,
  onEdit,
  onRuns,
}: {
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onEdit: () => void;
  onRuns: () => void;
}) {
  const [dagSearchOpen, setDagSearchOpen] = useState(false);
  const [dagFullscreenOpen, setDagFullscreenOpen] = useState(false);
  const [dagZoom, setDagZoom] = useState(0);
  const dagSteps = evidence?.dagSteps.length ? evidence.dagSteps : job.dagSteps ?? [];
  const runHistory = evidence?.runs.length ? evidence.runs : job.runHistory ?? [];
  const currentRun = runHistory[0] ?? {
    duration: "-",
    endedAt: "-",
    errorSummary: "-",
    failedStage: "-",
    inputRows: job.stats?.inputRows ?? "-",
    outputRows: job.stats?.outputRows ?? "0",
    runId: "실행 전",
    startedAt: "-",
    status: "queued" as JobRunStatus,
  };
  const completedSteps = dagSteps.filter((step) => step.status === "success").length;
  const activeOrFailedStep = dagSteps.find((step) => step.status === "running" || step.status === "failed" || step.status === "blocked");
  const dagZoomClass = `zoom-${dagZoom}`;
  const zoomIn = () => {
    setDagZoom((zoom) => Math.min(2, zoom + 1));
    onAction("etl.dag.zoom_in", `/api/etl/jobs/${job.id}/dag/view`, job.id);
  };
  const zoomOut = () => {
    setDagZoom((zoom) => Math.max(0, zoom - 1));
    onAction("etl.dag.zoom_out", `/api/etl/jobs/${job.id}/dag/view`, job.id);
  };
  const toggleSearch = () => {
    setDagSearchOpen((open) => !open);
    onAction("etl.dag.search_opened", `/api/etl/jobs/${job.id}/dag/search`, job.id);
  };
  const openFullscreen = () => {
    setDagFullscreenOpen(true);
    onAction("etl.dag.fullscreen_opened", `/api/etl/jobs/${job.id}/dag/fullscreen`, job.id);
  };

  const dagCanvas = (
    <div className="dag-canvas-expanded">
      <div className="dag-context-row">
        <strong>Run context</strong>
        <span>현재 Run의 단계별 상태와 처리 흐름을 확인합니다.</span>
        <div className="dag-legend">
          <DagStatePill status="success" />
          <DagStatePill status="failed" />
          <DagStatePill status="blocked" />
        </div>
      </div>

      <div className="dag-linear-graph">
        {dagSteps.map((step, index) => (
          <Fragment key={step.id}>
            <DagStepNode onSelect={() => onAction("etl.dag.node_selected", `/api/etl/jobs/${job.id}/dag/${step.id}`, step.id)} step={step} />
            {index < dagSteps.length - 1 && <div className="dag-arrow" />}
          </Fragment>
        ))}
      </div>
    </div>
  );

  return (
    <div className="job-detail-page job-dag-page">
      <JobDetailHeader activeTab="dag" job={job} onAction={onAction} onCommand={onCommand} onDag={() => undefined} onDetail={onBack} onEdit={onEdit} onRuns={onRuns} />

      <section className="dag-body-content">
        <button className="dag-run-select" title={`${currentRun.runId} · ${currentRun.startedAt} · ${runStatusMeta[currentRun.status].label}`} type="button" onClick={() => onAction("etl.dag.run_selector_opened", `/api/etl/jobs/${job.id}/runs`, job.id)}>
          {currentRun.runId} · {formatRunTimestamp(currentRun.startedAt)} · {runStatusMeta[currentRun.status].label}
          <span>▾</span>
        </button>

        <div className="dag-summary-grid">
          <DagSummaryCard label="현재 상태" value={runStatusMeta[currentRun.status].label} />
          <DagSummaryCard label="소요 시간" value={currentRun.duration} />
          <DagSummaryCard label="진행 단계" value={`${completedSteps}/${dagSteps.length} steps`} />
          <DagSummaryCard helper={`→ ${currentRun.outputRows}`} label="처리 행수" value={currentRun.inputRows} />
          <DagSummaryCard label={currentRun.status === "failed" ? "실패 단계" : "현재 단계"} value={currentRun.failedStage !== "-" ? currentRun.failedStage : activeOrFailedStep?.title ?? "-"} />
        </div>

        <article className="dag-flow-card">
          <div className="dag-flow-topbar">
            <h2>실행 DAG / 단계 흐름</h2>
            <div className="dag-flow-controls">
              <button className={dagSearchOpen ? "active" : ""} type="button" aria-label="DAG 검색" onClick={toggleSearch}><Search size={16} /></button>
              <button type="button" aria-label="확대" onClick={zoomIn}><Plus size={16} /></button>
              <button type="button" aria-label="축소" onClick={zoomOut}><Minus size={16} /></button>
              <button type="button" aria-label="전체화면" onClick={openFullscreen}><Maximize2 size={16} /></button>
            </div>
          </div>
          {dagSearchOpen && (
            <div className="dag-search-panel">
              <Search size={15} />
              <input aria-label="DAG 단계 검색" defaultValue="변환 규칙" />
              <span>1개 단계 발견</span>
            </div>
          )}

          <div className={`dag-canvas-scroll ${dagZoomClass}`}>
            {dagCanvas}
          </div>

          <div className="dag-selected-strip">
            <span>선택: 노드를 클릭하면 실행 상세 패널이 열립니다 · ETL 작업 수정 링크는 상세 패널에서 제공합니다</span>
            <strong>선택</strong>
          </div>
        </article>
      </section>
      {dagFullscreenOpen && (
        <div className="dag-fullscreen-modal" role="dialog" aria-modal="true" aria-label="DAG 전체화면">
          <section>
            <div className="dag-fullscreen-header">
              <div>
                <span>DAG FULLSCREEN</span>
                <h2>실행 DAG / 단계 흐름</h2>
              </div>
              <button type="button" onClick={() => setDagFullscreenOpen(false)}>닫기</button>
            </div>
            <div className="dag-canvas-scroll zoom-2">
              {dagCanvas}
            </div>
          </section>
        </div>
      )}
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
  const statusMeta = dagStepStatusMeta[status];
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
  const tone = dagStepStatusMeta[step.status].className;

  return (
    <button className={wide ? `dag-step-node ${tone} wide` : `dag-step-node ${tone}`} title={`${step.title} · ${step.meta}`} type="button" onClick={onSelect}>
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
