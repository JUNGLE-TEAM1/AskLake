import { createHash } from "node:crypto";


function configurationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  error.status = 500;
  return error;
}


export function sparkEventLogConfiguration(runId, environment = process.env) {
  const enabled = String(environment.ASKLAKE_SPARK_EVENT_LOG_ENABLED || "false").trim();
  if (!new Set(["false", "true"]).has(enabled)) {
    throw configurationError("ASKLAKE_SPARK_EVENT_LOG_ENABLED must be true or false.");
  }
  if (enabled === "false") return {};

  if (!String(runId || "").trim()) {
    throw configurationError("runId is required when Spark event logging is enabled.");
  }

  const bucket = String(environment.ASKLAKE_SPARK_OUTPUT_BUCKET || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw configurationError("ASKLAKE_SPARK_OUTPUT_BUCKET must be a valid S3 bucket when Spark event logging is enabled.");
  }
  const outputPrefix = String(environment.ASKLAKE_SPARK_OUTPUT_PREFIX || "asklake-output").trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/.test(outputPrefix)
    || outputPrefix.includes("//")
    || outputPrefix.split("/").includes("..")
  ) {
    throw configurationError("ASKLAKE_SPARK_OUTPUT_PREFIX must be a canonical S3 key prefix when Spark event logging is enabled.");
  }
  const prefix = String(environment.ASKLAKE_SPARK_EVENT_LOG_PREFIX || "spark-events").trim();
  if (prefix !== "spark-events") {
    throw configurationError("ASKLAKE_SPARK_EVENT_LOG_PREFIX must be spark-events.");
  }
  const runHash = createHash("sha256").update(String(runId || "")).digest("hex");
  return {
    "spark.eventLog.compress": "false",
    "spark.eventLog.dir": `s3a://${bucket}/${outputPrefix}/${prefix}/${runHash}/`,
    "spark.eventLog.enabled": "true",
    "spark.eventLog.logStageExecutorMetrics": "true",
    "spark.executor.processTreeMetrics.enabled": "true",
  };
}


export function sparkApplicationConfiguration({
  appName, environment = process.env, runId, runLabel,
}) {
  return {
    "spark.app.name": String(appName || `asklake-${runLabel}`),
    "spark.jars.ivy": "/tmp/.ivy2",
    "spark.kubernetes.executor.deleteOnTermination": "true",
    "spark.sql.shuffle.partitions": String(environment.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32"),
    ...sparkEventLogConfiguration(runId, environment),
  };
}
