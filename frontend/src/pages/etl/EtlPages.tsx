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
  Cable,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  CircleUser,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  HardDrive,
  Info,
  Maximize2,
  Minus,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Star,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { Field, InfoBox, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationTopActions, CreationValidationPanel } from "../../components/creation/CreationFlow";
import { ActionGroup } from "@/components/ui/action-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CommandBar } from "@/components/ui/command-bar";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/ui/empty";
import { Field as FormField, Field as ShadcnField, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { FormFieldGroup, NativeSelectField } from "@/components/ui/form-field-group";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { KeyValueList } from "@/components/ui/key-value-list";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { TagList } from "@/components/ui/tag-list";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ValidationList } from "@/components/ui/validation-list";
import { cn } from "@/lib/utils";
import { S3PathField } from "../../components/s3/S3PathField";
import { runTransformQualitySamplePreview } from "../../data/transformQualityPreview";
import { normalizeRetryPolicy, retryFailureActionLabels, scheduleOverlapPolicyLabels, toCreatePipelineRequest } from "../../services/draftPipelineContract";
import { getDatasets } from "../../services/mockApi";
import { listS3Buckets } from "../../services/s3PathApi";
import {
  buildReviewSnapshotRequest,
  getReviewSnapshot,
  getReviewSnapshotRequestKey,
  type ReviewSnapshot,
  type ReviewSnapshotRequest,
} from "../../services/reviewApi";
import { fetchPermissionOptions } from "../../services/permissionApi";
import { getSourceConnectorDefaults, listSourceAssets, previewRecordParsing, testSourceConnector, type SourceConnectorAnalysis } from "../../services/sourceConnectorService";
import type { AuditResult, CatalogDataset, DraftPipeline, DraftPipelinePatch, FlowId, PermissionAction, PermissionOptionsResponse, RecordParsingDraft, RecordParsingPreviewResponse, ScheduleFlowId, SchemaColumnDraft, SourceDraft, TargetLayer } from "../../types";
import type { QualityRuleDraft, RetryPolicyDraft, ScheduleDraft, ScheduleOverlapPolicy, TransformStepDraft, WatermarkPolicyDraft, WatermarkWindowMode } from "../../types/etl";
import type { QualityRuleOption, TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview, TransformQualityValidationResult } from "../../data/transformQualityPreview";
import { SourceAssetTree } from "./SourceAssetTree";
import { SourceExplorerWorkbench } from "./SourceExplorerWorkbench";
import { SourcePreviewDataTable } from "./SourcePreviewDataTable";
import { SourceRawSamplePreview } from "./SourceRawSamplePreview";
import { SchemaTransformWorkbench } from "./SchemaTransformWorkbench";
import { SchemaRuleSummary } from "./SchemaRuleSummary";
import { SchemaResultPreview } from "./SchemaResultPreview";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { getSourceBrandMeta, SourceBrandIcon } from "../../components/source/SourceBrand";
import {
  extractKafkaClickLogPreviewLines,
  extractRawTextPreviewLines,
  shouldShowKafkaClickLogPreview,
  shouldShowRawTextPreview,
} from "../../utils/sourcePreview";

const OBJECT_STORAGE_IS_AWS = String(import.meta.env.VITE_OBJECT_STORAGE_PROVIDER ?? "minio").trim().toLowerCase() === "aws";
const OBJECT_STORAGE_PROVIDER_LABEL = OBJECT_STORAGE_IS_AWS ? "Amazon S3" : "MinIO";
const OBJECT_STORAGE_REGION = String(import.meta.env.VITE_S3_REGION ?? (OBJECT_STORAGE_IS_AWS ? "ap-northeast-2" : "us-east-1"));
const SPARK_OUTPUT_BUCKET = String(import.meta.env.VITE_SPARK_OUTPUT_BUCKET ?? "asklake-output")
  .trim()
  .replace(/^s3a?:\/\//i, "")
  .replace(/\/+.*$/, "") || "asklake-output";

type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};
type ScheduleOptionId = "skip" | "repeat";

const FALLBACK_KAFKA_BROKER = import.meta.env.DEV ? "127.0.0.1:19092" : "";

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
  const [scheduleError, setScheduleError] = useState("");
  const title = "스케줄링 설정";
  const repeatDraft = { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime };
  const selectedOption = getScheduleOptionFromLabel(draftScheduleLabel, mode);
  const scheduleTimezone = normalizeScheduleTimezone(draftSchedule.timezone);
  const scheduleStartDate = normalizeDateValue(draftSchedule.startDate, SCHEDULE_START_DATE);
  const scheduleEndDate = normalizeOptionalDateValue(draftSchedule.endDate);
  const invalidRepeatCron = selectedOption === "repeat" && repeatFrequency === "custom" && !isValidCronExpression(customCron);
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
    setScheduleError("");
    onDraftChange(buildSchedulePatch(nextOption, repeatDraft, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
    onModeChange(scheduleFlowFromOption(nextOption));
  };
  const goNext = () => {
    if (invalidRepeatCron) {
      setScheduleError("Cron 표현식을 5개 필드 형식으로 입력해 주세요. 예: 0 10 * * 1-5");
      return;
    }
    setScheduleError("");
    applyScheduleDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={invalidRepeatCron} split onPrev={onPrev} onNext={goNext} />}
    >
        <EtlStepHeader
          className="etl-step-standalone-header"
          icon={<Calendar />}
          title={title}
        />
        <Card className="overflow-hidden" size="none">
          <CardHeader className="border-b border-slate-200 p-5">
            <CardTitle>실행 방식</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6 p-5">
            <div aria-label="실행 방식" className="grid gap-4 md:grid-cols-2" role="group">
              <ScheduleModeCard
                icon={<PlayCircle size={24} />}
                selected={selectedOption === "skip"}
                title="직접 실행"
                onClick={() => selectOption("skip")}
              />
              <ScheduleModeCard
                icon={<Repeat2 size={24} />}
                selected={selectedOption === "repeat"}
                title="반복 실행"
                onClick={() => selectOption("repeat")}
              />
            </div>
            <Separator />
            {scheduleError && <Alert variant="destructive"><Info /><AlertTitle>스케줄을 확인해 주세요.</AlertTitle><AlertDescription>{scheduleError}</AlertDescription></Alert>}
            {selectedOption === "repeat" && <RepeatSettings customCron={customCron} frequency={repeatFrequency} minute={repeatMinute} overlapPolicy={draftSchedule.overlapPolicy ?? DEFAULT_OVERLAP_POLICY} selectedDay={repeatDay} time={repeatTime} timezone={scheduleTimezone} onCronChange={(cron) => {
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
            }} onOverlapPolicyChange={(overlapPolicy) => onDraftChange({ overlapPolicy, schedule: { overlapPolicy } })} onTimezoneChange={(timezone) => onDraftChange(buildSchedulePatch("repeat", repeatDraft, timezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }))} />}
            <ScheduleRetrySettings retryPolicy={draftRetryPolicy} onRetryPolicyChange={updateRetryPolicy} />
          </CardContent>
        </Card>
    </CreationFlowLayout>
  );
}

