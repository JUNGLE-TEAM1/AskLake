import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applySnapshotRules,
  supportsSnapshotRules,
} from "../src/snapshotRuleRuntime.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const reportRoot = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(os.tmpdir(), "asklake-spark-runs"));
mkdirSync(reportRoot, { recursive: true });
const tempDir = mkdtempSync(path.join(reportRoot, "rule-preview-"));
chmodSync(tempDir, 0o777);

try {
  const payloadPath = path.join(tempDir, "payload.json");
  const reportPath = path.join(tempDir, "report.json");
  writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, "utf8");
  let usedFallback = false;
  const child = spawnSync("docker", [
    "run",
    "--rm",
    "-e", "SPARK_LOCAL_IP=127.0.0.1",
    "-e", "ASKLAKE_RULE_PREVIEW_PAYLOAD_FILE=/work/preview/payload.json",
    "-e", "ASKLAKE_RULE_PREVIEW_REPORT_FILE=/work/preview/report.json",
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${tempDir}:/work/preview`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master", "local[2]",
    "--conf", "spark.ui.enabled=false",
    "/work/scripts/spark_rule_preview.py",
  ], {
    cwd: backendDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!existsSync(reportPath)) {
    if (child.status === null && supportsSnapshotRules(payload.rules)) {
      const fallback = applySnapshotRules(payload.records, payload.rules);
      const fallbackResult = {
        ...fallback,
        engine: "snapshot-fallback",
        status: "success",
      };
      usedFallback = true;
      writeFileSync(reportPath, `${JSON.stringify(fallbackResult)}\n`, "utf8");
      console.log(`ASKLAKE_RULE_PREVIEW_RESULT=${JSON.stringify(fallbackResult)}`);
    } else {
      throw new Error(child.stderr || child.stdout || `Spark Preview exited ${child.status}.`);
    }
  }
  const result = JSON.parse(readFileSync(reportPath, "utf8"));
  if ((!usedFallback && child.status !== 0) || result.status !== "success") {
    throw Object.assign(new Error(result.message || `Spark Preview exited ${child.status}.`), {
      code: result.code || "RULE_PREVIEW_FAILED",
      status: 422,
    });
  }
  console.log(`ASKLAKE_RULE_PREVIEW_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_RULE_PREVIEW_ERROR=${JSON.stringify({
    code: error?.code || "RULE_PREVIEW_FAILED",
    message: error?.message || "Spark Rule Preview failed.",
    status: error?.status || 422,
  })}`);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
