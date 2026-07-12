import type {
  CatalogDataset,
  DerivedDatasetLayer,
  ScheduleOverlapPolicy,
  SqlResultDraft,
} from "../../types";
import type { WizardSelectOption } from "./SqlJobWizardFields";

export type SqlJobWizardScheduleMode = "manual" | "daily" | "weekly";
export type SqlJobWizardAccessScope = "organization" | "private" | "project";
export type SqlJobWizardCompression = "Gzip" | "None" | "Snappy";
export type SqlJobWizardFileFormat = "csv" | "json" | "parquet";
export type SqlJobWizardWeekday = "금" | "목" | "수" | "월" | "일" | "토" | "화";
export type SqlJobWizardStepId = "dataset" | "governance" | "review" | "schedule";

export type SqlJobWizardDatasetInfo = {
  description: string;
  layer: DerivedDatasetLayer;
  name: string;
};

export type SqlJobWizardSchedule = {
  mode: SqlJobWizardScheduleMode;
  overlapPolicy: ScheduleOverlapPolicy;
  time: string;
  timezone: string;
  weekday: SqlJobWizardWeekday;
};

export type SqlJobWizardGovernance = {
  accessScope: SqlJobWizardAccessScope;
  owner: string;
  permissionSummary: string;
};

export type SqlJobWizardTarget = {
  compression: SqlJobWizardCompression;
  databaseName: string;
  fileFormat: SqlJobWizardFileFormat;
  partitionColumns: string[];
  storagePath: string;
  tags: string[];
};

export type SqlJobWizardConfiguration = {
  dataset: SqlJobWizardDatasetInfo;
  governance: SqlJobWizardGovernance;
  schedule: SqlJobWizardSchedule;
  target: SqlJobWizardTarget;
};

export type SqlJobWizardSourceContext = {
  baseDatasetId: string;
  baseDatasetName: string;
  columns: string[];
  previewLimit?: number;
  query: string;
  referenceDatasetIds: string[];
  resultDatasetId: string;
  resultDatasetName: string;
  rowCount: number;
  rows: string[][];
  sourceRunId: string;
  validationKey?: string;
};

export type SqlJobWizardCreateRequest = {
  configuration: SqlJobWizardConfiguration;
  context: SqlJobWizardSourceContext;
};

export type SqlJobWizardDefaultMetadata = Partial<SqlJobWizardDatasetInfo>;
export type SqlJobWizardBaseDataset = Pick<CatalogDataset, "id" | "name" | "owner" | "schema">;

export type SqlJobWizardPartitionOption = {
  name: string;
  type: string;
};

export const accessScopeLabels: Record<SqlJobWizardAccessScope, string> = {
  organization: "조직 내부",
  private: "소유자 전용",
  project: "프로젝트 멤버",
};

const overlapPolicyLabels: Record<ScheduleOverlapPolicy, string> = {
  allow_parallel: "겹쳐도 새 Run 시작",
  queue_after_current: "현재 Run 종료 후 실행",
  skip_if_running: "실행 중이면 다음 예약 건너뜀",
};

const weekdays: SqlJobWizardWeekday[] = ["월", "화", "수", "목", "금", "토", "일"];
const timezones = ["Asia/Seoul", "UTC", "America/New_York", "Europe/London"];

export const weekdaySelectOptions: Array<WizardSelectOption<SqlJobWizardWeekday>> = weekdays.map((day) => ({
  label: `${day}요일`,
  value: day,
}));

export const timezoneSelectOptions: Array<WizardSelectOption<string>> = timezones.map((timezone) => ({
  label: timezone,
  value: timezone,
}));

export const overlapPolicyOptions: Array<WizardSelectOption<ScheduleOverlapPolicy>> = [
  { label: overlapPolicyLabels.allow_parallel, value: "allow_parallel" },
  { label: overlapPolicyLabels.queue_after_current, value: "queue_after_current" },
  { label: overlapPolicyLabels.skip_if_running, value: "skip_if_running" },
];

export const accessScopeOptions: Array<WizardSelectOption<SqlJobWizardAccessScope>> = [
  { label: accessScopeLabels.organization, value: "organization" },
  { label: accessScopeLabels.project, value: "project" },
  { label: accessScopeLabels.private, value: "private" },
];

export const compressionOptions: Array<WizardSelectOption<SqlJobWizardCompression>> = [
  { label: "Snappy", value: "Snappy" },
  { label: "Gzip", value: "Gzip" },
  { label: "압축 없음", value: "None" },
];

export const fileFormatOptions: Array<WizardSelectOption<SqlJobWizardFileFormat>> = [
  { label: "PARQUET", value: "parquet" },
  { label: "CSV", value: "csv" },
  { label: "JSON", value: "json" },
];

function normalizePathSegment(value: string) {
  return value.trim().replace(/\s+/g, "_") || "sql_result";
}

export function buildDefaultStoragePath(dataset: SqlJobWizardDatasetInfo) {
  return `s3a://asklake-output/${normalizePathSegment(dataset.name)}/${dataset.layer.toLowerCase()}/`;
}

function findDefaultPartitionColumn(columns: string[]) {
  return columns.find((column) => /(date|time|month|year|created_at|updated_at)$/i.test(column)) ?? "";
}

