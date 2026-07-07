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
  Trash2,
} from "lucide-react";
import { Field, InfoBox, PageTitle, RetryPolicy, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationPanelActions, CreationSummaryPanel, CreationValidationPanel } from "../../components/creation/CreationFlow";
import { runTransformQualitySamplePreview } from "../../data/transformQualityPreview";
import { toCreatePipelineRequest } from "../../services/draftPipelineContract";
import { testSourceConnector, type SourceConnectorAnalysis } from "../../services/sourceConnectorService";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, FlowId, ScheduleFlowId, SchemaColumnDraft, SourceDraft, TargetLayer } from "../../types";
import type { QualityRuleDraft, RetryPolicyDraft, TransformStepDraft } from "../../types/etl";
import type { QualityRuleOption, TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview, TransformQualityValidationResult } from "../../data/transformQualityPreview";

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
  const selected = mode === "repeat" ? "반복 스케줄" : mode === "manual" ? "스케줄 없음" : "예약 1회 실행";
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
            <RunTypeCard active={mode === "manual"} icon={<PlayCircle size={24} />} title="스케줄 없음" desc="저장 후 필요할 때 직접 실행합니다." onClick={() => selectMode("manual")} />
            <RunTypeCard active={mode === "once"} icon={<Clock3 size={24} />} title="예약 1회 실행" desc="지정된 시간에 한 번만 실행합니다." onClick={() => selectMode("once")} />
            <RunTypeCard active={mode === "repeat"} icon={<Repeat2 size={24} />} title="반복 스케줄" desc="정해진 주기로 반복 실행합니다." onClick={() => selectMode("repeat")} />
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

function mergeConnectorSourceConfig(currentFields: Array<[string, string]>, responseFields: Array<[string, string]>): Array<[string, string]> {
  const currentByLabel = new Map(currentFields);
  const responseLabels = new Set(responseFields.map(([label]) => label));
  return [
    ...responseFields.map(([label, value]) => {
      const currentValue = currentByLabel.get(label);
      if (isCredentialSourceField(label) && !String(value ?? "").trim() && currentValue) {
        return [label, currentValue] as [string, string];
      }
      return [label, value] as [string, string];
    }),
    ...currentFields.filter(([label]) => !responseLabels.has(label)),
  ];
}

function mergeConnectorAnalysisSourceConfig(result: SourceConnectorAnalysis, currentFields: Array<[string, string]>): SourceConnectorAnalysis {
  const responseConfig = result.draftPatch.source?.sourceConfig;
  if (!responseConfig) return result;
  return {
    ...result,
    draftPatch: {
      ...result.draftPatch,
      source: {
        ...result.draftPatch.source,
        sourceConfig: mergeConnectorSourceConfig(currentFields, responseConfig),
      },
    },
  };
}

