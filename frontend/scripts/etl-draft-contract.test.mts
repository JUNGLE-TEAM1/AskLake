import assert from "node:assert/strict";
import test from "node:test";

import {
  ETL_DRAFT_CONTRACT_VERSION,
  ETL_DRAFT_REDACTED_VALUE,
  hydrateEtlDraft,
  serializeEtlDraft,
} from "../src/state/etlDraftState.ts";
import type { DraftPipeline } from "../src/types/etl.ts";

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
