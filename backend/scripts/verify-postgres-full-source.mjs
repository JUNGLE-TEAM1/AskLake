import assert from "node:assert/strict";
import { getSourceRows, testPostgresSource } from "../src/connectors.mjs";
import { runSparkPipeline } from "../src/sparkRunner.mjs";

const expectedRows = Number(process.env.ASKLAKE_VERIFY_POSTGRES_ROWS || 79409);
const password = process.env.ASKLAKE_VERIFY_POSTGRES_PASSWORD || "asklake";
const fields = [
  ["Endpoint / Host", process.env.ASKLAKE_VERIFY_POSTGRES_HOST || "127.0.0.1"],
  ["Port", process.env.ASKLAKE_VERIFY_POSTGRES_PORT || "15432"],
  ["Database Name", process.env.ASKLAKE_VERIFY_POSTGRES_DATABASE || "asklake_sources"],
  ["Schema", process.env.ASKLAKE_VERIFY_POSTGRES_SCHEMA || "synthetic_commerce"],
  ["Username", process.env.ASKLAKE_VERIFY_POSTGRES_USER || "asklake"],
  ["Password / Auth Token", password],
  ["DATASET OR TABLE SELECTOR", process.env.ASKLAKE_VERIFY_POSTGRES_TABLE || "commerce_events"],
];

const analysis = await testPostgresSource(fields);
assert.equal(analysis.previewRows.length, 10, "inline PostgreSQL preview must remain 10 rows");
assert.equal(analysis.previewRowCount, expectedRows, "preview metadata must report the complete table row count");
assert.equal(analysis.previewHasNext, expectedRows > 10, "preview hasNext must reflect remaining source rows");

const beyondLegacyCapOffset = Math.min(50000, Math.max(0, expectedRows - 1));
const beyondLegacyCap = await getSourceRows("PostgreSQL", fields, { limit: 100, offset: beyondLegacyCapOffset });
assert.equal(beyondLegacyCap.offset, beyondLegacyCapOffset);
assert.ok(beyondLegacyCap.rows.length > 0, "rows beyond the former 50,000-row cap must be reachable");

const lastOffset = Math.floor(Math.max(0, expectedRows - 1) / 100) * 100;
const lastPage = await getSourceRows("PostgreSQL", fields, { limit: 100, offset: lastOffset });
assert.equal(lastPage.rowCount, expectedRows);
assert.equal(lastPage.rows.length, expectedRows - lastOffset);
assert.equal(lastPage.hasNext, false, "last source page must terminate pagination");

const summary = {
  beyondLegacyCap: `${beyondLegacyCap.offset + 1}-${beyondLegacyCap.offset + beyondLegacyCap.rows.length}`,
  inlineRows: analysis.previewRows.length,
  lastPage: `${lastOffset + 1}-${lastOffset + lastPage.rows.length}`,
  rowCount: expectedRows,
};

if (process.env.ASKLAKE_VERIFY_POSTGRES_SPARK === "true") {
  const sourceConfig = analysis.draftPatch.source.sourceConfig.map(([key, value]) => (
    key === "Password / Auth Token" ? [key, password] : [key, value]
  ));
  const runId = `verify_postgres_full_${Date.now()}`;
  const report = runSparkPipeline({
    id: "verify-postgres-full",
    name: "verify-postgres-full",
    partition: "",
    qualityRules: [],
    schemaColumns: analysis.draftPatch.schema.columns,
    schemaSampleRows: analysis.previewRows,
    sourceConfig,
    sourceType: "PostgreSQL",
    target: "verify_postgres_full",
    targetLayer: "gold",
    transformSteps: [],
  }, "run", runId);
  assert.equal(report.status, "success", report.error || "Spark JDBC verification failed");
  assert.equal(report.format, "jdbc");
  assert.equal(report.inputRows, expectedRows);
  assert.equal(report.outputRows, expectedRows);
  summary.spark = { inputRows: report.inputRows, outputRows: report.outputRows, runId };
}

console.log(JSON.stringify(summary, null, 2));
