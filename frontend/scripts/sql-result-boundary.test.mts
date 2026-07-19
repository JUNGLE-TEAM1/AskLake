import assert from "node:assert/strict";
import test from "node:test";

import { sqlResultToDashboardOption } from "../src/pages/dashboard/runtime/dashboardDatasetAdapters.ts";
import { hasSqlResultDataShape } from "../src/pages/sql/sqlResultFormatting.ts";
import {
  createTrinoResultChartRequestKey,
  resolveTrinoResultChartSource,
} from "../src/pages/sql/trinoResultChartState.ts";

const incompleteTrinoRun = {
  baseDatasetId: "dataset-1",
  engine: "trino",
  query: "SELECT 1",
  runId: "trino-run-1",
  status: "running",
  submittedAt: "2026-07-13T00:00:00Z",
};

test("an in-progress Trino run is not treated as a displayable SQL result", () => {
  assert.equal(hasSqlResultDataShape(incompleteTrinoRun), false);
});

test("dashboard SQL result conversion cannot crash on an incomplete Trino snapshot", () => {
  const option = sqlResultToDashboardOption(incompleteTrinoRun as never);

  assert.deepEqual(option.columns, []);
  assert.deepEqual(option.rows, []);
  assert.equal(option.id, "sql-result-trino-run-1");
});

test("an empty but complete SQL result remains displayable", () => {
  assert.equal(hasSqlResultDataShape({ columns: [], rows: [] }), true);
});

test("a Trino chart key is independent from the currently visible 100-row page", () => {
  const run = {
    baseDatasetId: "dataset-1",
    engine: "trino",
    mode: "run",
    query: "SELECT * FROM events",
    referenceDatasetIds: [],
    result: { columns: ["day", "value"], storageStatus: "available" },
    runId: "trino-full-1",
    status: "succeeded",
    submittedAt: "2026-07-19T00:00:00Z",
  } as const;
  const chartConfig = {
    config: {
      aggregation: "sum",
      color: { colors: ["#2563eb"] },
      xKey: "day",
      yKey: "value",
    },
    sourceId: "sql-result:trino-preview-1",
    title: "전체 결과",
    type: "line_chart",
  } as const;
  const source = {
    dataset: {
      columns: [{ name: "day", type: "date" as const }, { name: "value", type: "number" as const }],
      id: "sql-result-trino-preview-1",
      layer: "GOLD" as const,
      name: "SQL 결과",
      rows: [{ day: "2026-06-01", value: 1 }],
      status: "available" as const,
    },
    id: chartConfig.sourceId,
    kind: "sql_result" as const,
    label: "SQL 결과",
  };
  const nextPageSource = {
    ...source,
    dataset: { ...source.dataset, rows: [{ day: "2026-06-02", value: 999 }] },
  };

  assert.equal(
    createTrinoResultChartRequestKey({ chartConfig, fullResultRun: run, retryToken: 0, source }),
    createTrinoResultChartRequestKey({ chartConfig, fullResultRun: run, retryToken: 0, source: nextPageSource }),
  );
});

test("server-aggregated Trino rows replace the visible preview page rows", () => {
  const source = {
    dataset: {
      columns: [{ name: "day", type: "date" as const }, { name: "value", type: "number" as const }],
      id: "sql-result-trino-preview-1",
      layer: "GOLD" as const,
      name: "SQL 결과",
      rows: [{ day: "2026-06-01", value: 1 }],
      status: "available" as const,
    },
    id: "sql-result:trino-preview-1",
    kind: "sql_result" as const,
    label: "SQL 결과",
  };
  const result = {
    config: {
      aggregation: "sum",
      color: { colors: ["#2563eb"] },
      dataMode: "server_aggregated" as const,
      xKey: "day",
      yKey: "value",
    },
    data: [{ day: "2026-06-01", value: 123_456 }],
    groupCount: 1,
    runId: "trino-full-1",
    sourceRowCount: 1_000_000,
  };

  const resolved = resolveTrinoResultChartSource(source, result);
  assert.deepEqual(resolved?.dataset.rows, result.data);
  assert.equal(resolved?.scope, "full_result");
  assert.equal(resolved?.sourceRowCount, 1_000_000);
});
