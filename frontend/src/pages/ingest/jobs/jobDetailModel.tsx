
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";

import { Database } from "lucide-react";

import { getSourceBrandMeta } from "../../../components/source/SourceBrand";

import { Badge } from "@/components/ui/badge";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getIdentityInitials, UserIdentity } from "@/components/ui/user-identity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type DataTableColumnMeta } from "@/components/ui/data-table";
import { DataTableCellPrimary, DataTableCellSecondary, DataTableStackedCell } from "@/components/ui/data-table-stacked-cell";

import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

import { KeyValueList, type KeyValueListItem } from "@/components/ui/key-value-list";

import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";

import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";

import { cn } from "@/lib/utils";
import type { JobRowData, JobStats } from "../../../types";
import { jobStatusMeta } from "../../../utils/statusMeta";
import { formatCompactDateTime, getJobStatusTone, getLatestProblemRun, getLatestRunOutcome, isContinuousKafkaJob, isRealtimeJob } from "./jobShared";
import { normalizeWhitespace } from "./jobText";

export { normalizeWhitespace } from "./jobText";

export type JobExecutionDisplay = {
  raw: string;
  stage: string;
  summary: string;
  tone: "danger" | "normal";
};

export function getJobExecutionDisplay(job: JobRowData): JobExecutionDisplay {
  const problemRun = getLatestProblemRun(job);
  const problemStage = normalizeShortText(problemRun?.failedStage);
  const errorSummary = normalizeShortText(problemRun?.errorSummary);
  const rawCandidates = [job.lastState, problemRun?.errorSummary ?? ""].map((value) => value.trim()).filter(Boolean);
  const raw = rawCandidates.sort((first, second) => second.length - first.length)[0] ?? job.lastState;
  const latestOutcome = getLatestRunOutcome(job);
  const isProblem = latestOutcome === "failed" || latestOutcome === "canceled" || /실행 실패|취소됨/.test(job.lastState);
  const stage = problemStage && problemStage !== "-" ? problemStage : isProblem ? "실패 단계 미확인" : job.progress?.label ?? jobStatusMeta[job.status].summaryLabel;
  const fallbackSummary = isProblem ? compactLogSummary(raw) : normalizeWhitespace(job.lastState);
  const summarySource = errorSummary && errorSummary !== "-" && !isVerboseLogText(errorSummary) ? errorSummary : fallbackSummary;
  const normalizedSummary = summarySource === "실패" || summarySource === "FAILED" ? "실패 원인 확인 필요" : summarySource;
  const summary = truncateText(normalizedSummary || jobStatusMeta[job.status].summaryLabel, isProblem ? 72 : 58);
  return {
    raw: raw || "-",
    stage,
    summary,
    tone: isProblem ? "danger" : "normal",
  };
}

export function hasLatestSuccessfulRun(job: JobRowData) {
  const latestRun = job.runHistory?.[0];
  if (latestRun) return latestRun.status === "success";

  return /^(성공|success)$/i.test(normalizeWhitespace(job.lastState));
}

export function normalizeShortText(value?: string) {
  if (!value) return "";
  return value.trim();
}

export function isVerboseLogText(value: string) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length > 120) return true;
  return /warning:|exception|traceback|spark|ivy|\/opt\/spark|hadoop-aws|jar:file|download|successfully/i.test(normalized);
}

