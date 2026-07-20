import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { describeProcessingMode } from "../src/services/processingMode.ts";

const frontendRoot = resolve(import.meta.dirname, "..");

test("continuous review labels follow the persisted runtime engine", () => {
  assert.equal(
    describeProcessingMode({ executionMode: "continuous" } as never),
    "실시간 · Spark (기존 V1)",
  );
  assert.equal(
    describeProcessingMode({
      continuousConfig: { runtimeEngine: "kafka_connect_clickhouse_v2" },
      executionMode: "continuous",
    } as never),
    "실시간 · ClickHouse",
  );
  assert.equal(
    describeProcessingMode({ executionMode: "snapshot" } as never),
    "배치 · Spark",
  );
});

test("ClickHouse Gold action is absent when the deployment feature is disabled", () => {
  const page = readFileSync(
    resolve(frontendRoot, "src/pages/sql/SqlAnalysisPage.tsx"),
    "utf8",
  );
  assert.match(
    page,
    /continuousJoinAction=\{continuousSql\.relationMix && continuousSql\.featureEnabled/,
  );
});

test("Kafka create mode tells V1-only users that Spark is the realtime engine", () => {
  const sourceStage = readFileSync(
    resolve(frontendRoot, "src/pages/etl/SourceConnectionStages.tsx"),
    "utf8",
  );
  assert.match(sourceStage, /실시간 · Spark \(기존 V1\)/);
  assert.doesNotMatch(sourceStage, /실시간 · ClickHouse/);
});
