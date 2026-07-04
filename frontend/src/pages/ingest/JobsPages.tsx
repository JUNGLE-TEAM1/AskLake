import { Fragment, useState } from "react";
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
import type { AuditResult, FlowId, JobCommand, JobRowData, JobStatus } from "../../types";

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
    ["실행 중", String(jobs.filter((job) => job.status === "실행 중").length)],
    ["스케줄됨", String(jobs.filter((job) => job.status === "스케줄됨").length)],
    ["실패", String(jobs.filter((job) => job.status === "실패").length)],
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
              <p>Source 연결과 Schema 확인을 마친 뒤 파이프라인을 생성하면 이 목록에 Job이 추가됩니다.</p>
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
              onRun={() => onCommand(job, job.status === "실패" ? "retry" : "run")}
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
  const actionLabel = job.status === "실행 중" ? "실행 흐름" : job.status === "실패" ? "다시 실행" : job.status === "일시정지" ? "재개" : "즉시 실행";
  const tertiaryLabel = job.status === "실행 중" ? "취소" : "수정";
  const statusClass = job.status === "실패" ? "failed" : job.status === "실행 중" ? "running" : job.status === "일시정지" ? "paused" : "scheduled";

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
          <div><dt>소스</dt><dd>{job.source}</dd></div>
          <div><dt>타깃</dt><dd>{job.target}</dd></div>
          <div><dt>스케줄</dt><dd>{job.schedule}</dd></div>
          <div><dt>마지막 실행</dt><dd>{job.lastRun}</dd><dd className={job.lastState === "실패" ? "danger-text" : ""}>{job.lastState}</dd></div>
          <div><dt>다음 실행</dt><dd>{job.nextRun}</dd></div>
        </dl>
        <div className="job-row-actions">
          <button className="job-action-button" type="button" onClick={onDetail}>상세</button>
          <button className="job-action-button primary" type="button" onClick={job.status === "실행 중" ? onDag : onRun}>{actionLabel}</button>
          <button className={job.status === "실행 중" ? "job-action-button danger" : "job-action-button"} type="button" onClick={job.status === "실행 중" ? onCancel : onEdit}>{tertiaryLabel}</button>
        </div>
      </div>
    </article>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill ${status === "실패" ? "danger" : status === "실행 중" ? "running" : status === "일시정지" ? "paused" : ""}`}>{status}</span>;
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

function DetailStatusStrip({ body, title, tone }: { body: string; title: string; tone: "danger" | "running" | "scheduled" }) {
  return (
    <section className={`detail-status-strip ${tone}`}>
      <strong>{title}</strong>
      <span>{body}</span>
    </section>
  );
}

function DetailMetricCard({ label, tone, value }: { label: string; tone?: "danger" | "running" | "scheduled"; value: string }) {
  return (
    <article className={tone ? `detail-metric-card ${tone}` : "detail-metric-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
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
      <button className="job-detail-breadcrumb" type="button" onClick={onDetail}>수집/처리 &gt; 작업 목록 &gt; {job.name}</button>
      <div className="job-detail-title-row">
        <div>
          <h1>{job.name}</h1>
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
  const statusText = job.status === "실패" ? "FAILED" : job.status === "실행 중" ? "RUNNING" : job.status === "일시정지" ? "PAUSED" : "SCHEDULED";
  const issueText = job.status === "실패" ? "age 필드 TYPE_CAST 규칙 실패" : job.status === "실행 중" || job.status === "일시정지" ? job.lastState : "최근 실행 성공";
  const averageDuration = job.status === "실행 중" ? "12.0m" : job.status === "실패" ? "14.1m" : "3.8m";
  const totalRuns = job.status === "실행 중" ? "128회" : job.status === "실패" ? "47회" : "86회";
  const lastSuccess = job.status === "실패" ? "2026-07-02 08:03" : job.lastRun;
  const successRate = job.status === "실패" ? "94.2%" : job.status === "실행 중" ? "진행 중" : "99.1%";
  const recentFailure = job.status === "실패" ? "run_002" : job.status === "실행 중" ? "없음" : "-";
  const currentStage = job.status === "실패" ? "Transform Rule 적용" : job.status === "실행 중" ? job.progress?.label ?? "Load to Lake" : job.status === "일시정지" ? "재개 대기" : "대기 중";
  const lastChangedBy = job.status === "실패" ? "data-team" : job.owner;
  const stripTone = job.status === "실패" ? "danger" : job.status === "실행 중" ? "running" : "scheduled";
  const stripTitle = job.status === "실패" ? "최근 실행 실패" : job.status === "실행 중" ? "현재 실행 중" : job.status === "일시정지" ? "작업 일시정지" : "스케줄 정상";
  const stripBody = job.status === "실패"
    ? "run_002 · Transform Rule 적용 단계에서 TYPE_CAST 실패가 발생했습니다. DAG에서 영향 단계를 확인하세요."
    : job.status === "실행 중"
      ? `${job.progress?.label ?? "Load to Lake"} · 현재 처리 중이며 실행 흐름에서 단계별 로그를 확인할 수 있습니다.`
      : job.status === "일시정지"
        ? "사용자 요청으로 실행이 일시정지되었습니다. 즉시 실행 또는 재실행으로 실행을 재개할 수 있습니다."
      : `${job.nextRun}에 다음 실행이 예약되어 있고 최근 실행 상태는 정상입니다.`;
  const schemaRows = job.status === "실패"
    ? [
      ["1", "user_id", "user_id", "String", "No", "-"],
      ["2", "age", "age", "Mixed", "Yes", "TYPE_CAST 실패"],
      ["3", "event_name", "event_name", "String", "No", "-"],
      ["4", "event_time", "event_time", "timestamp", "No", "-"],
      ["5", "raw_value", "raw_value", "String", "Yes", "-"],
    ]
    : job.status === "실행 중"
      ? [
        ["1", "event_id", "event_id", "String", "No", "검증 완료"],
        ["2", "user_id", "user_id", "String", "No", "검증 완료"],
        ["3", "event_time", "event_time", "timestamp", "No", "처리 중"],
        ["4", "page_url", "page_url", "String", "Yes", "검증 대기"],
        ["5", "raw_payload", "raw_payload", "JSON", "Yes", "처리 중"],
      ]
      : [
        ["1", "id", "id", "String", "No", "정상"],
        ["2", "created_at", "created_at", "timestamp", "No", "정상"],
        ["3", "amount", "amount", "Decimal", "Yes", "정상"],
        ["4", "status", "status", "String", "No", "정상"],
        ["5", "region", "region", "String", "Yes", "-"],
      ];
  const ruleRows = job.status === "실패"
    ? [
      ["TYPE_CAST", "age", "integer", "FAILED"],
      ["VALIDATION", "age", "age >= 0", "SKIPPED"],
      ["DEDUP", "user_id,event_time", "latest", "SKIPPED"],
    ]
    : job.status === "실행 중"
      ? [
        ["NORMALIZE", "event_time", "UTC timestamp", "RUNNING"],
        ["PARSE_JSON", "raw_payload", "flatten selected keys", "RUNNING"],
        ["VALIDATION", "event_id", "not null", "PENDING"],
      ]
      : [
        ["TYPE_CAST", "amount", "decimal(18,2)", "정상 적용"],
        ["VALIDATION", "created_at", "not null", "정상 적용"],
        ["DEDUP", "id", "latest", "정상 적용"],
      ];

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
              <Field label="Source" value={job.source} />
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
              <DetailMetricCard label="성공률" tone={stripTone} value={successRate} />
              <DetailMetricCard label="평균 실행시간" value={averageDuration} />
              <DetailMetricCard label="총 실행" value={totalRuns} />
              <DetailMetricCard label={job.status === "실패" ? "최근 실패" : "현재 단계"} tone={stripTone} value={job.status === "실패" ? recentFailure : currentStage} />
            </div>
            <div className="detail-meta-line">
              <span>마지막 성공: {lastSuccess}</span>
              <span>다음 실행: {job.nextRun}</span>
            </div>
            {job.progress && <JobProgress label={job.progress.label} value={job.progress.value} />}
          </article>
        </div>
      </section>

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>Source / Target 설정</h2>
        </div>
        <div className="job-detail-card-grid two-up">
          <article className="job-detail-card">
            <h3>Source 연결 설정</h3>
            <div className="detail-kv-grid">
              <Field label="Source 유형" value={sourceType} />
              <Field label="Source 경로" value={sourcePath} />
              <Field label="연결 상태" value={job.status === "실패" ? "생성 시 검증됨 · 처리 실패" : "생성 시 Source 검증 완료"} />
              <Field label="인증 방식" value={sourceType.includes("S3") || sourceType.includes("File") ? "MinIO/S3 access key" : sourceType.includes("Kafka") ? "Backend Kafka connector" : "Backend source connector"} />
              <Field label="읽기 방식" value={job.status === "실행 중" ? "Streaming" : "Batch Scan"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Target 저장 설정</h3>
            <div className="detail-kv-grid">
              <Field label="타깃 데이터셋" value={job.target} />
              <Field label="Lake 경로" value={`lake/${job.target}`} />
              <Field label="저장 포맷" value="Parquet" />
              <Field label="쓰기 모드" value={job.status === "실행 중" ? "Append Stream" : "Append + compact"} />
              <Field label="품질 체크" value={job.status === "실패" ? "Transform 전 중단" : "row count / schema check"} />
            </div>
            <div className="detail-meta-line">
              <span>Downstream: SQL · Dashboard · Catalog</span>
            </div>
          </article>
        </div>
      </section>

      <section className="job-detail-section">
        <div className="job-detail-section-heading">
          <h2>Schema / Transform</h2>
        </div>
        <article className="detail-table-card">
          <div className="detail-table-header">
            <h3>Schema 매핑</h3>
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
            <h3>Transform Rules</h3>
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
              <Field label="실행 유형" value={job.status === "실행 중" ? "실시간 수집" : "반복 실행"} />
              <Field label="주기" value={job.schedule} />
              <Field label="다음 실행" value={job.nextRun} />
              <Field label="재시도 정책" value={job.status === "실패" ? "3회 · backoff 10m" : "3회 · backoff 5m"} />
            </div>
          </article>
          <article className="job-detail-card">
            <h3>Permission</h3>
            <div className="detail-kv-grid">
              <Field label="Owner" value={job.owner} />
              <Field label="접근 그룹" value="Data Platform, Analytics" />
              <Field label="canRun" value={job.status === "실패" ? "Owner 승인 후 가능" : "true"} />
              <Field label="승인 상태" value={job.status === "실패" ? "재실행 승인 필요" : "승인됨"} />
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
}: {
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onDag: () => void;
}) {
  const runs: Array<{
    duration: string;
    endedAt: string;
    errorSummary: string;
    failedStage: string;
    inputRows: string;
    outputRows: string;
    runId: string;
    startedAt: string;
    status: "실행 중" | "실패" | "성공";
  }> = [
    { duration: "12m", endedAt: "-", errorSummary: "-", failedStage: "-", inputRows: "142,030", outputRows: "130,410", runId: "run_003", startedAt: "10:00", status: "실행 중" },
    { duration: "18s", endedAt: "10:10", errorSummary: "age 필드 타입 변환 실패", failedStage: "Transform Rule 적용", inputRows: "21,840", outputRows: "0", runId: "run_002", startedAt: "10:10", status: "실패" },
    { duration: "3m", endedAt: "08:03", errorSummary: "-", failedStage: "-", inputRows: "21,040", outputRows: "21,038", runId: "run_001", startedAt: "08:00", status: "성공" },
  ];

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
            <span>47 runs total</span>
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
              {runs.map((row) => (
                <tr className={row.status === "실패" ? "run-row failed" : "run-row"} key={row.runId}>
                  <td>{row.runId}</td>
                  <td><RunStatusPill status={row.status} /></td>
                  <td>{row.startedAt}</td>
                  <td>{row.endedAt}</td>
                  <td>{row.duration}</td>
                  <td>{row.inputRows}</td>
                  <td>{row.outputRows}</td>
                  <td>{row.failedStage}</td>
                  <td>{row.errorSummary}</td>
                  <td>
                    <button className="runs-detail-button" type="button" onClick={() => onAction("etl.run.detail_opened", `/api/etl/jobs/${job.id}/runs/${row.runId}`, row.runId)}>상세보기</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="runs-pagination">
            <span>Showing 1-3 of 47</span>
            <div>
              <button type="button" aria-label="이전 페이지" onClick={() => onAction("etl.runs.page_previous", `/api/etl/jobs/${job.id}/runs?page=previous`, job.id)}>‹</button>
              <button type="button" aria-label="다음 페이지" onClick={() => onAction("etl.runs.page_next", `/api/etl/jobs/${job.id}/runs?page=next`, job.id)}>›</button>
            </div>
          </div>
        </article>

        <article className="runs-stats-summary">
          <h2>실행 통계 요약</h2>
          <div>
            <RunSummaryMetric label="7일 성공률" value="94.2%" />
            <RunSummaryMetric label="평균 소요시간" value="14.1m" />
            <RunSummaryMetric label="총 실행" value="47회" />
          </div>
        </article>
      </section>
    </div>
  );
}

function RunStatusPill({ status }: { status: "실행 중" | "실패" | "성공" }) {
  return (
    <span className={`run-status-pill ${status === "실패" ? "failed" : status === "실행 중" ? "running" : "success"}`}>
      {status === "실행 중" && <span className="run-status-dot" />}
      {status}
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
  const [dagSearchOpen, setDagSearchOpen] = useState(false);
  const [dagFullscreenOpen, setDagFullscreenOpen] = useState(false);
  const [dagZoom, setDagZoom] = useState(0);
  const dagSteps: Array<{
    id: string;
    meta: string;
    note?: string;
    status: "성공" | "실패" | "중단";
    title: string;
  }> = [
    { id: "step-1", meta: "S3 · raw/user-log/*.csv", status: "성공", title: "1. Source 연결" },
    { id: "step-2", meta: "21,840 rows scanned", status: "성공", title: "2. 파일 읽기" },
    { id: "step-3", meta: "5 columns mapped", status: "성공", title: "3. Schema 매핑" },
    { id: "step-4", meta: "age TYPE_CAST → Integer", note: "cannot cast unknown", status: "실패", title: "4. Transform Rule" },
    { id: "step-5", meta: "age >= 0", status: "중단", title: "5. Validation" },
    { id: "step-6", meta: "user_activity", status: "중단", title: "6. Lake 적재" },
    { id: "step-7", meta: "row count / schema check", status: "중단", title: "7. 품질 체크" },
    { id: "step-8", meta: "SQL · Dashboard · Index", status: "중단", title: "8. Downstream 반영" },
  ];
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
        <span>실패 Run의 단계별 상태와 중단 영향 범위를 확인합니다.</span>
        <div className="dag-legend">
          <DagStatePill status="성공" />
          <DagStatePill status="실패" />
          <DagStatePill status="중단" />
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
          <span>실패 이후 중단</span>
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
    <div className="job-detail-page job-dag-page">
      <JobDetailHeader activeTab="dag" job={job} onAction={onAction} onCommand={onCommand} onDag={() => undefined} onDetail={onBack} onEdit={onEdit} onRuns={onRuns} />

      <section className="dag-body-content">
        <button className="dag-run-select" type="button" onClick={() => onAction("etl.dag.run_selector_opened", `/api/etl/jobs/${job.id}/runs`, job.id)}>
          run_002 · 2026-07-02 10:10 · FAILED
          <span>▾</span>
        </button>

        <div className="dag-summary-grid">
          <DagSummaryCard label="현재 상태" value="FAILED" />
          <DagSummaryCard label="소요 시간" value="00:00:18" />
          <DagSummaryCard label="진행 단계" value="4/8 steps" />
          <DagSummaryCard helper="→ 0 (Error)" label="처리 행수" value="21,840" />
          <DagSummaryCard label="실패 단계" value="Transform Rule 적용" />
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
              <input aria-label="DAG 단계 검색" defaultValue="Transform Rule" />
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

function DagStatePill({ status }: { status: "성공" | "실패" | "중단" }) {
  return <span className={`dag-state-pill ${status === "실패" ? "failed" : status === "중단" ? "paused" : "success"}`}>{status}</span>;
}

function DagStepNode({
  onSelect,
  step,
  wide,
}: {
  onSelect: () => void;
  step: { meta: string; note?: string; status: "성공" | "실패" | "중단"; title: string };
  wide?: boolean;
}) {
  const tone = step.status === "실패" ? "failed" : step.status === "중단" ? "paused" : "success";

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
