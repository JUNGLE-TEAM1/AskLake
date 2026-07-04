import { useState } from "react";
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
import { Field, InfoBox, PageTitle, RetryPolicy, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationPanelActions, CreationSummaryPanel, CreationValidationPanel } from "../../components/creation/CreationFlow";
import { toCreatePipelineRequest } from "../../services/draftPipelineContract";
import { testSourceConnector, type SourceConnectorAnalysis } from "../../services/sourceConnectorService";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, FlowId, RetryPolicyDraft, ScheduleFlowId, SchemaColumnDraft, SourceDraft, TargetLayer } from "../../types";

type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};

export function SchedulePage({
  draftRetryPolicy,
  draftScheduleLabel,
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
  onSave,
}: {
  draftRetryPolicy: RetryPolicyDraft;
  draftScheduleLabel: string;
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialRepeat = parseRepeatScheduleLabel(draftScheduleLabel);
  const [repeatFrequency, setRepeatFrequency] = useState<RepeatFrequency>(initialRepeat.frequency);
  const [repeatDay, setRepeatDay] = useState(initialRepeat.day);
  const [repeatTime, setRepeatTime] = useState(initialRepeat.time);
  const [repeatMinute, setRepeatMinute] = useState(initialRepeat.minute);
  const [customCron, setCustomCron] = useState(initialRepeat.cron);
  const [onceDateTime, setOnceDateTime] = useState(parseOnceScheduleLabel(draftScheduleLabel));
  const title = "스케줄링 설정";
  const selected = mode === "repeat" ? "반복 실행" : mode === "manual" ? "수동 실행" : "1회 실행";
  const repeatDraft = { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime };
  const scheduleLabel = formatScheduleLabel(mode, repeatDraft, onceDateTime);
  const updateRetryPolicy = (retryPolicy: RetryPolicyDraft) => {
    onDraftChange({ schedule: { retryPolicy } });
  };
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

function mergeFieldRows(baseFields: Array<[string, string]>, savedFields: Array<[string, string]>): Array<[string, string]> {
  const savedByLabel = new Map(savedFields);
  const mergedFields = baseFields.map(([label, value]) => [label, savedByLabel.get(label) ?? value] as [string, string]);
  const baseLabels = new Set(baseFields.map(([label]) => label));
  const extraSavedFields = savedFields.filter(([label]) => !baseLabels.has(label));
  return [...mergedFields, ...extraSavedFields];
}

const DEFAULT_REPEAT_DAY = "목";
const DEFAULT_REPEAT_TIME = "10:30";
const DEFAULT_REPEAT_MINUTE = "00";
const DEFAULT_CUSTOM_CRON = "0 10 * * 1-5";
const DEFAULT_ONCE_DATE_TIME = "2026-07-05T10:00";
const validRepeatMinutes = ["00", "15", "30", "45"];
const validRepeatDays = ["월", "화", "수", "목", "금", "토", "일"];
const repeatFrequencyLabels: Record<RepeatFrequency, string> = {
  hourly: "매시간",
  daily: "매일",
  weekly: "매주",
  custom: "커스텀",
};

function formatScheduleLabel(mode: ScheduleFlowId, repeat: RepeatScheduleDraft, onceDateTime: string) {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  if (mode === "manual") return "수동 실행";
  if (mode === "once") return `${formatDateTimeLocalLabel(onceDateTime)} 1회 실행`;
  if (normalizedRepeat.frequency === "hourly") return `매시간 ${normalizedRepeat.minute}분`;
  if (normalizedRepeat.frequency === "daily") return `매일 ${normalizedRepeat.time}`;
  if (normalizedRepeat.frequency === "custom") return `커스텀: ${normalizedRepeat.cron}`;
  return `매주 ${normalizedRepeat.day}요일 ${normalizedRepeat.time}`;
}

function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("수동")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}

function parseOnceScheduleLabel(label: string) {
  if (!label.includes("1회")) return DEFAULT_ONCE_DATE_TIME;
  return normalizeDateTimeLocal(label.replace(/\s*1회 실행\s*$/, "").trim());
}

function parseRepeatScheduleLabel(label: string) {
  const weeklyMatch = label.match(/매주\s+(.+?)요일\s+(.+)$/);
  const dailyMatch = label.match(/매일\s+(.+)$/);
  const hourlyMatch = label.match(/매시간\s+(.+?)분$/);
  const customMatch = label.match(/^커스텀:\s*(.+)$/);
  const frequency: RepeatFrequency = customMatch ? "custom" : hourlyMatch ? "hourly" : dailyMatch ? "daily" : "weekly";

  return {
    cron: customMatch?.[1] ?? DEFAULT_CUSTOM_CRON,
    day: weeklyMatch?.[1] ?? DEFAULT_REPEAT_DAY,
    frequency,
    minute: hourlyMatch?.[1] ?? DEFAULT_REPEAT_MINUTE,
    time: weeklyMatch?.[2] ?? dailyMatch?.[1] ?? DEFAULT_REPEAT_TIME,
  };
}

function normalizeRepeatScheduleDraft(repeat: RepeatScheduleDraft): RepeatScheduleDraft {
  return {
    cron: normalizeCronExpression(repeat.cron),
    day: validRepeatDays.includes(repeat.day) ? repeat.day : DEFAULT_REPEAT_DAY,
    frequency: repeat.frequency,
    minute: validRepeatMinutes.includes(repeat.minute) ? repeat.minute : DEFAULT_REPEAT_MINUTE,
    time: normalizeTimeValue(repeat.time),
  };
}

function normalizeTimeValue(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : DEFAULT_REPEAT_TIME;
}

function normalizeDateTimeLocal(value: string) {
  const normalizedValue = value.replace(".", "-").replace(".", "-").replace(" ", "T");
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(normalizedValue) ? normalizedValue : DEFAULT_ONCE_DATE_TIME;
}

function formatDateTimeLocalLabel(value: string) {
  return normalizeDateTimeLocal(value).replace("T", " ").replaceAll("-", ".");
}

function sanitizeCronInput(value: string) {
  return value.replace(/[^\d*,/\-\s]/g, "").replace(/\s+/g, " ").slice(0, 64);
}

function isValidCronExpression(value: string) {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\d*,/\-]+$/.test(field));
}

