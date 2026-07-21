import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContinuousSqlOutputIdentity,
  getContinuousSqlUniqueKeyIssue,
  getContinuousSqlRelationMix,
  isStreamingCatalogDataset,
} from "../src/pages/sql/continuousSqlUi.ts";
import { ApiError } from "../src/types/audit.ts";

function dataset(overrides: Record<string, unknown>) {
  return {
    description: "fixture",
    downstream: [],
    freshness: "latest",
    id: "dataset-static",
    layer: "SILVER",
    lastUpdated: "now",
    name: "static",
    nextRefresh: "manual",
    owner: "tester",
    quality: "ok",
    rag: false,
    rows: "1 rows",
    sampleRows: [],
    schema: [],
    size: "1KB",
    source: "Amazon S3",
    status: "available",
    tags: [],
    upstream: [],
    ...overrides,
  } as never;
}

test("uses authoritative Catalog relationMode for the relation mix", () => {
  const stream = dataset({
    id: "dataset-events",
    name: "events",
    relationMode: "streaming",
  });
  const users = dataset({ id: "dataset-users", name: "users", relationMode: "static" });

  assert.equal(isStreamingCatalogDataset(stream), true);
  assert.equal(isStreamingCatalogDataset(users), false);
  assert.deepEqual(getContinuousSqlRelationMix([stream, users]), {
    staticDatasets: [users],
    streamingDataset: stream,
  });
});

test("requires exactly one stream and at least one static relation", () => {
  const streamA = dataset({ id: "stream-a", relationMode: "streaming" });
  const streamB = dataset({ id: "stream-b", relationMode: "streaming" });
  const staticDataset = dataset({ id: "static", relationMode: "static" });

  assert.equal(getContinuousSqlRelationMix([staticDataset]), null);
  assert.equal(getContinuousSqlRelationMix([streamA, streamB, staticDataset]), null);
});

test("does not infer streaming inputs from legacy names, tags, or materialization runs", () => {
  const legacy = dataset({
    id: "legacy-stream",
    materializationRuns: [{ materializationMode: "delta", sourceKind: "kafka" }],
    name: "realtime_kafka_events",
    source: "Kafka topic",
    tags: ["#실시간"],
  });
  const staticDataset = dataset({ id: "static", relationMode: "static" });

  assert.equal(isStreamingCatalogDataset(legacy), false);
  assert.equal(getContinuousSqlRelationMix([legacy, staticDataset]), null);
});

test("creates safe unique Continuous SQL dataset identifiers", () => {
  const first = buildContinuousSqlOutputIdentity();
  const second = buildContinuousSqlOutputIdentity();

  assert.match(first.datasetId, /^continuous-\d+-[a-z0-9]+$/);
  assert.notEqual(first.datasetId, second.datasetId);
});

test("extracts a static JOIN key issue for automatic Catalog verification", () => {
  const error = new ApiError({
    code: "CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE",
    details: { datasetId: "dataset-users", joinColumns: ["user_id"] },
    message: "Static JOIN key needs Catalog evidence",
    status: 422,
  });

  assert.deepEqual(getContinuousSqlUniqueKeyIssue(error), {
    columns: ["user_id"],
    datasetId: "dataset-users",
  });
  assert.equal(getContinuousSqlUniqueKeyIssue(new Error("unrelated")), null);
});
