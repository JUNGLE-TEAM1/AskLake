import {
  Check,
  Database,
  FileText,
  HardDrive,
  Info,
  RefreshCw,
  Settings,
  ShieldCheck
} from "lucide-react";
import { type SourceConnectorAnalysis, type SourceConnectorDefaults } from "../../services/sourceConnectorService";
import type { DraftPipeline, SourceDraft } from "../../types";
import { sanitizeSourceConnectorFields } from "../../utils/sourceConnectorFields";


export const OBJECT_STORAGE_IS_AWS = String(import.meta.env.VITE_OBJECT_STORAGE_PROVIDER ?? "minio").trim().toLowerCase() === "aws";
export const OBJECT_STORAGE_PROVIDER_LABEL = OBJECT_STORAGE_IS_AWS ? "Amazon S3" : "MinIO";
export const OBJECT_STORAGE_REGION = String(import.meta.env.VITE_S3_REGION ?? (OBJECT_STORAGE_IS_AWS ? "ap-northeast-2" : "us-east-1"));
export const SPARK_OUTPUT_BUCKET = String(import.meta.env.VITE_SPARK_OUTPUT_BUCKET ?? "asklake-output")
  .trim()
  .replace(/^s3a?:\/\//i, "")
  .replace(/\/+.*$/, "") || "asklake-output";

export type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
export type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};
export type ScheduleOptionId = "skip" | "repeat";

export const FALLBACK_KAFKA_BROKER = import.meta.env.DEV ? "127.0.0.1:19092" : "";
export const FALLBACK_KAFKA_TOPIC = "asklake-source-events";
export const FALLBACK_SOURCE_DEFAULTS: SourceConnectorDefaults = {
  kafkaBroker: FALLBACK_KAFKA_BROKER,
  kafkaTopic: FALLBACK_KAFKA_TOPIC,
  s3Bucket: "",
  s3Prefix: "",
};

export function mergeFieldRows(baseFields: Array<[string, string]>, savedFields: Array<[string, string]>): Array<[string, string]> {
  const savedByLabel = new Map(savedFields);
  const mergedFields = baseFields.map(([label, value]) => [label, savedByLabel.get(label) ?? value] as [string, string]);
  const baseLabels = new Set(baseFields.map(([label]) => label));
  const extraSavedFields = savedFields.filter(([label]) => !baseLabels.has(label));
  return [...mergedFields, ...extraSavedFields];
}

export function normalizeSourceConnectorDefaults(defaults: Partial<SourceConnectorDefaults>): SourceConnectorDefaults {
  return {
    kafkaBroker: String(defaults.kafkaBroker ?? "").trim() || FALLBACK_KAFKA_BROKER,
    kafkaTopic: String(defaults.kafkaTopic ?? "").trim() || FALLBACK_KAFKA_TOPIC,
    s3Bucket: String(defaults.s3Bucket ?? "").trim(),
    s3Prefix: String(defaults.s3Prefix ?? "").trim(),
  };
}

export function mergeRuntimeSourceDefaults(
  sourceType: string,
  fields: Array<[string, string]>,
  defaults: SourceConnectorDefaults,
): Array<[string, string]> {
  const replacements = sourceType === "File / S3"
    ? new Map<string, { next: string; replaceable: Set<string>; }>([
      ["Bucket / Stage Name", { next: defaults.s3Bucket, replaceable: new Set([""]) }],
      ["Path / Prefix", { next: defaults.s3Prefix, replaceable: new Set([""]) }],
    ])
    : new Map<string, { next: string; replaceable: Set<string>; }>([
      ["Broker / Endpoint", { next: defaults.kafkaBroker, replaceable: new Set(["", FALLBACK_KAFKA_BROKER]) }],
      ["TOPIC / QUEUE NAME", { next: defaults.kafkaTopic, replaceable: new Set(["", FALLBACK_KAFKA_TOPIC]) }],
    ]);

  return fields.map(([label, value]) => {
    const replacement = replacements.get(label);
    if (!replacement?.next || !replacement.replaceable.has(value.trim())) return [label, value] as [string, string];
    return [label, replacement.next] as [string, string];
  });
}

