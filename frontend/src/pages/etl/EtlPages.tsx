import { useEffect, useMemo, useState } from "react";
import type React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
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
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { Field, InfoBox, PageTitle, RetryPolicy, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationTopActions, CreationValidationPanel } from "../../components/creation/CreationFlow";
import { S3PathField } from "../../components/s3/S3PathField";
import { DatabaseField } from "../../components/target/DatabaseField";
import { runTransformQualitySamplePreview } from "../../data/transformQualityPreview";
import { toCreatePipelineRequest } from "../../services/draftPipelineContract";
import { runCellphonesReviewAnalysis, suggestReviewAnalysisSchema, type ReviewAnalysisSummary } from "../../services/reviewAnalysisApi";
import { listSourceAssets, testSourceConnector, type SourceConnectorAnalysis } from "../../services/sourceConnectorService";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, FlowId, ScheduleFlowId, SchemaColumnDraft, SourceDraft, TargetLayer } from "../../types";
import type { QualityRuleDraft, RetryPolicyDraft, ScheduleDraft, ScheduleOverlapPolicy, TransformStepDraft, WatermarkPolicyDraft, WatermarkWindowMode } from "../../types/etl";
import type { QualityRuleOption, TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview, TransformQualityValidationResult } from "../../data/transformQualityPreview";
import { SourceAssetTree } from "./SourceAssetTree";
import { SourceJsonSampleTree } from "./SourceJsonSampleTree";
import { XFlowSchemaTransformEditor } from "./XFlowSchemaTransformEditor";

type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};
type ScheduleOptionId = "skip" | "repeat";

