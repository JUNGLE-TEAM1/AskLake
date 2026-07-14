import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  "/work/scripts/verify_spark_schema_contract.py",
  "file:///work/fixtures/rules/schema-contract-input.jsonl",
], {
  cwd: backendDir,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

if (result.status !== 0) {
  throw new Error(`Spark schema contract verification failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
}
if (!result.stdout.includes("verify-spark-schema-contract: ok")) {
  throw new Error(`Spark schema contract verifier did not report success:\n${result.stdout}\n${result.stderr}`);
}
console.log("verify-spark-schema-contract: ok");
