import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClickHouseOutputIdentity,
  getContinuousSqlRelationMix,
  isStreamingCatalogDataset,
} from "../src/pages/sql/continuousSqlUi.ts";

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

test("detects a Kafka delta dataset as the single streaming relation", () => {
  const stream = dataset({
    id: "dataset-events",
    materializationRuns: [{ materializationMode: "delta", sourceKind: "kafka" }],
    name: "events",
  });
  const users = dataset({ id: "dataset-users", name: "users" });

  assert.equal(isStreamingCatalogDataset(stream), true);
  assert.equal(isStreamingCatalogDataset(users), false);
  assert.deepEqual(getContinuousSqlRelationMix([stream, users]), {
    staticDatasets: [users],
    streamingDataset: stream,
  });
});

test("requires exactly one stream and at least one static relation", () => {
  const streamA = dataset({ id: "stream-a", source: "Kafka topic a" });
  const streamB = dataset({ id: "stream-b", tags: ["#실시간"] });
  const staticDataset = dataset({ id: "static" });

  assert.equal(getContinuousSqlRelationMix([staticDataset]), null);
  assert.equal(getContinuousSqlRelationMix([streamA, streamB, staticDataset]), null);
});

test("creates safe unique ClickHouse output identifiers", () => {
  const first = buildClickHouseOutputIdentity();
  const second = buildClickHouseOutputIdentity();

  assert.match(first.datasetId, /^continuous-\d+-[a-z0-9]+$/);
  assert.match(first.table, /^live_join_\d+_[a-z0-9]+$/);
  assert.notEqual(first.table, second.table);
});
