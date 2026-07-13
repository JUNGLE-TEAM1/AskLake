import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applySnapshotRules, SnapshotRuleExecutionError } from "../src/snapshotRuleRuntime.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(backendDir, "fixtures", "rules", "snapshot-rule-conformance.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

for (const testCase of fixture.cases) verifyNodeCase(testCase);
console.log("verify-snapshot-rule-runtime-node: ok");

if (process.env.ASKLAKE_VERIFY_SNAPSHOT_SPARK !== "false") verifySparkRuntime();

function verifyNodeCase(testCase) {
  const expected = testCase.expected;
  try {
    const result = applySnapshotRules(testCase.records, testCase.rules);
    assert(expected.status === "success", `${testCase.name}: expected failure.`);
    assertProjectedRecords(result.records, expected.records ?? [], testCase.name);
    assertProjectedRecords(result.quarantined, expected.quarantine ?? [], `${testCase.name} quarantine`);
    assertPartial(result.transform, expected.transform ?? {}, `${testCase.name} transform`);
    assertPartial(result.quality, expected.quality ?? {}, `${testCase.name} quality`);
  } catch (error) {
    if (!(error instanceof SnapshotRuleExecutionError)) throw error;
    assert(expected.status === "failed", `${testCase.name}: unexpected ${error.message}`);
    assert(error.failedStage === expected.failedStage, `${testCase.name}: expected stage ${expected.failedStage}, got ${error.failedStage}.`);
    assert(error.ruleId === expected.ruleId, `${testCase.name}: expected rule ${expected.ruleId}, got ${error.ruleId}.`);
  }
}

function verifySparkRuntime() {
  const scriptsDir = path.join(backendDir, "scripts");
  const fixturesDir = path.join(backendDir, "fixtures");
  const result = spawnSync("docker", [
    "run",
    "--rm",
    "-e",
    "SPARK_LOCAL_IP=127.0.0.1",
    "-v",
    `${scriptsDir}:/work/scripts:ro`,
    "-v",
    `${fixturesDir}:/work/fixtures:ro`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master",
    "local[2]",
    "--conf",
    "spark.ui.enabled=false",
    "/work/scripts/verify_snapshot_rule_runtime.py",
    "/work/fixtures/rules/snapshot-rule-conformance.json",
  ], {
    cwd: backendDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Spark snapshot conformance failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  assert(result.stdout.includes("verify-snapshot-rule-runtime-spark: ok"), `Spark verifier did not report success:\n${result.stdout}\n${result.stderr}`);
  console.log("verify-snapshot-rule-conformance: ok");
}

function assertProjectedRecords(actual, expected, label) {
  const projected = expected.map((expectedRecord) => {
    const match = actual.find((record) => String(record?.event_id ?? "") === String(expectedRecord.event_id ?? ""));
    assert(match, `${label}: missing event_id ${expectedRecord.event_id}.`);
    return Object.fromEntries(Object.keys(expectedRecord).map((key) => [key, match[key]]));
  });
  assert(JSON.stringify(projected) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(projected)}.`);
  assert(actual.length === expected.length, `${label}: expected ${expected.length} rows, got ${actual.length}.`);
}

function assertPartial(actual, expected, label) {
  const projected = Object.fromEntries(Object.keys(expected).map((key) => [key, actual?.[key]]));
  assert(JSON.stringify(projected) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(projected)}.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
