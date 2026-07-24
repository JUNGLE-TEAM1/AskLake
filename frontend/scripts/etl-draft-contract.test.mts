import assert from "node:assert/strict";
import test from "node:test";

import {
  ETL_DRAFT_CONTRACT_VERSION,
  ETL_DRAFT_REDACTED_VALUE,
  hydrateEtlDraft,
  sanitizeLiveEtlDraft,
  serializeEtlDraft,
} from "../src/state/etlDraftState.ts";
import type { DraftPipeline } from "../src/types/etl.ts";
import {
  sanitizeSourceConnectorFields,
  shouldReplaceSourceRuntimeDefault,
} from "../src/utils/sourceConnectorFields.ts";
import {
  DEFAULT_TARGET_DATASET,
  DEFAULT_TARGET_DESCRIPTION,
  isDefaultTargetDataset,
  isDefaultTargetDescription,
  resolveDefaultTargetDataset,
  resolveDefaultTargetDescription,
} from "../src/pages/etl/targetDefaults.ts";

function draftFixture(): DraftPipeline {
  return {
    id: "draft-1",
    permission: { owner: "data-team", roles: [], summary: "owner" },
    quality: { invalidRows: [], rules: [], status: "idle", summary: "none" },
    recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
    schedule: {
      label: "수동 실행",
      mode: "manual",
      retryPolicy: {
        backoffMultiplier: 2,
        backoffStrategy: "exponential",
        failureAction: "retry_then_fail",
        initialRetryDelayMinutes: 1,
        maxRetries: 3,
        maxRetryDelayMinutes: 30,
        retryIntervalMinutes: 1,
        timeoutMinutes: 60,
      },
      summary: "manual",
    },
    schema: { columns: [], sampleRows: [], summary: "pending" },
    source: {
      connectionMessage: "pending",
      connectionStatus: "idle",
      sourceConfig: [["Access Key", "AKIA-SECRET"], ["Bucket / Stage Name", "raw"]],
      sourceLabel: "raw",
      sourceType: "File / S3",
    },
    target: { datasetName: "events", format: "parquet", layer: "RAW", rag: false },
    transform: { outputColumns: [], steps: [], summary: "none" },
  };
}

test("draft serialization is versioned and never persists credential values", () => {
  const serialized = serializeEtlDraft(draftFixture());
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.version, ETL_DRAFT_CONTRACT_VERSION);
  assert.equal(parsed.draft.source.sourceConfig[0][1], ETL_DRAFT_REDACTED_VALUE);
  assert.equal(serialized.includes("AKIA-SECRET"), false);
});

test("draft hydration accepts the versioned envelope and preserves masked placeholders", () => {
  const fallback = draftFixture();
  const hydrated = hydrateEtlDraft(serializeEtlDraft(fallback), fallback);
  assert.equal(hydrated.source.sourceConfig[0][1], ETL_DRAFT_REDACTED_VALUE);
  assert.equal(hydrated.target.datasetName, "events");
  assert.notEqual(hydrated, fallback);
});

test("legacy unversioned draft and invalid JSON use compatible fallback behavior", () => {
  const fallback = draftFixture();
  const legacy = JSON.stringify({ ...fallback, target: { ...fallback.target, datasetName: "legacy_events" } });
  assert.equal(hydrateEtlDraft(legacy, fallback).target.datasetName, "legacy_events");
  assert.deepEqual(hydrateEtlDraft("not-json", fallback), hydrateEtlDraft(null, fallback));
});

test("future draft versions fail closed to the supplied fallback", () => {
  const fallback = draftFixture();
  const future = JSON.stringify({
    draft: { ...fallback, target: { ...fallback.target, datasetName: "future_events" } },
    version: 99,
  });
  assert.deepEqual(hydrateEtlDraft(future, fallback), hydrateEtlDraft(null, fallback));
});

test("masked object-storage credentials are never sent back to the connector", () => {
  const fields: Array<[string, string]> = [
    ["Storage Provider", "MinIO"],
    ["Access Key", ETL_DRAFT_REDACTED_VALUE],
    ["Secret Key", "[REDACTED]"],
    ["Bucket / Stage Name", "m3-raw"],
  ];
  const sanitized = sanitizeSourceConnectorFields("File / S3", fields);
  assert.equal(sanitized.find(([label]) => label === "Access Key")?.[1], "");
  assert.equal(sanitized.find(([label]) => label === "Secret Key")?.[1], "");
  assert.equal(sanitized.find(([label]) => label === "Bucket / Stage Name")?.[1], "m3-raw");
});

