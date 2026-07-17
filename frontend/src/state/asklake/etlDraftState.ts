

import { hydrateEtlDraft, serializeEtlDraft } from "../../services/draftPipelineContract";

import type { DraftPipeline } from "../../types";

export const etlDraftStorageKey = "asklake.etlDraft.v1";

export function loadStoredEtlDraft(fallback: DraftPipeline) {
  if (typeof window === "undefined") return hydrateEtlDraft(null, fallback);
  try {
    return hydrateEtlDraft(window.localStorage.getItem(etlDraftStorageKey), fallback);
  } catch {
    return hydrateEtlDraft(null, fallback);
  }
}

export function saveStoredEtlDraft(draft: DraftPipeline) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(etlDraftStorageKey, serializeEtlDraft(draft));
  } catch {
    // Browser storage is an optional draft recovery cache, never the durable source of truth.
  }
}

export function normalizeInitialDraftPipeline(draft: DraftPipeline): DraftPipeline {
  return {
    ...draft,
    id: "",
    permission: {
      ...draft.permission,
      summary: "기본 소유자만 설정되었습니다.",
    },
    quality: {
      ...draft.quality,
      invalidRows: [],
      rules: [],
      score: undefined,
      status: "idle",
      summary: "데이터 품질 규칙을 설정하세요.",
    },
    recordParsing: {
      columns: [],
      delimiterKind: "whitespace",
      delimiterPattern: "\\s+",
      enabled: false,
      expectedFieldCount: 0,
      header: false,
    },
    schedule: {
      ...draft.schedule,
      endDate: "",
      label: "수동 실행",
      mode: "manual",
      nextRun: "-",
      nextRunUtc: undefined,
      overlapPolicy: "skip_if_running",
      startDate: "",
      summary: "수동 실행 · 저장 후 목록에서 직접 실행",
      timezone: "(GMT+09:00) Seoul, Tokyo",
      watermarkPolicy: {
        column: "updated_at",
        enabled: false,
        lookbackMinutes: 5,
        mode: "full_refresh",
      },
    },
    schema: {
      ...draft.schema,
      columns: [],
      sampleRows: [],
      summary: "스키마 추론 대기",
    },
    source: {
      ...draft.source,
      connectionMessage: "소스를 선택하고 연결 테스트를 실행하세요.",
      connectionStatus: "idle",
      sourceConfig: [],
      sourceLabel: "",
      sourceType: "",
    },
    target: {
      ...draft.target,
      datasetName: "",
      description: "",
      partition: "",
      partitionColumns: [],
      rag: false,
      storagePath: "",
      tableName: "",
      tags: [],
      testStatus: "idle",
    },
    transform: {
      ...draft.transform,
      outputColumns: [],
      steps: [],
      summary: "변환 규칙을 설정하세요.",
    },
  };
}

export const baseInitialDraftPipeline: DraftPipeline = normalizeInitialDraftPipeline({
  id: "pair_a_customer_review_gold",
  permission: {
    owner: "data-team-01",
    roles: [],
    summary: "Data Engineer Group · 조직 기본 권한",
  },
  quality: {
    invalidRows: [],
    rules: [],
    score: 94.2,
    status: "pass",
    summary: "품질 규칙 5개 · 유효하지 않은 행 격리",
  },
  recordParsing: {
    columns: [],
    delimiterKind: "whitespace",
    delimiterPattern: "\\s+",
    enabled: false,
    expectedFieldCount: 0,
    header: false,
  },
  schedule: {
    endDate: "",
    label: "매주 목요일 10:30",
    mode: "repeat",
    nextRun: "다음 예약 대기",
    retryPolicy: {
      backoffMultiplier: 2,
      backoffStrategy: "exponential",
      failureAction: "retry_then_fail",
      initialRetryDelayMinutes: 1,
      maxRetries: 3,
      maxRetryDelayMinutes: 30,
      retryIntervalMinutes: 10,
      timeoutMinutes: 60,
    },
    startDate: "2026-07-02",
    summary: "매주 목요일 10:30 · 시작 2026.07.02 · 종료일 없음 · (GMT+09:00) Seoul, Tokyo",
    timezone: "(GMT+09:00) Seoul, Tokyo",
  },
  schema: {
    columns: [],
    sampleRows: [],
    summary: "스키마 추론 대기",
  },
  source: {
    connectionMessage: "검토 전에 소스 연결 테스트가 필요합니다.",
    connectionStatus: "idle",
    sourceConfig: [],
    sourceLabel: "",
    sourceType: "",
  },
  target: {
    compression: "Snappy",
    datasetName: "pair_a_customer_review_gold",
    description: "고객 리뷰 분석용 정제 데이터셋",
    format: "Parquet",
    layer: "GOLD",
    partition: "date/category",
    partitionColumns: ["date", "category"],
    rag: false,
    storagePath: "s3a://asklake-output/pair_a_customer_review_gold/gold/",
    storageType: "S3",
    tableName: "pair_a_customer_review_gold",
    tags: ["고객데이터", "분석용", "가공됨"],
    testStatus: "idle",
  },
  transform: {
    outputColumns: [],
    steps: [],
    summary: "변환 규칙과 품질 검사를 설정하세요.",
  },
});

export const initialDraftPipeline: DraftPipeline = baseInitialDraftPipeline;