function ScheduleModeCard({
  icon,
  selected,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  selected: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "relative flex min-h-28 items-center gap-4 rounded-xl border bg-white p-5 text-left transition-colors",
        "hover:border-blue-300 hover:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        selected && "border-blue-500 bg-blue-50/70 shadow-[inset_3px_0_0_#2563eb]",
      )}
      type="button"
      onClick={onClick}
    >
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600", selected && "bg-blue-100 text-blue-600")}>
        {icon}
      </span>
      <strong className="text-base font-semibold text-slate-950">{title}</strong>
      <span className={cn("absolute right-5 top-5 flex size-5 items-center justify-center rounded-full border border-slate-300 text-transparent", selected && "border-blue-600 bg-blue-600 text-white")}>
        <Check aria-hidden="true" size={13} strokeWidth={3} />
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

function patchConnectorAnalysisSourceConfig(
  result: SourceConnectorAnalysis,
  fallbackFields: Array<[string, string]>,
  patches: Array<[string, string]>,
): SourceConnectorAnalysis {
  if (!result.draftPatch.source) return result;
  return {
    ...result,
    draftPatch: {
      ...result.draftPatch,
      source: {
        ...result.draftPatch.source,
        sourceConfig: upsertSourceFields(result.draftPatch.source.sourceConfig ?? fallbackFields, patches),
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
  Collections: "탐색 가능한 컬렉션",
  "Connection URI": "연결 URI",
  "DATASET OR TABLE SELECTOR": "데이터셋 또는 테이블 선택자",
  "DATABASE / SCHEMA": "데이터베이스 / 스키마",
  "Database Name": "데이터베이스 이름",
  Database: "데이터베이스",
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
  "Target discovery": "대상 탐색",
  Table: "테이블",
  Tables: "탐색 가능한 테이블",
  "Token / Secret": "토큰 / 시크릿",
  Topic: "토픽",
  "Topic Access": "토픽 접근",
  "TOPIC / QUEUE NAME": "토픽 / 큐 이름",
  Username: "사용자 이름",
  "Use Path Style": "Path Style 사용",
  "X-Request-ID": "요청 ID",
  Auth: "인증",
  "Backend connector": "데이터 읽기 권한",
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
  "After connection": "연결 후 확인",
  detected: "감지됨",
  failed: "실패",
  listed: "목록 확인",
  "metadata reachable": "메타데이터 접근 가능",
  "Not listed": "목록 미확인",
  "Not tested": "미테스트",
  Pending: "대기",
  Reachable: "접근 가능",
  "read-only": "읽기 전용",
  Required: "확인 필요",
  "Read-only": "읽기 전용",
  sampled: "샘플링됨",
  skipped: "생략",
  Skipped: "생략",
  verified: "검증됨",
  Verified: "검증됨",
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

function normalizeScheduleTimezone(timezone?: string) {
  if (!timezone) return SCHEDULE_TIMEZONE;
  if (timezone.includes("Seoul") || timezone.includes("Tokyo") || timezone.includes("GMT+09:00")) return SCHEDULE_TIMEZONE;
  return timezoneOptions.some((option) => option.value === timezone) ? timezone : SCHEDULE_TIMEZONE;
}
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
  if (label.includes("1회") || label.includes("예약")) return "manual";
  return "repeat";
}

function getScheduleOptionFromLabel(label: string, fallbackFlow: ScheduleFlowId): ScheduleOptionId {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "skip";
  if (label.includes("1회") || label.includes("예약")) return "skip";
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
  const nextRun = option === "skip" ? "-" : "저장 시점 기준 계산";
  const startDate = option === "repeat" ? normalizeDateValue(dates?.startDate ?? currentSchedule?.startDate, SCHEDULE_START_DATE) : "";
  const normalizedEndDate = option === "repeat" ? normalizeOptionalDateValue(dates?.endDate ?? currentSchedule?.endDate) : "";
  const endDate = normalizedEndDate && normalizedEndDate >= startDate ? normalizedEndDate : "";
  const scheduleTimezone = option === "skip" ? "" : timezone;
  const summary = formatScheduleSummary(option, label, scheduleTimezone);
  const nextRunUtc = option === "skip" ? "" : "";
  const restoreRepeatDefaults = option !== "skip" && (currentSchedule?.mode === "manual" || currentSchedule?.label.includes("건너뛰기"));
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
const DEFAULT_OWNER = "data-team-01";
const DEFAULT_TARGET_DATASET = "customer_review_gold";
const DEFAULT_TARGET_LAYER: TargetLayer = "GOLD";
const DEFAULT_TARGET_FORMAT: TargetFileFormat = "parquet";
const DEFAULT_TARGET_TAGS: string[] = [];
const LEGACY_TARGET_TAG_OPTIONS = ["마케팅용", "고객데이터", "고객 데이터", "분석용", "서비스용", "서비스 제공용", "원본", "원본 데이터", "가공됨", "가공 데이터", "운영 데이터", "개인정보 포함"];

const VISIBILITY_OPTIONS = ["조직 내부", "프로젝트 멤버", "외부 공유"] as const;
const TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER", "GOLD"];
const KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER"];
const TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["parquet", "csv", "json", "jsonl"];
const KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["jsonl"];
const KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["parquet"];

const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  delete: "삭제",
  manage: "관리",
  query: "쿼리 실행",
  run: "실행",
  share: "공유",
  view: "조회",
};

type PermissionGrantTab = "roles" | "users";

type PermissionDraftSlice = {
  grants?: DraftPipeline["permission"]["grants"];
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

function buildTargetStoragePathForBucket(bucket: string, targetDataset: string, targetLayer: TargetLayer) {
  return `s3a://${bucket}/${targetDataset}/${targetLayer.toLowerCase()}/`;
}

function buildTargetStoragePath(targetDataset: string, targetLayer: TargetLayer) {
  return buildTargetStoragePathForBucket(SPARK_OUTPUT_BUCKET, targetDataset, targetLayer);
}

function isManagedTargetStoragePath(value: string, targetDataset: string, targetLayer: TargetLayer) {
  return value === buildTargetStoragePath(targetDataset, targetLayer)
    || value === buildTargetStoragePathForBucket("asklake-output", targetDataset, targetLayer);
}

function normalizeKafkaDatasetName(topic: string) {
  const normalized = topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "kafka_events";
}

function isDefaultTargetDataset(value: string | undefined) {
  return !value?.trim() || value.trim() === DEFAULT_TARGET_DATASET;
}

function isDefaultTargetStoragePath(value: string | undefined) {
  return !value?.trim() || value.trim() === buildTargetStoragePath(DEFAULT_TARGET_DATASET, DEFAULT_TARGET_LAYER);
}

function isLegacyKafkaLandingPath(value: string | undefined) {
  return Boolean(value?.includes("kafka-landing/"));
}

function isDefaultTargetDescription(value: string | undefined) {
  return !value?.trim() || value.trim() === "고객 리뷰 분석용 정제 데이터셋";
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

function buildPermissionSummary(permissionTemplate: string, visibility: string) {
  return `${permissionTemplate} · ${visibility}`;
}

function parsePermissionSummary(summary: string | undefined) {
  const [template, visibility] = (summary ?? "").split(/[·/]/).map((part) => part.trim()).filter(Boolean);

  return {
    permissionTemplate: template || DEFAULT_PERMISSION_TEMPLATE,
    visibility: getKnownOption(visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY),
  };
}

function getPermissionDraftValues(draft: DraftPipeline) {
  const compatDraft = draft as DraftPipelineWithSlices;
  const permission = compatDraft.permission;
  const parsed = parsePermissionSummary(permission?.permissionSummary ?? permission?.summary ?? compatDraft.permissionSummary);
  const permissionTemplate = getDisplayText(permission?.permissionTemplate ?? permission?.template ?? parsed.permissionTemplate, DEFAULT_PERMISSION_TEMPLATE);
  const visibility = getKnownOption(permission?.visibility ?? parsed.visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);

  return {
    owner: getDisplayText(permission?.owner ?? compatDraft.owner, DEFAULT_OWNER),
    permissionSummary: buildPermissionSummary(permissionTemplate, visibility),
    permissionTemplate,
    visibility,
  };
}

function getTargetDraftValues(draft: DraftPipeline) {
  const compatDraft = draft as DraftPipelineWithSlices;
  const target = compatDraft.target;
  const isKafkaSource = draft.source.sourceType === "Stream / Kafka" || draft.source.sourceType === "Kafka JSON";
  const isContinuousKafka = isKafkaSource && draft.source.executionMode === "continuous";
  const kafkaTopic = sourceConfigValue(draft.source.sourceConfig, "TOPIC / QUEUE NAME") || sourceConfigValue(draft.source.sourceConfig, "Topic") || "reviews.raw";
  const kafkaDatasetName = normalizeKafkaDatasetName(kafkaTopic);
  const rawTargetDataset = target?.targetDataset ?? target?.datasetName ?? compatDraft.targetDataset;
  const targetDataset = isKafkaSource && isDefaultTargetDataset(rawTargetDataset)
    ? kafkaDatasetName
    : getDisplayText(rawTargetDataset, isKafkaSource ? kafkaDatasetName : DEFAULT_TARGET_DATASET);
  const rawTargetFormat = target?.targetFormat ?? target?.format ?? compatDraft.targetFormat;
  const targetFormat = isContinuousKafka
    ? "parquet"
    : isKafkaSource && (!rawTargetFormat || rawTargetFormat === DEFAULT_TARGET_FORMAT)
      ? "jsonl"
      : getKnownOption(rawTargetFormat, TARGET_FORMAT_OPTIONS, isKafkaSource ? "jsonl" : DEFAULT_TARGET_FORMAT);
  const rawTargetLayer = target?.targetLayer ?? target?.layer ?? compatDraft.targetLayer ?? draft.target.layer;
  const normalizedTargetLayer = normalizeTargetLayer(rawTargetLayer);
  const targetLayer = isKafkaSource && !isContinuousKafka
    ? getKnownOption(
        !rawTargetLayer || rawTargetLayer === DEFAULT_TARGET_LAYER ? "BRONZE" : normalizedTargetLayer,
        KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS,
        "BRONZE",
      )
    : normalizedTargetLayer;
  const storedPath = target?.storagePath ?? draft.target.storagePath;
  const defaultTargetPath = buildTargetStoragePath(targetDataset, targetLayer);
  const storagePath = isKafkaSource && (isDefaultTargetStoragePath(storedPath) || isLegacyKafkaLandingPath(storedPath))
    ? defaultTargetPath
    : getDisplayText(storedPath, defaultTargetPath);

  return {
    description: isKafkaSource && isDefaultTargetDescription(target?.description ?? draft.target.description)
      ? isContinuousKafka ? "Kafka continuous micro-batch target 데이터셋" : "Kafka snapshot direct target 데이터셋"
      : getDisplayText(target?.description ?? draft.target.description, "고객 리뷰 분석용 정제 데이터셋"),
    jobName: getDisplayText(target?.jobName ?? compatDraft.jobName, buildJobName(targetDataset)),
    owner: getDisplayText(target?.owner ?? compatDraft.owner ?? draft.permission.owner, DEFAULT_OWNER),
    partitionColumns: target?.partitionColumns ?? draft.target.partitionColumns ?? ["date", "category"],
    rag: typeof target?.rag === "boolean" ? target.rag : compatDraft.rag ?? draft.target.rag,
    storagePath,
    tableName: getDisplayText(target?.tableName ?? draft.target.tableName, targetDataset),
    tags: filterVisibleTargetTags(target?.tags ?? draft.target.tags ?? DEFAULT_TARGET_TAGS),
    targetDataset,
    targetFormat,
    targetLayer,
    testStatus: target?.testStatus ?? draft.target.testStatus ?? "idle",
  };
}

function getInitialSourceStage(draft: DraftPipeline): "choose" | "connect" | "browse" {
  if (!draft.source.sourceType) return "choose";
  if (draft.source.sourceType === "Data Lake") return "browse";
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
  const kafkaExecutionMode = draft.source.executionMode ?? "snapshot";
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const initialSqlResultReady = draft.source.sourceType === "SQL Result" && hasSqlResultPreviewConfig(draft.source.sourceConfig);
  const [connectionStatus, setConnectionStatus] = useState<SourceDraft["connectionStatus"]>(initialSqlResultReady ? "success" : "idle");
  const [connectionMessage, setConnectionMessage] = useState(
    initialSqlResultReady ? "SQL Preview 결과가 검증되었습니다." : "현재 설정으로 연결 테스트가 필요합니다.",
  );
  const [sourceRuntime, setSourceRuntime] = useState<SourceConnectorAnalysis | null>(null);
  const [sourceStage, setSourceStage] = useState<"choose" | "connect" | "browse">(() => getInitialSourceStage(draft));
  const [loadingAssetPath, setLoadingAssetPath] = useState("");
  const [selectedAssetPath, setSelectedAssetPath] = useState("");
  const [assetPathQuery, setAssetPathQuery] = useState("");
  const [assetSearchQuery, setAssetSearchQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState("all");
  const [catalogDatasets, setCatalogDatasets] = useState<CatalogDataset[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedCatalogDatasetId, setSelectedCatalogDatasetId] = useState(
    draft.source.sourceType === "Data Lake" ? sourceConfigValue(draft.source.sourceConfig, "Source Dataset ID") : "",
  );
  const [continuousAdvancedOpen, setContinuousAdvancedOpen] = useState(false);
  const [defaultKafkaBroker, setDefaultKafkaBroker] = useState(FALLBACK_KAFKA_BROKER);
  const sourceLocked = connectionStatus === "testing";

  useEffect(() => {
    if (!sourceType || sourceType === "SQL Result") return;
    setConnectionStatus("idle");
    setConnectionMessage("현재 설정으로 연결 테스트가 필요합니다.");
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setAssetPathQuery("");
    setAssetSearchQuery("");
    setAssetFilter("all");
  }, [sourceType]);

  const continuousConfig = draft.source.continuousConfig ?? {
    initialOffsetPolicy: "earliest" as const,
    triggerIntervalSeconds: 30,
    maxOffsetsPerTrigger: 10000,
  };
  const updateContinuousConfig = (patch: Partial<typeof continuousConfig>) => {
    onDraftChange({
      source: {
        executionMode: "continuous",
        continuousConfig: { ...continuousConfig, ...patch },
      },
      target: { format: "parquet" },
    });
  };
  useEffect(() => {
    let active = true;
    getSourceConnectorDefaults()
      .then((defaults) => {
        if (active && defaults.kafkaBroker.trim()) setDefaultKafkaBroker(defaults.kafkaBroker.trim());
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const connectorMeta: Record<string, { description: string; icon: React.ReactNode; label: string; status: string }> = {
    "File / S3": { description: "S3 버킷의 CSV, JSON, Parquet 파일을 가져옵니다.", icon: <SourceBrandIcon kind="s3" />, label: getSourceBrandMeta("File / S3").label, status: "실제 연결" },
    PostgreSQL: { description: "PostgreSQL 테이블에서 데이터를 가져옵니다.", icon: <SourceBrandIcon kind="postgres" />, label: getSourceBrandMeta("PostgreSQL").label, status: "실제 연결" },
    MongoDB: { description: "MongoDB 컬렉션에서 문서를 가져옵니다.", icon: <SourceBrandIcon kind="mongo" />, label: getSourceBrandMeta("MongoDB").label, status: "실제 연결" },
    "REST API": { description: "API를 호출해 응답 데이터를 가져옵니다.", icon: <SourceBrandIcon kind="rest" />, label: getSourceBrandMeta("REST API").label, status: "실제 연결" },
    "Data Lake": { description: "AskLake에 저장된 데이터셋을 다시 사용합니다.", icon: <SourceBrandIcon kind="lake" />, label: getSourceBrandMeta("Data Lake").label, status: "목록 조회" },
    "SQL Result": { description: "검증된 SQL 분석 결과를 다시 사용합니다.", icon: <SourceBrandIcon kind="sql" />, label: getSourceBrandMeta("SQL Result").label, status: "검증 완료" },
    "Stream / Kafka": { description: "Kafka에서 들어오는 데이터를 실시간 또는 구간별로 가져옵니다.", icon: <SourceBrandIcon kind="kafka" />, label: getSourceBrandMeta("Stream / Kafka").label, status: "메타데이터" },
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
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Endpoint", "Not tested"], ["Database", "Pending"], ["Target discovery", "After connection"]],
      logs: ["PostgreSQL 소스 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 원시 데이터베이스 소켓을 열지 않습니다."],
      assetsTitle: "PostgreSQL 테이블 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "테이블을 선택하면 일부 행을 가져와 표시합니다.",
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
        ["DATASET OR TABLE SELECTOR", ""],
      ],
      testItems: [["Endpoint", "Not tested"], ["Database", "Pending"], ["Target discovery", "After connection"]],
      logs: ["MongoDB 소스 식별이 아직 검증되지 않았습니다.", "연결 테스트를 실행하면 제한 문서 샘플을 가져옵니다."],
      assetsTitle: "MongoDB 컬렉션 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "컬렉션을 선택하면 일부 문서를 표 형태로 표시합니다.",
      previewColumns: ["Collection", "Documents", "Status"],
      previewRows: [],
      info: "",
    },
    "File / S3": {
      title: "Amazon S3 연결 설정",
      description: OBJECT_STORAGE_IS_AWS
        ? "배포 서버의 IAM Role로 AWS S3 버킷과 제한 샘플을 조회합니다."
        : "MinIO 오브젝트 스토리지에서 버킷과 제한 샘플을 실제 조회합니다.",
      fields: [
        ["Storage Provider", OBJECT_STORAGE_PROVIDER_LABEL],
        ["Endpoint URL", ""],
        ["Region", OBJECT_STORAGE_REGION],
        ["Bucket / Stage Name", ""],
        ["Path / Prefix", ""],
        ["Access Key", ""],
        ["Secret Key", ""],
        ["Use Path Style", String(!OBJECT_STORAGE_IS_AWS)],
        ["File Type", "auto"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      testItems: [["Endpoint", "Not tested"], ["Bucket", "Not listed"], ["샘플 프로파일", "Pending"]],
      logs: [`${OBJECT_STORAGE_PROVIDER_LABEL} 소스 식별이 아직 검증되지 않았습니다.`, "연결 테스트를 실행하면 제한 샘플을 가져옵니다."],
      assetsTitle: "Amazon S3 파일 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "파일을 선택하면 일부 데이터를 가져와 표시합니다.",
      previewColumns: ["Object Key", "Size", "Last Modified"],
      previewRows: [],
    },
    "Data Lake": {
      title: "AskLake 데이터 레이크",
      description: "현재 로그인 계정으로 접근할 수 있는 AskLake 데이터셋을 선택합니다.",
      fields: [
        ["Source Dataset", ""],
        ["Source Dataset ID", ""],
      ],
      testItems: [],
      logs: ["AskLake 로그인 세션과 Catalog 권한을 기준으로 데이터셋 목록을 조회합니다."],
      assetsTitle: "AskLake 데이터셋 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "왼쪽 목록에서 사용할 데이터셋을 선택하세요.",
      previewColumns: [],
      previewRows: [],
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
      assetsTitle: "REST API 응답 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "연결을 확인하면 응답의 일부 데이터를 표시합니다.",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [],
    },
    "Stream / Kafka": {
      title: "스트림 소스 설정",
      description: "실시간 데이터 스트림 엔드포인트를 설정합니다.",
      fields: [
        ["Stream Type", "Apache Kafka"],
        ["Broker / Endpoint", defaultKafkaBroker],
        ["TOPIC / QUEUE NAME", "asklake-source-events"],
        ["CONSUMER GROUP ID", "asklake-etl-consumer-01"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "SASL / SCRAM"],
      ],
      testItems: [["Broker Reachable", "Not tested"], ["Topic Access", "Pending"], ["Backend connector", "Required"]],
      logs: ["Kafka 소스 윈도우 식별은 백엔드 커넥터 러너에서 검증합니다.", "브라우저는 Kafka 프로토콜 핸드셰이크를 수행할 수 없습니다."],
      assetsTitle: "Kafka 토픽 메시지 탐색",
      assets: [],
      previewTitle: "데이터 미리보기",
      previewNote: "연결을 확인하면 일부 메시지를 가져와 표시합니다.",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [],
    },
  };
  const selectedSourceType = sourceType === "Database" ? "PostgreSQL" : sourceType;
  const activeSourceType = sourceConfigs[selectedSourceType] ? selectedSourceType : "";
  const hasSelectedSource = activeSourceType.length > 0;
  const current = hasSelectedSource ? sourceConfigs[activeSourceType] : sourceConfigs["File / S3"];
  const activeSourceMeta = connectorMeta[activeSourceType] ?? connectorMeta["File / S3"];
  const isInternalDataLake = activeSourceType === "Data Lake";
  const editableFields = sourceFields[activeSourceType] ?? (
    draft.source.sourceType === activeSourceType && draft.source.sourceConfig.length > 0
      ? mergeFieldRows(current.fields, draft.source.sourceConfig)
      : current.fields
  );
  const isSqlResultSource = activeSourceType === "SQL Result";
  const hasSqlResultPreview = isSqlResultSource && hasSqlResultPreviewConfig(editableFields);

  useEffect(() => {
    if (!isInternalDataLake || sourceStage !== "browse") return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError("");
    void getDatasets()
      .then((datasets) => {
        if (cancelled) return;
        setCatalogDatasets(datasets.filter((dataset) => dataset.permissions?.canView !== false));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogDatasets([]);
        setCatalogError(error instanceof Error ? error.message : "데이터셋 목록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isInternalDataLake, sourceStage]);

  const usableCatalogDatasets = catalogDatasets.filter((dataset) => dataset.status === "available");
  const filteredCatalogDatasets = usableCatalogDatasets.filter((dataset) => {
    const query = assetSearchQuery.trim().toLowerCase();
    const matchesQuery = !query || [dataset.name, dataset.description, dataset.owner, ...dataset.tags]
      .some((value) => value.toLowerCase().includes(query));
    const matchesLayer = assetFilter === "all" || dataset.layer === assetFilter;
    return matchesQuery && matchesLayer;
  });
  const selectedCatalogDataset = usableCatalogDatasets.find((dataset) => dataset.id === selectedCatalogDatasetId) ?? null;
  const sourceLabel = hasSelectedSource
    ? editableFields.find(([label]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? activeSourceType
    : "미선택";
  const connectionStatusCopy: Record<SourceDraft["connectionStatus"], { badge: string; title: string }> = {
    failed: { badge: "확인 실패", title: "연결 실패" },
    idle: { badge: "테스트 필요", title: "연결 검증 필요" },
    success: { badge: "탐색 가능", title: "연결 검증 완료" },
    testing: { badge: "테스트 중", title: "연결 테스트 실행 중" },
  };
  const visibleEditableFields = editableFields.filter(([label]) => isVisibleSourceField(activeSourceType, label));
  const missingConnectionFields = requiredSourceConnectionFields(activeSourceType).filter((label) => !sourceConfigValue(editableFields, label).trim());
  const displayTestItems = (sourceRuntime?.testItems ?? current.testItems).filter(([label]) => !isInternalSourceField(label));
  const displayAssets = sourceRuntime?.assets ?? current.assets;
  const explorerConfig = sourceExplorerConfig(activeSourceType, displayAssets);
  const filteredDisplayAssets = displayAssets.filter((asset) => sourceAssetMatchesExplorer(asset, assetSearchQuery, assetFilter, explorerConfig.filterMode));
  const hasDetectedAssets = displayAssets.length > 0;
  const selectedAsset = selectedAssetPath ? displayAssets.find(([path]) => path === selectedAssetPath) ?? null : null;
  const selectedDatasetSummary = sourceRuntime?.datasetSummary;
  const isPrefixSelection = sourceConfigValue(editableFields, "__Selection Kind").toLowerCase() === "prefix"
    || selectedDatasetSummary?.selectionKind === "prefix";
  const requiresAssetSelectionForPreview = ["File / S3", "MongoDB", "PostgreSQL"].includes(activeSourceType);
  const selectedAssetHasSample = Boolean(
    (!requiresAssetSelectionForPreview || selectedAssetPath) && sourceRuntime?.previewColumns?.length,
  );
  const displayPreviewColumns = selectedAssetHasSample ? sourceRuntime?.previewColumns ?? [] : [];
  const displayPreviewRows = selectedAssetHasSample ? sourceRuntime?.previewRows ?? [] : [];
  const s3RawTextPreviewLines = extractRawTextPreviewLines(displayPreviewColumns, displayPreviewRows);
  const kafkaClickLogPreviewLines = extractKafkaClickLogPreviewLines(displayPreviewColumns, displayPreviewRows);
  const previewShowsS3RawText = shouldShowRawTextPreview({
    detectedFormat: sourceRuntime?.draftPatch.source?.detectedFormat,
    requiresRecordParsing: sourceRuntime?.draftPatch.source?.requiresRecordParsing,
    rawLines: s3RawTextPreviewLines,
    sourceType: activeSourceType,
  });
  const previewShowsKafkaClickLog = shouldShowKafkaClickLogPreview({
    rawLines: kafkaClickLogPreviewLines,
    sourceType: activeSourceType,
  });
  const previewShowsRawText = previewShowsS3RawText || previewShowsKafkaClickLog;
  const rawTextPreviewLines = previewShowsKafkaClickLog ? kafkaClickLogPreviewLines : s3RawTextPreviewLines;
  const hasSamplePreview = displayPreviewColumns.length > 0 && displayPreviewRows.length > 0;
  const runtimeSchemaColumnCount = sourceRuntime?.draftPatch.schema?.columns?.length ?? 0;
  const hasSchemaPatch = Boolean(runtimeSchemaColumnCount && sourceRuntime?.draftPatch.schema?.sampleRows?.length);
  const hasValidatedSchema = isPrefixSelection
    ? Boolean(selectedDatasetSummary?.schemaCompatible && selectedDatasetSummary.fileCount > 0 && runtimeSchemaColumnCount > 0)
    : hasSchemaPatch || draft.schema.columns.length > 0;
  const displayPreviewNote = sourceRuntime?.previewNote ?? current.previewNote;
  const publicConnectionMessage = publicSourceLog(connectionMessage);
  const publicDisplayPreviewNote = publicSourceLog(displayPreviewNote);
  const runtimeSourceConfig = sourceRuntime?.draftPatch.source?.sourceConfig;
  const verifiedSourceFields = connectionStatus === "success" && runtimeSourceConfig ? runtimeSourceConfig : editableFields;
  const displayPreviewFormat = selectedDatasetSummary?.format
    || (activeSourceType === "File / S3" ? sourceFormatFromConfig(verifiedSourceFields) : sourceTypeLabel(activeSourceType));
  const previewShowsFileList = activeSourceType === "File / S3"
    && displayPreviewColumns.includes("Object Key");
  const previewShowsTopicInfo = activeSourceType === "Stream / Kafka"
    && displayPreviewColumns.includes("Leader");
  const sourcePreviewTitle = previewShowsFileList
    ? "파일 목록"
    : previewShowsTopicInfo
      ? "토픽 정보"
      : "데이터 미리보기";
  const sourceSummaryRows: Array<[string, string]> = [
    ["선택 커넥터", hasSelectedSource ? sourceTypeLabel(activeSourceType) : "미선택"],
    ["연결 상태", isSqlResultSource ? (hasSqlResultPreview && connectionStatus === "success" ? "SQL Preview 검증됨" : "SQL Preview 필요") : connectionStatus === "success" ? publicConnectionMessage : connectionStatus === "testing" ? "테스트 중" : connectionStatus === "failed" ? "실패" : "테스트 필요"],
    ["감지 파일", isSqlResultSource ? `${sourceConfigValue(editableFields, "Preview Row Count") || "0"} rows` : `${displayAssets.length}개`],
    ["인증 방식", isSqlResultSource ? "SQL Preview 검증" : isInternalDataLake ? "AskLake 로그인 권한" : activeSourceType === "File / S3" ? (OBJECT_STORAGE_IS_AWS ? "EC2 IAM Role" : "MinIO 액세스 키") : "백엔드 커넥터"],
    ["다음 단계", isSqlResultSource ? "Review 확인" : (sourceRuntime?.draftPatch.source?.requiresRecordParsing ? "레코드 구조화" : "스키마 추론")],
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
    const executionMode = nextType === "Stream / Kafka" ? draft.source.executionMode ?? "snapshot" : "snapshot";
    onDraftChange({
      source: {
        connectionMessage: nextMessage,
        connectionStatus: nextStatus,
        sourceConfig: nextFields,
        sourceLabel: label,
        sourceType: nextType,
        executionMode,
        continuousConfig: executionMode === "continuous" ? draft.source.continuousConfig : undefined,
      },
    });
  };

  const selectSource = (value: string) => {
    const nextFields = value === activeSourceType ? editableFields : sourceFields[value] ?? sourceConfigs[value].fields;
    const nextIsSqlResult = value === "SQL Result";
    const nextIsInternalDataLake = value === "Data Lake";
    const nextHasSqlResultPreview = nextIsSqlResult && hasSqlResultPreviewConfig(nextFields);
    const nextStatus: SourceDraft["connectionStatus"] = nextIsInternalDataLake
      ? "success"
      : nextIsSqlResult
        ? (nextHasSqlResultPreview ? "success" : "idle")
        : "idle";
    const nextMessage = nextIsSqlResult
      ? nextHasSqlResultPreview
        ? "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다."
        : "SQL Result는 SQL 분석 Preview에서 처리 Job 생성으로 진입할 때 사용합니다."
      : nextIsInternalDataLake
        ? "현재 사용자의 Catalog 접근 권한으로 데이터셋을 탐색합니다."
      : `${sourceTypeLabel(value)} 설정을 선택했습니다. 검토 전에 연결 테스트를 실행하세요.`;
    setSourceType(value);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    if (!nextIsInternalDataLake) setSelectedCatalogDatasetId("");
    setConnectionStatus(nextStatus);
    setConnectionMessage(nextMessage);
    applySourceDraft(value, nextFields, nextStatus, nextMessage);
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const selectCatalogDataset = (dataset: CatalogDataset) => {
    const nextFields: Array<[string, string]> = [
      ["Source Dataset", dataset.name],
      ["Source Dataset ID", dataset.id],
    ];
    const schemaColumns: SchemaColumnDraft[] = dataset.schema.map(([name, type]) => ({
      nullable: true,
      sourceName: name,
      targetName: name,
      type,
    }));
    const message = `${dataset.name} 데이터셋을 소스로 선택했습니다.`;
    const schemaSummary = `${dataset.name} · ${schemaColumns.length}개 필드 · Catalog 권한 확인`;
    const draftPatch: DraftPipelinePatch = {
      schema: {
        columns: schemaColumns,
        sampleRows: dataset.sampleRows,
        summary: schemaSummary,
      },
      source: {
        connectionMessage: message,
        connectionStatus: "success",
        executionMode: "snapshot",
        sourceConfig: nextFields,
        sourceLabel: dataset.name,
        sourceType: "Data Lake",
      },
    };
    setSelectedCatalogDatasetId(dataset.id);
    setSourceFields((fields) => ({ ...fields, "Data Lake": nextFields }));
    setConnectionStatus("success");
    setConnectionMessage(message);
    setSourceRuntime({
      actionPath: `/api/catalog/datasets/${encodeURIComponent(dataset.id)}`,
      assets: [],
      draftPatch,
      logs: [message],
      message,
      previewColumns: dataset.schema.map(([name]) => name),
      previewNote: `${dataset.name}의 Catalog 샘플 행입니다.`,
      previewRows: dataset.sampleRows,
      status: "success",
      testItems: [],
    });
    onDraftChange(draftPatch);
    onAction("etl.source.catalog_dataset_selected", `/api/catalog/datasets/${encodeURIComponent(dataset.id)}`, dataset.id);
    onNotify(message);
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
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
  };

  const updateCollectionConfig = (patches: Array<[string, string]>) => {
    const nextFields = upsertSourceFields(editableFields, [...patches, ["__Sample Object", ""]]);
    const nextMessage = "파일 수집 범위가 변경되었습니다. 대표 파일을 다시 샘플링하세요.";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime((runtime) => runtime ? {
      ...runtime,
      draftPatch: {},
      logs: [nextMessage],
      message: nextMessage,
      previewColumns: [],
      previewNote: "수집 범위를 다시 검증한 뒤 미리보기를 확인할 수 있습니다.",
      previewRows: [],
      status: "idle",
    } : null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    setSourceStage("connect");
    applySourceDraft(activeSourceType, nextFields, "idle", nextMessage);
    onDraftChange({
      quality: {
        invalidRows: [],
        rules: [],
        score: undefined,
        status: "idle",
        summary: "스키마 재추론 후 품질 규칙 설정 필요",
      },
      recordParsing: {
        columns: [],
        delimiterKind: "whitespace",
        delimiterPattern: "\\s+",
        enabled: false,
        expectedFieldCount: 0,
        header: false,
      },
      schema: {
        columns: [],
        sampleRows: [],
        schemaFingerprint: undefined,
        summary: "수집 범위 변경 · 스키마 재추론 필요",
      },
      source: {
        detectedFormat: undefined,
        rawPreviewLines: [],
        requiresRecordParsing: false,
      },
      transform: {
        outputColumns: [],
        steps: [],
        summary: "스키마 재추론 후 변환 설정 필요",
      },
    });
  };

  const loadSourceAssetChildren = async (folderPath: string) => {
    if (!hasSelectedSource || activeSourceType !== "File / S3") return;
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

  const navigateSourceAssetPath = async () => {
    const requestedPath = assetPathQuery.trim();
    if (!requestedPath) {
      onNotify("이동할 경로 또는 프리픽스를 입력하세요.");
      return;
    }
    await loadSourceAssetChildren(requestedPath);
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
      ["__Selection Kind", "file"],
      ["__Selected Object", assetPath],
      ["__Sample Object", assetPath],
    ]);
    const selectedTargetKind = activeSourceType === "PostgreSQL"
      ? "테이블"
      : activeSourceType === "MongoDB"
        ? "컬렉션"
        : assetMeta === "folder"
          ? "폴더"
          : "파일";
    const nextMessage = `${selectedTargetKind} ${assetPath} 선택됨`;
    setSelectedAssetPath(assetPath);
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setConnectionMessage(nextMessage);
    setConnectionStatus("testing");
    applySourceDraft(activeSourceType, nextFields, "testing", nextMessage);
    onDraftChange({ recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false } });
    onAction("etl.source.asset_selected", "/api/etl/sources/assets", assetPath);
    try {
      const result = patchConnectorAnalysisSourceConfig(
        mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, nextFields)),
          nextFields,
        ),
        nextFields,
        [
          ["__Selection Kind", "file"],
          ["__Selected Object", assetPath],
          ["__Sample Object", assetPath],
        ],
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

  const selectSourceFolder = async (folderPath: string) => {
    if (activeSourceType !== "File / S3") return;
    const folderPrefix = normalizeFolderPrefix(folderPath);
    if (!folderPrefix) {
      onNotify("버킷 루트가 아닌 데이터셋 폴더를 선택하세요.");
      return;
    }

    const currentAssets = displayAssets;
    const nextFields = upsertSourceFields(editableFields.map(([fieldLabel, fieldValue]) => (
      fieldLabel === "Path / Prefix"
        ? [fieldLabel, folderPrefix] as [string, string]
        : [fieldLabel, fieldValue] as [string, string]
    )), [
      ["__Selection Kind", "prefix"],
      ["__Selected Object", ""],
      ["__Sample Object", ""],
    ]);
    const testingMessage = `${folderPrefix} 폴더를 데이터셋으로 검사하고 있습니다.`;
    setSelectedAssetPath(folderPrefix);
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setConnectionMessage(testingMessage);
    setConnectionStatus("testing");
    setSourceRuntime((runtime) => runtime ? {
      ...runtime,
      datasetSummary: undefined,
      draftPatch: { ...runtime.draftPatch, schema: undefined },
      previewColumns: [],
      previewRows: [],
    } : runtime);
    applySourceDraft(activeSourceType, nextFields, "testing", testingMessage);
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
    onAction("etl.source.prefix_selected", "/api/etl/sources/test", folderPrefix);

    try {
      const result = patchConnectorAnalysisSourceConfig(
        mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, nextFields)),
          nextFields,
        ),
        nextFields,
        [
          ["Path / Prefix", folderPrefix],
          ["__Selection Kind", "prefix"],
          ["__Selected Object", ""],
          ["__Sample Object", ""],
        ],
      );
      const summary = result.datasetSummary;
      const hasSchema = Boolean(result.draftPatch.schema?.columns?.length);
      const prefixIsValid = Boolean(
        result.status === "success"
          && summary?.selectionKind === "prefix"
          && summary.schemaCompatible
          && summary.fileCount > 0
          && hasSchema,
      );
      const nextStatus: SourceDraft["connectionStatus"] = prefixIsValid ? "success" : "failed";
      const nextMessage = !summary
        ? `${folderPrefix} Prefix 검사 결과를 확인하지 못했습니다.`
        : summary.fileCount === 0
          ? `${folderPrefix} 아래에서 처리할 데이터 파일을 찾지 못했습니다.`
            : !summary.schemaCompatible
            ? `${folderPrefix} 아래 ${summary.fileCount.toLocaleString()}개 파일의 스키마가 호환되지 않습니다.`
            : !hasSchema
              ? `${folderPrefix} 대표 파일의 스키마를 확인하지 못했습니다.`
              : result.status !== "success"
                ? result.message || `${folderPrefix} 데이터셋 검증에 실패했습니다.`
              : `${folderPrefix} 데이터셋 검증 완료: ${summary.fileCount.toLocaleString()}개 파일`;
      const normalizedResult: SourceConnectorAnalysis = {
        ...result,
        draftPatch: {
          ...result.draftPatch,
          source: result.draftPatch.source ? {
            ...result.draftPatch.source,
            connectionMessage: nextMessage,
            connectionStatus: nextStatus,
          } : result.draftPatch.source,
        },
        message: nextMessage,
        status: nextStatus,
      };
      if (normalizedResult.draftPatch.source?.sourceConfig) {
        setSourceFields((fields) => ({ ...fields, [activeSourceType]: normalizedResult.draftPatch.source?.sourceConfig ?? nextFields }));
      }
      setSourceRuntime({ ...normalizedResult, assets: mergeSourceAssets(currentAssets, normalizedResult.assets ?? []) });
      setConnectionStatus(nextStatus);
      setConnectionMessage(nextMessage);
      onDraftChange(normalizedResult.draftPatch);
      onAction(
        prefixIsValid ? "etl.source.prefix_sampled" : "etl.source.prefix_validation_failed",
        normalizedResult.actionPath,
        folderPrefix,
        prefixIsValid ? undefined : "failed",
      );
      onNotify(nextMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "선택한 Prefix의 샘플을 가져오지 못했습니다.";
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, nextFields, "failed", message);
      onAction("etl.source.prefix_sample_failed", "/api/etl/sources/test", folderPrefix, "failed");
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
    if (isInternalDataLake) {
      onNotify("AskLake 데이터 레이크는 별도 연결 테스트 없이 Catalog 권한으로 탐색합니다.");
      return;
    }
    if (missingConnectionFields.length > 0) {
      onNotify(`${missingConnectionFields.map(sourceFieldLabel).join(", ")} 값을 입력하세요.`);
      return;
    }

    const testingMessage = `${sourceTypeLabel(activeSourceType)} 커넥터 테스트 실행 중입니다.`;
    setConnectionStatus("testing");
    setConnectionMessage(testingMessage);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    applySourceDraft(activeSourceType, editableFields, "testing", testingMessage);
    try {
      if (!["File / S3", "MongoDB", "PostgreSQL"].includes(activeSourceType)) {
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
      const discoveredTargetLabel = activeSourceType === "PostgreSQL"
        ? "테이블"
        : activeSourceType === "MongoDB"
          ? "컬렉션"
          : "하위 항목";
      const successMessage = `${sourceTypeLabel(activeSourceType)} 연결 성공: ${discoveredTargetLabel} ${result.assets.length}개 탐색 가능`;
      const connectionTestItems: Array<[string, string]> = activeSourceType === "PostgreSQL"
        ? [
            ["Endpoint", `${sourceConfigValue(editableFields, "Endpoint / Host")}:${sourceConfigValue(editableFields, "Port")}`],
            ["Database", sourceConfigValue(editableFields, "Database Name")],
            ["Tables", String(result.assets.length)],
          ]
        : activeSourceType === "MongoDB"
          ? [
              ["Endpoint", `${sourceConfigValue(editableFields, "Endpoint / Host")}:${sourceConfigValue(editableFields, "Port")}`],
              ["Database", sourceConfigValue(editableFields, "Database Name")],
              ["Collections", String(result.assets.length)],
            ]
          : [
              ["Connector", activeSourceType],
              ["Result", "Verified"],
              ["Objects", String(result.assets.length)],
            ];
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
        previewNote: `${discoveredTargetLabel}을 선택하면 제한 샘플과 스키마 추론 결과가 표시됩니다.`,
        previewRows: [],
        status: "success",
        testItems: connectionTestItems,
      };
      setSourceRuntime(connectorResult);
      setSelectedAssetPath("");
      setConnectionStatus("success");
      setConnectionMessage(successMessage);
      onDraftChange({
        ...connectorResult.draftPatch,
        schema: { columns: [], sampleRows: [], summary: "" },
      });
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
    if (sourceStage === "choose") {
      setSourceStage(isInternalDataLake ? "browse" : "connect");
      return;
    }
    if (!isInternalDataLake && connectionStatus !== "success") {
      onNotify(isSqlResultSource ? "SQL 분석에서 Preview를 실행한 뒤 처리 Job 생성으로 진입해 주세요." : "먼저 소스 연결 테스트를 성공시켜야 스키마 단계로 넘어갈 수 있습니다.");
      return;
    }
    if (sourceStage === "connect") {
      setSourceStage("browse");
      return;
    }
    if (isPrefixSelection && selectedDatasetSummary?.schemaCompatible === false) {
      onNotify("Prefix 아래 데이터 파일의 스키마가 서로 호환되지 않아 다음 단계로 이동할 수 없습니다.");
      return;
    }
    if (!hasValidatedSchema) {
      onNotify("데이터를 선택하고 샘플 스키마를 확인해야 다음 단계로 이동할 수 있습니다.");
      return;
    }
    applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
    onNext();
  };

  const sourceNextDisabled = sourceStage === "choose"
    ? !hasSelectedSource
    : sourceStage === "connect"
      ? connectionStatus !== "success"
      : isInternalDataLake
        ? !selectedCatalogDatasetId || !hasValidatedSchema
        : connectionStatus !== "success"
          || (requiresAssetSelectionForPreview && !selectedAssetPath)
          || !hasValidatedSchema;
  const canOpenSourceBrowser = isInternalDataLake
    ? hasSelectedSource && sourceStage !== "choose"
    : sourceStage === "browse" || (connectionStatus === "success" && hasDetectedAssets);

  const handleSourceStageChange = (value: string) => {
    const nextStage = value as "choose" | "connect" | "browse";
    if (nextStage === "browse" && !canOpenSourceBrowser) return;
    if (nextStage === "connect" && (!hasSelectedSource || sourceStage === "choose")) return;
    setSourceStage(nextStage);
  };

  const sourceChoiceConnectors = ["PostgreSQL", "MongoDB", "File / S3", "REST API", "Stream / Kafka", "Data Lake"];

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={sourceNextDisabled} showPrev={false} split onPrev={onPrev} onNext={goNext} />}
      className="source-creation-flow"
    >
        <EtlStepHeader
          className="etl-step-standalone-header"
          icon={<Cable />}
          title="소스 연결"
        />
        <section className="panel hegun-console-panel source-connect-panel source-workbench-panel" aria-label="소스 선택 및 연결">
        <div className="source-workbench-body">
          <Tabs
            value={sourceStage}
            onValueChange={handleSourceStageChange}
          >
            <TabsList
              aria-label="소스 연결 단계"
              className="source-stage-tabs"
              style={{ gridTemplateColumns: isInternalDataLake ? "repeat(2, minmax(0, 1fr))" : undefined }}
            >
              <TabsTrigger value="choose">1. 소스 선택</TabsTrigger>
              {!isInternalDataLake && <TabsTrigger disabled={!hasSelectedSource || sourceStage === "choose"} value="connect">2. 연결 설정</TabsTrigger>}
              <TabsTrigger
                disabled={!canOpenSourceBrowser}
                value="browse"
              >
                {isInternalDataLake ? "2. 데이터셋 탐색" : "3. 데이터 탐색"}
              </TabsTrigger>
            </TabsList>

          {sourceStage === "choose" && (
            <div className="source-stage-screen source-choice-screen">
              <div className="source-select-heading">
                <h2>데이터 소스 선택</h2>
              </div>
              <div className="source-choice-grid">
                {sourceChoiceConnectors.map((connector) => {
                  const meta = connectorMeta[connector];
                  return (
                    <Button
                      aria-label={`${meta.label} 소스 선택`}
                      aria-pressed={sourceType === connector}
                      className="source-choice-button relative grid h-auto min-h-36 w-full grid-cols-[64px_minmax(0,1fr)] items-center justify-items-start gap-5 whitespace-normal px-10 py-8 text-left"
                      key={connector}
                      type="button"
                      variant={sourceType === connector ? "subtle" : "outline"}
                      onClick={() => selectSource(connector)}
                    >
                      {sourceType === connector && <span className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-full bg-blue-600 text-white"><Check /></span>}
                      <span className="inline-flex size-16 items-center justify-center">{meta.icon}</span>
                      <span className="grid min-w-0 gap-1.5">
                        <span className="text-lg font-bold text-slate-950">{meta.label}</span>
                        <span className="text-[13px] font-medium leading-5 text-slate-500">{meta.description}</span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {sourceStage === "connect" && hasSelectedSource && !isInternalDataLake && (
            <ScrollArea className="h-[calc(100vh-270px)] min-h-0">
              <div className="source-stage-screen">
              <section className="source-step-section active">
                <div className="source-step-header">
                  <div className="source-step-brand" aria-hidden="true">{activeSourceMeta.icon}</div>
                  <div>
                    <strong>{current.title}</strong>
                  </div>
                  <div className="hegun-status-actions">
                    {isSqlResultSource ? <span className="panel-note">연결 테스트 생략</span> : <Button type="button" disabled={connectionStatus === "testing"} onClick={testConnection}>연결 테스트</Button>}
                  </div>
                </div>
                <div className="hegun-field-grid source-flow-fields">
                  {visibleEditableFields.map(([label, value]) => (
                    <FormFieldGroup
                      className={value.length > 38 ? "field wide" : "field"}
                      key={`${activeSourceType}-${label}`}
                      label={requiredSourceConnectionFields(activeSourceType).includes(label) ? `${sourceFieldLabel(label)} *` : sourceFieldLabel(label)}
                    >
                      <Input
                        autoComplete={isSecretSourceField(label) ? "new-password" : undefined}
                        readOnly={isSqlResultSource}
                        type={isSecretSourceField(label) ? "password" : "text"}
                        value={value}
                        onChange={(event) => updateSourceField(label, event.target.value)}
                      />
                    </FormFieldGroup>
                  ))}
                </div>
                {activeSourceType === "Stream / Kafka" && (
                  <section className="source-step-section" aria-label="Kafka 실행 방식">
                    <div className="source-step-header">
                      <em>2</em>
                      <div><strong>Kafka 실행 방식</strong></div>
                    </div>
                    <div className="kafka-execution-mode-grid" role="group" aria-label="Kafka 실행 방식 선택">
                      <button aria-pressed={kafkaExecutionMode === "snapshot"} className={`kafka-execution-mode-card ${kafkaExecutionMode === "snapshot" ? "selected" : ""}`} disabled={sourceLocked} type="button" onClick={() => onDraftChange({ source: { executionMode: "snapshot" } })}>
                        <span className="kafka-execution-mode-icon"><Clock3 size={19} /></span>
                        <span className="kafka-execution-mode-copy">
                          <strong>일괄 수집</strong>
                          <span>필요할 때 직접 실행하거나 일정에 맞춰 수집</span>
                        </span>
                        <span className="kafka-execution-mode-tag">배치</span>
                        {kafkaExecutionMode === "snapshot" && <span className="kafka-execution-mode-check"><Check size={14} /></span>}
                      </button>
                      <button aria-pressed={kafkaExecutionMode === "continuous"} className={`kafka-execution-mode-card ${kafkaExecutionMode === "continuous" ? "selected" : ""}`} disabled={sourceLocked} type="button" onClick={() => updateContinuousConfig({})}>
                        <span className="kafka-execution-mode-icon"><Repeat2 size={19} /></span>
                        <span className="kafka-execution-mode-copy">
                          <strong>실시간 수집</strong>
                          <span>새 메시지를 지속적으로 수집</span>
                        </span>
                        <span className="kafka-execution-mode-tag">스트리밍</span>
                        {kafkaExecutionMode === "continuous" && <span className="kafka-execution-mode-check"><Check size={14} /></span>}
                      </button>
                    </div>
                    {kafkaExecutionMode === "continuous" && (
                      <div className="kafka-continuous-settings">
                        <button aria-expanded={continuousAdvancedOpen} className="kafka-continuous-settings-toggle" type="button" onClick={() => setContinuousAdvancedOpen((open) => !open)}>
                          <span>고급 설정</span>
                          {continuousAdvancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                        {continuousAdvancedOpen && (
                          <div className="kafka-continuous-settings-grid">
                            <FormFieldGroup className="field" hint="새 체크포인트를 만들 때만 적용" label="시작 위치">
                              <NativeSelect disabled={sourceLocked} value={continuousConfig.initialOffsetPolicy} onChange={(event) => updateContinuousConfig({ initialOffsetPolicy: event.target.value as "earliest" | "latest" })}>
                                <option value="earliest">처음부터 읽기</option>
                                <option value="latest">새 이벤트부터 읽기</option>
                              </NativeSelect>
                            </FormFieldGroup>
                            <FormFieldGroup className="field" hint="1~3600초" label="수집 실행 간격">
                              <Input disabled={sourceLocked} max={3600} min={1} type="number" value={continuousConfig.triggerIntervalSeconds} onChange={(event) => {
                                const value = Number(event.target.value);
                                if (Number.isInteger(value) && value >= 1 && value <= 3600) updateContinuousConfig({ triggerIntervalSeconds: value });
                              }} />
                            </FormFieldGroup>
                            <FormFieldGroup className="field" hint="1~1,000,000건" label="한 번에 처리할 최대 메시지">
                              <Input disabled={sourceLocked} max={1_000_000} min={1} type="number" value={continuousConfig.maxOffsetsPerTrigger} onChange={(event) => {
                                const value = Number(event.target.value);
                                if (Number.isInteger(value) && value >= 1 && value <= 1_000_000) updateContinuousConfig({ maxOffsetsPerTrigger: value });
                              }} />
                            </FormFieldGroup>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}
                {current.info && <InfoBox title={isSqlResultSource ? "SQL Preview 입력" : "보안 연결"} body={current.info} />}
              </section>

              <section className={`hegun-source-status-bar ${connectionStatus}`} aria-label="연결 테스트 상태">
                <div className="hegun-status-head">
                  <div className="hegun-status-copy single-line">
                    {sourceStatusIcon(connectionStatus)}
                    <h2>{connectionStatusCopy[connectionStatus].title}</h2>
                  </div>
                  <div className="hegun-status-actions">
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
            </ScrollArea>
          )}

          {sourceStage === "browse" && hasSelectedSource && (
            <ScrollArea className="h-[calc(100vh-270px)] min-h-0">
              <div className="source-stage-screen">
                {isInternalDataLake ? (
                  <SourceExplorerWorkbench
                    explorer={(
                      <DataLakeDatasetList
                        datasets={filteredCatalogDatasets}
                        error={catalogError}
                        loading={catalogLoading}
                        selectedDatasetId={selectedCatalogDatasetId}
                        onSelect={selectCatalogDataset}
                      />
                    )}
                    explorerTitle="접근 가능한 데이터셋"
                    filterOptions={explorerConfig.filterOptions}
                    filterValue={assetFilter}
                    onFilterChange={setAssetFilter}
                    onPathChange={setAssetPathQuery}
                    onQueryChange={setAssetSearchQuery}
                    pathValue={assetPathQuery}
                    preview={(
                      <SourcePreviewDataTable
                        columnLabels={selectedCatalogDataset?.schema.map(([name]) => name) ?? []}
                        rows={selectedCatalogDataset?.sampleRows ?? []}
                      />
                    )}
                    previewMeta={selectedCatalogDataset ? (
                      <div className="source-explorer-preview-meta">
                        <span>{selectedCatalogDataset.sampleRows.length}행 · {selectedCatalogDataset.schema.length}필드</span>
                      </div>
                    ) : undefined}
                    previewTitle="데이터 미리보기"
                    queryPlaceholder="데이터셋 이름, 설명, 소유자 검색"
                    queryValue={assetSearchQuery}
                    showPathSearch={false}
                  />
                ) : (
                  <SourceExplorerWorkbench
                    explorer={hasDetectedAssets ? (
                      <SourceAssetTree
                        assets={filteredDisplayAssets.map(([path, meta, status]) => (
                          activeSourceType === "PostgreSQL" || activeSourceType === "MongoDB"
                            ? [path, "", status]
                            : [path, meta, status]
                        ))}
                        loadingPath={loadingAssetPath}
                        selectedPath={selectedAssetPath}
                        onOpenFolder={explorerConfig.supportsPathSearch ? loadSourceAssetChildren : undefined}
                        onSelectFolder={activeSourceType === "File / S3" ? selectSourceFolder : undefined}
                        onSelect={selectSourceAsset}
                      />
                    ) : (
                      <p className="source-empty-note">연결 테스트 후 탐색 가능한 항목이 표시됩니다.</p>
                    )}
                    explorerTitle={current.assetsTitle}
                    filterOptions={explorerConfig.filterOptions}
                    filterValue={assetFilter}
                    onFilterChange={setAssetFilter}
                    onPathChange={setAssetPathQuery}
                    onPathSubmit={navigateSourceAssetPath}
                    onQueryChange={setAssetSearchQuery}
                    pathPlaceholder={explorerConfig.pathPlaceholder}
                    pathValue={assetPathQuery}
                    preview={(
                      previewShowsRawText
                        ? <SourceRawSamplePreview lines={rawTextPreviewLines} />
                        : (
                          <SourcePreviewDataTable
                            columnLabels={displayPreviewColumns.map(sourceColumnLabel)}
                            rows={displayPreviewRows}
                          />
                        )
                    )}
                    previewIcon={previewShowsRawText ? <FileText /> : undefined}
                    previewMeta={(
                      <div className="source-explorer-preview-meta">
                        <Badge variant="outline" className="border-blue-200 bg-white text-blue-700">{displayPreviewFormat}</Badge>
                        {previewShowsRawText ? (
                          <span>{rawTextPreviewLines.length}행</span>
                        ) : selectedDatasetSummary ? (
                          <span>
                            전체 {selectedDatasetSummary.fileCount.toLocaleString()}개 · {formatSourceBytes(selectedDatasetSummary.totalBytes)} · 스키마 {selectedDatasetSummary.schemaCompatible ? "호환" : "불일치"}
                            {selectedDatasetSummary.excludedFileCount > 0 ? ` · 제외 ${selectedDatasetSummary.excludedFileCount.toLocaleString()}개` : ""}
                          </span>
                        ) : (
                          <span>{displayPreviewRows.length}행 · {displayPreviewColumns.length}필드</span>
                        )}
                      </div>
                    )}
                    previewTitle={previewShowsRawText
                      ? (previewShowsKafkaClickLog ? "원본 로그 샘플" : "원본 샘플")
                      : selectedDatasetSummary
                      ? `대표 파일 · ${selectedDatasetSummary.representativeObject}`
                      : selectedAsset?.[0] || sourcePreviewTitle}
                    queryPlaceholder={explorerConfig.queryPlaceholder}
                    queryValue={assetSearchQuery}
                    showPathSearch={explorerConfig.supportsPathSearch}
                  />
                )}
              </div>
            </ScrollArea>
          )}
          </Tabs>
        </div>
        </section>
    </CreationFlowLayout>
  );
}

function DataLakeDatasetList({
  datasets,
  error,
  loading,
  onSelect,
  selectedDatasetId,
}: {
  datasets: CatalogDataset[];
  error: string;
  loading: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  selectedDatasetId: string;
}) {
  if (loading) {
    return <EmptyState description="현재 계정으로 볼 수 있는 데이터셋을 확인하고 있습니다." icon={<RefreshCw className="animate-spin" />} size="sm" title="데이터셋 불러오는 중" variant="plain" />;
  }
  if (error) {
    return <EmptyState description={error} icon={<Info />} size="sm" title="데이터셋을 불러오지 못했습니다." variant="plain" />;
  }
  if (datasets.length === 0) {
    return <EmptyState description="Catalog에서 조회 권한이 있는 사용 가능한 데이터셋이 없습니다." icon={<Database />} size="sm" title="표시할 데이터셋이 없습니다." variant="plain" />;
  }
  return (
    <div className="data-lake-dataset-list" role="listbox" aria-label="접근 가능한 AskLake 데이터셋">
      {datasets.map((dataset) => {
        const selected = dataset.id === selectedDatasetId;
        return (
          <button
            aria-selected={selected}
            className={cn("data-lake-dataset-row", selected && "is-selected")}
            key={dataset.id}
            role="option"
            type="button"
            onClick={() => onSelect(dataset)}
          >
            <span className="data-lake-dataset-icon"><Database /></span>
            <span className="data-lake-dataset-copy">
              <strong>{dataset.name}</strong>
              <span>{dataset.description || `${dataset.owner} 소유 데이터셋`}</span>
            </span>
            <span className="data-lake-dataset-meta">
              <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{dataset.layer}</Badge>
              <span>{dataset.schema.length}필드 · {dataset.rows}</span>
            </span>
            {selected ? <Check className="data-lake-dataset-check" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function RecordParsingPage({
  draft,
  onAction,
  onDraftChange,
  onNext,
  onNotify,
  onPrev,
}: {
  draft: DraftPipeline;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNext: () => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
}) {
  const rawLines = draft.source.rawPreviewLines ?? [];
  const [preview, setPreview] = useState<RecordParsingPreviewResponse | null>(null);
  const [parsing, setParsing] = useState<RecordParsingDraft>(draft.recordParsing);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadPreview = async (nextParsing: RecordParsingDraft) => {
    setLoading(true);
    setError("");
    try {
      const result = await previewRecordParsing(rawLines, nextParsing);
      setPreview(result);
      setParsing(result.recordParsing);
      onAction("etl.record_parsing.previewed", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt");
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "레코드 구조화 미리보기에 실패했습니다.";
      setError(message);
      onAction("etl.record_parsing.preview_failed", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt", "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (rawLines.length === 0) {
      setError("원본 TXT 샘플이 없습니다. 소스 단계에서 파일을 다시 선택해 주세요.");
      return;
    }
    void loadPreview(draft.recordParsing.enabled ? draft.recordParsing : {
      columns: [],
      delimiterKind: "whitespace",
      delimiterPattern: "\\s+",
      enabled: true,
      expectedFieldCount: 0,
      header: false,
    });
  }, [draft.source.sourceLabel]);

  const updateHeader = (header: boolean) => {
    const next = { ...parsing, columns: [], expectedFieldCount: 0, header };
    setParsing(next);
    void loadPreview(next);
  };

  const updateColumn = (position: number, patch: Partial<RecordParsingDraft["columns"][number]>) => {
    const columns = parsing.columns.map((column) => column.position === position ? { ...column, ...patch } : column);
    const nextParsing = { ...parsing, columns };
    setParsing(nextParsing);
    setPreview((current) => current ? {
      ...current,
      columns: current.columns.map((column, index) => index === position ? {
        ...column,
        sourceName: patch.name ?? column.sourceName,
        targetName: patch.name ?? column.targetName,
        type: patch.inferredType ?? column.type,
      } : column),
      recordParsing: nextParsing,
    } : current);
  };

  const normalizedNames = parsing.columns.map((column) => normalizeTargetColumnName(column.name));
  const columnNamesValid = normalizedNames.every(Boolean) && new Set(normalizedNames).size === normalizedNames.length;
  const canApply = Boolean(preview?.canApply && columnNamesValid && parsing.columns.length === parsing.expectedFieldCount);

  const applyAndContinue = () => {
    if (!preview || !canApply) {
      onNotify("필드 개수와 컬럼명을 확인한 뒤 다시 시도해 주세요.");
      return;
    }
    const columns = parsing.columns.map((column) => {
      const name = normalizeTargetColumnName(column.name) || `field_${column.position + 1}`;
      return {
        confidence: 90,
        included: false,
        nullable: false,
        sourceName: name,
        targetName: name,
        type: column.inferredType,
      } satisfies SchemaColumnDraft;
    });
    const normalizedParsing: RecordParsingDraft = {
      ...parsing,
      columns: parsing.columns.map((column) => ({ ...column, name: normalizeTargetColumnName(column.name) })),
      enabled: true,
    };
    onDraftChange({
      recordParsing: normalizedParsing,
      schema: {
        columns,
        sampleRows: preview.sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary: `TXT 연속 공백 구조화 · ${preview.totalRows}행 검증 · ${columns.length}개 필드`,
      },
      transform: {
        outputColumns: columns.map((column) => [column.targetName, column.type]),
        summary: "레코드 구조화 적용 · 추가 변환 없음",
      },
    });
    onAction("etl.record_parsing.applied", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt");
    onNext();
  };

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={!canApply || loading} useShadcnStyles onPrev={onPrev} onNext={applyAndContinue} />}
    >
      <header className="record-parsing-page-header">
        <span className="record-parsing-page-icon" aria-hidden="true"><SlidersHorizontal /></span>
        <h2>레코드 구조화</h2>
      </header>

      <section className="record-parsing-source-strip" aria-label="선택한 원시 소스">
        <span className="record-parsing-source-icon" aria-hidden="true"><FileText /></span>
        <span className="record-parsing-source-name">
          <em>원시 소스</em>
          <strong title={draft.source.sourceLabel || "-"}>{draft.source.sourceLabel || "-"}</strong>
        </span>
        <span className="record-parsing-source-meta" aria-label="소스 요약">
          <strong>{draft.source.detectedFormat || "TXT"}</strong>
          <strong>{rawLines.length}행</strong>
          <strong>필드 없음</strong>
        </span>
      </section>

      <div className="record-parsing-workspace">
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><FileText aria-hidden="true" />원본 샘플</h2>
            <span className="record-parsing-count">{rawLines.length}행</span>
          </div>
          <div className="record-parsing-panel-body">
            <textarea className="input record-parsing-raw" readOnly aria-label="원본 TXT 샘플" value={rawLines.join("\n")} />
          </div>
        </section>

        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><SlidersHorizontal aria-hidden="true" />컬럼 설정</h2>
            <span className={cn("record-parsing-status", preview?.invalidRows.length && "is-warning")}>
              {!loading && preview && !preview.invalidRows.length ? <Check aria-hidden="true" /> : null}
              {loading ? "검증 중" : preview ? `${preview.validRows}/${preview.totalRows} 정상` : "검증 대기"}
            </span>
          </div>
          <div className="record-parsing-panel-body record-parsing-settings-body">
            <div className="record-parsing-controls">
              <FormFieldGroup className="field" label="필드 구분자">
                <NativeSelect disabled value="whitespace"><option value="whitespace">연속 공백 (\\s+)</option></NativeSelect>
              </FormFieldGroup>
              <FormFieldGroup className="field" label="헤더 처리">
                <NativeSelect value={parsing.header ? "first" : "none"} onChange={(event) => updateHeader(event.target.value === "first")}>
                  <option value="none">헤더 없음</option>
                  <option value="first">첫 줄을 헤더로 사용</option>
                </NativeSelect>
              </FormFieldGroup>
            </div>
            {error && <p className="record-parsing-error">{error}</p>}
            <ScrollArea type="always" scrollbars="horizontal" className="record-parsing-table-scroll">
              <table className="schema-table record-parsing-table">
                <thead><tr><th>순서</th><th>샘플 값</th><th>출력 컬럼명</th><th>추론 타입</th></tr></thead>
                <tbody>
                  {parsing.columns.map((column) => (
                    <tr key={column.position}>
                      <td>{column.position + 1}</td>
                      <td><code>{preview?.sampleRows[0]?.[column.position] || "-"}</code></td>
                      <td><Input aria-label={`${column.position + 1}번째 출력 컬럼명`} value={column.name} onChange={(event) => updateColumn(column.position, { name: event.target.value })} /></td>
                      <td>
                        <NativeSelect value={column.inferredType} onChange={(event) => updateColumn(column.position, { inferredType: event.target.value as RecordParsingDraft["columns"][number]["inferredType"] })}>
                          {schemaTypeOptions.filter((type) => type !== "JSON").map((type) => <option key={type} value={type}>{type}</option>)}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
            {!columnNamesValid && <p className="record-parsing-error">컬럼명은 비어 있거나 중복될 수 없습니다.</p>}
          </div>
        </section>
      </div>

      {preview?.invalidRows.length ? (
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header record-parsing-panel-header-warning"><h2><Info aria-hidden="true" />필드 개수 불일치</h2></div>
          <div className="record-parsing-panel-body">
            <table className="schema-table record-parsing-invalid-table">
              <thead><tr><th>원본 행</th><th>예상</th><th>실제</th><th>원문</th></tr></thead>
              <tbody>{preview.invalidRows.map((row) => <tr key={row.lineNumber}><td>{row.lineNumber}</td><td>{row.expectedFieldCount}</td><td>{row.actualFieldCount}</td><td><code>{row.rawPreview}</code></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : preview && (
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><Table2 aria-hidden="true" />결과 미리보기</h2>
            <span className="record-parsing-count">{preview.totalRows}행 · {parsing.expectedFieldCount}컬럼</span>
          </div>
          <div className="record-parsing-panel-body record-parsing-preview-body">
            <ScrollArea type="always" scrollbars="horizontal" className="record-parsing-table-scroll">
              <table className="schema-table record-parsing-preview-table">
                <thead><tr>{parsing.columns.map((column) => <th key={column.position}>{column.name}</th>)}</tr></thead>
                <tbody>{preview.sampleRows.slice(0, 5).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </ScrollArea>
          </div>
        </section>
      )}
    </CreationFlowLayout>
  );
}

function sourceFormatFromConfig(fields: Array<[string, string]>) {
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
  if (rawFormat.includes("txt") || rawFormat.includes("log")) return "TXT";
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

function formatSourceBytes(totalBytes: number) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(totalBytes) / Math.log(1024)), units.length - 1);
  const value = totalBytes / (1024 ** unitIndex);
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
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
    if (OBJECT_STORAGE_IS_AWS && ["Endpoint URL", "Access Key", "Secret Key"].includes(label)) return false;
    return !["Storage Provider", "Region", "Use Path Style", "Header", "Path / Prefix", "File Type", "Delimiter", "Encoding"].includes(label);
  }
  if (sourceType === "PostgreSQL") {
    return !["Schema", "DATASET OR TABLE SELECTOR"].includes(label);
  }
  if (sourceType === "MongoDB") {
    return label !== "DATASET OR TABLE SELECTOR";
  }
  if (sourceType === "REST API") {
    return ["Method", "Endpoint URL", "Accept"].includes(label);
  }
  if (sourceType === "Stream / Kafka") {
    return ["Broker / Endpoint", "TOPIC / QUEUE NAME"].includes(label);
  }
  if (sourceType === "Data Lake") {
    return ["Source Dataset", "Source Dataset ID"].includes(label);
  }
  return true;
}

function requiredSourceConnectionFields(sourceType: string) {
  const fields: Record<string, string[]> = {
    "Data Lake": [],
    "File / S3": OBJECT_STORAGE_IS_AWS ? ["Bucket / Stage Name"] : ["Endpoint URL", "Bucket / Stage Name", "Access Key", "Secret Key"],
    MongoDB: ["Endpoint / Host", "Port", "Database Name"],
    PostgreSQL: ["Endpoint / Host", "Port", "Database Name", "Username", "Password / Auth Token"],
    "REST API": ["Method", "Endpoint URL"],
    "Stream / Kafka": ["Broker / Endpoint", "TOPIC / QUEUE NAME"],
  };
  return fields[sourceType] ?? [];
}

type SourceExplorerConfig = {
  filterMode: "extension" | "meta" | "none";
  filterOptions: Array<{ label: string; value: string }>;
  pathPlaceholder: string;
  previewTitle: string;
  queryPlaceholder: string;
  supportsPathSearch: boolean;
};

function sourceExplorerConfig(sourceType: string, assets: Array<[string, string, string]>): SourceExplorerConfig {
  if (sourceType === "Data Lake") {
    return {
      filterMode: "none",
      filterOptions: [
        { label: "모든 레이어", value: "all" },
        { label: "RAW", value: "RAW" },
        { label: "BRONZE", value: "BRONZE" },
        { label: "SILVER", value: "SILVER" },
        { label: "GOLD", value: "GOLD" },
      ],
      pathPlaceholder: "",
      previewTitle: "데이터셋 미리보기",
      queryPlaceholder: "데이터셋 이름, 설명, 소유자 검색",
      supportsPathSearch: false,
    };
  }

  if (sourceType === "File / S3") {
    return {
      filterMode: "extension",
      filterOptions: [
        { label: "모든 형식", value: "all" },
        { label: "Parquet", value: "parquet" },
        { label: "CSV / TSV", value: "delimited" },
        { label: "JSON / JSONL", value: "json" },
      ],
      pathPlaceholder: "버킷 내부 경로 또는 프리픽스",
      previewTitle: "데이터 미리보기",
      queryPlaceholder: "현재 불러온 파일 또는 폴더 검색",
      supportsPathSearch: true,
    };
  }

  if (sourceType === "PostgreSQL" || sourceType === "MongoDB") {
    const scopes = Array.from(new Set(assets.map(([, meta]) => meta.trim()).filter(Boolean)));
    const scopeLabel = sourceType === "PostgreSQL" ? "스키마" : "데이터베이스";
    return {
      filterMode: "meta",
      filterOptions: scopes.length > 1
        ? [
            { label: `${scopeLabel} 전체`, value: "all" },
            ...scopes.map((scope) => ({ label: `${scopeLabel}: ${scope}`, value: scope.toLowerCase() })),
          ]
        : [{ label: `${scopeLabel}: ${scopes[0] ?? "-"}`, value: "all" }],
      pathPlaceholder: "",
      previewTitle: "데이터 미리보기",
      queryPlaceholder: sourceType === "PostgreSQL" ? "테이블명 검색" : "컬렉션명 검색",
      supportsPathSearch: false,
    };
  }

  if (sourceType === "REST API") {
    return {
      filterMode: "none",
      filterOptions: [{ label: "모든 응답 필드", value: "all" }],
      pathPlaceholder: "",
      previewTitle: "데이터 미리보기",
      queryPlaceholder: "응답 필드 또는 경로 검색",
      supportsPathSearch: false,
    };
  }

  if (sourceType === "Stream / Kafka") {
    return {
      filterMode: "none",
      filterOptions: [{ label: "모든 파티션", value: "all" }],
      pathPlaceholder: "",
      previewTitle: "데이터 미리보기",
      queryPlaceholder: "파티션 또는 메시지 필드 검색",
      supportsPathSearch: false,
    };
  }

  return {
    filterMode: "none",
    filterOptions: [{ label: "전체", value: "all" }],
    pathPlaceholder: "",
    previewTitle: "데이터 미리보기",
    queryPlaceholder: "탐색 항목 검색",
    supportsPathSearch: false,
  };
}

function sourceAssetMatchesExplorer(
  [path, meta, status]: [string, string, string],
  query: string,
  filter: string,
  filterMode: SourceExplorerConfig["filterMode"],
) {
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = !normalizedQuery || `${path} ${meta} ${status}`.toLowerCase().includes(normalizedQuery);
  if (!matchesQuery || filter === "all" || filterMode === "none") return matchesQuery;
  if (meta.toLowerCase() === "folder" || path.endsWith("/")) return true;
  if (filterMode === "meta") return meta.trim().toLowerCase() === filter;

  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (filter === "parquet") return extension === "parquet";
  if (filter === "delimited") return extension === "csv" || extension === "tsv" || extension === "txt";
  if (filter === "json") return extension === "json" || extension === "jsonl";
  return true;
}

function isSecretSourceField(label: string) {
  return ["Access Key", "Password / Auth Token", "Secret Key", "Token / Secret"].includes(label);
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

const schemaTypeOptions = ["String", "Integer", "Long", "Double", "Boolean", "Timestamp", "Date", "JSON"];
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
  if (probe.includes(".txt") || probe.includes(".log") || probe.includes(" txt") || probe.includes(" log")) return "TXT";
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
  const [showResultPreview, setShowResultPreview] = useState(false);
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
    if (includedSchemaColumns.length === 0) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("출력에 포함된 컬럼이 없습니다. 최소 1개 컬럼을 포함해야 실행할 수 있습니다.");
      return false;
    }
    const emptyNameColumn = includedSchemaColumns.find((column) => !column.targetName.trim());
    if (emptyNameColumn) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", emptyNameColumn.sourceName, "failed");
      onNotify(`${emptyNameColumn.sourceName} 필드의 출력 이름을 입력해야 합니다.`);
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
          <Button className="secondary-button" type="button" variant="outline" disabled={!hasInferredSchema} onClick={resetSchemaMappings}>
            <RefreshCw size={15} /> 매핑 초기화
          </Button>
          <Button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", approvedSummary)}>
            <Check size={15} /> 스키마 승인
          </Button>
        </div>
      </section>

      <CommandBar className="schema-bottom-bar schema-top-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>이전</Button>
        <span>2/3 단계 · {hasInferredSchema ? approvedSummary : inferredSummary}</span>
        <Button
          aria-expanded={showResultPreview}
          className="secondary-button schema-result-preview-button"
          type="button"
          variant="outline"
          disabled={!hasInferredSchema}
          onClick={() => setShowResultPreview((current) => !current)}
        >
          <Table2 size={15} /> {showResultPreview ? "미리보기 닫기" : "결과 미리보기"}
        </Button>
        <Button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={confirmCurrentSchema}>다음</Button>
        <Button className="ghost-button" type="button" variant="ghost" onClick={saveSchemaDraft}>설정 저장</Button>
      </CommandBar>

      <div className="schema-workbench-content">
        <SchemaTransformWorkbench
          columns={schemaColumns}
          executionMode={draft.source.executionMode}
          sampleRows={schemaSampleRows}
          selectedIndex={selectedIndex}
          sourceFormat={sourceFormat}
          sourceType={draft.source.sourceType}
          qualityRules={draft.quality.rules}
          transformSteps={draft.transform.steps}
          onSelectedIndexChange={setSelectedSchemaIndex}
          onColumnsChange={(nextColumns, nextSampleRows = schemaSampleRows) => {
            patchSchemaColumns(nextColumns, nextSampleRows);
            const boundedIndex = nextColumns.length > 0 ? Math.min(selectedIndex, nextColumns.length - 1) : 0;
            setSelectedSchemaIndex(boundedIndex);
          }}
          onTransformStepsChange={(steps, outputColumns) => {
            onDraftChange({
              transform: {
                outputColumns,
                steps,
                summary: steps.length > 0 ? `스키마 단계 변환 ${steps.length}개 설정` : "스키마 단계 변환 없음",
              },
            });
          }}
          onQualityRulesChange={(rules) => {
            onDraftChange({
              quality: {
                invalidRows: [],
                rules,
                score: undefined,
                status: "idle",
                summary: rules.length > 0 ? `스키마 단계 품질 규칙 ${rules.length}개 설정` : "데이터 품질 규칙 없음",
              },
            });
          }}
        />

        {showResultPreview ? (
          <SchemaResultPreview
            columns={schemaColumns}
            qualityRules={draft.quality.rules}
            sampleRows={schemaSampleRows}
          />
        ) : null}

        <SchemaRuleSummary
          columns={schemaColumns}
          qualityRules={draft.quality.rules}
          transformSteps={draft.transform.steps}
        />
      </div>

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
      <SegmentedTabs
        ariaLabel="처리 규칙 모드"
        buttonClassName="hegun-rule-category"
        className="hegun-rule-category-list"
        items={RULE_CATEGORIES.map((category) => ({
          icon: <span className="hegun-rule-category-icon">{category.icon}</span>,
          label: (
            <>
              <strong>{category.label}</strong>
              <em>{category.description}</em>
            </>
          ),
          value: category.id,
        }))}
        value={activeCategory}
        onValueChange={onSelect}
      />
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
              <NativeSelectField
                className="input control-input"
                fieldClassName="hegun-rule-field wide"
                label={isTransform ? "추천 변환 규칙 불러오기" : "추천 품질 규칙 불러오기"}
                value={selectedPresetId}
                onChange={(event) => setSelectedPresetId(event.target.value)}
              >
                {presetOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </NativeSelectField>
            )}
            <NativeSelectField
              className="input control-input"
              fieldClassName="hegun-rule-field"
              label={isTransform ? "입력 컬럼" : "대상 컬럼"}
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
            </NativeSelectField>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "처리 작업" : "검증 규칙"}>
              {isTransform ? (
                <NativeSelect
                  className="input control-input"
                  value={selectedOperation}
                  onChange={(event) => selectTransformOperation(event.target.value as TransformOperation)}
                >
                  {TRANSFORM_OPERATION_OPTIONS.map((operation) => (
                    <option key={operation} value={operation}>{transformOperationLabel(operation)}</option>
                  ))}
                </NativeSelect>
              ) : (
                <NativeSelect
                  className="input control-input"
                  value={selectedValidationType}
                  onChange={(event) => setSelectedValidationType(event.target.value as QualityRule["validationType"])}
                >
                  {QUALITY_VALIDATION_OPTIONS.map((validationType) => (
                    <option key={validationType} value={validationType}>{qualityValidationLabel(validationType)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "출력 컬럼" : "심각도"}>
              {isTransform ? (
                <div className="hegun-rule-control-stack">
                  <Input
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
                <NativeSelect
                  className="input control-input"
                  value={selectedSeverity}
                  onChange={(event) => setSelectedSeverity(event.target.value as QualityRule["severity"])}
                >
                  {QUALITY_SEVERITY_OPTIONS.map((severity) => (
                    <option key={severity} value={severity}>{qualitySeverityLabel(severity)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            <FormFieldGroup className="hegun-rule-field" label={isTransform ? "옵션" : "실패 처리"}>
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
                <NativeSelect
                  className="input control-input"
                  value={selectedFailureAction}
                  onChange={(event) => setSelectedFailureAction(event.target.value as QualityRule["failureAction"])}
                >
                  {QUALITY_FAILURE_ACTION_OPTIONS.map((failureAction) => (
                    <option key={failureAction} value={failureAction}>{failureActionLabel(failureAction)}</option>
                  ))}
                </NativeSelect>
              )}
            </FormFieldGroup>
            {isTransform && (
              <NativeSelectField
                className="input control-input"
                fieldClassName="hegun-rule-field"
                label="오류 처리"
                value={onError}
                onChange={(event) => setOnError(event.target.value as TransformFailurePolicy)}
              >
                {TRANSFORM_FAILURE_POLICY_OPTIONS.map((policy) => (
                  <option key={policy} value={policy}>{failureActionLabel(policy)}</option>
                ))}
              </NativeSelectField>
            )}
          </div>
          <ActionGroup className="hegun-rule-form-actions" density="compact">
            {isEditing && <Button className="ghost-button" type="button" variant="ghost" onClick={cancelEdit}>수정 취소</Button>}
            <Button className="secondary-button" type="button" variant="outline" onClick={previewDraft}>{isTransform ? "선택 단계 미리보기" : "선택 검사 미리보기"}</Button>
            <Button className="primary-button" type="button" onClick={addDraftStep}>{submitLabel}</Button>
          </ActionGroup>
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
        <Input className="input control-input" type="text" value={jsonPath} onChange={(event) => onJsonPathChange(event.target.value)} />
        <em>JSON 컬럼에서 꺼낼 경로</em>
      </div>
    );
  }

  if (operation === "Cast Decimal") {
    return (
      <div className="hegun-rule-control-stack">
        <Input className="input control-input" type="text" value={decimalFormat} onChange={(event) => onDecimalFormatChange(event.target.value)} />
        <em>숫자 변환 형식</em>
      </div>
    );
  }

  if (operation === "Parse Timestamp") {
    return (
      <div className="hegun-rule-control-stack">
        <NativeSelect className="input control-input" value={timestampFormat} onChange={(event) => onTimestampFormatChange(event.target.value)}>
          <option value="UTC">UTC</option>
          <option value="string to UTC">string to UTC</option>
        </NativeSelect>
        <em>목표 시간대 / 변환 형식</em>
      </div>
    );
  }

  return (
    <div className="hegun-rule-control-stack">
      <NativeSelect className="input control-input" value={maskPolicy} onChange={(event) => onMaskPolicyChange(event.target.value)}>
        <option value="keep first 3 digits">앞 3자리 유지</option>
        <option value="keep last 4 digits">뒤 4자리 유지</option>
      </NativeSelect>
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
    <CommandBar className="hegun-rule-bottom-bar" layout="sticky">
      <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>스키마로 돌아가기</Button>
      <Button className="ghost-button hegun-bottom-command" type="button" variant="ghost" onClick={onTest}>
        <Search size={16} />
        샘플 테스트 (1,000개 행)
      </Button>
      <Button className={invalidRowsVisible ? "ghost-button hegun-bottom-command active" : "ghost-button hegun-bottom-command"} type="button" variant="ghost" onClick={onInvalidRows}>
        <Info size={16} />
        유효하지 않은 행 보기 ({invalidRowCount})
      </Button>
      <span className="hegun-target-engine">실행 엔진<br /><strong>Spark</strong></span>
      <Button className="secondary-button" type="button" variant="outline" onClick={onSave}>임시 저장</Button>
      <Button className="primary-button" type="button" onClick={onNext}>실행 준비 완료</Button>
    </CommandBar>
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
        <Button className="secondary-button hegun-header-button" type="button" variant="outline" onClick={() => onAction("etl.rules.sample_rows_refetched", "/api/etl/rules/sample-rows")}>새 샘플 행 가져오기</Button>
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

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escapeCell = (value: string | number) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
        <Button className="secondary-button hegun-header-button" type="button" variant="outline" onClick={() => onAction("etl.rules.quality_sample_refetched", "/api/etl/rules/quality/sample-rows")}>새 샘플 행 가져오기</Button>
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
      <ActionGroup className="hegun-rule-form-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={() => {
          downloadCsv("asklake-quality-failed-rows.csv", ["행", "컬럼", "샘플 값", "사유", "처리"], previewRows.map((row) => [row.row, row.column, row.sampleValue, qualityFailureReasonLabel(row.reason), failureActionLabel(row.action)]));
          onAction("etl.rules.quality_failed_rows_exported", "/api/etl/rules/quality/failed-rows/export");
        }}>행 내보내기</Button>
        <Button className="primary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_reviewed", "/api/etl/rules/quality/failed-rows/review")}>검토 완료</Button>
      </ActionGroup>
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
      <ActionGroup className="hegun-rule-form-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={() => {
          downloadCsv("asklake-invalid-rows.csv", ["행", "컬럼", "사유", "처리", "샘플 값"], invalidRows.map((row) => [row.row, row.column, qualityFailureReasonLabel(row.reason), failureActionLabel(row.action), row.sampleValue]));
          onAction("etl.rules.invalid_rows_exported", "/api/etl/rules/invalid-rows/export");
        }}>행 내보내기</Button>
        <Button className="primary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_reviewed", "/api/etl/rules/invalid-rows/review")}>검토 완료</Button>
      </ActionGroup>
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
  onOverlapPolicyChange,
  onTimezoneChange,
  onTimeCommit,
  onTimeChange,
  overlapPolicy,
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
  onOverlapPolicyChange: (policy: ScheduleOverlapPolicy) => void;
  onTimezoneChange: (timezone: string) => void;
  onTimeCommit: () => void;
  onTimeChange: (time: string) => void;
  overlapPolicy: ScheduleOverlapPolicy;
  selectedDay: string;
  time: string;
  timezone: string;
}) {
  const cronIsValid = isValidCronExpression(customCron);
  const normalizedTimezone = normalizeScheduleTimezone(timezone);
  const visibleRepeatFrequencyOptions = repeatFrequencyOptions;

  return (
    <FieldSet>
      <FieldLegend>반복 일정</FieldLegend>
      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <FormField>
          <FieldLabel htmlFor="schedule-frequency">반복 주기</FieldLabel>
          <Select value={frequency} onValueChange={(value) => onFrequencyChange(value as RepeatFrequency)}>
            <SelectTrigger id="schedule-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleRepeatFrequencyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
          {frequency === "hourly" && (
            <FormField>
              <FieldLabel htmlFor="schedule-minute">실행 분</FieldLabel>
              <Select value={minute} onValueChange={onMinuteChange}>
                <SelectTrigger id="schedule-minute">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {validRepeatMinutes.map((value) => (
                    <SelectItem key={value} value={value}>{value}분</SelectItem>
                ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          {frequency === "daily" && (
            <ScheduleTimeField time={time} onTimeChange={onTimeChange} onTimeCommit={onTimeCommit} />
          )}
          {frequency === "weekly" && (
            <FormField className="md:col-span-2">
              <FieldLabel>실행 요일</FieldLabel>
              <ToggleGroup aria-label="실행 요일" className="grid grid-cols-7" type="single" value={selectedDay} onValueChange={(value) => value && onDayChange(value)}>
                {validRepeatDays.map((day) => (
                  <ToggleGroupItem className="min-w-0 px-2" key={day} value={day}>
                    {day}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FormField>
          )}
          {frequency === "weekly" && (
            <ScheduleTimeField time={time} onTimeChange={onTimeChange} onTimeCommit={onTimeCommit} />
          )}
          {frequency === "custom" && (
            <FormField>
              <FieldLabel htmlFor="schedule-cron">Cron 표현식</FieldLabel>
              <Input id="schedule-cron" inputMode="numeric" pattern="[0-9*,/\\-\\s]+" value={customCron} onBlur={onCronCommit} onChange={(event) => onCronChange(event.target.value)} onInput={(event) => onCronChange(event.currentTarget.value)} />
            </FormField>
          )}
        <FormField>
          <FieldLabel htmlFor="schedule-timezone">시간대</FieldLabel>
          <Select value={normalizedTimezone} onValueChange={onTimezoneChange}>
            <SelectTrigger id="schedule-timezone">
              <span>{timezoneOptions.find((option) => option.value === normalizedTimezone)?.label}</span>
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField>
          <FieldLabel htmlFor="schedule-overlap-policy">중복 실행 정책</FieldLabel>
          <Select value={overlapPolicy} onValueChange={(value) => onOverlapPolicyChange(value as ScheduleOverlapPolicy)}>
            <SelectTrigger id="schedule-overlap-policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(scheduleOverlapPolicyLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FieldGroup>
      {frequency === "custom" && !cronIsValid && (
        <Alert variant="destructive">
          <Info />
          <AlertTitle>Cron 형식을 확인해 주세요.</AlertTitle>
          <AlertDescription>5개 필드 형식만 저장합니다. 예: 0 10 * * 1-5</AlertDescription>
        </Alert>
      )}
    </FieldSet>
  );
}

function ScheduleTimeField({ onTimeChange, onTimeCommit, time }: { onTimeChange: (time: string) => void; onTimeCommit: () => void; time: string }) {
  return (
    <FormField>
      <FieldLabel htmlFor="schedule-time">실행 시간</FieldLabel>
      <Input id="schedule-time" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
    </FormField>
  );
}

function ScheduleRetrySettings({ onRetryPolicyChange, retryPolicy: value }: { onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft }) {
  const retryPolicy = normalizeRetryPolicy(value);
  const retryEnabled = retryPolicy.maxRetries > 0;
  const normalizeNumber = (nextValue: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(nextValue, 10);
    return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max);
  };
  const updateNumber = (key: "maxRetries" | "maxRetryDelayMinutes", nextValue: string, fallback: number, min: number, max: number) => {
    onRetryPolicyChange({ ...retryPolicy, [key]: normalizeNumber(nextValue, fallback, min, max) });
  };
  const updateInitialDelay = (nextValue: string) => {
    const nextDelay = normalizeNumber(nextValue, 1, 1, 1440);
    onRetryPolicyChange({
      ...retryPolicy,
      initialRetryDelayMinutes: nextDelay,
      maxRetryDelayMinutes: Math.max(retryPolicy.maxRetryDelayMinutes, nextDelay),
      retryIntervalMinutes: nextDelay,
    });
  };
  const blockInvalidNumberKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["e", "E", "+", "-", "."].includes(event.key)) event.preventDefault();
  };

  return (
    <FieldSet>
      <div className="flex items-center justify-between gap-4">
        <FieldLegend className="mb-0">재시도 정책</FieldLegend>
        <div className="flex items-center gap-3">
          <FieldLabel htmlFor="schedule-retry-enabled">재시도 사용</FieldLabel>
          <Switch
            checked={retryEnabled}
            id="schedule-retry-enabled"
            onCheckedChange={(checked) => onRetryPolicyChange({ ...retryPolicy, maxRetries: checked ? Math.max(retryPolicy.maxRetries, 3) : 0 })}
          />
        </div>
      </div>
      <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {retryEnabled && (
          <>
            <FormField>
              <FieldLabel htmlFor="schedule-max-retries">최대 재시도</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-max-retries" inputMode="numeric" max="10" min="1" type="number" value={retryPolicy.maxRetries} onChange={(event) => updateNumber("maxRetries", event.target.value, 3, 1, 10)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>회</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="schedule-initial-delay">시작 지연</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-initial-delay" inputMode="numeric" max="1440" min="1" type="number" value={retryPolicy.initialRetryDelayMinutes} onChange={(event) => updateInitialDelay(event.target.value)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>분</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="schedule-max-delay">최대 간격</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-max-delay" inputMode="numeric" max="1440" min={retryPolicy.initialRetryDelayMinutes} type="number" value={retryPolicy.maxRetryDelayMinutes} onChange={(event) => updateNumber("maxRetryDelayMinutes", event.target.value, 30, retryPolicy.initialRetryDelayMinutes, 1440)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>분</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
          </>
        )}
        <FormField className={retryEnabled ? "" : "md:col-span-2 xl:col-span-2"}>
          <FieldLabel htmlFor="schedule-failure-action">최종 실패 처리</FieldLabel>
          <Select value={retryPolicy.failureAction} onValueChange={(failureAction) => onRetryPolicyChange({ ...retryPolicy, failureAction: failureAction as RetryPolicyDraft["failureAction"] })}>
            <SelectTrigger id="schedule-failure-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(retryFailureActionLabels).map(([optionValue, label]) => (
                <SelectItem key={optionValue} value={optionValue}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FieldGroup>
    </FieldSet>
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
  const isKafkaSource = draft.source.sourceType === "Stream / Kafka" || draft.source.sourceType === "Kafka JSON";
  const isKafkaContinuous = isKafkaSource && draft.source.executionMode === "continuous";
  const isKafkaSnapshot = isKafkaSource && !isKafkaContinuous;
  const targetLayerOptions = isKafkaSnapshot ? KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS : TARGET_LAYER_OPTIONS;
  const targetFormatOptions = isKafkaContinuous
    ? KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS
    : isKafkaSnapshot
      ? KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS
      : TARGET_FORMAT_OPTIONS.filter((format) => format !== "jsonl");
  const initialTargetLayer = targetLayerOptions.includes(initialTarget.targetLayer)
    ? initialTarget.targetLayer
    : targetLayerOptions[0] ?? "BRONZE";
  const normalizedInitialTargetFormat = normalizeTargetFileFormat(initialTarget.targetFormat);
  const initialTargetFormat = targetFormatOptions.includes(normalizedInitialTargetFormat)
    ? normalizedInitialTargetFormat
    : targetFormatOptions[0] ?? "parquet";
  const initialStoragePath = initialTargetLayer !== initialTarget.targetLayer
    && initialTarget.storagePath === buildTargetStoragePath(initialTarget.targetDataset, initialTarget.targetLayer)
    ? buildTargetStoragePath(initialTarget.targetDataset, initialTargetLayer)
    : initialTarget.storagePath;
  const inferredTarget = useMemo(
    () => inferTargetSchema(draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules),
    [draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules],
  );
  const sampleTargetSchema = useMemo(() => inferTargetSchema([], [], undefined), []);
  const [targetDataset, setTargetDataset] = useState(initialTarget.targetDataset);
  const databaseName = draftTarget?.databaseName ?? "asklake";
  const targetLayer = initialTargetLayer;
  const [runtimeOutputBucket, setRuntimeOutputBucket] = useState(SPARK_OUTPUT_BUCKET);
  const [targetStoragePath, setTargetStoragePath] = useState(initialStoragePath);
  const [storagePathCustomized, setStoragePathCustomized] = useState(
    !isManagedTargetStoragePath(initialStoragePath, initialTarget.targetDataset, initialTargetLayer),
  );
  const [targetDescription, setTargetDescription] = useState(initialTarget.description);
  const targetFormat = initialTargetFormat;
  const targetOwner = draftTarget?.owner ?? initialTarget.owner;
  const [targetManager, setTargetManager] = useState(draftTarget?.manager ?? initialTarget.owner);
  const [targetTags, setTargetTags] = useState<string[]>(initialTarget.tags);
  const [customTag, setCustomTag] = useState("");
  const [partitionColumns, setPartitionColumns] = useState<string[]>(draftTarget?.partitionColumns ?? initialTarget.partitionColumns);
  const [indexColumns] = useState<string[]>(draftTarget?.indexColumns ?? []);
  const [schemaRules, setSchemaRules] = useState<TargetSchemaRule[]>(inferredTarget.schemaRules);
  const lastTestRun = draftTarget?.lastTestRun ?? { status: "idle", logs: [] };
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void listS3Buckets()
      .then(({ buckets }) => {
        const outputBucket = buckets[0]?.trim();
        if (active && outputBucket) setRuntimeOutputBucket(outputBucket);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (storagePathCustomized) return;
    setTargetStoragePath(buildTargetStoragePathForBucket(
      runtimeOutputBucket,
      targetDataset.trim() || "target_dataset",
      targetLayer,
    ));
  }, [runtimeOutputBucket, storagePathCustomized, targetDataset, targetLayer]);

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
    .filter((column) => partitionCandidates.some((rule) => rule.name === column && rule.use));
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

  const setPartitionColumnSelected = (columnName: string, selected: boolean) => {
    setPartitionColumns((currentColumns) => selected
      ? currentColumns.includes(columnName) ? currentColumns : [...currentColumns, columnName]
      : currentColumns.filter((column) => column !== columnName));
  };

  const changeTargetDataset = (nextDataset: string) => {
    setTargetDataset(nextDataset);
    if (!storagePathCustomized) {
      setTargetStoragePath(buildTargetStoragePathForBucket(
        runtimeOutputBucket,
        nextDataset.trim() || "target_dataset",
        targetLayer,
      ));
    }
  };

  const saveTargetConfig = () => {
    const config = buildConfig();
    const errors = validateTargetConfig(config, activeJsonParseFailed);
    if (!targetLayerOptions.includes(targetLayer)) errors.push(`현재 실행 방식에서 ${targetLayer} 레이어를 사용할 수 없습니다.`);
    if (!targetFormatOptions.includes(targetFormat)) errors.push(`현재 실행 방식에서 ${targetFormat.toUpperCase()} 포맷을 사용할 수 없습니다.`);
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
  const targetNextDisabled = validateTargetConfig(buildConfig(), activeJsonParseFailed).length > 0;

  const renderPartitionOption = (rule: TargetSchemaRule) => {
    const selected = filteredPartitionColumns.includes(rule.name);
    const disabled = !rule.use;
    const checkboxId = `target-partition-${rule.name}`;
    return (
      <label
        className={cn("target-partition-option", selected && "active", disabled && "disabled")}
        key={rule.name}
      >
        <Checkbox
          checked={selected}
          disabled={disabled}
          id={checkboxId}
          onCheckedChange={(checked) => setPartitionColumnSelected(rule.name, checked === true)}
        />
        <span className="target-partition-name">{rule.name}</span>
        <span className="target-partition-type">{formatPartitionColumnType(rule)}</span>
      </label>
    );
  };

  return (
    <CreationFlowLayout className="target-page-layout" actions={<CreationTopActions nextDisabled={targetNextDisabled} prevLabel="이전" nextLabel="다음" split onPrev={onPrev} onNext={handleNext} />}>
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<HardDrive />}
        title="타겟 설정"
      />
      {validationErrors.length > 0 ? (
        <div className="target-validation-summary" role="alert">
          {validationErrors.map((error) => <span key={error}>{error}</span>)}
        </div>
      ) : null}
      <div className="etl-review-stack target-config-stack">
        <section className="etl-review-card target-config-card">
          <div className="etl-review-card-header">
            <span className="etl-review-icon"><FileText size={17} /></span>
            <div>
              <h2>기본 정보</h2>
            </div>
          </div>
          <div className="target-config-form-grid basic">
            <FormFieldGroup className="field wide" label="데이터셋명">
              <Input className="input control-input" value={targetDataset} onChange={(event) => changeTargetDataset(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field target-manager-field" label="담당자">
              <Input className="input control-input" value={targetManager} onChange={(event) => setTargetManager(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field wide" label="설명">
              <Input className="input control-input" value={targetDescription} onChange={(event) => setTargetDescription(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field wide target-tags-field" label="태그">
              {targetTags.length > 0 ? (
                <TagList className="target-chip-grid" density="compact" role="group" aria-label="타겟 태그">
                  {targetTags.map((tag) => (
                    <Button aria-pressed={targetTags.includes(tag)} key={tag} size="sm" type="button" variant="secondary" onClick={() => toggleTag(tag)}>
                      {tag}
                    </Button>
                  ))}
                </TagList>
              ) : null}
              <div className="target-inline-controls">
                <Input className="input control-input" placeholder="태그 입력" value={customTag} onChange={(event) => setCustomTag(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomTag();
                  }
                }} />
                <Button type="button" variant="outline" onClick={addCustomTag}><Plus data-icon="inline-start" />추가</Button>
              </div>
            </FormFieldGroup>
          </div>
        </section>

        <section className="etl-review-card target-config-card">
          <div className="etl-review-card-header">
            <span className="etl-review-icon destination"><HardDrive size={17} /></span>
            <div>
              <h2>저장 위치 설정</h2>
            </div>
          </div>
          <div className="target-config-form-grid destination storage-only">
            <FormFieldGroup className="field wide target-storage-field" label="저장 경로">
              <S3PathField useShadcnStyles value={targetStoragePath} onChange={(path) => {
                setTargetStoragePath(path);
                setStoragePathCustomized(true);
              }} />
            </FormFieldGroup>
          </div>
        </section>
        <section className="etl-review-card target-config-card">
          <div className="etl-review-card-header">
            <span className="etl-review-icon permission"><SlidersHorizontal size={17} /></span>
            <div>
              <h2>파티션 설정</h2>
            </div>
          </div>
          <div className="target-partition-settings">
            <div className="target-partition-table">
              <div className="target-partition-header" aria-hidden="true">
                <span>선택</span>
                <span>컬럼명</span>
                <span>데이터 타입</span>
              </div>
              <div className="target-partition-grid" role="group" aria-label="파티션 컬럼 다중 선택">
                {partitionCandidates.map(renderPartitionOption)}
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
  const [grantTab, setGrantTab] = useState<PermissionGrantTab>("roles");
  const [grantSearch, setGrantSearch] = useState("");
  const [permissionOptions, setPermissionOptions] = useState<PermissionOptionsResponse | null>(null);
  const [permissionOptionsError, setPermissionOptionsError] = useState("");
  const [permissionOptionsLoading, setPermissionOptionsLoading] = useState(true);
  const [permissionOptionsRequest, setPermissionOptionsRequest] = useState(0);
  const [permissionActionError, setPermissionActionError] = useState("");
  const [roleChecks, setRoleChecks] = useState<Record<string, boolean>>({});
  const [userChecks, setUserChecks] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    setPermissionOptionsLoading(true);
    setPermissionOptionsError("");

    void fetchPermissionOptions()
      .then((options) => {
        if (!active) return;
        const savedGroupGrants = new Set(
          (draft.permission.grants ?? [])
            .filter((grant) => grant.principalType === "group")
            .map((grant) => grant.principalId),
        );
        const savedUserGrants = new Set(
          (draft.permission.grants ?? [])
            .filter((grant) => grant.principalType === "user")
            .map((grant) => grant.principalId),
        );
        const savedRoles = new Map((draft.permission.roles ?? []).map((role) => [role.name, role.checked]));
        const hasSavedGrants = draft.permission.grants !== undefined;
        const nextRoleChecks = Object.fromEntries(options.groups.map((group, index) => [
          group.id,
          hasSavedGrants ? savedGroupGrants.has(group.id) : savedRoles.get(group.name) ?? index === 0,
        ]));
        const nextUserChecks = Object.fromEntries(options.users.map((user) => [user.id, savedUserGrants.has(user.id)]));
        const selectedTemplate = options.groups.find((group) => group.name === initialPermission.permissionTemplate)
          ?? options.groups.find((group) => nextRoleChecks[group.id])
          ?? options.groups[0];
        setPermissionOptions(options);
        setPermissionActionError("");
        setPermissionTemplate(selectedTemplate?.name ?? initialPermission.permissionTemplate);
        setRoleChecks(nextRoleChecks);
        setUserChecks(nextUserChecks);
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "권한 대상 목록을 불러오지 못했습니다.";
        setPermissionOptionsError(message);
        setPermissionActionError(message);
      })
      .finally(() => {
        if (active) setPermissionOptionsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [permissionOptionsRequest]);

  const applyPermissionDraft = (patch: Partial<{
    owner: string;
    permissionTemplate: string;
    visibility: string;
  }> = {}, nextRoleChecks = roleChecks, nextUserChecks = userChecks) => {
    if (!permissionOptions) return;
    const requestedTemplate = patch.permissionTemplate ?? permissionTemplate;
    const nextPermissionTemplate = permissionOptions.groups.some((group) => group.name === requestedTemplate)
      ? requestedTemplate
      : permissionOptions.groups[0]?.name ?? DEFAULT_PERMISSION_TEMPLATE;
    const nextVisibility = getKnownOption(patch.visibility ?? visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);
    const nextOwner = getDisplayText(patch.owner ?? dataOwner, DEFAULT_OWNER);
    const permissionRoles = permissionOptions.groups.map((group) => ({
      access: group.actions.map((action) => PERMISSION_ACTION_LABELS[action]),
      checked: Boolean(nextRoleChecks[group.id]),
      name: group.name,
    }));
    const permissionGrants = [
      ...permissionOptions.groups
        .filter((group) => nextRoleChecks[group.id])
        .map((group) => ({
          actions: group.actions,
          principalId: group.id,
          principalType: "group" as const,
          source: "permission_ui",
        })),
      ...permissionOptions.users
        .filter((user) => nextUserChecks[user.id])
        .map((user) => ({
          actions: ["view", "run"] as PermissionAction[],
          principalId: user.id,
          principalType: "user" as const,
          source: "permission_ui",
        })),
      ...(nextVisibility === "외부 공유" ? [{
        actions: ["view"] as PermissionAction[],
        principalId: "public",
        principalType: "public" as const,
        source: "permission_ui",
      }] : []),
    ];
    const permissionSummary = buildPermissionSummary(nextPermissionTemplate, nextVisibility);

    onDraftChange({
      owner: nextOwner,
      permissionGrants,
      permissionRoles,
      permission: {
        grants: permissionGrants,
        owner: nextOwner,
        roles: permissionRoles,
        summary: permissionSummary,
        template: nextPermissionTemplate,
        visibility: nextVisibility,
      },
      permissionSummary,
    });
  };
  const goNext = () => {
    if (permissionOptionsLoading) {
      setPermissionActionError("권한 대상 목록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    if (permissionOptionsError || !permissionOptions || permissionOptions.groups.length === 0) {
      setPermissionActionError(permissionOptionsError || "사용 가능한 권한 그룹이 없어 다음 단계로 이동할 수 없습니다.");
      return;
    }
    setPermissionActionError("");
    applyPermissionDraft();
    onNext();
  };
  const updateRoleCheck = (roleId: string, checked: boolean) => {
    const nextRoleChecks = { ...roleChecks, [roleId]: checked };
    setRoleChecks(nextRoleChecks);
    applyPermissionDraft({}, nextRoleChecks);
  };
  const updateUserCheck = (userId: string, checked: boolean) => {
    const nextUserChecks = { ...userChecks, [userId]: checked };
    setUserChecks(nextUserChecks);
    applyPermissionDraft({}, roleChecks, nextUserChecks);
  };
  const normalizedGrantSearch = grantSearch.trim().toLocaleLowerCase();
  const filteredRoles = (permissionOptions?.groups ?? []).filter((role) => (
    `${role.name} ${role.description ?? ""}`.toLocaleLowerCase().includes(normalizedGrantSearch)
  ));
  const filteredUsers = (permissionOptions?.users ?? []).filter((user) => (
    `${user.name} ${user.email} ${user.role}`.toLocaleLowerCase().includes(normalizedGrantSearch)
  ));
  const sensitiveColumnCount = draft.schema.columns.filter((column) => (
    /(email|phone|address|review_text|customer|user_name|이메일|전화|주소|주민)/i.test(`${column.sourceName} ${column.targetName}`)
  )).length;
  const governanceChecks = [
    { icon: <Database size={18} />, label: "공유 범위", status: visibility === "외부 공유" ? "검토 필요" : "안전", value: visibility },
    { icon: <FileText size={18} />, label: "민감 데이터", status: sensitiveColumnCount > 0 ? "검토 필요" : "안전", value: sensitiveColumnCount > 0 ? `${sensitiveColumnCount}개 필드 감지` : "감지 없음" },
  ];

  return (
    <CreationFlowLayout
      variant="permission"
      actions={<CreationTopActions split onPrev={onPrev} onNext={goNext} />}
    >
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<ShieldCheck />}
        title="권한 설정"
      />
      {permissionActionError && <Alert className="mb-4" variant="destructive"><Info /><AlertTitle>권한 확인이 필요합니다.</AlertTitle><AlertDescription>{permissionActionError}</AlertDescription></Alert>}
      <div className="grid min-w-0 gap-4 pb-6" data-testid="permission-workflow">
        <Card className="min-w-0 overflow-hidden" size="none">
          <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
            <span className="etl-review-icon permission"><ShieldCheck size={17} /></span>
            <CardTitle>거버넌스 확인</CardTitle>
          </CardHeader>
          <CardContent className="grid min-w-0 gap-3 p-5 sm:grid-cols-2">
            {governanceChecks.map((item) => (
              <Card className="min-w-0" key={item.label} size="sm" variant="muted">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    {item.icon}
                    <div className="grid min-w-0 gap-1">
                      <span className="text-sm font-semibold text-slate-500">{item.label}</span>
                      <strong className="truncate text-sm text-slate-950" title={item.value}>{item.value}</strong>
                    </div>
                  </div>
                  <Badge
                    shape="compact"
                    size="sm"
                    variant={item.status === "안전" ? "success" : "warning"}
                  >
                    {item.status}
                  </Badge>
                </div>
              </Card>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden" size="none">
          <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
            <span className="etl-review-icon"><SlidersHorizontal size={17} /></span>
            <CardTitle>접근 정책</CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <FieldGroup className="grid min-w-0 gap-4 md:grid-cols-2">
              <ShadcnField>
                <FieldLabel htmlFor="permission-template">권한 템플릿</FieldLabel>
                <Select
                  disabled={!permissionOptions}
                  value={permissionTemplate}
                  onValueChange={(value) => {
                    const group = permissionOptions?.groups.find((candidate) => candidate.name === value);
                    if (!group) return;
                    const nextRoleChecks = { ...roleChecks, [group.id]: true };
                    setPermissionTemplate(group.name);
                    setRoleChecks(nextRoleChecks);
                    applyPermissionDraft({ permissionTemplate: group.name }, nextRoleChecks);
                  }}
                >
                  <SelectTrigger aria-label="권한 템플릿" id="permission-template" size="sm">
                    <SelectValue placeholder={permissionOptionsLoading ? "불러오는 중" : "템플릿 선택"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(permissionOptions?.groups ?? []).map((group) => <SelectItem key={group.id} value={group.name}>{group.name}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </ShadcnField>
              <ShadcnField>
                <FieldLabel htmlFor="permission-visibility">공개 범위</FieldLabel>
              <Select
                value={visibility}
                onValueChange={(value) => {
                  const nextVisibility = getKnownOption(value, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY);
                  setVisibility(nextVisibility);
                  applyPermissionDraft({ visibility: nextVisibility });
                }}
              >
                <SelectTrigger aria-label="공개 범위" id="permission-visibility" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {VISIBILITY_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              </ShadcnField>
              <ShadcnField>
                <FieldLabel htmlFor="permission-owner">데이터 오너</FieldLabel>
              <Input id="permission-owner" value={dataOwner} onChange={(event) => {
                const nextOwner = event.target.value;
                setDataOwner(nextOwner);
                applyPermissionDraft({ owner: nextOwner });
              }} />
              </ShadcnField>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden" size="none">
          <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
            <span className="etl-review-icon schema"><CircleUser size={17} /></span>
            <CardTitle>역할 및 사용자 권한</CardTitle>
          </CardHeader>
          <CardContent className="grid min-w-0 gap-4 p-5">
            {permissionOptionsLoading ? (
              <div className="grid gap-3" data-testid="permission-options-loading">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : permissionOptionsError ? (
              <Alert variant="destructive">
                <Info />
                <AlertTitle>권한 대상 API를 불러오지 못했습니다.</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>{permissionOptionsError}</span>
                  <Button size="sm" type="button" variant="outline" onClick={() => setPermissionOptionsRequest((value) => value + 1)}>
                    <RefreshCw data-icon="inline-start" />
                    다시 시도
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
            <Tabs
              className="grid min-w-0 gap-4"
              value={grantTab}
              onValueChange={(value) => {
                setGrantTab(value as PermissionGrantTab);
                setGrantSearch("");
              }}
            >
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <TabsList aria-label="권한 대상 유형">
                  <TabsTrigger value="roles">역할</TabsTrigger>
                  <TabsTrigger value="users">사용자</TabsTrigger>
                </TabsList>
                <InputGroup className="sm:max-w-80">
                  <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                  <InputGroupInput
                    aria-label={grantTab === "roles" ? "역할 검색" : "사용자 검색"}
                    placeholder={grantTab === "roles" ? "역할 검색" : "사용자 검색"}
                    value={grantSearch}
                    onChange={(event) => setGrantSearch(event.target.value)}
                  />
                </InputGroup>
              </div>
              <Separator />

              <TabsContent className="mt-0" value="roles">
                {filteredRoles.length > 0 ? (
                  <FieldSet className="gap-3">
                    <FieldLegend className="sr-only">역할 선택</FieldLegend>
                    {filteredRoles.map((role) => {
                      const selected = Boolean(roleChecks[role.id]);
                      const recommended = role.name === permissionTemplate;
                      const checkboxId = `permission-role-${role.id}`;
                      return (
                        <Card aria-selected={selected} key={role.id} size="sm" variant={selected ? "muted" : "default"}>
                          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                            <div className="flex min-w-0 items-start gap-3">
                              <Checkbox
                                checked={selected}
                                id={checkboxId}
                                onCheckedChange={(checked) => updateRoleCheck(role.id, checked === true)}
                              />
                              <label className="grid min-w-0 cursor-pointer gap-1" htmlFor={checkboxId}>
                                <span className="flex min-w-0 flex-wrap items-center gap-2">
                                  <strong className="truncate text-sm">{role.name}</strong>
                                  {recommended ? <Badge shape="compact" size="sm" variant="default">추천</Badge> : null}
                                </span>
                                <span className="text-sm text-slate-500">{role.description}</span>
                              </label>
                            </div>
                            <div className="flex flex-wrap gap-2 md:justify-end" aria-label={`${role.name} 권한`}>
                              {role.actions.map((action) => (
                                <Badge
                                  key={action}
                                  shape="compact"
                                  size="sm"
                                  variant={selected ? "default" : "outline"}
                                >
                                  {PERMISSION_ACTION_LABELS[action]}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </FieldSet>
                ) : (
                  <PermissionGrantEmpty query={grantSearch} />
                )}
              </TabsContent>

              <TabsContent className="mt-0" value="users">
                {filteredUsers.length > 0 ? (
                  <div className="grid gap-3">
                    {filteredUsers.map((user) => {
                      const selected = Boolean(userChecks[user.id]);
                      return (
                        <Card aria-selected={selected} key={user.id} size="sm" variant={selected ? "muted" : "default"}>
                          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 items-center gap-3">
                              <Avatar><AvatarFallback>{user.initials}</AvatarFallback></Avatar>
                              <div className="grid min-w-0 gap-1">
                                <strong className="truncate text-sm">{user.name}</strong>
                                <span className="truncate text-sm text-slate-500">{user.email} · {user.role}</span>
                              </div>
                            </div>
                            <Button
                              aria-pressed={selected}
                              size="sm"
                              type="button"
                              variant={selected ? "outline" : "subtle"}
                              onClick={() => updateUserCheck(user.id, !selected)}
                            >
                              {selected ? "제거" : "추가"}
                            </Button>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                ) : (
                  <PermissionGrantEmpty query={grantSearch} />
                )}
              </TabsContent>
            </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
    </CreationFlowLayout>
  );
}

function PermissionGrantEmpty({ query }: { query: string }) {
  return (
    <Empty className="py-10" size="sm" variant="plain">
      <EmptyIcon><Search aria-hidden="true" /></EmptyIcon>
      <EmptyHeader>
        <EmptyTitle>검색 결과가 없습니다.</EmptyTitle>
        <EmptyDescription>{query ? `“${query}”와 일치하는 권한 대상을 찾지 못했습니다.` : "표시할 권한 대상이 없습니다."}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewError, setReviewError] = useState("");
  const [reviewRetryCount, setReviewRetryCount] = useState(0);
  const reviewRequestKey = getReviewSnapshotRequestKey(buildReviewSnapshotRequest(draft));
  const reviewRequest = useMemo(
    () => JSON.parse(reviewRequestKey) as ReviewSnapshotRequest,
    [reviewRequestKey],
  );

  useEffect(() => {
    let cancelled = false;
    setReviewLoading(true);
    setReviewError("");
    setReviewSnapshot(null);
    void getReviewSnapshot(reviewRequest)
      .then((snapshot) => {
        if (!cancelled) setReviewSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReviewError(error instanceof Error ? error.message : "검토 정보를 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewRequest, reviewRetryCount]);

  const basicInformationRows = reviewSnapshot?.basicInformation ?? [];
  const destinationRows = reviewSnapshot?.destination ?? [];
  const permissionRows = reviewSnapshot?.permission ?? [];
  const schemaRows = reviewSnapshot?.schema ?? [];
  const validationRows = reviewSnapshot?.validation ?? [];
  const canCreate = reviewSnapshot?.canCreate === true;
  const createDisabled = createPending || reviewLoading || !canCreate;
  const createLabel = createPending
    ? "생성 중..."
    : reviewLoading
      ? "서버 확인 중..."
      : reviewError
        ? "검토 오류"
        : canCreate
          ? "파이프라인 생성"
          : "검증 필요";

  return (
    <CreationFlowLayout
      variant="review"
      actions={<CreationTopActions nextDisabled={createDisabled} nextLabel={createLabel} split onPrev={() => onEdit("target")} onNext={onCreate} />}
    >
        <EtlStepHeader
          className="etl-step-standalone-header"
          icon={<FileText />}
          title="검토 및 생성"
        />
        {reviewError ? (
          <Alert className="mx-0" variant="destructive">
            <AlertTitle>검토 정보를 불러오지 못했습니다.</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{reviewError}</span>
              <Button size="sm" type="button" variant="outline" onClick={() => setReviewRetryCount((count) => count + 1)}>
                <RefreshCw aria-hidden="true" data-icon="inline-start" /> 다시 시도
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="etl-review-stack">
          <section className="etl-review-card">
            <div className="etl-review-card-header">
              <span className="etl-review-icon"><FileText size={17} /></span>
              <div>
                <h2>기본 정보</h2>
              </div>
              <ReviewEditButton label="기본 정보 수정" onClick={() => onEdit("target")} />
            </div>
            <KeyValueList
              className="etl-review-kv"
              items={basicInformationRows.map(({ label, value }) => ({
                className: label === "설명" ? "wide" : undefined,
                label,
                value,
              }))}
            />
          </section>

          <section className="etl-review-card">
            <div className="etl-review-card-header">
              <span className="etl-review-icon schema"><Database size={17} /></span>
              <div>
                <h2>출력 스키마</h2>
              </div>
              <ReviewEditButton label="출력 스키마 수정" onClick={() => onEdit("schema")} />
            </div>
            <ReviewSchemaTable rows={schemaRows} />
          </section>

          <section className="etl-review-card">
            <div className="etl-review-card-header">
              <span className="etl-review-icon destination"><HardDrive size={17} /></span>
              <div>
                <h2>저장 위치 설정</h2>
              </div>
              <ReviewEditButton label="저장 위치 수정" onClick={() => onEdit("target")} />
            </div>
            <KeyValueList
              className="etl-review-kv destination"
              items={destinationRows.map(({ label, value }) => ({
                className: label === "저장 경로" ? "wide" : undefined,
                label,
                value,
              }))}
            />
          </section>

          <section className="etl-review-card">
            <div className="etl-review-card-header">
              <span className="etl-review-icon permission"><ShieldCheck size={17} /></span>
              <div>
                <h2>권한 및 검증</h2>
              </div>
              <ReviewEditButton label="권한 및 검증 수정" onClick={() => onEdit("permission")} />
            </div>
            <KeyValueList
              className="etl-review-kv permission"
              items={permissionRows.map(({ label, value }) => ({
                className: label === "요약" ? "wide" : undefined,
                label,
                value,
              }))}
            />
            <ValidationList
              className="etl-review-validation"
              items={validationRows.map(({ label, status, value }) => ({
                label,
                status,
                value,
              }))}
            />
          </section>
        </div>
    </CreationFlowLayout>
  );
}

function ReviewEditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={label} className="etl-review-edit" size="sm" type="button" variant="outline" onClick={onClick}>
      <Pencil aria-hidden="true" data-icon="inline-start" /> 수정
    </Button>
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
    <div aria-label="출력 스키마 표" className="review-schema-table-viewport" role="region" tabIndex={0}>
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
    </div>
  );
}

function displayReviewValue(value: string | undefined) {
  return value?.trim() || "미설정";
}

function summarizeSourceConfig(sourceConfig: Array<[string, string]>) {
  const priorityLabels = ["Source Dataset", "Source Dataset ID", "Storage Provider", "Endpoint URL", "Bucket / Stage Name", "Path / Prefix", "Path", "DATASET OR TABLE SELECTOR", "Broker / Endpoint"];
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

  return fields.find(([fieldLabel]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? sourceType;
}

function sourceConfigValue(fields: Array<[string, string]>, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

function hasSqlResultPreviewConfig(fields: Array<[string, string]>) {
  return Boolean(sourceConfigValue(fields, "Source Dataset") && sourceConfigValue(fields, "SQL Run ID") && sourceConfigValue(fields, "Query"));
}
