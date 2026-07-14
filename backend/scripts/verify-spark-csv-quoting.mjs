import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const fixturesDir = path.join(backendDir, "fixtures");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "asklake-spark-csv-quoting-"));
chmodSync(tempDir, 0o777);

try {
  const manifestPath = path.join(tempDir, "manifest.json");
  const reportPath = path.join(tempDir, "report.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: [
      ["id", "Long"],
      ["review", "String"],
      ["price", "Double"],
      ["rating_count", "Long"],
    ],
    rules: [],
    schemaColumns: [
      schemaColumn("id", "Long", false),
      schemaColumn("review", "String", false),
      schemaColumn("price", "Double", false),
      schemaColumn("rating_count", "Long", false),
    ],
    transformSteps: [],
  }, null, 2)}\n`, "utf8");

  const child = spawnSync("docker", [
    "run",
    "--rm",
    "-e", "SPARK_LOCAL_IP=127.0.0.1",
    "-e", "ASKLAKE_SPARK_SOURCE_PATH=file:///work/fixtures/rules/quoted-reviews.csv",
    "-e", "ASKLAKE_SPARK_SOURCE_FORMAT=csv",
    "-e", "ASKLAKE_SPARK_OUTPUT_PATH=file:///work/tmp/output",
    "-e", "ASKLAKE_SPARK_RUN_ID=spark-csv-quoting",
    "-e", "ASKLAKE_SPARK_JOB_MANIFEST_FILE=/work/tmp/manifest.json",
    "-e", "ASKLAKE_SPARK_REPORT_FILE=/work/tmp/report.json",
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

  assert.equal(child.status, 0, `Quoted CSV pipeline failed:\n${child.stdout}\n${child.stderr}`);
  assert.ok(existsSync(reportPath), `Quoted CSV pipeline did not write a report:\n${child.stdout}\n${child.stderr}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.status, "success", JSON.stringify(report));
  assert.equal(report.inputRows, 4, JSON.stringify(report));
  assert.equal(report.outputRows, 4, JSON.stringify(report));

  const reviewsById = new Map(report.sampleRows.map((row) => [String(row[0]), String(row[1])]));
  assert.equal(reviewsById.get("1"), '안녕, 나는 "해건"');
  assert.equal(reviewsById.get("2"), '쉼표, 큰따옴표 "둘 다" 포함');
  assert.equal(reviewsById.get("3"), '"따옴표로 시작하고 끝나는 리뷰"');
  assert.equal(reviewsById.get("4"), '"');
  console.log("verify-spark-csv-quoting: ok");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function schemaColumn(name, type, nullable) {
  return {
    included: true,
    nullable,
    sourceName: name,
    targetName: name,
    type,
  };
}
