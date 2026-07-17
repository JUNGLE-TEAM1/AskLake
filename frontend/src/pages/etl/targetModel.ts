import type { DraftPipeline, DraftPipelinePatch, PermissionAction, PermissionGrant, PermissionOptionsResponse, SchemaColumnDraft, TargetLayer } from "../../types";

import {
  sourceConfigValue,
  SPARK_OUTPUT_BUCKET
} from "./sourceModel";

export const DEFAULT_PERMISSION_TEMPLATE = "Data Engineer Group";
export const DEFAULT_VISIBILITY = "조직 내부";
export const DEFAULT_OWNER = "data-team-01";
export const DEFAULT_TARGET_DATASET = "customer_review_gold";
export const DEFAULT_TARGET_LAYER: TargetLayer = "GOLD";
export const DEFAULT_TARGET_FORMAT: TargetFileFormat = "parquet";
export const DEFAULT_TARGET_TAGS: string[] = [];
export const LEGACY_TARGET_TAG_OPTIONS = ["마케팅용", "고객데이터", "고객 데이터", "분석용", "서비스용", "서비스 제공용", "원본", "원본 데이터", "가공됨", "가공 데이터", "운영 데이터", "개인정보 포함"];

export const VISIBILITY_OPTIONS = ["조직 내부", "프로젝트 멤버", "외부 공유"] as const;
export const TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER", "GOLD"];
export const KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS: TargetLayer[] = ["RAW", "BRONZE", "SILVER"];
export const TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["parquet", "csv", "json", "jsonl"];
export const KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["jsonl"];
export const KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS: TargetFileFormat[] = ["parquet"];

export const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  delete: "삭제",
  manage: "관리",
  query: "쿼리 실행",
  run: "실행",
  share: "공유",
  view: "조회",
};

export type PermissionGrantTab = "groups" | "users";
export type PermissionPresetId = "view" | "run" | "manage" | "custom";

export const PERMISSION_ACTION_ORDER: PermissionAction[] = ["view", "query", "run", "manage", "share", "delete"];
export const PERMISSION_PRESETS: Array<{
  actions: PermissionAction[];
  id: PermissionPresetId;
  label: string;
}> = [
    { actions: ["view"], id: "view", label: "조회 전용" },
    { actions: ["view", "run"], id: "run", label: "실행 가능" },
    { actions: ["view", "run", "manage"], id: "manage", label: "운영 가능" },
    { actions: [], id: "custom", label: "직접 설정" },
  ];

export type PermissionDraftSlice = {
  grants?: DraftPipeline["permission"]["grants"];
  owner?: string;
  permissionSummary?: string;
  permissionTemplate?: string;
  roles?: Array<{ access: string[]; checked: boolean; name: string; }>;
  summary?: string;
  template?: string;
  visibility?: string;
};

