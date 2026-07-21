import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { describeProcessingMode } from "../src/services/processingMode.ts";

const frontendRoot = resolve(import.meta.dirname, "..");

test("continuous review labels expose Spark as the only runtime engine", () => {
  assert.equal(
    describeProcessingMode({ executionMode: "continuous" } as never),
    "실시간 · Spark",
  );
  assert.equal(
    describeProcessingMode({
      continuousConfig: { runtimeEngine: "spark_structured_streaming" },
      executionMode: "continuous",
    } as never),
    "실시간 · Spark",
  );
  assert.equal(
    describeProcessingMode({ executionMode: "snapshot" } as never),
    "배치 · Spark",
  );
});

test("general Iceberg SQL Job flow remains available without ClickHouse V2", () => {
  const page = readFileSync(
    resolve(frontendRoot, "src/pages/sql/SqlAnalysisPage.tsx"),
    "utf8",
  );
  const editor = readFileSync(
    resolve(frontendRoot, "src/pages/sql/SqlQueryEditorPanel.tsx"),
    "utf8",
  );
  const api = readFileSync(
    resolve(frontendRoot, "src/services/continuousSqlApi.ts"),
    "utf8",
  );

  assert.match(page, /onCreateTrinoSqlJob/);
  assert.match(editor, /<SqlAiWriterDialog/);
  assert.doesNotMatch(page, /continuousJoinAction|<ContinuousSqlJoinDialog/);
  assert.doesNotMatch(editor, /data-testid="continuous-sql-join-button"/);
  assert.match(api, /servingMode: "iceberg"/);
  assert.doesNotMatch(`${page}\n${editor}\n${api}`, /ClickHouse|clickhouse|kafka_connect_v2/);
});

test("Kafka create mode tells V1-only users that Spark is the realtime engine", () => {
  const sourceStage = readFileSync(
    resolve(frontendRoot, "src/pages/etl/SourceConnectionStages.tsx"),
    "utf8",
  );
  assert.match(sourceStage, /실시간 · Spark/);
  assert.doesNotMatch(sourceStage, /실시간 · ClickHouse/);
});
