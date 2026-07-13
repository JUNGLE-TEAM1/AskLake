import { finalizeSparkJobRun } from "../src/createPipeline.mjs";
import { closeMetadataStore, ensureMetadataSchema } from "../src/metadataStore.mjs";

const [jobId, command, runId] = process.argv.slice(2);

if (!jobId || !command || !runId) {
  console.error("Usage: node scripts/finalize-spark-job-run.mjs <jobId> <command> <runId>");
  process.exit(2);
}

try {
  await ensureMetadataSchema();
  console.log(JSON.stringify({
    event: "asklake.spark_worker.started",
    jobId,
    command,
    runId,
    startedAt: new Date().toISOString(),
  }));
  const result = await finalizeSparkJobRun(jobId, command, runId);
  const sparkResult = result?.sparkResult ?? null;
  if (sparkResult?.stdout) {
    console.log(sparkResult.stdout);
  }
  if (sparkResult?.stderr) {
    console.error(sparkResult.stderr);
  }
  console.log(JSON.stringify({
    event: "asklake.spark_worker.finished",
    jobId,
    command,
    datasetId: result?.dataset?.id ?? null,
    error: sparkResult?.error ?? null,
    outputRows: sparkResult?.outputRows ?? null,
    runId,
    sparkExitCode: sparkResult?.sparkExitCode ?? null,
    status: sparkResult?.status ?? "unknown",
    finishedAt: new Date().toISOString(),
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: "asklake.spark_worker.failed",
    jobId,
    command,
    runId,
    error: error?.message || String(error),
    failedAt: new Date().toISOString(),
  }));
  process.exitCode = 1;
} finally {
  await closeMetadataStore().catch(() => {});
}
