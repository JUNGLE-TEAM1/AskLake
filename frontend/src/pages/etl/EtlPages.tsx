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
  Trash2,
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

const sourceTypeLabels: Record<string, string> = {
  Database: "PostgreSQL",
  "Data Lake": "데이터 레이크",
  "File / S3": "파일 / MinIO(S3)",
  MongoDB: "MongoDB",
  PostgreSQL: "PostgreSQL",
  "REST API": "REST API",
  "Stream / Kafka": "스트림 / Kafka",
};

const sourceFieldLabels: Record<string, string> = {
  Accept: "응답 형식",
  "Access Key": "액세스 키",
  Authentication: "인증",
  "Authentication Type": "인증 방식",
  "Broker / Endpoint": "브로커 / 엔드포인트",
  Bucket: "버킷",
  "Bucket / Stage Name": "버킷 / 스테이지 이름",
  "CONSUMER GROUP ID": "컨슈머 그룹 ID",
  "CATALOG / NAMESPACE": "카탈로그 / 네임스페이스",
  Collection: "컬렉션",
  "Connection URI": "연결 URI",
  "DATASET OR TABLE SELECTOR": "데이터셋 또는 테이블 선택자",
  "DATABASE / SCHEMA": "데이터베이스 / 스키마",
  "Database Name": "데이터베이스 이름",
  Delimiter: "구분자",
  Encoding: "인코딩",
  Endpoint: "엔드포인트",
  "Endpoint / Host": "엔드포인트 / 호스트",
  "Endpoint URL": "엔드포인트 URL",
  Header: "헤더 처리",
  HTTP: "HTTP",
  "Lake Access": "레이크 접근",
  "Lake Type": "레이크 유형",
  Metadata: "메타데이터",
  Method: "메서드",
  Objects: "오브젝트",
  Partitions: "파티션",
  "Password / Auth Token": "비밀번호 / 인증 토큰",
  Path: "경로",
  "Path / Prefix": "경로 / 프리픽스",
  Port: "포트",
  Region: "리전",
  Response: "응답",
  Result: "결과",
  Schema: "스키마",
  "Secret Key": "시크릿 키",
  "Storage Provider": "스토리지 제공자",
  "Stream Type": "스트림 유형",
  Table: "테이블",
  Tables: "테이블",
  "Token / Secret": "토큰 / 시크릿",
  Topic: "토픽",
  "Topic Access": "토픽 접근",
  "TOPIC / QUEUE NAME": "토픽 / 큐 이름",
  Username: "사용자 이름",
  "Use Path Style": "Path Style 사용",
  "X-Request-ID": "요청 ID",
  Auth: "인증",
  "Backend connector": "백엔드 커넥터",
  "Broker Reachable": "브로커 접근",
  Connector: "커넥터",
  "File Type": "파일 형식",
  "Message Format": "메시지 형식",
  "Offset Policy": "오프셋 정책",
  Parquet: "Parquet",
  "Pagination Strategy": "페이지네이션 방식",
  "Read Mode": "읽기 모드",
  "Root Path": "루트 경로",
  "Source Units": "소스 단위",
};

const sourceColumnLabels: Record<string, string> = {
  "Action Type": "액션 유형",
  Amount: "금액",
  Date: "일자",
  Email: "이메일",
  "Event Timestamp": "이벤트 시각",
  "Last Modified": "수정 시각",
  Leader: "리더",
  "Object Key": "오브젝트 키",
  "Payload (Raw JSON)": "페이로드(JSON 원문)",
  "Part.": "파티션",
  Partition: "파티션",
  Reason: "사유",
  Region: "리전",
  Rows: "행 수",
  Size: "크기",
  Status: "상태",
  Table: "테이블",
  Timestamp: "타임스탬프",
  Topic: "토픽",
  "Transaction ID": "거래 ID",
  "User ID": "사용자 ID",
};

const sourceValueLabels: Record<string, string> = {
  detected: "감지됨",
  failed: "실패",
  listed: "목록 확인",
  "metadata reachable": "메타데이터 접근 가능",
  "Not listed": "목록 미확인",
  "Not tested": "미테스트",
  Pending: "대기",
  Reachable: "접근 가능",
  Required: "필수",
  sampled: "샘플링됨",
};

const sourceActionLabels: Record<string, string> = {
  "Download CSV": "CSV 다운로드",
  "Fetch Metadata": "메타데이터 조회",
  "Full Screen": "전체 화면",
  "Refresh Preview": "미리보기 새로고침",
  "Show Advanced Configuration": "고급 설정 보기",
};

function sourceTypeLabel(value: string) {
  return sourceTypeLabels[value] ?? value;
}

function sourceFieldLabel(value: string) {
  return sourceFieldLabels[value] ?? value;
}

function sourceColumnLabel(value: string) {
  return sourceColumnLabels[value] ?? value;
}

function sourceValueLabel(value: string) {
  if (/^leader \d+$/i.test(value)) return value.replace(/^leader/i, "리더");
  if (/^\d+ bytes$/i.test(value)) return value.replace("bytes", "바이트");
  return sourceValueLabels[value] ?? value;
}

function sourceActionLabel(value: string) {
  return sourceActionLabels[value] ?? value;
}

function isInternalSourceField(label: string) {
  return label.startsWith("__");
}

