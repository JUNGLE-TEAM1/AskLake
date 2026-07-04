import { useEffect, useMemo, useState } from "react";
import type React from "react";
import {
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
  FileText,
  HardDrive,
  Info,
  LayoutGrid,
  Maximize2,
  Minus,
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
} from "lucide-react";
import { Field, InfoBox, PageTitle, RetryPolicy, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationPanelActions, CreationSummaryPanel, CreationValidationPanel } from "../../components/creation/CreationFlow";
import {
  QUALITY_RULE_OPTIONS,
  RECOMMENDED_TRANSFORM_STEPS,
  TRANSFORM_QUALITY_INVALID_ROWS,
  TRANSFORM_QUALITY_PREVIEW_BY_STEP_ID,
  TRANSFORM_QUALITY_SAMPLE_PROFILE,
  TRANSFORM_QUALITY_VALIDATION_RESULT,
  runTransformQualitySamplePreview,
} from "../../data/transformQualityMockData";
import { toCreatePipelineRequest } from "../../services/draftPipelineContract";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, FlowId, ScheduleFlowId, TargetLayer } from "../../types";
import type { QualityRuleDraft, TransformStepDraft } from "../../types/etl";
import type { QualityRuleOption, TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview, TransformQualityValidationResult } from "../../data/transformQualityMockData";

type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};

export function SchedulePage({
  draftScheduleLabel,
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
  onSave,
}: {
  draftScheduleLabel: string;
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialRepeat = parseRepeatScheduleLabel(draftScheduleLabel);
  const [repeatDay, setRepeatDay] = useState(initialRepeat.day);
  const [repeatTime, setRepeatTime] = useState(initialRepeat.time);
  const [onceDateTime, setOnceDateTime] = useState(parseOnceScheduleLabel(draftScheduleLabel));
  const title = "스케줄링 설정";
  const selected = mode === "repeat" ? "반복 실행" : mode === "manual" ? "수동 실행" : "1회 실행";
  const scheduleLabel = formatScheduleLabel(mode, repeatDay, repeatTime, onceDateTime);
  const applyScheduleDraft = () => {
    const normalizedRepeat = normalizeRepeatScheduleDraft(repeatDraft);
    const normalizedOnceDateTime = normalizeDateTimeLocal(onceDateTime);
    setRepeatDay(normalizedRepeat.day);
    setRepeatTime(normalizedRepeat.time);
    setRepeatMinute(normalizedRepeat.minute);
    setCustomCron(normalizedRepeat.cron);
    setOnceDateTime(normalizedOnceDateTime);
    onDraftChange({ scheduleLabel: formatScheduleLabel(mode, normalizedRepeat, normalizedOnceDateTime) });
  };
  const selectMode = (nextMode: ScheduleFlowId) => {
    onDraftChange({ scheduleLabel: formatScheduleLabel(nextMode, repeatDraft, onceDateTime) });
    onModeChange(nextMode);
  };
  const selectMode = (nextMode: ScheduleFlowId) => {
    onDraftChange({ scheduleLabel: formatScheduleLabel(nextMode, repeatDay, repeatTime, onceDateTime) });
    onModeChange(nextMode);
  };
  const goNext = () => {
    applyScheduleDraft();
    onNext();
  };
  const saveSchedule = () => {
    applyScheduleDraft();
    onSave();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow={mode} title="설정 요약" selected={scheduleLabel || selected} onPrev={onPrev} onNext={goNext} onSave={saveSchedule} />}
    >
        <PageTitle title={title} description="파이프라인의 실행 주기 및 재시도 정책을 설정합니다." />
        <section className="panel">
          <div className="section-heading">
            <PlayCircle size={20} />
            <h2>실행 방식 설정</h2>
          </div>
          <div className="option-grid">
            <RunTypeCard active={mode === "manual"} icon={<PlayCircle size={24} />} title="수동 실행" desc="사용자가 직접 트리거할 때만 실행됩니다." onClick={() => selectMode("manual")} />
            <RunTypeCard active={mode === "once"} icon={<Clock3 size={24} />} title="1회 실행" desc="지정된 시간에 단 한 번만 실행됩니다." onClick={() => selectMode("once")} />
            <RunTypeCard active={mode === "repeat"} icon={<Repeat2 size={24} />} title="반복 실행" desc="주기적으로 반복하여 데이터를 처리합니다." onClick={() => selectMode("repeat")} />
          </div>
        </section>
        {mode === "repeat" && <RepeatSettings customCron={customCron} frequency={repeatFrequency} minute={repeatMinute} retryPolicy={draftRetryPolicy} selectedDay={repeatDay} time={repeatTime} onCronChange={(cron) => {
          const sanitizedCron = sanitizeCronInput(cron);
          setCustomCron(sanitizedCron);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: sanitizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onCronCommit={() => {
          const normalizedCron = normalizeCronExpression(customCron);
          setCustomCron(normalizedCron);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: normalizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onDayChange={(day) => {
          setRepeatDay(day);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onFrequencyChange={(frequency) => {
          setRepeatFrequency(frequency);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onMinuteChange={(minute) => {
          setRepeatMinute(minute);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute, time: repeatTime }, onceDateTime) });
        }} onTimeCommit={() => {
          const normalizedTime = normalizeTimeValue(repeatTime);
          setRepeatTime(normalizedTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: normalizedTime }, onceDateTime) });
        }} onTimeChange={(time) => {
          setRepeatTime(time);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time }, onceDateTime) });
        }} onRetryPolicyChange={updateRetryPolicy} />}
        {mode === "manual" && <ManualSettings retryPolicy={draftRetryPolicy} onRetryPolicyChange={updateRetryPolicy} />}
        {mode === "once" && <OnceSettings dateTime={onceDateTime} retryPolicy={draftRetryPolicy} onDateTimeChange={(dateTime) => {
          setOnceDateTime(dateTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("once", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, dateTime) });
        }} onDateTimeCommit={() => {
          const normalizedDateTime = normalizeDateTimeLocal(onceDateTime);
          setOnceDateTime(normalizedDateTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("once", repeatDraft, normalizedDateTime) });
        }} onRetryPolicyChange={updateRetryPolicy} />}
    </CreationFlowLayout>
  );
}

function RunTypeCard({ active, icon, title, desc, onClick }: { active: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={active ? "run-card active" : "run-card"} type="button" onClick={onClick}>
      {active && <span className="run-selected-dot" />}
      <span className="run-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{desc}</span>
    </button>
  );
}

const DEFAULT_REPEAT_DAY = "목";
const DEFAULT_REPEAT_TIME = "10:30";
const DEFAULT_ONCE_DATE_TIME = "2026.07.05 10:00";

function formatScheduleLabel(mode: ScheduleFlowId, repeatDay: string, repeatTime: string, onceDateTime: string) {
  if (mode === "manual") return "수동 실행";
  if (mode === "once") return `${onceDateTime.trim() || DEFAULT_ONCE_DATE_TIME} 1회 실행`;
  return `매주 ${repeatDay || DEFAULT_REPEAT_DAY}요일 ${repeatTime || DEFAULT_REPEAT_TIME}`;
}

function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("수동")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}

function parseOnceScheduleLabel(label: string) {
  if (!label.includes("1회")) return DEFAULT_ONCE_DATE_TIME;
  return label.replace(/\s*1회 실행\s*$/, "").trim() || DEFAULT_ONCE_DATE_TIME;
}

function parseRepeatScheduleLabel(label: string) {
  const match = label.match(/매주\s+(.+?)요일\s+(.+)$/);
  return {
    day: match?.[1] ?? DEFAULT_REPEAT_DAY,
    time: match?.[2] ?? DEFAULT_REPEAT_TIME,
  };
}

const DEFAULT_PERMISSION_TEMPLATE = "Data Engineer Group";
const DEFAULT_VISIBILITY = "조직 내부";
const DEFAULT_APPROVAL_STATUS = "승인 검토";
const DEFAULT_OWNER = "data-team-01";
const DEFAULT_TARGET_DATASET = "customer_review_gold";
const DEFAULT_TARGET_LAYER: TargetLayer = "GOLD";
const DEFAULT_TARGET_FORMAT = "Parquet";

const PERMISSION_TEMPLATES = ["Data Engineer Group", "Data Analyst Group", "ML Team"] as const;
const VISIBILITY_OPTIONS = ["조직 내부", "프로젝트 멤버", "외부 공유"] as const;
const APPROVAL_STATUS_OPTIONS = ["승인 검토", "승인 완료", "오너 승인 필요"] as const;
const TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER", "GOLD"];
const TARGET_FORMAT_OPTIONS = ["Parquet", "Delta", "Iceberg", "CSV"] as const;

const PERMISSION_ACCESS_ITEMS = ["조회", "쿼리 실행", "메타데이터", "관리"] as const;

const PERMISSION_ROLES = [
  { name: "Data Engineer Group", access: PERMISSION_ACCESS_ITEMS, checked: true, note: "파이프라인 운영 및 장애 대응 권한" },
  { name: "Data Analyst Group", access: PERMISSION_ACCESS_ITEMS, checked: true, note: "분석 업무용 표준 접근 권한" },
  { name: "ML Team", access: PERMISSION_ACCESS_ITEMS, checked: false, note: "RAG 인덱스 검증 후 확장 예정" },
];

type PermissionDraftSlice = {
  approvalStatus?: string;
  owner?: string;
  permissionSummary?: string;
  permissionTemplate?: string;
  summary?: string;
  template?: string;
  visibility?: string;
};

type TargetDraftSlice = {
  datasetName?: string;
  format?: string;
  jobName?: string;
  layer?: string;
  owner?: string;
  rag?: boolean;
  targetDataset?: string;
  targetFormat?: string;
  targetLayer?: string;
};

type DraftPipelineWithSlices = DraftPipeline & {
  jobName?: string;
  owner?: string;
  permission?: PermissionDraftSlice;
  permissionSummary?: string;
  rag?: boolean;
  target?: TargetDraftSlice;
  targetDataset?: string;
  targetFormat?: string;
  targetLayer?: string;
};