const sourceTypeLabels: Record<string, string> = {
  Database: "PostgreSQL",
  "Data Lake": "데이터 레이크",
  "File / S3": "파일 / S3",
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
  "Refresh Preview": "샘플 다시 가져오기",
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

function isCredentialSourceField(label: string) {
  return /(access key|secret key|password|auth token|token|private key)/i.test(label);
}

function publicSourceLog(value: string) {
  return value
    .replace(/^MinIO\/S3 reachable:\s*(\d+)\s*objects?$/i, "S3 호환 스토리지 연결 성공: 오브젝트 $1개")
    .replace(/^MinIO\/S3 reachable:\s*(.+?)\s*\((\d+)\s*objects?\)$/i, "S3 호환 스토리지 연결 성공: $1 (오브젝트 $2개)")
    .replace(/^MinIO reachable:\s*(\d+)\s*objects?$/i, "S3 호환 스토리지 연결 성공: 오브젝트 $1개")
    .replace(/^REST API reachable$/i, "REST API 연결 성공")
    .replace(/^REST API reachable:\s*(.+)$/i, "REST API 연결 성공: $1")
    .replace(/^PostgreSQL reachable:\s*(.+)$/i, "PostgreSQL 연결 성공: $1")
    .replace(/^MongoDB reachable:\s*(.+)$/i, "MongoDB 연결 성공: $1")
    .replace(/^Data Lake reachable:\s*(\d+)\s*objects?$/i, "데이터 레이크 연결 성공: 오브젝트 $1개")
    .replace(/^Kafka topic reachable:\s*(.+)$/i, "Kafka 토픽 연결 성공: $1")
    .replace(/^Source connection test is required before review\.$/i, "검토 전에 소스 연결 테스트가 필요합니다.")
    .replace(/^Connection test is required before review\.$/i, "검토 전에 연결 테스트가 필요합니다.")
    .replace(/^Bounded sample from\s+(.+)$/i, "$1에서 가져온 제한 샘플")
    .replace(/^Listed\s+(\d+)\s+objects?\s+from\s+MinIO\/S3$/i, "S3 오브젝트 $1개 목록 조회")
    .replace(/^source units detected:\s*(\d+)$/i, "소스 단위 감지: $1개")
    .replace(/^bounded sample fetched:\s*(.+)$/i, "제한 샘플 조회: $1")
    .replace(/^profile snapshot inferred:\s*(\d+)\s*fields?,\s*(\d+)\s*sample rows?$/i, "프로파일 스냅샷 추론: $1개 필드, 샘플 행 $2개")
    .replace(/^profile snapshot inferred:\s*(\d+)\s*fields?$/i, "프로파일 스냅샷 추론: $1개 필드")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function publicSchemaSummary(value: string) {
  return value
    .replace(/^MinIO\/S3 reachable\s*-\s*schema inference pending\s*\((\d+)\s*objects?\)$/i, "S3 호환 스토리지 연결 성공 · 스키마 추론 대기 (오브젝트 $1개)")
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
  if (mode === "manual") return "스케줄 없음";
  if (mode === "once") return `${formatDateTimeLocalLabel(onceDateTime)} 예약 1회 실행`;
  if (normalizedRepeat.frequency === "hourly") return `매시간 ${normalizedRepeat.minute}분`;
  if (normalizedRepeat.frequency === "daily") return `매일 ${normalizedRepeat.time}`;
  if (normalizedRepeat.frequency === "custom") return `커스텀: ${normalizedRepeat.cron}`;
  return `매주 ${normalizedRepeat.day}요일 ${normalizedRepeat.time}`;
}

function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("수동") || label.includes("스케줄 없음")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}

function parseOnceScheduleLabel(label: string) {
  if (!label.includes("1회")) return DEFAULT_ONCE_DATE_TIME;
  return normalizeDateTimeLocal(label.replace(/\s*(예약\s*)?1회 실행\s*$/, "").trim());
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

const PERMISSION_ACCESS_ITEMS = ["조회", "수정", "실행", "관리"] as const;
type PermissionAccessItem = (typeof PERMISSION_ACCESS_ITEMS)[number];

const PERMISSION_ROLES: Array<{ access: readonly PermissionAccessItem[]; checked: boolean; name: string; note: string }> = [
  { name: "Data Engineer Group", access: PERMISSION_ACCESS_ITEMS, checked: true, note: "파이프라인 운영 및 장애 대응 권한" },
  { name: "Data Analyst Group", access: ["조회", "실행"] as const, checked: true, note: "분석 업무용 표준 접근 권한" },
  { name: "ML Team", access: ["조회", "실행"] as const, checked: false, note: "RAG 인덱스 검증 후 확장 예정" },
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
    "File / S3": { desc: "S3 버킷과 텍스트 샘플 조회", icon: <HardDrive size={18} />, label: "파일 / S3", status: "실제 연결" },
    PostgreSQL: { desc: "테이블 목록, 샘플 행, 스키마 추론", icon: <Database size={18} />, label: "PostgreSQL", status: "실제 연결" },
    MongoDB: { desc: "컬렉션 목록, 문서 샘플, 중첩 필드 추론", icon: <LayoutGrid size={18} />, label: "MongoDB", status: "실제 연결" },
    "REST API": { desc: "HTTP 응답 샘플을 백엔드에서 수집", icon: <FileText size={18} />, label: "REST API", status: "실제 연결" },
    "Data Lake": { desc: "S3 경로의 Parquet 오브젝트 목록", icon: <Table2 size={18} />, label: "데이터 레이크", status: "목록 조회" },
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
      title: "S3 소스 설정",
      description: "S3 또는 S3 호환 오브젝트 스토리지에서 버킷, 프리픽스, 제한 샘플을 조회합니다.",
      fields: [
        ["Storage Provider", "S3 Compatible"],
        ["Endpoint URL", "http://127.0.0.1:9000"],
        ["Region", "us-east-1"],
        ["Bucket / Stage Name", "m3-raw"],
        ["Path / Prefix", "nyc_taxi/csv/"],
        ["Access Key", ""],
        ["Secret Key", ""],
        ["Use Path Style", "true"],
        ["File Type", "CSV (Comma Separated)"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Bucket", "Not listed"], ["샘플 프로파일", "Pending"]],
      logs: ["S3 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 제한 샘플을 가져옵니다."],
      assetsTitle: "감지된 S3 오브젝트",
      assets: [],
      previewTitle: "제한 샘플 미리보기",
      previewNote: "미리보기 데이터 없음 · S3 연결 테스트를 실행하세요.",
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
        ["Access Key", ""],
        ["Secret Key", ""],
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
    ["인증 방식", activeSourceType === "File / S3" ? "S3 호환 액세스 키" : "백엔드 커넥터"],
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
      const result = mergeConnectorAnalysisSourceConfig(
        publicConnectorAnalysis(await testSourceConnector(activeSourceType, editableFields)),
        editableFields,
      );
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
  const sourceFlowSteps = activeSourceType === "MongoDB"
    ? ["연결 정보 입력", "데이터베이스 선택", "컬렉션 선택", "문서/필드 확인"]
    : ["연결 정보 입력", "연결 검증", "샘플/필드 확인"];
  const completeSourceSelection = () => {
    if (connectionStatus !== "success") {
      onNotify("연결 검증을 먼저 성공시켜야 데이터 선택을 완료할 수 있습니다.");
      return;
    }
    applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
    onNext();
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
        <PageTitle title="소스 연결" description="소스를 고른 뒤 연결 정보, 데이터 선택, 샘플 확인 순서로 검증합니다." />
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
              <div className="source-flow-steps" aria-label="소스 연결 단계">
                {sourceFlowSteps.map((step, index) => (
                  <span className={index === 0 || connectionStatus === "success" ? "active" : ""} key={step}>{index + 1}. {step}</span>
                ))}
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
                <button className="primary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>{connectionStatus === "success" ? "연결 다시 테스트" : "연결만 테스트"}</button>
              </div>
            </div>
          </div>
        </section>
        <div className="hegun-source-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>연결 검증 결과</h2>
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
          <button className="secondary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>연결 다시 테스트</button>
          <button className="primary-button" type="button" disabled={connectionStatus !== "success"} onClick={completeSourceSelection}>데이터 선택 완료 · 스키마로 이동</button>
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

function getFlattenDepthOptions(columns: SchemaColumnDraft[]) {
  const maxDepth = Math.max(
    1,
    ...columns.map((column) => column.sourceName.split(".").filter(Boolean).length),
  );
  const cappedDepth = Math.min(maxDepth, 5);
  return Array.from({ length: cappedDepth }, (_, index) => index + 1);
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
  const flattenDepthOptions = getFlattenDepthOptions(schemaColumns);
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
    const allowedDepths = getFlattenDepthOptions(schemaColumns);
    const maxAllowedDepth = allowedDepths.at(-1) ?? 1;
    const normalizedDepth = Math.min(Math.max(nextDepth, 1), maxAllowedDepth);
    const base = getFlattenBaseSchema();
    const maxPathSegments = nextFlattenObjects ? normalizedDepth : 1;
    const nextSchema = compactSchemaByPathDepth(base.columns, base.sampleRows, maxPathSegments);
    setFlattenObjects(nextFlattenObjects);
    setFlattenDepth(normalizedDepth);
    patchSchemaColumns(nextSchema.columns, nextSchema.sampleRows);
    setSelectedSchemaIndex(0);
    onAction(
      nextFlattenObjects ? "etl.schema.flatten_enabled" : "etl.schema.flatten_disabled",
      "/api/etl/schema-inference/flattening",
      draft.source.sourceLabel || "schema",
    );
    onNotify(nextFlattenObjects
      ? `중첩 객체를 최대 ${normalizedDepth}단계까지 출력 컬럼으로 펼쳤습니다.`
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
      const result = mergeConnectorAnalysisSourceConfig(
        publicConnectorAnalysis(await testSourceConnector(draft.source.sourceType, sourceConfig)),
        sourceConfig,
      );
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
                  {flattenDepthOptions.map((depth) => (
                    <button
                      className={depth === Math.min(flattenDepth, flattenDepthOptions.at(-1) ?? flattenDepth) ? "active" : ""}
                      disabled={!hasInferredSchema || !flattenObjects}
                      key={depth}
                      onClick={() => applyFlattenSettings(true, depth)}
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
            <RefreshCw size={15} /> {isRecheckingSchema ? "스키마 확인 중" : "이 샘플 범위로 스키마 다시 추론"}
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
        <span>2/3 단계 · {hasInferredSchema ? approvedSummary : inferredSummary}</span>
        <button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={confirmCurrentSchema}>스키마 확정 후 다음</button>
        <button className="ghost-button" type="button" onClick={saveSchemaDraft}>설정 저장</button>
      </section>
    </div>
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
  version: 2;
};

const RULE_METRIC_DEFS: Array<{ icon: React.ReactNode; label: string; value: (stats: RuleStats) => string }> = [
  { icon: <SlidersHorizontal size={18} />, label: "전체 규칙", value: (stats) => String(stats.totalRules) },
  { icon: <Database size={18} />, label: "영향 컬럼", value: (stats) => String(stats.affectedColumns) },
  { icon: <Clock3 size={18} />, label: "변환 적용률", value: (stats) => `${stats.coverage}%` },
  { icon: <Info size={18} />, label: "유효하지 않은 행", value: (stats) => String(stats.invalidRows) },
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
    title: "변환",
    description: "Lake 저장 전에 필드를 정리하고 타입을 맞춥니다.",
    icon: <SlidersHorizontal size={20} />,
  },
  {
    id: "quality",
    label: "품질 체크",
    title: "품질 체크",
    description: "저장 전 검증 규칙으로 데이터 품질을 확인합니다.",
    icon: <ShieldCheck size={20} />,
  },
];

const FALLBACK_RECIPE_STEPS: RecipeStep[] = [{
  id: "1",
  input: "value",
  onError: "Warn",
  operation: "Lowercase + Trim",
  output: "value",
  params: "lower(), trim()",
}];
const FALLBACK_QUALITY_RULES: QualityRule[] = [{
  failureAction: "Warn",
  id: "qr-required-value",
  severity: "Warning",
  targetColumn: "value",
  validationType: "Not Null",
}];
const TRANSFORM_OPERATION_OPTIONS = ["Extract JSONPath", "Lowercase + Trim", "Cast Decimal", "Parse Timestamp", "Mask"] as const;
const TRANSFORM_FAILURE_POLICY_OPTIONS = ["Warn", "Set Null", "Drop Row", "Fail Run"] as const;
const QUALITY_VALIDATION_OPTIONS: Array<QualityRule["validationType"]> = ["Not Null", "Regex Match", "Range Check", "Accepted Values"];
const QUALITY_SEVERITY_OPTIONS: Array<QualityRule["severity"]> = ["Warning", "Error"];
const QUALITY_FAILURE_ACTION_OPTIONS: Array<QualityRule["failureAction"]> = ["Warn", "Quarantine", "Fail Run", "Drop Row", "Set Null"];

const TRANSFORM_OPERATION_LABELS: Record<TransformOperation, string> = {
  "Cast Decimal": "숫자 타입 변환",
  "Extract JSONPath": "JSON 경로 추출",
  "Lowercase + Trim": "소문자/공백 정리",
  Mask: "마스킹",
  "Parse Timestamp": "시간 타입 변환",
};

const FAILURE_ACTION_LABELS: Record<TransformFailurePolicy | QualityRule["failureAction"], string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 실패 처리",
  Quarantine: "격리",
  "Set Null": "Null로 대체",
  Warn: "경고만 표시",
};

const QUALITY_VALIDATION_LABELS: Record<QualityRule["validationType"], string> = {
  "Accepted Values": "허용값 검사",
  "Not Null": "필수값 검사",
  "Range Check": "범위 검사",
  "Regex Match": "정규식 검사",
};

const QUALITY_SEVERITY_LABELS: Record<QualityRule["severity"], string> = {
  Error: "오류",
  Warning: "경고",
};

const QUALITY_FAILURE_REASON_LABELS: Record<string, string> = {
  "Email format check failed": "이메일 형식 검사 실패",
  "Missing required value": "필수값 누락",
  "Numeric range check failed": "숫자 범위 검사 실패",
  "Value is outside accepted set": "허용값 목록 밖의 값",
};
const DEFAULT_PYTHON_TRANSFORM_CODE = `def transform(row):
    row["normalized_value"] = str(row.get("value", "")).strip().lower()
    return row`;

function transformOperationLabel(operation: string) {
  if (operation === "Python Code") return "Python 코드";
  return TRANSFORM_OPERATION_LABELS[operation as TransformOperation] ?? operation;
}

function ruleParamLabel(value: string) {
  if (value.includes("\n")) return `${value.split("\n").length}줄 코드`;
  return value;
}

function failureActionLabel(action: string) {
  return FAILURE_ACTION_LABELS[action as TransformFailurePolicy | QualityRule["failureAction"]] ?? action;
}

function qualityValidationLabel(validationType: string) {
  return QUALITY_VALIDATION_LABELS[validationType as QualityRule["validationType"]] ?? validationType;
}

function qualitySeverityLabel(severity: string) {
  return QUALITY_SEVERITY_LABELS[severity as QualityRule["severity"]] ?? severity;
}

function qualityFailureReasonLabel(reason: string) {
  return QUALITY_FAILURE_REASON_LABELS[reason] ?? reason;
}
const QUALITY_DRAFT_PREVIEW_ID_PREFIX = "qr-draft-preview-";
type TransformOperation = (typeof TRANSFORM_OPERATION_OPTIONS)[number];
type TransformFailurePolicy = (typeof TRANSFORM_FAILURE_POLICY_OPTIONS)[number];

const DEFAULT_RULE_STEP_BY_CATEGORY: Record<RuleCategory, RuleStepDraft> = {
  transform: { input: "raw_value", operation: "Extract JSONPath", output: "normalized_value", params: "$.value", onError: "Set Null" },
  quality: { input: "user_email", operation: "Regex Match", output: "quality_status", params: "email pattern", onError: "Warn" },
};

const TRANSFORM_QUALITY_PREVIEW_CACHE_KEY = "asklake.transformQualityPreviewCache";
const TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION = 2;

function createDefaultTransformQualityPreviewCache(
  datasetId: string,
  recipeSteps: RecipeStep[],
  qualityRules: QualityRule[],
  validation: TransformQualityValidationResult,
): TransformQualityPreviewCache {
  return {
    datasetId,
    invalidRows: validation.failedRows,
    qualityRules,
    recipeSteps,
    selectedPreviewStepId: recipeSteps[0]?.id ?? "",
    selectedQualityRuleId: qualityRules[0]?.id ?? "",
    savedAt: new Date().toISOString(),
    validation,
    version: TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION,
  };
}

function readTransformQualityPreviewCache(defaultCache: TransformQualityPreviewCache): TransformQualityPreviewCache {
  if (typeof window === "undefined") return defaultCache;
  try {
    const stored = window.localStorage.getItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY);
    if (!stored) return defaultCache;
    const parsed = JSON.parse(stored) as Partial<TransformQualityPreviewCache>;
    if (parsed.version !== TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION || parsed.datasetId !== defaultCache.datasetId || !Array.isArray(parsed.recipeSteps) || !Array.isArray(parsed.qualityRules)) {
      return defaultCache;
    }
    const qualityRules = parsed.qualityRules.filter((rule) => !rule.id.startsWith(QUALITY_DRAFT_PREVIEW_ID_PREFIX));
    const selectedQualityRuleId = qualityRules.some((rule) => rule.id === parsed.selectedQualityRuleId)
      ? parsed.selectedQualityRuleId ?? ""
      : qualityRules[0]?.id ?? defaultCache.selectedQualityRuleId;
    return {
      ...defaultCache,
      ...parsed,
      invalidRows: Array.isArray(parsed.invalidRows) ? parsed.invalidRows : defaultCache.invalidRows,
      qualityRules: qualityRules.length > 0 ? qualityRules : defaultCache.qualityRules,
      recipeSteps: parsed.recipeSteps.length > 0 ? parsed.recipeSteps : defaultCache.recipeSteps,
      selectedQualityRuleId,
      validation: parsed.validation ?? defaultCache.validation,
    };
  } catch {
    return defaultCache;
  }
}

function writeTransformQualityPreviewCache(cache: TransformQualityPreviewCache) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY, JSON.stringify(cache));
}

function schemaColumnOutputName(column: SchemaColumnDraft) {
  return (column.targetName || column.sourceName || "column").trim();
}

function getRuleSourceColumns(columns: SchemaColumnDraft[]) {
  return columns.map(schemaColumnOutputName).filter(Boolean);
}

function getRuleDatasetId(draft: DraftPipeline) {
  return [
    draft.source.sourceType,
    draft.source.sourceLabel,
    draft.schema.schemaFingerprint,
    draft.schema.columns.map((column) => schemaColumnOutputName(column)).join(","),
  ].filter(Boolean).join("|");
}

function schemaRowsToRuleSampleRows(columns: SchemaColumnDraft[], rows: string[][]): TransformQualitySampleRow[] {
  const outputNames = getRuleSourceColumns(columns);
  return rows.map((row, rowIndex) => {
    const nextRow: TransformQualitySampleRow = { row_id: String(rowIndex + 1) };
    columns.forEach((column, columnIndex) => {
      const value = row[columnIndex] ?? "";
      const outputName = schemaColumnOutputName(column);
      if (outputName) nextRow[outputName] = value;
      if (column.sourceName && column.sourceName !== outputName) nextRow[column.sourceName] = value;
    });
    if (!nextRow.row_id && outputNames[0]) nextRow.row_id = nextRow[outputNames[0]] ?? String(rowIndex + 1);
    return nextRow;
  });
}

function isJsonLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return probe.includes("json") || probe.includes("payload") || probe.includes("metadata") || probe.includes("profile");
}

function isTimestampLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return probe.includes("timestamp") || probe.includes("datetime") || probe.includes("_at") || probe.endsWith(" date") || probe.includes("date");
}

function isNumericLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return ["int", "long", "float", "double", "decimal", "number", "numeric"].some((token) => probe.includes(token));
}

function isEmailLikeColumn(column: SchemaColumnDraft) {
  return `${column.sourceName} ${column.targetName}`.toLowerCase().includes("email");
}

function isCountryLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName}`.toLowerCase();
  return probe.includes("country") || probe.includes("region");
}

function buildDefaultRecipeSteps(draft: DraftPipeline): RecipeStep[] {
  const columns = draft.schema.columns;
  if (columns.length === 0) return FALLBACK_RECIPE_STEPS.slice(0, 1);
  const candidates: RecipeStep[] = [];
  const addStep = (column: SchemaColumnDraft, operation: TransformOperation, output?: string, params?: string, onError: TransformFailurePolicy = "Warn") => {
    const input = schemaColumnOutputName(column);
    if (!input || candidates.some((step) => step.input === input && step.operation === operation)) return;
    candidates.push({
      id: String(candidates.length + 1),
      input,
      onError,
      operation,
      output: output ?? getRecommendedOutputColumn(operation, input),
      params: params ?? getDefaultParamForOperation(operation),
    });
  };

  const jsonColumn = columns.find(isJsonLikeColumn);
  if (jsonColumn) addStep(jsonColumn, "Extract JSONPath", `${schemaColumnOutputName(jsonColumn)}_value`, "$.value", "Set Null");
  const emailColumn = columns.find(isEmailLikeColumn);
  if (emailColumn) addStep(emailColumn, "Lowercase + Trim");
  const numericColumn = columns.find(isNumericLikeColumn);
  if (numericColumn) addStep(numericColumn, "Cast Decimal", schemaColumnOutputName(numericColumn), "double");
  const timestampColumn = columns.find(isTimestampLikeColumn);
  if (timestampColumn) addStep(timestampColumn, "Parse Timestamp", `${schemaColumnOutputName(timestampColumn)}_ts`, "UTC", "Set Null");
  const stringColumn = columns.find((column) => !isNumericLikeColumn(column) && !isTimestampLikeColumn(column) && !isJsonLikeColumn(column));
  if (candidates.length === 0 && stringColumn) addStep(stringColumn, "Lowercase + Trim");

  return candidates.length > 0 ? candidates.slice(0, 5) : FALLBACK_RECIPE_STEPS.slice(0, 1);
}

function buildDefaultQualityRules(draft: DraftPipeline): QualityRule[] {
  const columns = draft.schema.columns;
  if (columns.length === 0) return FALLBACK_QUALITY_RULES.slice(0, 1);
  const rules: QualityRule[] = [];
  const addRule = (
    column: SchemaColumnDraft | undefined,
    validationType: QualityRule["validationType"],
    severity: QualityRule["severity"] = "Warning",
    failureAction: QualityRule["failureAction"] = "Warn",
  ) => {
    if (!column) return;
    const targetColumn = schemaColumnOutputName(column);
    if (!targetColumn || rules.some((rule) => rule.targetColumn === targetColumn && rule.validationType === validationType)) return;
    rules.push({
      failureAction,
      id: `qr-${rules.length + 1}-${normalizeTargetColumnName(targetColumn)}`,
      severity,
      targetColumn,
      validationType,
    });
  };

  addRule(columns.find((column) => !column.nullable) ?? columns[0], "Not Null", "Error", "Fail Run");
  addRule(columns.find(isEmailLikeColumn), "Regex Match", "Warning", "Quarantine");
  addRule(columns.find(isNumericLikeColumn), "Range Check", "Warning", "Quarantine");
  addRule(columns.find(isCountryLikeColumn), "Accepted Values", "Warning", "Warn");
  return rules.length > 0 ? rules.slice(0, 5) : FALLBACK_QUALITY_RULES.slice(0, 1);
}

function typeForOutputColumn(name: string, steps: RecipeStep[], schemaColumns: SchemaColumnDraft[], previewRows: TransformQualitySampleRow[]) {
  const sourceColumn = schemaColumns.find((column) => schemaColumnOutputName(column) === name || column.sourceName === name);
  const producingStep = steps.find((step) => step.output === name);
  if (producingStep) {
    const operation = producingStep.operation.toLowerCase();
    if (operation.includes("timestamp") || operation.includes("date")) return "timestamp";
    if (operation.includes("decimal") || operation.includes("cast")) return "double";
    if (operation.includes("json")) return "string";
  }
  if (sourceColumn) return sourceColumn.type;
  const sampleValue = previewRows.map((row) => row[name]).find((value) => value !== undefined && value !== "");
  if (sampleValue && Number.isFinite(Number(sampleValue))) return "double";
  return "string";
}

function buildTransformOutputColumns(
  steps: RecipeStep[],
  schemaColumns: SchemaColumnDraft[],
  previewRows: TransformQualitySampleRow[],
) {
  const baseColumns = getRuleSourceColumns(schemaColumns);
  const previewColumns = previewRows[0] ? Object.keys(previewRows[0]).filter((column) => column !== "row_id") : [];
  const columns = Array.from(new Set([...baseColumns, ...steps.map((step) => step.output.trim()).filter(Boolean), ...previewColumns]));
  return columns.map((column) => [column, typeForOutputColumn(column, steps, schemaColumns, previewRows)] as [string, string]);
}

type RuleStats = {
  affectedColumns: number;
  coverage: number;
  invalidRows: number;
  qualityRules: number;
  transformSteps: number;
  totalRules: number;
};

function getRuleStats(steps: RecipeStep[], qualityRules: QualityRule[], invalidRows: number, baseColumnCount: number): RuleStats {
  const affectedColumns = new Set(steps.flatMap((step) => [step.input, step.output].filter(Boolean)));
  return {
    affectedColumns: Math.max(affectedColumns.size, baseColumnCount),
    coverage: baseColumnCount > 0 ? Math.min(100, Math.round((affectedColumns.size / Math.max(baseColumnCount, 1)) * 100)) : 0,
    invalidRows,
    qualityRules: qualityRules.length,
    transformSteps: steps.length,
    totalRules: steps.length + qualityRules.length,
  };
}

function formatTransformSummary(stats: RuleStats) {
  return `변환 단계 ${stats.transformSteps}개 · 영향 컬럼 ${stats.affectedColumns}개 · 적용률 ${stats.coverage}%`;
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
    input: step.input,
    kind: getTransformStepKind(step.operation),
    label: `${transformOperationLabel(step.operation)}: ${step.input} -> ${step.output}`,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: step.params,
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
    failureAction: rule.failureAction,
    id: rule.id,
    kind: toQualityRuleKind(rule.validationType),
    severity: rule.severity,
    targetColumn: rule.targetColumn,
    validationType: rule.validationType,
  }));
}

function toDraftInvalidRows(rows: TransformQualityInvalidRow[]) {
  return rows.map((row) => [row.row, row.column, row.reason, row.action]);
}

function formatInvalidRowsPreviewSummary(invalidRowCount: number, exampleCount: number) {
  if (invalidRowCount === exampleCount) return `유효하지 않은 행 ${invalidRowCount}개`;
  return `유효하지 않은 행 ${invalidRowCount}개 · 예시 ${exampleCount}개 표시`;
}

function getWorkingColumns(steps: RecipeStep[], sourceColumns: string[]) {
  return Array.from(new Set([
    ...sourceColumns,
    ...steps.map((step) => step.output.trim()).filter(Boolean),
  ]));
}

function getDerivedColumns(steps: RecipeStep[], sourceColumnSet: Set<string>) {
  return Array.from(new Set(
    steps
      .map((step) => step.output.trim())
      .filter((column) => column && !sourceColumnSet.has(column)),
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
  const ruleSampleRows = useMemo(() => schemaRowsToRuleSampleRows(draft.schema.columns, draft.schema.sampleRows), [draft.schema.columns, draft.schema.sampleRows]);
  const sourceColumns = useMemo(() => getRuleSourceColumns(draft.schema.columns), [draft.schema.columns]);
  const sourceColumnSet = useMemo(() => new Set(sourceColumns), [sourceColumns]);
  const datasetId = useMemo(() => getRuleDatasetId(draft), [draft]);
  const defaultRecipeSteps = useMemo(() => buildDefaultRecipeSteps(draft), [draft]);
  const defaultQualityRules = useMemo(() => buildDefaultQualityRules(draft), [draft]);
  const defaultPreviewCache = useMemo(() => {
    const validation = runTransformQualitySamplePreview(defaultRecipeSteps, defaultQualityRules, ruleSampleRows).validation;
    return createDefaultTransformQualityPreviewCache(datasetId, defaultRecipeSteps, defaultQualityRules, validation);
  }, [datasetId, defaultQualityRules, defaultRecipeSteps, ruleSampleRows]);
  const [previewCache] = useState(() => readTransformQualityPreviewCache(defaultPreviewCache));
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
  const [pythonTransformCode, setPythonTransformCode] = useState(DEFAULT_PYTHON_TRANSFORM_CODE);
  const [pythonPreviewOpen, setPythonPreviewOpen] = useState(false);
  const workingColumns = useMemo(() => getWorkingColumns(recipeSteps, sourceColumns), [recipeSteps, sourceColumns]);
  const derivedColumns = useMemo(() => getDerivedColumns(recipeSteps, sourceColumnSet), [recipeSteps, sourceColumnSet]);
  const runnerResult = useMemo(() => runTransformQualitySamplePreview(recipeSteps, qualityRules, ruleSampleRows), [qualityRules, recipeSteps, ruleSampleRows]);
  const previewRunnerResult = useMemo(() => {
    const previewSteps = draftPreviewStep?.id === selectedPreviewStepId ? replaceOrAppendById(recipeSteps, draftPreviewStep) : recipeSteps;
    return runTransformQualitySamplePreview(previewSteps, qualityRules, ruleSampleRows);
  }, [draftPreviewStep, qualityRules, recipeSteps, ruleSampleRows, selectedPreviewStepId]);
  const qualityPreviewRules = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId ? replaceOrAppendById(qualityRules, draftPreviewQualityRule) : qualityRules
  ), [draftPreviewQualityRule, qualityRules, selectedQualityRuleId]);
  const qualityPreviewRunnerResult = useMemo(() => (
    draftPreviewQualityRule?.id === selectedQualityRuleId
      ? runTransformQualitySamplePreview(recipeSteps, qualityPreviewRules, ruleSampleRows)
      : runnerResult
  ), [draftPreviewQualityRule, qualityPreviewRules, recipeSteps, ruleSampleRows, runnerResult, selectedQualityRuleId]);
  const validationResult = runnerResult.validation;
  const invalidRows = validationResult.failedRows;
  const invalidRowCount = validationResult.invalidRowCount;
  const ruleStats = getRuleStats(recipeSteps, qualityRules, invalidRowCount, sourceColumns.length);
  const selectedPreviewStep = (draftPreviewStep?.id === selectedPreviewStepId ? draftPreviewStep : undefined)
    ?? recipeSteps.find((step) => step.id === selectedPreviewStepId)
    ?? recipeSteps[0]
    ?? defaultRecipeSteps[0];
  const selectedQualityRule = draftPreviewQualityRule?.id === selectedQualityRuleId
    ? draftPreviewQualityRule
    : qualityRules.find((rule) => rule.id === selectedQualityRuleId) ?? qualityRules[0] ?? defaultQualityRules[0];
  const selectedQualityInvalidRows = getQualityRuleInvalidRows(qualityPreviewRunnerResult.validation.failedRows, selectedQualityRule);
  const invalidRowsPreviewSummary = formatInvalidRowsPreviewSummary(invalidRowCount, invalidRows.length);
  const cachedSelectedQualityRuleId = qualityRules.some((rule) => rule.id === selectedQualityRuleId)
    ? selectedQualityRuleId
    : qualityRules[0]?.id ?? defaultQualityRules[0]?.id ?? "";
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
      return `${recipeSteps.findIndex((step) => step.id === editingTransformStep.id) + 1}번 변환 단계`;
    }
    if (selectedRuleCategory === "quality" && editingQualityRule) {
      return `${qualityRules.findIndex((rule) => rule.id === editingQualityRule.id) + 1}번 품질 규칙`;
    }
    return undefined;
  }, [editingQualityRule, editingTransformStep, qualityRules, recipeSteps, selectedRuleCategory]);

  useEffect(() => {
    writeTransformQualityPreviewCache({
      datasetId,
      invalidRows,
      qualityRules,
      recipeSteps,
      selectedPreviewStepId,
      selectedQualityRuleId: cachedSelectedQualityRuleId,
      savedAt: new Date().toISOString(),
      validation: validationResult,
      version: TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION,
    });
  }, [cachedSelectedQualityRuleId, datasetId, invalidRows, qualityRules, recipeSteps, selectedPreviewStepId, validationResult]);

  const buildRuleDraftPatch = (steps: RecipeStep[] = recipeSteps, rules: QualityRule[] = qualityRules): DraftPipelinePatch => {
    const nextRunnerResult = steps === recipeSteps && rules === qualityRules ? runnerResult : runTransformQualitySamplePreview(steps, rules, ruleSampleRows);
    const nextValidation = nextRunnerResult.validation;
    const nextStats = getRuleStats(steps, rules, nextValidation.invalidRowCount, sourceColumns.length);
    return {
      transform: {
        outputColumns: buildTransformOutputColumns(steps, draft.schema.columns, nextRunnerResult.transformedRows),
        steps: toDraftTransformSteps(steps),
        summary: formatTransformSummary(nextStats),
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
    onAction("etl.transform.tested", "/api/etl/transform-rules/test", draft.source.sourceLabel || draft.target.datasetName || "rule-preview");
    applyRuleDraft();
    onNotify(`${ruleStats.totalRules}개 rule 샘플 테스트가 완료되었습니다.`);
  };

  const ruleAction = (action: string, path: string, targetId = draft.source.sourceLabel || draft.target.datasetName || "rule-preview") => {
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
  const previewPythonTransform = () => {
    setPythonPreviewOpen(true);
    ruleAction("etl.rules.python_previewed", "/api/etl/rules/python/preview");
    onNotify("Python 코드 샘플 결과를 표시했습니다.");
  };
  const applyPythonTransform = () => {
    const code = pythonTransformCode.trim();
    if (!code) {
      onNotify("적용할 Python 코드를 입력하세요.");
      return;
    }
    const nextStepNumber = String(Math.max(...recipeSteps.map((step) => Number(step.id)), 0) + 1);
    const nextStep: RecipeStep = {
      id: nextStepNumber,
      input: sourceColumns[0] ?? "row",
      onError: "Fail Run",
      operation: "Python Code",
      output: "python_output",
      params: code,
    };
    const nextSteps = [...recipeSteps, nextStep];
    setRecipeSteps(nextSteps);
    setSelectedPreviewStepId(nextStep.id);
    setDraftPreviewStep(null);
    setDraftPreviewQualityRule(null);
    applyRuleDraft(nextSteps);
    ruleAction("etl.rules.python_applied", "/api/etl/rules/python");
    onNotify("Python 코드 변환 단계를 추가했습니다.");
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
            baseColumnSet={sourceColumnSet}
            category={selectedRuleCategory}
            editingDraft={editingDraft}
            editingLabel={editingLabel}
            qualityPresets={defaultQualityRules}
            transformPresets={defaultRecipeSteps}
            workingColumns={workingColumns}
            onAction={ruleAction}
            onAddStep={addRuleDraft}
            onCancelEdit={cancelRuleEdit}
            onPreviewStep={previewDraftStep}
            onUpdateStep={selectedRuleCategory === "quality" ? updateQualityRule : updateRecipeStep}
          />
          {selectedRuleCategory === "transform" && (
            <PythonTransformPanel
              code={pythonTransformCode}
              previewOpen={pythonPreviewOpen}
              sampleColumns={workingColumns}
              sampleRows={runnerResult.transformedRows}
              onApply={applyPythonTransform}
              onCodeChange={(code) => {
                setPythonTransformCode(code);
                setPythonPreviewOpen(false);
              }}
              onPreview={previewPythonTransform}
            />
          )}
          {selectedRuleCategory === "quality" ? (
            <QualityPreviewAnalysis invalidRows={selectedQualityInvalidRows} rule={selectedQualityRule} sampleRows={qualityPreviewRunnerResult.validation.sampleRows} onAction={ruleAction} />
          ) : (
            <StepPreviewAnalysis
              preview={previewRunnerResult.previewByStepId[selectedPreviewStep.id]}
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
        초안 변경 있음
      </div>
    </div>
  );
}

function RuleCategoryTabs({ activeCategory, onSelect }: { activeCategory: RuleCategory; onSelect: (category: RuleCategory) => void }) {
  return (
    <section className="hegun-rule-mode-switcher" aria-label="처리 규칙 모드">
      <div className="hegun-rule-category-list" role="tablist" aria-label="처리 규칙 모드">
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
        <span>샘플로 먼저 확인하고 실행 시 전체 데이터에 적용합니다.</span>
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
        <h2>변환 규칙 단계</h2>
        <p>규칙은 샘플 데이터에 먼저 순서대로 적용되고, 실행 시 전체 데이터에 적용됩니다.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table">
          <thead>
            <tr>
              <th>단계</th>
              <th>입력</th>
              <th>작업</th>
              <th>출력</th>
              <th>옵션</th>
              <th>오류 처리</th>
              <th>작업</th>
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
                <td>{transformOperationLabel(row.operation)}</td>
                <td><span className="hegun-data-chip muted">{row.output}</span></td>
                <td>{ruleParamLabel(row.params)}</td>
                <td><span className={`hegun-error-pill ${row.onError.toLowerCase().replace(/\s/g, "-")}`}>{failureActionLabel(row.onError)}</span></td>
                <td>
                  <div className="hegun-row-actions">
                    <button aria-label={`${stepNumber}번 단계 수정`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onEdit(row);
                    }}>
                      <Pencil size={15} />
                    </button>
                    <button aria-label={`${stepNumber}번 단계 제거`} type="button" onClick={(event) => {
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
        <h2>품질 검증 규칙</h2>
        <p>검증 규칙은 샘플 행에 먼저 적용하고 실행 전 차단, 격리, 경고 여부를 결정합니다.</p>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-recipe-table hegun-quality-table">
          <thead>
            <tr>
              <th>규칙</th>
              <th>컬럼</th>
              <th>검증</th>
              <th>심각도</th>
              <th>실패 처리</th>
              <th>상태</th>
              <th>작업</th>
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
                <td>{qualityValidationLabel(rule.validationType)}</td>
                <td><span className={`hegun-error-pill ${rule.severity.toLowerCase()}`}>{qualitySeverityLabel(rule.severity)}</span></td>
                <td><span className={`hegun-error-pill ${rule.failureAction.toLowerCase().replace(/\s/g, "-")}`}>{failureActionLabel(rule.failureAction)}</span></td>
                <td>{rule.severity === "Error" ? "차단" : "모니터링"}</td>
                <td>
                  <div className="hegun-row-actions">
                    <button aria-label={`${index + 1}번 품질 규칙 수정`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      onEdit(rule);
                    }}>
                      <Pencil size={15} />
                    </button>
                    <button aria-label={`${index + 1}번 품질 규칙 제외`} type="button" onClick={(event) => {
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
  baseColumnSet,
  category,
  editingDraft,
  editingLabel,
  onAddStep,
  onAction,
  onCancelEdit,
  onPreviewStep,
  onUpdateStep,
  qualityPresets,
  transformPresets,
  workingColumns,
}: {
  baseColumnSet: Set<string>;
  category: RuleCategory;
  editingDraft: RuleStepDraft | null;
  editingLabel?: string;
  onAddStep: (draft: RuleStepDraft) => void;
  onAction: RuleActionHandler;
  onCancelEdit: () => void;
  onPreviewStep: (draft: RuleStepDraft) => void;
  onUpdateStep: (draft: RuleStepDraft) => void;
  qualityPresets: QualityRule[];
  transformPresets: RecipeStep[];
  workingColumns: string[];
}) {
  const isTransform = category === "transform";
  const isEditing = Boolean(editingDraft);
  const [collapsed, setCollapsed] = useState(true);
  const defaultPresetId = isTransform ? transformPresets[0]?.id ?? "" : qualityPresets[0]?.id ?? "";
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId);
  const selectedTransformPreset = transformPresets.find((step) => step.id === selectedPresetId) ?? transformPresets[0] ?? FALLBACK_RECIPE_STEPS[0];
  const selectedQualityPreset = qualityPresets.find((rule) => rule.id === selectedPresetId) ?? qualityPresets[0] ?? FALLBACK_QUALITY_RULES[0];
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
  const outputColumnMode = trimmedOutputColumn && baseColumnSet.has(trimmedOutputColumn) ? "inPlace" : "derived";
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
    ? transformPresets.map((step) => ({ id: step.id, label: `${transformOperationLabel(step.operation)}: ${step.input} -> ${step.output}` }))
    : qualityPresets.map((rule) => ({ id: rule.id, label: `${qualityValidationLabel(rule.validationType)}: ${rule.targetColumn} · ${qualitySeverityLabel(rule.severity)} / ${failureActionLabel(rule.failureAction)}` }));
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
      ? "변환 단계 수정"
      : "품질 체크 수정"
    : isTransform
      ? "변환 단계 추가"
      : "품질 체크 추가";
  const builderDescription = isEditing
    ? `${editingLabel ?? "선택한 규칙"} 값을 수정한 뒤 같은 규칙에 저장합니다.`
    : isTransform
      ? "현재 스키마 컬럼을 기준으로 새 변환 규칙을 만듭니다."
      : "실행 전에 적용할 품질 검증 규칙을 만듭니다.";
  const submitLabel = isEditing
    ? isTransform ? "단계 수정" : "검사 수정"
    : isTransform ? "선택 단계 추가" : "선택 검사 추가";

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
        <button className="icon-button hegun-builder-collapse" aria-expanded={!collapsed} aria-label={collapsed ? "추가 영역 열기" : "추가 영역 접기"} type="button" onClick={(event) => {
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
                <span>{isTransform ? "추천 변환 규칙 불러오기" : "추천 품질 규칙 불러오기"}</span>
                <select className="input control-input" value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
                  {presetOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="hegun-rule-field">
              <span>{isTransform ? "입력 컬럼" : "대상 컬럼"}</span>
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
                    {baseColumnSet.has(column) ? column : `${column} (파생)`}
                  </option>
                ))}
              </select>
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "처리 작업" : "검증 규칙"}</span>
              {isTransform ? (
                <select className="input control-input" value={selectedOperation} onChange={(event) => selectTransformOperation(event.target.value as TransformOperation)}>
                  {TRANSFORM_OPERATION_OPTIONS.map((operation) => (
                    <option key={operation} value={operation}>{transformOperationLabel(operation)}</option>
                  ))}
                </select>
              ) : (
                <select className="input control-input" value={selectedValidationType} onChange={(event) => setSelectedValidationType(event.target.value as QualityRule["validationType"])}>
                  {QUALITY_VALIDATION_OPTIONS.map((validationType) => (
                    <option key={validationType} value={validationType}>{qualityValidationLabel(validationType)}</option>
                  ))}
                </select>
              )}
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "출력 컬럼" : "심각도"}</span>
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
                        : "새 파생 컬럼을 생성하고 이후 단계에서 사용할 수 있습니다."
                      : "새 이름을 입력하면 이후 단계에서 사용할 수 있는 파생 컬럼이 됩니다."}
                  </em>
                </div>
              ) : (
                <select className="input control-input" value={selectedSeverity} onChange={(event) => setSelectedSeverity(event.target.value as QualityRule["severity"])}>
                  {QUALITY_SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>{qualitySeverityLabel(severity)}</option>
                  ))}
                </select>
              )}
            </label>
            <label className="hegun-rule-field">
              <span>{isTransform ? "옵션" : "실패 처리"}</span>
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
                    <option key={failureAction} value={failureAction}>{failureActionLabel(failureAction)}</option>
                  ))}
                </select>
              )}
            </label>
            {isTransform && (
              <label className="hegun-rule-field">
                <span>오류 처리</span>
                <select className="input control-input" value={onError} onChange={(event) => setOnError(event.target.value as TransformFailurePolicy)}>
                  {TRANSFORM_FAILURE_POLICY_OPTIONS.map((policy) => (
                    <option key={policy} value={policy}>{failureActionLabel(policy)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="hegun-rule-form-actions">
            {isEditing && <button className="ghost-button" type="button" onClick={cancelEdit}>수정 취소</button>}
            <button className="secondary-button" type="button" onClick={previewDraft}>{isTransform ? "선택 단계 미리보기" : "선택 검사 미리보기"}</button>
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
        <strong>추가 파라미터 없음</strong>
        <em>lower(), trim() 규칙으로 저장됩니다.</em>
      </div>
    );
  }

  if (operation === "Extract JSONPath") {
    return (
      <div className="hegun-rule-control-stack">
        <input className="input control-input" type="text" value={jsonPath} onChange={(event) => onJsonPathChange(event.target.value)} />
        <em>JSON 컬럼에서 꺼낼 경로</em>
      </div>
    );
  }

  if (operation === "Cast Decimal") {
    return (
      <div className="hegun-rule-control-stack">
        <input className="input control-input" type="text" value={decimalFormat} onChange={(event) => onDecimalFormatChange(event.target.value)} />
        <em>숫자 변환 형식</em>
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
        <em>목표 시간대 / 변환 형식</em>
      </div>
    );
  }

  return (
    <div className="hegun-rule-control-stack">
      <select className="input control-input" value={maskPolicy} onChange={(event) => onMaskPolicyChange(event.target.value)}>
        <option value="keep first 3 digits">앞 3자리 유지</option>
        <option value="keep last 4 digits">뒤 4자리 유지</option>
      </select>
      <em>마스킹 정책</em>
    </div>
  );
}

function PythonTransformPanel({
  code,
  onApply,
  onCodeChange,
  onPreview,
  previewOpen,
  sampleColumns,
  sampleRows,
}: {
  code: string;
  onApply: () => void;
  onCodeChange: (code: string) => void;
  onPreview: () => void;
  previewOpen: boolean;
  sampleColumns: string[];
  sampleRows: TransformQualitySampleRow[];
}) {
  const previewColumns = sampleColumns.slice(0, 4);
  const previewRows = sampleRows.slice(0, 3);
  const primaryColumn = previewColumns[0] ?? "value";

  return (
    <section className="panel hegun-console-panel python-transform-panel">
      <div className="hegun-section-title compact">
        <h2>Python 코드 변환</h2>
        <p>입력 row를 받아 출력 row를 반환하는 코드 기반 변환 단계를 추가합니다.</p>
      </div>
      <textarea
        className="python-code-editor"
        spellCheck={false}
        value={code}
        onChange={(event) => onCodeChange(event.currentTarget.value)}
      />
      <div className="hegun-rule-form-actions">
        <button className="secondary-button" type="button" disabled={code.trim().length === 0} onClick={onPreview}>샘플 결과 보기</button>
        <button className="primary-button" type="button" disabled={code.trim().length === 0} onClick={onApply}>Python 코드 변환 적용</button>
      </div>
      {previewOpen && (
        <div className="python-preview-table-wrap">
          <table className="schema-table python-preview-table">
            <thead>
              <tr>
                <th>행</th>
                <th>입력 예시</th>
                <th>출력 예시</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, index) => {
                const inputValue = String(row[primaryColumn] ?? "");
                return (
                  <tr key={`${row.row_id ?? index}-${inputValue}`}>
                    <td>{row.row_id ?? index + 1}</td>
                    <td><code className="hegun-impact-value">{inputValue || "(비어 있음)"}</code></td>
                    <td><code className="hegun-impact-value output">{inputValue.trim().toLowerCase() || "(비어 있음)"}</code></td>
                    <td><span className="hegun-impact-status changed">미리보기</span></td>
                  </tr>
                );
              })}
              {previewRows.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <span className="hegun-empty-table-state">샘플 행이 없습니다.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
      <span className="hegun-target-engine">실행 엔진<br /><strong>Spark</strong></span>
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
  const showingRowsLabel = `${totalRows.toLocaleString()}행 중 ${previewRows.length.toLocaleString()}행 표시`;
  const summaryItems = [
    { label: "처리된 샘플 행", value: totalRows.toLocaleString() },
    { label: "적용된 변환 단계", value: transformStepCount.toLocaleString() },
    { label: "생성된 파생 컬럼", value: derivedColumns.length.toLocaleString() },
    { label: "유효하지 않은 행", value: invalidRowCount.toLocaleString() },
  ];

  return (
    <section className="panel hegun-console-panel hegun-final-preview-panel">
      <div className="panel-header">
        <Table2 size={18} />
        <h2>최종 데이터셋 미리보기</h2>
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
                    {derivedColumnSet.has(column) && <em>파생</em>}
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
                  <span className="hegun-empty-table-state">변환된 샘플 행이 없습니다.</span>
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
  const failedRows = preview?.failedRows ?? 0;
  const previewStatus = preview?.status ?? "Preview pending";
  const previewStatusLabel = previewStatus === "Success" ? "성공" : previewStatus === "Review" ? "검토 필요" : "미리보기 대기";
  const beforeRows = preview && "beforeRows" in preview ? preview.beforeRows : [];
  const afterRows = preview && "afterRows" in preview ? preview.afterRows : [];
  const matchedRows = preview?.matchedRows ?? beforeRows.length;
  const sampleRows = preview ? matchedRows + failedRows : 0;
  const previewColumns = preview && "columns" in preview ? preview.columns : ["row_id", step.input, step.output].filter(Boolean);
  const impactRows = buildStepImpactRows(beforeRows, afterRows, previewColumns, step, preview);
  return (
    <section className="panel hegun-console-panel">
      <div className="panel-header">
        <RefreshCw size={18} />
        <h2>단계 미리보기 및 분석</h2>
        <button className="secondary-button hegun-header-button" type="button" onClick={() => onAction("etl.rules.sample_rows_refetched", "/api/etl/rules/sample-rows")}>새 샘플 행 가져오기</button>
      </div>
      <div className="hegun-selected-step-banner">
        <span>선택 단계</span>
        <strong>{step.id}. {transformOperationLabel(step.operation)}</strong>
        <em>{step.input} {"->"} {step.output}</em>
      </div>
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>단계 상세</h3>
          <Field label="입력 컬럼" value={step.input} />
          <Field label="출력 컬럼" value={step.output} />
          <Field label="처리 작업" value={transformOperationLabel(step.operation)} />
          <Field label="오류 처리" value={failureActionLabel(step.onError)} />
          <Field label="옵션" value={step.params} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>입력에서 출력으로</h3>
          <Field label="입력 값" value={inputValue} wide />
          <div className="hegun-preview-arrow">→</div>
          <Field label="출력 값" value={outputValue} wide />
          <span className="hegun-success-state"><Check size={14} /> {previewStatusLabel}</span>
        </div>
        <div className="hegun-preview-column">
          <h3>샘플 통계</h3>
          <StatusTile label="샘플 행" value={sampleRows.toLocaleString()} status="테스트 완료" />
          <StatusTile label="일치 행" value={matchedRows.toLocaleString()} status="일치" />
          <StatusTile label="실패 행" value={String(failedRows)} status={failedRows > 0 ? "검토" : hasPreview ? "정상" : "대기"} />
          <StatusTile label="영향 컬럼" value={preview?.affectedColumn ?? step.output} status={hasPreview ? "출력" : "대기"} />
        </div>
      </div>
      <div className="hegun-impact-header">
        <div>
          <h3>규칙 영향 미리보기</h3>
          <p>{matchedRows.toLocaleString()}개 일치 행에 {transformOperationLabel(step.operation)}을 적용했습니다. 대표 {impactRows.length}개 행을 표시합니다.</p>
        </div>
        <span>{previewStatusLabel}</span>
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
            <th>행</th>
            <th>이전: {step.input}</th>
            <th>변환</th>
            <th>이후: {step.output}</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.rowId}-${row.beforeValue}-${row.afterValue}`}>
              <td><strong>{row.rowId}</strong></td>
              <td><code className="hegun-impact-value">{row.beforeValue}</code></td>
              <td><span className="hegun-data-chip muted">{transformOperationLabel(step.operation)}</span></td>
              <td><code className="hegun-impact-value output">{row.afterValue}</code></td>
              <td><span className={`hegun-impact-status ${row.statusClass}`}>{row.statusLabel}</span></td>
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
    const statusClass = step.input !== step.output ? "derived" : changed ? "changed" : "unchanged";
    const statusLabel = step.input !== step.output ? "파생" : changed ? "변경됨" : "변경 없음";

    return {
      afterValue: truncatePreviewValue(afterValue),
      beforeValue: truncatePreviewValue(row[safeInputIndex] ?? ""),
      rowId: row[rowIdIndex] ?? String(index + 1),
      statusClass,
      statusLabel,
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
        <h2>품질 검증 미리보기</h2>
        <button className="secondary-button hegun-header-button" type="button" onClick={() => onAction("etl.rules.quality_sample_refetched", "/api/etl/rules/quality/sample-rows")}>새 샘플 행 가져오기</button>
      </div>
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>규칙 상세</h3>
          <Field label="대상 컬럼" value={rule.targetColumn} />
          <Field label="검증" value={qualityValidationLabel(rule.validationType)} />
          <Field label="심각도" value={qualitySeverityLabel(rule.severity)} />
          <Field label="실패 처리" value={failureActionLabel(rule.failureAction)} />
          <Field label="상태" value={rule.severity === "Error" ? "차단" : "모니터링"} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>샘플 실패</h3>
          <Field label="행" value={firstFailure?.row ?? "실패 샘플 없음"} />
          <Field label="컬럼" value={firstFailure?.column ?? rule.targetColumn} />
          <Field label="샘플 값" value={firstFailure?.sampleValue || "(비어 있음)"} wide />
          <Field label="사유" value={firstFailure ? qualityFailureReasonLabel(firstFailure.reason) : "샘플 행이 모두 통과했습니다."} wide />
          <Field label="처리" value={failureActionLabel(firstFailure?.action ?? rule.failureAction)} />
          <span className={invalidRowCount > 0 ? "hegun-warning-state" : "hegun-success-state"}>
            <Info size={14} /> {invalidRowCount > 0 ? "검토 필요" : "성공"}
          </span>
        </div>
        <div className="hegun-preview-column">
          <h3>샘플 통계</h3>
          <StatusTile label="샘플 행" value={sampleRows.toLocaleString()} status="테스트 완료" />
          <StatusTile label="통과 행" value={matchedRows.toLocaleString()} status="통과" />
          <StatusTile label="유효하지 않은 행" value={String(invalidRowCount)} status={invalidRowCount > 0 ? "검토" : "정상"} />
          <StatusTile label="품질 점수" value={`${qualityScore}%`} status={invalidRowCount > 0 ? "주의" : "통과"} />
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
    ? "선택한 검사에서 실패 행이 없습니다."
    : `${rule.targetColumn}의 ${qualityValidationLabel(rule.validationType)} 실패 행 ${invalidRows.length}개`;
  return (
    <section className="panel hegun-console-panel hegun-quality-failures-panel">
      <div className="panel-header">
        <Table2 size={18} />
        <h2>선택 검사 실패 행</h2>
        <span className="panel-note">{rowSummary}</span>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table hegun-quality-failed-table">
          <thead>
            <tr>
              <th>행</th>
              <th>컬럼</th>
              <th>샘플 값</th>
              <th>사유</th>
              <th>처리</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.length > 0 ? previewRows.map((row) => (
              <tr key={`${row.ruleId ?? rule.id}-${row.row}-${row.column}-${row.reason}`}>
                <td>{row.row}</td>
                <td>{row.column}</td>
                <td><code className="hegun-impact-value">{row.sampleValue || "(비어 있음)"}</code></td>
                <td>{qualityFailureReasonLabel(row.reason)}</td>
                <td><span className="hegun-data-chip muted">{failureActionLabel(row.action)}</span></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={5}>
                  <span className="hegun-empty-table-state">선택한 검사가 모든 샘플 행을 통과했습니다.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="hegun-rule-form-actions">
        <button className="secondary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_exported", "/api/etl/rules/quality/failed-rows/export")}>행 내보내기</button>
        <button className="primary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_reviewed", "/api/etl/rules/quality/failed-rows/review")}>검토 완료</button>
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
        <h2>유효하지 않은 데이터 행</h2>
        <span className="panel-note">{invalidRowsPreviewSummary}</span>
      </div>
      <div className="hegun-table-scroll">
        <table className="schema-table">
          <thead>
            <tr>
              <th>행</th>
              <th>컬럼</th>
              <th>사유</th>
              <th>처리</th>
              <th>샘플 값</th>
            </tr>
          </thead>
          <tbody>
            {invalidRows.map((row) => (
              <tr key={`${row.row}-${row.column}`}>
                <td>{row.row}</td>
                <td>{row.column}</td>
                <td>{qualityFailureReasonLabel(row.reason)}</td>
                <td><span className="hegun-data-chip muted">{failureActionLabel(row.action)}</span></td>
                <td><code className="hegun-impact-value">{row.sampleValue || "(비어 있음)"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hegun-rule-form-actions">
        <button className="secondary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_exported", "/api/etl/rules/invalid-rows/export")}>행 내보내기</button>
        <button className="primary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_reviewed", "/api/etl/rules/invalid-rows/review")}>검토 완료</button>
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
  const preview = frequency === "hourly"
    ? `매시간 ${minute}분에 실행됩니다. 다음 실행 예정: 2026.07.05 11:${minute}`
    : frequency === "daily"
      ? `매일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.06 ${time}`
      : frequency === "custom"
        ? `Cron ${customCron || DEFAULT_CUSTOM_CRON} 기준으로 실행됩니다.`
        : `매주 ${selectedDay}요일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.09 ${time}`;

  return (
    <section className="panel">
      <div className="panel-header">
        <Repeat2 size={18} />
        <h2>반복 스케줄 상세 설정</h2>
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
              {validRepeatMinutes.map((value) => (
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
              {validRepeatDays.map((day) => (
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
        <h2>스케줄 없음 상세 설정</h2>
      </div>
      <InfoBox title="자동 스케줄 없음" body="이 파이프라인은 저장 후 사용자가 직접 실행할 때만 동작합니다. 테스트 실행이나 필요할 때만 데이터를 적재하는 작업에 적합합니다." />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <input type="checkbox" defaultChecked />
          <span>
            <strong>실패 시 재시도 활성화</strong>
            <small>직접 실행 중 오류가 발생하면 지정한 정책에 따라 자동 재시도합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
      <InfoBox title="자동 실행 예정 없음" body="저장 후 필요할 때 직접 실행할 수 있으며, 다음 실행 일시는 생성되지 않습니다." />
    </section>
  );
}

function OnceSettings({
  dateTime,
  onDateTimeChange,
  onDateTimeCommit,
  onRetryPolicyChange,
  retryPolicy,
}: {
  dateTime: string;
  onDateTimeChange: (dateTime: string) => void;
  onDateTimeCommit: () => void;
  onRetryPolicyChange: (policy: RetryPolicyDraft) => void;
  retryPolicy: RetryPolicyDraft;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Clock3 size={18} />
        <h2>예약 1회 실행 상세 설정</h2>
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
            <StatusTile label="카탈로그 등록" value="생성 후 자동 등록" status="준비됨" />
            <StatusTile label="경로 검증" value="쓰기 권한 확인 완료" status="유효함" />
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
  const targetObjectName = draft.target.datasetName || getTargetDraftValues(draft).targetDataset;
  const activePermissionRows = PERMISSION_ROLES.filter((role) => roleChecks[role.name]);

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
  const applySelectedTemplate = () => {
    setRoleChecks((checks) => ({ ...checks, [permissionTemplate]: true }));
    applyPermissionDraft({ permissionTemplate });
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
          <StatusTile label="공유 범위" value={visibility} status={visibility === "외부 공유" ? "검토 필요" : "안전" } />
          <StatusTile label="민감 데이터" value="review_text 포함" status="검토 필요" />
          <StatusTile label="승인자" value={dataOwner} status={approvalStatus === "승인 완료" ? "준비됨" : "대기"} />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="권한 설정" description="생성할 데이터셋 기준으로 사용자/그룹별 조회, 수정, 실행 권한을 지정하세요." icon={<ShieldCheck size={24} />} />
        <section className="panel permission-share-panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>공유 대상</h2>
          </div>
          <InfoBox title="추천 권한 템플릿" body="템플릿을 선택한 뒤 적용하면 아래 권한 목록에 사용자/그룹과 권한 종류가 반영됩니다." />
          <div className="form-grid">
            <label className="field">
              <span>권한 템플릿</span>
              <select className="input control-input" value={permissionTemplate} onChange={(event) => {
                const nextPermissionTemplate = getKnownOption(event.target.value, PERMISSION_TEMPLATES, DEFAULT_PERMISSION_TEMPLATE);
                setPermissionTemplate(nextPermissionTemplate);
              }}>
                {PERMISSION_TEMPLATES.map((template) => <option key={template}>{template}</option>)}
              </select>
            </label>
            <div className="field permission-template-actions">
              <span>템플릿 적용</span>
              <button className="secondary-button" type="button" onClick={applySelectedTemplate}>선택 템플릿 적용</button>
            </div>
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
          <div className="permission-matrix">
            <div className="hegun-section-title compact">
              <h2>권한 목록</h2>
              <p>대상 객체, 사용자/그룹, 권한 종류를 한 행으로 확인합니다.</p>
            </div>
            <div className="hegun-table-scroll">
              <table className="schema-table permission-matrix-table">
                <thead>
                  <tr>
                    <th>대상 객체</th>
                    <th>사용자/그룹</th>
                    <th>권한 종류</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {activePermissionRows.map((role) => (
                    <tr key={role.name}>
                      <td>{targetObjectName}</td>
                      <td>{role.name}</td>
                      <td>{role.access.join(" · ")}</td>
                      <td>{role.name === permissionTemplate ? "템플릿 적용" : "직접 선택"}</td>
                    </tr>
                  ))}
                  {activePermissionRows.length === 0 && (
                    <tr>
                      <td colSpan={4}>적용된 권한이 없습니다. 템플릿을 적용하거나 사용자/그룹을 선택하세요.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
  const schemaRows = draft.transform.outputColumns.length > 0
    ? draft.transform.outputColumns.map(([name, type]) => {
        const sourceColumn = draft.schema.columns.find((column) => schemaColumnOutputName(column) === name || column.sourceName === name);
        return [
          name,
          type,
          sourceColumn ? (sourceColumn.nullable ? "예" : "아니오") : "생성",
          sourceColumn ? (sourceColumn.sourceName === name ? `SOURCE.${sourceColumn.sourceName}` : `${sourceColumn.sourceName} -> ${name}`) : "변환 출력",
        ];
      })
    : draft.schema.columns.map((column) => [
        column.targetName,
        column.type,
        column.nullable ? "예" : "아니오",
        column.sourceName === column.targetName ? `SOURCE.${column.sourceName}` : `${column.sourceName} -> ${column.targetName}`,
      ]);
  const sourceSummary = summarizeSourceConfig(request.sourceConfig);
  const reviewSchemaSummary = publicSchemaSummary(request.schemaSummary);
  const scheduleEditFlow = getScheduleFlowFromLabel(request.scheduleLabel);
  const permissionReview = getPermissionDraftValues(draft);
  const targetReview = getTargetDraftValues(draft);
  const ragReviewLabel = targetReview.rag ? "RAG 활성화" : "RAG 비활성화";
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
            ["기본 정보", `${targetReview.targetDataset} · ${targetReview.owner}`, "target"],
            ["소스", `${sourceTypeLabel(request.sourceType)} · ${sourceSummary || request.sourceLabel}`, "source"],
            ["스키마", reviewSchemaSummary, "schema"],
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
            <span className="panel-note">검토 카드 반영값</span>
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
            <span className="panel-note">검토 카드 반영값</span>
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