function normalizeCronExpression(value: string) {
  const sanitized = sanitizeCronInput(value).trim();
  return isValidCronExpression(sanitized) ? sanitized : DEFAULT_CUSTOM_CRON;
}

export function SourceConnectionPage({
  draft,
  onAction,
  onDraftChange,
  onNotify,
  onPrev,
  onNext,
  onSave,
}: {
  draft: DraftPipeline;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [sourceType, setSourceType] = useState(draft.source.sourceType || "File / S3");
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const [connectionStatus, setConnectionStatus] = useState<SourceDraft["connectionStatus"]>(draft.source.connectionStatus);
  const [connectionMessage, setConnectionMessage] = useState(draft.source.connectionMessage ?? "Connection test is required before review.");
  const [sourceRuntime, setSourceRuntime] = useState<SourceConnectorAnalysis | null>(null);
  const connectorMeta: Record<string, { desc: string; status: string }> = {
    Database: { desc: "Postgres, MySQL, Oracle", status: "backend" },
    "File / S3": { desc: "MinIO / S3-compatible object storage", status: "MinIO" },
    "Data Lake": { desc: "Delta Lake, Iceberg, Hudi", status: "backend" },
    "REST API": { desc: "REST, GraphQL, Webhooks", status: "fetch" },
    "Stream / Kafka": { desc: "Real-time message brokers", status: "backend" },
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
      description: "백엔드 connector runner를 통해 PostgreSQL 메타데이터와 샘플 행을 조회합니다.",
      fields: [
        ["Endpoint / Host", "localhost"],
        ["Port", "5432"],
        ["Database Name", "asklake"],
        ["Schema", "public"],
        ["Username", "asklake"],
        ["Password / Auth Token", ""],
      ],
      testItems: [["Endpoint", "Not tested"], ["Backend connector", "Required"], ["Tables", "Pending"]],
      logs: ["[M3:L0] PostgreSQL source identity requires backend connector runner.", "[M3:L1] Browser does not open raw database sockets."],
      assetsTitle: "Detected Tables",
      assets: [],
      previewTitle: "Raw Source Preview",
      previewNote: "No preview data available · Run backend connection test to fetch sample rows.",
      previewColumns: ["Table", "Rows", "Status"],
      previewRows: [],
      info: "PostgreSQL/Kafka credentials must be verified by the backend connector runner, not by the browser.",
    },
    "File / S3": {
      title: "MinIO Source Configuration",
      description: "MinIO/S3-compatible object storage에서 bucket, prefix, bounded sample을 실제 조회합니다.",
      fields: [
        ["Storage Provider", "MinIO"],
        ["Endpoint URL", "http://127.0.0.1:9000"],
        ["Region", "us-east-1"],
        ["Bucket / Stage Name", "m3-raw"],
        ["Path / Prefix", "nyc_taxi/csv/"],
        ["Access Key", "m3admin"],
        ["Secret Key", "wishuponastar"],
        ["Use Path Style", "true"],
        ["File Type", "CSV (Comma Separated)"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Bucket", "Not listed"], ["M3 L0-L3", "Pending"]],
      logs: ["[M3:L0] MinIO source identity is not verified yet.", "[M3:L1] Run Test Connection to fetch a bounded sample."],
      assetsTitle: "Detected MinIO Objects",
      assets: [],
      previewTitle: "Bounded Source Preview",
      previewNote: "No preview data available · Run Test Connection against MinIO.",
      previewColumns: ["Object Key", "Size", "Last Modified"],
      previewRows: [],
      actions: ["Refresh Preview"],
    },
    "Data Lake": {
      title: "Data Lake Source",
      description: "백엔드 connector runner가 Delta/Iceberg/Hudi 메타데이터를 조회해야 합니다.",
      fields: [
        ["Lake Type", "Delta Lake (Databricks)"],
        ["CATALOG / NAMESPACE", "local_catalog"],
        ["DATABASE / SCHEMA", "default"],
        ["Path", "s3://m3-raw/"],
        ["Read Mode", "Latest Version (Snapshot Isolation)"],
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Lake Access", "Not tested"], ["Metadata", "Pending"], ["Backend connector", "Required"]],
      logs: ["[M3:L0] Data Lake source identity requires backend connector runner.", "[M3:L2] Table profile is pending until connector returns metadata."],
      assetsTitle: "Detected Lake Objects",
      assets: [],
      previewTitle: "Lake Table Preview",
      previewNote: "No preview data available · Run backend connection test.",
      previewColumns: ["Event Timestamp", "User ID", "Transaction ID", "Region", "Action Type", "Latency"],
      previewRows: [],
      actions: ["Fetch Metadata", "Download CSV", "Full Screen"],
    },
    "REST API": {
      title: "REST API Source",
      description: "Configure your REST endpoint to ingest remote data.",
      fields: [
        ["Method", "GET"],
        ["Endpoint URL", ""],
        ["Authentication Type", "None"],
        ["Token / Secret", ""],
        ["Accept", "application/json"],
        ["X-Request-ID", "etl-9928-ax"],
        ["limit", "50"],
        ["status", "active"],
        ["Pagination Strategy", "Page Number"],
        ["Root Path", "$.data.items"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Auth", "Pending"], ["Response", "Pending"]],
      logs: ["[M3:L0] REST source identity is not verified yet.", "[M3:L1] Browser fetch can test CORS-enabled REST endpoints."],
      assetsTitle: "Detected Fields",
      assets: [],
      previewTitle: "API Response Preview",
      previewNote: "No preview data available · Run Test Connection.",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [],
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
      testItems: [["Broker Reachable", "Not tested"], ["Topic Access", "Pending"], ["Backend connector", "Required"]],
      logs: ["[M3:L0] Kafka source window identity requires backend connector runner.", "[M3:L2] Browser cannot perform Kafka protocol handshakes."],
      assetsTitle: "Detected Metadata",
      assets: [],
      previewTitle: "Sample Messages Preview",
      previewNote: "No preview data available · Run backend connection test.",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [],
      actions: ["Show Advanced Configuration"],
    },
  };
  const activeSourceType = sourceConfigs[sourceType] ? sourceType : "File / S3";
  const current = sourceConfigs[activeSourceType];
  const editableFields = sourceFields[activeSourceType] ?? (
    draft.source.sourceType === activeSourceType && draft.source.sourceConfig.length > 0
      ? mergeFieldRows(current.fields, draft.source.sourceConfig)
      : current.fields
  );
  const sourceLabel = editableFields.find(([label]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? activeSourceType;
  const connectionStatusCopy: Record<SourceDraft["connectionStatus"], { badge: string; title: string }> = {
    failed: { badge: "Check failed", title: "Connection failed" },
    idle: { badge: "Test required", title: "Connection test pending" },
    success: { badge: "Ready for preview", title: "Connection verified" },
    testing: { badge: "Testing", title: "Connection test running" },
  };
  const displayTestItems = sourceRuntime?.testItems ?? current.testItems;
  const displayAssets = sourceRuntime?.assets ?? current.assets;
  const displayLogs = sourceRuntime?.logs ?? current.logs;
  const displayPreviewColumns = sourceRuntime?.previewColumns ?? current.previewColumns;
  const displayPreviewRows = sourceRuntime?.previewRows ?? current.previewRows;
  const displayPreviewNote = sourceRuntime?.previewNote ?? current.previewNote;
  const runtimeSourceConfig = sourceRuntime?.draftPatch.source?.sourceConfig;
  const verifiedSourceFields = connectionStatus === "success" && runtimeSourceConfig ? runtimeSourceConfig : editableFields;
  const sourceSummaryRows: Array<[string, string]> = [
    ["선택 커넥터", activeSourceType],
    ["연결 상태", connectionStatus === "success" ? connectionMessage : connectionStatus === "testing" ? "테스트 중" : connectionStatus === "failed" ? "실패" : "테스트 필요"],
    ["감지 파일", `${displayAssets.length}개`],
    ["인증 방식", activeSourceType === "File / S3" ? "MinIO/S3 access key" : activeSourceType === "REST API" ? "Browser fetch" : "Backend connector 필요"],
    ["다음 단계", "스키마 추론"],
  ];

  const applySourceDraft = (
    nextType = activeSourceType,
    nextFields = verifiedSourceFields,
    nextStatus = connectionStatus,
    nextMessage = connectionMessage,
  ) => {
    const label = sourceLabelFromFields(nextType, nextFields);
    onDraftChange({
      source: {
        connectionMessage: nextMessage,
        connectionStatus: nextStatus,
        sourceConfig: nextFields,
        sourceLabel: label,
        sourceType: nextType,
      },
    });
  };

  const selectSource = (value: string) => {
    const nextMessage = `${value} settings selected. Run a connection test before review.`;
    setSourceType(value);
    setSourceRuntime(null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    applySourceDraft(value, sourceFields[value] ?? sourceConfigs[value].fields, "idle", nextMessage);
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    const nextMessage = "Source configuration changed. Run the connection test again.";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime(null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    applySourceDraft(activeSourceType, nextFields, "idle", nextMessage);
  };

  const testConnection = async () => {
    const testingMessage = `${activeSourceType} connector test running.`;
    setConnectionStatus("testing");
    setConnectionMessage(testingMessage);
    applySourceDraft(activeSourceType, editableFields, "testing", testingMessage);
    try {
      const result = await testSourceConnector(activeSourceType, editableFields);
      if (result.draftPatch.source?.sourceConfig) {
        setSourceFields((fields) => ({ ...fields, [activeSourceType]: result.draftPatch.source?.sourceConfig ?? editableFields }));
      }
      setSourceRuntime(result);
      setConnectionStatus(result.status);
      setConnectionMessage(result.message);
      onDraftChange(result.draftPatch);
      onAction("etl.source.connection_tested", result.actionPath, activeSourceType);
      onNotify(result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Source connector test failed.";
      setSourceRuntime({
        actionPath: "/api/etl/sources/test",
        assets: [],
        draftPatch: {},
        logs: [`[ERROR] ${message}`],
        message,
        previewColumns: ["Status", "Reason"],
        previewNote: "Connection test failed. No sample was fetched.",
        previewRows: [["failed", message]],
        status: "failed",
        testItems: [["Connector", activeSourceType], ["Result", "Failed"]],
      });
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, editableFields, "failed", message);
      onAction("etl.source.connection_failed", "/api/etl/sources/test", activeSourceType, "failed");
      onNotify(message);
    }
  };

  const fetchMetadata = () => {
    onAction("etl.source.metadata_fetched", "/api/etl/sources/metadata", activeSourceType);
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="source" title="소스 요약" selected={`${activeSourceType} · ${sourceLabel}`} summaryRows={sourceSummaryRows} onPrev={onPrev} onNext={() => {
        if (connectionStatus !== "success") {
          onNotify("먼저 Source 연결 테스트를 성공시켜야 Schema 단계로 넘어갈 수 있습니다.");
          return;
        }
        applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
        onNext();
      }} onSave={() => {
        applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
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
              <button className={activeSourceType === connector ? "hegun-connector active" : "hegun-connector"} key={connector} type="button" onClick={() => selectSource(connector)}>
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
              <label className={value.length > 38 ? "field wide" : "field"} key={`${activeSourceType}-${label}`}>
                <span>{label}</span>
                <input className="input control-input" value={value} onChange={(event) => updateSourceField(label, event.target.value)} />
              </label>
            ))}
          </div>
          {current.info && <InfoBox title="Secure Connection" body={current.info} />}
          <div className="form-actions inline">
            {current.actions?.includes("Show Advanced Configuration") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.advanced_opened", "/api/etl/sources/advanced", activeSourceType)}>Show Advanced Configuration</button>}
            {current.actions?.includes("Fetch Metadata") && <button className="secondary-button" type="button" onClick={fetchMetadata}>Fetch Metadata</button>}
            <button className="secondary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>Test Connection</button>
          </div>
        </section>
        <div className="hegun-source-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Connectivity Test</h2>
              <span className="panel-note">{displayTestItems.map(([label]) => label).join(" · ")}</span>
            </div>
            <div className="hegun-test-summary">
              <div>
                <strong>{connectionStatusCopy[connectionStatus].title}</strong>
                <span>{connectionMessage || `${current.testItems.length} checks configured for ${activeSourceType}`}</span>
              </div>
              <em>{connectionStatusCopy[connectionStatus].badge}</em>
            </div>
            <div className="hegun-test-strip">
              {displayTestItems.map(([label, value], index) => (
                <span key={`${activeSourceType}-${label}-${index}`}>
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
                {displayLogs.map((log, index) => <span key={`${activeSourceType}-log-${index}`}>{log}</span>)}
              </div>
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <LayoutGrid size={18} />
              <h2>{current.assetsTitle}</h2>
              <span className="panel-note">{displayAssets.length} Total</span>
            </div>
            <div className="hegun-asset-list">
              {displayAssets.map(([name, meta, status], index) => (
                <article key={`${activeSourceType}-${name}-${index}`}>
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
            <span className="panel-note">{displayPreviewNote}</span>
          </div>
          <div className="hegun-preview-actions">
            {current.actions?.includes("Refresh Preview") && <button className="secondary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>Refresh Preview</button>}
            {current.actions?.includes("Download CSV") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_downloaded", "/api/etl/sources/preview/download", activeSourceType)}>Download CSV</button>}
            {current.actions?.includes("Full Screen") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_fullscreen_opened", "/api/etl/sources/preview/fullscreen", activeSourceType)}>Full Screen</button>}
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead><tr>{displayPreviewColumns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>
                {displayPreviewRows.map((row, rowIndex) => <tr key={`${activeSourceType}-preview-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}
                {displayPreviewRows.length === 0 && <tr><td colSpan={Math.max(displayPreviewColumns.length, 1)}>연결 테스트 후 MinIO sample preview가 표시됩니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>연결 테스트</button>
        </div>
    </CreationFlowLayout>
  );
}

export function SchemaInferencePage({
  draft,
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const hasInferredSchema = draft.schema.columns.length > 0;
  const schemaRows = draft.schema.columns.map((column, index) => [
    `#${index + 1}`,
    column.sourceName,
    column.targetName,
    column.type,
    column.nullable ? "YES" : "NO",
    column.role ?? "-",
    `${column.confidence ?? 70}%`,
    draft.schema.sampleRows.map((row) => row[index]).filter(Boolean).slice(0, 3).join(", ") || "-",
  ]);
  const metadata = [
    ["Data Source", draft.source.sourceLabel || "-"],
    ["Rows Sampled", String(draft.schema.sampleRows.length)],
    ["Status", hasInferredSchema ? draft.schema.summary : "Source sample not profiled"],
    ["Parser", draft.source.sourceType === "File / S3" ? "MinIO bounded sample · M3 L0-L3" : `${draft.source.sourceType} bounded sample`],
  ];
  const schemaColumns: SchemaColumnDraft[] = draft.schema.columns;
  const lowConfidenceCount = schemaColumns.filter((column) => (column.confidence ?? 100) < 80).length;
  const averageConfidence = schemaColumns.length
    ? Math.round(schemaColumns.reduce((sum, column) => sum + (column.confidence ?? 70), 0) / schemaColumns.length)
    : 0;
  const inferredSummary = hasInferredSchema ? draft.schema.summary : "Source connection required before schema inference";
  const approvedSummary = `${schemaColumns.length} fields approved · ${lowConfidenceCount} need review · M3 L2 profile`;
  const schemaSampleRows = draft.schema.sampleRows;
  const schemaFingerprint = draft.schema.schemaFingerprint ?? schemaColumns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|");
  const schemaSummaryRows: Array<[string, string]> = [
    ["샘플 Row", String(schemaSampleRows.length)],
    ["추론 필드", `${schemaColumns.length}개`],
    ["평균 Confidence", schemaColumns.length ? `${averageConfidence}%` : "-"],
    ["검토 필요", schemaColumns.length ? `${lowConfidenceCount}개 필드` : "-"],
    ["다음 단계", "룰 적용"],
  ];

  const applySchemaDraft = (summary: string) => {
    if (!hasInferredSchema) return false;
    onDraftChange({
      schema: {
        columns: schemaColumns,
        sampleRows: schemaSampleRows,
        schemaFingerprint,
        summary,
      },
    });
    return true;
  };

  const runInference = () => {
    if (!hasInferredSchema) {
      onAction("etl.schema.inference_blocked", "/api/etl/schema-inference", draft.source.sourceLabel || "source", "failed");
      onNotify("먼저 Source Connection에서 MinIO/Source 연결 테스트를 성공시켜야 합니다.");
      return;
    }
    onAction("etl.schema.inferred", "/api/etl/schema-inference", draft.source.sourceLabel);
    applySchemaDraft(inferredSummary);
    onNotify("Source bounded sample 기준 스키마 프로파일을 확인했습니다.");
  };

  const schemaAction = (action: string, path: string, schemaSummary?: string) => {
    onAction(action, path, draft.source.sourceLabel || "source");
    if (schemaSummary) {
      applySchemaDraft(schemaSummary);
    }
  };

  const approveSchema = () => {
    if (!hasInferredSchema) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("확정할 스키마가 없습니다. Source 연결 테스트를 먼저 실행하세요.");
      return false;
    }
    schemaAction("etl.schema.confirmed", "/api/etl/schema-inference/confirm", approvedSummary);
    return true;
  };

  const saveSchemaDraft = () => {
    if (!applySchemaDraft(approvedSummary)) {
      onNotify("저장할 스키마가 없습니다. Source 연결 테스트를 먼저 실행하세요.");
      return;
    }
    onSave();
  };
  const currentSummary = hasInferredSchema ? draft.schema.summary : inferredSummary;

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="schema" title="스키마 요약" summaryRows={schemaSummaryRows} onPrev={onPrev} onNext={() => {
        if (!approveSchema()) return;
        onNext();
      }} onSave={saveSchemaDraft} />}
    >
        <PageTitle title="Schema Inference" description="샘플 데이터를 분석해 컬럼, 타입, Null 여부와 추천 메타데이터를 확인합니다." />
        <div className="review-card-grid compact-cards">
          {metadata.map(([label, value], index) => (
            <article className="review-mini-card" key={`${label}-${index}`}>
              <strong>{label}</strong>
              <span>{label === "Status" ? currentSummary : value}</span>
            </article>
          ))}
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <LayoutGrid size={18} />
            <h2>Showing {schemaColumns.length} Fields</h2>
            <span className="panel-note">{hasInferredSchema ? "Filter, bulk edit, and approve inferred fields" : "Run Source Connection first"}</span>
          </div>
          <div className="hegun-toolbar">
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.rescanned", "/api/etl/schema-inference/rescan", `${schemaColumns.length} fields re-scanned · ${lowConfidenceCount} need review`)}>Re-scan Source</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", approvedSummary)}>Approve All</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.bulk_edit_opened", "/api/etl/schema-inference/bulk-edit")}>Bulk Edit Type</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.mappings_reset", "/api/etl/schema-inference/reset-mappings", `${schemaColumns.length} fields inferred · mappings reset`)}>Reset Mappings</button>
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
                {schemaRows.length === 0 && <tr><td colSpan={8}>Source 연결 테스트가 성공하면 MinIO sample 기반 스키마가 여기에 표시됩니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <div className="hegun-schema-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Field Review</h2>
              <span className="panel-note">{schemaColumns[0] ? `${schemaColumns[0].sourceName} · ${schemaColumns[0].confidence ?? 70}% Confidence · Field ID: 1` : "No field selected"}</span>
            </div>
            <div className="form-grid">
              <Field label="Target Field Name" value={schemaColumns[0]?.targetName ?? "-"} />
              <Field label="Override Type" value={schemaColumns[0]?.type ?? "-"} />
              <Field label="Null Ratio" value={schemaColumns[0]?.nullable ? "nullable" : hasInferredSchema ? "required" : "-"} />
              <Field label="Value Distribution" value={schemaRows[0]?.[7] ?? "-"} wide />
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
  const rules = [
    ["1", "meta_json", "Extract JSONPath", "user_email", "$.user.contact.email", "Set Null"],
    ["2", "user_email", "Lowercase + Trim", "user_email", "lower(), trim()", "Warn"],
    ["3", "price_usd", "Cast Decimal", "price_usd", "decimal(10,2)", "Drop Row"],
    ["4", "created_at", "Parse Timestamp", "created_at_utc", "string to UTC", "Set Null"],
    ["5", "phone_number", "Mask", "phone_masked", "keep first 3 digits", "Quarantine"],
  ];
  const qualityRules = [
    ["user_id", "Must not be null", "Error", "Fail Run"],
    ["price_usd", "Must be greater than 0", "Error", "Drop Row"],
    ["country", "Must be one of USA, KOR, JPN", "Warning", "Warn"],
    ["user_email", "Must match email regex pattern", "Warning", "Quarantine"],
    ["order_id", "Must be unique across set", "Error", "Fail Run"],
  ];
  const validationRows = [
    ["Row #1024", "Pass", "All checks passed"],
    ["Row #1025", "Fail", "price_usd (-15.0) < 0"],
    ["Row #1026", "Pass", "All checks passed"],
    ["Row #1027", "Fail", "user_id is NULL"],
    ["Row #1028", "Pass", "All checks passed"],
  ];

  const testRules = () => {
    onAction("etl.transform.tested", "/api/etl/transform-rules/test", "transform_recipe_draft");
    onDraftChange({ ruleSummary: "5 rules tested · 94.2% pass · 3 invalid rows" });
    onNotify("샘플 Transform 테스트가 통과되었습니다.");
  };

  const ruleAction = (action: string, path: string, ruleSummary?: string) => {
    onAction(action, path, "transform_recipe_draft");
    if (ruleSummary) {
      onDraftChange({ ruleSummary });
    }
  };

  const saveRuleDraft = () => {
    onDraftChange({ ruleSummary: "5 quality rules · quarantine invalid rows" });
    onSave();
  };

  const goNext = () => {
    onDraftChange({ ruleSummary: "5 quality rules · quarantine invalid rows" });
    onNext();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="rules" title="처리 요약" onPrev={onPrev} onNext={goNext} onSave={saveRuleDraft} />}
    >
        <PageTitle title="Rule Application" description="필드 매핑, 타입 변환, Null 처리, 검증 규칙을 적용해 Lake 저장 전 데이터를 정리합니다." />
        <div className="review-card-grid compact-cards">
          {[
            ["Active Rules", "5"],
            ["Affected Cols", "12/48"],
            ["Health", "94.2% Passed"],
            ["Invalid Rows", "3 Invalid Rows Detected"],
          ].map(([label, value]) => (
            <article className="review-mini-card" key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>
        <div className="hegun-rule-layout">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <BookOpen size={18} />
              <h2>Rule Library</h2>
              <span className="panel-note">Transformation · Quality & Validation</span>
            </div>
            <div className="hegun-rule-library">
              <article><strong>Transformation</strong><span>Type Cast, Map</span></article>
              <article><strong>Quality & Validation</strong><span>Check Integrity</span></article>
              <article className="wide"><strong>Auto-Validation</strong><span>Real-time quality checks are enabled. Every rule change triggers a preview update on the sampled 1k rows.</span></article>
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Settings size={18} />
              <h2>Configure New Quality Rule</h2>
              <span className="panel-note">Define validation logic for a specific data field.</span>
            </div>
            <div className="hegun-rule-builder">
              <label className="hegun-rule-field wide">
                <span>Validation Type</span>
                <div className="hegun-rule-options">
                  {["Not Null", "Range Check", "Accepted Values", "Unique", "Regex"].map((option) => (
                    <button className={option === "Range Check" ? "active" : ""} key={option} type="button" onClick={() => ruleAction("etl.rules.validation_type_selected", `/api/etl/rules/types/${option}`, `${option} rule selected`) }>{option}</button>
                  ))}
                </div>
              </label>
              <label className="hegun-rule-field">
                <span>Target Column</span>
                <div className="hegun-rule-select">
                  <strong>price_usd</strong>
                  <em>Decimal · 98.4% valid</em>
                </div>
              </label>
              <label className="hegun-rule-field">
                <span>Severity Level</span>
                <div className="hegun-rule-toggle">
                  <button type="button" onClick={() => ruleAction("etl.rules.severity_selected", "/api/etl/rules/severity/warning", "5 quality rules · warning severity selected")}>Warning</button>
                  <button className="active" type="button" onClick={() => ruleAction("etl.rules.severity_selected", "/api/etl/rules/severity/error", "5 quality rules · error severity selected")}>Error</button>
                </div>
              </label>
              <label className="hegun-rule-field wide">
                <span>Failure Action</span>
                <div className="hegun-rule-options compact">
                  {["Warn", "Drop Row", "Quarantine", "Fail Run"].map((option) => (
                    <button className={option === "Quarantine" ? "active" : ""} key={option} type="button" onClick={() => ruleAction("etl.rules.failure_action_selected", `/api/etl/rules/failure-actions/${option}`, `${option} failure action selected`)}>{option}</button>
                  ))}
                </div>
              </label>
              <label className="hegun-rule-field wide">
                <span>Condition / Value Expression</span>
                <div className="hegun-rule-expression">
                  <code>value &gt;= 0 AND value &lt;= 10000</code>
                  <em>sample pass rate 97.8%</em>
                </div>
              </label>
            </div>
            <div className="hegun-rule-footer">
              <div>
                <strong>Preview changes in real-time</strong>
                <span>1,000 sampled rows · 22 rows will be quarantined</span>
              </div>
              <button className="primary-button" type="button" onClick={() => ruleAction("etl.rules.added", "/api/etl/rules", "6 quality rules · price_usd range check added")}>Add Rule</button>
            </div>
          </section>
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Settings size={18} />
            <h2>Transformation Recipe Steps</h2>
            <span className="panel-note">sample first, full dataset during execution</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Input</th>
                  <th>Operation</th>
                  <th>Output</th>
                  <th>Params</th>
                  <th>On Error</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((row) => (
                  <tr key={`${row[0]}-${row[1]}`}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>Applied Quality Rules</h2>
            <span className="panel-note">Real-time validation enabled</span>
          </div>
          <div className="hegun-toolbar">
            <button className="secondary-button" type="button" onClick={() => ruleAction("etl.rules.revalidated", "/api/etl/rules/revalidate", "5 rules revalidated · 94.2% pass · 3 invalid rows")}>Re-validate</button>
            <button className="secondary-button" type="button" onClick={() => ruleAction("etl.rules.cleared", "/api/etl/rules/clear", "0 active rules · validation disabled")}>Clear All</button>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Rule</th>
                  <th>Severity</th>
                  <th>Failure Action</th>
                </tr>
              </thead>
              <tbody>
                {qualityRules.map((row) => (
                  <tr key={`${row[0]}-${row[1]}`}>
                    {row.map((cell, index) => <td key={`${row[0]}-${index}`}>{index === 3 ? `Action: ${cell}` : cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <FileText size={18} />
            <h2>Before / After Preview</h2>
          </div>
          <div className="form-grid">
            <Field label="Input Value" value={'{ "user": { "contact": { "email": "Jane.Doe@Acme.com" } } }'} wide />
            <Field label="Output Value" value="Jane.Doe@Acme.com" />
            <Field label="Sample Rows" value="1,000" />
            <Field label="Matched Rows" value="997" />
            <Field label="Generated Spec" value="json_path($.user.contact.email) → lower() → trim()" wide />
          </div>
          <InfoBox title="테스트 결과" body="샘플 1,000건 기준 변환 성공 998건, 검토 필요 2건입니다." />
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Check size={18} />
            <h2>Validation Results</h2>
            <span className="panel-note">SAMPLE N=1000</span>
          </div>
          <div className="hegun-validation-summary">
            <strong>3 Rows Failed Validation</strong>
            <span>Missing user_id (2 rows)</span>
            <span>Non-positive price_usd (1 row)</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {validationRows.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={testRules}>룰 테스트</button>
        </div>
    </CreationFlowLayout>
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
  const [selectedLayer, setSelectedLayer] = useState<TargetLayer>(draft.target.layer);
  const [targetDataset, setTargetDataset] = useState(draft.target.datasetName);
  const [targetOwner, setTargetOwner] = useState(draft.permission.owner);
  const [targetDescription, setTargetDescription] = useState("고객 리뷰 분석용 정제 데이터셋");
  const [targetFormat, setTargetFormat] = useState(draft.target.format);
  const [ragEnabled, setRagEnabled] = useState(draft.target.rag);
  const applyTargetDraft = () => {
    onDraftChange({
      jobName: `${targetDataset}_pipeline`,
      owner: targetOwner,
      targetDataset,
      targetFormat,
      targetLayer: selectedLayer,
      rag: ragEnabled,
    });
  };
  const selectLayer = (format: string) => {
    const layer = format.toUpperCase() as TargetLayer;
    setSelectedLayer(layer);
    onDraftChange({ targetLayer: layer });
  };
  const toggleRag = () => {
    const next = !ragEnabled;
    setRagEnabled(next);
    onDraftChange({ rag: next });
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
                setTargetDataset(event.target.value);
                onDraftChange({ jobName: `${event.target.value}_pipeline`, targetDataset: event.target.value });
              }} />
            </label>
            <label className="field">
              <span>소유자</span>
              <input className="input control-input" value={targetOwner} onChange={(event) => {
                setTargetOwner(event.target.value);
                onDraftChange({ owner: event.target.value });
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
            {["RAW", "Bronze", "Silver", "Gold"].map((format) => (
              <button className={format.toUpperCase() === selectedLayer ? "format-card active" : "format-card"} key={format} type="button" onClick={() => selectLayer(format)}>
                {format}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <Field label="저장소 유형" value="S3" />
            <label className="field">
              <span>파일 포맷</span>
              <select className="input control-input" value={targetFormat} onChange={(event) => {
                setTargetFormat(event.target.value);
                onDraftChange({ targetFormat: event.target.value });
              }}>
                <option>Parquet</option>
                <option>Delta</option>
                <option>Iceberg</option>
                <option>CSV</option>
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
  const roles = [
    { name: "Data Engineer Group", access: ["조회", "쿼리 실행", "메타데이터", "관리"], checked: true, note: "파이프라인 운영 및 장애 대응 권한" },
    { name: "Data Analyst Group", access: ["조회", "쿼리 실행", "메타데이터"], checked: true, note: "분석 업무용 표준 접근 권한" },
    { name: "ML Team", access: ["조회", "메타데이터"], checked: false, note: "RAG 인덱스 검증 후 확장 예정" },
  ];
  const [permissionTemplate, setPermissionTemplate] = useState("Data Engineer Group");
  const [visibility, setVisibility] = useState("조직 내부");
  const [dataOwner, setDataOwner] = useState(draft.permission.owner || "data-team-01");
  const [approvalStatus, setApprovalStatus] = useState("승인 검토");
  const [roleChecks, setRoleChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(roles.map((role) => [role.name, role.checked])));
  const permissionSummary = `${permissionTemplate} · ${visibility} · ${approvalStatus}`;

  const applyPermissionDraft = () => {
    onDraftChange({
      owner: dataOwner,
      permissionSummary,
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
                setPermissionTemplate(event.target.value);
                onDraftChange({ permissionSummary: `${event.target.value} · ${visibility} · ${approvalStatus}` });
              }}>
                <option>Data Engineer Group</option>
                <option>Data Analyst Group</option>
                <option>ML Team</option>
              </select>
            </label>
            <label className="field">
              <span>공개 범위</span>
              <select className="input control-input" value={visibility} onChange={(event) => {
                setVisibility(event.target.value);
                onDraftChange({ permissionSummary: `${permissionTemplate} · ${event.target.value} · ${approvalStatus}` });
              }}>
                <option>조직 내부</option>
                <option>프로젝트 멤버</option>
                <option>외부 공유</option>
              </select>
            </label>
            <label className="field">
              <span>데이터 오너</span>
              <input className="input control-input" value={dataOwner} onChange={(event) => {
                setDataOwner(event.target.value);
                onDraftChange({ owner: event.target.value });
              }} />
            </label>
            <label className="field">
              <span>승인 상태</span>
              <select className="input control-input" value={approvalStatus} onChange={(event) => {
                setApprovalStatus(event.target.value);
                onDraftChange({ permissionSummary: `${permissionTemplate} · ${visibility} · ${event.target.value}` });
              }}>
                <option>승인 검토</option>
                <option>승인 완료</option>
                <option>오너 승인 필요</option>
              </select>
            </label>
          </div>
        </section>
        <section className="panel">
          <h2 className="panel-title">세부 권한</h2>
          <div className="permission-list">
            {roles.map((role) => (
              <label className="permission-row detailed" key={role.name}>
                <input type="checkbox" checked={roleChecks[role.name]} onChange={(event) => setRoleChecks((checks) => ({ ...checks, [role.name]: event.target.checked }))} />
                <span>
                  <strong>{role.name}</strong>
                  <small>{role.note}</small>
                </span>
                <div className="permission-chip-row">
                  {["조회", "쿼리 실행", "메타데이터", "관리"].map((item) => (
                    <em className={role.access.includes(item) ? "allowed" : ""} key={item}>{item}</em>
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

export function ReviewPage({
  createPending,
  draft,
  onCreate,
  onEdit,
  onSave,
}: {
  createPending?: boolean;
  draft: DraftPipeline;
  onCreate: () => void;
  onEdit: (flow: FlowId) => void;
  onSave: () => void;
}) {
  const request = toCreatePipelineRequest(draft);
  const schemaRows = draft.schema.columns.map((column) => [
    column.targetName,
    column.type,
    column.nullable ? "YES" : "NO",
    column.sourceName === column.targetName ? `SOURCE.${column.sourceName}` : `${column.sourceName} -> ${column.targetName}`,
  ]);
  const sourceSummary = summarizeSourceConfig(request.sourceConfig);
  const scheduleEditFlow = getScheduleFlowFromLabel(request.scheduleLabel);
  const validationRows = [
    ["소스 연결", draft.source.connectionStatus === "success" ? "완료" : "확인 필요"],
    ["스키마", draft.schema.columns.length > 0 ? "확정됨" : "추론 필요"],
    ["처리 테스트", request.ruleSummary ? "통과" : "확인 필요"],
    ["스케줄", request.scheduleLabel ? "유효함" : "확인 필요"],
    ["실패 처리 정책", request.retryPolicySummary ? "유효함" : "확인 필요"],
    ["권한/타겟", request.permissionSummary && request.targetDataset ? "유효함" : "확인 필요"],
  ];
  const canCreate = draft.source.connectionStatus === "success" && draft.schema.columns.length > 0;
  const createDisabled = createPending || !canCreate;
  const createLabel = createPending ? "생성 중..." : canCreate ? "파이프라인 생성" : "검증 필요";

  return (
    <CreationFlowLayout
      variant="review"
      side={(
        <CreationValidationPanel
          title="최종 유효성 검사"
          actions={<CreationPanelActions withDivider nextDisabled={createDisabled} nextLabel={createLabel} onPrev={() => onEdit("target")} onSave={onSave} onNext={onCreate} />}
        >
          {validationRows.map(([item, status]) => (
            <div className="validation-row" key={item}>
              <Check size={16} />
              <span>{item}</span>
              <strong>{status}</strong>
            </div>
          ))}
          <InfoBox title="안내사항" body="파이프라인 생성 후 데이터 카탈로그에서 즉시 조회 및 SQL 쿼리를 수행할 수 있습니다." />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="검토 및 생성" description="설정된 모든 구성을 확인하고 데이터 파이프라인 생성을 완료하세요." />
        <div className="review-card-grid">
          {[
            ["기본 정보", request.targetDataset, "target"],
            ["소스", `${request.sourceType} · ${sourceSummary || request.sourceLabel}`, "source"],
            ["스키마", request.schemaSummary, "schema"],
            ["처리 규칙", request.ruleSummary, "rules"],
            ["스케줄", request.scheduleLabel, scheduleEditFlow],
            ["실패 처리 정책", request.retryPolicySummary, scheduleEditFlow],
            ["권한", request.permissionSummary, "permission"],
            ["타겟 저장소", `${request.targetLayer} / ${request.targetFormat}`, "target"],
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
              {schemaRows.length === 0 && <tr><td colSpan={4}>Source 연결과 Schema 추론이 완료되면 출력 스키마가 표시됩니다.</td></tr>}
            </tbody>
          </table>
        </section>
    </CreationFlowLayout>
  );
}

function summarizeSourceConfig(sourceConfig: Array<[string, string]>) {
  const priorityLabels = ["Storage Provider", "Endpoint URL", "Bucket / Stage Name", "Path / Prefix", "M3 Source ID", "M3 Run ID"];
  const valuesByLabel = new Map(sourceConfig);
  return priorityLabels
    .map((label) => {
      const value = valuesByLabel.get(label);
      return value ? `${label}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function sourceLabelFromFields(sourceType: string, fields: Array<[string, string]>) {
  const valuesByLabel = new Map(fields);
  if (sourceType === "File / S3") {
    const bucket = valuesByLabel.get("Bucket / Stage Name");
    const prefix = valuesByLabel.get("Path / Prefix");
    if (bucket && prefix) return `${bucket}/${prefix}`;
    if (bucket) return bucket;
  }

  return fields.find(([fieldLabel]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? sourceType;
}
