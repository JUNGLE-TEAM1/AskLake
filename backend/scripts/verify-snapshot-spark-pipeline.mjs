import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const fixturesDir = path.join(backendDir, "fixtures");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "asklake-snapshot-pipeline-"));
chmodSync(tempDir, 0o777);

try {
  const actionBudget = runPipeline("action-budget", actionBudgetManifest(), {
    ASKLAKE_SPARK_STAGED_CACHE_MAX_BYTES: "1",
  });
  assert(actionBudget.process.status === 0, `Action-budget pipeline exited ${actionBudget.process.status}:\n${actionBudget.process.stdout}\n${actionBudget.process.stderr}`);
  assert(actionBudget.report.inputRows === 3, `Expected 3 action-budget input rows: ${JSON.stringify(actionBudget.report)}`);
  assert(actionBudget.report.outputRows === 3, `Expected 3 action-budget output rows: ${JSON.stringify(actionBudget.report)}`);
  assert(actionBudget.report.sparkResources?.cacheStorageLevel === "NONE", `Expected the batch path to avoid executor DataFrame cache: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.materializationMode === "run_scoped_parquet_staging", `Expected run-scoped Parquet materialization: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.materializationFileCount > 0, `Expected materialized Parquet files: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.materializationBytes > 1, `Expected exact materialized Parquet bytes: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.materializationSizeStatus === "exact", `Expected exact materialization size status: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.materializationCleanupStatus === "success", `Expected successful materialization cleanup: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.outputFrameCacheMode === "staged_parquet_reuse", `Expected downstream work to reuse staged Parquet instead of executor cache: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.stagedCacheEligible === false, `Expected an above-threshold materialization to skip cache: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.sparkResources?.stagedCacheDecisionReason === "above_threshold", `Expected an auditable cache rejection reason: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.phaseTimings?.materializationStaging?.durationMs >= 0, `Expected materialization timing evidence: ${JSON.stringify(actionBudget.report.phaseTimings)}`);
  assert(actionBudget.report.sparkResources?.executorInstances === 1, `Expected one local executor in action-budget evidence: ${JSON.stringify(actionBudget.report.sparkResources)}`);
  assert(actionBudget.report.transform?.rowPreservingSqlExpressionCount === 2, `Expected two action-free row-preserving SQL transforms: ${JSON.stringify(actionBudget.report.transform)}`);
  assert(actionBudget.report.quality?.outputRowCountSource === "canonical_quality_counters", `Expected canonical row counters to replace the duplicate output count: ${JSON.stringify(actionBudget.report.quality)}`);
  const sourceReadMarker = "FileScanRDD: Reading File path: file:///work/fixtures/rules/snapshot-pipeline-input.jsonl";
  const sourceReadCount = actionBudget.process.stderr.split(sourceReadMarker).length - 1;
  assert(sourceReadCount === 1, `Expected exactly 1 raw JSONL read, got ${sourceReadCount}:\n${actionBudget.process.stderr}`);

  const cached = runPipeline("cached", actionBudgetManifest(), {
    ASKLAKE_SPARK_STAGED_CACHE_MAX_BYTES: String(1024 * 1024 * 1024),
  });
  assert(cached.process.status === 0, `Cached pipeline exited ${cached.process.status}:\n${cached.process.stdout}\n${cached.process.stderr}`);
  assert(cached.report.sparkResources?.stagedCacheEligible === true, `Expected a small staged frame to be cache eligible: ${JSON.stringify(cached.report.sparkResources)}`);
  assert(cached.report.sparkResources?.stagedCacheDecisionReason === "within_threshold", `Expected an auditable cache selection reason: ${JSON.stringify(cached.report.sparkResources)}`);
  assert(cached.report.sparkResources?.cacheStorageLevel === "MEMORY_AND_DISK", `Expected staged Parquet to use bounded memory/disk cache: ${JSON.stringify(cached.report.sparkResources)}`);
  assert(cached.report.sparkResources?.outputFrameCacheMode === "staged_parquet_memory_and_disk", `Expected downstream work to use the staged cache: ${JSON.stringify(cached.report.sparkResources)}`);
  assert(cached.report.sparkResources?.stagedCacheFallbackCount === 0, `Expected no cache fallback for the small fixture: ${JSON.stringify(cached.report.sparkResources)}`);
  const cachedSourceReadCount = cached.process.stderr.split(sourceReadMarker).length - 1;
  assert(cachedSourceReadCount === 1, `Expected exactly 1 raw JSONL read with staged cache, got ${cachedSourceReadCount}:\n${cached.process.stderr}`);
  assertNoMaterializationStaging("cached-output");

  const preMaterialized = runPipeline("pre-materialized-prefix", preMaterializedPrefixManifest());
  assert(preMaterialized.process.status === 0, `Pre-materialized pipeline exited ${preMaterialized.process.status}:\n${preMaterialized.process.stdout}\n${preMaterialized.process.stderr}`);
  assert(preMaterialized.report.outputRows === 3, `Expected 3 pre-materialized output rows: ${JSON.stringify(preMaterialized.report)}`);
  assert(preMaterialized.report.transform?.preMaterializedTransformCount === 3, `Expected all proven transform-prefix rules in the source materialization: ${JSON.stringify(preMaterialized.report.transform)}`);
  assert(preMaterialized.report.transform?.rowPreservingSqlExpressionCount === 2, `Expected two pre-materialized row-preserving SQL transforms: ${JSON.stringify(preMaterialized.report.transform)}`);
  assert(preMaterialized.report.sparkResources?.outputFrameCacheMode === "staged_parquet_reuse", `Expected the pre-materialized prefix to continue from staged Parquet: ${JSON.stringify(preMaterialized.report.sparkResources)}`);
  const preMaterializedReadCount = preMaterialized.process.stderr.split(sourceReadMarker).length - 1;
  assert(preMaterializedReadCount === 1, `Expected exactly 1 raw JSONL read for the pre-materialized prefix, got ${preMaterializedReadCount}:\n${preMaterialized.process.stderr}`);

  const success = runPipeline("success", successManifest());
  assert(success.process.status === 0, `Success pipeline exited ${success.process.status}:\n${success.process.stdout}\n${success.process.stderr}`);
  assert(success.report.status === "success", `Success report failed: ${JSON.stringify(success.report)}`);
  assert(success.report.inputRows === 3, `Expected 3 input rows: ${JSON.stringify(success.report)}`);
  assert(success.report.outputRows === 1, `Expected one physical target row: ${JSON.stringify(success.report)}`);
  assert(success.report.transform?.errorCount === 1, `Expected one transform error: ${JSON.stringify(success.report.transform)}`);
  assert(success.report.transform?.setNullCount === 1, `Expected transform set-null evidence: ${JSON.stringify(success.report.transform)}`);
  assert(success.report.quality?.invalidRowCount === 2, `Expected two invalid quality rows: ${JSON.stringify(success.report.quality)}`);
  assert(success.report.quality?.quarantinedCount === 1, `Expected one quarantined row: ${JSON.stringify(success.report.quality)}`);
  assert(success.report.quality?.droppedCount === 1, `Expected one dropped row: ${JSON.stringify(success.report.quality)}`);
  assert(success.report.quality?.outputRowCountSource === "canonical_quality_counters", `Expected dropped/quarantined counters to derive the exact final row count: ${JSON.stringify(success.report.quality)}`);
  assert(parquetFiles(path.join(tempDir, "success-output")).length > 0, "Success target Parquet was not created.");
  assert(parquetFiles(path.join(tempDir, "success-output_quarantine")).length > 0, "Quarantine Parquet was not created.");
  assertNoMaterializationStaging("success-output");

  const failed = runPipeline("failed", failBatchManifest());
  assert(failed.process.status !== 0, "Fail Batch pipeline unexpectedly exited successfully.");
  assert(failed.report.status === "failed", `Fail Batch report did not fail: ${JSON.stringify(failed.report)}`);
  assert(failed.report.failedStage === "quality", `Expected quality failure stage: ${JSON.stringify(failed.report)}`);
  assert(failed.report.quality?.blockingFailures === 1, `Expected blocking quality evidence: ${JSON.stringify(failed.report.quality)}`);
  assert(failed.report.sparkResources?.materializationCleanupStatus === "success", `Expected failed quality run to clean materialization staging: ${JSON.stringify(failed.report.sparkResources)}`);
  assert(!existsSync(path.join(tempDir, "failed-output")), "Fail Batch must not create a target directory.");
  assertNoMaterializationStaging("failed-output");

  const schemaFailed = runPipeline("schema-failed", requiredCastFailManifest());
  assert(schemaFailed.process.status !== 0, "Required cast failure pipeline unexpectedly exited successfully.");
  assert(schemaFailed.report.status === "failed", `Required cast failure report did not fail: ${JSON.stringify(schemaFailed.report)}`);
  assert(schemaFailed.report.sparkResources?.materializationCleanupStatus === "success", `Expected schema failure to clean materialization staging: ${JSON.stringify(schemaFailed.report.sparkResources)}`);
  assert(!existsSync(path.join(tempDir, "schema-failed-output")), "Required cast failure must not create a target directory.");
  assertNoMaterializationStaging("schema-failed-output");

  const mixedSqlFailed = runPipeline("mixed-sql-failed", mixedSqlFailBatchManifest());
  assert(mixedSqlFailed.process.status !== 0, "Mixed SQL + Fail Batch pipeline unexpectedly succeeded.");
  assert(mixedSqlFailed.report.failedStage === "quality", `Expected mixed SQL quality failure: ${JSON.stringify(mixedSqlFailed.report)}`);
  assert(!existsSync(path.join(tempDir, "mixed-sql-failed-output")), "Mixed SQL + Fail Batch must not publish a target directory.");
  assert(
    !readdirSync(tempDir).some((name) => name.startsWith("mixed-sql-failed-output.__staging__")),
    "Mixed SQL + Fail Batch must clean its staging directory.",
  );
  assertNoMaterializationStaging("mixed-sql-failed-output");

  console.log("verify-snapshot-spark-pipeline: ok");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function actionBudgetManifest() {
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: [
      ...baseOutputSchema(),
      ["rating_value", "Double"],
      ["event_id_trimmed", "String"],
      ["status_trimmed", "String"],
    ],
    rules: [
      canonicalRule({
        failureDisposition: "set_null",
        id: "rating-cast-action-budget",
        inputColumns: ["rating"],
        kind: "transform",
        operation: "cast",
        outputColumns: ["rating_value"],
        outputType: "Double",
        parameters: { targetType: "Double" },
      }),
      canonicalRule({
        id: "event-id-trim-action-budget",
        inputColumns: ["event_id"],
        kind: "transform",
        operation: "sql_expression",
        outputColumns: ["event_id_trimmed"],
        outputType: "String",
        parameters: { expression: "TRIM(CAST(event_id AS STRING))" },
      }),
      canonicalRule({
        id: "status-trim-action-budget",
        inputColumns: ["status"],
        kind: "transform",
        operation: "sql_expression",
        outputColumns: ["status_trimmed"],
        outputType: "String",
        parameters: { expression: "TRIM(CAST(status AS STRING))" },
      }),
    ],
    schemaColumns: baseSchema(),
    transformSteps: [
      { enabled: true, input: "rating", output: "rating_value" },
      {
        enabled: true,
        input: "event_id",
        operation: "SQL Expression",
        output: "event_id_trimmed",
        params: "TRIM(CAST(event_id AS STRING))",
      },
      {
        enabled: true,
        input: "status",
        operation: "SQL Expression",
        output: "status_trimmed",
        params: "TRIM(CAST(status AS STRING))",
      },
    ],
  };
}

function preMaterializedPrefixManifest() {
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: baseOutputSchema(),
    rules: [
      canonicalRule({
        id: "event-id-identity-rename",
        inputColumns: ["event_id"],
        kind: "transform",
        operation: "rename",
        outputColumns: ["event_id"],
        outputType: "String",
      }),
      canonicalRule({
        id: "event-id-trim-pre-materialized",
        inputColumns: ["event_id"],
        kind: "transform",
        operation: "sql_expression",
        outputColumns: ["event_id"],
        outputType: "String",
        parameters: { expression: "TRIM(CAST(event_id AS STRING))" },
      }),
      canonicalRule({
        id: "status-trim-pre-materialized",
        inputColumns: ["status"],
        kind: "transform",
        operation: "sql_expression",
        outputColumns: ["status"],
        outputType: "String",
        parameters: { expression: "TRIM(CAST(status AS STRING))" },
      }),
    ],
    schemaColumns: baseSchema(),
    transformSteps: [
      { enabled: true, input: "event_id", output: "event_id" },
      {
        enabled: true,
        input: "event_id",
        operation: "SQL Expression",
        output: "event_id",
        params: "TRIM(CAST(event_id AS STRING))",
      },
      {
        enabled: true,
        input: "status",
        operation: "SQL Expression",
        output: "status",
        params: "TRIM(CAST(status AS STRING))",
      },
    ],
  };
}

function runPipeline(name, manifest, environment = {}) {
  const manifestPath = path.join(tempDir, `${name}-manifest.json`);
  const reportPath = path.join(tempDir, `${name}-report.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const child = spawnSync("docker", [
    "run",
    "--rm",
    "-e", "SPARK_LOCAL_IP=127.0.0.1",
    "-e", "ASKLAKE_SPARK_SOURCE_PATH=file:///work/fixtures/rules/snapshot-pipeline-input.jsonl",
    "-e", "ASKLAKE_SPARK_SOURCE_FORMAT=jsonl",
    "-e", `ASKLAKE_SPARK_OUTPUT_PATH=file:///work/tmp/${name}-output`,
    "-e", `ASKLAKE_SPARK_RUN_ID=snapshot-${name}`,
    "-e", `ASKLAKE_SPARK_JOB_MANIFEST_FILE=/work/tmp/${name}-manifest.json`,
    "-e", `ASKLAKE_SPARK_REPORT_FILE=/work/tmp/${name}-report.json`,
    "-e", "ASKLAKE_SPARK_RUN_ROW_LIMIT=0",
    ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${fixturesDir}:/work/fixtures:ro`,
    "-v", `${tempDir}:/work/tmp`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master", "local[2]",
    "--conf", "spark.ui.enabled=false",
    "/work/scripts/spark_job_run.py",
  ], {
    cwd: backendDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert(existsSync(reportPath), `${name} pipeline did not write a report:\n${child.stdout}\n${child.stderr}`);
  return { process: child, report: JSON.parse(readFileSync(reportPath, "utf8")) };
}

function successManifest() {
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: [...baseOutputSchema(), ["rating_value", "Double"], ["reviewer_alias", "String"]],
    rules: [
      canonicalRule({
        failureDisposition: "set_null",
        id: "rating-cast",
        inputColumns: ["rating"],
        kind: "transform",
        operation: "cast",
        outputColumns: ["rating_value"],
        outputType: "Double",
        parameters: { targetType: "Double" },
      }),
      canonicalRule({
        id: "rename-mixed-case-dotted-input",
        inputColumns: ["raw.reviewerID"],
        kind: "transform",
        operation: "rename",
        outputColumns: ["reviewer_alias"],
        outputType: "String",
      }),
      canonicalRule({
        id: "email-pattern",
        inputColumns: ["email"],
        kind: "quality",
        onError: "quarantine",
        operation: "regex",
        parameters: { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
        severity: "error",
      }),
      canonicalRule({
        failureDisposition: "drop_row",
        id: "status-required",
        inputColumns: ["status"],
        kind: "quality",
        operation: "not_null",
        severity: "warning",
      }),
    ],
    schemaColumns: baseSchema(),
    transformSteps: [
      { enabled: true, input: "rating", output: "rating_value" },
      { enabled: true, input: "raw.reviewerID", output: "reviewer_alias" },
    ],
  };
}

function failBatchManifest() {
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: baseOutputSchema(),
    rules: [canonicalRule({
      id: "status-blocking",
      inputColumns: ["status"],
      kind: "quality",
      onError: "fail_batch",
      operation: "not_null",
      severity: "error",
    })],
    schemaColumns: baseSchema(),
    transformSteps: [],
  };
}

function mixedSqlFailBatchManifest() {
  return {
    partitionColumns: "",
    qualityRules: [{
      enabled: true,
      failureAction: "Fail Run",
      id: "status-blocking",
      kind: "notNull",
      severity: "Error",
      targetColumn: "status",
      validationType: "Not Null",
    }],
    ruleContractVersion: "1.0",
    ruleOutputSchema: [...baseOutputSchema(), ["status_upper", "String"]],
    rules: [
      canonicalRule({
        id: "status-sql",
        inputColumns: ["status"],
        kind: "transform",
        operation: "sql_expression",
        outputColumns: ["status_upper"],
        outputType: "String",
        parameters: { expression: "upper(status)" },
      }),
      canonicalRule({
        id: "status-blocking",
        inputColumns: ["status"],
        kind: "quality",
        onError: "fail_batch",
        operation: "not_null",
        severity: "error",
      }),
    ],
    schemaColumns: baseSchema(),
    transformSteps: [{
      enabled: true,
      input: "status",
      operation: "SQL Expression",
      output: "status_upper",
      params: "upper(status)",
    }],
  };
}

function requiredCastFailManifest() {
  const schemaColumns = baseSchema().map((column) => (
    column.targetName === "rating"
      ? { ...column, nullable: false, type: "Integer" }
      : column
  ));
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: schemaColumns.map((column) => [column.targetName, column.type]),
    rules: [],
    schemaColumns,
    transformSteps: [],
  };
}

function canonicalRule(overrides) {
  return {
    contractVersion: "1.0",
    enabled: true,
    failureDisposition: "keep",
    inputColumns: [],
    kind: "transform",
    onError: "warn",
    operation: "copy",
    outputColumns: [],
    parameters: {},
    ...overrides,
  };
}

function baseSchema() {
  return [
    { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
    { included: true, nullable: true, sourceName: "rating", targetName: "rating", type: "String" },
    { included: true, nullable: true, sourceName: "status", targetName: "status", type: "String" },
    { included: true, nullable: true, sourceName: "email", targetName: "email", type: "String" },
    { included: true, nullable: true, sourceName: "raw.reviewerID", targetName: "raw_reviewerid", type: "String" },
  ];
}

function baseOutputSchema() {
  return baseSchema().map((column) => [column.targetName, column.type]);
}

function parquetFiles(directory) {
  if (!existsSync(directory)) return [];
  const output = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".parquet")) output.push(entryPath);
    }
  };
  visit(directory);
  return output;
}

function assertNoMaterializationStaging(outputName) {
  assert(
    !readdirSync(tempDir).some((name) => name.startsWith(`${outputName}.__materialization__`)),
    `${outputName} must clean its materialization staging directory.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