export type TargetDraftSlice = {
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

export type TargetFileFormat = "parquet" | "csv" | "json" | "jsonl";
export type TargetTestStatus = "idle" | "pending" | "success" | "failed";
export type TargetColumnType = "string" | "number" | "boolean" | "datetime" | "json";

export type TargetSchemaRule = {
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

export type TargetTestRun = {
  finishedAt?: string;
  logs: string[];
  message?: string;
  status: TargetTestStatus;
};

export type TargetMetadata = {
  databaseName: string;
  datasetName: string;
  description: string;
  fileFormat: TargetFileFormat;
  manager: string;
  owner: string;
  storagePath: string;
  targetTableName: string;
};

export type TargetSavedConfig = {
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

export type ReviewSchemaRow = {
  columnName: string;
  nullable: string;
  transform: string;
  type: string;
};

export type DraftPipelineWithSlices = DraftPipeline & {
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

export function getDisplayText(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function getKnownOption<T extends string>(value: string | undefined, options: readonly T[], fallback: T): T {
  const trimmed = value?.trim();
  return options.find((option) => option === trimmed) ?? fallback;
}

export function normalizeTargetLayer(value: string | undefined): TargetLayer {
  return getKnownOption(value?.toUpperCase(), TARGET_LAYER_OPTIONS, DEFAULT_TARGET_LAYER);
}

export function buildTargetStoragePathForBucket(bucket: string, targetDataset: string, targetLayer: TargetLayer) {
  return `s3a://${bucket}/${targetDataset}/${targetLayer.toLowerCase()}/`;
}

export function buildTargetStoragePath(targetDataset: string, targetLayer: TargetLayer) {
  return buildTargetStoragePathForBucket(SPARK_OUTPUT_BUCKET, targetDataset, targetLayer);
}

export function isManagedTargetStoragePath(value: string, targetDataset: string, targetLayer: TargetLayer) {
  return value === buildTargetStoragePath(targetDataset, targetLayer)
    || value === buildTargetStoragePathForBucket("asklake-output", targetDataset, targetLayer);
}

export function normalizeKafkaDatasetName(topic: string) {
  const normalized = topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "kafka_events";
}

export function isDefaultTargetDataset(value: string | undefined) {
  return !value?.trim() || value.trim() === DEFAULT_TARGET_DATASET;
}

export function isDefaultTargetStoragePath(value: string | undefined) {
  return !value?.trim() || value.trim() === buildTargetStoragePath(DEFAULT_TARGET_DATASET, DEFAULT_TARGET_LAYER);
}

export function isLegacyKafkaLandingPath(value: string | undefined) {
  return Boolean(value?.includes("kafka-landing/"));
}

export function isDefaultTargetDescription(value: string | undefined) {
  return !value?.trim() || value.trim() === "고객 리뷰 분석용 정제 데이터셋";
}

export const TARGET_CONFIG_STORAGE_KEY = "asklake.targetConfigDraft";
export const TARGET_FILE_FORMAT_VALUES: TargetFileFormat[] = ["parquet", "csv", "json", "jsonl"];
export const SAMPLE_TARGET_SCHEMA_COLUMNS: SchemaColumnDraft[] = [
  { included: true, nullable: false, sourceName: "order_date", targetName: "order_date", type: "date" },
  { included: true, nullable: false, sourceName: "order_count", targetName: "order_count", type: "integer" },
  { included: true, nullable: false, sourceName: "gross_sales", targetName: "gross_sales", type: "decimal" },
  { included: true, nullable: false, sourceName: "updated_at", targetName: "updated_at", type: "timestamp" },
];
export const SAMPLE_TARGET_ROWS = [
  ["2026-07-07", "128", "10200.50", "2026-07-07T09:30:00Z"],
  ["2026-07-08", "96", "15700.00", "2026-07-08T09:30:00Z"],
  ["2026-07-09", "141", "99900.25", "2026-07-09T09:30:00Z"],
];

export function normalizeTargetFileFormat(value: string | undefined): TargetFileFormat {
  const normalized = value?.trim().toLowerCase();
  return TARGET_FILE_FORMAT_VALUES.find((format) => format === normalized) ?? "parquet";
}

export function filterVisibleTargetTags(tags: string[] | undefined) {
  return (tags ?? []).filter((tag) => !LEGACY_TARGET_TAG_OPTIONS.includes(tag));
}

export function isRecommendedPartitionColumn(columnName: string, columnType = "") {
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

export function isRecommendedIndexColumn(columnName: string) {
  return /^(id|user_id|customer_id|product_id|order_id|review_id|account_id)$/i.test(columnName);
}

export function normalizeTargetColumnType(value: string): TargetColumnType {
  const normalized = value.toLowerCase();
  if (normalized.includes("int") || normalized.includes("float") || normalized.includes("double") || normalized.includes("decimal") || normalized === "number") return "number";
  if (normalized.includes("bool")) return "boolean";
  if (normalized.includes("date") || normalized.includes("time")) return "datetime";
  if (normalized.includes("json") || normalized.includes("object") || normalized.includes("array")) return "json";
  return "string";
}

export function inferJsonValueType(value: unknown): TargetColumnType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|\s)?/.test(value)) return "datetime";
  return "string";
}

export function mergeTargetColumnType(previous: TargetColumnType | undefined, next: TargetColumnType): TargetColumnType {
  if (!previous || previous === next) return next;
  if (previous === "json" || next === "json") return "json";
  return "string";
}

export function flattenJsonObject(value: unknown, prefix: string, output: Record<string, unknown>) {
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

export function stringifyPreviewValue(value: unknown) {
  if (value === null || typeof value === "undefined") return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function inferTargetSchema(columns: SchemaColumnDraft[], rows: string[][], existingRules: TargetSchemaRule[] | undefined) {
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

export function formatPartitionColumnType(rule: TargetSchemaRule) {
  const displayType = rule.displayType?.trim().toLowerCase();
  if (displayType) return displayType;
  if (rule.type === "datetime") return rule.name.toLowerCase().endsWith("_date") ? "date" : "timestamp";
  return rule.type;
}

export function validateTargetConfig(config: TargetSavedConfig, jsonParseFailed: boolean) {
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
export function buildJobName(targetDataset: string) {
  return `${getDisplayText(targetDataset, DEFAULT_TARGET_DATASET)}_pipeline`;
}

export function buildPermissionSummary(permissionTemplate: string, visibility: string) {
  return `${permissionTemplate} · ${visibility}`;
}

export function parsePermissionSummary(summary: string | undefined) {
  const [template, visibility] = (summary ?? "").split(/[·/]/).map((part) => part.trim()).filter(Boolean);

  return {
    permissionTemplate: template || DEFAULT_PERMISSION_TEMPLATE,
    visibility: getKnownOption(visibility, VISIBILITY_OPTIONS, DEFAULT_VISIBILITY),
  };
}

export function getPermissionDraftValues(draft: DraftPipeline) {
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

export function normalizePermissionActions(actions: PermissionAction[] | undefined) {
  const selected = new Set(actions ?? []);
  selected.add("view");
  return PERMISSION_ACTION_ORDER.filter((action) => selected.has(action));
}

export function permissionGrantKey(grant: Pick<PermissionGrant, "principalId" | "principalType">) {
  return `${grant.principalType}:${grant.principalId}`;
}

export function permissionActionsMatch(left: PermissionAction[], right: PermissionAction[]) {
  const normalizedLeft = normalizePermissionActions(left);
  const normalizedRight = normalizePermissionActions(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((action, index) => action === normalizedRight[index]);
}

export function inferPermissionPreset(grants: PermissionGrant[]): PermissionPresetId {
  if (grants.length === 0) return "custom";
  const preset = PERMISSION_PRESETS.find((candidate) => (
    candidate.id !== "custom"
    && grants.every((grant) => permissionActionsMatch(grant.actions, candidate.actions))
  ));
  return preset?.id ?? "custom";
}

export function permissionPresetActions(presetId: PermissionPresetId) {
  return PERMISSION_PRESETS.find((preset) => preset.id === presetId)?.actions ?? [];
}

export function buildPermissionDraftPatch({
  grants,
  options,
  owner,
  preset,
  publicView,
}: {
  grants: PermissionGrant[];
  options: PermissionOptionsResponse;
  owner: string;
  preset: PermissionPresetId;
  publicView: boolean;
}): DraftPipelinePatch {
  const normalizedOwner = getDisplayText(owner, DEFAULT_OWNER);
  const selectedGrants = grants
    .filter((grant) => grant.principalType !== "public")
    .map((grant) => {
      const principalName = grant.principalType === "group"
        ? options.groups.find((group) => group.id === grant.principalId)?.name
        : grant.principalType === "user"
          ? options.users.find((user) => user.id === grant.principalId)?.name
          : grant.principalName;
      return {
        actions: normalizePermissionActions(grant.actions),
        principalId: grant.principalId,
        principalName: principalName ?? grant.principalId,
        principalType: grant.principalType,
        source: "permission_ui",
      };
    });
  const permissionGrants: PermissionGrant[] = [
    ...selectedGrants,
    ...(publicView ? [{
      actions: ["view"] as PermissionAction[],
      principalId: "public",
      principalName: "로그인한 모든 사용자",
      principalType: "public" as const,
      source: "permission_ui",
    }] : []),
  ];
  const selectedGrantKeys = new Set(selectedGrants.map(permissionGrantKey));
  const permissionRoles = options.groups.map((group) => ({
    access: normalizePermissionActions(
      selectedGrants.find((grant) => permissionGrantKey(grant) === `group:${group.id}`)?.actions ?? group.actions,
    ).map((action) => PERMISSION_ACTION_LABELS[action]),
    checked: selectedGrantKeys.has(`group:${group.id}`),
    name: group.name,
  }));
  const presetLabel = PERMISSION_PRESETS.find((candidate) => candidate.id === preset)?.label ?? "직접 설정";
  const visibility = publicView ? "외부 공유" : "조직 내부";
  const permissionSummary = `담당자 + ${selectedGrants.length}개 대상 · ${publicView ? "모든 사용자 조회 허용" : "지정 대상만 조회"}`;

  return {
    owner: normalizedOwner,
    permissionGrants,
    permissionRoles,
    permission: {
      grants: permissionGrants,
      owner: normalizedOwner,
      roles: permissionRoles,
      summary: permissionSummary,
      template: presetLabel,
      visibility,
    },
    permissionSummary,
  };
}

export function getTargetDraftValues(draft: DraftPipeline) {
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
