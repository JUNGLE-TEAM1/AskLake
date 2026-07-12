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
  assert(parquetFiles(path.join(tempDir, "success-output")).length > 0, "Success target Parquet was not created.");
  assert(parquetFiles(path.join(tempDir, "success-output_quarantine")).length > 0, "Quarantine Parquet was not created.");

  const failed = runPipeline("failed", failBatchManifest());
  assert(failed.process.status !== 0, "Fail Batch pipeline unexpectedly exited successfully.");
  assert(failed.report.status === "failed", `Fail Batch report did not fail: ${JSON.stringify(failed.report)}`);
  assert(failed.report.failedStage === "quality", `Expected quality failure stage: ${JSON.stringify(failed.report)}`);
  assert(failed.report.quality?.blockingFailures === 1, `Expected blocking quality evidence: ${JSON.stringify(failed.report.quality)}`);
  assert(!existsSync(path.join(tempDir, "failed-output")), "Fail Batch must not create a target directory.");

  console.log("verify-snapshot-spark-pipeline: ok");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function runPipeline(name, manifest) {
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
    ruleOutputSchema: [...baseOutputSchema(), ["rating_value", "Double"]],
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
    transformSteps: [{ enabled: true, input: "rating", output: "rating_value" }],
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