test("empty and example object-storage defaults are replaceable", () => {
  assert.equal(shouldReplaceSourceRuntimeDefault(""), true);
  assert.equal(shouldReplaceSourceRuntimeDefault("replace-with-asklake-raw-bucket"), true);
  assert.equal(shouldReplaceSourceRuntimeDefault("m3-raw"), false);
});

test("live draft hydration removes mock and missing-column rules", () => {
  const draft = draftFixture();
  draft.schema.columns = [
    { included: true, nullable: false, sourceName: "amount", targetName: "amount", type: "double" },
  ];
  draft.quality.rules = [
    { enabled: true, failureAction: "Warn", id: "mock-quality-amount", kind: "range", severity: "Warning", targetColumn: "amount", validationType: "Range Check" },
    { enabled: true, failureAction: "Fail Run", id: "stale-order-id", kind: "notNull", severity: "Error", targetColumn: "order_id", validationType: "Not Null" },
    { enabled: true, failureAction: "Warn", id: "valid-amount", kind: "range", severity: "Warning", targetColumn: "amount", validationType: "Range Check" },
  ];
  draft.transform.steps = [
    { enabled: true, id: "mock-transform-amount", input: "amount", kind: "cast", label: "mock", onError: "Warn", operation: "Cast", output: "amount" },
    { enabled: true, id: "stale-order-transform", input: "order_id", kind: "trim", label: "stale", onError: "Warn", operation: "Trim", output: "order_id" },
  ];

  const sanitized = sanitizeLiveEtlDraft(draft);

  assert.deepEqual(sanitized.quality.rules.map((rule) => rule.id), ["valid-amount"]);
  assert.deepEqual(sanitized.transform.steps, []);
  assert.equal(sanitized.quality.status, "idle");
});

test("target defaults replace empty and legacy example values", () => {
  assert.equal(resolveDefaultTargetDataset(""), DEFAULT_TARGET_DATASET);
  assert.equal(resolveDefaultTargetDataset("customer_review_gold"), DEFAULT_TARGET_DATASET);
  assert.equal(resolveDefaultTargetDataset("pair_a_customer_review_gold"), DEFAULT_TARGET_DATASET);
  assert.equal(resolveDefaultTargetDataset("구매전환율 데이터셋"), DEFAULT_TARGET_DATASET);
  assert.equal(resolveDefaultTargetDataset("과거 30일 클릭 로그 데이터셋"), DEFAULT_TARGET_DATASET);
  assert.equal(resolveDefaultTargetDescription(""), DEFAULT_TARGET_DESCRIPTION);
  assert.equal(resolveDefaultTargetDescription("고객 리뷰 분석용 정제 데이터셋"), DEFAULT_TARGET_DESCRIPTION);
  assert.equal(resolveDefaultTargetDescription("이전 30일 2026년 6월 클릭로그"), DEFAULT_TARGET_DESCRIPTION);
});

test("target defaults preserve explicit user values", () => {
  assert.equal(resolveDefaultTargetDataset("custom_conversion_dataset"), "custom_conversion_dataset");
  assert.equal(resolveDefaultTargetDescription("사용자가 직접 입력한 설명"), "사용자가 직접 입력한 설명");
});

test("Kafka target default detection keeps legacy placeholder compatibility", () => {
  assert.equal(isDefaultTargetDataset("customer_review_gold"), true);
  assert.equal(isDefaultTargetDataset(DEFAULT_TARGET_DATASET), true);
  assert.equal(isDefaultTargetDataset("orders_clicks_v1"), false);
  assert.equal(isDefaultTargetDescription("고객 리뷰 분석용 정제 데이터셋"), true);
  assert.equal(isDefaultTargetDescription(DEFAULT_TARGET_DESCRIPTION), true);
  assert.equal(isDefaultTargetDescription("Kafka continuous micro-batch target 데이터셋"), false);
});