export function sourceFieldRowsEqual(left: Array<[string, string]>, right: Array<[string, string]>): boolean {
  return left.length === right.length
    && left.every(([label, value], index) => label === right[index]?.[0] && value === right[index]?.[1]);
}

export function mergeConnectorSourceConfig(currentFields: Array<[string, string]>, responseFields: Array<[string, string]>): Array<[string, string]> {
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

export function mergeConnectorAnalysisSourceConfig(result: SourceConnectorAnalysis, currentFields: Array<[string, string]>): SourceConnectorAnalysis {
  const responseConfig = result.draftPatch.source?.sourceConfig;
  if (!responseConfig) return result;
  const sourceType = result.draftPatch.source?.sourceType ?? "";
  return {
    ...result,
    draftPatch: {
      ...result.draftPatch,
      source: {
        ...result.draftPatch.source,
        sourceConfig: sanitizeSourceConnectorFields(sourceType, mergeConnectorSourceConfig(currentFields, responseConfig)),
      },
    },
  };
}

export function patchConnectorAnalysisSourceConfig(
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

export const sourceTypeLabels: Record<string, string> = {
  Database: "PostgreSQL",
  "Data Lake": "데이터 레이크",
  "File / S3": "파일 / MinIO",
  MongoDB: "MongoDB",
  PostgreSQL: "PostgreSQL",
  "REST API": "REST API",
  "SQL Result": "SQL Result",
  "Stream / Kafka": "스트림 / Kafka",
};

export const sourceFieldLabels: Record<string, string> = {
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

export const sourceColumnLabels: Record<string, string> = {
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

export const sourceValueLabels: Record<string, string> = {
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

export function sourceTypeLabel(value: string) {
  return sourceTypeLabels[value] ?? value;
}

export function sourceFieldLabel(value: string) {
  return sourceFieldLabels[value] ?? value;
}

export function sourceColumnLabel(value: string) {
  return sourceColumnLabels[value] ?? value;
}

export function sourceValueLabel(value: string) {
  if (/^leader \d+$/i.test(value)) return value.replace(/^leader/i, "리더");
  if (/^\d+ bytes$/i.test(value)) return value.replace("bytes", "바이트");
  return sourceValueLabels[value] ?? value;
}

export function isInternalSourceField(label: string) {
  return label.startsWith("__");
}

export function isCredentialSourceField(label: string) {
  return /(access key|secret key|password|auth token|token|private key)/i.test(label);
}

export function shouldPreserveCredentialValue(value: string) {
  const normalized = String(value ?? "").trim();
  return !normalized || /^[*•]+$/.test(normalized) || normalized.toLowerCase() === "redacted";
}

export function publicSourceLog(value: string) {
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

export function publicSchemaSummary(value: string) {
  return value
    .replace(/^MinIO\/S3 reachable\s*-\s*schema inference pending\s*\((\d+)\s*objects?\)$/i, "MinIO/S3 연결 성공 · 스키마 추론 대기 (오브젝트 $1개)")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function publicConnectorAnalysis(result: SourceConnectorAnalysis): SourceConnectorAnalysis {
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

export function getInitialSourceStage(draft: DraftPipeline): "choose" | "connect" | "browse" {
  if (!draft.source.sourceType) return "choose";
  if (draft.source.sourceType === "Data Lake") return "browse";
  return "connect";
}
export function sourceFormatFromConfig(fields: Array<[string, string]>) {
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

export function mergeSourceAssets(currentAssets: Array<[string, string, string]>, nextAssets: Array<[string, string, string]>) {
  const merged = new Map<string, [string, string, string]>();
  [...currentAssets, ...nextAssets].forEach(([path, meta, status]) => {
    merged.set(path, [path, meta, status]);
  });
  return Array.from(merged.values());
}

export function normalizeFolderPrefix(path: string) {
  const cleanPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return cleanPath ? `${cleanPath}/` : "";
}

export function formatSourceBytes(totalBytes: number) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(totalBytes) / Math.log(1024)), units.length - 1);
  const value = totalBytes / (1024 ** unitIndex);
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function upsertSourceFields(fields: Array<[string, string]>, patches: Array<[string, string]>) {
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

export function sourceStatusIcon(status: SourceDraft["connectionStatus"]) {
  if (status === "success") return <Check size={18} />;
  if (status === "testing") return <RefreshCw size={18} />;
  if (status === "failed") return <Info size={18} />;
  return <Settings size={18} />;
}

export function isVisibleSourceField(sourceType: string, label: string) {
  if (isInternalSourceField(label)) return false;
  if (sourceType === "File / S3") {
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

export function requiredSourceConnectionFields(sourceType: string) {
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

export type SourceExplorerConfig = {
  filterMode: "extension" | "meta" | "none";
  filterOptions: Array<{ label: string; value: string; }>;
  pathPlaceholder: string;
  previewTitle: string;
  queryPlaceholder: string;
  supportsPathSearch: boolean;
};

export function sourceExplorerConfig(sourceType: string, assets: Array<[string, string, string]>): SourceExplorerConfig {
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

export function sourceAssetMatchesExplorer(
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

export function isSecretSourceField(label: string) {
  return ["Access Key", "Password / Auth Token", "Secret Key", "Token / Secret"].includes(label);
}

export function sourceCheckIcon(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("endpoint") || normalized.includes("broker") || normalized.includes("lake")) return <HardDrive size={14} />;
  if (normalized.includes("bucket") || normalized.includes("database") || normalized.includes("table") || normalized.includes("collection") || normalized.includes("topic")) return <Database size={14} />;
  if (normalized.includes("auth") || normalized.includes("access")) return <ShieldCheck size={14} />;
  if (normalized.includes("sample") || normalized.includes("response") || normalized.includes("message") || normalized.includes("metadata")) return <FileText size={14} />;
  return <Settings size={14} />;
}

export function sourceCheckState(value: string) {
  const normalized = value.toLowerCase();
  if (/(ok|success|reachable|verified|fetched|listed|ready|skipped|완료|성공|가능|생략)/.test(normalized)) return "success";
  if (/(fail|error|denied|실패|오류)/.test(normalized)) return "failed";
  if (/(pending|required|not tested|대기|필요|미확인)/.test(normalized)) return "idle";
  return "idle";
}

export function displayReviewValue(value: string | undefined) {
  return value?.trim() || "미설정";
}

export function summarizeSourceConfig(sourceConfig: Array<[string, string]>) {
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

export function sourceLabelFromFields(sourceType: string, fields: Array<[string, string]>) {
  const valuesByLabel = new Map(fields);
  if (sourceType === "File / S3") {
    const bucket = valuesByLabel.get("Bucket / Stage Name");
    const prefix = valuesByLabel.get("Path / Prefix");
    if (bucket && prefix) return `${bucket}/${prefix}`;
    if (bucket) return bucket;
  }

  return fields.find(([fieldLabel]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? sourceType;
}

export function sourceConfigValue(fields: Array<[string, string]>, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

export function hasSqlResultPreviewConfig(fields: Array<[string, string]>) {
  return Boolean(sourceConfigValue(fields, "Source Dataset") && sourceConfigValue(fields, "SQL Run ID") && sourceConfigValue(fields, "Query"));
}

export const SOURCE_CONNECTION_STATUS_COPY: Record<SourceDraft["connectionStatus"], { badge: string; title: string; }> = {
  failed: { badge: "확인 실패", title: "연결 실패" },
  idle: { badge: "테스트 필요", title: "연결 검증 필요" },
  success: { badge: "탐색 가능", title: "연결 검증 완료" },
  testing: { badge: "테스트 중", title: "연결 테스트 실행 중" },
};
