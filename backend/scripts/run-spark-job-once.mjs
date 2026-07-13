import { readFileSync } from "node:fs";
import { runSparkPipeline } from "../src/sparkRunner.mjs";
import { normalizeObjectStorageFailure } from "../src/storageLayout.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const job = payload.job ?? {};
const command = payload.command ?? "run";
const runId = payload.runId;

try {
  const result = runSparkPipeline(job, command, runId, {
    sparkRestStateFile: payload.sparkRestStateFile,
    sparkRestTimeoutMs: payload.sparkRestTimeoutMs,
  });
  const storageFailure = result?.status === "failed"
    ? normalizeObjectStorageFailure(
      {
        code: result.errorCode,
        message: [result.error, result.stderr, result.stdout].filter(Boolean).join(" "),
        status: result.errorStatus,
      },
      { bucket: "configured Spark output", operation: "Spark batch write" },
    )
    : null;
  console.log(`ASKLAKE_SPARK_RUN_RESULT=${JSON.stringify(storageFailure ? {
    ...result,
    error: storageFailure.message,
    errorCode: storageFailure.code,
    errorStatus: storageFailure.status,
    stderr: "",
    stdout: "",
  } : result)}`);
} catch (error) {
  const storageFailure = normalizeObjectStorageFailure(
    error,
    { bucket: "configured Spark output", operation: "Spark batch submission" },
  );
  console.log(`ASKLAKE_SPARK_RUN_RESULT=${JSON.stringify({
    endedAt: new Date().toISOString(),
    error: storageFailure?.message || error?.message || "Spark run failed.",
    ...(storageFailure ? { errorCode: storageFailure.code, errorStatus: storageFailure.status } : {}),
    inputRows: 0,
    outputPath: "-",
    outputRows: 0,
    runId,
    sourcePath: job.source || "-",
    startedAt: new Date().toISOString(),
    status: "failed",
  })}`);
  console.error(storageFailure ? `${storageFailure.code}: ${storageFailure.message}` : "Spark run failed.");
}