function getDisplayText(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function getKnownOption<T extends string>(value: string | undefined, options: readonly T[], fallback: T): T {
  const trimmed = value?.trim();
  return options.find((option) => option === trimmed) ?? fallback;
}

function normalizeTargetLayer(value: string | undefined): TargetLayer {
  return getKnownOption(value?.toUpperCase(), TARGET_LAYER_OPTIONS, DEFAULT_TARGET_LAYER);
}

function buildJobName(targetDataset: string) {
  return `${getDisplayText(targetDataset, DEFAULT_TARGET_DATASET)}_pipeline`;
}

function buildPermissionSummary(permissionTemplate: string, visibility: string, approvalStatus: string) {
  return `${permissionTemplate} · ${visibility} · ${approvalStatus}`;
}

function parsePermissionSummary(summary: string | undefined) {
  const [template, visibility, approvalStatus] = (summary ?? "").split(/[·/]/).map((part) => part.trim()).filter(Boolean);

  return {
    approvalStatus: getKnownOption(approvalStatus, APPROVAL_STATUS_OPTIONS, DEFAULT_APPROVAL_STATUS),
    permissionTemplate: getKnownOption(template, PERMISSION_TEMPLATES, DEFAULT_PERMISSION_TEMPLATE),
    visibility: getKnownOption(visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY),
  };
}

function getPermissionDraftValues(draft: DraftPipeline) {
  const compatDraft = draft as DraftPipelineWithSlices;
  const permission = compatDraft.permission;
  const parsed = parsePermissionSummary(permission?.permissionSummary ?? permission?.summary ?? compatDraft.permissionSummary);
  const permissionTemplate = getKnownOption(permission?.permissionTemplate ?? permission?.template ?? parsed.permissionTemplate, PERMISSION_TEMPLATES, DEFAULT_PERMISSION_TEMPLATE);
  const visibility = getKnownOption(permission?.visibility ?? parsed.visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);
  const approvalStatus = getKnownOption(permission?.approvalStatus ?? parsed.approvalStatus, APPROVAL_STATUS_OPTIONS, DEFAULT_APPROVAL_STATUS);

  return {
    approvalStatus,
    owner: getDisplayText(permission?.owner ?? compatDraft.owner, DEFAULT_OWNER),
    permissionSummary: buildPermissionSummary(permissionTemplate, visibility, approvalStatus),
    permissionTemplate,
    visibility,
  };
}

function getTargetDraftValues(draft: DraftPipeline) {
  const compatDraft = draft as DraftPipelineWithSlices;
  const target = compatDraft.target;
  const targetDataset = getDisplayText(target?.targetDataset ?? target?.datasetName ?? compatDraft.targetDataset, DEFAULT_TARGET_DATASET);
  const targetFormat = getKnownOption(target?.targetFormat ?? target?.format ?? compatDraft.targetFormat, TARGET_FORMAT_OPTIONS, DEFAULT_TARGET_FORMAT);

  return {
    jobName: getDisplayText(target?.jobName ?? compatDraft.jobName, buildJobName(targetDataset)),
    owner: getDisplayText(target?.owner ?? compatDraft.owner ?? draft.permission.owner, DEFAULT_OWNER),
    rag: typeof target?.rag === "boolean" ? target.rag : compatDraft.rag ?? draft.target.rag,
    targetDataset,
    targetFormat,
    targetLayer: normalizeTargetLayer(target?.targetLayer ?? target?.layer ?? compatDraft.targetLayer ?? draft.target.layer),
  };
}

export function SourceConnectionPage({
  onAction,
  onDraftChange,
  onNotify,
  onPrev,
  onNext,
  onSave,
}: {
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [sourceType, setSourceType] = useState("File / S3");
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const connectorMeta: Record<string, { desc: string; status: string }> = {
    Database: { desc: "Postgres, MySQL, Oracle", status: "ready" },
    "File / S3": { desc: "S3, GCS, Azure Blob", status: "valid" },
    "Data Lake": { desc: "Delta Lake, Iceberg, Hudi", status: "metadata" },
    "REST API": { desc: "REST, GraphQL, Webhooks", status: "parsed" },
    "Stream / Kafka": { desc: "Real-time message brokers", status: "active" },
  };
  const sourceConfigs: Record<string, {
    title: string;
    description: string;
    fields: Array<[string, string]>;
    testItems: Array<[string, string]>;
    logs: string[];
    assetsTitle: string;
    assets: Array<[string, string, string]>;
    previewTitle: string;
    previewNote: string;
    previewColumns: string[];
    previewRows: string[][];
    actions?: string[];
    info?: string;
  }> = {
    Database: {
      title: "PostgreSQL Connection",
      description: "JDBC 연결로 테이블과 뷰를 탐색하고 샘플 행을 가져옵니다.",
      fields: [
        ["Endpoint / Host", "production-pg-cluster.internal"],
        ["Port", "5432"],
        ["Database Name", "sales_warehouse"],
        ["Schema", "public"],
        ["Username", "asklake_service_account"],
        ["Password / Auth Token", "secret_token_123"],
      ],
      testItems: [["Endpoint", "Reachable"], ["Auth", "Ready"], ["Tables", "1 detected"]],
      logs: ["[INFO] DNS resolved production-pg-cluster.internal", "[INFO] Read-only credential accepted", "[SCAN] public.users detected"],
      assetsTitle: "Detected Tables",
      assets: [["public.users", "Table", "ready"], ["public.orders", "Table", "locked"], ["public.events", "View", "ready"]],
      previewTitle: "Raw Source Preview",
      previewNote: "No preview data available · Run a connection test to fetch sample rows from the source.",
      previewColumns: ["Table", "Rows", "Status"],
      previewRows: [["public.users", "0", "Test required"], ["public.orders", "0", "Locked"]],
      info: "We recommend using a read-only user account for ETL processes to ensure data security.",
    },
    "File / S3": {
      title: "File / S3 Source Configuration",
      description: "Configure your cloud storage bucket connection details.",
      fields: [
        ["Storage Provider", "Amazon S3"],
        ["Bucket / Stage Name", "asklake-raw-ingest-us-east"],
        ["Path / Prefix", "data/inventory/daily/"],
        ["Auth Method", "IAM Role (Recommended)"],
        ["Role ARN", "arn:aws:iam::982347102:role/DataIngestRole"],
        ["File Type", "CSV (Comma Separated)"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      testItems: [["Storage", "Connected"], ["Auth", "AccessGranted"], ["Path", "Scanned"]],
      logs: ["[INFO] Connection established to us-east-1", "[INFO] Validating IAM policy: AccessGranted", "[SCAN] Scanning prefix: data/inventory/..."],
      assetsTitle: "Detected Files",
      assets: [["orders_2024.csv", "2.4 MB", "10m ago"], ["users.parquet", "15.8 MB", "1h ago"], ["events.json", "442 KB", "2d ago"]],
      previewTitle: "Raw File Preview",
      previewNote: 'Showing first 5 rows of "orders_2024.csv"',
      previewColumns: ["#", "Raw Content (UTF-8)", "Byte Size", "Status"],
      previewRows: [
        ["1", "order_id,customer_id,order_date,amount,status,region", "64 B", "Header"],
        ["2", "ORD-99201,CUST-002,2024-03-15,124.50,PENDING,US-EAST-1", "62 B", "Valid"],
        ["3", "ORD-99202,CUST-045,2024-03-15,88.00,COMPLETED,US-WEST-2", "60 B", "Valid"],
        ["4", "ORD-99203,CUST-012,2024-03-16,420.75,CANCELLED,US-EAST-1", "63 B", "Valid"],
        ["5", "ORD-99204,CUST-111,2024-03-16,210.00,PENDING,EU-CENTRAL-1", "62 B", "Valid"],
      ],
      actions: ["Refresh Preview"],
    },
    "Data Lake": {
      title: "Data Lake Source",
      description: "Configure the connection details for your cloud-based data lakehouse.",
      fields: [
        ["Lake Type", "Delta Lake (Databricks)"],
        ["CATALOG / NAMESPACE", "prod_datalake_v2"],
        ["DATABASE / SCHEMA", "analytics_raw"],
        ["Path", "s3://asklake-prod-bucket/logs/user_events/"],
        ["Read Mode", "Latest Version (Snapshot Isolation)"],
        ["DATASET OR TABLE SELECTOR", "user_interactions_log"],
      ],
      testItems: [["Lake Access", "Passed"], ["Metadata", "Fetched"], ["Permission", "Granted"]],
      logs: ["[14:02:11] Init: AWS SDK V2 Client", "[14:02:12] Auth: IAM Role detected", "[14:02:14] Success: Bucket accessible", "[14:02:15] Success: Delta manifest found", "[14:02:15] Info: Scanning partitions..."],
      assetsTitle: "Detected Lake Objects",
      assets: [["user_interactions_log", "Table", "1.2 TB"], ["session_archive_2023", "Folder", "4.8 TB"], ["identity_map_v2", "Iceberg Table", "240 GB"], ["snapshot_v1_backup", "Snapshot", "12 GB"]],
      previewTitle: "Lake Table Preview",
      previewNote: "Showing first 5 of 12,402,192 rows · Version 42 (Iceberg)",
      previewColumns: ["Event Timestamp", "User ID", "Transaction ID", "Region", "Action Type", "Latency"],
      previewRows: [["2024-03-20 10:15:02", "USR_882", "TRX-90122", "APAC", "PAGE_VIEW", "42ms"], ["2024-03-20 10:15:15", "USR_121", "TRX-90123", "EMEA", "ADD_TO_CART", "38ms"], ["2024-03-20 10:16:01", "USR_882", "TRX-90124", "APAC", "CHECKOUT", "55ms"]],
      actions: ["Fetch Metadata", "Download CSV", "Full Screen"],
    },
    "REST API": {
      title: "REST API Source",
      description: "Configure your REST endpoint to ingest remote data.",
      fields: [
        ["Method", "GET"],
        ["Endpoint URL", "https://api.asklake-demo.io/v1/analytics/orders"],
        ["Authentication Type", "Bearer Token"],
        ["Token / Secret", "••••••••••••••••••••••"],
        ["Accept", "application/json"],
        ["X-Request-ID", "etl-9928-ax"],
        ["limit", "50"],
        ["status", "active"],
        ["Pagination Strategy", "Page Number"],
        ["Root Path", "$.data.items"],
      ],
      testItems: [["Endpoint", "Reachable"], ["Auth", "Valid"], ["Response", "Parsed (200 OK)"]],
      logs: ["[09:21:02] Connected to asklake-demo.io", "[09:21:03] Sending Auth headers...", "[09:21:03] Response 200 Received (82kb)", "[09:21:04] Applying Root Path $.data.items"],
      assetsTitle: "Detected Fields",
      assets: [["user_id", "Integer", "5 Found"], ["email", "String", "parsed"], ["created_at", "DateTime", "parsed"], ["amount", "Decimal", "parsed"], ["status", "String", "parsed"]],
      previewTitle: "API Response Preview",
      previewNote: "Parsed Rows · Total Rows: 50 · Fetch Time: 214ms",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [["10283", "dev.ops@example.com", "2024-03-12", "COMPLETED", "$499.99"], ["10284", "data.wiz@asklake.ai", "2024-03-12", "PENDING", "$120.50"], ["10285", "jane.smith@corp.com", "2024-03-12", "COMPLETED", "$88.00"]],
      actions: ["Refresh Preview"],
    },
    "Stream / Kafka": {
      title: "Stream Source Configuration",
      description: "Configure your real-time data stream endpoint.",
      fields: [
        ["Stream Type", "Apache Kafka"],
        ["Broker / Endpoint", "pkc-4vjqw.us-east-1.confluent.cloud:9092"],
        ["TOPIC / QUEUE NAME", "asklake.ingest.production.telemetry"],
        ["CONSUMER GROUP ID", "asklake-etl-consumer-01"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "SASL / SCRAM"],
      ],
      testItems: [["Broker Reachable", "Pending"], ["Topic Access", "Pending"], ["Message Parse", "Pending"]],
      logs: ["[INFO] Initiating handshake with broker...", "[INFO] SASL_SSL authentication successful.", "[INFO] Metadata fetched for 12 partitions.", "[INFO] Established consumer session ID: k-8821x-af", "[WARN] Partition 4 reporting slight latency."],
      assetsTitle: "Detected Metadata",
      assets: [["Partitions", "12", "ready"], ["Replication Factor", "3", "ready"], ["Latest Offset", "1,442,901", "ready"], ["Lag Status", "0ms", "healthy"], ["Compression", "Snappy", "ready"]],
      previewTitle: "Sample Messages Preview",
      previewNote: "Real-time stream head · Polling at 100ms · Auto-parsing active",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [["{\"event\":\"purchase\",\"user_id\":8821,\"amount\":42.50}", "2", "450122", "2024-05-20 14:02:11.452"], ["{\"event\":\"click\",\"user_id\":4120,\"page\":\"/checkout\"}", "0", "991201", "2024-05-20 14:02:11.488"], ["{\"event\":\"view\",\"user_id\":9931,\"product_id\":\"P-442\"}", "1", "221094", "2024-05-20 14:02:11.501"]],
      actions: ["Show Advanced Configuration"],
    },
  };
  const current = sourceConfigs[sourceType];
  const editableFields = sourceFields[sourceType] ?? current.fields;
  const sourceLabel = editableFields.find(([label]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? sourceType;

  const applySourceDraft = (nextType = sourceType, nextFields = editableFields) => {
    const label = nextFields.find(([fieldLabel]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? nextType;
    onDraftChange({
      sourceConfig: nextFields,
      sourceLabel: label,
      sourceType: nextType,
    });
  };

  const selectSource = (value: string) => {
    setSourceType(value);
    applySourceDraft(value, sourceFields[value] ?? sourceConfigs[value].fields);
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    setSourceFields((fields) => ({ ...fields, [sourceType]: nextFields }));
    applySourceDraft(sourceType, nextFields);
  };

  const testConnection = () => {
    onAction("etl.source.connection_tested", "/api/etl/sources/test", sourceType);
    onNotify(`${sourceType} 연결 테스트가 통과되었습니다.`);
  };

  const fetchMetadata = () => {
    onAction("etl.source.metadata_fetched", "/api/etl/sources/metadata", sourceType);
  };

  const refreshPreview = () => {
    onAction("etl.source.preview_refreshed", "/api/etl/sources/preview", sourceType);
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="source" title="소스 요약" selected={`${sourceType} · ${sourceLabel}`} onPrev={onPrev} onNext={() => {
        applySourceDraft();
        onNext();
      }} onSave={() => {
        applySourceDraft();
        onSave();
      }} />}
    >
        <PageTitle title="Source Connection" description="Define your data source and test connectivity to proceed." />
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>Source Type</h2>
            <span className="panel-note">Pipeline Draft saved 2 mins ago</span>
          </div>
          <div className="hegun-connector-grid">
            {Object.entries(connectorMeta).map(([connector, meta]) => (
              <button className={sourceType === connector ? "hegun-connector active" : "hegun-connector"} key={connector} type="button" onClick={() => selectSource(connector)}>
                <strong>{connector}</strong>
                <span>{meta.desc}</span>
                <em>{meta.status}</em>
              </button>
            ))}
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Settings size={18} />
            <h2>{current.title}</h2>
            <span className="panel-note">{current.description}</span>
          </div>
          <div className="hegun-field-grid">
            {editableFields.map(([label, value]) => (
              <label className={value.length > 38 ? "field wide" : "field"} key={`${sourceType}-${label}`}>
                <span>{label}</span>
                <input className="input control-input" value={value} onChange={(event) => updateSourceField(label, event.target.value)} />
              </label>
            ))}
          </div>
          {current.info && <InfoBox title="Secure Connection" body={current.info} />}
          <div className="form-actions inline">
            {current.actions?.includes("Show Advanced Configuration") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.advanced_opened", "/api/etl/sources/advanced", sourceType)}>Show Advanced Configuration</button>}
            {current.actions?.includes("Fetch Metadata") && <button className="secondary-button" type="button" onClick={fetchMetadata}>Fetch Metadata</button>}
            <button className="secondary-button" type="button" onClick={testConnection}>Test Connection</button>
          </div>
        </section>
        <div className="hegun-source-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Connectivity Test</h2>
              <span className="panel-note">{current.testItems.map(([label]) => label).join(" · ")}</span>
            </div>
            <div className="hegun-test-summary">
              <div>
                <strong>Connection verified</strong>
                <span>{current.testItems.length} checks completed for {sourceType}</span>
              </div>
              <em>Ready for preview</em>
            </div>
            <div className="hegun-test-strip">
              {current.testItems.map(([label, value], index) => (
                <span key={`${sourceType}-${label}-${index}`}>
                  <i><Check size={13} /></i>
                  <strong>{label}</strong>
                  <em>{value}</em>
                </span>
              ))}
            </div>
            <div className="hegun-log-panel" aria-label="Connection test log">
              <div className="hegun-log-header">
                <strong>Execution log</strong>
                <span>live</span>
              </div>
              <div className="hegun-log-lines">
                {current.logs.map((log, index) => <span key={`${sourceType}-log-${index}`}>{log}</span>)}
              </div>
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <LayoutGrid size={18} />
              <h2>{current.assetsTitle}</h2>
              <span className="panel-note">{current.assets.length} Total</span>
            </div>
            <div className="hegun-asset-list">
              {current.assets.map(([name, meta, status], index) => (
                <article key={`${sourceType}-${name}-${index}`}>
                  <strong>{name}</strong>
                  <span>{meta}</span>
                  <em>{status}</em>
                </article>
              ))}
            </div>
          </section>
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <FileText size={18} />
            <h2>{current.previewTitle}</h2>
            <span className="panel-note">{current.previewNote}</span>
          </div>
          <div className="hegun-preview-actions">
            {current.actions?.includes("Refresh Preview") && <button className="secondary-button" type="button" onClick={refreshPreview}>Refresh Preview</button>}
            {current.actions?.includes("Download CSV") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_downloaded", "/api/etl/sources/preview/download", sourceType)}>Download CSV</button>}
            {current.actions?.includes("Full Screen") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_fullscreen_opened", "/api/etl/sources/preview/fullscreen", sourceType)}>Full Screen</button>}
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead><tr>{current.previewColumns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>{current.previewRows.map((row, rowIndex) => <tr key={`${sourceType}-preview-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </section>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={testConnection}>연결 테스트</button>
        </div>
    </CreationFlowLayout>
  );
}

export function SchemaInferencePage({
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const schemaRows = [
    ["#1", "user_id", "user_id", "Integer", "NO", "Primary", "100%", "102, 103, 104"],
    ["#2", "first_name", "first_name", "String", "NO", "-", "98%", "John, Jane, Mike"],
    ["#3", "last_name", "last_name", "String", "YES", "-", "95%", "Doe, Smith, Brown"],
    ["#4", "signup_ts", "created_at", "Timestamp", "NO", "-", "72%", "2023-01-01 10:00..."],
    ["#5", "sub_plan_code", "plan_id", "Integer", "YES", "Foreign", "85%", "1, 2, NULL, 3"],
    ["#6", "meta_json", "metadata", "JSON", "YES", "Obj", "60%", "{\"ref\":\"ads_01\"}"],
    ["#7", "geo_lat", "latitude", "Float", "YES", "-", "99%", "37.7749, 34.0522"],
  ];
  const metadata = [
    ["Data Source", "orders_main_prod.csv"],
    ["Rows Sampled", "10,000"],
    ["Status", "Inference Needs Review"],
    ["Parser", "CSV · UTF-8 · Header"],
  ];

  const runInference = () => {
    onAction("etl.schema.inferred", "/api/etl/schema-inference", "customer_review_raw");
    onDraftChange({ schemaSummary: "24 fields inferred · 3 need review" });
    onNotify("샘플 데이터 기준 스키마 추론이 완료되었습니다.");
  };

  const schemaAction = (action: string, path: string, schemaSummary?: string) => {
    onAction(action, path, "orders_main_prod.csv");
    if (schemaSummary) {
      onDraftChange({ schemaSummary });
    }
  };

  const approveSchema = () => {
    schemaAction("etl.schema.confirmed", "/api/etl/schema-inference/confirm", "24 fields approved · 0 blocking issues");
  };

  const saveSchemaDraft = () => {
    onDraftChange({ schemaSummary: "24 fields approved · 0 blocking issues" });
    onSave();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="schema" title="스키마 요약" onPrev={onPrev} onNext={() => {
        approveSchema();
        onNext();
      }} onSave={saveSchemaDraft} />}
    >
        <PageTitle title="Schema Inference" description="샘플 데이터를 분석해 컬럼, 타입, Null 여부와 추천 메타데이터를 확인합니다." />
        <div className="review-card-grid compact-cards">
          {metadata.map(([label, value], index) => (
            <article className="review-mini-card" key={`${label}-${index}`}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <LayoutGrid size={18} />
            <h2>Showing 24 Fields</h2>
            <span className="panel-note">Filter, bulk edit, and approve inferred fields</span>
          </div>
          <div className="hegun-toolbar">
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.rescanned", "/api/etl/schema-inference/rescan", "24 fields re-scanned · 3 need review")}>Re-scan Source</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", "24 fields approved · 0 blocking issues")}>Approve All</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.bulk_edit_opened", "/api/etl/schema-inference/bulk-edit")}>Bulk Edit Type</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.mappings_reset", "/api/etl/schema-inference/reset-mappings", "24 fields inferred · mappings reset")}>Reset Mappings</button>
            <span>Filter fields...</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Source Field</th>
                  <th>Target Field</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Key</th>
                  <th>Confidence</th>
                  <th>Sample Data</th>
                </tr>
              </thead>
              <tbody>
                {schemaRows.map((row, rowIndex) => (
                  <tr className={Number.parseInt(row[6]) < 80 ? "hegun-low-confidence" : ""} key={`${row[0]}-${rowIndex}`}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div className="hegun-schema-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Field Review</h2>
              <span className="panel-note">signup_ts · 72% Confidence · Field ID: 4</span>
            </div>
            <div className="form-grid">
              <Field label="Target Field Name" value="created_at" />
              <Field label="Override Type" value="Timestamp" />
              <Field label="Null Ratio" value="12.4%" />
              <Field label="Value Distribution" value="Premium / Basic / Enterprise / Trial" wide />
            </div>
            <div className="hegun-distribution">
              {[45, 30, 15, 10].map((value, index) => <span key={value + index} style={{ width: `${value}%` }} />)}
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Settings size={18} />
              <h2>Parsing & Flattening</h2>
              <span className="panel-note">MongoDB / JSON compatible</span>
            </div>
            <div className="form-grid compact">
              <Field label="Root Path" value="$" />
              <Field label="Flatten Nested Objects" value="Enabled" />
              <Field label="Flatten Depth" value="1 / 2 / 3" />
              <Field label="Array Handling" value="Keep as JSON" />
              <Field label="Mixed Type Policy" value="Most Common Type" wide />
            </div>
          </section>
        </div>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={runInference}>다시 추론</button>
          <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.exported", "/api/etl/schema-inference/export")}>Export Schema (JSON)</button>
        </div>
    </CreationFlowLayout>
  );
}

type RuleCategory = "transform" | "quality";
type RuleActionHandler = (action: string, path: string, targetId?: string) => void;
type RuleStepDraft = {
  input: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};
type RecipeStep = RuleStepDraft & {
  id: string;
};
type QualityRule = QualityRuleOption;

type TransformQualityPreviewCache = {
  datasetId: string;
  invalidRows: TransformQualityInvalidRow[];
  qualityRules: QualityRule[];
  recipeSteps: RecipeStep[];
  selectedPreviewStepId: string;
  selectedQualityRuleId: string;
  savedAt: string;
  validation: TransformQualityValidationResult;
  version: 1;
};

const RULE_METRIC_DEFS: Array<{ icon: React.ReactNode; label: string; value: (stats: RuleStats) => string }> = [
  { icon: <SlidersHorizontal size={18} />, label: "Total Rules", value: (stats) => String(stats.totalRules) },
  { icon: <Database size={18} />, label: "Affected Columns", value: (stats) => String(stats.affectedColumns) },
  { icon: <Clock3 size={18} />, label: "Transformation Coverage", value: (stats) => `${stats.coverage}%` },
  { icon: <Info size={18} />, label: "Invalid Data Rows", value: (stats) => String(stats.invalidRows) },
];

const RULE_CATEGORIES: Array<{
  id: RuleCategory;
  label: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    id: "transform",
    label: "변환",
    title: "Transform",
    description: "Modify, clean, and format data fields before storing them in the Lake.",
    icon: <SlidersHorizontal size={20} />,
  },
  {
    id: "quality",
    label: "품질 체크",
    title: "Quality Check",
    description: "Enforce data integrity with validation rules and row-level constraints.",
    icon: <ShieldCheck size={20} />,
  },
];

const INITIAL_RECIPE_STEPS: RecipeStep[] = RECOMMENDED_TRANSFORM_STEPS.map(({ id, input, onError, operation, output, params }) => ({
  id,
  input,
  onError,
  operation,
  output,
  params,
}));
const INITIAL_QUALITY_RULES: QualityRule[] = QUALITY_RULE_OPTIONS;
const TRANSFORM_QUALITY_SAMPLE_COLUMNS = [...TRANSFORM_QUALITY_SAMPLE_PROFILE.columns];
const TRANSFORM_QUALITY_SAMPLE_COLUMN_SET = new Set<string>(TRANSFORM_QUALITY_SAMPLE_COLUMNS);
const INITIAL_AFFECTED_COLUMNS = 12;
const INITIAL_TRANSFORMATION_COVERAGE = 84;
const TRANSFORM_OPERATION_OPTIONS = ["Extract JSONPath", "Lowercase + Trim", "Cast Decimal", "Parse Timestamp", "Mask"] as const;
const TRANSFORM_FAILURE_POLICY_OPTIONS = ["Warn", "Set Null", "Drop Row", "Fail Run"] as const;
const QUALITY_VALIDATION_OPTIONS: Array<QualityRule["validationType"]> = ["Not Null", "Regex Match", "Range Check", "Accepted Values"];
const QUALITY_SEVERITY_OPTIONS: Array<QualityRule["severity"]> = ["Warning", "Error"];
const QUALITY_FAILURE_ACTION_OPTIONS: Array<QualityRule["failureAction"]> = ["Warn", "Quarantine", "Fail Run", "Drop Row", "Set Null"];
const QUALITY_DRAFT_PREVIEW_ID_PREFIX = "qr-draft-preview-";
type TransformOperation = (typeof TRANSFORM_OPERATION_OPTIONS)[number];
type TransformFailurePolicy = (typeof TRANSFORM_FAILURE_POLICY_OPTIONS)[number];

const DEFAULT_RULE_STEP_BY_CATEGORY: Record<RuleCategory, RuleStepDraft> = {
  transform: { input: "raw_value", operation: "Extract JSONPath", output: "normalized_value", params: "$.value", onError: "Set Null" },
  quality: { input: "user_email", operation: "Regex Match", output: "quality_status", params: "email pattern", onError: "Warn" },
};

const TRANSFORM_QUALITY_PREVIEW_CACHE_KEY = "asklake.transformQualityPreviewCache";

function createDefaultTransformQualityPreviewCache(): TransformQualityPreviewCache {
  return {
    datasetId: TRANSFORM_QUALITY_SAMPLE_PROFILE.datasetId,
    invalidRows: TRANSFORM_QUALITY_INVALID_ROWS,
    qualityRules: INITIAL_QUALITY_RULES,
    recipeSteps: INITIAL_RECIPE_STEPS,
    selectedPreviewStepId: INITIAL_RECIPE_STEPS[0]?.id ?? "",
    selectedQualityRuleId: INITIAL_QUALITY_RULES[0]?.id ?? "",
    savedAt: new Date().toISOString(),
    validation: TRANSFORM_QUALITY_VALIDATION_RESULT,
    version: 1,
  };
}

function readTransformQualityPreviewCache(): TransformQualityPreviewCache {
  if (typeof window === "undefined") return createDefaultTransformQualityPreviewCache();
  try {
    const stored = window.localStorage.getItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY);
    if (!stored) return createDefaultTransformQualityPreviewCache();
    const parsed = JSON.parse(stored) as Partial<TransformQualityPreviewCache>;
    if (parsed.version !== 1 || !Array.isArray(parsed.recipeSteps) || !Array.isArray(parsed.qualityRules)) {
      return createDefaultTransformQualityPreviewCache();
    }
    const defaultCache = createDefaultTransformQualityPreviewCache();
    const qualityRules = parsed.qualityRules.filter((rule) => !rule.id.startsWith(QUALITY_DRAFT_PREVIEW_ID_PREFIX));
    const selectedQualityRuleId = qualityRules.some((rule) => rule.id === parsed.selectedQualityRuleId)
      ? parsed.selectedQualityRuleId ?? ""
      : qualityRules[0]?.id ?? defaultCache.selectedQualityRuleId;
    return {
      ...defaultCache,
      ...parsed,
      invalidRows: Array.isArray(parsed.invalidRows) ? parsed.invalidRows : TRANSFORM_QUALITY_INVALID_ROWS,
      qualityRules: qualityRules.length > 0 ? qualityRules : defaultCache.qualityRules,
      recipeSteps: parsed.recipeSteps,
      selectedQualityRuleId,
      validation: parsed.validation ?? TRANSFORM_QUALITY_VALIDATION_RESULT,
    };
  } catch {
    return createDefaultTransformQualityPreviewCache();
  }
}

function writeTransformQualityPreviewCache(cache: TransformQualityPreviewCache) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY, JSON.stringify(cache));
}

type RuleStats = {
  affectedColumns: number;
  coverage: number;
  invalidRows: number;
  qualityRules: number;
  transformSteps: number;
  totalRules: number;
};

function getRuleStats(steps: RecipeStep[], qualityRules: QualityRule[], invalidRows: number): RuleStats {
  const ruleCountDelta = steps.length - INITIAL_RECIPE_STEPS.length;
  return {
    affectedColumns: Math.max(0, INITIAL_AFFECTED_COLUMNS + ruleCountDelta),
    coverage: Math.min(100, Math.max(0, INITIAL_TRANSFORMATION_COVERAGE + ruleCountDelta * 2)),
    invalidRows,
    qualityRules: qualityRules.length,
    transformSteps: steps.length,
    totalRules: steps.length + qualityRules.length,
  };
}

function formatRuleSummary(stats: RuleStats, validation: TransformQualityValidationResult) {
  return `${stats.transformSteps} transform steps · ${stats.qualityRules} quality rules · ${validation.qualityScore}% quality score · ${stats.invalidRows} invalid rows`;
}

function getTransformStepKind(operation: string): TransformStepDraft["kind"] {
  const normalizedOperation = operation.toLowerCase();
  if (normalizedOperation.includes("json")) return "jsonPath";
  if (normalizedOperation.includes("cast") || normalizedOperation.includes("decimal")) return "cast";
  if (normalizedOperation.includes("trim") || normalizedOperation.includes("lower")) return "trim";
  if (normalizedOperation.includes("mask")) return "mask";
  return "derive";
}

function toDraftTransformSteps(steps: RecipeStep[]): TransformStepDraft[] {
  return steps.map((step) => ({
    enabled: true,
    id: step.id,
    kind: getTransformStepKind(step.operation),
    label: `${step.operation}: ${step.input} -> ${step.output}`,
  }));
}

function toQualityRuleKind(validationType: QualityRule["validationType"]): QualityRuleDraft["kind"] {
  switch (validationType) {
    case "Accepted Values":
      return "acceptedValues";
    case "Not Null":
      return "notNull";
    case "Range Check":
      return "range";
    case "Regex Match":
      return "regex";
    default:
      return "regex";
  }
}

function toDraftQualityRules(rules: QualityRule[]): QualityRuleDraft[] {
  return rules.map((rule) => ({
    enabled: true,
    id: rule.id,
    kind: toQualityRuleKind(rule.validationType),
    targetColumn: rule.targetColumn,
  }));
}

function toDraftInvalidRows(rows: TransformQualityInvalidRow[]) {
  return rows.map((row) => [row.row, row.column, row.reason, row.action]);
}

function formatInvalidRowsPreviewSummary(invalidRowCount: number, exampleCount: number) {
  if (invalidRowCount === exampleCount) return `${invalidRowCount} invalid rows`;
  return `${invalidRowCount} invalid rows · showing ${exampleCount} examples`;
}

function getWorkingColumns(steps: RecipeStep[]) {
  return Array.from(new Set([
    ...TRANSFORM_QUALITY_SAMPLE_COLUMNS,
    ...steps.map((step) => step.output.trim()).filter(Boolean),
  ]));
}

function getDerivedColumns(steps: RecipeStep[]) {
  return Array.from(new Set(
    steps
      .map((step) => step.output.trim())
      .filter((column) => column && !TRANSFORM_QUALITY_SAMPLE_COLUMN_SET.has(column)),
  ));
}

function getPermanentQualityRules(rules: QualityRule[]) {
  return rules.filter((rule) => !rule.id.startsWith(QUALITY_DRAFT_PREVIEW_ID_PREFIX));
}

function replaceOrAppendById<T extends { id: string }>(items: T[], nextItem: T) {
  return items.some((item) => item.id === nextItem.id)
    ? items.map((item) => item.id === nextItem.id ? nextItem : item)
    : [...items, nextItem];
}

function getTransformFailurePolicy(value: string): TransformFailurePolicy {
  return TRANSFORM_FAILURE_POLICY_OPTIONS.find((option) => option === value) ?? "Warn";
}

function createRecipeStepFromDraft(draft: RuleStepDraft, id: string, fallback: RuleStepDraft = DEFAULT_RULE_STEP_BY_CATEGORY.transform): RecipeStep {
  return {
    id,
    input: draft.input.trim() || fallback.input,
    onError: draft.onError.trim() || fallback.onError,
    operation: draft.operation.trim() || fallback.operation,
    output: draft.output.trim() || fallback.output,
    params: draft.params.trim() || fallback.params,
  };
}

function recipeStepToRuleStepDraft(step: RecipeStep): RuleStepDraft {
  return {
    input: step.input,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: step.params,
  };
}

function qualityRuleToRuleStepDraft(rule: QualityRule): RuleStepDraft {
  return {
    input: rule.targetColumn,
    onError: rule.failureAction,
    operation: rule.validationType,
    output: "validation_status",
    params: rule.severity,
  };
}

function getQualityRuleInvalidRows(rows: TransformQualityInvalidRow[], rule: QualityRule) {
  const rowsWithRuleIds = rows.filter((row) => row.ruleId);
  if (rowsWithRuleIds.length > 0) return rows.filter((row) => row.ruleId === rule.id);
  return rows.filter((row) => row.column === rule.targetColumn);
}

export function RuleApplicationPage({
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const [previewCache] = useState(() => readTransformQualityPreviewCache());
  const [selectedRuleCategory, setSelectedRuleCategory] = useState<RuleCategory>("transform");
  const [recipeSteps, setRecipeSteps] = useState<RecipeStep[]>(previewCache.recipeSteps);
  const [qualityRules, setQualityRules] = useState<QualityRule[]>(previewCache.qualityRules);
  const [selectedPreviewStepId, setSelectedPreviewStepId] = useState(previewCache.selectedPreviewStepId);
  const [selectedQualityRuleId, setSelectedQualityRuleId] = useState(previewCache.selectedQualityRuleId);
  const [draftPreviewStep, setDraftPreviewStep] = useState<RecipeStep | null>(null);
  const [draftPreviewQualityRule, setDraftPreviewQualityRule] = useState<QualityRule | null>(null);
  const [editingTransformStepId, setEditingTransformStepId] = useState<string | null>(null);
  const [editingQualityRuleId, setEditingQualityRuleId] = useState<string | null>(null);
  const [showInvalidRows, setShowInvalidRows] = useState(false);
  const workingColumns = useMemo(() => getWorkingColumns(recipeSteps), [recipeSteps]);
  const derivedColumns = useMemo(() => getDerivedColumns(recipeSteps), [recipeSteps]);
  const runnerResult = useMemo(() => runTransformQualitySamplePreview(recipeSteps, qualityRules), [qualityRules, recipeSteps]);
  const previewRunnerResult = useMemo(() => {
    const previewSteps = draftPreviewStep?.id === selectedPreviewStepId ? replaceOrAppendById(recipeSteps, draftPreviewStep) : recipeSteps;
    return runTransformQualitySamplePreview(previewSteps, qualityRules);
  }, [draftPreviewStep, qualityRules, recipeSteps, selectedPreviewStepId]);
  const qualityPreviewRules = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId ? replaceOrAppendById(qualityRules, draftPreviewQualityRule) : qualityRules
  ), [draftPreviewQualityRule, qualityRules, selectedQualityRuleId]);
  const qualityPreviewRunnerResult = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId
      ? runTransformQualitySamplePreview(recipeSteps, qualityPreviewRules)
      : runnerResult
  ), [draftPreviewQualityRule, qualityPreviewRules, recipeSteps, runnerResult, selectedQualityRuleId]);
  const validationResult = runnerResult.validation;
  const invalidRows = validationResult.failedRows;
  const invalidRowCount = validationResult.invalidRowCount;
  const ruleStats = getRuleStats(recipeSteps, qualityRules, invalidRowCount);
  const selectedPreviewStep = (draftPreviewStep?.id === selectedPreviewStepId ? draftPreviewStep : undefined)
    ?? recipeSteps.find((step) => step.id === selectedPreviewStepId)
    ?? recipeSteps[0]
    ?? INITIAL_RECIPE_STEPS[0];
  const selectedQualityRule = draftPreviewQualityRule?.id === selectedQualityRuleId
    ? draftPreviewQualityRule
    : qualityRules.find((rule) => rule.id === selectedQualityRuleId) ?? qualityRules[0] ?? INITIAL_QUALITY_RULES[0];
  const selectedQualityInvalidRows = getQualityRuleInvalidRows(qualityPreviewRunnerResult.validation.failedRows, selectedQualityRule);
  const invalidRowsPreviewSummary = formatInvalidRowsPreviewSummary(invalidRowCount, invalidRows.length);
  const cachedSelectedQualityRuleId = qualityRules.some((rule) => rule.id === selectedQualityRuleId)
    ? selectedQualityRuleId
    : qualityRules[0]?.id ?? INITIAL_QUALITY_RULES[0]?.id ?? "";
  const editingTransformStep = editingTransformStepId ? recipeSteps.find((step) => step.id === editingTransformStepId) ?? null : null;
  const editingQualityRule = editingQualityRuleId ? qualityRules.find((rule) => rule.id === editingQualityRuleId) ?? null : null;
  const editingDraft = useMemo(() => {
    if (selectedRuleCategory === "transform" && editingTransformStep) {
      return recipeStepToRuleStepDraft(editingTransformStep);
    }
    if (selectedRuleCategory === "quality" && editingQualityRule) {
      return qualityRuleToRuleStepDraft(editingQualityRule);
    }
    return null;
  }, [editingQualityRule, editingTransformStep, selectedRuleCategory]);
  const editingLabel = useMemo(() => {
    if (selectedRuleCategory === "transform" && editingTransformStep) {
      return `Step ${recipeSteps.findIndex((step) => step.id === editingTransformStep.id) + 1}`;
    }
    if (selectedRuleCategory === "quality" && editingQualityRule) {
      return `Rule ${qualityRules.findIndex((rule) => rule.id === editingQualityRule.id) + 1}`;
    }
    return undefined;
  }, [editingQualityRule, editingTransformStep, qualityRules, recipeSteps, selectedRuleCategory]);

  useEffect(() => {
    writeTransformQualityPreviewCache({
      datasetId: TRANSFORM_QUALITY_SAMPLE_PROFILE.datasetId,
      invalidRows,
      qualityRules,
      recipeSteps,
      selectedPreviewStepId,
      selectedQualityRuleId: cachedSelectedQualityRuleId,
      savedAt: new Date().toISOString(),
      validation: validationResult,
      version: 1,
    });
  }, [cachedSelectedQualityRuleId, invalidRows, qualityRules, recipeSteps, selectedPreviewStepId, validationResult]);

  const buildRuleDraftPatch = (steps: RecipeStep[] = recipeSteps, rules: QualityRule[] = qualityRules): DraftPipelinePatch => {
    const nextValidation = steps === recipeSteps && rules === qualityRules ? validationResult : runTransformQualitySamplePreview(steps, rules).validation;
    const nextSummary = formatRuleSummary(getRuleStats(steps, rules, nextValidation.invalidRowCount), nextValidation);
    return {
      ruleSummary: nextSummary,
      transform: {
        steps: toDraftTransformSteps(steps),
        summary: nextSummary,
      },
      quality: {
        invalidRows: toDraftInvalidRows(nextValidation.failedRows),
        rules: toDraftQualityRules(rules),
        score: nextValidation.qualityScore,
        status: nextValidation.status,
        summary: nextValidation.summary,
      },
    };
  };

  const applyRuleDraft = (steps: RecipeStep[] = recipeSteps, rules: QualityRule[] = qualityRules) => {
    onDraftChange(buildRuleDraftPatch(steps, rules));
  };

  const testRules = () => {
    onAction("etl.transform.tested", "/api/etl/transform-rules/test", "customer_review_raw");
    applyRuleDraft();
    onNotify(`${ruleStats.totalRules}개 rule 샘플 테스트가 완료되었습니다.`);
  };

  const ruleAction = (action: string, path: string, targetId = "customer_review_raw") => {
    onAction(action, path, targetId);
  };

  const saveRuleDraft = () => {
    applyRuleDraft();
    onSave();
  };

  const goNext = () => {
    applyRuleDraft();
    onNext();
  };

  const previewRecipeStep = (step: RecipeStep) => {
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(step.id);
    ruleAction("etl.rules.step_previewed", `/api/etl/rules/steps/${step.id}/preview`);
  };

  const editRecipeStep = (step: RecipeStep) => {
    setSelectedRuleCategory("transform");
    setEditingTransformStepId(step.id);
    setEditingQualityRuleId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(step.id);
    ruleAction("etl.rules.step_edit_started", `/api/etl/rules/steps/${step.id}`);
  };

  const cancelRuleEdit = () => {
    setEditingTransformStepId(null);
    setEditingQualityRuleId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    ruleAction("etl.rules.edit_canceled", "/api/etl/rules/edit");
  };

  const removeRecipeStep = (step: RecipeStep) => {
    const nextSteps = recipeSteps.filter((currentStep) => currentStep.id !== step.id);
    if (nextSteps.length === 0) {
      onNotify("최소 1개 rule은 유지해야 합니다.");
      return;
    }
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    if (editingTransformStepId === step.id) {
      setEditingTransformStepId(null);
    }
    if (!nextSteps.some((nextStep) => nextStep.id === selectedPreviewStepId)) {
      const removedIndex = recipeSteps.findIndex((currentStep) => currentStep.id === step.id);
      const nextSelectedStep = nextSteps[Math.min(Math.max(removedIndex, 0), nextSteps.length - 1)] ?? nextSteps[0];
      setSelectedPreviewStepId(nextSelectedStep.id);
    }
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_removed", `/api/etl/rules/steps/${step.id}`);
  };

  const addRecipeStep = (draft: RuleStepDraft) => {
    const nextStepNumber = String(Math.max(...recipeSteps.map((step) => Number(step.id)), 0) + 1);
    const nextStep = createRecipeStepFromDraft(draft, nextStepNumber);
    const nextSteps = [...recipeSteps, nextStep];
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(nextStep.id);
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_added", "/api/etl/rules/steps");
    onNotify("새 rule step이 추가되었습니다.");
  };

  const updateRecipeStep = (draft: RuleStepDraft) => {
    if (!editingTransformStepId) return;
    const currentStep = recipeSteps.find((step) => step.id === editingTransformStepId);
    if (!currentStep) {
      setEditingTransformStepId(null);
      onNotify("수정할 transform step을 찾을 수 없습니다.");
      return;
    }
    const updatedStep = createRecipeStepFromDraft(draft, editingTransformStepId, currentStep);
    const nextSteps = recipeSteps.map((step) => step.id === editingTransformStepId ? updatedStep : step);
    setRecipeSteps(nextSteps);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setEditingTransformStepId(null);
    setSelectedPreviewStepId(updatedStep.id);
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.step_updated", `/api/etl/rules/steps/${updatedStep.id}`);
    onNotify("rule step이 업데이트되었습니다.");
  };

  const addQualityRule = (draft: RuleStepDraft) => {
    const baseRules = getPermanentQualityRules(qualityRules);
    const nextRuleNumber = baseRules.length + 1;
    const nextRule = createQualityRuleFromDraft(draft, `qr-custom-${nextRuleNumber}`);
    const nextRules = [...baseRules, nextRule];
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(nextRule.id);
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_added", "/api/etl/rules/quality");
    onNotify("새 quality check가 추가되었습니다.");
  };

  const addRuleDraft = (draft: RuleStepDraft) => {
    if (selectedRuleCategory === "quality") {
      addQualityRule(draft);
      return;
    }
    addRecipeStep(draft);
  };

  const previewQualityRule = (rule: QualityRule) => {
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(rule.id);
    ruleAction("etl.rules.quality_rule_previewed", `/api/etl/rules/quality/${rule.id}/preview`);
  };

  const editQualityRule = (rule: QualityRule) => {
    setSelectedRuleCategory("quality");
    setEditingQualityRuleId(rule.id);
    setEditingTransformStepId(null);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    setSelectedQualityRuleId(rule.id);
    ruleAction("etl.rules.quality_rule_edit_started", `/api/etl/rules/quality/${rule.id}`);
  };

  const removeQualityRule = (rule: QualityRule) => {
    const baseRules = getPermanentQualityRules(qualityRules);
    if (baseRules.length <= 1) {
      onNotify("최소 1개 quality rule은 유지해야 합니다.");
      return;
    }
    const removedIndex = baseRules.findIndex((currentRule) => currentRule.id === rule.id);
    const nextRules = baseRules.filter((currentRule) => currentRule.id !== rule.id);
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    if (editingQualityRuleId === rule.id) {
      setEditingQualityRuleId(null);
    }
    if (!nextRules.some((nextRule) => nextRule.id === selectedQualityRuleId)) {
      const nextSelectedRule = nextRules[Math.min(Math.max(removedIndex, 0), nextRules.length - 1)] ?? nextRules[0];
      setSelectedQualityRuleId(nextSelectedRule.id);
    }
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_removed", `/api/etl/rules/quality/${rule.id}`);
    onNotify("quality check가 제외되었습니다.");
  };

  const updateQualityRule = (draft: RuleStepDraft) => {
    if (!editingQualityRuleId) return;
    const baseRules = getPermanentQualityRules(qualityRules);
    const currentRule = baseRules.find((rule) => rule.id === editingQualityRuleId);
    if (!currentRule) {
      setEditingQualityRuleId(null);
      onNotify("수정할 quality rule을 찾을 수 없습니다.");
      return;
    }
    const updatedRule = createQualityRuleFromDraft(draft, currentRule.id);
    const nextRules = baseRules.map((rule) => rule.id === currentRule.id ? updatedRule : rule);
    setQualityRules(nextRules);
    setDraftPreviewQualityRule(null);
    setEditingQualityRuleId(null);
    setSelectedQualityRuleId(updatedRule.id);
    applyRuleDraft(recipeSteps, nextRules);
    ruleAction("etl.rules.quality_rule_updated", `/api/etl/rules/quality/${updatedRule.id}`);
    onNotify("quality check가 업데이트되었습니다.");
  };

  const previewDraftStep = (draft: RuleStepDraft) => {
    if (selectedRuleCategory === "quality") {
      const draftRule = createQualityRuleFromDraft(draft, editingQualityRuleId ?? `${QUALITY_DRAFT_PREVIEW_ID_PREFIX}${Date.now()}`);
      setDraftPreviewQualityRule(draftRule);
      setSelectedQualityRuleId(draftRule.id);
      ruleAction("etl.rules.quality_rule_previewed", "/api/etl/rules/quality/preview");
      return;
    }
    const currentStep = editingTransformStepId ? recipeSteps.find((step) => step.id === editingTransformStepId) : undefined;
    const previewStep = createRecipeStepFromDraft(draft, editingTransformStepId ?? `draft-preview-${Date.now()}`, currentStep);
    setDraftPreviewStep(previewStep);
    setDraftPreviewQualityRule(null);
    setSelectedPreviewStepId(previewStep.id);
    ruleAction("etl.rules.step_previewed", "/api/etl/rules/steps/preview");
  };

  const toggleInvalidRows = () => {
    setShowInvalidRows((visible) => !visible);
    ruleAction("etl.rules.invalid_rows_toggled", "/api/etl/rules/invalid-rows");
  };

  return (
    <div className="hegun-rule-page">
      <RuleMetrics stats={ruleStats} />
      <RuleCategoryTabs activeCategory={selectedRuleCategory} onSelect={(category) => {
        setSelectedRuleCategory(category);
        ruleAction("etl.rules.category_selected", `/api/etl/rules/categories/${category}`);
      }} />
      <div className="hegun-rule-workspace">
        <div className="hegun-rule-main-stack">
          {selectedRuleCategory === "quality" ? (
            <QualityRulesTable rules={qualityRules} selectedRuleId={selectedQualityRuleId} onEdit={editQualityRule} onPreview={previewQualityRule} onRemove={removeQualityRule} />
          ) : (
            <RecipeStepsTable selectedStepId={selectedPreviewStep.id} steps={recipeSteps} onEdit={editRecipeStep} onPreview={previewRecipeStep} onRemove={removeRecipeStep} />
          )}
          <RuleStepBuilder
            category={selectedRuleCategory}
            editingDraft={editingDraft}
            editingLabel={editingLabel}
            workingColumns={workingColumns}
            onAction={ruleAction}
            onAddStep={addRuleDraft}
            onCancelEdit={cancelRuleEdit}
            onPreviewStep={previewDraftStep}
            onUpdateStep={selectedRuleCategory === "quality" ? updateQualityRule : updateRecipeStep}
          />
          {selectedRuleCategory === "quality" ? (
            <QualityPreviewAnalysis invalidRows={selectedQualityInvalidRows} rule={selectedQualityRule} sampleRows={qualityPreviewRunnerResult.validation.sampleRows} onAction={ruleAction} />
          ) : (
            <StepPreviewAnalysis
              preview={previewRunnerResult.previewByStepId[selectedPreviewStep.id] ?? TRANSFORM_QUALITY_PREVIEW_BY_STEP_ID[selectedPreviewStep.id]}
              step={selectedPreviewStep}
              onAction={ruleAction}
            />
          )}
          <FinalDatasetPreviewPanel
            columns={workingColumns}
            derivedColumns={derivedColumns}
            invalidRowCount={invalidRowCount}
            rows={runnerResult.transformedRows}
            totalRows={runnerResult.transformedRows.length}
            transformStepCount={recipeSteps.length}
          />
          {selectedRuleCategory === "quality" && <QualityFailedRowsPanel invalidRows={selectedQualityInvalidRows} rule={selectedQualityRule} onAction={ruleAction} />}
          {showInvalidRows && <InvalidRowsPanel invalidRows={invalidRows} invalidRowsPreviewSummary={invalidRowsPreviewSummary} onAction={ruleAction} />}
        </div>
      </div>
      <RuleBottomBar invalidRowCount={invalidRowCount} invalidRowsVisible={showInvalidRows} onInvalidRows={toggleInvalidRows} onNext={goNext} onPrev={onPrev} onSave={saveRuleDraft} onTest={testRules} />
    </div>
  );
}

function RuleMetrics({ stats }: { stats: RuleStats }) {
  return (
    <div className="hegun-rule-metrics">
      {RULE_METRIC_DEFS.map(({ icon, label, value }) => (
        <article className="hegun-rule-metric" key={label}>
          <span className="hegun-rule-metric-icon">{icon}</span>
          <div>
            <span>{label}</span>
            <strong>{value(stats)}</strong>
          </div>
        </article>
      ))}
      <div className="hegun-draft-chip">
        <i />
        Draft: Unsaved Changes
      </div>
    </div>
  );
}

function RuleCategoryTabs({ activeCategory, onSelect }: { activeCategory: RuleCategory; onSelect: (category: RuleCategory) => void }) {
  return (
    <section className="hegun-rule-mode-switcher" aria-label="Rule mode">
      <div className="hegun-rule-category-list" role="tablist" aria-label="Rule mode">
        {RULE_CATEGORIES.map((category) => (
          <button
            aria-selected={category.id === activeCategory}
            className={category.id === activeCategory ? "hegun-rule-category active" : "hegun-rule-category"}
            key={category.id}
            role="tab"
            type="button"
            onClick={() => onSelect(category.id)}
          >
            <span className="hegun-rule-category-icon">{category.icon}</span>
            <strong>{category.label}</strong>
            <em>{category.description}</em>
          </button>
        ))}
      </div>
      <div className="hegun-rail-note">
        <BookOpen size={16} />
        <span>Sample first, full dataset during execution.</span>
      </div>
    </section>
  );
}

function RecipeStepsTable({
  onEdit,
  onPreview,
  onRemove,
  selectedStepId,
  steps,
}: {
  onEdit: (step: RecipeStep) => void;
  onPreview: (step: RecipeStep) => void;
  onRemove: (step: RecipeStep) => void;
  selectedStepId: string;
  steps: RecipeStep[];
}) {
  return (
    <section className="panel hegun-console-panel hegun-recipe-panel">
      <div className="hegun-section-title">
        <h2>Transformation Recipe Steps</h2>
        <p>Rules are applied sequentially to sample data first, then to the full dataset during execution.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Input</th>
              <th>Operation</th>
              <th>Output</th>
              <th>Params</th>
              <th>On Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((row, index) => {
              const stepNumber = index + 1;
              const isSelected = row.id === selectedStepId;
              return (
              <tr
                aria-current={isSelected ? "step" : undefined}
                className={isSelected ? "selected" : undefined}
                key={`${row.id}-${row.input}`}
                onClick={() => onPreview(row)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPreview(row);
                  }
                }}
              >
                <td>
                  <span className="hegun-step-number"><strong>{stepNumber}</strong></span>
                </td>
                <td><span className="hegun-data-chip">{row.input}</span></td>
                <td>{row.operation}</td>
                <td><span className="hegun-data-chip muted">{row.output}</span></td>
                <td>{row.params}</td>
                <td><span className={`hegun-error-pill ${row.onError.toLowerCase().replace(/\s/g, "-")}`}>{row.onError}</span></td>
                <td>
                  <div className="hegun-row-actions">
                    <button aria-label={`Edit step ${stepNumber}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onEdit(row);
                    }}>
                      <Pencil size={15} />
                    </button>
                    <button aria-label={`Remove step ${stepNumber}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onRemove(row);
                    }}>
                      <Minus size={15} />
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QualityRulesTable({
  onEdit,
  onRemove,
  onPreview,
  rules,
  selectedRuleId,
}: {
  onEdit: (rule: QualityRule) => void;
  onRemove: (rule: QualityRule) => void;
  onPreview: (rule: QualityRule) => void;
  rules: QualityRule[];
  selectedRuleId: string;
}) {
  return (
    <section className="panel hegun-console-panel hegun-recipe-panel">
      <div className="hegun-section-title">
        <h2>Quality Validation Rules</h2>
        <p>Validation rules run against sample rows first and block, quarantine, or warn before execution.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table hegun-quality-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Column</th>
              <th>Validation</th>
              <th>Severity</th>
              <th>Failure Action</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule, index) => {
              const isSelected = rule.id === selectedRuleId;
              return (
              <tr
                aria-current={isSelected ? "step" : undefined}
                className={isSelected ? "selected" : undefined}
                key={rule.id}
                onClick={() => onPreview(rule)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPreview(rule);
                  }
                }}
              >
                <td><strong>{index + 1}</strong></td>
                <td><span className="hegun-data-chip">{rule.targetColumn}</span></td>
                <td>{rule.validationType}</td>
                <td><span className={`hegun-error-pill ${rule.severity.toLowerCase()}`}>{rule.severity}</span></td>
                <td><span className={`hegun-error-pill ${rule.failureAction.toLowerCase().replace(/\s/g, "-")}`}>{rule.failureAction}</span></td>
                <td>{rule.severity === "Error" ? "Blocking" : "Monitor"}</td>
                <td>
                  <div className="hegun-row-actions">
                    <button aria-label={`Edit quality rule ${index + 1}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onEdit(rule);
                    }}>
                      <Pencil size={15} />
                    </button>
                    <button aria-label={`Exclude quality rule ${index + 1}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onRemove(rule);
                    }}>
                      <Minus size={15} />
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function transformPresetToRuleStepDraft(step: (typeof RECOMMENDED_TRANSFORM_STEPS)[number]): RuleStepDraft {
  return {
    input: step.input,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: step.params,
  };
}

function getQualityValidationType(operation: string): QualityRule["validationType"] {
  const validationType = operation.trim() as QualityRule["validationType"];
  return QUALITY_VALIDATION_OPTIONS.find((option) => option === validationType) ?? "Regex Match";
}

function getQualitySeverity(severity: string): QualityRule["severity"] {
  const nextSeverity = severity.trim() as QualityRule["severity"];
  return QUALITY_SEVERITY_OPTIONS.find((option) => option === nextSeverity) ?? "Warning";
}

function getQualityFailureAction(failureAction: string): QualityRule["failureAction"] {
  const nextFailureAction = failureAction.trim() as QualityRule["failureAction"];
  return QUALITY_FAILURE_ACTION_OPTIONS.find((option) => option === nextFailureAction) ?? "Warn";
}

function createQualityRuleFromDraft(draft: RuleStepDraft, id: string): QualityRule {
  const fallback = DEFAULT_RULE_STEP_BY_CATEGORY.quality;
  return {
    failureAction: getQualityFailureAction(draft.onError || fallback.onError),
    id,
    severity: getQualitySeverity(draft.params || "Warning"),
    targetColumn: draft.input.trim() || fallback.input,
    validationType: getQualityValidationType(draft.operation || fallback.operation),
  };
}

function getAllowedTransformOperation(operation: string | undefined): TransformOperation {
  return TRANSFORM_OPERATION_OPTIONS.find((option) => option === operation) ?? "Extract JSONPath";
}

function getDefaultParamForOperation(operation: TransformOperation) {
  switch (operation) {
    case "Extract JSONPath":
      return "$.user.contact.email";
    case "Lowercase + Trim":
      return "lower(), trim()";
    case "Cast Decimal":
      return "decimal(10,2)";
    case "Parse Timestamp":
      return "UTC";
    case "Mask":
      return "keep first 3 digits";
    default:
      return "";
  }
}

function getRecommendedOutputColumn(operation: TransformOperation, inputColumn: string) {
  if (operation === "Extract JSONPath" && inputColumn === "meta_json") return "user_email";
  if (operation === "Parse Timestamp" && inputColumn === "created_at") return "created_at_utc";
  if (operation === "Mask" && inputColumn === "phone_number") return "phone_masked";
  return inputColumn || "normalized_value";
}

function RuleStepBuilder({
  category,
  editingDraft,
  editingLabel,
  onAddStep,
  onAction,
  onCancelEdit,
  onPreviewStep,
  onUpdateStep,
  workingColumns,
}: {
  category: RuleCategory;
  editingDraft: RuleStepDraft | null;
  editingLabel?: string;
  onAddStep: (draft: RuleStepDraft) => void;
  onAction: RuleActionHandler;
  onCancelEdit: () => void;
  onPreviewStep: (draft: RuleStepDraft) => void;
  onUpdateStep: (draft: RuleStepDraft) => void;
  workingColumns: string[];
}) {
  const isTransform = category === "transform";
  const isEditing = Boolean(editingDraft);
  const [collapsed, setCollapsed] = useState(true);
  const defaultPresetId = isTransform ? RECOMMENDED_TRANSFORM_STEPS[0]?.id ?? "" : QUALITY_RULE_OPTIONS[0]?.id ?? "";
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId);
  const selectedTransformPreset = RECOMMENDED_TRANSFORM_STEPS.find((step) => step.id === selectedPresetId) ?? RECOMMENDED_TRANSFORM_STEPS[0];
  const selectedQualityPreset = QUALITY_RULE_OPTIONS.find((rule) => rule.id === selectedPresetId) ?? QUALITY_RULE_OPTIONS[0];
  const [selectedInputColumn, setSelectedInputColumn] = useState(selectedTransformPreset.input);
  const [selectedOperation, setSelectedOperation] = useState<TransformOperation>(getAllowedTransformOperation(selectedTransformPreset.operation));
  const [outputColumn, setOutputColumn] = useState(selectedTransformPreset.output);
  const [outputColumnTouched, setOutputColumnTouched] = useState(false);
  const [jsonPath, setJsonPath] = useState(getDefaultParamForOperation("Extract JSONPath"));
  const [decimalFormat, setDecimalFormat] = useState(getDefaultParamForOperation("Cast Decimal"));
  const [timestampFormat, setTimestampFormat] = useState(getDefaultParamForOperation("Parse Timestamp"));
  const [maskPolicy, setMaskPolicy] = useState(getDefaultParamForOperation("Mask"));
  const [onError, setOnError] = useState<TransformFailurePolicy>("Set Null");
  const [selectedTargetColumn, setSelectedTargetColumn] = useState(selectedQualityPreset.targetColumn);
  const [selectedValidationType, setSelectedValidationType] = useState<QualityRule["validationType"]>(selectedQualityPreset.validationType);
  const [selectedSeverity, setSelectedSeverity] = useState<QualityRule["severity"]>(selectedQualityPreset.severity);
  const [selectedFailureAction, setSelectedFailureAction] = useState<QualityRule["failureAction"]>(selectedQualityPreset.failureAction);
  const trimmedOutputColumn = outputColumn.trim();
  const outputColumnMode = trimmedOutputColumn && TRANSFORM_QUALITY_SAMPLE_COLUMN_SET.has(trimmedOutputColumn) ? "inPlace" : "derived";
  const getTransformParams = (operation: TransformOperation) => {
    switch (operation) {
      case "Extract JSONPath":
        return jsonPath.trim() || getDefaultParamForOperation(operation);
      case "Lowercase + Trim":
        return getDefaultParamForOperation(operation);
      case "Cast Decimal":
        return decimalFormat.trim() || getDefaultParamForOperation(operation);
      case "Parse Timestamp":
        return timestampFormat.trim() || getDefaultParamForOperation(operation);
      case "Mask":
        return maskPolicy.trim() || getDefaultParamForOperation(operation);
      default:
        return "";
    }
  };
  const selectedDraft = isTransform
    ? {
        input: selectedInputColumn,
        onError,
        operation: selectedOperation,
        output: outputColumn,
        params: getTransformParams(selectedOperation),
      }
    : {
        input: selectedTargetColumn,
        onError: selectedFailureAction,
        operation: selectedValidationType,
        output: "validation_status",
        params: selectedSeverity,
      };
  const presetOptions = isTransform
    ? RECOMMENDED_TRANSFORM_STEPS.map((step) => ({ id: step.id, label: `${step.operation}: ${step.input} -> ${step.output}` }))
    : QUALITY_RULE_OPTIONS.map((rule) => ({ id: rule.id, label: `${rule.validationType}: ${rule.targetColumn} · ${rule.severity} / ${rule.failureAction}` }));
  const applyTransformPreset = (preset: typeof selectedTransformPreset) => {
    const operation = getAllowedTransformOperation(preset.operation);
    setSelectedInputColumn(preset.input);
    setSelectedOperation(operation);
    setOutputColumn(preset.output || getRecommendedOutputColumn(operation, preset.input));
    setOutputColumnTouched(false);
    setJsonPath(operation === "Extract JSONPath" ? preset.params : getDefaultParamForOperation("Extract JSONPath"));
    setDecimalFormat(operation === "Cast Decimal" ? preset.params : getDefaultParamForOperation("Cast Decimal"));
    setTimestampFormat(operation === "Parse Timestamp" ? preset.params : getDefaultParamForOperation("Parse Timestamp"));
    setMaskPolicy(operation === "Mask" ? preset.params : getDefaultParamForOperation("Mask"));
    setOnError(TRANSFORM_FAILURE_POLICY_OPTIONS.find((option) => option === preset.onError) ?? "Warn");
  };
  const applyQualityPreset = (preset: QualityRule) => {
    setSelectedTargetColumn(preset.targetColumn);
    setSelectedValidationType(preset.validationType);
    setSelectedSeverity(preset.severity);
    setSelectedFailureAction(preset.failureAction);
  };
  const applyTransformDraft = (draft: RuleStepDraft) => {
    const operation = getAllowedTransformOperation(draft.operation);
    setSelectedInputColumn(draft.input);
    setSelectedOperation(operation);
    setOutputColumn(draft.output || getRecommendedOutputColumn(operation, draft.input));
    setOutputColumnTouched(true);
    setJsonPath(operation === "Extract JSONPath" ? draft.params : getDefaultParamForOperation("Extract JSONPath"));
    setDecimalFormat(operation === "Cast Decimal" ? draft.params : getDefaultParamForOperation("Cast Decimal"));
    setTimestampFormat(operation === "Parse Timestamp" ? draft.params : getDefaultParamForOperation("Parse Timestamp"));
    setMaskPolicy(operation === "Mask" ? draft.params : getDefaultParamForOperation("Mask"));
    setOnError(getTransformFailurePolicy(draft.onError));
  };
  const applyQualityDraft = (draft: RuleStepDraft) => {
    setSelectedTargetColumn(draft.input);
    setSelectedValidationType(getQualityValidationType(draft.operation));
    setSelectedSeverity(getQualitySeverity(draft.params));
    setSelectedFailureAction(getQualityFailureAction(draft.onError));
  };
  useEffect(() => {
    if (isEditing) return;
    setSelectedPresetId(defaultPresetId);
  }, [defaultPresetId, isEditing]);
  useEffect(() => {
    if (isEditing) return;
    if (isTransform) {
      applyTransformPreset(selectedTransformPreset);
      return;
    }
    applyQualityPreset(selectedQualityPreset);
  }, [isEditing, isTransform, selectedPresetId, selectedQualityPreset, selectedTransformPreset]);
  useEffect(() => {
    if (!editingDraft) return;
    setCollapsed(false);
    if (isTransform) {
      applyTransformDraft(editingDraft);
      return;
    }
    applyQualityDraft(editingDraft);
  }, [editingDraft, isTransform]);
  useEffect(() => {
    if (!isTransform || outputColumnTouched) return;
    setOutputColumn(getRecommendedOutputColumn(selectedOperation, selectedInputColumn));
  }, [isTransform, outputColumnTouched, selectedInputColumn, selectedOperation]);
  useEffect(() => {
    if (workingColumns.length === 0) return;
    if (isTransform && !workingColumns.includes(selectedInputColumn)) {
      setSelectedInputColumn(workingColumns[0]);
      if (!outputColumnTouched) {
        setOutputColumn(getRecommendedOutputColumn(selectedOperation, workingColumns[0]));
      }
    }
    if (!isTransform && !workingColumns.includes(selectedTargetColumn)) {
      setSelectedTargetColumn(workingColumns[0]);
    }
  }, [isTransform, outputColumnTouched, selectedInputColumn, selectedOperation, selectedTargetColumn, workingColumns]);
  const toggleCollapsed = () => {
    setCollapsed((isCollapsed) => !isCollapsed);
    onAction(collapsed ? "etl.rules.builder_expanded" : "etl.rules.builder_collapsed", "/api/etl/rules/builder");
  };
  const selectTransformOperation = (operation: TransformOperation) => {
    setSelectedOperation(operation);
    if (!outputColumnTouched) {
      setOutputColumn(getRecommendedOutputColumn(operation, selectedInputColumn));
    }
  };
  const selectTransformInputColumn = (inputColumn: string) => {
    setSelectedInputColumn(inputColumn);
    if (!outputColumnTouched) {
      setOutputColumn(getRecommendedOutputColumn(selectedOperation, inputColumn));
    }
  };
  const previewDraft = () => {
    onPreviewStep(selectedDraft);
  };
  const addDraftStep = () => {
    if (isEditing) {
      onUpdateStep(selectedDraft);
    } else {
      onAddStep(selectedDraft);
    }
    setCollapsed(true);
  };
  const cancelEdit = () => {
    onCancelEdit();
    setCollapsed(true);
  };
  const builderTitle = isEditing
    ? isTransform
      ? "Edit Transformation Step"
      : "Edit Quality Check"
    : isTransform
      ? "Add Transformation Step"
      : "Add Quality Check";
  const builderDescription = isEditing
    ? `${editingLabel ?? "Selected rule"} 값을 수정한 뒤 Update로 같은 id에 저장합니다.`
    : isTransform
      ? "Define a new rule to process your data pipeline"
      : "Define a validation rule before execution";
  const submitLabel = isEditing
    ? isTransform ? "Update Step" : "Update Check"
    : isTransform ? "Add Selected Step" : "Add Selected Check";

  return (
    <section className={collapsed ? "panel hegun-console-panel hegun-builder-panel collapsed" : "panel hegun-console-panel hegun-builder-panel"}>
      <div
        className="hegun-builder-header"
        onClick={toggleCollapsed}
      >
        <div>
          <span className="hegun-builder-icon">{isEditing ? <Pencil size={20} /> : <Plus size={20} />}</span>
          <div>
            <h2>{builderTitle}</h2>
            <p>{builderDescription}</p>
          </div>
        </div>
        <button className="icon-button hegun-builder-collapse" aria-expanded={!collapsed} aria-label={collapsed ? "Expand add step" : "Collapse add step"} type="button" onClick={(event) => {
          event.stopPropagation();
          toggleCollapsed();
        }}>
          {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="hegun-rule-builder">
            {!isEditing && (
              <label className="hegun-rule-field wide">
                <span>{isTransform ? "Load Recommended Rule" : "Load Recommended Quality Rule"}</span>
                <select className="input control-input" value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
                  {presetOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="hegun-rule-field">
              <span>{isTransform ? "Input Column" : "Target Column"}</span>
              <select
                className="input control-input"
                value={isTransform ? selectedInputColumn : selectedTargetColumn}
                onChange={(event) => {
                  if (isTransform) {
                    selectTransformInputColumn(event.target.value);
                    return;
                  }
                  setSelectedTargetColumn(event.target.value);
                }}
              >
                {workingColumns.map((column) => (
                  <option key={column} value={column}>
                    {TRANSFORM_QUALITY_SAMPLE_COLUMN_SET.has(column) ? column : `${column} (derived)`}
                  </option>
                ))}
              </select>
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "Operation" : "Validation Rule"}</span>
              {isTransform ? (
                <select className="input control-input" value={selectedOperation} onChange={(event) => selectTransformOperation(event.target.value as TransformOperation)}>
                  {TRANSFORM_OPERATION_OPTIONS.map((operation) => (
                    <option key={operation} value={operation}>{operation}</option>
                  ))}
                </select>
              ) : (
                <select className="input control-input" value={selectedValidationType} onChange={(event) => setSelectedValidationType(event.target.value as QualityRule["validationType"])}>
                  {QUALITY_VALIDATION_OPTIONS.map((validationType) => (
                    <option key={validationType} value={validationType}>{validationType}</option>
                  ))}
                </select>
              )}
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "Output Column" : "Severity"}</span>
              {isTransform ? (
                <div className="hegun-rule-control-stack">
                  <input
                    className="input control-input"
                    type="text"
                    value={outputColumn}
                    onChange={(event) => {
                      setOutputColumn(event.target.value);
                      setOutputColumnTouched(true);
                    }}
                  />
                  <em>
                    {trimmedOutputColumn
                      ? outputColumnMode === "inPlace"
                        ? "기존 컬럼을 덮어씁니다."
                        : "새 derived column을 생성하고 이후 step에서 사용할 수 있습니다."
                      : "새 이름을 입력하면 이후 step에서 사용할 수 있는 derived column이 됩니다."}
                  </em>
                </div>
              ) : (
                <select className="input control-input" value={selectedSeverity} onChange={(event) => setSelectedSeverity(event.target.value as QualityRule["severity"])}>
                  {QUALITY_SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>{severity}</option>
                  ))}
                </select>
              )}
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "Parameters" : "Failure Action"}</span>
              {isTransform ? (
                <TransformParameterControl
                  decimalFormat={decimalFormat}
                  jsonPath={jsonPath}
                  maskPolicy={maskPolicy}
                  operation={selectedOperation}
                  timestampFormat={timestampFormat}
                  onDecimalFormatChange={setDecimalFormat}
                  onJsonPathChange={setJsonPath}
                  onMaskPolicyChange={setMaskPolicy}
                  onTimestampFormatChange={setTimestampFormat}
                />
              ) : (
                <select className="input control-input" value={selectedFailureAction} onChange={(event) => setSelectedFailureAction(event.target.value as QualityRule["failureAction"])}>
                  {QUALITY_FAILURE_ACTION_OPTIONS.map((failureAction) => (
                    <option key={failureAction} value={failureAction}>{failureAction}</option>
                  ))}
                </select>
              )}
            </label>
            {isTransform && (
              <label className="hegun-rule-field">
                <span>On Error</span>
                <select className="input control-input" value={onError} onChange={(event) => setOnError(event.target.value as TransformFailurePolicy)}>
                  {TRANSFORM_FAILURE_POLICY_OPTIONS.map((policy) => (
                    <option key={policy} value={policy}>{policy}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="hegun-rule-form-actions">
            {isEditing && <button className="ghost-button" type="button" onClick={cancelEdit}>Cancel Edit</button>}
            <button className="secondary-button" type="button" onClick={previewDraft}>{isTransform ? "Preview Selected Step" : "Preview Selected Check"}</button>
            <button className="primary-button" type="button" onClick={addDraftStep}>{submitLabel}</button>
          </div>
        </>
      )}
    </section>
  );
}

function TransformParameterControl({
  decimalFormat,
  jsonPath,
  maskPolicy,
  onDecimalFormatChange,
  onJsonPathChange,
  onMaskPolicyChange,
  onTimestampFormatChange,
  operation,
  timestampFormat,
}: {
  decimalFormat: string;
  jsonPath: string;
  maskPolicy: string;
  onDecimalFormatChange: (value: string) => void;
  onJsonPathChange: (value: string) => void;
  onMaskPolicyChange: (value: string) => void;
  onTimestampFormatChange: (value: string) => void;
  operation: TransformOperation;
  timestampFormat: string;
}) {
  if (operation === "Lowercase + Trim") {
    return (
      <div className="hegun-rule-select">
        <strong>No parameter required</strong>
        <em>params saved as lower(), trim()</em>
      </div>
    );
  }

  if (operation === "Extract JSONPath") {
    return (
      <div className="hegun-rule-control-stack">
        <input className="input control-input" type="text" value={jsonPath} onChange={(event) => onJsonPathChange(event.target.value)} />
        <em>JSON column에서 꺼낼 경로</em>
      </div>
    );
  }

  if (operation === "Cast Decimal") {
    return (
      <div className="hegun-rule-control-stack">
        <input className="input control-input" type="text" value={decimalFormat} onChange={(event) => onDecimalFormatChange(event.target.value)} />
        <em>Decimal Format</em>
      </div>
    );
  }

  if (operation === "Parse Timestamp") {
    return (
      <div className="hegun-rule-control-stack">
        <select className="input control-input" value={timestampFormat} onChange={(event) => onTimestampFormatChange(event.target.value)}>
          <option value="UTC">UTC</option>
          <option value="string to UTC">string to UTC</option>
        </select>
        <em>Target Timezone / Format</em>
      </div>
    );
  }

  return (
    <div className="hegun-rule-control-stack">
      <select className="input control-input" value={maskPolicy} onChange={(event) => onMaskPolicyChange(event.target.value)}>
        <option value="keep first 3 digits">keep first 3 digits</option>
        <option value="keep last 4 digits">keep last 4 digits</option>
      </select>
      <em>Mask Policy</em>
    </div>
  );
}

function RuleBottomBar({
  invalidRowCount,
  invalidRowsVisible,
  onInvalidRows,
  onNext,
  onPrev,
  onSave,
  onTest,
}: {
  invalidRowCount: number;
  invalidRowsVisible: boolean;
  onInvalidRows: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <div className="hegun-rule-bottom-bar">
      <button className="secondary-button" type="button" onClick={onPrev}>스키마로 돌아가기</button>
      <button className="ghost-button hegun-bottom-command" type="button" onClick={onTest}>
        <Search size={16} />
        샘플 테스트 (1,000개 행)
      </button>
      <button className={invalidRowsVisible ? "ghost-button hegun-bottom-command active" : "ghost-button hegun-bottom-command"} type="button" onClick={onInvalidRows}>
        <Info size={16} />
        유효하지 않은 행 보기 ({invalidRowCount})
      </button>
      <span className="hegun-target-engine">TARGET ENGINE<br /><strong>AWS Athena (Presto)</strong></span>
      <button className="secondary-button" type="button" onClick={onSave}>임시 저장</button>
      <button className="primary-button" type="button" onClick={onNext}>실행 준비 완료</button>
    </div>
  );
}

function FinalDatasetPreviewPanel({
  columns,
  derivedColumns,
  invalidRowCount,
  rows,
  totalRows,
  transformStepCount,
}: {
  columns: string[];
  derivedColumns: string[];
  invalidRowCount: number;
  rows: TransformQualitySampleRow[];
  totalRows: number;
  transformStepCount: number;
}) {
  const previewRows = rows.slice(0, 10);
  const derivedColumnSet = new Set(derivedColumns);
  const showingRowsLabel = `Showing ${previewRows.length.toLocaleString()} of ${totalRows.toLocaleString()} rows`;
  const summaryItems = [
    { label: "Sample rows processed", value: totalRows.toLocaleString() },
    { label: "Transform steps applied", value: transformStepCount.toLocaleString() },
    { label: "Derived columns created", value: derivedColumns.length.toLocaleString() },
    { label: "Invalid rows detected", value: invalidRowCount.toLocaleString() },
  ];

  return (
    <section className="panel hegun-console-panel hegun-final-preview-panel">
      <div className="panel-header">
        <Table2 size={18} />
        <h2>Final Dataset Preview</h2>
        <span className="panel-note">{showingRowsLabel}</span>
      </div>
      <div className="hegun-final-preview-summary">
        {summaryItems.map((item) => (
          <article key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-final-preview-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>
                  <span className="hegun-final-column-header">
                    {column}
                    {derivedColumnSet.has(column) && <em>derived</em>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.length > 0 ? previewRows.map((row, rowIndex) => (
              <tr key={row.row_id ?? `row-${rowIndex}`}>
                {columns.map((column) => (
                  <td key={`${row.row_id ?? rowIndex}-${column}`}>{row[column] ?? ""}</td>
                ))}
              </tr>
            )) : (
              <tr>
                <td colSpan={columns.length}>
                  <span className="hegun-empty-table-state">No transformed sample rows available.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="hegun-final-preview-footer">{showingRowsLabel}</div>
    </section>
  );
}

function StepPreviewAnalysis({
  onAction,
  preview,
  step,
}: {
  onAction: RuleActionHandler;
  preview?: TransformQualityPreviewSample | TransformQualityStepPreview;
  step: RecipeStep;
}) {
  const hasPreview = Boolean(preview);
  const inputValue = preview?.inputValue ?? "";
  const outputValue = preview?.outputValue ?? "";
  const matchedRows = preview?.matchedRows ?? TRANSFORM_QUALITY_SAMPLE_PROFILE.totalRows;
  const failedRows = preview?.failedRows ?? 0;
  const previewStatus = preview?.status ?? "Preview pending";
  const beforeRows = preview && "beforeRows" in preview ? preview.beforeRows : [];
  const afterRows = preview && "afterRows" in preview ? preview.afterRows : [];
  const previewColumns = preview && "columns" in preview ? preview.columns : ["row_id", step.input, step.output].filter(Boolean);
  const impactRows = buildStepImpactRows(beforeRows, afterRows, previewColumns, step, preview);
  return (
    <section className="panel hegun-console-panel">
      <div className="panel-header">
        <RefreshCw size={18} />
        <h2>단계 미리보기 및 분석 (Step Preview & Analysis)</h2>
        <button className="secondary-button hegun-header-button" type="button" onClick={() => onAction("etl.rules.sample_rows_refetched", "/api/etl/rules/sample-rows")}>새 샘플 행 가져오기</button>
      </div>
      <div className="hegun-selected-step-banner">
        <span>Selected Step</span>
        <strong>{step.id}. {step.operation}</strong>
        <em>{step.input} {"->"} {step.output}</em>
      </div>
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>Step Details</h3>
          <Field label="Input Column" value={step.input} />
          <Field label="Output Column" value={step.output} />
          <Field label="Operation" value={step.operation} />
          <Field label="On Error" value={step.onError} />
          <Field label="Params" value={step.params} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>Input to Output</h3>
          <Field label="Input Value" value={inputValue} wide />
          <div className="hegun-preview-arrow">→</div>
          <Field label="Output Value" value={outputValue} wide />
          <span className="hegun-success-state"><Check size={14} /> {previewStatus}</span>
        </div>
        <div className="hegun-preview-column">
          <h3>Sample Stats</h3>
          <StatusTile label="Sample Rows" value={TRANSFORM_QUALITY_SAMPLE_PROFILE.totalRows.toLocaleString()} status="Tested" />
          <StatusTile label="Matched Rows" value={matchedRows.toLocaleString()} status="Matched" />
          <StatusTile label="Failed Rows" value={String(failedRows)} status={failedRows > 0 ? "Review" : hasPreview ? "Clean" : "Pending"} />
          <StatusTile label="Affected Column" value={preview?.affectedColumn ?? step.output} status={hasPreview ? "Output" : "Pending"} />
        </div>
      </div>
      <div className="hegun-impact-header">
        <div>
          <h3>Rule Impact Preview</h3>
          <p>{step.operation} runs against {matchedRows.toLocaleString()} matched rows. Showing {impactRows.length} representative rows.</p>
        </div>
        <span>{previewStatus}</span>
      </div>
      <StepImpactRowsTable rows={impactRows} step={step} />
    </section>
  );
}

function StepImpactRowsTable({
  rows,
  step,
}: {
  rows: ReturnType<typeof buildStepImpactRows>;
  step: RecipeStep;
}) {
  return (
    <div className="hegun-table-scroll">
      <table className="schema-table hegun-impact-table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Before: {step.input}</th>
            <th>Transform</th>
            <th>After: {step.output}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.rowId}-${row.beforeValue}-${row.afterValue}`}>
              <td><strong>{row.rowId}</strong></td>
              <td><code className="hegun-impact-value">{row.beforeValue}</code></td>
              <td><span className="hegun-data-chip muted">{step.operation}</span></td>
              <td><code className="hegun-impact-value output">{row.afterValue}</code></td>
              <td><span className={`hegun-impact-status ${row.status.toLowerCase()}`}>{row.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildStepImpactRows(
  beforeRows: string[][],
  afterRows: string[][],
  columns: string[],
  step: RecipeStep,
  preview?: TransformQualityPreviewSample | TransformQualityStepPreview,
) {
  const rowIdIndex = Math.max(0, columns.indexOf("row_id"));
  const inputIndex = columns.indexOf(step.input);
  const outputIndex = columns.reduce((matchedIndex, column, index) => column === step.output ? index : matchedIndex, -1);
  const safeInputIndex = inputIndex >= 0 ? inputIndex : 0;
  const safeOutputIndex = outputIndex >= 0 ? outputIndex : columns.length - 1;
  const sourceRows = beforeRows.length > 0
    ? beforeRows.slice(0, 5)
    : Array.from({ length: 3 }, (_, index) => [String(index + 1), preview?.inputValue ?? "", preview?.outputValue ?? ""]);

  return sourceRows.map((row, index) => {
    const afterRow = afterRows[index] ?? row;
    const beforeOutputValue = row[safeOutputIndex] ?? "";
    const afterValue = afterRow[safeOutputIndex] ?? preview?.outputValue ?? "";
    const changed = afterValue !== beforeOutputValue;
    const status = step.input !== step.output ? "Derived" : changed ? "Changed" : "Unchanged";

    return {
      afterValue: truncatePreviewValue(afterValue),
      beforeValue: truncatePreviewValue(row[safeInputIndex] ?? ""),
      rowId: row[rowIdIndex] ?? String(index + 1),
      status,
    };
  });
}

function truncatePreviewValue(value: string) {
  if (value.length <= 120) return value;
  return `${value.slice(0, 117)}...`;
}

function QualityPreviewAnalysis({
  invalidRows,
  onAction,
  rule,
  sampleRows,
}: {
  invalidRows: TransformQualityInvalidRow[];
  onAction: RuleActionHandler;
  rule: QualityRule;
  sampleRows: number;
}) {
  const invalidRowCount = invalidRows.length;
  const matchedRows = Math.max(0, sampleRows - invalidRowCount);
  const qualityScore = sampleRows ? Number(((matchedRows / sampleRows) * 100).toFixed(1)) : 100;
  const firstFailure = invalidRows[0];
  return (
    <section className="panel hegun-console-panel">
      <div className="panel-header">
        <ShieldCheck size={18} />
        <h2>품질 검증 미리보기 (Quality Check Analysis)</h2>
        <button className="secondary-button hegun-header-button" type="button" onClick={() => onAction("etl.rules.quality_sample_refetched", "/api/etl/rules/quality/sample-rows")}>새 샘플 행 가져오기</button>
      </div>
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>Rule Details</h3>
          <Field label="Target Column" value={rule.targetColumn} />
          <Field label="Validation" value={rule.validationType} />
          <Field label="Severity" value={rule.severity} />
          <Field label="Failure Action" value={rule.failureAction} />
          <Field label="Status" value={rule.severity === "Error" ? "Blocking" : "Monitor"} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>Sample Failure</h3>
          <Field label="Row" value={firstFailure?.row ?? "No failed sample"} />
          <Field label="Column" value={firstFailure?.column ?? rule.targetColumn} />
          <Field label="Sample Value" value={firstFailure?.sampleValue || "(empty)"} wide />
          <Field label="Reason" value={firstFailure?.reason ?? "All sampled rows passed"} wide />
          <Field label="Action" value={firstFailure?.action ?? rule.failureAction} />
          <span className={invalidRowCount > 0 ? "hegun-warning-state" : "hegun-success-state"}>
            <Info size={14} /> {invalidRowCount > 0 ? "Review needed" : "Success"}
          </span>
        </div>
        <div className="hegun-preview-column">
          <h3>Sample Stats</h3>
          <StatusTile label="Sample Rows" value={sampleRows.toLocaleString()} status="Tested" />
          <StatusTile label="Passed Rows" value={matchedRows.toLocaleString()} status="Passed" />
          <StatusTile label="Invalid Rows" value={String(invalidRowCount)} status={invalidRowCount > 0 ? "Review" : "Clean"} />
          <StatusTile label="Quality Score" value={`${qualityScore}%`} status={invalidRowCount > 0 ? "Warn" : "Pass"} />
        </div>
      </div>
    </section>
  );
}

function QualityFailedRowsPanel({
  invalidRows,
  onAction,
  rule,
}: {
  invalidRows: TransformQualityInvalidRow[];
  onAction: RuleActionHandler;
  rule: QualityRule;
}) {
  const previewRows = invalidRows.slice(0, 12);
  const rowSummary = invalidRows.length === 0
    ? "No failed rows for selected check"
    : `${invalidRows.length} failed rows for ${rule.validationType} on ${rule.targetColumn}`;
  return (
    <section className="panel hegun-console-panel hegun-quality-failures-panel">
      <div className="panel-header">
        <Table2 size={18} />
        <h2>Failed Rows for Selected Check</h2>
        <span className="panel-note">{rowSummary}</span>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-quality-failed-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Column</th>
              <th>Sample Value</th>
              <th>Reason</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.length > 0 ? previewRows.map((row) => (
              <tr key={`${row.ruleId ?? rule.id}-${row.row}-${row.column}-${row.reason}`}>
                <td>{row.row}</td>
                <td>{row.column}</td>
                <td><code className="hegun-impact-value">{row.sampleValue || "(empty)"}</code></td>
                <td>{row.reason}</td>
                <td><span className="hegun-data-chip muted">{row.action}</span></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={5}>
                  <span className="hegun-empty-table-state">Selected check passed all sampled rows.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="hegun-rule-form-actions">
        <button className="secondary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_exported", "/api/etl/rules/quality/failed-rows/export")}>Export Rows</button>
        <button className="primary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_reviewed", "/api/etl/rules/quality/failed-rows/review")}>Mark Reviewed</button>
      </div>
    </section>
  );
}

function InvalidRowsPanel({
  invalidRows,
  invalidRowsPreviewSummary,
  onAction,
}: {
  invalidRows: TransformQualityInvalidRow[];
  invalidRowsPreviewSummary: string;
  onAction: RuleActionHandler;
}) {
  return (
    <section className="panel hegun-console-panel hegun-invalid-panel">
      <div className="panel-header">
        <Info size={18} />
        <h2>Invalid Data Rows</h2>
        <span className="panel-note">{invalidRowsPreviewSummary}</span>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Column</th>
              <th>Reason</th>
              <th>Action</th>
              <th>Sample Value</th>
            </tr>
          </thead>
          <tbody>
            {invalidRows.map((row) => (
              <tr key={`${row.row}-${row.column}`}>
                <td>{row.row}</td>
                <td>{row.column}</td>
                <td>{row.reason}</td>
                <td><span className="hegun-data-chip muted">{row.action}</span></td>
                <td><code className="hegun-impact-value">{row.sampleValue || "(empty)"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hegun-rule-form-actions">
        <button className="secondary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_exported", "/api/etl/rules/invalid-rows/export")}>Export Rows</button>
        <button className="primary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_reviewed", "/api/etl/rules/invalid-rows/review")}>Mark Reviewed</button>
      </div>
    </section>
  );
}

function RepeatSettings({
  customCron,
  frequency,
  minute,
  onCronChange,
  onCronCommit,
  onDayChange,
  onFrequencyChange,
  onMinuteChange,
  onRetryPolicyChange,
  onTimeCommit,
  onTimeChange,
  retryPolicy,
  selectedDay,
  time,
}: {
  customCron: string;
  frequency: RepeatFrequency;
  minute: string;
  onCronChange: (cron: string) => void;
  onCronCommit: () => void;
  onDayChange: (day: string) => void;
  onFrequencyChange: (frequency: RepeatFrequency) => void;
  onMinuteChange: (minute: string) => void;
  onRetryPolicyChange: (policy: RetryPolicyDraft) => void;
  onTimeCommit: () => void;
  onTimeChange: (time: string) => void;
  retryPolicy: RetryPolicyDraft;
  selectedDay: string;
  time: string;
}) {
  const cronIsValid = isValidCronExpression(customCron);
  const preview =
    frequency === "hourly"
      ? `매시간 ${minute}분에 실행됩니다. 다음 실행 예정: 2026.07.04 11:${minute}`
      : frequency === "daily"
        ? `매일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.05 ${time}`
        : frequency === "custom"
          ? `커스텀 cron(${customCron}) 규칙으로 실행됩니다. 저장 전에 표현식을 검증해야 합니다.`
          : `매주 ${selectedDay}요일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.09 ${time}`;

  return (
    <section className="panel">
      <div className="panel-header">
        <Repeat2 size={18} />
        <h2>반복 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>반복 주기</span>
          <select className="input control-input" value={frequency} onChange={(event) => onFrequencyChange(event.target.value as RepeatFrequency)}>
            {Object.entries(repeatFrequencyLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {frequency === "hourly" && (
          <label className="field">
            <span>실행 분</span>
            <select className="input control-input" value={minute} onChange={(event) => onMinuteChange(event.target.value)}>
              {["00", "15", "30", "45"].map((value) => (
                <option key={value} value={value}>{value}분</option>
              ))}
            </select>
          </label>
        )}
        {frequency === "daily" && (
          <label className="field">
            <span>실행 시간</span>
            <input className="input control-input" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
          </label>
        )}
        {frequency === "weekly" && (
          <div className="field wide">
            <span>실행 요일</span>
            <div className="weekday-group">
              {["월", "화", "수", "목", "금", "토", "일"].map((day) => (
                <button className={day === selectedDay ? "weekday active" : "weekday"} key={day} type="button" onClick={() => onDayChange(day)}>
                  {day}
                </button>
              ))}
            </div>
          </div>
        )}
        {frequency === "weekly" && (
          <label className="field">
            <span>실행 시간</span>
            <input className="input control-input" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
          </label>
        )}
        {frequency === "custom" && (
          <label className="field wide">
            <span>Cron 표현식</span>
            <input className="input control-input" inputMode="numeric" pattern="[0-9*,/\\-\\s]+" value={customCron} onBlur={onCronCommit} onChange={(event) => onCronChange(event.target.value)} onInput={(event) => onCronChange(event.currentTarget.value)} />
          </label>
        )}
        <Field label="시간대" value="(GMT+09:00) Seoul, Tokyo" />
        <Field label="시작 날짜" value="07/02/2026" icon={<Calendar size={16} />} />
        <Field label="종료 날짜" value="mm/dd/yyyy" icon={<Calendar size={16} />} muted />
      </div>
      <InfoBox title="실행 미리보기" body={preview} />
      {frequency === "custom" && !cronIsValid && <InfoBox title="Cron 형식 확인" body="5개 필드 형식만 저장합니다. 예: 0 10 * * 1-5" />}
      <label className="policy-check-row">
        <input type="checkbox" defaultChecked />
        <span>
          <strong>과거 데이터 소급 (Backfill)</strong>
          <small>파이프라인 생성 시점 이전의 누락된 구간 데이터를 자동으로 처리합니다.</small>
        </span>
      </label>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
    </section>
  );
}

function ManualSettings({ onRetryPolicyChange, retryPolicy }: { onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <PlayCircle size={18} />
        <h2>수동 실행 상세 설정</h2>
      </div>
      <InfoBox title="자동 스케줄 없음" body="이 파이프라인은 저장 후 사용자가 직접 실행할 때만 동작합니다. 테스트 실행이나 필요할 때만 데이터를 적재하는 작업에 적합합니다." />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <input type="checkbox" defaultChecked />
          <span>
            <strong>실패 시 재시도 활성화</strong>
            <small>수동 실행 중 오류가 발생하면 지정한 정책에 따라 자동 재시도합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
      <InfoBox title="자동 실행 예정 없음" body="저장 후 필요할 때 직접 실행할 수 있으며, 다음 실행 일시는 생성되지 않습니다." />
    </section>
  );
}

function OnceSettings({ dateTime, onDateTimeChange, onDateTimeCommit, onRetryPolicyChange, retryPolicy }: { dateTime: string; onDateTimeChange: (dateTime: string) => void; onDateTimeCommit: () => void; onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Clock3 size={18} />
        <h2>1회 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>실행 예정 일시</span>
          <input className="input control-input" min="2026-07-04T00:00" type="datetime-local" value={normalizeDateTimeLocal(dateTime)} onBlur={onDateTimeCommit} onChange={(event) => onDateTimeChange(event.target.value)} onInput={(event) => onDateTimeChange(event.currentTarget.value)} />
        </label>
        <Field label="시간대" value="Asia/Seoul (GMT+09:00)" icon={<Clock3 size={16} />} />
      </div>
      <InfoBox title="실행 미리보기" body={`${formatDateTimeLocalLabel(dateTime)}에 한 번 실행됩니다. 실행 완료 후 반복되지 않습니다.`} />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <input type="checkbox" defaultChecked />
          <span>
            <strong>실패 시 재시도</strong>
            <small>예약 실행 실패 시 재시도 정책을 적용합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
    </section>
  );
}

export function TargetPage({
  draft,
  onDraftChange,
  onPrev,
  onNext,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialTarget = getTargetDraftValues(draft);
  const [selectedLayer, setSelectedLayer] = useState<TargetLayer>(initialTarget.targetLayer);
  const [targetDataset, setTargetDataset] = useState(initialTarget.targetDataset);
  const [targetOwner, setTargetOwner] = useState(initialTarget.owner);
  const [targetDescription, setTargetDescription] = useState("고객 리뷰 분석용 정제 데이터셋");
  const [targetFormat, setTargetFormat] = useState(initialTarget.targetFormat);
  const [ragEnabled, setRagEnabled] = useState(initialTarget.rag);
  const applyTargetDraft = (patch: Partial<{
    owner: string;
    rag: boolean;
    targetDataset: string;
    targetFormat: string;
    targetLayer: TargetLayer;
  }> = {}) => {
    const nextTargetDataset = getDisplayText(patch.targetDataset ?? targetDataset, DEFAULT_TARGET_DATASET);
    const nextTargetFormat = getKnownOption(patch.targetFormat ?? targetFormat, TARGET_FORMAT_OPTIONS, DEFAULT_TARGET_FORMAT);
    const nextTargetLayer = normalizeTargetLayer(patch.targetLayer ?? selectedLayer);
    const nextOwner = getDisplayText(patch.owner ?? targetOwner, DEFAULT_OWNER);
    const nextRag = patch.rag ?? ragEnabled;

    onDraftChange({
      jobName: buildJobName(nextTargetDataset),
      owner: nextOwner,
      targetDataset: nextTargetDataset,
      targetFormat: nextTargetFormat,
      targetLayer: nextTargetLayer,
      rag: nextRag,
    });
  };
  const selectLayer = (layer: TargetLayer) => {
    setSelectedLayer(layer);
    applyTargetDraft({ targetLayer: layer });
  };
  const toggleRag = () => {
    const next = !ragEnabled;
    setRagEnabled(next);
    applyTargetDraft({ rag: next });
  };
  const goNext = () => {
    applyTargetDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="target" title="생성 요약" onPrev={onPrev} onNext={goNext} onSave={() => {
        applyTargetDraft();
        onSave();
      }} />}
    >
        <PageTitle title="타겟 설정" description="가공된 데이터가 저장될 위치와 포맷, RAG 인덱싱 여부를 설정합니다." />
        <section className="panel">
          <div className="panel-header">
            <HardDrive size={18} />
            <h2>기본 저장소 설정</h2>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>타겟 데이터셋 이름</span>
              <input className="input control-input" value={targetDataset} onChange={(event) => {
                const nextTargetDataset = event.target.value;
                setTargetDataset(nextTargetDataset);
                applyTargetDraft({ targetDataset: nextTargetDataset });
              }} />
            </label>
            <label className="field">
              <span>소유자</span>
              <input className="input control-input" value={targetOwner} onChange={(event) => {
                const nextOwner = event.target.value;
                setTargetOwner(nextOwner);
                applyTargetDraft({ owner: nextOwner });
              }} />
            </label>
            <label className="field wide">
              <span>설명</span>
              <input className="input control-input" value={targetDescription} onChange={(event) => setTargetDescription(event.target.value)} />
            </label>
          </div>
          <div className="tag-row">
            {[targetDataset.replace(/_gold$/, ""), "sentiment_analysis", ragEnabled ? "rag_ready" : "rag_disabled"].map((tag) => (
              <span className="tag" key={tag}>{tag}</span>
            ))}
            <button className="ghost-link" type="button" onClick={() => onDraftChange({ rag: ragEnabled })}>+ 추가</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>저장소 및 포맷 설정</h2>
          </div>
          <div className="format-grid">
            {TARGET_LAYER_OPTIONS.map((layer) => (
              <button className={layer === selectedLayer ? "format-card active" : "format-card"} key={layer} type="button" onClick={() => selectLayer(layer)}>
                {layer}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <Field label="저장소 유형" value="S3" />
            <label className="field">
              <span>파일 포맷</span>
              <select className="input control-input" value={targetFormat} onChange={(event) => {
                const nextTargetFormat = getKnownOption(event.target.value, TARGET_FORMAT_OPTIONS, DEFAULT_TARGET_FORMAT);
                setTargetFormat(nextTargetFormat);
                applyTargetDraft({ targetFormat: nextTargetFormat });
              }}>
                {TARGET_FORMAT_OPTIONS.map((format) => <option key={format}>{format}</option>)}
              </select>
            </label>
            <Field label="파티션" value="year/month/region" />
            <Field label="압축" value="Snappy" />
            <Field label="저장 경로" value={`s3a://asklake-output/${targetDataset}/${selectedLayer.toLowerCase()}/`} wide />
          </div>
          <div className="target-status-grid">
            <StatusTile label="카탈로그 등록" value="생성 후 자동 등록" status="Ready" />
            <StatusTile label="경로 검증" value="쓰기 권한 확인 완료" status="Valid" />
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <Search size={18} />
            <h2>RAG 설정</h2>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>RAG 인덱싱</span>
              <button className={ragEnabled ? "input control-toggle active" : "input control-toggle"} type="button" onClick={toggleRag}>
                {ragEnabled ? "활성화" : "비활성화"}
              </button>
            </label>
            <Field label="임베딩 모델" value="text-embedding-3-small" />
            <Field label="청킹 전략" value="Recursive Character" />
            <Field label="청크 크기" value="1,000 Tokens" />
            <Field label="오버랩" value="200 Tokens" />
            <Field label="인덱스 생성 예정" value="파이프라인 생성 후 자동 큐잉" />
          </div>
        </section>
    </CreationFlowLayout>
  );
}

export function PermissionPage({
  draft,
  onDraftChange,
  onNext,
  onPrev,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const initialPermission = getPermissionDraftValues(draft);
  const [permissionTemplate, setPermissionTemplate] = useState(initialPermission.permissionTemplate);
  const [visibility, setVisibility] = useState(initialPermission.visibility);
  const [dataOwner, setDataOwner] = useState(initialPermission.owner);
  const [approvalStatus, setApprovalStatus] = useState(initialPermission.approvalStatus);
  const [roleChecks, setRoleChecks] = useState<Record<string, boolean>>(() => ({
    ...Object.fromEntries(PERMISSION_ROLES.map((role) => [role.name, role.checked])),
    [initialPermission.permissionTemplate]: true,
  }));

  const applyPermissionDraft = (patch: Partial<{
    approvalStatus: string;
    owner: string;
    permissionTemplate: string;
    visibility: string;
  }> = {}) => {
    const nextPermissionTemplate = getKnownOption(patch.permissionTemplate ?? permissionTemplate, PERMISSION_TEMPLATES, DEFAULT_PERMISSION_TEMPLATE);
    const nextVisibility = getKnownOption(patch.visibility ?? visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);
    const nextApprovalStatus = getKnownOption(patch.approvalStatus ?? approvalStatus, APPROVAL_STATUS_OPTIONS, DEFAULT_APPROVAL_STATUS);
    const nextOwner = getDisplayText(patch.owner ?? dataOwner, DEFAULT_OWNER);

    onDraftChange({
      owner: nextOwner,
      permissionSummary: buildPermissionSummary(nextPermissionTemplate, nextVisibility, nextApprovalStatus),
    });
  };
  const goNext = () => {
    applyPermissionDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      variant="permission"
      side={(
        <CreationValidationPanel
          className="permission-aside"
          title="거버넌스 체크"
          actions={<CreationPanelActions withDivider onPrev={onPrev} onSave={() => {
            applyPermissionDraft();
            onSave();
          }} onNext={goNext} />}
        >
          <StatusTile label="공유 범위" value={visibility} status={visibility === "외부 공유" ? "Review" : "Safe"} />
          <StatusTile label="민감 데이터" value="review_text 포함" status="Review" />
          <StatusTile label="승인자" value={dataOwner} status={approvalStatus === "승인 완료" ? "Ready" : "Pending"} />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="권한 설정" description="생성할 데이터셋에 접근할 수 있는 역할과 사용자를 선택하세요." icon={<ShieldCheck size={24} />} />
        <section className="panel permission-share-panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>공유 대상</h2>
          </div>
          <InfoBox title="추천 권한 템플릿" body="유사 데이터셋의 접근 권한과 조직 정책을 기반으로 추천되었습니다." />
          <div className="form-grid">
            <label className="field">
              <span>권한 템플릿</span>
              <select className="input control-input" value={permissionTemplate} onChange={(event) => {
                const nextPermissionTemplate = getKnownOption(event.target.value, PERMISSION_TEMPLATES, DEFAULT_PERMISSION_TEMPLATE);
                setPermissionTemplate(nextPermissionTemplate);
                setRoleChecks((checks) => ({ ...checks, [nextPermissionTemplate]: true }));
                applyPermissionDraft({ permissionTemplate: nextPermissionTemplate });
              }}>
                {PERMISSION_TEMPLATES.map((template) => <option key={template}>{template}</option>)}
              </select>
            </label>
            <label className="field">
              <span>공개 범위</span>
              <select className="input control-input" value={visibility} onChange={(event) => {
                const nextVisibility = getKnownOption(event.target.value, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);
                setVisibility(nextVisibility);
                applyPermissionDraft({ visibility: nextVisibility });
              }}>
                {VISIBILITY_OPTIONS.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="field">
              <span>데이터 오너</span>
              <input className="input control-input" value={dataOwner} onChange={(event) => {
                const nextOwner = event.target.value;
                setDataOwner(nextOwner);
                applyPermissionDraft({ owner: nextOwner });
              }} />
            </label>
            <label className="field">
              <span>승인 상태</span>
              <select className="input control-input" value={approvalStatus} onChange={(event) => {
                const nextApprovalStatus = getKnownOption(event.target.value, APPROVAL_STATUS_OPTIONS, DEFAULT_APPROVAL_STATUS);
                setApprovalStatus(nextApprovalStatus);
                applyPermissionDraft({ approvalStatus: nextApprovalStatus });
              }}>
                {APPROVAL_STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
          </div>
        </section>
        <section className="panel">
          <h2 className="panel-title">세부 권한</h2>
          <div className="permission-list">
            {PERMISSION_ROLES.map((role) => (
              <label className={role.name === permissionTemplate ? "permission-row detailed active" : "permission-row detailed"} key={role.name}>
                <input type="checkbox" checked={roleChecks[role.name]} onChange={(event) => setRoleChecks((checks) => ({ ...checks, [role.name]: event.target.checked }))} />
                <span>
                  <strong>{role.name}</strong>
                  <small>{role.note}</small>
                </span>
                <div className="permission-chip-row">
                  {PERMISSION_ACCESS_ITEMS.map((item) => (
                    <em className={roleChecks[role.name] && role.access.includes(item) ? "allowed" : ""} key={item}>{item}</em>
                  ))}
                </div>
              </label>
            ))}
          </div>
          <InfoBox title="권한 검토 필요" body="외부 공유 또는 민감 데이터 접근 권한은 데이터 오너 승인 후 적용됩니다." />
        </section>
    </CreationFlowLayout>
  );
}

export function ReviewPage({ draft, onCreate, onEdit, onSave }: { draft: DraftPipeline; onCreate: () => void; onEdit: (flow: FlowId) => void; onSave: () => void }) {
  const request = toCreatePipelineRequest(draft);
  const scheduleEditFlow = getScheduleFlowFromLabel(request.scheduleLabel);
  const permissionReview = getPermissionDraftValues(draft);
  const targetReview = getTargetDraftValues(draft);
  const ragReviewLabel = targetReview.rag ? "RAG 활성화" : "RAG 비활성화";
  const schemaRows = [
    ["review_id", "BIGINT", "NO", "SOURCE.id"],
    ["product_id", "STRING", "NO", "SOURCE.p_code"],
    ["rating", "INT", "YES", "CAST(SOURCE.score AS INT)"],
    ["review_title", "STRING", "YES", "TRIM(SOURCE.title)"],
    ["review_text", "STRING", "YES", "REGEXP_REPLACE(SOURCE.content, \"[\\n\\r]\", \" \")"],
    ["created_at", "TIMESTAMP", "NO", "CURRENT_TIMESTAMP()"],
  ];
  const sourceSummary = request.sourceConfig.slice(0, 3).map(([label, value]) => `${label}: ${value}`).join(" · ");
  const scheduleEditFlow = getScheduleFlowFromLabel(request.scheduleLabel);

  return (
    <CreationFlowLayout
      variant="review"
      side={(
        <CreationValidationPanel
          title="최종 유효성 검사"
          actions={<CreationPanelActions withDivider nextLabel="파이프라인 생성" onPrev={() => onEdit("target")} onSave={onSave} onNext={onCreate} />}
        >
          {["소스 연결 완료", "처리 테스트 통과", "스케줄 유효함", "실패 처리 정책 유효함", "권한 선택됨", "타겟 설정 유효함"].map((item) => (
            <div className="validation-row" key={item}>
              <Check size={16} />
              <span>{item}</span>
              <strong>유효함</strong>
            </div>
          ))}
          <InfoBox title="안내사항" body="파이프라인 생성 후 데이터 카탈로그에서 즉시 조회 및 SQL 쿼리를 수행할 수 있습니다." />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="검토 및 생성" description="설정된 모든 구성을 확인하고 데이터 파이프라인 생성을 완료하세요." />
        <div className="review-card-grid">
          {[
            ["기본 정보", `${targetReview.targetDataset} · ${targetReview.owner}`, "target"],
            ["소스", `${request.sourceType} · ${sourceSummary || request.sourceLabel}`, "source"],
            ["스키마", request.schemaSummary, "schema"],
            ["처리 규칙", request.ruleSummary, "rules"],
            ["스케줄", request.scheduleLabel, scheduleEditFlow],
            ["권한", `${permissionReview.permissionSummary} · ${permissionReview.owner}`, "permission"],
            ["타겟 저장소", `${targetReview.targetLayer} / ${targetReview.targetFormat} · ${ragReviewLabel}`, "target"],
          ].map(([label, value, flow]) => (
            <article className="review-mini-card" key={label}>
              <span className="review-card-icon">{flow === "permission" ? <ShieldCheck size={14} /> : flow === "repeat" ? <Calendar size={14} /> : flow === "rules" || flow === "schema" ? <SlidersHorizontal size={14} /> : <Database size={14} />}</span>
              <strong>{label}</strong>
              <span>{value}</span>
              <button type="button" onClick={() => onEdit(flow as FlowId)}>수정</button>
            </article>
          ))}
        </div>
        <section className="panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>권한 draft 상세</h2>
            <span className="panel-note">Review 카드 반영값</span>
          </div>
          <div className="form-grid">
            <Field label="권한 템플릿" value={permissionReview.permissionTemplate} />
            <Field label="공개 범위" value={permissionReview.visibility} />
            <Field label="승인 상태" value={permissionReview.approvalStatus} />
            <Field label="데이터 오너" value={permissionReview.owner} />
            <Field label="권한 요약" value={permissionReview.permissionSummary} wide />
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <HardDrive size={18} />
            <h2>타겟 draft 상세</h2>
            <span className="panel-note">Review 카드 반영값</span>
          </div>
          <div className="form-grid">
            <Field label="생성될 Job 이름" value={buildJobName(targetReview.targetDataset)} />
            <Field label="타겟 데이터셋" value={targetReview.targetDataset} />
            <Field label="타겟 Layer" value={targetReview.targetLayer} />
            <Field label="타겟 Format" value={targetReview.targetFormat} />
            <Field label="RAG 인덱싱" value={ragReviewLabel} />
            <Field label="데이터 오너" value={targetReview.owner} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>출력 스키마 미리보기</h2>
            <span className="panel-note">{request.schemaSummary}</span>
          </div>
          <table className="schema-table">
            <thead>
              <tr>
                <th>컬럼명</th>
                <th>타입</th>
                <th>Null 허용</th>
                <th>변환식</th>
              </tr>
            </thead>
            <tbody>
              {schemaRows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
    </CreationFlowLayout>
  );
}