export function SchedulePage({
  draftSchedule,
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
}: {
  draftSchedule: ScheduleDraft;
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const draftRetryPolicy = draftSchedule.retryPolicy;
  const draftScheduleLabel = draftSchedule.label;
  const initialRepeat = parseRepeatScheduleLabel(draftScheduleLabel);
  const [repeatFrequency, setRepeatFrequency] = useState<RepeatFrequency>(initialRepeat.frequency);
  const [repeatDay, setRepeatDay] = useState(initialRepeat.day);
  const [repeatTime, setRepeatTime] = useState(initialRepeat.time);
  const [repeatMinute, setRepeatMinute] = useState(initialRepeat.minute);
  const [customCron, setCustomCron] = useState(initialRepeat.cron);
  const title = "스케줄링 설정";
  const repeatDraft = { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime };
  const selectedOption = getScheduleOptionFromLabel(draftScheduleLabel, mode);
  const scheduleTimezone = draftSchedule.timezone || SCHEDULE_TIMEZONE;
  const scheduleStartDate = normalizeDateValue(draftSchedule.startDate, SCHEDULE_START_DATE);
  const scheduleEndDate = normalizeOptionalDateValue(draftSchedule.endDate);
  const updateRetryPolicy = (retryPolicy: RetryPolicyDraft) => {
    onDraftChange({ schedule: { retryPolicy } });
  };
  const applyScheduleDraft = () => {
    const normalizedRepeat = normalizeRepeatScheduleDraft(repeatDraft);
    setRepeatDay(normalizedRepeat.day);
    setRepeatTime(normalizedRepeat.time);
    setRepeatMinute(normalizedRepeat.minute);
    setCustomCron(normalizedRepeat.cron);
    onDraftChange(buildSchedulePatch(selectedOption, normalizedRepeat, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
  };
  const selectOption = (nextOption: ScheduleOptionId) => {
    onDraftChange(buildSchedulePatch(nextOption, repeatDraft, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
    onModeChange(scheduleFlowFromOption(nextOption));
  };
  const goNext = () => {
    applyScheduleDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      actions={<CreationTopActions onPrev={onPrev} onNext={goNext} />}
    >
        <PageTitle title={title} description="파이프라인의 실행 시간, 반복 여부, 실행 정책을 설정합니다." />
        <div className="xflow-review-stack schedule-xflow-stack">
          <section className="xflow-review-card schedule-xflow-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon"><PlayCircle size={17} /></span>
              <div>
                <h2>실행 방식 설정</h2>
                <p>저장만 할지, 정해진 주기로 자동 실행할지 선택합니다.</p>
              </div>
              <span className="schedule-xflow-state">{selectedOption === "repeat" ? "자동 실행" : "직접 실행"}</span>
            </div>
            <div className="schedule-xflow-mode-grid">
              <RunTypeCard active={selectedOption === "skip"} icon={<PlayCircle size={20} />} title="스케줄링 건너뛰기" desc="시간을 정하지 않고 저장만 합니다. 필요할 때 목록에서 즉시 실행합니다." onClick={() => selectOption("skip")} />
              <RunTypeCard active={selectedOption === "repeat"} icon={<Repeat2 size={20} />} title="반복 실행" desc="정해진 주기마다 자동으로 실행합니다." onClick={() => selectOption("repeat")} />
            </div>
          </section>
          {selectedOption === "repeat" && <RepeatSettings customCron={customCron} frequency={repeatFrequency} minute={repeatMinute} retryPolicy={draftRetryPolicy} selectedDay={repeatDay} time={repeatTime} timezone={scheduleTimezone} onCronChange={(cron) => {
            const sanitizedCron = sanitizeCronInput(cron);
            setCustomCron(sanitizedCron);
            onDraftChange(buildSchedulePatch("repeat", { cron: sanitizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onCronCommit={() => {
            const normalizedCron = normalizeCronExpression(customCron);
            setCustomCron(normalizedCron);
            onDraftChange(buildSchedulePatch("repeat", { cron: normalizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onDayChange={(day) => {
            setRepeatDay(day);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onFrequencyChange={(frequency) => {
            setRepeatFrequency(frequency);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onMinuteChange={(minute) => {
            setRepeatMinute(minute);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onTimeCommit={() => {
            const normalizedTime = normalizeTimeValue(repeatTime);
            setRepeatTime(normalizedTime);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: normalizedTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onTimeChange={(time) => {
            setRepeatTime(time);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onRetryPolicyChange={updateRetryPolicy} onTimezoneChange={(timezone) => onDraftChange(buildSchedulePatch("repeat", repeatDraft, timezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }))} />}
          {selectedOption === "skip" && <NoScheduleSettings retryPolicy={draftRetryPolicy} onRetryPolicyChange={updateRetryPolicy} />}
        </div>
    </CreationFlowLayout>
  );
}

function RunTypeCard({ active, icon, title, desc, onClick }: { active: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={active ? "schedule-xflow-mode-card active" : "schedule-xflow-mode-card"} type="button" onClick={onClick}>
      {active && <span className="run-selected-dot" />}
      <span className="schedule-xflow-mode-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
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
      if (isCredentialSourceField(label) && shouldPreserveCredentialValue(value) && currentValue) {
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
  "File / S3": "파일 / MinIO",
  MongoDB: "MongoDB",
  PostgreSQL: "PostgreSQL",
  "REST API": "REST API",
  "SQL Result": "SQL Result",
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
  "Preview Limit": "Preview 제한",
  "Preview Row Count": "Preview 행 수",
  Port: "포트",
  Query: "SQL Query",
  "Reference Dataset IDs": "참조 데이터셋 ID",
  Region: "리전",
  Response: "응답",
  Result: "결과",
  Schema: "스키마",
  "Secret Key": "시크릿 키",
  "Source Dataset": "원본 데이터셋",
  "Source Dataset ID": "원본 데이터셋 ID",
  "SQL Preview": "SQL Preview",
  "SQL Run ID": "SQL Run ID",
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
  "read-only": "읽기 전용",
  Required: "필수",
  "Read-only": "읽기 전용",
  sampled: "샘플링됨",
  skipped: "생략",
  Skipped: "생략",
  verified: "검증됨",
  Verified: "검증됨",
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

function isCredentialSourceField(label: string) {
  return /(access key|secret key|password|auth token|token|private key)/i.test(label);
}

function shouldPreserveCredentialValue(value: string) {
  const normalized = String(value ?? "").trim();
  return !normalized || /^[*•]+$/.test(normalized) || normalized.toLowerCase() === "redacted";
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
const SCHEDULE_START_DATE = "2026-07-07";
const SCHEDULE_TIMEZONE = "Asia/Seoul";
const DEFAULT_OVERLAP_POLICY: ScheduleOverlapPolicy = "skip_if_running";
const DEFAULT_WATERMARK_POLICY: WatermarkPolicyDraft = {
  column: "updated_at",
  enabled: true,
  lookbackMinutes: 5,
  mode: "last_success_to_scheduled_at",
};
const timezoneOptions = [
  { label: "Asia/Seoul (UTC+09:00)", value: "Asia/Seoul" },
  { label: "UTC", value: "UTC" },
  { label: "America/New_York (DST 적용)", value: "America/New_York" },
  { label: "Europe/London (DST 적용)", value: "Europe/London" },
];
const validRepeatMinutes = ["00", "15", "30", "45"];
const validRepeatDays = ["월", "화", "수", "목", "금", "토", "일"];
const repeatFrequencyLabels: Record<RepeatFrequency, string> = {
  hourly: "매시간",
  daily: "매일",
  weekly: "매주",
  custom: "커스텀",
};
const repeatFrequencyOptions = Object.entries(repeatFrequencyLabels).map(([value, label]) => ({ label, value: value as RepeatFrequency }));

function formatScheduleLabel(option: ScheduleOptionId, repeat: RepeatScheduleDraft) {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  if (option === "skip") return "스케줄링 건너뛰기";
  if (normalizedRepeat.frequency === "hourly") return `매시간 ${normalizedRepeat.minute}분`;
  if (normalizedRepeat.frequency === "daily") return `매일 ${normalizedRepeat.time}`;
  if (normalizedRepeat.frequency === "custom") return `커스텀: ${normalizedRepeat.cron}`;
  return `매주 ${normalizedRepeat.day}요일 ${normalizedRepeat.time}`;
}

function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "manual";
  if (label.includes("예약") || label.includes("1회")) return "manual";
  return "repeat";
}

function getScheduleOptionFromLabel(label: string, fallbackFlow: ScheduleFlowId): ScheduleOptionId {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "skip";
  if (label.includes("예약") || label.includes("1회")) return "skip";
  if (label) return "repeat";
  return fallbackFlow === "manual" ? "skip" : "repeat";
}

function scheduleFlowFromOption(option: ScheduleOptionId): ScheduleFlowId {
  if (option === "skip") return "manual";
  return "repeat";
}

function buildSchedulePatch(option: ScheduleOptionId, repeat: RepeatScheduleDraft, timezone: string = SCHEDULE_TIMEZONE, currentSchedule?: ScheduleDraft, dates?: { endDate?: string; startDate?: string }): DraftPipelinePatch {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  const label = formatScheduleLabel(option, normalizedRepeat);
  const nextRun = option === "skip"
    ? "-"
    : "저장 시점 기준 계산";
  const startDate = option === "repeat" ? normalizeDateValue(dates?.startDate ?? currentSchedule?.startDate, SCHEDULE_START_DATE) : "";
  const normalizedEndDate = option === "repeat" ? normalizeOptionalDateValue(dates?.endDate ?? currentSchedule?.endDate) : "";
  const endDate = normalizedEndDate && normalizedEndDate >= startDate ? normalizedEndDate : "";
  const scheduleTimezone = option === "skip" ? "" : timezone;
  const summary = formatScheduleSummary(option, label, scheduleTimezone);
  const nextRunUtc = option === "skip" ? "" : "";
  const restoreRepeatDefaults = option === "repeat" && (currentSchedule?.mode === "manual" || currentSchedule?.label.includes("건너뛰기"));
  const overlapPolicy = option === "skip" ? undefined : restoreRepeatDefaults ? DEFAULT_OVERLAP_POLICY : currentSchedule?.overlapPolicy ?? DEFAULT_OVERLAP_POLICY;
  const watermarkPolicy = option === "skip"
    ? { ...DEFAULT_WATERMARK_POLICY, enabled: false, mode: "full_refresh" as WatermarkWindowMode }
    : restoreRepeatDefaults ? DEFAULT_WATERMARK_POLICY : currentSchedule?.watermarkPolicy ?? DEFAULT_WATERMARK_POLICY;

  return {
    endDate,
    nextRunUtc,
    overlapPolicy,
    schedule: {
      endDate,
      label,
      nextRun,
      nextRunUtc,
      overlapPolicy,
      startDate,
      summary,
      timezone: scheduleTimezone,
      watermarkPolicy,
    },
    scheduleLabel: label,
    scheduleSummary: summary,
    startDate,
    timezone: scheduleTimezone,
    watermarkPolicy,
  };
}

function formatScheduleSummary(option: ScheduleOptionId, label: string, timezone: string) {
  if (option === "skip") return "스케줄링 건너뛰기 · 나중에 목록에서 직접 실행";
  return `반복 실행 · ${label} · ${timezone} · 저장 후 다음 예약부터 시작`;
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

function normalizeDateValue(value: string | undefined, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function normalizeOptionalDateValue(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
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
const DEFAULT_TARGET_FORMAT: TargetFileFormat = "parquet";
const DEFAULT_TARGET_TAGS: string[] = [];
const LEGACY_TARGET_TAG_OPTIONS = ["마케팅용", "고객데이터", "고객 데이터", "분석용", "서비스용", "서비스 제공용", "원본", "원본 데이터", "가공됨", "가공 데이터", "운영 데이터", "개인정보 포함"];

const PERMISSION_TEMPLATES = ["Data Engineer Group", "Data Analyst Group", "ML Team"] as const;
const VISIBILITY_OPTIONS = ["조직 내부", "프로젝트 멤버", "외부 공유"] as const;
const APPROVAL_STATUS_OPTIONS = ["승인 검토", "승인 완료", "오너 승인 필요"] as const;
const TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER", "GOLD"];
const TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["parquet", "csv", "json", "jsonl"];

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
  roles?: Array<{ access: string[]; checked: boolean; name: string }>;
  summary?: string;
  template?: string;
  visibility?: string;
};

type TargetDraftSlice = {
  compression?: "Snappy" | "Gzip" | "None";
  databaseName?: string;
  datasetName?: string;
  description?: string;
  format?: string;
  indexColumns?: string[];
  jobName?: string;
  lastTestRun?: TargetTestRun;
  layer?: string;
  manager?: string;
  owner?: string;
  partition?: string;
  partitionColumns?: string[];
  rag?: boolean;
  schemaRules?: TargetSchemaRule[];
  storagePath?: string;
  storageType?: "S3" | "Local" | "HDFS";
  tableName?: string;
  targetTableName?: string;
  targetDataset?: string;
  targetFormat?: string;
  targetLayer?: string;
  tags?: string[];
  testStatus?: "idle" | "success" | "failed";
};

type TargetFileFormat = "parquet" | "csv" | "json" | "jsonl";
type TargetTestStatus = "idle" | "pending" | "success" | "failed";
type TargetColumnType = "string" | "number" | "boolean" | "datetime" | "json";

type TargetSchemaRule = {
  displayType?: string;
  indexed: boolean;
  name: string;
  nullable: boolean;
  partitionable: boolean;
  raw?: boolean;
  recommendedIndex: boolean;
  recommendedPartition: boolean;
  sourceName: string;
  type: TargetColumnType;
  use: boolean;
  validationStatus: "valid" | "warning" | "error";
};

type TargetTestRun = {
  finishedAt?: string;
  logs: string[];
  message?: string;
  status: TargetTestStatus;
};

type TargetMetadata = {
  databaseName: string;
  datasetName: string;
  description: string;
  fileFormat: TargetFileFormat;
  manager: string;
  owner: string;
  storagePath: string;
  targetTableName: string;
};

type TargetSavedConfig = {
  indexColumns: string[];
  lastTestRun: TargetTestRun;
  lineage: {
    sourceName: string;
    targetDatasetName: string;
    targetStoragePath: string;
    transformStepCount: number;
  };
  metadata: TargetMetadata;
  partitionColumns: string[];
  previewRows: Array<Record<string, string>>;
  schemaRules: TargetSchemaRule[];
  tags: string[];
};

type ReviewSchemaRow = {
  columnName: string;
  nullable: string;
  transform: string;
  type: string;
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

function buildTargetStoragePath(targetDataset: string, targetLayer: TargetLayer) {
  return `s3a://asklake-output/${targetDataset}/${targetLayer.toLowerCase()}/`;
}

function buildKafkaLandingPath(topic: string) {
  return `s3://m3-raw/kafka-landing/${topic || "reviews.raw"}`;
}

function normalizeKafkaDatasetName(topic: string) {
  return (topic || "reviews.raw").trim().replace(/[^0-9A-Za-z_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "reviews_raw";
}

function isDefaultTargetStoragePath(value: string | undefined) {
  return !value || value.includes("asklake-output/");
}

function isDefaultTargetDataset(value: string | undefined) {
  return !value || [DEFAULT_TARGET_DATASET, "pair_a_customer_review_gold"].includes(value);
}

function isDefaultTargetTable(value: string | undefined) {
  return !value || [DEFAULT_TARGET_DATASET, "pair_a_customer_review_gold"].includes(value);
}

function isDefaultTargetDescription(value: string | undefined) {
  return !value || value.includes("고객 리뷰 분석용");
}

function kafkaTargetTags(tags: string[] | undefined) {
  const visibleTags = filterVisibleTargetTags(tags);
  return visibleTags.length > 0 ? visibleTags : ["#kafka", "#raw"];
}

const TARGET_CONFIG_STORAGE_KEY = "asklake.targetConfigDraft";
const TARGET_FILE_FORMAT_VALUES: TargetFileFormat[] = ["parquet", "csv", "json", "jsonl"];
const SAMPLE_TARGET_SCHEMA_COLUMNS: SchemaColumnDraft[] = [
  { included: true, nullable: false, sourceName: "order_date", targetName: "order_date", type: "date" },
  { included: true, nullable: false, sourceName: "order_count", targetName: "order_count", type: "integer" },
  { included: true, nullable: false, sourceName: "gross_sales", targetName: "gross_sales", type: "decimal" },
  { included: true, nullable: false, sourceName: "updated_at", targetName: "updated_at", type: "timestamp" },
];
const SAMPLE_TARGET_ROWS = [
  ["2026-07-07", "128", "10200.50", "2026-07-07T09:30:00Z"],
  ["2026-07-08", "96", "15700.00", "2026-07-08T09:30:00Z"],
  ["2026-07-09", "141", "99900.25", "2026-07-09T09:30:00Z"],
];

function normalizeTargetFileFormat(value: string | undefined): TargetFileFormat {
  const normalized = value?.trim().toLowerCase();
  return TARGET_FILE_FORMAT_VALUES.find((format) => format === normalized) ?? "parquet";
}

function filterVisibleTargetTags(tags: string[] | undefined) {
  return (tags ?? []).filter((tag) => !LEGACY_TARGET_TAG_OPTIONS.includes(tag));
}

function isRecommendedPartitionColumn(columnName: string, columnType = "") {
  const normalizedName = columnName.trim().toLowerCase();
  const normalizedType = columnType.trim().toLowerCase();
  return (
    normalizedName === "date"
    || normalizedName.endsWith("_date")
    || ["event_time", "created_at", "updated_at", "partition_date", "event_date", "region", "category"].includes(normalizedName)
    || normalizedType.includes("date")
    || normalizedType.includes("time")
  );
}

function isRecommendedIndexColumn(columnName: string) {
  return /^(id|user_id|customer_id|product_id|order_id|review_id|account_id)$/i.test(columnName);
}

function normalizeTargetColumnType(value: string): TargetColumnType {
  const normalized = value.toLowerCase();
  if (normalized.includes("int") || normalized.includes("float") || normalized.includes("double") || normalized.includes("decimal") || normalized === "number") return "number";
  if (normalized.includes("bool")) return "boolean";
  if (normalized.includes("date") || normalized.includes("time")) return "datetime";
  if (normalized.includes("json") || normalized.includes("object") || normalized.includes("array")) return "json";
  return "string";
}

function inferJsonValueType(value: unknown): TargetColumnType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|\s)?/.test(value)) return "datetime";
  return "string";
}

function mergeTargetColumnType(previous: TargetColumnType | undefined, next: TargetColumnType): TargetColumnType {
  if (!previous || previous === next) return next;
  if (previous === "json" || next === "json") return "json";
  return "string";
}

function flattenJsonObject(value: unknown, prefix: string, output: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    output[prefix] = value;
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenJsonObject(child, path, output);
      return;
    }
    output[path] = child;
  });
}

function stringifyPreviewValue(value: unknown) {
  if (value === null || typeof value === "undefined") return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inferTargetSchema(columns: SchemaColumnDraft[], rows: string[][], existingRules: TargetSchemaRule[] | undefined) {
  const sourceColumns = columns.length > 0 ? columns : SAMPLE_TARGET_SCHEMA_COLUMNS;
  const sourceRows = rows.length > 0 ? rows : SAMPLE_TARGET_ROWS;
  const dataColumnIndex = sourceColumns.findIndex((column) => (column.targetName || column.sourceName).toLowerCase() === "data");
  const jsonColumnIndex = dataColumnIndex >= 0 ? dataColumnIndex : sourceColumns.length === 1 ? 0 : -1;
  const existingByName = new Map(existingRules?.map((rule) => [rule.name, rule]));
  const previewRows: Array<Record<string, string>> = [];
  const typeByName = new Map<string, TargetColumnType>();
  const displayTypeByName = new Map<string, string>();
  const nullableByName = new Map<string, boolean>();
  let jsonParseFailed = false;
  let jsonInferred = false;

  if (jsonColumnIndex >= 0) {
    sourceRows.forEach((row) => {
      const rawValue = row[jsonColumnIndex] ?? "";
      try {
        const parsed = JSON.parse(rawValue);
        const flattened: Record<string, unknown> = {};
        flattenJsonObject(parsed, "", flattened);
        const previewRow: Record<string, string> = {};

        Object.entries(flattened).forEach(([name, value]) => {
          previewRow[name] = stringifyPreviewValue(value);
          const inferredType = inferJsonValueType(value);
          typeByName.set(name, mergeTargetColumnType(typeByName.get(name), inferredType));
          displayTypeByName.set(name, inferredType === "datetime" ? "timestamp" : inferredType);
          nullableByName.set(name, (nullableByName.get(name) ?? false) || value === null || typeof value === "undefined");
        });

        previewRow.raw_data = rawValue;
        typeByName.set("raw_data", "json");
        displayTypeByName.set("raw_data", "json");
        nullableByName.set("raw_data", false);
        previewRows.push(previewRow);
        jsonInferred = true;
      } catch {
        jsonParseFailed = true;
      }
    });
  }

  if (!jsonInferred) {
    sourceRows.forEach((row) => {
      const previewRow: Record<string, string> = {};
      sourceColumns.forEach((column, index) => {
        const name = column.targetName || column.sourceName;
        const value = row[index] ?? "";
        previewRow[name] = value;
        typeByName.set(name, mergeTargetColumnType(typeByName.get(name), normalizeTargetColumnType(column.type)));
        displayTypeByName.set(name, column.type.trim().toLowerCase());
        nullableByName.set(name, (nullableByName.get(name) ?? false) || value === "");
      });
      previewRows.push(previewRow);
    });
  }

  const schemaRules = Array.from(typeByName.keys()).map((name) => {
    const existing = existingByName.get(name);
    const displayType = existing?.displayType ?? displayTypeByName.get(name);
    const recommendedPartition = isRecommendedPartitionColumn(name, displayType);
    const recommendedIndex = isRecommendedIndexColumn(name);
    const raw = name === "raw_data";
    const type = existing?.type ?? typeByName.get(name) ?? "string";
    const validationStatus: TargetSchemaRule["validationStatus"] = raw ? "warning" : "valid";

    return {
      displayType,
      indexed: existing?.indexed ?? recommendedIndex,
      name,
      nullable: existing?.nullable ?? Boolean(nullableByName.get(name)),
      partitionable: !raw && type !== "json",
      raw,
      recommendedIndex,
      recommendedPartition,
      sourceName: name,
      type,
      use: existing?.use ?? !raw,
      validationStatus,
    };
  });

  return { jsonInferred, jsonParseFailed, previewRows, schemaRules };
}

function formatPartitionColumnType(rule: TargetSchemaRule) {
  const displayType = rule.displayType?.trim().toLowerCase();
  if (displayType) return displayType;
  if (rule.type === "datetime") return rule.name.toLowerCase().endsWith("_date") ? "date" : "timestamp";
  return rule.type;
}

function validateTargetConfig(config: TargetSavedConfig, jsonParseFailed: boolean) {
  const errors: string[] = [];

  if (!config.metadata.datasetName.trim()) errors.push("데이터셋명은 필수입니다.");
  if (!config.metadata.storagePath.trim()) errors.push("저장경로는 필수입니다.");
  if (!config.metadata.fileFormat.trim()) errors.push("포맷은 필수입니다.");
  if (jsonParseFailed) errors.push("JSON 파싱에 실패했습니다.");

  const usedColumnNames = new Set(config.schemaRules.filter((rule) => rule.use).map((rule) => rule.name));
  if (usedColumnNames.size === 0) errors.push("저장에 사용할 컬럼이 1개 이상 필요합니다.");

  const disabledPartitionColumns = config.partitionColumns.filter((column) => !usedColumnNames.has(column));
  if (disabledPartitionColumns.length > 0) {
    errors.push(`partition 컬럼이 사용 제외 상태입니다: ${disabledPartitionColumns.join(", ")}`);
  }

  return errors;
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
  const isKafkaSource = draft.source.sourceType === "Stream / Kafka" || draft.source.sourceType === "Kafka JSON";
  const kafkaTopic = sourceConfigValue(draft.source.sourceConfig, "TOPIC / QUEUE NAME") || sourceConfigValue(draft.source.sourceConfig, "Topic") || "reviews.raw";
  const kafkaDatasetName = normalizeKafkaDatasetName(kafkaTopic);
  const rawTargetDataset = target?.targetDataset ?? target?.datasetName ?? compatDraft.targetDataset;
  const targetDataset = isKafkaSource && isDefaultTargetDataset(rawTargetDataset)
    ? kafkaDatasetName
    : getDisplayText(rawTargetDataset, isKafkaSource ? kafkaDatasetName : DEFAULT_TARGET_DATASET);
  const rawTargetFormat = target?.targetFormat ?? target?.format ?? compatDraft.targetFormat;
  const targetFormat = isKafkaSource && (!rawTargetFormat || rawTargetFormat === DEFAULT_TARGET_FORMAT)
    ? "jsonl"
    : getKnownOption(rawTargetFormat, TARGET_FORMAT_OPTIONS, isKafkaSource ? "jsonl" : DEFAULT_TARGET_FORMAT);
  const rawTargetLayer = target?.targetLayer ?? target?.layer ?? compatDraft.targetLayer ?? draft.target.layer;
  const targetLayer = isKafkaSource && (!rawTargetLayer || rawTargetLayer === DEFAULT_TARGET_LAYER)
    ? "RAW"
    : normalizeTargetLayer(rawTargetLayer);
  const storedPath = target?.storagePath ?? draft.target.storagePath;
  const defaultTargetPath = isKafkaSource ? buildKafkaLandingPath(kafkaTopic) : buildTargetStoragePath(targetDataset, targetLayer);
  const storagePath = isKafkaSource && isDefaultTargetStoragePath(storedPath) ? defaultTargetPath : getDisplayText(storedPath, defaultTargetPath);

  return {
    description: isKafkaSource && isDefaultTargetDescription(target?.description ?? draft.target.description)
      ? "Kafka 원본 이벤트 Lake landing 데이터셋"
      : getDisplayText(target?.description ?? draft.target.description, "고객 리뷰 분석용 정제 데이터셋"),
    jobName: getDisplayText(target?.jobName ?? compatDraft.jobName, buildJobName(targetDataset)),
    owner: getDisplayText(target?.owner ?? compatDraft.owner ?? draft.permission.owner, DEFAULT_OWNER),
    partitionColumns: isKafkaSource ? ["created_at"] : target?.partitionColumns ?? draft.target.partitionColumns ?? ["date", "category"],
    rag: typeof target?.rag === "boolean" ? target.rag : compatDraft.rag ?? draft.target.rag,
    storagePath,
    tableName: isKafkaSource && isDefaultTargetTable(target?.tableName ?? draft.target.tableName)
      ? targetDataset
      : getDisplayText(target?.tableName ?? draft.target.tableName, targetDataset),
    tags: isKafkaSource ? kafkaTargetTags(target?.tags ?? draft.target.tags) : filterVisibleTargetTags(target?.tags ?? draft.target.tags ?? DEFAULT_TARGET_TAGS),
    targetDataset,
    targetFormat,
    targetLayer,
    testStatus: target?.testStatus ?? draft.target.testStatus ?? "idle",
  };
}

function getInitialSourceStage(draft: DraftPipeline): "choose" | "connect" | "browse" {
  if (!draft.source.sourceType) return "choose";
  if (draft.source.connectionStatus === "success") return "browse";
  return "connect";
}

export function SourceConnectionPage({
  draft,
  onAction,
  onDraftChange,
  onNotify,
  onPrev,
  onNext,
}: {
  draft: DraftPipeline;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [sourceType, setSourceType] = useState(draft.source.sourceType || "");
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const [connectionStatus, setConnectionStatus] = useState<SourceDraft["connectionStatus"]>(draft.source.connectionStatus);
  const [connectionMessage, setConnectionMessage] = useState(draft.source.connectionMessage ?? "검토 전에 연결 테스트가 필요합니다.");
  const [sourceRuntime, setSourceRuntime] = useState<SourceConnectorAnalysis | null>(null);
  const [sourceStage, setSourceStage] = useState<"choose" | "connect" | "browse">(() => getInitialSourceStage(draft));
  const [loadingAssetPath, setLoadingAssetPath] = useState("");
  const [selectedAssetPath, setSelectedAssetPath] = useState("");
  const connectorMeta: Record<string, { desc: string; icon: React.ReactNode; label: string; status: string }> = {
    "File / S3": { desc: "MinIO 버킷을 연결한 뒤 실제 오브젝트를 선택합니다.", icon: <SourceBrandIcon kind="s3" />, label: "MinIO", status: "실제 연결" },
    PostgreSQL: { desc: "테이블 목록, 샘플 행, 스키마 추론", icon: <SourceBrandIcon kind="postgres" />, label: "Postgres", status: "실제 연결" },
    MongoDB: { desc: "컬렉션 목록, 문서 샘플, 중첩 필드 추론", icon: <SourceBrandIcon kind="mongo" />, label: "MongoDB", status: "실제 연결" },
    "REST API": { desc: "HTTP 응답 샘플을 백엔드에서 수집", icon: <SourceBrandIcon kind="rest" />, label: "REST API", status: "실제 연결" },
    "Data Lake": { desc: "MinIO 경로의 Parquet 오브젝트 목록", icon: <SourceBrandIcon kind="lake" />, label: "레이크", status: "목록 조회" },
    "SQL Result": { desc: "SQL Preview 결과를 처리 Job 입력으로 사용", icon: <TerminalSquare size={20} />, label: "SQL Result", status: "검증 완료" },
    "Stream / Kafka": { desc: "Apache Kafka 스트림 데이터를 연결합니다.", icon: <SourceBrandIcon kind="kafka" />, label: "Kafka", status: "메타데이터" },
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
    "SQL Result": {
      title: "SQL 결과 입력",
      description: "SQL Preview 결과와 query/run metadata를 처리 Job 입력으로 사용합니다.",
      fields: [
        ["Source Dataset", ""],
        ["Source Dataset ID", ""],
        ["SQL Run ID", ""],
        ["Preview Limit", "100"],
        ["Preview Row Count", ""],
        ["Reference Dataset IDs", "-"],
        ["Validation Key", "-"],
        ["Query", ""],
      ],
      testItems: [["SQL Preview", "Verified"], ["Query", "Read-only"], ["Backend connector", "Skipped"]],
      logs: ["SQL Preview 결과가 이미 검증되어 소스 연결 단계를 생략합니다.", "Review에서 Job 생성 후 실행 정책과 타겟 저장소를 확정합니다."],
      assetsTitle: "SQL 실행 근거",
      assets: [],
      previewTitle: "SQL Preview 결과",
      previewNote: "SQL 분석 화면에서 전달된 Preview 결과를 사용합니다.",
      previewColumns: ["Column", "Type", "Source"],
      previewRows: [],
      info: "SQL 결과 저장은 Catalog 직접 저장이 아니라 수집/처리 Job 생성 검토로 이어집니다.",
    },
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
      info: "",
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
      info: "",
    },
    "File / S3": {
      title: "MinIO 소스 설정",
      description: "MinIO 오브젝트 스토리지에서 버킷과 제한 샘플을 실제 조회합니다.",
      fields: [
        ["Storage Provider", "MinIO"],
        ["Endpoint URL", ""],
        ["Region", ""],
        ["Bucket / Stage Name", ""],
        ["Path / Prefix", ""],
        ["Access Key", ""],
        ["Secret Key", ""],
        ["Use Path Style", "true"],
        ["File Type", "auto"],
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
        ["TOPIC / QUEUE NAME", "reviews.raw"],
        ["CONSUMER GROUP ID", "asklake-reviews-raw-job"],
        ["Batch Max Messages", "100"],
        ["Timeout Ms", "10000"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "None"],
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
  const selectedSourceType = sourceType === "Database" ? "PostgreSQL" : sourceType;
  const activeSourceType = sourceConfigs[selectedSourceType] ? selectedSourceType : "";
  const hasSelectedSource = activeSourceType.length > 0;
  const current = hasSelectedSource ? sourceConfigs[activeSourceType] : sourceConfigs["File / S3"];
  const editableFields = sourceFields[activeSourceType] ?? (
    draft.source.sourceType === activeSourceType && draft.source.sourceConfig.length > 0
      ? mergeFieldRows(current.fields, draft.source.sourceConfig)
      : current.fields
  );
  const isSqlResultSource = activeSourceType === "SQL Result";
  const hasSqlResultPreview = isSqlResultSource && hasSqlResultPreviewConfig(editableFields);
  const sourceLabel = hasSelectedSource
    ? editableFields.find(([label]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? activeSourceType
    : "미선택";
  const connectionStatusCopy: Record<SourceDraft["connectionStatus"], { badge: string; title: string }> = {
    failed: { badge: "확인 실패", title: "연결 실패" },
    idle: { badge: "테스트 필요", title: "연결 테스트 대기" },
    success: { badge: "미리보기 가능", title: "연결 검증 완료" },
    testing: { badge: "테스트 중", title: "연결 테스트 실행 중" },
  };
  const visibleEditableFields = editableFields.filter(([label]) => isVisibleSourceField(activeSourceType, label));
  const displayTestItems = (sourceRuntime?.testItems ?? current.testItems).filter(([label]) => !isInternalSourceField(label));
  const displayAssets = sourceRuntime?.assets ?? current.assets;
  const hasDetectedAssets = displayAssets.length > 0;
  const selectedAsset = selectedAssetPath ? displayAssets.find(([path]) => path === selectedAssetPath) ?? null : null;
  const requiresAssetSelectionForPreview = activeSourceType === "File / S3" || activeSourceType === "Data Lake";
  const selectedAssetHasSample = Boolean(
    (!requiresAssetSelectionForPreview || selectedAsset) && sourceRuntime?.draftPatch.schema?.columns?.length,
  );
  const displayPreviewColumns = selectedAssetHasSample ? sourceRuntime?.previewColumns ?? [] : [];
  const displayPreviewRows = selectedAssetHasSample ? sourceRuntime?.previewRows ?? [] : [];
  const hasSamplePreview = displayPreviewColumns.length > 0 && displayPreviewRows.length > 0;
  const hasSchemaPatch = Boolean(sourceRuntime?.draftPatch.schema?.columns?.length && sourceRuntime?.draftPatch.schema?.sampleRows?.length);
  const displayPreviewNote = sourceRuntime?.previewNote ?? current.previewNote;
  const previewTableMinWidth = Math.max(880, displayPreviewColumns.length * 148);
  const publicConnectionMessage = publicSourceLog(connectionMessage);
  const publicDisplayPreviewNote = publicSourceLog(displayPreviewNote);
  const runtimeSourceConfig = sourceRuntime?.draftPatch.source?.sourceConfig;
  const verifiedSourceFields = connectionStatus === "success" && runtimeSourceConfig ? runtimeSourceConfig : editableFields;
  const displayPreviewFormat = activeSourceType === "File / S3" ? sourceFormatFromConfig(verifiedSourceFields, activeSourceType) : sourceTypeLabel(activeSourceType);
  const usesJsonSampleTree = displayPreviewFormat === "JSON" || displayPreviewFormat === "JSONL";
  const sourceSummaryRows: Array<[string, string]> = [
    ["선택 커넥터", hasSelectedSource ? sourceTypeLabel(activeSourceType) : "미선택"],
    ["연결 상태", isSqlResultSource ? (hasSqlResultPreview && connectionStatus === "success" ? "SQL Preview 검증됨" : "SQL Preview 필요") : connectionStatus === "success" ? publicConnectionMessage : connectionStatus === "testing" ? "테스트 중" : connectionStatus === "failed" ? "실패" : "테스트 필요"],
    ["감지 파일", isSqlResultSource ? `${sourceConfigValue(editableFields, "Preview Row Count") || "0"} rows` : `${displayAssets.length}개`],
    ["인증 방식", isSqlResultSource ? "SQL Preview 검증" : activeSourceType === "File / S3" ? "MinIO 액세스 키" : "백엔드 커넥터"],
    ["다음 단계", isSqlResultSource ? "Review 확인" : "스키마 추론"],
  ];

  const applySourceDraft = (
    nextType = activeSourceType,
    nextFields = verifiedSourceFields,
    nextStatus = connectionStatus,
    nextMessage = connectionMessage,
  ) => {
    if (!nextType) {
      onDraftChange({
        source: {
          connectionMessage: nextMessage,
          connectionStatus: nextStatus,
          sourceConfig: [],
          sourceLabel: "",
          sourceType: "",
        },
      });
      return;
    }
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
    const nextFields = value === activeSourceType ? editableFields : sourceFields[value] ?? sourceConfigs[value].fields;
    const nextIsSqlResult = value === "SQL Result";
    const nextHasSqlResultPreview = nextIsSqlResult && hasSqlResultPreviewConfig(nextFields);
    const nextStatus: SourceDraft["connectionStatus"] = nextIsSqlResult ? (nextHasSqlResultPreview ? "success" : "idle") : "idle";
    const nextMessage = nextIsSqlResult
      ? nextHasSqlResultPreview
        ? "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다."
        : "SQL Result는 SQL 분석 Preview에서 처리 Job 생성으로 진입할 때 사용합니다."
      : `${sourceTypeLabel(value)} 설정을 선택했습니다. 검토 전에 연결 테스트를 실행하세요.`;
    setSourceType(value);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setSourceStage("connect");
    setConnectionStatus(nextStatus);
    setConnectionMessage(nextMessage);
    applySourceDraft(value, nextFields, nextStatus, nextMessage);
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    const nextMessage = isSqlResultSource ? connectionMessage : "소스 설정이 변경되었습니다. 연결 테스트를 다시 실행하세요.";
    const nextStatus = isSqlResultSource ? connectionStatus : "idle";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setConnectionStatus(nextStatus);
    setConnectionMessage(nextMessage);
    applySourceDraft(activeSourceType, nextFields, nextStatus, nextMessage);
  };

  const fillMinioDemoFields = () => {
    const demoFields: Array<[string, string]> = [
      ["Storage Provider", "MinIO"],
      ["Endpoint URL", "http://127.0.0.1:19000"],
      ["Region", "us-east-1"],
      ["Bucket / Stage Name", "m3-raw"],
      ["Path / Prefix", ""],
      ["Access Key", "m3admin"],
      ["Secret Key", "wishuponastar"],
      ["Use Path Style", "true"],
      ["File Type", "auto"],
      ["Delimiter", ","],
      ["Encoding", "UTF-8"],
      ["Header", "Treat first row as header"],
    ];
    const nextFields = mergeFieldRows(editableFields, demoFields);
    const nextMessage = "로컬 MinIO 데모 연결값을 채웠습니다. 연결 테스트를 실행하세요.";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    applySourceDraft(activeSourceType, nextFields, "idle", nextMessage);
    onAction("etl.source.demo_minio_filled", "/api/etl/sources/demo-minio", activeSourceType);
  };

  const loadSourceAssetChildren = async (folderPath: string) => {
    if (!hasSelectedSource || !(activeSourceType === "File / S3" || activeSourceType === "Data Lake")) return;
    const folderPrefix = normalizeFolderPrefix(folderPath);
    setLoadingAssetPath(folderPrefix);
    try {
      const result = await listSourceAssets(activeSourceType, editableFields, folderPrefix);
      setSourceRuntime((runtime) => runtime
        ? { ...runtime, assets: mergeSourceAssets(runtime.assets ?? [], result.assets ?? []) }
        : {
          actionPath: "/api/etl/sources/assets",
          assets: result.assets ?? [],
          draftPatch: {},
          logs: [],
          message: connectionMessage,
          previewColumns: [],
          previewNote: "",
          previewRows: [],
          status: connectionStatus,
          testItems: displayTestItems,
        });
      onAction("etl.source.folder_opened", "/api/etl/sources/assets", folderPrefix);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "하위 목록을 가져오지 못했습니다.");
    } finally {
      setLoadingAssetPath("");
    }
  };

  const selectSourceAsset = async (assetPath: string) => {
    const asset = displayAssets.find(([path]) => path === assetPath);
    if (!asset) return;
    const [, assetMeta] = asset;
    if (assetMeta === "folder" || assetPath.endsWith("/")) {
      await loadSourceAssetChildren(assetPath);
      return;
    }
    const currentAssets = displayAssets;
    const nextFields = upsertSourceFields(editableFields.map(([fieldLabel, fieldValue]) => (
      fieldLabel === "Path / Prefix" || fieldLabel === "Path" || fieldLabel === "DATASET OR TABLE SELECTOR"
        ? [fieldLabel, assetPath] as [string, string]
        : [fieldLabel, fieldValue] as [string, string]
    )), [
      ["__Selected Object", assetPath],
      ["__Sample Object", assetPath],
    ]);
    const nextMessage = `${assetMeta === "folder" ? "폴더" : "파일"} ${assetPath} 선택됨`;
    setSelectedAssetPath(assetPath);
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setConnectionMessage(nextMessage);
    setConnectionStatus("testing");
    applySourceDraft(activeSourceType, nextFields, "testing", nextMessage);
    onAction("etl.source.asset_selected", "/api/etl/sources/assets", assetPath);
    try {
      const result = mergeConnectorAnalysisSourceConfig(
        publicConnectorAnalysis(await testSourceConnector(activeSourceType, nextFields)),
        nextFields,
      );
      const successMessage = `${assetPath} 기준 샘플을 가져왔습니다.`;
      if (result.draftPatch.source?.sourceConfig) {
        setSourceFields((fields) => ({ ...fields, [activeSourceType]: result.draftPatch.source?.sourceConfig ?? nextFields }));
      }
      setSourceRuntime({ ...result, assets: mergeSourceAssets(currentAssets, result.assets ?? []), message: successMessage });
      setConnectionStatus(result.status);
      setConnectionMessage(successMessage);
      onDraftChange(result.draftPatch);
      onAction("etl.source.asset_sampled", result.actionPath, assetPath);
      onNotify(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "선택한 오브젝트의 샘플을 가져오지 못했습니다.";
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, nextFields, "failed", message);
      onAction("etl.source.asset_sample_failed", "/api/etl/sources/test", assetPath, "failed");
      onNotify(message);
    }
  };

  const testConnection = async () => {
    if (!hasSelectedSource) {
      onNotify("먼저 소스를 선택하세요.");
      return;
    }
    if (isSqlResultSource) {
      const message = hasSqlResultPreview
        ? "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다."
        : "SQL 분석에서 Preview를 실행한 뒤 처리 Job 생성으로 진입해 주세요.";
      const nextStatus: SourceDraft["connectionStatus"] = hasSqlResultPreview ? "success" : "idle";
      setConnectionStatus(nextStatus);
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, editableFields, nextStatus, message);
      onNotify(message);
      return;
    }

    const testingMessage = `${sourceTypeLabel(activeSourceType)} 커넥터 테스트 실행 중입니다.`;
    setConnectionStatus("testing");
    setConnectionMessage(testingMessage);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    applySourceDraft(activeSourceType, editableFields, "testing", testingMessage);
    try {
      if (activeSourceType !== "File / S3" && activeSourceType !== "Data Lake") {
        const result = mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, editableFields)),
          editableFields,
        );
        if (result.draftPatch.source?.sourceConfig) {
          setSourceFields((fields) => ({ ...fields, [activeSourceType]: result.draftPatch.source?.sourceConfig ?? editableFields }));
        }
        setSourceRuntime(result);
        setSelectedAssetPath("");
        setConnectionStatus(result.status);
        setConnectionMessage(result.message);
        onDraftChange(result.draftPatch);
        onAction("etl.source.connection_tested", result.actionPath, activeSourceType);
        onNotify(result.message);
        return;
      }
      const result = await listSourceAssets(activeSourceType, editableFields, "");
      const successMessage = `${sourceTypeLabel(activeSourceType)} 연결 성공: 하위 항목 ${result.assets.length}개`;
      const connectorResult: SourceConnectorAnalysis = {
        actionPath: "/api/etl/sources/assets",
        assets: result.assets,
        draftPatch: {
          source: {
            connectionMessage: successMessage,
            connectionStatus: "success",
            sourceConfig: editableFields,
            sourceLabel: sourceLabelFromFields(activeSourceType, editableFields),
            sourceType: activeSourceType,
          },
        },
        logs: [successMessage],
        message: successMessage,
        previewColumns: [],
        previewNote: "파일을 선택하면 제한 샘플과 스키마 추론 결과가 표시됩니다.",
        previewRows: [],
        status: "success",
        testItems: [["Connector", activeSourceType], ["Result", "Verified"], ["Objects", `${result.assets.length}`]],
      };
      setSourceRuntime(connectorResult);
      setSelectedAssetPath("");
      setConnectionStatus("success");
      setConnectionMessage(successMessage);
      onDraftChange(connectorResult.draftPatch);
      onAction("etl.source.connection_tested", connectorResult.actionPath, activeSourceType);
      onNotify(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "소스 커넥터 테스트에 실패했습니다.";
      setSourceRuntime(null);
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, editableFields, "failed", message);
      onAction("etl.source.connection_failed", "/api/etl/sources/test", activeSourceType, "failed");
      onNotify(message);
    }
  };

  const goNext = () => {
    if (!hasSelectedSource) {
      onNotify("먼저 소스를 선택하세요.");
      return;
    }
    if (connectionStatus !== "success") {
      onNotify(isSqlResultSource ? "SQL 분석에서 Preview를 실행한 뒤 처리 Job 생성으로 진입해 주세요." : "먼저 소스 연결 테스트를 성공시켜야 스키마 단계로 넘어갈 수 있습니다.");
      return;
    }
    applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
    onNext();
  };

  const fetchMetadata = () => {
    onAction("etl.source.metadata_fetched", "/api/etl/sources/metadata", activeSourceType);
  };

  const sourceChoiceGroups: Array<{ connectors: string[]; description: string; id: string; title: string }> = [
    {
      id: "database",
      title: "데이터베이스",
      description: "관계형/문서형 DB에서 테이블·컬렉션을 조회하고 샘플로 스키마를 추론합니다.",
      connectors: ["PostgreSQL", "MongoDB"],
    },
    {
      id: "object-storage",
      title: "파일 / 오브젝트 스토리지",
      description: "MinIO 버킷, 파일, Parquet 레이크 오브젝트를 선택합니다.",
      connectors: ["File / S3", "Data Lake"],
    },
    {
      id: "stream",
      title: "스트림",
      description: "이벤트 스트림 메타데이터와 토픽 기반 입력을 설정합니다.",
      connectors: ["Stream / Kafka"],
    },
    {
      id: "api",
      title: "API",
      description: "HTTP 응답 샘플을 수집해서 처리 입력으로 사용합니다.",
      connectors: ["REST API"],
    },
  ];

  return (
    <CreationFlowLayout
      actions={<CreationTopActions onPrev={onPrev} onNext={goNext} />}
    >
        <PageTitle title="소스 연결" description={isSqlResultSource ? "SQL Preview 결과를 처리 Job 입력으로 확인합니다." : "소스를 선택하고 실제 연결 테스트로 샘플을 가져옵니다."} />
        <section className="panel hegun-console-panel source-connect-panel" aria-label="소스 선택 및 연결">
          <div className="source-stage-tabs" role="tablist" aria-label="소스 연결 단계">
            <button className={sourceStage === "choose" ? "active" : ""} type="button" onClick={() => setSourceStage("choose")}>1. 소스 선택</button>
            <button className={sourceStage === "connect" ? "active" : ""} type="button" disabled={!hasSelectedSource} onClick={() => setSourceStage("connect")}>2. 연결 설정</button>
            <button className={sourceStage === "browse" ? "active" : ""} type="button" disabled={connectionStatus !== "success" || !hasDetectedAssets} onClick={() => setSourceStage("browse")}>3. 데이터 탐색</button>
          </div>

          {sourceStage === "choose" && (
            <div className="source-stage-screen source-choice-screen">
              <div className="xflow-source-select-heading">
                <h2>Select a data source</h2>
                <p>Choose the type of data source you want to connect</p>
              </div>
              <div className="source-choice-groups">
                {sourceChoiceGroups.map((group) => (
                  <section className="source-choice-group" key={group.id} aria-labelledby={`source-choice-${group.id}`}>
                    <div className="source-choice-group-head">
                      <div>
                        <h3 id={`source-choice-${group.id}`}>{group.title}</h3>
                        <p>{group.description}</p>
                      </div>
                      <span>{group.connectors.length} connectors</span>
                    </div>
                    <div className="source-choice-list">
                      {group.connectors.map((connector) => {
                        const meta = connectorMeta[connector];
                        const config = sourceConfigs[connector];
                        const selected = sourceType === connector;
                        return (
                          <button aria-label={`${group.title} ${meta.label} ${meta.desc}`} className={selected ? "source-choice-row active" : "source-choice-row"} key={connector} type="button" onClick={() => selectSource(connector)}>
                            <span className="source-choice-icon">{meta.icon}</span>
                            <span className="source-choice-main">
                              <strong>{meta.label}</strong>
                              <span>{meta.desc}</span>
                            </span>
                            <span className="source-choice-meta">
                              <em>{meta.status}</em>
                              <span>{config?.assetsTitle ?? "데이터 탐색"}</span>
                            </span>
                            <span className="source-choice-next">연결 설정</span>
                            {selected && <span className="source-choice-check"><Check size={18} /></span>}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}

          {sourceStage === "connect" && hasSelectedSource && (
            <div className="source-stage-screen">
              <section className="source-step-section active">
                <div className="source-step-header">
                  <em>1</em>
                  <div>
                    <strong>{current.title}</strong>
                  </div>
                  <div className="hegun-status-actions">
                  {activeSourceType === "File / S3" && <button className="secondary-button" type="button" onClick={fillMinioDemoFields}>데모용 MinIO 값 채우기</button>}
                  {current.actions?.includes("Show Advanced Configuration") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.advanced_opened", "/api/etl/sources/advanced", activeSourceType)}>{sourceActionLabel("Show Advanced Configuration")}</button>}
                  {current.actions?.includes("Fetch Metadata") && <button className="secondary-button" type="button" onClick={fetchMetadata}>{sourceActionLabel("Fetch Metadata")}</button>}
                    {isSqlResultSource ? <span className="panel-note">연결 테스트 생략</span> : <button className="primary-button" type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>연결 테스트</button>}
                  </div>
                </div>
                <div className="hegun-field-grid source-flow-fields">
                  {visibleEditableFields.map(([label, value]) => (
                    <label className={value.length > 38 ? "field wide" : "field"} key={`${activeSourceType}-${label}`}>
                      <span>{sourceFieldLabel(label)}</span>
                      <input className="input control-input" readOnly={isSqlResultSource} value={value} onChange={(event) => updateSourceField(label, event.target.value)} />
                    </label>
                  ))}
                </div>
                {current.info && <InfoBox title={isSqlResultSource ? "SQL Preview 입력" : "보안 연결"} body={current.info} />}
              </section>

              <section className={`hegun-source-status-bar ${connectionStatus}`} aria-label="연결 테스트 상태">
                <div className="hegun-status-head">
                  <div className="hegun-status-copy">
                    {sourceStatusIcon(connectionStatus)}
                    <h2>{connectionStatusCopy[connectionStatus].title}</h2>
                    <span className="panel-note">{publicConnectionMessage}</span>
                  </div>
                  <div className="hegun-status-actions">
                    {connectionStatus === "success" && hasDetectedAssets && <button className="secondary-button" type="button" onClick={() => setSourceStage("browse")}>데이터 탐색 열기</button>}
                    {isSqlResultSource && <span className="panel-note">연결 테스트 생략</span>}
                  </div>
                </div>
                <div className="hegun-test-strip">
                  {displayTestItems.map(([label, value], index) => (
                    <span className={sourceCheckState(value)} key={`${activeSourceType}-${label}-${index}`}>
                      <i>{sourceCheckIcon(label)}</i>
                      <strong>{sourceFieldLabel(label)}</strong>
                      <em>{sourceValueLabel(value)}</em>
                    </span>
                  ))}
                </div>
              </section>
            </div>
          )}

          {sourceStage === "browse" && hasSelectedSource && (
            <div className="source-stage-screen source-xflow-layout">
              <section className="source-from-panel">
                <div className="source-xflow-heading">
                  <LayoutGrid size={18} />
                  <div><h2>{current.assetsTitle}</h2></div>
                </div>
                {hasDetectedAssets ? (
                  <SourceAssetTree
                    assets={displayAssets}
                    loadingPath={loadingAssetPath}
                    selectedPath={selectedAssetPath}
                    onOpenFolder={loadSourceAssetChildren}
                    onSelect={selectSourceAsset}
                  />
                ) : (
                  <p className="source-empty-note">연결 테스트 후 실제 폴더와 파일이 표시됩니다.</p>
                )}
              </section>
              <section className="source-flow-panel">
                <section className="source-step-section active">
                  <div className="source-step-header">
                    <em>2</em>
                    <div>
                      <strong>제한 샘플 미리보기</strong>
                    </div>
                    <span className="source-select-pill active">{selectedAsset ? selectedAsset[0] : "선택 대기"}</span>
                  </div>
                  <div className="source-preview-format-strip">
                    <strong>{displayPreviewFormat}</strong>
                    <span>{displayPreviewRows.length}행 · {displayPreviewColumns.length}필드</span>
                  </div>
                  {displayPreviewRows.length > 0 ? (
                    usesJsonSampleTree ? (
                      <SourceJsonSampleTree
                        columns={displayPreviewColumns}
                        format={displayPreviewFormat}
                        rows={displayPreviewRows}
                      />
                    ) : (
                      <div className="hegun-table-scroll source-preview-scroll">
                        <table className="schema-table" style={{ minWidth: previewTableMinWidth }}>
                          <thead><tr>{displayPreviewColumns.map((column, index) => <th key={`${column}-${index}`}>{sourceColumnLabel(column)}</th>)}</tr></thead>
                          <tbody>
                            {displayPreviewRows.map((row, rowIndex) => <tr key={`${activeSourceType}-preview-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}
                          </tbody>
                        </table>
                      </div>
                    )
                  ) : (
                    <p className="source-empty-note">파일을 선택한 뒤 연결 테스트를 다시 실행하면 해당 파일 기준 샘플이 표시됩니다.</p>
                  )}
                </section>
              </section>
            </div>
          )}
        </section>
    </CreationFlowLayout>
  );
}

function sourceFormatFromConfig(fields: Array<[string, string]>, _sourceType?: string) {
  const fieldMap = new Map(fields.map(([label, value]) => [label, value]));
  const declaredFormat = (fieldMap.get("File Type") || "").trim().toLowerCase();
  const selectedPath = [
    fieldMap.get("Path / Prefix"),
    fieldMap.get("Path"),
    fieldMap.get("DATASET OR TABLE SELECTOR"),
  ].find((value) => value && value.trim().length > 0)?.trim().toLowerCase() || "";
  const rawFormat = declaredFormat && declaredFormat !== "auto"
    ? declaredFormat
    : selectedPath.replace(/^.*\./, "");
  if (rawFormat.includes("jsonl")) return "JSONL";
  if (rawFormat.includes("json")) return "JSON";
  if (rawFormat.includes("csv")) return "CSV";
  if (rawFormat.includes("tsv")) return "TSV";
  if (rawFormat.includes("txt")) return "TXT";
  if (rawFormat.includes("parquet")) return "PARQUET";
  return "AUTO";
}

function mergeSourceAssets(currentAssets: Array<[string, string, string]>, nextAssets: Array<[string, string, string]>) {
  const merged = new Map<string, [string, string, string]>();
  [...currentAssets, ...nextAssets].forEach(([path, meta, status]) => {
    merged.set(path, [path, meta, status]);
  });
  return Array.from(merged.values());
}

function normalizeFolderPrefix(path: string) {
  const cleanPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return cleanPath ? `${cleanPath}/` : "";
}

function upsertSourceFields(fields: Array<[string, string]>, patches: Array<[string, string]>) {
  const nextFields = [...fields];
  patches.forEach(([label, value]) => {
    const index = nextFields.findIndex(([fieldLabel]) => fieldLabel === label);
    if (index >= 0) {
      nextFields[index] = [label, value];
    } else {
      nextFields.push([label, value]);
    }
  });
  return nextFields;
}

function sourceStatusIcon(status: SourceDraft["connectionStatus"]) {
  if (status === "success") return <Check size={18} />;
  if (status === "testing") return <RefreshCw size={18} />;
  if (status === "failed") return <Info size={18} />;
  return <Settings size={18} />;
}

function isVisibleSourceField(sourceType: string, label: string) {
  if (isInternalSourceField(label)) return false;
  if (sourceType === "File / S3") {
    return !["Storage Provider", "Region", "Use Path Style", "Header", "Path / Prefix"].includes(label);
  }
  return true;
}

function SourceBrandIcon({ kind }: { kind: "s3" | "postgres" | "mongo" | "rest" | "lake" | "kafka" }) {
  if (kind === "s3") {
    return (
      <svg className="source-brand-icon source-brand-s3" viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#ff9900" d="M14 17.5 32 8l18 9.5v29L32 56l-18-9.5v-29Z" />
        <path fill="#f58518" d="m32 8 18 9.5-18 9.4-18-9.4L32 8Z" opacity=".72" />
        <path fill="#d95b00" d="M32 26.9 50 17.5v29L32 56V26.9Z" opacity=".36" />
        <path fill="none" stroke="#fff7ed" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.2" d="M22 21.5 32 16l10 5.5M22 42.5 32 48l10-5.5M32 16v32" />
        <text x="32" y="37" fill="#fff" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="800" textAnchor="middle">S3</text>
      </svg>
    );
  }
  if (kind === "postgres") {
    return (
      <svg className="source-brand-icon source-brand-postgres" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="29" fill="#336791" />
        <path fill="#fff" d="M18.8 29.2c.2-8.7 5.7-14.5 14.2-14.2 8.9.3 14 6.7 12.5 15.4l-1.9 10.8c-.6 3.6-4.4 5.6-7.5 3.9l-4.2-2.3-5 6.6c-2.2 2.9-6.8 1.3-6.7-2.4l.2-8.7-1.5-.7c-3.2-1.5-4.8-4.6-4.2-8.1l4.1-.3Z" opacity=".96" />
        <path fill="#336791" d="M25.1 30.4c-.6-5.8 2.2-9.1 7.2-9.1 5.7 0 8.3 4.3 7.1 10.7l-1.1 5.9-6.3-3.3-4.8 6.4.4-8.2-2.5-2.4Z" />
        <circle cx="36.9" cy="27.5" r="2.1" fill="#fff" />
        <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.1" d="M23.5 30.4c3.8 1.5 7.7 2 11.7 1.4M37.4 32.2c4.2.9 6.7 2.9 7.6 6" />
      </svg>
    );
  }
  if (kind === "mongo") {
    return (
      <svg className="source-brand-icon source-brand-mongo" viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#47a248" d="M33.2 4.8c10.1 7.9 14.5 16.6 13.1 26.3-1.2 8.5-6.1 15.6-14.3 28.1-8.3-12.5-13.1-19.6-14.3-28.1-1.4-9.7 3-18.4 13.1-26.3l1.2-.9 1.2.9Z" />
        <path fill="#2f7d32" d="M32 3.9v55.3c8.2-12.5 13.1-19.6 14.3-28.1C47.7 21.4 43.3 12.7 33.2 4.8L32 3.9Z" opacity=".4" />
        <path fill="none" stroke="#e7f7ea" strokeLinecap="round" strokeWidth="3.2" d="M32 12.5v36.8" />
        <path fill="none" stroke="#e7f7ea" strokeLinecap="round" strokeWidth="2.4" d="M32 28.6c-3.2-3.8-5.6-7.7-7.1-11.8M32 36.8c3.8-4.5 6.3-9 7.4-13.5" opacity=".72" />
      </svg>
    );
  }
  if (kind === "rest") {
    return (
      <svg className="source-brand-icon source-brand-rest" viewBox="0 0 64 64" aria-hidden="true">
        <rect x="9" y="11" width="46" height="42" rx="10" fill="#eff6ff" stroke="#2563eb" strokeWidth="3" />
        <path fill="none" stroke="#2563eb" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M24 27.5 17.5 34 24 40.5M40 27.5 46.5 34 40 40.5M35.8 24.5l-7.6 19" />
        <path fill="#2563eb" d="M18 18.5h28a2 2 0 0 1 2 2v1.2H16v-1.2a2 2 0 0 1 2-2Z" opacity=".18" />
        <circle cx="20" cy="21" r="1.7" fill="#2563eb" />
        <circle cx="25.5" cy="21" r="1.7" fill="#2563eb" opacity=".72" />
      </svg>
    );
  }
  if (kind === "lake") {
    return (
      <svg className="source-brand-icon source-brand-lake" viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#e0f2fe" d="M8 23c0-6.6 10.7-12 24-12s24 5.4 24 12v18c0 6.6-10.7 12-24 12S8 47.6 8 41V23Z" />
        <ellipse cx="32" cy="23" fill="#38bdf8" rx="24" ry="12" />
        <path fill="#0284c7" d="M8 23c0 6.6 10.7 12 24 12s24-5.4 24-12v18c0 6.6-10.7 12-24 12S8 47.6 8 41V23Z" opacity=".7" />
        <path fill="none" stroke="#e0f2fe" strokeLinecap="round" strokeWidth="3.4" d="M14 38c4.9-3.2 9.8-3.2 14.7 0 2.5 1.7 6.1 1.7 8.6 0 4.2-2.8 8.4-3.2 12.7-1.2" />
        <path fill="none" stroke="#bae6fd" strokeLinecap="round" strokeWidth="3" d="M15 46c4.2-2.6 8.5-2.6 12.7 0 2.8 1.8 6.8 1.8 9.6 0 3.6-2.2 7.4-2.6 11.2-1.1" />
      </svg>
    );
  }
  return (
    <svg className="source-brand-icon source-brand-kafka" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="19" cy="18" r="8" fill="#111827" />
      <circle cx="45" cy="18" r="8" fill="#111827" />
      <circle cx="32" cy="46" r="8" fill="#111827" />
      <path fill="none" stroke="#111827" strokeLinecap="round" strokeWidth="5" d="M26 21.6 38 42.4M38 21.6 26 42.4M27 18h10" />
      <circle cx="19" cy="18" r="3.1" fill="#fff" opacity=".9" />
      <circle cx="45" cy="18" r="3.1" fill="#fff" opacity=".9" />
      <circle cx="32" cy="46" r="3.1" fill="#fff" opacity=".9" />
    </svg>
  );
}

function sourceCheckIcon(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("endpoint") || normalized.includes("broker") || normalized.includes("lake")) return <HardDrive size={14} />;
  if (normalized.includes("bucket") || normalized.includes("database") || normalized.includes("table") || normalized.includes("collection") || normalized.includes("topic")) return <Database size={14} />;
  if (normalized.includes("auth") || normalized.includes("access")) return <ShieldCheck size={14} />;
  if (normalized.includes("sample") || normalized.includes("response") || normalized.includes("message") || normalized.includes("metadata")) return <FileText size={14} />;
  return <Settings size={14} />;
}

function sourceCheckState(value: string) {
  const normalized = value.toLowerCase();
  if (/(ok|success|reachable|verified|fetched|listed|ready|skipped|완료|성공|가능|생략)/.test(normalized)) return "success";
  if (/(fail|error|denied|실패|오류)/.test(normalized)) return "failed";
  if (/(pending|required|not tested|대기|필요|미확인)/.test(normalized)) return "idle";
  return "idle";
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
  if (sourceType === "SQL Result") {
    return [
      { label: "SQL Preview", shortLabel: "Preview", value: "current" },
    ];
  }
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
    { label: "1GB 요청(기본 16MB 제한)", shortLabel: "1GB", value: "slice1gb" },
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
  if (draft.source.sourceType === "SQL Result") return "SQL";
  return "SAMPLE";
}

function buildSchemaFingerprint(columns: SchemaColumnDraft[]) {
  return columns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}:${isSchemaColumnIncluded(column) ? "included" : "excluded"}`).join("|");
}

function summarizeSchemaColumns(columns: SchemaColumnDraft[], lowConfidenceCount: number, sourceFormat: string) {
  const includedCount = columns.filter(isSchemaColumnIncluded).length;
  const excludedCount = Math.max(0, columns.length - includedCount);
  const excludedSummary = excludedCount > 0 ? ` · ${excludedCount}개 출력 제외` : "";
  return `${includedCount}개 출력 컬럼 구성${excludedSummary} · ${lowConfidenceCount}개 검토 필요 · ${sourceFormat} 샘플 기준`;
}

function isSchemaColumnIncluded(column: SchemaColumnDraft) {
  return column.included !== false;
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
      included: group.columns.some(({ column }) => isSchemaColumnIncluded(column)),
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

function compactSchemaPreviewValue(value: string, maxLength = 44) {
  const normalized = value.trim() || "null";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(8, maxLength - 14))}...${normalized.slice(-8)}`;
}

function schemaTransformLabel(column: SchemaColumnDraft) {
  const actions: string[] = [];
  if (!isSchemaColumnIncluded(column)) actions.push("출력에서 제외");
  if (column.sourceName.includes(".")) actions.push("중첩 경로 평탄화");
  if ((column.targetName || "") !== normalizeTargetColumnName(column.sourceName)) actions.push("출력 필드명 변경");
  if (column.type) actions.push(`${column.type} 타입 변환`);
  actions.push(column.nullable ? "Null 허용" : "필수");
  return actions.join(" · ");
}

function schemaTransformShortLabel(column: SchemaColumnDraft) {
  const actions: string[] = [];
  if (!isSchemaColumnIncluded(column)) actions.push("제외");
  if (column.sourceName.includes(".")) actions.push("평탄화");
  if ((column.targetName || "") !== normalizeTargetColumnName(column.sourceName)) actions.push("이름 변경");
  if (column.type) actions.push("타입 변환");
  return actions.length > 0 ? actions.join(" + ") : "그대로";
}
function schemaFlowWindow(columns: SchemaColumnDraft[], sampleRows: string[][], selectedIndex: number) {
  const maxItems = 6;
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(columns.length - 1, 0)));
  const start = Math.max(0, Math.min(safeSelectedIndex - 3, Math.max(columns.length - maxItems, 0)));
  return columns.slice(start, start + maxItems).map((column, offset) => {
    const index = start + offset;
    return {
      action: schemaTransformLabel(column),
      actionShort: schemaTransformShortLabel(column),
      included: isSchemaColumnIncluded(column),
      index,
      nullable: column.nullable ? "Null 허용" : "필수",
      sample: compactSchemaPreviewValue(sampleRows[0]?.[index] ?? ""),
      sourceName: column.sourceName,
      targetName: column.targetName || `column_${index + 1}`,
      type: column.type,
    };
  });
}

function schemaRoleLabel(role?: string) {
  return schemaRoleOptions.find((option) => option.value === (role ?? ""))?.label ?? role ?? "일반";
}

function formatSourceFieldPath(value: string) {
  if (!value.includes(".")) return value;
  const parts = value.split(".");
  return parts.map((part, index) => (index === 0 ? part : `└ ${part}`)).join(" ");
}

type ReviewStructuringColumnDef = {
  allowedValues?: string[];
  label: string;
  method?: string;
  nullable: boolean;
  targetName: string;
  type: string;
};

type ReviewStructuringTemplate = {
  columns: ReviewStructuringColumnDef[];
  createdAt: string;
  id: string;
  name: string;
  sourceObject: string;
};

const REVIEW_STRUCTURING_SOURCE_OBJECT = "s3://m3-raw/amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl";
const REVIEW_SCHEMA_TEMPLATE_STORAGE_KEY = "asklake.reviewSchemaTemplates.v1";
const REVIEW_STRUCTURING_COLUMNS: ReviewStructuringColumnDef[] = [
  { label: "리뷰 식별자", method: "copy_or_extract_field", nullable: false, targetName: "review_id", type: "String" },
  { allowedValues: ["positive", "mixed", "negative"], label: "감정", method: "sentiment_3way", nullable: false, targetName: "sentiment", type: "String" },
  { label: "이슈 카테고리", method: "issue_category", nullable: false, targetName: "issue_category", type: "String" },
  { label: "이슈 세부 분류", method: "issue_subcategory", nullable: true, targetName: "issue_subcategory", type: "String" },
  { allowedValues: ["critical", "high", "medium", "low"], label: "심각도", method: "severity_4level", nullable: false, targetName: "severity", type: "String" },
  { label: "요약", method: "extractive_summary", nullable: true, targetName: "summary", type: "String" },
  { label: "근거 문장", method: "evidence_span", nullable: true, targetName: "evidence", type: "String" },
];
const REVIEW_STRUCTURING_STEP_PREFIX = "review-row-analysis-";

function reviewStructuringOutputNames(columns = REVIEW_STRUCTURING_COLUMNS) {
  return new Set(columns.map((column) => column.targetName));
}

function readReviewStructuringTemplates() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(REVIEW_SCHEMA_TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ReviewStructuringTemplate => (
        item
        && typeof item.id === "string"
        && typeof item.name === "string"
        && Array.isArray(item.columns)
      ))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function writeReviewStructuringTemplates(templates: ReviewStructuringTemplate[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REVIEW_SCHEMA_TEMPLATE_STORAGE_KEY, JSON.stringify(templates.slice(0, 20)));
}

function buildReviewStructuringTemplate(name: string): ReviewStructuringTemplate {
  return {
    columns: REVIEW_STRUCTURING_COLUMNS,
    createdAt: new Date().toISOString(),
    id: `review-schema-${Date.now()}`,
    name: name.trim() || "Amazon 리뷰 분석 추천 스키마",
    sourceObject: REVIEW_STRUCTURING_SOURCE_OBJECT,
  };
}

function buildReviewStructuringTemplateFromSchema(columns: SchemaColumnDraft[], name: string): ReviewStructuringTemplate {
  const configuredColumns = columns
    .filter((column) => column.sourceName.startsWith("__review_analysis.") || column.role?.startsWith("review-row-analysis:"))
    .map((column) => ({
      allowedValues: reviewAnalysisAllowedValuesForTarget(column.targetName || column.sourceName.replace(/^__review_analysis\./, "")),
      label: (column.role ?? "").replace(/^review-row-analysis:/, "") || column.targetName || column.sourceName,
      method: (column as SchemaColumnDraft & { reviewAnalysisMethod?: string }).reviewAnalysisMethod || reviewAnalysisMethodForTarget(column.targetName || column.sourceName),
      nullable: column.nullable,
      targetName: column.targetName || column.sourceName.replace(/^__review_analysis\./, ""),
      type: column.type || "String",
    }))
    .filter((column) => Boolean(column.targetName));
  return {
    columns: configuredColumns.length > 0 ? configuredColumns : REVIEW_STRUCTURING_COLUMNS,
    createdAt: new Date().toISOString(),
    id: `review-schema-${Date.now()}`,
    name: name.trim() || "사용자 수정 리뷰 분석 스키마",
    sourceObject: REVIEW_STRUCTURING_SOURCE_OBJECT,
  };
}

function reviewAnalysisMethodForTarget(value: string) {
  const target = String(value || "").replace(/^__review_analysis\./, "").toLowerCase();
  if (target === "sentiment") return "sentiment_3way";
  if (target === "issue_category") return "issue_category";
  if (target === "issue_subcategory") return "issue_subcategory";
  if (target === "severity" || target === "severity_risk") return "severity_4level";
  if (target === "summary") return "extractive_summary";
  if (target === "evidence" || target === "supporting_evidence") return "evidence_span";
  if (target.startsWith("is_") || target.startsWith("has_") || target === "clicked") return "boolean_y_n";
  return "copy_or_extract_field";
}

function reviewAnalysisAllowedValuesForTarget(value: string) {
  const method = reviewAnalysisMethodForTarget(value);
  if (method === "sentiment_3way") return ["positive", "mixed", "negative"];
  if (method === "severity_4level") return ["critical", "high", "medium", "low"];
  if (method === "boolean_y_n") return ["Y", "N"];
  return [];
}

function reviewAnalysisParamsForColumns(reviewColumns: ReviewStructuringColumnDef[]) {
  return JSON.stringify({
    columns: reviewColumns.map((column) => ({
      allowedValues: column.allowedValues ?? reviewAnalysisAllowedValuesForTarget(column.targetName),
      method: column.method || reviewAnalysisMethodForTarget(column.targetName),
      nullable: column.nullable,
      targetName: column.targetName,
      type: column.type,
    })),
    asinField: "asin",
    ratingField: "rating",
    sourceField: "text",
    textField: "text",
    titleField: "title",
    version: 1,
  });
}

function reviewTemplateDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function normalizeReviewFieldName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function schemaColumnName(column: SchemaColumnDraft) {
  return normalizeReviewFieldName(column.targetName || column.sourceName);
}

function findReviewFieldIndex(columns: SchemaColumnDraft[], names: string[]) {
  const normalizedNames = new Set(names.map(normalizeReviewFieldName));
  return columns.findIndex((column) => normalizedNames.has(schemaColumnName(column)) || normalizedNames.has(normalizeReviewFieldName(column.sourceName)));
}

function hasReviewTextFields(columns: SchemaColumnDraft[]) {
  return findReviewFieldIndex(columns, ["text", "review_text", "body"]) >= 0
    && findReviewFieldIndex(columns, ["rating", "stars", "score"]) >= 0;
}

function isReviewStructuringApplied(columns: SchemaColumnDraft[], reviewColumns = REVIEW_STRUCTURING_COLUMNS) {
  return reviewColumns.every((column) => (
    columns.some((item) => schemaColumnName(item) === column.targetName)
  ));
}

function shouldShowReviewStructuringFlow(draft: DraftPipeline, columns: SchemaColumnDraft[], sourceFormat: string) {
  const sourceText = [
    draft.source.sourceLabel,
    draft.source.sourceType,
    sourceFormat,
    ...draft.source.sourceConfig.flatMap(([label, value]) => [label, value]),
    ...columns.flatMap((column) => [column.sourceName, column.targetName]),
  ].join(" ").toLowerCase();
  return hasReviewTextFields(columns)
    || sourceText.includes("cell_phones_and_accessories")
    || sourceText.includes("amazon_reviews")
    || sourceText.includes("review");
}

function buildReviewStructuringColumns(columns: SchemaColumnDraft[], reviewColumns = REVIEW_STRUCTURING_COLUMNS) {
  const outputNames = reviewStructuringOutputNames(reviewColumns);
  const baseColumns = columns.filter((column) => (
    !outputNames.has(schemaColumnName(column))
    && !column.sourceName.startsWith("__review_analysis.")
  ));
  const params = reviewAnalysisParamsForColumns(reviewColumns);
  const generatedColumns = reviewColumns.map((column) => ({
    included: true,
    nullable: column.nullable,
    role: `review-row-analysis:${column.label}`,
    sourceName: `__review_analysis.${column.targetName}`,
    targetName: column.targetName,
    reviewAnalysisMethod: column.method || reviewAnalysisMethodForTarget(column.targetName),
    transformChain: [{
      display: `리뷰 row 분석 -> ${column.label}`,
      expression: `REVIEW_ANALYZE(rating, title, text, asin).${column.targetName}`,
      onError: "Warn",
      operation: "Review Row Analysis",
      params,
      type: column.type,
    }],
    type: column.type,
  } satisfies SchemaColumnDraft));
  return [...baseColumns, ...generatedColumns];
}

function buildReviewStructuringTransformSteps(existingSteps: TransformStepDraft[], reviewColumns = REVIEW_STRUCTURING_COLUMNS) {
  const rest = existingSteps.filter((step) => !step.id.startsWith(REVIEW_STRUCTURING_STEP_PREFIX));
  const params = reviewAnalysisParamsForColumns(reviewColumns);
  const generatedSteps = reviewColumns.map((column) => ({
    enabled: true,
    id: `${REVIEW_STRUCTURING_STEP_PREFIX}${column.targetName}`,
    input: "rating,title,text,asin",
    kind: "derive",
    label: `리뷰 row 분석: ${column.label}`,
    onError: "Warn",
    operation: "Review Row Analysis",
    output: column.targetName,
    params,
  } satisfies TransformStepDraft));
  return [...rest, ...generatedSteps];
}

function buildReviewStructuringSampleRows(columns: SchemaColumnDraft[], sampleRows: string[][], reviewColumns = REVIEW_STRUCTURING_COLUMNS) {
  const fieldIndexes = {
    asin: findReviewFieldIndex(columns, ["asin", "product_id"]),
    rating: findReviewFieldIndex(columns, ["rating", "stars", "score"]),
    text: findReviewFieldIndex(columns, ["text", "review_text", "body"]),
    timestamp: findReviewFieldIndex(columns, ["timestamp", "event_time", "created_at"]),
    title: findReviewFieldIndex(columns, ["title", "summary", "review_title"]),
    userId: findReviewFieldIndex(columns, ["user_id", "reviewer_id", "customer_id"]),
  };
  return sampleRows.map((row, rowIndex) => {
    const sample = classifyReviewSample(row, fieldIndexes, rowIndex);
    return [
      ...row,
      ...reviewColumns.map((column) => sample[column.targetName] ?? ""),
    ];
  });
}

function classifyReviewSample(row: string[], indexes: { asin: number; rating: number; text: number; timestamp: number; title: number; userId: number }, rowIndex: number) {
  const rating = Number(row[indexes.rating] ?? "");
  const title = indexes.title >= 0 ? row[indexes.title] ?? "" : "";
  const text = indexes.text >= 0 ? row[indexes.text] ?? "" : "";
  const asin = indexes.asin >= 0 ? row[indexes.asin] ?? "" : "";
  const userId = indexes.userId >= 0 ? row[indexes.userId] ?? "" : "";
  const timestamp = indexes.timestamp >= 0 ? row[indexes.timestamp] ?? "" : "";
  const combined = `${title} ${text}`.toLowerCase();
  const category = reviewIssueCategoryForText(combined, rating);
  const severity = reviewSeverityForText(combined, rating, category.id);
  const sentiment = rating <= 2 || severity === "critical" || severity === "high"
    ? "negative"
    : rating === 3 || category.id !== "positive_value"
      ? "mixed"
      : "positive";
  const evidence = compactSchemaPreviewValue(text || title || "(샘플 텍스트 없음)");
  const reviewIdSeed = [asin, userId, timestamp].filter(Boolean).join("_") || `sample_${rowIndex + 1}`;
  return {
    confidence: category.id === "positive_value" ? "0.78" : "0.86",
    evidence,
    issue_category: category.id,
    issue_subcategory: category.label,
    review_id: reviewIdSeed.replace(/[^a-zA-Z0-9_-]+/g, "_"),
    sentiment,
    severity,
    summary: `${category.label} 신호를 감지했습니다. ${evidence}`,
  } as Record<string, string>;
}

function reviewIssueCategoryForText(text: string, rating: number) {
  const rules = [
    { id: "safety_battery", label: "배터리/안전", pattern: /(battery|explode|fire|hot|overheat|burn|smoke|danger)/i },
    { id: "charging_power", label: "충전/전원", pattern: /(charge|charging|charger|power|cable|usb|plug)/i },
    { id: "screen_display", label: "화면/디스플레이", pattern: /(screen|display|glass|crack|touch|protector)/i },
    { id: "audio_bluetooth", label: "오디오/블루투스", pattern: /(sound|audio|speaker|earbud|bluetooth|pairing|mic)/i },
    { id: "compatibility_fit", label: "호환/장착", pattern: /(fit|compatible|case|size|model|install|mount)/i },
    { id: "delivery_packaging", label: "배송/포장", pattern: /(shipping|delivery|package|packaging|arrived|box)/i },
    { id: "durability_quality", label: "내구성/품질", pattern: /(broke|broken|defect|quality|cheap|scratch|stopped|fail)/i },
    { id: "listing_accuracy", label: "상품 정보 불일치", pattern: /(not as described|wrong|fake|different|missing|picture|listing)/i },
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  if (matched) return matched;
  if (rating > 0 && rating <= 2) return { id: "general_negative", label: "일반 불만" };
  return { id: "positive_value", label: "긍정/가치" };
}

function reviewSeverityForText(text: string, rating: number, category: string) {
  if (/(explode|fire|burn|smoke|danger|injury)/i.test(text)) return "critical";
  if (category === "safety_battery" || rating === 1) return "high";
  if (rating === 2 || /(broken|defect|stopped|fail|wrong|missing)/i.test(text)) return "medium";
  if (category !== "positive_value") return "low";
  return "none";
}

function summarizeReviewAnalysisResult(result: ReviewAnalysisSummary | null) {
  if (!result || result.status !== "success") return "아직 실제 원본 검증을 실행하지 않았습니다.";
  const processedRows = result.processedRows?.toLocaleString() ?? "0";
  const issueRows = result.metrics?.issueRows?.toLocaleString() ?? "0";
  const highRows = result.metrics?.highSeverityRows?.toLocaleString() ?? "0";
  return `${processedRows}행 처리 · 이슈 ${issueRows}행 · High+ ${highRows}행`;
}

function ReviewStructuringFlowCard({
  applied,
  error,
  hasRequiredFields,
  loading,
  recommendedColumns,
  result,
  suggesting,
  selectedTemplateId,
  templateName,
  templates,
  onApply,
  onGenerateSuggestion,
  onLoadTemplate,
  onRunValidation,
  onSaveTemplate,
  onClose,
  onTemplateNameChange,
}: {
  applied: boolean;
  error: string;
  hasRequiredFields: boolean;
  loading: boolean;
  recommendedColumns: ReviewStructuringColumnDef[];
  result: ReviewAnalysisSummary | null;
  suggesting: boolean;
  selectedTemplateId: string;
  templateName: string;
  templates: ReviewStructuringTemplate[];
  onApply: () => void;
  onGenerateSuggestion: () => void;
  onLoadTemplate: (templateId: string) => void;
  onRunValidation: () => void;
  onSaveTemplate: () => void;
  onClose: () => void;
  onTemplateNameChange: (value: string) => void;
}) {
  return (
    <section className="review-structuring-flow-card" aria-label="AI 추천 리뷰 분석 스키마 초안">
      <div className="review-structuring-flow-head">
        <span className="review-structuring-flow-icon"><Bot size={17} /></span>
        <div>
          <strong>AI 스키마 추천</strong>
          <p>리뷰 row를 어떤 출력 컬럼으로 나눌지 초안만 만듭니다. 적용 후 XFlow에서 직접 수정하고 템플릿으로 저장하세요.</p>
        </div>
        <span className={applied ? "review-structuring-status applied" : "review-structuring-status"}>
          {applied ? "편집 가능 상태" : "초안 대기"}
        </span>
        <button className="review-schema-close-button" type="button" aria-label="AI 스키마 추천 닫기" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="review-structuring-pipeline">
        <div><HardDrive size={15} /><span>입력</span><strong>리뷰 JSONL row</strong></div>
        <div><Bot size={15} /><span>AI 역할</span><strong>초안 스키마 추천만</strong></div>
        <div><Table2 size={15} /><span>실행 기준</span><strong>사용자가 수정/저장한 템플릿</strong></div>
      </div>
      <div className="review-structuring-columns">
        {recommendedColumns.length > 0
          ? recommendedColumns.map((column) => (
            <span key={column.targetName}>{column.targetName}</span>
          ))
          : <p>{suggesting ? "로컬 LLM이 추천 스키마를 생성하는 중입니다." : "아직 생성된 AI 추천 스키마가 없습니다."}</p>}
      </div>
      <div className="review-template-controls">
        <label>
          <span>템플릿 이름</span>
          <input value={templateName} onChange={(event) => onTemplateNameChange(event.target.value)} />
        </label>
        <label>
          <span>저장된 템플릿</span>
          <select value={selectedTemplateId} onChange={(event) => onLoadTemplate(event.target.value)}>
            <option value="">템플릿 선택</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}{template.createdAt ? ` · ${reviewTemplateDateLabel(template.createdAt)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button" type="button" disabled={!hasRequiredFields || suggesting} onClick={onGenerateSuggestion}>
          <Bot size={15} /> {suggesting ? "AI 추천 중..." : "AI 추천 새로 생성"}
        </button>
        <button className="secondary-button" type="button" onClick={onSaveTemplate}>
          <Save size={15} /> 현재 스키마 템플릿 저장
        </button>
      </div>
      {error && <div className="review-structuring-error">{error}</div>}
      <div className="review-structuring-actions">
        <span>{summarizeReviewAnalysisResult(result)}</span>
        <button className="secondary-button" type="button" disabled={!hasRequiredFields || loading} onClick={onRunValidation}>
          <PlayCircle size={15} /> {loading ? "검증 실행 중..." : "현재 템플릿 기준 실제 원본 검증"}
        </button>
        <button className="primary-button" type="button" disabled={!hasRequiredFields || recommendedColumns.length === 0 || suggesting} onClick={onApply}>
          <Check size={15} /> {applied ? "AI 초안 다시 적용" : "AI 추천 초안 적용"}
        </button>
      </div>
    </section>
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
  const [schemaFilter, setSchemaFilter] = useState("");
  const [selectedSchemaIndex, setSelectedSchemaIndex] = useState(0);
  const [flattenObjects, setFlattenObjects] = useState(true);
  const [flattenDepth, setFlattenDepth] = useState(2);
  const [flattenBaseSchema, setFlattenBaseSchema] = useState<SchemaBaseSnapshot | null>(null);
  const [schemaSampleScope, setSchemaSampleScope] = useState<SchemaSampleScope>("current");
  const [isRecheckingSchema, setIsRecheckingSchema] = useState(false);
  const [reviewStructuringResult, setReviewStructuringResult] = useState<ReviewAnalysisSummary | null>(null);
  const [reviewStructuringError, setReviewStructuringError] = useState("");
  const [isReviewStructuringRunning, setIsReviewStructuringRunning] = useState(false);
  const [isReviewSchemaSuggesting, setIsReviewSchemaSuggesting] = useState(false);
  const [isReviewSchemaPanelOpen, setIsReviewSchemaPanelOpen] = useState(false);
  const [reviewSchemaSuggestionColumns, setReviewSchemaSuggestionColumns] = useState<ReviewStructuringColumnDef[]>([]);
  const [reviewTemplates, setReviewTemplates] = useState<ReviewStructuringTemplate[]>(() => readReviewStructuringTemplates());
  const [selectedReviewTemplateId, setSelectedReviewTemplateId] = useState("");
  const [reviewTemplateName, setReviewTemplateName] = useState("Amazon 리뷰 분석 스키마");
  const hasInferredSchema = draft.schema.columns.length > 0;
  const schemaColumns: SchemaColumnDraft[] = draft.schema.columns;
  const includedSchemaColumns = schemaColumns.filter(isSchemaColumnIncluded);
  const includedSchemaColumnItems = schemaColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => isSchemaColumnIncluded(column));
  const schemaSampleRows = draft.schema.sampleRows;
  const lowConfidenceCount = includedSchemaColumns.filter((column) => (column.confidence ?? 100) < 80).length;
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
  const schemaFlowItems = schemaFlowWindow(schemaColumns, schemaSampleRows, selectedIndex);
  const selectedFlowItem = schemaFlowItems.find((item) => item.index === selectedIndex) ?? schemaFlowItems[0];
  const previewOutputItems = includedSchemaColumnItems.slice(0, 8);
  const hiddenPreviewColumnCount = Math.max(0, includedSchemaColumnItems.length - previewOutputItems.length);
  const previewOutputRows = schemaSampleRows.slice(0, 4);
  const reviewStructuringVisible = hasInferredSchema && shouldShowReviewStructuringFlow(draft, schemaColumns, sourceFormat);
  const reviewStructuringHasRequiredFields = hasReviewTextFields(schemaColumns);
  const selectedReviewTemplate = reviewTemplates.find((template) => template.id === selectedReviewTemplateId);
  const activeReviewColumns = selectedReviewTemplate?.columns?.length ? selectedReviewTemplate.columns : reviewSchemaSuggestionColumns;
  const reviewStructuringApplied = activeReviewColumns.length > 0 && isReviewStructuringApplied(schemaColumns, activeReviewColumns);
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
      transform: {
        outputColumns: buildSchemaDraftOutputColumns(columns),
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
      transform: {
        outputColumns: buildSchemaDraftOutputColumns(columns),
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

  const applyReviewStructuringPreset = () => {
    if (!hasInferredSchema) {
      onNotify("스키마 추론 후 리뷰 row 분석 프리셋을 적용할 수 있습니다.");
      return;
    }
    if (!reviewStructuringHasRequiredFields) {
      onNotify("리뷰 row 분석에는 최소 rating과 text 필드가 필요합니다.");
      return;
    }
    if (activeReviewColumns.length === 0) {
      onNotify("먼저 AI 추천 스키마 초안을 생성하세요.");
      return;
    }
    const activeOutputNames = reviewStructuringOutputNames(activeReviewColumns);
    const baseColumns = schemaColumns.filter((column) => (
      !activeOutputNames.has(schemaColumnName(column))
      && !column.sourceName.startsWith("__review_analysis.")
    ));
    const nextColumns = buildReviewStructuringColumns(schemaColumns, activeReviewColumns);
    const nextSampleRows = buildReviewStructuringSampleRows(baseColumns, schemaSampleRows, activeReviewColumns);
    const nextSteps = buildReviewStructuringTransformSteps(draft.transform.steps, activeReviewColumns);
    onDraftChange({
      schema: {
        columns: nextColumns,
        sampleRows: nextSampleRows,
        schemaFingerprint: buildSchemaFingerprint(nextColumns),
        summary: `AI 추천 리뷰 분석 스키마 적용 · 출력 파생 컬럼 ${activeReviewColumns.length}개 추가`,
      },
      transform: {
        outputColumns: buildSchemaDraftOutputColumns(nextColumns),
        steps: nextSteps,
        summary: `AI 추천 리뷰 분석 스키마 적용 · ${activeReviewColumns.map((column) => column.targetName).join(", ")}`,
      },
    });
    setSelectedSchemaIndex(Math.max(0, nextColumns.findIndex((column) => activeOutputNames.has(schemaColumnName(column)))));
    onAction("etl.schema.review_row_analysis_applied", "/api/etl/schema-inference/review-row-analysis", draft.source.sourceLabel || REVIEW_STRUCTURING_SOURCE_OBJECT, "success");
    onNotify("AI 추천 스키마 초안을 출력 스키마와 변환 단계에 반영했습니다. 이제 컬럼명/타입/변환식을 직접 수정하세요.");
  };

  const saveReviewStructuringTemplate = () => {
    const draftTemplate = buildReviewStructuringTemplateFromSchema(schemaColumns, reviewTemplateName);
    const nextTemplate = isReviewStructuringApplied(schemaColumns, activeReviewColumns)
      ? draftTemplate
      : { ...draftTemplate, columns: activeReviewColumns };
    if (nextTemplate.columns.length === 0) {
      onNotify("저장할 리뷰 분석 스키마가 없습니다. AI 추천 초안을 먼저 생성하세요.");
      return;
    }
    const nextTemplates = [nextTemplate, ...reviewTemplates.filter((template) => template.name !== nextTemplate.name)];
    setReviewTemplates(nextTemplates);
    setSelectedReviewTemplateId(nextTemplate.id);
    writeReviewStructuringTemplates(nextTemplates);
    onAction("etl.schema.review_template_saved", "/api/etl/schema-inference/review-row-analysis/templates", nextTemplate.name, "success");
    onNotify(`현재 리뷰 분석 스키마를 템플릿으로 저장했습니다: ${nextTemplate.name}`);
  };

  const loadReviewStructuringTemplate = (templateId: string) => {
    setSelectedReviewTemplateId(templateId);
    const template = reviewTemplates.find((item) => item.id === templateId);
    if (!template) return;
    setReviewTemplateName(template.name);
    onAction("etl.schema.review_template_selected", "/api/etl/schema-inference/review-row-analysis/templates", template.name, "success");
    onNotify(`템플릿을 선택했습니다. 적용을 누르면 현재 출력 스키마에 반영됩니다: ${template.name}`);
  };

  const generateReviewSchemaSuggestion = async () => {
    if (!reviewStructuringHasRequiredFields) {
      onNotify("AI 추천에는 최소 rating과 text 필드가 필요합니다.");
      return;
    }
    setIsReviewSchemaSuggesting(true);
    setReviewStructuringError("");
    try {
      const suggestion = await suggestReviewAnalysisSchema({
        sampleRows: schemaSampleRows.slice(0, 3),
        sourceColumns: schemaColumns.map((column) => ({
          name: column.targetName || column.sourceName,
          type: column.type,
        })),
      });
      setSelectedReviewTemplateId("");
      setReviewSchemaSuggestionColumns(suggestion.columns);
      onAction("etl.schema.review_schema_suggested", "/api/review-analysis/schema-suggestion", suggestion.model, "success");
      onNotify(`로컬 LLM이 리뷰 분석 스키마 초안 ${suggestion.columns.length}개 컬럼을 추천했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "로컬 LLM 스키마 추천에 실패했습니다.";
      setReviewStructuringError(message);
      onAction("etl.schema.review_schema_suggestion_failed", "/api/review-analysis/schema-suggestion", "local-llm", "failed");
      onNotify(message);
    } finally {
      setIsReviewSchemaSuggesting(false);
    }
  };

  const openReviewSchemaPanel = () => {
    setIsReviewSchemaPanelOpen(true);
    onAction("etl.schema.review_schema_panel_opened", "/api/review-analysis/schema-suggestion", draft.source.sourceLabel || "source", "success");
    if (reviewStructuringHasRequiredFields && activeReviewColumns.length === 0 && !isReviewSchemaSuggesting) {
      void generateReviewSchemaSuggestion();
    }
  };

  const runReviewStructuringValidation = async () => {
    setIsReviewStructuringRunning(true);
    setReviewStructuringError("");
    try {
      const configuredSchema = buildReviewStructuringTemplateFromSchema(schemaColumns, reviewTemplateName).columns;
      const validationSchema = isReviewStructuringApplied(schemaColumns, activeReviewColumns) ? configuredSchema : activeReviewColumns;
      if (validationSchema.length === 0) {
        onNotify("검증할 AI 추천 스키마가 없습니다.");
        return;
      }
      const result = await runCellphonesReviewAnalysis(50000, validationSchema);
      setReviewStructuringResult(result);
      onAction("etl.schema.review_row_analysis_validated", "/api/review-analysis/cellphones/run", result.runId ?? "Cell_Phones_and_Accessories", "success");
      onNotify(`실제 원본 검증 완료: ${(result.processedRows ?? 0).toLocaleString()}행을 처리했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "실제 원본 검증 실행에 실패했습니다.";
      setReviewStructuringError(message);
      onAction("etl.schema.review_row_analysis_validation_failed", "/api/review-analysis/cellphones/run", "Cell_Phones_and_Accessories", "failed");
      onNotify(message);
    } finally {
      setIsReviewStructuringRunning(false);
    }
  };

  const approveSchema = () => {
    if (!hasInferredSchema) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("확정할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return false;
    }
    if (includedSchemaColumns.length === 0) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("출력에 포함된 컬럼이 없습니다. 최소 1개 컬럼을 포함해야 실행할 수 있습니다.");
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
    if (draft.source.sourceType === "SQL Result") {
      onAction("etl.schema.inference_skipped", "/api/query/runs", draft.source.sourceLabel || "SQL Result");
      onNotify("SQL Preview에서 전달된 schema를 사용하므로 재확인을 생략합니다.");
      return;
    }

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
    <div className="schema-workbench schema-workbench-focused">
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

      {reviewStructuringVisible && isReviewSchemaPanelOpen && (
        <div className="review-schema-modal-backdrop" role="presentation" onMouseDown={() => setIsReviewSchemaPanelOpen(false)}>
          <div className="review-schema-modal" role="dialog" aria-modal="true" aria-label="AI 스키마 추천" onMouseDown={(event) => event.stopPropagation()}>
            <ReviewStructuringFlowCard
              applied={reviewStructuringApplied}
              error={reviewStructuringError}
              hasRequiredFields={reviewStructuringHasRequiredFields}
              loading={isReviewStructuringRunning}
              recommendedColumns={activeReviewColumns}
              result={reviewStructuringResult}
              suggesting={isReviewSchemaSuggesting}
              selectedTemplateId={selectedReviewTemplateId}
              templateName={reviewTemplateName}
              templates={reviewTemplates}
              onApply={applyReviewStructuringPreset}
              onClose={() => setIsReviewSchemaPanelOpen(false)}
              onGenerateSuggestion={generateReviewSchemaSuggestion}
              onLoadTemplate={loadReviewStructuringTemplate}
              onRunValidation={runReviewStructuringValidation}
              onSaveTemplate={saveReviewStructuringTemplate}
              onTemplateNameChange={setReviewTemplateName}
            />
          </div>
        </div>
      )}

      <XFlowSchemaTransformEditor
        columns={schemaColumns}
        sampleRows={schemaSampleRows}
        selectedIndex={selectedIndex}
        sourceFormat={sourceFormat}
        transformSteps={draft.transform.steps}
        onSelectedIndexChange={setSelectedSchemaIndex}
        onColumnsChange={(nextColumns, nextSampleRows = schemaSampleRows) => {
          patchSchemaColumns(nextColumns, nextSampleRows);
          const boundedIndex = nextColumns.length > 0 ? Math.min(selectedIndex, nextColumns.length - 1) : 0;
          setSelectedSchemaIndex(boundedIndex);
        }}
        onTransformStepsChange={(steps) => {
          onDraftChange({
            transform: {
              steps,
              summary: steps.length > 0 ? `스키마 단계 변환 ${steps.length}개 설정` : "스키마 단계 변환 없음",
            },
          });
        }}
      />

      <section className="schema-bottom-bar">
        <button className="secondary-button" type="button" onClick={onPrev}>이전: 데이터 탐색</button>
        {reviewStructuringVisible && (
          <button className="secondary-button ai-schema-action-button" type="button" disabled={!reviewStructuringHasRequiredFields} onClick={openReviewSchemaPanel}>
            <Bot size={15} /> AI 스키마 추천
          </button>
        )}
        <button className="secondary-button" type="button" disabled={!hasInferredSchema} onClick={exportSchema}><Download size={15} /> 스키마 JSON 내보내기</button>
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

function transformOperationLabel(operation: string) {
  return TRANSFORM_OPERATION_LABELS[operation as TransformOperation] ?? operation;
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

function buildSchemaDraftOutputColumns(columns: SchemaColumnDraft[]) {
  return columns
    .filter(isSchemaColumnIncluded)
    .map((column) => [schemaColumnOutputName(column), column.type] as [string, string]);
}

function reviewTransformLabel(outputName: string, sourceColumn: SchemaColumnDraft | undefined, steps: TransformStepDraft[]) {
  const matchedSteps = steps.filter((step) => step.enabled !== false && step.output === outputName);
  if (matchedSteps.length > 0) {
    return matchedSteps
      .map((step) => `${step.operation}${step.params ? `: ${step.params}` : ""}`)
      .join(" -> ");
  }
  if (!sourceColumn) return "변환 출력";
  return sourceColumn.sourceName === outputName ? `SOURCE.${sourceColumn.sourceName}` : `${sourceColumn.sourceName} -> ${outputName}`;
}

function getRuleSourceColumns(columns: SchemaColumnDraft[]) {
  return columns.filter(isSchemaColumnIncluded).map(schemaColumnOutputName).filter(Boolean);
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
      if (!isSchemaColumnIncluded(column)) return;
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
  const columns = draft.schema.columns.filter(isSchemaColumnIncluded);
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
  const columns = draft.schema.columns.filter(isSchemaColumnIncluded);
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
  const sourceColumn = schemaColumns.find((column) => isSchemaColumnIncluded(column) && (schemaColumnOutputName(column) === name || column.sourceName === name));
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
                <td>{row.params}</td>
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
  onTimezoneChange,
  onTimeCommit,
  onTimeChange,
  retryPolicy,
  selectedDay,
  time,
  timezone,
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
  onTimezoneChange: (timezone: string) => void;
  onTimeCommit: () => void;
  onTimeChange: (time: string) => void;
  retryPolicy: RetryPolicyDraft;
  selectedDay: string;
  time: string;
  timezone: string;
}) {
  const cronIsValid = isValidCronExpression(customCron);
  const visibleRepeatFrequencyOptions = frequency === "custom"
    ? repeatFrequencyOptions
    : repeatFrequencyOptions.filter((option) => option.value !== "custom");
  const preview = frequency === "hourly"
    ? `매시간 ${minute}분에 실행됩니다. 다음 실행 예정은 저장 시점 기준으로 계산됩니다.`
    : frequency === "daily"
      ? `매일 ${time}에 실행됩니다. 다음 실행 예정은 저장 시점 기준으로 계산됩니다.`
      : frequency === "custom"
        ? `Cron ${customCron || DEFAULT_CUSTOM_CRON} 기준으로 반복 실행됩니다.`
        : `매주 ${selectedDay}요일 ${time}에 실행됩니다. 다음 실행 예정은 저장 시점 기준으로 계산됩니다.`;

  return (
    <section className="xflow-review-card schedule-xflow-card">
      <div className="xflow-review-card-header">
        <span className="xflow-review-icon schema"><Repeat2 size={17} /></span>
        <div>
          <h2>반복 실행 상세 설정</h2>
          <p>실행 주기, 시간대, 재시도 정책을 한 번에 확인하고 조정합니다.</p>
        </div>
        <span className="schedule-xflow-state">{repeatFrequencyLabels[frequency]}</span>
      </div>
      <div className="schedule-config-section">
        <div className="schedule-xflow-subheader">
          <Clock3 size={16} />
          <h3>실행 일정</h3>
        </div>
        <div className="schedule-xflow-form-grid">
          <label className="field">
            <span>반복 주기</span>
            <select className="input control-input" value={frequency} onChange={(event) => onFrequencyChange(event.target.value as RepeatFrequency)}>
              {visibleRepeatFrequencyOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
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
          <label className="field">
            <span>시간대</span>
            <select className="input control-input" value={timezone} onChange={(event) => onTimezoneChange(event.target.value)}>
              {timezoneOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="schedule-xflow-preview">
          <InfoBox title="실행 미리보기" body={preview} />
          {frequency === "custom" && !cronIsValid && <InfoBox title="Cron 형식 확인" body="5개 필드 형식만 저장합니다. 예: 0 10 * * 1-5" />}
        </div>
      </div>
      <div className="schedule-xflow-policy-section">
        <div className="schedule-xflow-subheader">
          <ShieldCheck size={16} />
          <h3>재시도 정책</h3>
        </div>
        <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
      </div>
    </section>
  );
}

function NoScheduleSettings({ onRetryPolicyChange, retryPolicy }: { onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft }) {
  return (
    <section className="xflow-review-card schedule-xflow-card">
      <div className="xflow-review-card-header">
        <span className="xflow-review-icon"><PlayCircle size={17} /></span>
        <div>
          <h2>직접 실행 정책</h2>
          <p>자동 예약 없이 저장하고 필요할 때 Job 목록에서 직접 실행합니다.</p>
        </div>
        <span className="schedule-xflow-state muted">스케줄 없음</span>
      </div>
      <div className="xflow-review-validation schedule-xflow-validation">
        <div className="ready">
          <Check size={14} />
          <span>자동 스케줄</span>
          <strong>없음</strong>
        </div>
        <div className="ready">
          <Check size={14} />
          <span>실행 방식</span>
          <strong>수동</strong>
        </div>
        <div className="needs-review">
          <Clock3 size={14} />
          <span>다음 실행</span>
          <strong>미생성</strong>
        </div>
      </div>
      <div className="schedule-xflow-policy-section">
        <div className="schedule-xflow-subheader">
          <ShieldCheck size={16} />
          <h3>재시도 정책</h3>
        </div>
        <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
        <InfoBox title="다음 실행 없음" body="스케줄을 저장하지 않으므로 다음 예약 일시는 생성되지 않습니다. 필요할 때 Job 목록에서 즉시 실행합니다." />
      </div>
    </section>
  );
}

export function TargetPage({
  draft,
  onDraftChange,
  onPrev,
  onNext,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialTarget = getTargetDraftValues(draft);
  const draftTarget = (draft as DraftPipelineWithSlices).target;
  const targetLayer = initialTarget.targetLayer;
  const inferredTarget = useMemo(
    () => inferTargetSchema(draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules),
    [draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules],
  );
  const sampleTargetSchema = useMemo(() => inferTargetSchema([], [], undefined), []);
  const [targetDataset, setTargetDataset] = useState(initialTarget.targetDataset);
  const [databaseName, setDatabaseName] = useState(draftTarget?.databaseName ?? "asklake");
  const [targetStoragePath, setTargetStoragePath] = useState(initialTarget.storagePath);
  const [targetDescription, setTargetDescription] = useState(initialTarget.description);
  const [targetFormat, setTargetFormat] = useState<TargetFileFormat>(normalizeTargetFileFormat(initialTarget.targetFormat));
  const [targetOwner, setTargetOwner] = useState(draftTarget?.owner ?? initialTarget.owner);
  const [targetManager, setTargetManager] = useState(draftTarget?.manager ?? initialTarget.owner);
  const [targetTags, setTargetTags] = useState<string[]>(initialTarget.tags);
  const [customTag, setCustomTag] = useState("");
  const [partitionColumns, setPartitionColumns] = useState<string[]>(draftTarget?.partitionColumns ?? initialTarget.partitionColumns);
  const [indexColumns] = useState<string[]>(draftTarget?.indexColumns ?? []);
  const [schemaRules, setSchemaRules] = useState<TargetSchemaRule[]>(inferredTarget.schemaRules);
  const lastTestRun = draftTarget?.lastTestRun ?? { status: "idle", logs: [] };
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [formatOptionsOpen, setFormatOptionsOpen] = useState(false);

  const shouldUseSampleTargetSchema = useMemo(
    () => !schemaRules.some((rule) => rule.partitionable && !rule.raw),
    [schemaRules],
  );
  const activeSchemaRules = shouldUseSampleTargetSchema ? sampleTargetSchema.schemaRules : schemaRules;
  const activePreviewRows = shouldUseSampleTargetSchema ? sampleTargetSchema.previewRows : inferredTarget.previewRows;
  const activeJsonParseFailed = shouldUseSampleTargetSchema ? sampleTargetSchema.jsonParseFailed : inferredTarget.jsonParseFailed;
  const orderedSchemaRules = useMemo(() => [...activeSchemaRules], [activeSchemaRules]);
  const usedSchemaRules = useMemo(() => orderedSchemaRules.filter((rule) => rule.use), [orderedSchemaRules]);
  const partitionCandidates = useMemo(() => orderedSchemaRules.filter((rule) => rule.partitionable && !rule.raw), [orderedSchemaRules]);
  const filteredPartitionColumns = partitionColumns
    .filter((column) => partitionCandidates.some((rule) => rule.name === column && rule.use))
    .slice(0, 1);
  const previewRows = useMemo(() => activePreviewRows.slice(0, 5).map((row) => {
    const previewRow: Record<string, string> = {};
    usedSchemaRules.forEach((rule) => {
      previewRow[rule.name] = row[rule.name] ?? "";
    });
    return previewRow;
  }), [activePreviewRows, usedSchemaRules]);
  const lineage = {
    sourceName: draft.source.sourceLabel || "Source",
    targetDatasetName: targetDataset || "Target",
    targetStoragePath,
    transformStepCount: draft.transform.steps.length,
  };
  const targetTableName = targetDataset.trim();
  const buildConfig = (testRun: TargetTestRun = lastTestRun): TargetSavedConfig => ({
    metadata: {
      databaseName,
      datasetName: targetDataset,
      description: targetDescription,
      fileFormat: targetFormat,
      manager: targetManager,
      owner: targetOwner,
      storagePath: targetStoragePath,
      targetTableName,
    },
    tags: targetTags,
    partitionColumns: filteredPartitionColumns,
    indexColumns,
    schemaRules: activeSchemaRules,
    previewRows,
    lineage,
    lastTestRun: testRun,
  });

  const persistDraft = (config: TargetSavedConfig) => {
    onDraftChange({
      jobName: buildJobName(config.metadata.datasetName),
      compression: "Snappy",
      partition: config.partitionColumns.join("/"),
      storagePath: config.metadata.storagePath,
      storageType: "S3",
      target: {
        databaseName: config.metadata.databaseName,
        datasetName: config.metadata.datasetName,
        description: config.metadata.description,
        format: config.metadata.fileFormat,
        indexColumns: config.indexColumns,
        lastTestRun: config.lastTestRun,
        manager: config.metadata.manager,
        owner: config.metadata.owner,
        partitionColumns: config.partitionColumns,
        rag: false,
        schemaRules: config.schemaRules,
        storagePath: config.metadata.storagePath,
        tableName: config.metadata.targetTableName,
        targetTableName: config.metadata.targetTableName,
        tags: config.tags,
        testStatus: config.lastTestRun.status === "success" ? "success" : config.lastTestRun.status === "failed" ? "failed" : "idle",
      },
      targetDataset: config.metadata.datasetName,
      targetFormat: config.metadata.fileFormat,
      targetLayer,
      rag: false,
    });
  };

  const updateSchemaRule = (sourceName: string, patch: Partial<TargetSchemaRule>) => {
    setSchemaRules((currentRules) => {
      const nextRules = currentRules.map((rule) => {
        if (rule.sourceName !== sourceName) return rule;
        const nextRule = { ...rule, ...patch };
        if (patch.type) {
          nextRule.partitionable = !nextRule.raw && patch.type !== "json";
        }
        return nextRule;
      });
      return nextRules;
    });
  };

  const toggleTag = (tag: string) => {
    setTargetTags((currentTags) => currentTags.includes(tag)
      ? currentTags.filter((currentTag) => currentTag !== tag)
      : [...currentTags, tag]);
  };

  const addCustomTag = () => {
    const nextTag = customTag.trim();
    if (!nextTag) return;
    setTargetTags((currentTags) => currentTags.includes(nextTag) ? currentTags : [...currentTags, nextTag]);
    setCustomTag("");
  };

  const togglePartitionColumn = (columnName: string) => {
    setPartitionColumns([columnName]);
  };

  const saveTargetConfig = () => {
    const config = buildConfig();
    const errors = validateTargetConfig(config, activeJsonParseFailed);
    setValidationErrors(errors);

    if (errors.length > 0) {
      return false;
    }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(TARGET_CONFIG_STORAGE_KEY, JSON.stringify(config, null, 2));
    }
    persistDraft(config);
    return true;
  };

  const handleNext = () => {
    if (!saveTargetConfig()) return;
    onNext();
  };

  const renderPartitionOption = (rule: TargetSchemaRule) => {
    const selected = filteredPartitionColumns[0] === rule.name;
    const disabled = !rule.use;
    return (
      <label className={["target-partition-option", selected ? "active" : "", disabled ? "disabled" : ""].filter(Boolean).join(" ")} key={rule.name}>
        <input checked={selected} disabled={disabled} name="target-partition-column" type="radio" onChange={() => togglePartitionColumn(rule.name)} />
        <span className="target-partition-name">{rule.name}</span>
        <span className="target-partition-type">{formatPartitionColumnType(rule)}</span>
      </label>
    );
  };

  return (
    <CreationFlowLayout actions={<CreationTopActions prevLabel="이전" nextLabel="다음" onPrev={onPrev} onNext={handleNext} />}>
      <PageTitle title="타겟 설정" description="최종 데이터셋의 저장 명세, 컬럼 규칙, 파티션을 설정합니다." />
      {validationErrors.length > 0 ? (
        <div className="target-validation-summary" role="alert">
          {validationErrors.map((error) => <span key={error}>{error}</span>)}
        </div>
      ) : null}
      <div className="xflow-review-stack target-xflow-stack">
        <section className="xflow-review-card target-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon"><FileText size={17} /></span>
            <div>
              <h2>Basic Information</h2>
              <p>타겟 데이터셋의 이름과 소유 정보를 설정합니다.</p>
            </div>
          </div>
          <div className="target-xflow-form-grid basic">
            <label className="field wide">
              <span>데이터셋명</span>
              <input className="input control-input" value={targetDataset} onChange={(event) => setTargetDataset(event.target.value)} />
            </label>
            <label className="field">
              <span>오너</span>
              <input className="input control-input" value={targetOwner} onChange={(event) => setTargetOwner(event.target.value)} />
            </label>
            <label className="field">
              <span>담당자</span>
              <input className="input control-input" value={targetManager} onChange={(event) => setTargetManager(event.target.value)} />
            </label>
            <label className="field wide">
              <span>설명</span>
              <input className="input control-input" value={targetDescription} onChange={(event) => setTargetDescription(event.target.value)} />
            </label>
          </div>
        </section>

        <section className="xflow-review-card target-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon destination"><HardDrive size={17} /></span>
            <div>
              <h2>Destination Settings</h2>
              <p>Lake 저장 위치와 데이터셋 물리 저장 방식을 설정합니다.</p>
            </div>
          </div>
          <div className="target-xflow-form-grid destination">
            <label className="field target-db-field">
              <span>DB 선택</span>
              <DatabaseField value={databaseName} onChange={setDatabaseName} />
            </label>
            <label className="field target-format-field">
              <span>포맷</span>
              <div className="target-format-toggle" role="group" aria-label="파일 포맷 선택">
                <button
                  aria-expanded={formatOptionsOpen}
                  className="target-format-trigger"
                  type="button"
                  onClick={() => setFormatOptionsOpen((open) => !open)}
                >
                  <span>{targetFormat}</span>
                  {formatOptionsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {formatOptionsOpen ? (
                  <div className="target-format-menu">
                    {TARGET_FORMAT_OPTIONS.map((format) => (
                      <button
                        aria-pressed={targetFormat === format}
                        className={targetFormat === format ? "target-format-option active" : "target-format-option"}
                        key={format}
                        type="button"
                        onClick={() => {
                          setTargetFormat(format);
                          setFormatOptionsOpen(false);
                        }}
                      >
                        {format}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
            <label className="field wide target-storage-field">
              <span>저장경로</span>
              <S3PathField value={targetStoragePath} onChange={setTargetStoragePath} />
            </label>
          </div>
        </section>
        <section className="xflow-review-card target-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon permission"><SlidersHorizontal size={17} /></span>
            <div>
              <h2>Partition & Tags</h2>
              <p>검색, 저장, 운영 기준으로 사용할 태그와 파티션을 설정합니다.</p>
            </div>
          </div>
          <div className="target-xflow-split">
            <div className="target-xflow-subsection">
              <div className="target-xflow-subheader">
                <BookOpen size={16} />
                <h3>Tags</h3>
              </div>
              {targetTags.length > 0 ? (
                <div className="target-chip-grid" role="group" aria-label="타겟 태그">
                  {targetTags.map((tag) => (
                    <button className={targetTags.includes(tag) ? "target-chip active" : "target-chip"} key={tag} type="button" onClick={() => toggleTag(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="target-inline-controls">
                <input className="input control-input" placeholder="직접 태그 추가" value={customTag} onChange={(event) => setCustomTag(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomTag();
                  }
                }} />
                <button className="secondary-button" type="button" onClick={addCustomTag}><Plus size={14} />추가</button>
              </div>
            </div>
            <div className="target-xflow-subsection">
              <div className="target-xflow-subheader">
                <SlidersHorizontal size={16} />
                <h3>Partition</h3>
              </div>
              <div className="target-partition-settings">
                <div className="target-partition-grid" role="radiogroup" aria-label="파티션 컬럼 선택">
                  {partitionCandidates.map(renderPartitionOption)}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </CreationFlowLayout>
  );
}
export function PermissionPage({
  draft,
  onDraftChange,
  onNext,
  onPrev,
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
    const permissionRoles = PERMISSION_ROLES.map((role) => ({
      access: [...role.access],
      checked: Boolean(roleChecks[role.name] ?? role.checked),
      name: role.name,
    }));

    onDraftChange({
      owner: nextOwner,
      permissionRoles,
      permission: {
        roles: permissionRoles,
      },
      permissionSummary: buildPermissionSummary(nextPermissionTemplate, nextVisibility, nextApprovalStatus),
    });
  };
  const goNext = () => {
    applyPermissionDraft();
    onNext();
  };
  const selectedRoleCount = PERMISSION_ROLES.filter((role) => Boolean(roleChecks[role.name])).length;
  const governanceChecks = [
    ["공유 범위", visibility, visibility === "외부 공유" ? "검토 필요" : "안전"],
    ["민감 데이터", "review_text 포함", "검토 필요"],
    ["승인자", dataOwner, approvalStatus === "승인 완료" ? "준비됨" : "대기"],
  ];

  return (
    <CreationFlowLayout
      variant="permission"
      actions={<CreationTopActions onPrev={onPrev} onNext={goNext} />}
    >
      <PageTitle title="권한 설정" description="생성할 데이터셋에 접근할 수 있는 역할과 사용자를 선택하세요." />
      <div className="xflow-review-stack permission-xflow-stack">
        <section className="xflow-review-card permission-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon permission"><ShieldCheck size={17} /></span>
            <div>
              <h2>Governance Check</h2>
              <p>공개 범위, 민감 데이터, 승인 상태를 생성 전에 확인합니다.</p>
            </div>
          </div>
          <div className="xflow-review-validation permission-xflow-validation">
            {governanceChecks.map(([label, value, status]) => (
              <div className={status === "안전" || status === "준비됨" ? "ready" : "needs-review"} key={label}>
                <Check size={15} />
                <span>{label}</span>
                <strong>{value} · {status}</strong>
              </div>
            ))}
          </div>
          <InfoBox title="권한 검토 필요" body="외부 공유 또는 민감 데이터 접근 권한은 데이터 오너 승인 후 적용됩니다." />
        </section>

        <section className="xflow-review-card permission-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon"><SlidersHorizontal size={17} /></span>
            <div>
              <h2>Access Policy</h2>
              <p>조직 정책에 맞는 권한 템플릿과 공개 범위를 설정합니다.</p>
            </div>
          </div>
          <InfoBox title="추천 권한 템플릿" body="유사 데이터셋의 접근 권한과 조직 정책을 기반으로 추천되었습니다." />
          <div className="target-xflow-form-grid permission-xflow-form-grid">
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

        <section className="xflow-review-card permission-xflow-card">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon schema"><CircleUser size={17} /></span>
            <div>
              <h2>Role Grants</h2>
              <p>{selectedRoleCount}개 역할 선택 · 템플릿 기준 접근 권한을 조정합니다.</p>
            </div>
          </div>
          <div className="permission-xflow-role-list">
            {PERMISSION_ROLES.map((role) => {
              const selected = Boolean(roleChecks[role.name]);
              const recommended = role.name === permissionTemplate;
              return (
                <label className={["permission-xflow-role", selected ? "active" : "", recommended ? "recommended" : ""].filter(Boolean).join(" ")} key={role.name}>
                  <input type="checkbox" checked={selected} onChange={(event) => setRoleChecks((checks) => ({ ...checks, [role.name]: event.target.checked }))} />
                  <span className="permission-xflow-role-body">
                    <span className="permission-xflow-role-title">
                      <strong>{role.name}</strong>
                      {recommended ? <em>Template</em> : null}
                    </span>
                    <small>{role.note}</small>
                  </span>
                  <div className="permission-chip-row permission-xflow-access-row">
                    {PERMISSION_ACCESS_ITEMS.map((item) => (
                      <em className={selected && role.access.includes(item) ? "allowed" : ""} key={item}>{item}</em>
                    ))}
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      </div>
    </CreationFlowLayout>
  );
}

export function ReviewPage({
  createPending,
  draft,
  onCreate,
  onEdit,
}: {
  createPending?: boolean;
  draft: DraftPipeline;
  onCreate: () => void;
  onEdit: (flow: FlowId) => void;
  onSave: () => void;
}) {
  const request = toCreatePipelineRequest(draft);
  const includedReviewColumns = draft.schema.columns.filter(isSchemaColumnIncluded);
  const schemaRows: ReviewSchemaRow[] = draft.transform.outputColumns.length > 0
    ? draft.transform.outputColumns.map(([name, type]) => {
        const sourceColumn = includedReviewColumns.find((column) => schemaColumnOutputName(column) === name || column.sourceName === name);
        return {
          columnName: name,
          nullable: sourceColumn ? (sourceColumn.nullable ? "예" : "아니요") : "생성",
          transform: reviewTransformLabel(name, sourceColumn, draft.transform.steps),
          type,
        };
      })
    : includedReviewColumns.map((column) => ({
        columnName: column.targetName,
        nullable: column.nullable ? "예" : "아니요",
        transform: reviewTransformLabel(schemaColumnOutputName(column), column, draft.transform.steps),
        type: column.type,
      }));
  const sourceSummary = summarizeSourceConfig(request.sourceConfig);
  const permissionReview = getPermissionDraftValues(draft);
  const targetReview = getTargetDraftValues(draft);
  const targetDatabaseName = (draft as DraftPipelineWithSlices).target?.databaseName ?? "asklake";
  const basicInformationRows = [
    ["Job ID", request.id],
    ["Job Name", targetReview.jobName],
    ["Source", `${sourceTypeLabel(request.sourceType)} · ${sourceSummary || request.sourceLabel}`],
    ["Target Dataset", targetReview.targetDataset],
    ["Description", targetReview.description],
  ];
  const destinationRows = [
    ["Output Path", targetReview.storagePath],
    ["Database", targetDatabaseName],
    ["Table Name", targetReview.tableName],
    ["Format", targetReview.targetFormat],
    ["Layer", targetReview.targetLayer],
    ["Partition", targetReview.partitionColumns.length > 0 ? targetReview.partitionColumns.join(", ") : "없음"],
  ];
  const permissionRows = [
    ["Permission Template", permissionReview.permissionTemplate],
    ["Visibility", permissionReview.visibility],
    ["Approval", permissionReview.approvalStatus],
    ["Owner", permissionReview.owner],
    ["Summary", permissionReview.permissionSummary],
  ];
  const validationRows = [
    ["소스 연결", draft.source.connectionStatus === "success" ? "실제 연결 확인" : "연결 테스트 필요"],
    ["스키마", includedReviewColumns.length > 0 ? "추론 결과 있음" : "추론 필요"],
    ["처리 규칙", request.ruleSummary ? "설정값 저장" : "규칙 없음"],
    ["스케줄", request.scheduleLabel ? "예약 메타데이터 저장" : "확인 필요"],
    ["실패 재시도", request.retryPolicySummary ? "정책 메타데이터 저장" : "기본 정책"],
    ["권한/타겟", request.permissionSummary && request.targetDataset ? "메타데이터 저장" : "확인 필요"],
  ];
  const readyValidationStatuses = new Set(["실제 연결 확인", "추론 결과 있음", "설정값 저장", "규칙 없음", "예약 메타데이터 저장", "정책 메타데이터 저장", "기본 정책", "메타데이터 저장"]);
  const canCreate = draft.source.connectionStatus === "success"
    && includedReviewColumns.length > 0
    && Boolean(request.sourceType.trim())
    && Boolean(request.sourceLabel.trim())
    && Boolean(request.targetDataset.trim())
    && Boolean(request.owner.trim());
  const createDisabled = createPending || !canCreate;
  const createLabel = createPending ? "생성 중..." : canCreate ? "파이프라인 생성" : "검증 필요";

  return (
    <CreationFlowLayout
      variant="review"
      actions={<CreationTopActions nextDisabled={createDisabled} nextLabel={createLabel} onPrev={() => onEdit("target")} onNext={onCreate} />}
    >
        <PageTitle title="검토 및 생성" description="설정된 모든 구성을 확인하고 데이터 파이프라인 생성을 완료하세요." />
        <div className="xflow-review-stack">
          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon"><FileText size={17} /></span>
              <div>
                <h2>Basic Information</h2>
                <p>생성될 파이프라인과 타겟 데이터셋의 기본 정보를 확인합니다.</p>
              </div>
              <button className="xflow-review-edit" type="button" onClick={() => onEdit("target")}><Pencil size={14} /> 수정</button>
            </div>
            <dl className="xflow-review-kv">
              {basicInformationRows.map(([label, value]) => (
                <div className={label === "Description" ? "wide" : undefined} key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon schema"><Database size={17} /></span>
              <div>
                <h2>Output Schema</h2>
              </div>
              <button className="xflow-review-edit" type="button" onClick={() => onEdit("schema")}><Pencil size={14} /> 수정</button>
            </div>
            <ReviewSchemaTable rows={schemaRows} />
          </section>

          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon destination"><HardDrive size={17} /></span>
              <div>
                <h2>Destination Settings</h2>
                <p>Lake 저장 위치와 데이터셋 물리 저장 방식을 확인합니다.</p>
              </div>
              <button className="xflow-review-edit" type="button" onClick={() => onEdit("target")}><Pencil size={14} /> 수정</button>
            </div>
            <dl className="xflow-review-kv destination">
              {destinationRows.map(([label, value]) => (
                <div className={label === "Output Path" ? "wide" : undefined} key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon permission"><ShieldCheck size={17} /></span>
              <div>
                <h2>Permission & Validation</h2>
                <p>접근 권한과 생성 전 체크 항목을 확인합니다.</p>
              </div>
              <button className="xflow-review-edit" type="button" onClick={() => onEdit("permission")}><Pencil size={14} /> 수정</button>
            </div>
            <dl className="xflow-review-kv permission">
              {permissionRows.map(([label, value]) => (
                <div className={label === "Summary" ? "wide" : undefined} key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="xflow-review-validation">
              {validationRows.map(([item, status]) => (
                <div className={readyValidationStatuses.has(status) ? "ready" : "needs-review"} key={item}>
                  <Check size={15} />
                  <span>{item}</span>
                  <strong>{status}</strong>
                </div>
              ))}
            </div>
            <InfoBox title="안내사항" body="파이프라인 생성 후 실행이 성공하면 데이터 카탈로그에 등록되고 SQL 쿼리를 수행할 수 있습니다." />
          </section>
        </div>
    </CreationFlowLayout>
  );
}

function ReviewSchemaTable({ rows }: { rows: ReviewSchemaRow[] }) {
  const columns = useMemo<ColumnDef<ReviewSchemaRow>[]>(
    () => [
      { accessorKey: "columnName", cell: (info) => info.getValue<string>(), header: "컬럼명" },
      { accessorKey: "type", cell: (info) => info.getValue<string>(), header: "타입" },
      { accessorKey: "nullable", cell: (info) => info.getValue<string>(), header: "Null 허용" },
      { accessorKey: "transform", cell: (info) => info.getValue<string>(), header: "변환식" },
    ],
    [],
  );
  const table = useReactTable({
    columns,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table className="schema-table review-schema-table">
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length}>소스 연결과 스키마 추론이 완료되면 출력 스키마가 표시됩니다.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function summarizeSourceConfig(sourceConfig: Array<[string, string]>) {
  const priorityLabels = ["Storage Provider", "Endpoint URL", "Bucket / Stage Name", "Path / Prefix", "Path", "DATASET OR TABLE SELECTOR", "TOPIC / QUEUE NAME", "CONSUMER GROUP ID", "Broker / Endpoint"];
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
  if (sourceType === "Stream / Kafka" || sourceType === "Kafka JSON") {
    return valuesByLabel.get("TOPIC / QUEUE NAME") || valuesByLabel.get("Topic") || sourceType;
  }

  if (sourceType === "File / S3") {
    const bucket = valuesByLabel.get("Bucket / Stage Name");
    const prefix = valuesByLabel.get("Path / Prefix");
    if (bucket && prefix) return `${bucket}/${prefix}`;
    if (bucket) return bucket;
  }

  return fields.find(([fieldLabel]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? sourceType;
}

function sourceConfigValue(fields: Array<[string, string]>, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

function hasSqlResultPreviewConfig(fields: Array<[string, string]>) {
  return Boolean(sourceConfigValue(fields, "Source Dataset") && sourceConfigValue(fields, "SQL Run ID") && sourceConfigValue(fields, "Query"));
}
