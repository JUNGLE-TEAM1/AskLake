import { readFileSync } from "node:fs";
import { runSparkPipeline } from "../src/sparkRunner.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const job = payload.job ?? {};
const command = payload.command ?? "run";
const runId = payload.runId;

try {
  const result = runSparkPipeline(job, command, runId, {
    sparkKubernetesProgressFile: payload.sparkKubernetesProgressFile,
    sparkRestStateFile: payload.sparkRestStateFile,
    sparkRestTimeoutMs: payload.sparkRestTimeoutMs,
  });
  console.log(`ASKLAKE_SPARK_RUN_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_SPARK_RUN_RESULT=${JSON.stringify({
    endedAt: new Date().toISOString(),
    error: error?.message || "Spark run failed.",
    inputRows: 0,
    outputPath: "-",
    outputRows: 0,
    runId,
    sourcePath: job.source || "-",
    startedAt: new Date().toISOString(),
    status: "failed",
  })}`);
  console.error(error?.stack || error?.message || error);
}
