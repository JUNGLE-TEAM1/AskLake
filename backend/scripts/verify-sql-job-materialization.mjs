import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const localOutputDir = path.join(os.tmpdir(), "asklake-sql-job-output");
process.env.ASKLAKE_SPARK_LOCAL_OUTPUT_DIR = localOutputDir;
process.env.ASKLAKE_SPARK_OUTPUT_CONTAINER_DIR = "/work/output";

const {
  sparkJobManifest,
  sparkRowLimitFromJob,
  sparkSourceFromJob,
} = await import("../src/sparkRunner.mjs");

const savedQuery = "SELECT id, score FROM reviews WHERE score >= 4";
const job = {
  id: "job-sql-full-data",
  partition: "",
  qualityRules: [],
  schemaColumns: [
    { included: true, sourceName: "id", targetName: "id", type: "long" },
    { included: true, sourceName: "score", targetName: "score", type: "double" },
  ],
  schemaSampleRows: [["1", "5"], ["2", "4"]],
  sourceConfig: [
    ["SQL Run ID", "sql-run-full-data"],
    ["Preview Limit", "2"],
    ["Preview Row Count", "2"],
    ["Execution Row Limit", "2"],
  ],
  sourceType: "SQL Result",
  sqlExecution: {
    baseDatasetId: "ds_reviews",
    datasets: [
      {
        datasetId: "ds_reviews",
        name: "reviews",
        storageSegments: [
          { format: "parquet", location: "s3://asklake-output/reviews/run-1" },
          { format: "json", location: path.join(localOutputDir, "gold", "reviews", "run-2") },
        ],
      },
    ],
    query: savedQuery,
    referenceDatasetIds: [],
    sourceRunId: "sql-run-full-data",
    validatedReadOnly: true,
    version: 1,
  },
  targetFormat: "parquet",
  transformSteps: [],
};

const source = sparkSourceFromJob(job, "run-output");
assert.equal(source.format, "sql");
assert.equal(source.path, "catalog://ds_reviews");
assert.equal(source.sqlExecution.query, savedQuery);
assert.equal(source.sqlExecution.datasets[0].storageSegments.length, 2);
assert.equal(
  source.sqlExecution.datasets[0].storageSegments[0].location,
  "s3a://asklake-output/reviews/run-1",
);
assert.equal(
  source.sqlExecution.datasets[0].storageSegments[1].location,
  "file:///work/output/gold/reviews/run-2",
);
assert.equal(sparkRowLimitFromJob(job), "0");

const manifest = sparkJobManifest(job, source);
assert.deepEqual(manifest.sqlExecution, source.sqlExecution);
assert.equal(manifest.sqlExecution.query.includes("LIMIT 2"), false);
assert.equal("schemaSampleRows" in manifest, false);

assert.throws(
  () => sparkSourceFromJob({ ...job, sqlExecution: null }, "run-output"),
  /backend-resolved sqlExecution contract/,
);

console.log("SQL Job full-materialization contract verified: preview rows are not a Spark input.");