function inferPreviewColumnType(values: string[]) {
  const populatedValues = values.map((value) => value.trim()).filter(Boolean);
  if (populatedValues.length === 0) return "string";
  if (populatedValues.every((value) => /^-?\d+$/.test(value))) return "integer";
  if (populatedValues.every((value) => /^-?(?:\d+\.?\d*|\d*\.\d+)$/.test(value))) return "decimal";
  if (populatedValues.every((value) => /^(?:true|false)$/i.test(value))) return "boolean";
  if (populatedValues.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return "date";
  if (populatedValues.every((value) => /^\d{4}-\d{2}-\d{2}[T\s]/.test(value))) return "timestamp";
  return "string";
}

export function buildSqlJobPartitionOptions(
  baseDataset: SqlJobWizardBaseDataset,
  resultDraft: SqlResultDraft,
): SqlJobWizardPartitionOption[] {
  const schemaTypes = new Map(baseDataset.schema.map(([name, type]) => [name.toLowerCase(), type]));
  return resultDraft.columns.map((name, columnIndex) => ({
    name,
    type: schemaTypes.get(name.toLowerCase())
      ?? inferPreviewColumnType(resultDraft.rows.map((row) => row[columnIndex] ?? "")),
  }));
}

export function buildPermissionSummary(accessScope: SqlJobWizardAccessScope) {
  return `Data Engineer Group · ${accessScopeLabels[accessScope]} · 승인 검토`;
}

export function buildInitialSqlJobConfiguration(
  baseDataset: SqlJobWizardBaseDataset,
  resultDraft: SqlResultDraft,
  defaults?: SqlJobWizardDefaultMetadata,
): SqlJobWizardConfiguration {
  const dataset: SqlJobWizardDatasetInfo = {
    description: defaults?.description ?? `${baseDataset.name} SQL 결과로 생성한 분석 데이터셋`,
    layer: defaults?.layer ?? "GOLD",
    name: defaults?.name ?? `${baseDataset.name}_analysis`,
  };
  const accessScope: SqlJobWizardAccessScope = "organization";

  return {
    dataset,
    governance: {
      accessScope,
      owner: baseDataset.owner || "data-team-01",
      permissionSummary: buildPermissionSummary(accessScope),
    },
    schedule: {
      mode: "manual",
      overlapPolicy: "skip_if_running",
      time: "09:00",
      timezone: "Asia/Seoul",
      weekday: "월",
    },
    target: {
      compression: "Snappy",
      databaseName: "asklake",
      fileFormat: "parquet",
      partitionColumns: [findDefaultPartitionColumn(resultDraft.columns)].filter(Boolean),
      storagePath: buildDefaultStoragePath(dataset),
      tags: [],
    },
  };
}

export function formatSqlJobWizardScheduleLabel(schedule: SqlJobWizardSchedule) {
  if (schedule.mode === "manual") return "스케줄링 건너뛰기";
  if (schedule.mode === "daily") return `매일 ${schedule.time}`;
  return `매주 ${schedule.weekday}요일 ${schedule.time}`;
}

export function formatSqlJobWizardScheduleSummary(schedule: SqlJobWizardSchedule) {
  if (schedule.mode === "manual") return "스케줄링 건너뛰기 · Job 목록에서 직접 실행";
  return `반복 실행 · ${formatSqlJobWizardScheduleLabel(schedule)} · ${schedule.timezone} · ${overlapPolicyLabels[schedule.overlapPolicy]}`;
}

function isValidTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validateSqlJobStep(step: SqlJobWizardStepId, configuration: SqlJobWizardConfiguration) {
  const errors: string[] = [];
  if (step === "dataset") {
    if (!configuration.dataset.name.trim()) errors.push("데이터셋 이름을 입력해 주세요.");
    if (!configuration.dataset.description.trim()) errors.push("데이터셋 설명을 입력해 주세요.");
  }
  if (step === "schedule" && configuration.schedule.mode !== "manual") {
    if (!isValidTime(configuration.schedule.time)) errors.push("실행 시간을 HH:mm 형식으로 입력해 주세요.");
    if (!configuration.schedule.timezone.trim()) errors.push("시간대를 선택해 주세요.");
  }
  if (step === "governance") {
    if (!configuration.governance.owner.trim()) errors.push("데이터 오너를 입력해 주세요.");
    if (!configuration.governance.permissionSummary.trim()) errors.push("권한 정책 요약을 입력해 주세요.");
  }
  if (step === "review") {
    if (!configuration.target.storagePath.trim()) errors.push("저장 경로를 입력해 주세요.");
    if (configuration.target.storagePath && !/^s3a?:\/\//i.test(configuration.target.storagePath)) {
      errors.push("저장 경로는 s3:// 또는 s3a:// 형식이어야 합니다.");
    }
  }
  return errors;
}

export function createSqlJobRequest(
  baseDataset: SqlJobWizardBaseDataset,
  resultDraft: SqlResultDraft,
  configuration: SqlJobWizardConfiguration,
): SqlJobWizardCreateRequest {
  return {
    configuration,
    context: {
      baseDatasetId: baseDataset.id,
      baseDatasetName: baseDataset.name,
      columns: [...resultDraft.columns],
      previewLimit: resultDraft.previewLimit,
      query: resultDraft.query,
      referenceDatasetIds: [...(resultDraft.referenceDatasetIds ?? [])],
      resultDatasetId: resultDraft.datasetId,
      resultDatasetName: resultDraft.datasetName,
      rowCount: resultDraft.rowCount,
      rows: resultDraft.rows.map((row) => [...row]),
      sourceRunId: resultDraft.runId,
      validationKey: resultDraft.validationKey,
    },
  };
}
