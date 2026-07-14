import assert from "node:assert/strict";
import test from "node:test";

import { sqlResultToDashboardOption } from "../src/pages/dashboard/runtime/dashboardDatasetAdapters.ts";
import { hasSqlResultDataShape } from "../src/pages/sql/sqlResultFormatting.ts";

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