function publicSourceLog(value: string) {
  return value
    .replace(/^MinIO\/S3 reachable:\s*(\d+)\s*objects?$/i, "MinIO/S3 연결 성공: 오브젝트 $1개")
    .replace(/^MinIO\/S3 reachable:\s*(.+?)\s*\((\d+)\s*objects?\)$/i, "MinIO/S3 연결 성공: $1 (오브젝트 $2개)")
    .replace(/^MinIO reachable:\s*(\d+)\s*objects?$/i, "MinIO 연결 성공: 오브젝트 $1개")
    .replace(/^REST API reachable$/i, "REST API 연결 성공")
    .replace(/^REST API reachable:\s*(.+)$/i, "REST API 연결 성공: $1")
    .replace(/^PostgreSQL reachable:\s*(.+)$/i, "PostgreSQL 연결 성공: $1")
    .replace(/^MongoDB reachable:\s*(.+)$/i, "MongoDB 연결 성공: $1")
    .replace(/^Data Lake reachable:\s*(\d+)\s*objects?$/i, "데이터 레이크 연결 성공: 오브젝트 $1개")
    .replace(/^Kafka topic reachable:\s*(.+)$/i, "Kafka 토픽 연결 성공: $1")
    .replace(/^Source connection test is required before review\.$/i, "검토 전에 소스 연결 테스트가 필요합니다.")
    .replace(/^Connection test is required before review\.$/i, "검토 전에 연결 테스트가 필요합니다.")
    .replace(/^Bounded sample from\s+(.+)$/i, "$1에서 가져온 제한 샘플")
    .replace(/^Listed\s+(\d+)\s+objects?\s+from\s+MinIO\/S3$/i, "MinIO/S3 오브젝트 $1개 목록 조회")
    .replace(/^source units detected:\s*(\d+)$/i, "소스 단위 감지: $1개")
    .replace(/^bounded sample fetched:\s*(.+)$/i, "제한 샘플 조회: $1")
    .replace(/^profile snapshot inferred:\s*(\d+)\s*fields?,\s*(\d+)\s*sample rows?$/i, "프로파일 스냅샷 추론: $1개 필드, 샘플 행 $2개")
    .replace(/^profile snapshot inferred:\s*(\d+)\s*fields?$/i, "프로파일 스냅샷 추론: $1개 필드")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function publicSchemaSummary(value: string) {
  return value
    .replace(/^MinIO\/S3 reachable\s*-\s*schema inference pending\s*\((\d+)\s*objects?\)$/i, "MinIO/S3 연결 성공 · 스키마 추론 대기 (오브젝트 $1개)")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function publicConnectorAnalysis(result: SourceConnectorAnalysis): SourceConnectorAnalysis {
  return {
    ...result,
    draftPatch: {
      ...result.draftPatch,
      schema: result.draftPatch.schema ? {
        ...result.draftPatch.schema,
        summary: publicSchemaSummary(result.draftPatch.schema.summary ?? ""),
      } : result.draftPatch.schema,
      source: result.draftPatch.source ? {
        ...result.draftPatch.source,
        connectionMessage: publicSourceLog(result.draftPatch.source.connectionMessage ?? result.message),
      } : result.draftPatch.source,
    },
    logs: result.logs.map(publicSourceLog).filter(Boolean),
    message: publicSourceLog(result.message),
    previewNote: publicSourceLog(result.previewNote),
    testItems: result.testItems.filter(([label]) => !isInternalSourceField(label)),
  };
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
  const [connectionMessage, setConnectionMessage] = useState(draft.source.connectionMessage ?? "검토 전에 연결 테스트가 필요합니다.");
  const [sourceRuntime, setSourceRuntime] = useState<SourceConnectorAnalysis | null>(null);
  const connectorMeta: Record<string, { desc: string; icon: React.ReactNode; label: string; status: string }> = {
    "File / S3": { desc: "MinIO/S3 버킷과 텍스트 샘플 조회", icon: <HardDrive size={18} />, label: "파일 / MinIO(S3)", status: "실제 연결" },
    PostgreSQL: { desc: "테이블 목록, 샘플 행, 스키마 추론", icon: <Database size={18} />, label: "PostgreSQL", status: "실제 연결" },
    MongoDB: { desc: "컬렉션 목록, 문서 샘플, 중첩 필드 추론", icon: <LayoutGrid size={18} />, label: "MongoDB", status: "실제 연결" },
    "REST API": { desc: "HTTP 응답 샘플을 백엔드에서 수집", icon: <FileText size={18} />, label: "REST API", status: "실제 연결" },
    "Data Lake": { desc: "MinIO 경로의 Parquet 오브젝트 목록", icon: <Table2 size={18} />, label: "데이터 레이크", status: "목록 조회" },
    "Stream / Kafka": { desc: "Kafka 브로커와 토픽 메타데이터", icon: <TerminalSquare size={18} />, label: "스트림 / Kafka", status: "메타데이터" },
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
    PostgreSQL: {
      title: "PostgreSQL 연결",
      description: "백엔드 커넥터가 PostgreSQL 테이블 목록, 샘플 행, 스키마를 조회합니다.",
      fields: [
        ["Endpoint / Host", "127.0.0.1"],
        ["Port", "15432"],
        ["Database Name", "asklake_sources"],
        ["Schema", "public"],
        ["Username", "asklake"],
        ["Password / Auth Token", "asklake"],
        ["DATASET OR TABLE SELECTOR", "nyc_taxi_sample"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Backend connector", "Required"], ["Tables", "Pending"]],
      logs: ["PostgreSQL 소스 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 원시 데이터베이스 소켓을 열지 않습니다."],
      assetsTitle: "감지된 테이블",
      assets: [],
      previewTitle: "원천 데이터 미리보기",
      previewNote: "미리보기 데이터 없음 · 백엔드 연결 테스트를 실행하면 샘플 행을 가져옵니다.",
      previewColumns: ["Table", "Rows", "Status"],
      previewRows: [],
      info: "PostgreSQL 자격 증명은 브라우저가 아니라 백엔드 커넥터에서 검증합니다.",
    },
    MongoDB: {
      title: "MongoDB 연결",
      description: "백엔드 커넥터가 MongoDB 컬렉션 목록, 문서 샘플, 중첩 필드를 조회합니다.",
      fields: [
        ["Endpoint / Host", "127.0.0.1"],
        ["Port", "27018"],
        ["Database Name", "asklake_sources"],
        ["Username", ""],
        ["Password / Auth Token", ""],
        ["DATASET OR TABLE SELECTOR", "app_events"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Database", "Pending"], ["Collection", "Pending"]],
      logs: ["MongoDB 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 제한 문서 샘플을 가져옵니다."],
      assetsTitle: "감지된 컬렉션",
      assets: [],
      previewTitle: "문서 샘플 미리보기",
      previewNote: "미리보기 데이터 없음 · MongoDB 연결 테스트를 실행하세요.",
      previewColumns: ["Collection", "Documents", "Status"],
      previewRows: [],
      info: "MongoDB 연결과 샘플 조회는 백엔드 커넥터에서 실행합니다.",
    },
    "File / S3": {
      title: "MinIO 소스 설정",
      description: "MinIO/S3 호환 오브젝트 스토리지에서 버킷, 프리픽스, 제한 샘플을 실제 조회합니다.",
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
      testItems: [["Endpoint", "Not tested"], ["Bucket", "Not listed"], ["샘플 프로파일", "Pending"]],
      logs: ["MinIO 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 제한 샘플을 가져옵니다."],
      assetsTitle: "감지된 MinIO 오브젝트",
      assets: [],
      previewTitle: "제한 샘플 미리보기",
      previewNote: "미리보기 데이터 없음 · MinIO 연결 테스트를 실행하세요.",
      previewColumns: ["Object Key", "Size", "Last Modified"],
      previewRows: [],
      actions: ["Refresh Preview"],
    },
    "Data Lake": {
      title: "데이터 레이크 소스",
      description: "백엔드 connector runner가 Delta/Iceberg/Hudi 메타데이터를 조회해야 합니다.",
      fields: [
        ["Lake Type", "Delta Lake (Databricks)"],
        ["CATALOG / NAMESPACE", "local_catalog"],
        ["DATABASE / SCHEMA", "default"],
        ["Path", "s3://m3-raw/nyc_taxi/yellow_parquet/"],
        ["Endpoint URL", "http://127.0.0.1:9000"],
        ["Region", "us-east-1"],
        ["Access Key", "m3admin"],
        ["Secret Key", "wishuponastar"],
        ["Use Path Style", "true"],
        ["Read Mode", "Latest Version (Snapshot Isolation)"],
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Lake Access", "Not tested"], ["Metadata", "Pending"], ["Backend connector", "Required"]],
      logs: ["데이터 레이크 소스 식별은 백엔드 커넥터 러너에서 검증합니다.", "커넥터가 메타데이터를 반환할 때까지 테이블 프로파일은 대기합니다."],
      assetsTitle: "감지된 레이크 오브젝트",
      assets: [],
      previewTitle: "레이크 테이블 미리보기",
      previewNote: "미리보기 데이터 없음 · 백엔드 연결 테스트를 실행하세요.",
      previewColumns: ["Event Timestamp", "User ID", "Transaction ID", "Region", "Action Type", "Latency"],
      previewRows: [],
      actions: ["Fetch Metadata", "Download CSV", "Full Screen"],
    },
    "REST API": {
      title: "REST API 소스",
      description: "원격 데이터를 수집할 REST 엔드포인트를 설정합니다.",
      fields: [
        ["Method", "GET"],
        ["Endpoint URL", "http://localhost:8080/api/harness/rest-sample"],
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
      logs: ["REST 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 백엔드가 HTTP 응답 샘플을 가져옵니다."],
      assetsTitle: "감지된 필드",
      assets: [],
      previewTitle: "API 응답 미리보기",
      previewNote: "미리보기 데이터 없음 · 연결 테스트를 실행하세요.",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [],
      actions: ["Refresh Preview"],
    },
    "Stream / Kafka": {
      title: "스트림 소스 설정",
      description: "실시간 데이터 스트림 엔드포인트를 설정합니다.",
      fields: [
        ["Stream Type", "Apache Kafka"],
        ["Broker / Endpoint", "127.0.0.1:19092"],
        ["TOPIC / QUEUE NAME", "asklake-source-events"],
        ["CONSUMER GROUP ID", "asklake-etl-consumer-01"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "SASL / SCRAM"],
      ],
      testItems: [["Broker Reachable", "Not tested"], ["Topic Access", "Pending"], ["Backend connector", "Required"]],
      logs: ["Kafka 소스 윈도우 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 Kafka 프로토콜 핸드셰이크를 수행할 수 없습니다."],
      assetsTitle: "감지된 메타데이터",
      assets: [],
      previewTitle: "샘플 메시지 미리보기",
      previewNote: "미리보기 데이터 없음 · 백엔드 연결 테스트를 실행하세요.",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [],
      actions: ["Show Advanced Configuration"],
    },
  };
  const activeSourceType = sourceType === "Database" ? "PostgreSQL" : sourceConfigs[sourceType] ? sourceType : "File / S3";
  const current = sourceConfigs[activeSourceType];
  const editableFields = sourceFields[activeSourceType] ?? (
    draft.source.sourceType === activeSourceType && draft.source.sourceConfig.length > 0
      ? mergeFieldRows(current.fields, draft.source.sourceConfig)
      : current.fields
  );
  const sourceLabel = editableFields.find(([label]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? activeSourceType;
  const connectionStatusCopy: Record<SourceDraft["connectionStatus"], { badge: string; title: string }> = {
    failed: { badge: "확인 실패", title: "연결 실패" },
    idle: { badge: "테스트 필요", title: "연결 테스트 대기" },
    success: { badge: "미리보기 가능", title: "연결 검증 완료" },
    testing: { badge: "테스트 중", title: "연결 테스트 실행 중" },
  };
  const visibleEditableFields = editableFields.filter(([label]) => !isInternalSourceField(label));
  const displayTestItems = (sourceRuntime?.testItems ?? current.testItems).filter(([label]) => !isInternalSourceField(label));
  const displayAssets = sourceRuntime?.assets ?? current.assets;
  const displayLogs = (sourceRuntime?.logs ?? current.logs).map(publicSourceLog).filter(Boolean);
  const displayPreviewColumns = sourceRuntime?.previewColumns ?? current.previewColumns;
  const displayPreviewRows = sourceRuntime?.previewRows ?? current.previewRows;
  const displayPreviewNote = sourceRuntime?.previewNote ?? current.previewNote;
  const previewTableMinWidth = Math.max(880, displayPreviewColumns.length * 148);
  const publicConnectionMessage = publicSourceLog(connectionMessage);
  const publicDisplayPreviewNote = publicSourceLog(displayPreviewNote);
  const runtimeSourceConfig = sourceRuntime?.draftPatch.source?.sourceConfig;
  const verifiedSourceFields = connectionStatus === "success" && runtimeSourceConfig ? runtimeSourceConfig : editableFields;
  const sourceSummaryRows: Array<[string, string]> = [
    ["선택 커넥터", sourceTypeLabel(activeSourceType)],
    ["연결 상태", connectionStatus === "success" ? publicConnectionMessage : connectionStatus === "testing" ? "테스트 중" : connectionStatus === "failed" ? "실패" : "테스트 필요"],
    ["감지 파일", `${displayAssets.length}개`],
    ["인증 방식", activeSourceType === "File / S3" ? "MinIO/S3 액세스 키" : "백엔드 커넥터"],
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
    const nextMessage = `${sourceTypeLabel(value)} 설정을 선택했습니다. 검토 전에 연결 테스트를 실행하세요.`;
    setSourceType(value);
    setSourceRuntime(null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    applySourceDraft(value, sourceFields[value] ?? sourceConfigs[value].fields, "idle", nextMessage);
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    const nextMessage = "소스 설정이 변경되었습니다. 연결 테스트를 다시 실행하세요.";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime(null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    applySourceDraft(activeSourceType, nextFields, "idle", nextMessage);
  };

  const testConnection = async () => {
    const testingMessage = `${sourceTypeLabel(activeSourceType)} 커넥터 테스트 실행 중입니다.`;
    setConnectionStatus("testing");
    setConnectionMessage(testingMessage);
    applySourceDraft(activeSourceType, editableFields, "testing", testingMessage);
    try {
      const result = publicConnectorAnalysis(await testSourceConnector(activeSourceType, editableFields));
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
      const message = error instanceof Error ? error.message : "소스 커넥터 테스트에 실패했습니다.";
      setSourceRuntime({
        actionPath: "/api/etl/sources/test",
        assets: [],
        draftPatch: {},
        logs: [`[ERROR] ${message}`],
        message,
        previewColumns: ["Status", "Reason"],
        previewNote: "연결 테스트에 실패했습니다. 샘플을 가져오지 못했습니다.",
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
      side={<CreationSummaryPanel flow="source" title="소스 요약" selected={`${sourceTypeLabel(activeSourceType)} · ${sourceLabel}`} summaryRows={sourceSummaryRows} onPrev={onPrev} onNext={() => {
        if (connectionStatus !== "success") {
          onNotify("먼저 소스 연결 테스트를 성공시켜야 스키마 단계로 넘어갈 수 있습니다.");
          return;
        }
        applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
        onNext();
      }} onSave={() => {
        applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
        onSave();
      }} />}
    >
        <PageTitle title="소스 연결" description="사용할 소스를 고르고 같은 영역에서 연결 정보를 입력한 뒤 실제 연결 테스트를 실행합니다." />
        <section className="panel hegun-console-panel source-connect-panel" aria-label="소스 선택 및 연결">
          <div className="panel-header">
            <Database size={18} />
            <h2>소스 선택 및 연결</h2>
            <span className="panel-note">소스를 선택하면 연결 설정과 테스트가 바로 이어집니다</span>
          </div>
          <div className="source-connect-stack">
            <div className="source-picker-strip" role="group" aria-label="소스 선택">
              {Object.entries(connectorMeta).map(([connector, meta]) => (
                <button className={activeSourceType === connector ? "hegun-connector active" : "hegun-connector"} key={connector} type="button" onClick={() => selectSource(connector)}>
                  <span className="hegun-connector-icon">{meta.icon}</span>
                  <strong>{meta.label}</strong>
                  <span>{meta.desc}</span>
                  <em>{meta.status}</em>
                </button>
              ))}
            </div>
            <div className="source-active-config">
              <div className="source-active-heading">
                <Settings size={18} />
                <strong>{current.title}</strong>
                <span>{current.description}</span>
              </div>
              <div className="hegun-field-grid">
                {visibleEditableFields.map(([label, value]) => (
                  <label className={value.length > 38 ? "field wide" : "field"} key={`${activeSourceType}-${label}`}>
                    <span>{sourceFieldLabel(label)}</span>
                    <input className="input control-input" value={value} onChange={(event) => updateSourceField(label, event.target.value)} />
                  </label>
                ))}
              </div>
              {current.info && <InfoBox title="보안 연결" body={current.info} />}
              <div className="form-actions inline source-connect-actions">
                {current.actions?.includes("Show Advanced Configuration") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.advanced_opened", "/api/etl/sources/advanced", activeSourceType)}>{sourceActionLabel("Show Advanced Configuration")}</button>}
                {current.actions?.includes("Fetch Metadata") && <button className="secondary-button" type="button" onClick={fetchMetadata}>{sourceActionLabel("Fetch Metadata")}</button>}
                <button className="primary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>연결 테스트</button>
              </div>
            </div>
          </div>
        </section>
        <div className="hegun-source-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>연결 테스트</h2>
              <span className="panel-note">{displayTestItems.map(([label]) => sourceFieldLabel(label)).join(" · ")}</span>
            </div>
            <div className="hegun-test-summary">
              <div>
                <strong>{connectionStatusCopy[connectionStatus].title}</strong>
                <span>{publicConnectionMessage || `${sourceTypeLabel(activeSourceType)}에 ${displayTestItems.length}개 확인 항목이 설정되었습니다.`}</span>
              </div>
              <em>{connectionStatusCopy[connectionStatus].badge}</em>
            </div>
            <div className="hegun-test-strip">
              {displayTestItems.map(([label, value], index) => (
                <span key={`${activeSourceType}-${label}-${index}`}>
                  <i><Check size={13} /></i>
                  <strong>{sourceFieldLabel(label)}</strong>
                  <em>{sourceValueLabel(value)}</em>
                </span>
              ))}
            </div>
            <div className="hegun-log-panel" aria-label="연결 테스트 로그">
              <div className="hegun-log-header">
                <strong>검증 기록</strong>
                <span>{connectionStatus === "success" ? "완료" : connectionStatus === "testing" ? "진행 중" : connectionStatus === "failed" ? "실패" : "대기"}</span>
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
              <span className="panel-note">총 {displayAssets.length}개</span>
            </div>
            <div className="hegun-asset-list">
              {displayAssets.map(([name, meta, status], index) => (
                <article key={`${activeSourceType}-${name}-${index}`}>
                  <strong>{name}</strong>
                  <span>{meta}</span>
                  <em>{sourceValueLabel(status)}</em>
                </article>
              ))}
            </div>
          </section>
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <FileText size={18} />
            <h2>{current.previewTitle}</h2>
            <span className="panel-note">{publicDisplayPreviewNote}</span>
          </div>
          <div className="hegun-preview-actions">
            {current.actions?.includes("Refresh Preview") && <button className="secondary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>{sourceActionLabel("Refresh Preview")}</button>}
            {current.actions?.includes("Download CSV") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_downloaded", "/api/etl/sources/preview/download", activeSourceType)}>{sourceActionLabel("Download CSV")}</button>}
            {current.actions?.includes("Full Screen") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_fullscreen_opened", "/api/etl/sources/preview/fullscreen", activeSourceType)}>{sourceActionLabel("Full Screen")}</button>}
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table" style={{ minWidth: previewTableMinWidth }}>
              <thead><tr>{displayPreviewColumns.map((column, index) => <th key={`${column}-${index}`}>{sourceColumnLabel(column)}</th>)}</tr></thead>
              <tbody>
                {displayPreviewRows.map((row, rowIndex) => <tr key={`${activeSourceType}-preview-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}
                {displayPreviewRows.length === 0 && <tr><td colSpan={Math.max(displayPreviewColumns.length, 1)}>연결 테스트 후 소스 샘플 미리보기가 표시됩니다.</td></tr>}
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

const schemaTypeOptions = ["String", "Integer", "Float", "Boolean", "Timestamp", "JSON"];
const schemaRoleOptions = [
  { label: "일반", value: "" },
  { label: "식별자", value: "Identifier" },
  { label: "이벤트 시간", value: "Event Time" },
  { label: "측정값", value: "Metric" },
  { label: "개인정보", value: "PII" },
];

type SchemaBaseSnapshot = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  sourceLabel: string;
};

type SchemaSampleScope = "current" | "slice1gb" | "full";
type SchemaSampleScopeOption = {
  label: string;
  shortLabel: string;
  value: SchemaSampleScope;
};

function schemaSampleScopeOptionsForSource(sourceType: string): SchemaSampleScopeOption[] {
  if (sourceType === "MongoDB") {
    return [
      { label: "현재 문서", shortLabel: "현재", value: "current" },
      { label: "10k 문서", shortLabel: "10k", value: "slice1gb" },
      { label: "전체 컬렉션", shortLabel: "전체", value: "full" },
    ];
  }
  if (sourceType === "PostgreSQL") {
    return [
      { label: "현재 행", shortLabel: "현재", value: "current" },
      { label: "10k 행", shortLabel: "10k", value: "slice1gb" },
      { label: "전체 테이블", shortLabel: "전체", value: "full" },
    ];
  }
  return [
    { label: "현재 샘플", shortLabel: "현재", value: "current" },
    { label: "1GB 샘플", shortLabel: "1GB", value: "slice1gb" },
    { label: "전체", shortLabel: "전체", value: "full" },
  ];
}

function detectSchemaSourceFormat(draft: DraftPipeline) {
  const summary = draft.schema.summary.toLowerCase();
  const sampleObject = draft.source.sourceConfig.find(([label]) => label === "__Sample Object")?.[1]?.toLowerCase() ?? "";
  const sourceLabel = draft.source.sourceLabel.toLowerCase();
  const probe = `${summary} ${sampleObject} ${sourceLabel}`;
  if (probe.includes("jsonl")) return "JSONL";
  if (probe.includes("json")) return "JSON";
  if (probe.includes("parquet")) return "PARQUET";
  if (probe.includes("tsv")) return "TSV";
  if (probe.includes("csv")) return "CSV";
  if (draft.source.sourceType === "PostgreSQL") return "TABLE";
  if (draft.source.sourceType === "MongoDB") return "JSON";
  if (draft.source.sourceType === "Stream / Kafka") return "JSON";
  return "SAMPLE";
}

function buildSchemaFingerprint(columns: SchemaColumnDraft[]) {
  return columns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|");
}

function summarizeSchemaColumns(columns: SchemaColumnDraft[], lowConfidenceCount: number, sourceFormat: string) {
  return `${columns.length}개 출력 컬럼 구성 · ${lowConfidenceCount}개 검토 필요 · ${sourceFormat} 샘플 기준`;
}

function normalizeTargetColumnName(value: string) {
  return value
    .trim()
    .replace(/[^0-9A-Za-z_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function withUniqueTargetNames(columns: SchemaColumnDraft[]) {
  const counts = new Map<string, number>();
  return columns.map((column) => {
    const baseName = normalizeTargetColumnName(column.sourceName);
    const seen = counts.get(baseName) ?? 0;
    counts.set(baseName, seen + 1);
    return {
      ...column,
      targetName: seen === 0 ? baseName : `${baseName}_${seen + 1}`,
    };
  });
}

function cloneSchemaColumns(columns: SchemaColumnDraft[]) {
  return columns.map((column) => ({ ...column }));
}

function cloneSchemaRows(rows: string[][]) {
  return rows.map((row) => [...row]);
}

function upsertConfigValue(config: Array<[string, string]>, label: string, value: string) {
  const found = config.some(([fieldLabel]) => fieldLabel === label);
  if (found) {
    return config.map(([fieldLabel, fieldValue]) => (fieldLabel === label ? [fieldLabel, value] : [fieldLabel, fieldValue])) as Array<[string, string]>;
  }
  return [...config, [label, value]] as Array<[string, string]>;
}

function compactSchemaByPathDepth(columns: SchemaColumnDraft[], sampleRows: string[][], maxPathSegments: number) {
  const safeDepth = Math.max(1, Math.trunc(maxPathSegments));
  const groups = new Map<string, {
    columns: Array<{ column: SchemaColumnDraft; index: number; relativePath: string }>;
    firstIndex: number;
    key: string;
  }>();

  columns.forEach((column, index) => {
    const parts = column.sourceName.split(".").filter(Boolean);
    const compactParts = parts.length > safeDepth ? parts.slice(0, safeDepth) : parts;
    const key = compactParts.join(".") || column.sourceName || `column_${index + 1}`;
    const relativePath = parts.slice(compactParts.length).join(".");
    const group = groups.get(key);
    if (group) {
      group.columns.push({ column, index, relativePath });
      return;
    }
    groups.set(key, { columns: [{ column, index, relativePath }], firstIndex: index, key });
  });

  const orderedGroups = Array.from(groups.values()).sort((a, b) => a.firstIndex - b.firstIndex);
  const nextColumns = orderedGroups.map((group) => {
    if (group.columns.length === 1 && !group.columns[0].relativePath) {
      return { ...group.columns[0].column };
    }
    const confidenceValues = group.columns.map(({ column }) => column.confidence ?? 70);
    return {
      confidence: Math.min(...confidenceValues),
      nullable: group.columns.some(({ column }) => column.nullable),
      sourceName: group.key,
      targetName: normalizeTargetColumnName(group.key),
      type: "JSON",
    } satisfies SchemaColumnDraft;
  });

  const nextRows = sampleRows.map((row) => orderedGroups.map((group) => {
    if (group.columns.length === 1 && !group.columns[0].relativePath) {
      return row[group.columns[0].index] ?? "";
    }
    const nested: Record<string, unknown> = {};
    group.columns.forEach(({ column, index, relativePath }) => {
      const value = row[index] ?? "";
      if (!value.trim()) return;
      setNestedPreviewValue(nested, relativePath || column.sourceName.split(".").at(-1) || "value", value);
    });
    return Object.keys(nested).length > 0 ? JSON.stringify(nested) : "";
  }));

  return { columns: nextColumns, sampleRows: nextRows };
}

function buildSourceShapePreview(columns: SchemaColumnDraft[], row: string[]) {
  if (columns.length === 0) return "연결 테스트 후 샘플 구조가 표시됩니다.";
  const preview: Record<string, unknown> = {};
  const visibleColumns = columns.slice(0, 10);
  visibleColumns.forEach((column, index) => {
    setNestedPreviewValue(preview, column.sourceName, row[index] ?? "");
  });
  if (columns.length > visibleColumns.length) {
    preview.__remaining_fields = `${columns.length - visibleColumns.length}개 추가 필드`;
  }
  return JSON.stringify(preview, null, 2);
}

function buildCsvShapePreview(columns: SchemaColumnDraft[], row: string[]) {
  if (columns.length === 0) return "출력 컬럼이 없습니다.";
  const visibleColumns = columns.slice(0, 10);
  const header = visibleColumns.map((column, index) => toCsvPreviewCell(column.targetName || `column_${index + 1}`)).join(",");
  const values = visibleColumns.map((_, index) => toCsvPreviewCell(row[index] ?? "")).join(",");
  const suffix = columns.length > visibleColumns.length ? `\n... ${columns.length - visibleColumns.length}개 컬럼 더 있음` : "";
  return `${header}\n${values}${suffix}`;
}

function setNestedPreviewValue(target: Record<string, unknown>, sourceName: string, value: string) {
  const parts = sourceName.split(".").filter(Boolean);
  if (parts.length <= 1) {
    target[sourceName || "value"] = value;
    return;
  }
  let cursor = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  });
}

function toCsvPreviewCell(value: string) {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function sampleValuesForColumn(rows: string[][], columnIndex: number) {
  return rows.map((row) => row[columnIndex] ?? "").filter((value) => value.trim() !== "");
}

function estimateNullRatio(rows: string[][], columnIndex: number) {
  if (rows.length === 0) return 0;
  const nullCount = rows.filter((row) => !(row[columnIndex] ?? "").trim()).length;
  return Math.round((nullCount / rows.length) * 100);
}

function valueDistribution(values: string[]) {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const key = value.length > 24 ? `${value.slice(0, 24)}...` : value;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const max = Math.max(...counts.values(), 0);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => ({ count, label, percent: max > 0 ? Math.max(8, Math.round((count / max) * 100)) : 0 }));
}

function schemaRoleLabel(role?: string) {
  return schemaRoleOptions.find((option) => option.value === (role ?? ""))?.label ?? role ?? "일반";
}

function formatSourceFieldPath(value: string) {
  if (!value.includes(".")) return value;
  const parts = value.split(".");
  return parts.map((part, index) => (index === 0 ? part : `└ ${part}`)).join(" ");
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
  const [schemaFilter, setSchemaFilter] = useState("");
  const [schemaPreviewMode, setSchemaPreviewMode] = useState<"flat" | "raw">("flat");
  const [selectedSchemaIndex, setSelectedSchemaIndex] = useState(0);
  const [flattenObjects, setFlattenObjects] = useState(true);
  const [flattenDepth, setFlattenDepth] = useState(2);
  const [flattenBaseSchema, setFlattenBaseSchema] = useState<SchemaBaseSnapshot | null>(null);
  const [schemaSampleScope, setSchemaSampleScope] = useState<SchemaSampleScope>("current");
  const [isRecheckingSchema, setIsRecheckingSchema] = useState(false);
  const hasInferredSchema = draft.schema.columns.length > 0;
  const schemaColumns: SchemaColumnDraft[] = draft.schema.columns;
  const schemaSampleRows = draft.schema.sampleRows;
  const lowConfidenceCount = schemaColumns.filter((column) => (column.confidence ?? 100) < 80).length;
  const averageConfidence = schemaColumns.length
    ? Math.round(schemaColumns.reduce((sum, column) => sum + (column.confidence ?? 70), 0) / schemaColumns.length)
    : 0;
  const sourceFormat = detectSchemaSourceFormat(draft);
  const isFlattenedJson = schemaColumns.some((column) => column.sourceName.includes(".")) || ["JSON", "JSONL"].includes(sourceFormat);
  const nestedFieldCount = schemaColumns.filter((column) => column.sourceName.includes(".")).length;
  const mappingModeText = hasInferredSchema
    ? isFlattenedJson
      ? flattenObjects
        ? `${sourceFormat} 원본 필드를 최대 ${flattenDepth}단계까지 출력 컬럼으로 평탄화`
        : `${sourceFormat} 중첩 객체를 JSON 컬럼으로 유지`
      : `${sourceFormat} 원본 컬럼을 출력 테이블 컬럼으로 매핑`
    : "소스 연결 후 원본 필드와 출력 컬럼 매핑을 확인할 수 있습니다.";
  const previewRow = schemaSampleRows[0] ?? [];
  const sourcePreviewText = buildSourceShapePreview(schemaColumns, previewRow);
  const outputTableMinWidth = Math.max(880, schemaColumns.length * 148);
  const inferredSummary = hasInferredSchema ? publicSchemaSummary(draft.schema.summary) : "스키마 추론 전에 소스 연결이 필요합니다.";
  const approvedSummary = summarizeSchemaColumns(schemaColumns, lowConfidenceCount, sourceFormat);
  const sampleScopeOptions = schemaSampleScopeOptionsForSource(draft.source.sourceType);
  const selectedSampleScopeLabel = sampleScopeOptions.find((option) => option.value === schemaSampleScope)?.label ?? sampleScopeOptions[0].label;
  const schemaFingerprint = buildSchemaFingerprint(schemaColumns);
  const selectedIndex = schemaColumns.length ? Math.min(selectedSchemaIndex, schemaColumns.length - 1) : 0;
  const selectedColumn = schemaColumns[selectedIndex];
  const selectedSampleValues = selectedColumn ? sampleValuesForColumn(schemaSampleRows, selectedIndex) : [];
  const selectedNullRatio = selectedColumn ? estimateNullRatio(schemaSampleRows, selectedIndex) : 0;
  const selectedDistribution = selectedColumn ? valueDistribution(selectedSampleValues) : [];
  const visibleSchemaColumns = schemaColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => {
      const keyword = schemaFilter.trim().toLowerCase();
      if (!keyword) return true;
      return `${column.sourceName} ${column.targetName} ${column.type} ${column.role ?? ""}`.toLowerCase().includes(keyword);
    });

  const applySchemaDraft = (summary: string, columns = schemaColumns, sampleRows = schemaSampleRows) => {
    if (columns.length === 0) return false;
    onDraftChange({
      schema: {
        columns,
        sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary,
      },
    });
    return true;
  };

  const patchSchemaColumns = (columns: SchemaColumnDraft[], sampleRows = schemaSampleRows) => {
    const reviewCount = columns.filter((column) => (column.confidence ?? 100) < 80).length;
    onDraftChange({
      schema: {
        columns,
        sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary: columns.length > 0 ? summarizeSchemaColumns(columns, reviewCount, sourceFormat) : "출력 컬럼 없음 · 스키마 매핑 필요",
      },
    });
  };

  const currentSourceLabel = draft.source.sourceLabel || draft.source.sourceType || "source";

  const getFlattenBaseSchema = () => {
    if (flattenBaseSchema?.sourceLabel === currentSourceLabel && flattenBaseSchema.columns.length > 0) {
      return flattenBaseSchema;
    }
    const base = {
      columns: cloneSchemaColumns(schemaColumns),
      sampleRows: cloneSchemaRows(schemaSampleRows),
      sourceLabel: currentSourceLabel,
    };
    setFlattenBaseSchema(base);
    return base;
  };

  const applyFlattenSettings = (nextFlattenObjects: boolean, nextDepth = flattenDepth) => {
    if (!hasInferredSchema) {
      onNotify("변경할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    const base = getFlattenBaseSchema();
    const maxPathSegments = nextFlattenObjects ? nextDepth : 1;
    const nextSchema = compactSchemaByPathDepth(base.columns, base.sampleRows, maxPathSegments);
    setFlattenObjects(nextFlattenObjects);
    setFlattenDepth(nextDepth);
    patchSchemaColumns(nextSchema.columns, nextSchema.sampleRows);
    setSelectedSchemaIndex(0);
    onAction(
      nextFlattenObjects ? "etl.schema.flatten_enabled" : "etl.schema.flatten_disabled",
      "/api/etl/schema-inference/flattening",
      draft.source.sourceLabel || "schema",
    );
    onNotify(nextFlattenObjects
      ? `중첩 객체를 최대 ${nextDepth}단계까지 출력 컬럼으로 펼쳤습니다.`
      : "중첩 객체를 JSON 컬럼으로 유지합니다.");
  };

  const selectSampleScope = (scope: SchemaSampleScope) => {
    const option = sampleScopeOptions.find((item) => item.value === scope) ?? sampleScopeOptions[0];
    setSchemaSampleScope(scope);
    onDraftChange({
      source: {
        sourceConfig: upsertConfigValue(
          upsertConfigValue(draft.source.sourceConfig, "__Schema Sample Scope", option.value),
          "__Schema Sample Scope Label",
          option.label,
        ),
      },
    });
    onAction("etl.schema.sample_scope_changed", "/api/etl/schema-inference/sample-scope", option.label);
    onNotify(`${option.label} 기준으로 스키마 확인 범위를 설정했습니다.`);
  };

  const updateSchemaColumn = (index: number, patch: Partial<SchemaColumnDraft>) => {
    const nextColumns = schemaColumns.map((column, columnIndex) => (
      columnIndex === index ? { ...column, ...patch } : column
    ));
    patchSchemaColumns(nextColumns);
  };

  const deleteSchemaColumn = (index: number) => {
    const nextColumns = schemaColumns.filter((_, columnIndex) => columnIndex !== index);
    const nextSampleRows = schemaSampleRows.map((row) => row.filter((_, cellIndex) => cellIndex !== index));
    patchSchemaColumns(nextColumns, nextSampleRows);
    setSelectedSchemaIndex(Math.max(0, Math.min(index, nextColumns.length - 1)));
    onAction("etl.schema.column_deleted", "/api/etl/schema-inference/columns", schemaColumns[index]?.sourceName ?? "schema");
    onNotify(nextColumns.length > 0 ? "출력 컬럼에서 제외했습니다." : "모든 출력 컬럼이 제외됐습니다. 최소 1개 컬럼을 남겨야 생성할 수 있습니다.");
  };

  const resetSchemaMappings = () => {
    const nextColumns = withUniqueTargetNames(schemaColumns);
    patchSchemaColumns(nextColumns);
    onAction("etl.schema.mappings_reset", "/api/etl/schema-inference/reset-mappings", draft.source.sourceLabel || "source");
    onNotify("원본 필드 기준으로 출력 컬럼명을 다시 맞췄습니다.");
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
      onNotify("확정할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return false;
    }
    schemaAction("etl.schema.confirmed", "/api/etl/schema-inference/confirm", approvedSummary);
    return true;
  };

  const saveSchemaDraft = () => {
    if (!applySchemaDraft(approvedSummary)) {
      onNotify("저장할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    onSave();
  };

  const exportSchema = () => {
    if (!hasInferredSchema) {
      onNotify("내보낼 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    const payload = JSON.stringify({
      columns: schemaColumns,
      sampleRows: schemaSampleRows.slice(0, 5),
      schemaFingerprint,
      summary: approvedSummary,
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.source.sourceLabel || "asklake-schema"}.schema.json`.replace(/[\\/:*?"<>|]+/g, "_");
    link.click();
    URL.revokeObjectURL(url);
    onAction("etl.schema.exported", "/api/etl/schema-inference/export", draft.source.sourceLabel || "schema");
    onNotify("현재 스키마 JSON을 내보냈습니다.");
  };

  const confirmCurrentSchema = () => {
    if (!approveSchema()) return;
    onNext();
  };

  const applySelectedField = () => {
    if (!selectedColumn) {
      onNotify("적용할 필드가 없습니다.");
      return;
    }
    onAction("etl.schema.field_applied", "/api/etl/schema-inference/field", selectedColumn.sourceName);
    onNotify(`${selectedColumn.targetName || selectedColumn.sourceName} 필드 변경사항을 적용했습니다.`);
  };

  const rerunCurrentInference = async () => {
    if (!draft.source.sourceType || draft.source.sourceConfig.length === 0) {
      onNotify("다시 확인할 소스 연결 정보가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    setIsRecheckingSchema(true);
    const sourceConfig = upsertConfigValue(
      upsertConfigValue(draft.source.sourceConfig, "__Schema Sample Scope", schemaSampleScope),
      "__Schema Sample Scope Label",
      selectedSampleScopeLabel,
    );
    try {
      const result = await testSourceConnector(draft.source.sourceType, sourceConfig);
      onDraftChange(result.draftPatch);
      setFlattenBaseSchema(null);
      setSelectedSchemaIndex(0);
      onAction("etl.schema.inference_checked", "/api/etl/schema-inference", draft.source.sourceLabel || "source", result.status === "failed" ? "failed" : "success");
      onNotify(`${selectedSampleScopeLabel} 기준으로 스키마를 다시 확인했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "스키마 재확인 중 오류가 발생했습니다.";
      onAction("etl.schema.inference_failed", "/api/etl/schema-inference", draft.source.sourceLabel || "source", "failed");
      onNotify(message);
    } finally {
      setIsRecheckingSchema(false);
    }
  };

  return (
    <div className="schema-workbench">
      <section className="schema-status-strip">
        <div className="schema-status-item source">
          <Database size={17} />
          <span>데이터 소스</span>
          <strong>{draft.source.sourceLabel || "-"}</strong>
        </div>
        <div className="schema-status-item">
          <span>샘플 행</span>
          <strong>{schemaSampleRows.length.toLocaleString()}</strong>
        </div>
        <div className={lowConfidenceCount > 0 ? "schema-status-item warning" : "schema-status-item success"}>
          <span>상태</span>
          <strong>{hasInferredSchema ? (lowConfidenceCount > 0 ? "검토 필요" : "추론 완료") : "소스 연결 필요"}</strong>
        </div>
        <div className="schema-status-actions">
          <button className="secondary-button" type="button" disabled={!hasInferredSchema} onClick={resetSchemaMappings}>
            <RefreshCw size={15} /> 매핑 초기화
          </button>
          <button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", approvedSummary)}>
            <Check size={15} /> 스키마 승인
          </button>
        </div>
      </section>

      <section className="schema-designer">
        <aside className="schema-settings-panel">
          <div className="schema-panel-title">
            <SlidersHorizontal size={17} />
            <h2>{isFlattenedJson ? "문서 샘플링" : "파서 설정"}</h2>
          </div>
          <label className="schema-setting-field">
            <span>소스 형식</span>
            <select className="input control-input" value={sourceFormat} disabled>
              <option>{sourceFormat}</option>
            </select>
          </label>
          <label className="schema-setting-field">
            <span>{isFlattenedJson ? "루트 경로" : "헤더 처리"}</span>
            <input className="input control-input" value={isFlattenedJson ? "$" : "첫 행을 컬럼명으로 사용"} readOnly />
          </label>
          <label className="schema-setting-field">
            <span>인코딩</span>
            <select className="input control-input" value="UTF-8" disabled>
              <option>UTF-8</option>
            </select>
          </label>
          <div className="schema-segment-field">
            <span>샘플 범위</span>
            <div>
              {sampleScopeOptions.map((option) => (
                <button
                  className={option.value === schemaSampleScope ? "active" : ""}
                  disabled={isRecheckingSchema}
                  aria-label={option.label}
                  key={option.value}
                  onClick={() => selectSampleScope(option.value)}
                  title={option.label}
                  type="button"
                >
                  {option.shortLabel}
                </button>
              ))}
            </div>
          </div>
          {isFlattenedJson && (
            <>
              <label className="schema-check-row">
                <span>
                  <strong>중첩 객체 평탄화</strong>
                  <small>{flattenObjects ? `${nestedFieldCount}개 중첩 필드를 출력 컬럼으로 펼침` : "중첩 객체를 JSON 컬럼으로 유지"}</small>
                </span>
                <input
                  aria-label="중첩 객체 평탄화"
                  checked={flattenObjects}
                  disabled={!hasInferredSchema}
                  onChange={(event) => applyFlattenSettings(event.currentTarget.checked)}
                  type="checkbox"
                />
              </label>
              <div className="schema-segment-field">
                <span>평탄화 깊이</span>
                <div>
                  {["1", "2", "3"].map((depth) => (
                    <button
                      className={Number(depth) === flattenDepth ? "active" : ""}
                      disabled={!hasInferredSchema || !flattenObjects}
                      key={depth}
                      onClick={() => applyFlattenSettings(true, Number(depth))}
                      type="button"
                    >
                      {depth}
                    </button>
                  ))}
                </div>
              </div>
              <label className="schema-setting-field">
                <span>배열 처리</span>
                <select className="input control-input" value="JSON 유지" disabled>
                  <option>JSON 유지</option>
                </select>
              </label>
            </>
          )}
          <button className="secondary-button schema-wide-button" type="button" disabled={isRecheckingSchema || !hasInferredSchema} onClick={rerunCurrentInference}>
            <RefreshCw size={15} /> {isRecheckingSchema ? "스키마 확인 중" : "선택 범위 다시 확인"}
          </button>
        </aside>

        <main className="schema-field-panel">
          <div className="schema-field-toolbar">
            <label className="schema-search-box">
              <Search size={16} />
              <input value={schemaFilter} onChange={(event) => setSchemaFilter(event.currentTarget.value)} placeholder="필드 검색..." />
            </label>
            <button className="schema-toolbar-button" type="button" disabled={!hasInferredSchema} onClick={resetSchemaMappings}>매핑 초기화</button>
            <span>{visibleSchemaColumns.length} / {schemaColumns.length}개 표시</span>
          </div>
          <div className="schema-field-table-wrap">
            <table className="schema-field-table">
              <thead>
                <tr>
                  <th>포함</th>
                  <th>순서</th>
                  <th>{isFlattenedJson ? "필드 경로" : "원본 필드"}</th>
                  <th>출력 필드</th>
                  <th>타입</th>
                  <th>Null</th>
                  <th>역할</th>
                  <th>삭제</th>
                </tr>
              </thead>
              <tbody>
                {visibleSchemaColumns.map(({ column, index }) => {
                  const confidence = column.confidence ?? 70;
                  return (
                    <tr className={`${index === selectedIndex ? "selected" : ""} ${confidence < 80 ? "needs-review" : ""}`} key={`${column.sourceName}-${index}`} onClick={() => setSelectedSchemaIndex(index)}>
                      <td>
                        <input aria-label={`${column.targetName} 포함`} checked type="checkbox" onChange={(event) => {
                          event.stopPropagation();
                          if (!event.currentTarget.checked) deleteSchemaColumn(index);
                        }} onClick={(event) => event.stopPropagation()} />
                      </td>
                      <td>#{index + 1}</td>
                      <td>
                        <strong title={column.sourceName}>{formatSourceFieldPath(column.sourceName)}</strong>
                      </td>
                      <td>
                        <button type="button" onClick={(event) => {
                          event.stopPropagation();
                          setSelectedSchemaIndex(index);
                        }}>{column.targetName || `column_${index + 1}`}</button>
                      </td>
                      <td><span className="schema-type-pill">{column.type}</span></td>
                      <td>{column.nullable ? "허용" : "필수"}</td>
                      <td>{schemaRoleLabel(column.role)}</td>
                      <td>
                        <button className="schema-table-delete" type="button" title="출력 컬럼에서 제외" onClick={(event) => {
                          event.stopPropagation();
                          deleteSchemaColumn(index);
                        }}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleSchemaColumns.length === 0 && (
                  <tr>
                    <td colSpan={8}>표시할 스키마 필드가 없습니다. 소스 연결 테스트를 먼저 실행하거나 검색어를 지우세요.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="schema-inspector-panel">
          {selectedColumn ? (
            <>
              <div className="schema-inspector-heading">
                <div>
                  <h2>{formatSourceFieldPath(selectedColumn.sourceName)}</h2>
                  <span>필드 ID: {selectedIndex + 1}</span>
                </div>
                <em>{selectedColumn.confidence ?? 70}% 확신</em>
              </div>
              <label className="schema-setting-field">
                <span>출력 필드명</span>
                <input
                  className="input control-input"
                  value={selectedColumn.targetName}
                  onBlur={(event) => {
                    if (event.currentTarget.value.trim()) return;
                    updateSchemaColumn(selectedIndex, { targetName: normalizeTargetColumnName(selectedColumn.sourceName) });
                  }}
                  onChange={(event) => updateSchemaColumn(selectedIndex, { targetName: event.currentTarget.value })}
                />
              </label>
              <label className="schema-setting-field">
                <span>타입 재정의</span>
                <select className="input control-input" value={selectedColumn.type} onChange={(event) => updateSchemaColumn(selectedIndex, { type: event.currentTarget.value })}>
                  {schemaTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="schema-setting-field">
                <span>Null 정책</span>
                <select className="input control-input" value={selectedColumn.nullable ? "true" : "false"} onChange={(event) => updateSchemaColumn(selectedIndex, { nullable: event.currentTarget.value === "true" })}>
                  <option value="false">필수</option>
                  <option value="true">허용</option>
                </select>
              </label>
              <label className="schema-setting-field">
                <span>역할</span>
                <select className="input control-input" value={selectedColumn.role ?? ""} onChange={(event) => updateSchemaColumn(selectedIndex, { role: event.currentTarget.value || undefined })}>
                  {schemaRoleOptions.map((role) => <option key={role.value || "none"} value={role.value}>{role.label}</option>)}
                </select>
              </label>
              <div className="schema-inspector-metrics">
                <div>
                  <span>Null 비율</span>
                  <strong>{selectedNullRatio}%</strong>
                </div>
                <div>
                  <span>샘플 값 수</span>
                  <strong>{selectedSampleValues.length}</strong>
                </div>
              </div>
              <div className="schema-null-meter"><span style={{ width: `${selectedNullRatio}%` }} /></div>
              <div className="schema-distribution">
                <span>값 분포</span>
                {selectedDistribution.map((item) => (
                  <div key={item.label}>
                    <strong title={item.label}>{item.label}</strong>
                    <span><i style={{ width: `${item.percent}%` }} /></span>
                    <em>{item.count}</em>
                  </div>
                ))}
                {selectedDistribution.length === 0 && <small>샘플 값 없음</small>}
              </div>
              <div className="schema-sample-chips">
                <span>샘플 값</span>
                <div>
                  {selectedSampleValues.slice(0, 5).map((value, index) => <em key={`${value}-${index}`} title={value}>{value || "null"}</em>)}
                  {selectedSampleValues.length === 0 && <em>값 없음</em>}
                </div>
              </div>
              <button className="primary-button schema-wide-button" type="button" onClick={applySelectedField}>변경 적용</button>
              <button className="secondary-button schema-wide-button" type="button" onClick={() => deleteSchemaColumn(selectedIndex)}>출력 컬럼에서 제외</button>
            </>
          ) : (
            <div className="schema-inspector-empty">선택된 필드가 없습니다.</div>
          )}
        </aside>
      </section>

      <section className="schema-preview-panel">
        <div className="schema-preview-tabs">
          <button className={schemaPreviewMode === "raw" ? "active" : ""} type="button" onClick={() => setSchemaPreviewMode("raw")}>원본 샘플</button>
          <button className={schemaPreviewMode === "flat" ? "active" : ""} type="button" onClick={() => setSchemaPreviewMode("flat")}>평탄화 미리보기</button>
          <span>{mappingModeText}</span>
        </div>
        {schemaPreviewMode === "raw" ? (
          <pre className="schema-raw-preview">{sourcePreviewText}</pre>
        ) : (
          <div className="hegun-table-scroll">
            <table className="schema-table schema-output-preview-table" style={{ minWidth: outputTableMinWidth }}>
              <thead>
                <tr>
                  {schemaColumns.map((column, index) => <th key={`${column.targetName}-${index}`} title={column.targetName}>{column.targetName || `column_${index + 1}`}</th>)}
                </tr>
              </thead>
              <tbody>
                {schemaSampleRows.slice(0, 8).map((row, rowIndex) => (
                  <tr key={`schema-preview-${rowIndex}`}>
                    {schemaColumns.map((column, columnIndex) => <td key={`${column.sourceName}-${columnIndex}`} title={row[columnIndex] ?? ""}>{row[columnIndex] ?? ""}</td>)}
                  </tr>
                ))}
                {schemaColumns.length === 0 && <tr><td>소스 연결과 스키마 추론이 완료되면 출력 미리보기가 표시됩니다.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="schema-bottom-bar">
        <button className="secondary-button" type="button" onClick={onPrev}>이전: 소스 연결</button>
        <button className="secondary-button" type="button" disabled={!hasInferredSchema} onClick={exportSchema}>
          <Download size={15} /> 스키마 JSON 내보내기
        </button>
        <span>Step 2 of 3 · {hasInferredSchema ? approvedSummary : inferredSummary}</span>
        <button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={confirmCurrentSchema}>스키마 확정 후 다음</button>
        <button className="ghost-button" type="button" onClick={saveSchemaDraft}>설정 저장</button>
      </section>
    </div>
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
    column.nullable ? "예" : "아니오",
    column.sourceName === column.targetName ? `SOURCE.${column.sourceName}` : `${column.sourceName} -> ${column.targetName}`,
  ]);
  const sourceSummary = summarizeSourceConfig(request.sourceConfig);
  const reviewSchemaSummary = publicSchemaSummary(request.schemaSummary);
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
            ["소스", `${sourceTypeLabel(request.sourceType)} · ${sourceSummary || request.sourceLabel}`, "source"],
            ["스키마", reviewSchemaSummary, "schema"],
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
            <span className="panel-note">{reviewSchemaSummary}</span>
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
              {schemaRows.length === 0 && <tr><td colSpan={4}>소스 연결과 스키마 추론이 완료되면 출력 스키마가 표시됩니다.</td></tr>}
            </tbody>
          </table>
        </section>
    </CreationFlowLayout>
  );
}

function summarizeSourceConfig(sourceConfig: Array<[string, string]>) {
  const priorityLabels = ["Storage Provider", "Endpoint URL", "Bucket / Stage Name", "Path / Prefix", "Path", "DATASET OR TABLE SELECTOR", "Broker / Endpoint"];
  const valuesByLabel = new Map(sourceConfig);
  return priorityLabels
    .map((label) => {
      const value = valuesByLabel.get(label);
      return value && !isInternalSourceField(label) ? `${sourceFieldLabel(label)}: ${value}` : "";
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