export function compactLogSummary(value: string) {
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

export function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export function StatusPill({ job }: { job: JobRowData }) {
  const showExecutionProgress = job.status === "running"
    && !isContinuousKafkaJob(job)
    && !isRealtimeJob(job)
    && job.progress !== undefined;

  return (
    <div className={cn(
      "grid h-full min-w-[184px] justify-items-center px-3",
      showExecutionProgress
        ? "min-h-[132px] grid-rows-[1fr_auto] gap-2 pb-3 pt-5"
        : "min-h-[100px] content-center py-3",
    )}>
      <StatusBadge
        className={cn(
          "min-w-[160px] justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2.5 text-base font-semibold",
          showExecutionProgress && "self-end translate-y-0.5",
        )}
        tone={getJobStatusTone(job.status)}
      >
        {job.status === "running" && <Spinner className="size-4" aria-label="실행 중" />}
        {jobStatusMeta[job.status].label}
      </StatusBadge>
      {showExecutionProgress && job.progress ? (
        <div className="w-full self-end text-left">
          <Progress
            aria-label={`${job.progress.label} ${job.progress.value}%`}
            className="w-full"
            indicatorClassName="bg-green-500"
            value={job.progress.value}
          >
            <ProgressLabel className="text-left text-sm" title={job.progress.label}>{job.progress.label}</ProgressLabel>
            <ProgressValue className="text-right text-sm" />
          </Progress>
        </div>
      ) : null}
    </div>
  );
}

export function OwnerIdentity({
  job,
  layout = "stacked",
}: {
  job: JobRowData;
  layout?: "header" | "stacked";
}) {
  const timestamp = job.updatedAt ?? job.createdAt;
  const timestampLabel = job.updatedAt ? "최근 수정" : "생성";

  if (layout === "header") {
    return (
      <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="lg">
            {job.ownerAvatarUrl && <AvatarImage alt={`${job.owner} 프로필`} src={job.ownerAvatarUrl} />}
            <AvatarFallback className="bg-slate-100 font-semibold text-slate-700 ring-1 ring-slate-200">
              {getIdentityInitials(job.owner)}
            </AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 gap-0.5 text-left">
            <span className="text-sm font-semibold text-slate-500">소유자</span>
            <span className="truncate text-base font-semibold text-slate-800" title={job.owner}>{job.owner}</span>
          </div>
        </div>
        {timestamp && (
          <div className="grid shrink-0 gap-0.5 text-right">
            <span className="text-sm font-semibold text-slate-500">{timestampLabel}</span>
            <time className="text-base font-medium tabular-nums text-slate-700" dateTime={timestamp} title={`${timestampLabel} ${timestamp}`}>
              {formatCompactDateTime(timestamp)}
            </time>
          </div>
        )}
      </div>
    );
  }

  return (
    <UserIdentity
      avatarUrl={job.ownerAvatarUrl}
      name={job.owner}
      secondary={timestamp ? `${timestampLabel} ${formatCompactDateTime(timestamp)}` : undefined}
    />
  );
}

export function fallbackJobStats(job: JobRowData): JobStats {
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

export function formatOperationalRate(value: number | null) {
  return value === null ? "-" : `${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

export function formatOperationalDelay(value: number | null) {
  if (value === null) return "-";
  if (value < 1000) return `${value.toLocaleString("ko-KR")}ms`;
  return `${(value / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}초`;
}

export const jobDetailFieldLabelMap: Record<string, string> = {
  Accept: "응답 형식",
  Aggregation: "집계 주기",
  Authentication: "인증",
  "Authentication Type": "인증 방식",
  "Broker / Endpoint": "브로커 / 엔드포인트",
  "Bootstrap Server": "부트스트랩 서버",
  Bucket: "버킷",
  "Bucket / Stage Name": "버킷 / 스테이지 이름",
  "CATALOG / NAMESPACE": "카탈로그 / 네임스페이스",
  Collection: "컬렉션",
  "Connection URI": "연결 URI",
  "Consumer Group": "컨슈머 그룹",
  "CONSUMER GROUP ID": "컨슈머 그룹 ID",
  "DATASET OR TABLE SELECTOR": "데이터셋 또는 테이블 선택자",
  Database: "데이터베이스",
  "DATABASE / SCHEMA": "데이터베이스 / 스키마",
  "Database Name": "데이터베이스 이름",
  Dataset: "데이터셋",
  Delimiter: "구분자",
  Encoding: "인코딩",
  Endpoint: "엔드포인트",
  "Endpoint / Host": "엔드포인트 / 호스트",
  "Endpoint URL": "엔드포인트 URL",
  "File Type": "파일 형식",
  Format: "파일 형식",
  Header: "헤더 처리",
  Host: "호스트",
  "Incremental Key": "증분 기준 키",
  "Lake Access": "레이크 접근",
  "Lake Type": "레이크 유형",
  "Message Format": "메시지 형식",
  Method: "메서드",
  Offset: "시작 오프셋",
  "Offset Policy": "오프셋 정책",
  "Pagination Strategy": "페이지네이션 방식",
  Path: "경로",
  "Path / Prefix": "경로 / 프리픽스",
  Port: "포트",
  Prefix: "경로 접두사",
  Region: "리전",
  "Root Path": "루트 경로",
  "Storage Provider": "스토리지 제공자",
  "Stream Type": "스트림 유형",
  Table: "테이블",
  Topic: "토픽",
  "TOPIC / QUEUE NAME": "토픽 / 큐 이름",
  Username: "사용자 이름",
  "Use Path Style": "Path Style 사용",
  Window: "집계 범위",
};

export const hiddenJobDetailFieldLabels = new Set([
  "Access Key",
  "Password / Auth Token",
  "Secret Key",
  "Token / Secret",
]);

export function getJobDetailFieldLabel(label: string) {
  return jobDetailFieldLabelMap[label] ?? label;
}

export function isVisibleJobDetailField(label: string) {
  return !label.startsWith("__") && !hiddenJobDetailFieldLabels.has(label);
}

export type JobEndpointItem = {
  label: string;
  value: string;
};

export function sourceConfigValue(job: JobRowData, labels: string[]) {
  const values = new Map(job.sourceConfig ?? []);
  for (const label of labels) {
    const value = values.get(label)?.trim();
    if (value) return value;
  }
  return "";
}

export function inferSourceFileFormat(job: JobRowData, sourcePath: string) {
  const configuredFormat = sourceConfigValue(job, ["File Type", "Format"]);
  if (configuredFormat && configuredFormat.toLowerCase() !== "auto") return configuredFormat;

  const normalizedPath = sourcePath.split(/[?#]/)[0].toLowerCase();
  if (normalizedPath.endsWith(".parquet")) return "Parquet";
  if (normalizedPath.endsWith(".csv")) return "CSV";
  if (normalizedPath.endsWith(".jsonl") || normalizedPath.endsWith(".ndjson")) return "JSONL";
  if (normalizedPath.endsWith(".json")) return "JSON";
  if (normalizedPath.endsWith(".avro")) return "Avro";
  return configuredFormat;
}

export function inferObjectSourceScope(sourcePath: string) {
  if (/[*?{}]/.test(sourcePath)) return "경로 패턴";
  const normalizedPath = sourcePath.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  if (/\.(avro|csv|json|jsonl|ndjson|orc|parquet)$/.test(normalizedPath)) return "단일 파일";
  return "폴더 / 프리픽스";
}

export function inferSourceReadMode(job: JobRowData, sourceType: string) {
  const configuredMode = sourceConfigValue(job, ["Read Mode", "읽기 방식"]);
  if (configuredMode) return configuredMode;
  if (sourceType.includes("kafka") || sourceType.includes("stream")) return "연속 수집";
  if (sourceConfigValue(job, ["Incremental Key", "Offset Policy", "Offset"])) return "증분 수집";
  return "전체 스캔";
}

export function compactSourceConfigItems(job: JobRowData, rawSourceType: string, sourcePath: string): JobEndpointItem[] {
  const sourceType = rawSourceType.toLowerCase();
  const item = (label: string, value: string): JobEndpointItem | null => value ? { label, value } : null;
  const compact = (items: Array<JobEndpointItem | null>) => items.filter((value): value is JobEndpointItem => Boolean(value));

  if (sourceType.includes("file") || sourceType.includes("s3") || sourceType.includes("minio")) {
    const fileFormat = inferSourceFileFormat(job, sourcePath);
    const isCsv = fileFormat.toLowerCase() === "csv";
    return compact([
      item("소스 경로", sourcePath),
      item("파일 형식", fileFormat),
      item("읽기 범위", inferObjectSourceScope(sourcePath)),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      isCsv ? item("구분자", sourceConfigValue(job, ["Delimiter"])) : null,
      isCsv ? item("헤더 처리", sourceConfigValue(job, ["Header"])) : null,
    ]);
  }

  if (sourceType.includes("kafka") || sourceType.includes("stream")) {
    return compact([
      item("브로커 / 엔드포인트", sourceConfigValue(job, ["Broker / Endpoint", "Bootstrap Server"])),
      item("토픽", sourceConfigValue(job, ["TOPIC / QUEUE NAME", "Topic"])),
      item("컨슈머 그룹", sourceConfigValue(job, ["CONSUMER GROUP ID", "Consumer Group"])),
      item("메시지 형식", sourceConfigValue(job, ["Message Format", "Format"])),
      item("시작 오프셋", sourceConfigValue(job, ["Offset Policy", "Offset"])),
      item("수집 방식", inferSourceReadMode(job, sourceType)),
    ]);
  }

  if (sourceType.includes("postgres") || sourceType.includes("mysql") || sourceType.includes("database")) {
    return compact([
      item("호스트", sourceConfigValue(job, ["Host", "Endpoint / Host"])),
      item("데이터베이스", sourceConfigValue(job, ["Database", "Database Name"])),
      item("테이블", sourceConfigValue(job, ["Table", "DATASET OR TABLE SELECTOR"])),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      item("증분 기준 키", sourceConfigValue(job, ["Incremental Key"])),
    ]);
  }

  if (sourceType.includes("mongo")) {
    return compact([
      item("엔드포인트 / 호스트", sourceConfigValue(job, ["Endpoint / Host", "Host", "Endpoint"])),
      item("데이터베이스", sourceConfigValue(job, ["Database Name", "Database"])),
      item("컬렉션", sourceConfigValue(job, ["Collection"])),
      item("읽기 방식", inferSourceReadMode(job, sourceType)),
      item("증분 기준 키", sourceConfigValue(job, ["Incremental Key"])),
    ]);
  }

  if (sourceType.includes("sql result")) {
    return compact([
      item("소스 데이터셋", sourceConfigValue(job, ["Source Dataset"])),
      item("SQL 실행 ID", sourceConfigValue(job, ["SQL Run ID"])),
    ]);
  }

  const fallbackItems = (job.sourceConfig ?? [])
    .filter(([label, value]) => isVisibleJobDetailField(label) && value.trim())
    .slice(0, 4)
    .map(([label, value]) => ({ label: getJobDetailFieldLabel(label), value }));
  return fallbackItems.length > 0 ? fallbackItems : [{ label: "소스 경로", value: sourcePath }];
}

export function getJobListSourceDisplay(job: JobRowData) {
  const sourceParts = job.source
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean);
  const rawType = job.sourceType?.trim()
    || (sourceParts[0] === "File" && sourceParts[1] === "S3" ? "File / S3" : sourceParts[0])
    || "소스";
  const inferredPath = rawType === "File / S3" && sourceParts[0] === "File" && sourceParts[1] === "S3"
    ? sourceParts.slice(2).join(" / ")
    : sourceParts.slice(1).join(" / ");

  const path = job.sourceLabel?.trim() || inferredPath || job.source;

  const brand = getSourceBrandMeta(rawType);

  return {
    brandKind: brand.kind,
    path,
    type: brand.label,
  };
}

export const ruleActionLabelMap: Record<string, string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 실패 처리",
  Quarantine: "격리",
  "Set Null": "NULL 처리",
  Warn: "경고 기록",
};

export const validationTypeLabelMap: Record<string, string> = {
  "Accepted Values": "허용값 검사",
  "Not Null": "NULL 불가",
  "Range Check": "범위 검사",
  "Regex Match": "정규식 검사",
};

export function getRuleActionLabel(value: string) {
  return ruleActionLabelMap[value] ?? value;
}

export const detailKeyValueListClassName = "grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 [&>div]:min-w-0 [&_dt]:mb-1.5 [&_dt]:text-sm [&_dt]:font-bold [&_dt]:text-slate-500 [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold [&_dd]:leading-7 [&_dd]:text-slate-900 [&_dd]:[overflow-wrap:anywhere]";

export const endpointKeyValueListClassName = "grid grid-cols-1 gap-x-8 sm:grid-cols-2 [&>div]:min-w-0 [&>div]:border-b [&>div]:border-slate-100 [&>div]:py-4 [&_dt]:mb-1.5 [&_dt]:text-sm [&_dt]:font-bold [&_dt]:text-slate-500 [&_dd]:m-0 [&_dd]:text-base [&_dd]:font-semibold [&_dd]:leading-7 [&_dd]:text-slate-950 [&_dd]:[overflow-wrap:anywhere]";

export function JobEndpointCard({
  badge,
  icon,
  items,
  tone,
  title,
}: {
  badge: string;
  icon: React.ReactNode;
  items: KeyValueListItem[];
  tone: "source" | "target";
  title: string;
}) {
  const isSource = tone === "source";

  return (
    <Card
      className={`relative h-full overflow-hidden border-slate-200 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.45)] before:absolute before:inset-x-0 before:top-0 before:h-0.5 ${isSource ? "before:bg-blue-500" : "before:bg-emerald-500"}`}
      size="none"
    >
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4">
        <span className={`grid size-11 place-items-center rounded-md ring-1 ring-inset ${isSource ? "bg-blue-50 text-blue-600 ring-blue-100" : "bg-emerald-50 text-emerald-600 ring-emerald-100"}`}>
          {icon}
        </span>
        <CardTitle className="text-lg font-extrabold">{title}</CardTitle>
        <Badge shape="compact" size="lg" variant={isSource ? "default" : "success"}>{badge}</Badge>
      </CardHeader>
      <CardContent className="px-5 pb-5 !pt-3">
        <KeyValueList className={endpointKeyValueListClassName} items={items} />
      </CardContent>
    </Card>
  );
}

export type OutputSchemaRow = {
  field: string;
  index: number;
  sample: string;
  type: string;
};

export type TransformRuleRow = {
  enabled: boolean;
  index: number;
  input: string;
  label: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};

export type QualityRuleRow = {
  enabled: boolean;
  failureAction: string;
  severity: string;
  targetColumn: string;
  validationType: string;
};

export const outputSchemaColumns: ColumnDef<OutputSchemaRow>[] = [
  {
    accessorKey: "index",
    header: "순서",
    meta: { align: "center", widthClassName: "w-[80px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "field",
    header: "출력 필드",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-bold">{row.original.field}</DataTableCellPrimary>,
  },
  {
    accessorKey: "type",
    header: "타입",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant="muted">{row.original.type}</Badge>,
  },
  {
    accessorKey: "sample",
    header: "샘플",
    cell: ({ row }) => (
      <span className="block max-w-[280px] truncate text-base font-medium text-slate-700" title={row.original.sample}>
        {row.original.sample}
      </span>
    ),
  },
];

export function TransformRuleSettingsAction({ rule }: { rule: TransformRuleRow }) {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex h-auto items-center justify-center whitespace-nowrap p-0 text-base font-semibold text-blue-600 underline-offset-4 transition-colors hover:text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
        설정 보기
      </DialogTrigger>
      <DialogContent
        closeLabel="닫기"
        className="max-h-[calc(100vh-2rem)] w-[min(calc(100vw-2rem),48rem)] gap-0 overflow-hidden p-0"
      >
        <header className="grid min-w-0 gap-1.5 border-b border-slate-200 px-6 py-5 pr-16">
          <span className="text-xs font-black uppercase tracking-normal text-blue-600">변환 규칙 {rule.index}</span>
          <DialogTitle className="text-xl font-extrabold leading-tight">{rule.label}</DialogTitle>
          <DialogDescription>{rule.operation}</DialogDescription>
        </header>
        <div className="grid min-h-0 gap-5 overflow-y-auto px-6 py-5">
          <KeyValueList
            className={detailKeyValueListClassName}
            items={[
              { label: "입력", value: rule.input },
              { label: "출력", value: rule.output },
              { label: "오류 처리", value: rule.onError },
              { label: "상태", value: rule.enabled ? "활성" : "비활성" },
            ]}
          />
          <section className="grid min-w-0 gap-3">
            <h3 className="text-base font-extrabold text-slate-950">설정</h3>
            <pre className="max-h-[320px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-5 font-mono text-sm leading-6 text-slate-100">
              {rule.params || "설정 없음"}
            </pre>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const transformRuleColumns: ColumnDef<TransformRuleRow>[] = [
  {
    accessorKey: "index",
    header: "순서",
    meta: { align: "center", widthClassName: "w-[64px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "label",
    header: "변환 규칙",
    cell: ({ row }) => (
      <DataTableStackedCell className="min-w-[170px] gap-1">
        <DataTableCellPrimary className="text-base font-bold">{row.original.label}</DataTableCellPrimary>
        <DataTableCellSecondary className="text-[13px] font-semibold">{row.original.operation}</DataTableCellSecondary>
      </DataTableStackedCell>
    ),
    meta: { widthClassName: "w-[190px]" } satisfies DataTableColumnMeta,
  },
  {
    id: "mapping",
    header: "입력 → 출력",
    cell: ({ row }) => {
      const mapping = `${row.original.input} → ${row.original.output}`;
      return (
        <DataTableCellPrimary className="block max-w-[260px] truncate text-base font-semibold" title={mapping}>
          {mapping}
        </DataTableCellPrimary>
      );
    },
    meta: { widthClassName: "w-[280px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "onError",
    header: "오류 처리",
    cell: ({ row }) => <DataTableCellPrimary className="whitespace-nowrap text-base font-medium text-slate-700">{row.original.onError}</DataTableCellPrimary>,
    meta: { widthClassName: "w-[140px]" } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "enabled",
    header: "상태",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.enabled ? "success" : "muted"}>{row.original.enabled ? "활성" : "비활성"}</Badge>,
    meta: { widthClassName: "w-[96px]" } satisfies DataTableColumnMeta,
  },
  {
    id: "settings",
    header: "상세",
    cell: ({ row }) => <TransformRuleSettingsAction rule={row.original} />,
    meta: { align: "center", widthClassName: "w-[112px]" } satisfies DataTableColumnMeta,
  },
];

export const qualityRuleColumns: ColumnDef<QualityRuleRow>[] = [
  {
    accessorKey: "targetColumn",
    header: "대상 컬럼",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-bold">{row.original.targetColumn}</DataTableCellPrimary>,
    meta: {
      cellClassName: "pl-10",
      headerClassName: "pl-10",
    } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "validationType",
    header: "검증 규칙",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.validationType}</DataTableCellPrimary>,
  },
  {
    accessorKey: "severity",
    header: "심각도",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.severity === "오류" ? "destructive" : "warning"}>{row.original.severity}</Badge>,
  },
  {
    accessorKey: "failureAction",
    header: "실패 시",
    cell: ({ row }) => <DataTableCellPrimary className="text-base font-medium text-slate-700">{row.original.failureAction}</DataTableCellPrimary>,
  },
  {
    accessorKey: "enabled",
    header: "상태",
    cell: ({ row }) => <Badge shape="compact" size="lg" variant={row.original.enabled ? "success" : "muted"}>{row.original.enabled ? "활성" : "비활성"}</Badge>,
  },
];

export function OperationSummaryItem({
  detail,
  label,
  tone = "default",
  value,
}: {
  detail: string;
  label: string;
  tone?: "danger" | "default" | "running" | "scheduled";
  value: string;
}) {
  const accentClassName = tone === "danger"
    ? "border-red-400"
    : tone === "running"
      ? "border-emerald-400"
      : tone === "scheduled"
        ? "border-blue-400"
        : "border-slate-300";

  return (
    <div className={`grid min-w-0 content-start gap-1 border-l-2 pl-3 ${accentClassName}`}>
      <span className="text-sm font-bold text-slate-500">{label}</span>
      <strong className="text-lg font-extrabold leading-snug text-slate-950 [overflow-wrap:anywhere]">{value}</strong>
      <span className="text-sm font-semibold leading-snug text-slate-500 [overflow-wrap:anywhere]">{detail}</span>
    </div>
  );
}

export function PipelineFlowNode({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="grid min-h-24 min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-md border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <span className="grid size-10 place-items-center rounded-md bg-blue-50 text-blue-600">
        {icon}
      </span>
      <div className="grid min-w-0 gap-1 text-left">
        <span className="text-sm font-extrabold text-slate-500">{label}</span>
        <strong className="text-lg font-extrabold leading-snug text-slate-950 [overflow-wrap:anywhere]">{value}</strong>
      </div>
    </div>
  );
}
