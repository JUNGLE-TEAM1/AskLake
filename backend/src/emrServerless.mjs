import { canonicalObjectStorageUri } from "./storageLayout.mjs";

export const EMR_SERVERLESS_RUNTIME_ID = "emr-serverless";
export const EMR_SERVERLESS_TERMINAL_STATES = Object.freeze(new Set([
  "CANCELLED",
  "FAILED",
  "SUCCESS",
]));

const forbiddenCredentialNames = new Set([
  "ACCESSKEYID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "MINIO_ACCESS_KEY",
  "MINIO_ROOT_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_SECRET_KEY",
  "SPARK_MINIO_ACCESS_KEY",
  "SPARK_MINIO_SECRET_KEY",
  "SECRETACCESSKEY",
  "SESSIONTOKEN",
]);

const driverEnvironmentNames = Object.freeze([
  "ASKLAKE_OBJECT_STORAGE_PROVIDER",
  "ASKLAKE_REVIEW_ANALYSIS_RUNTIME",
  "ASKLAKE_SPARK_APP_NAME",
  "ASKLAKE_SPARK_JOB_MANIFEST_FILE",
  "ASKLAKE_SPARK_OUTPUT_PATH",
  "ASKLAKE_SPARK_REPORT_FILE",
  "ASKLAKE_SPARK_RUN_ID",
  "ASKLAKE_SPARK_RUN_ROW_LIMIT",
  "ASKLAKE_SPARK_SOURCE_FORMAT",
  "ASKLAKE_SPARK_SOURCE_PATH",
  "ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE",
  "AWS_REGION",
  "S3_FORCE_PATH_STYLE",
]);

const continuousScopedEnvironmentNames = Object.freeze([
  "APPLICATION_ID",
  "ARTIFACT_URI",
  "CANCEL_GRACE_SECONDS",
  "DRIVER_CORES",
  "DRIVER_MEMORY",
  "ENTRY_POINT_URI",
  "EXECUTION_ROLE_ARN",
  "EXECUTOR_CORES",
  "EXECUTOR_MEMORY",
  "INITIAL_EXECUTORS",
  "LOG_URI",
  "MAX_EXECUTORS",
  "MIN_EXECUTORS",
  "POLL_INTERVAL_MS",
]);

const EMR_CONTINUOUS_DEPENDENCY_MODES = Object.freeze(new Set(["jars", "packages"]));

export const EMR_SERVERLESS_CONTINUOUS_MANIFEST_FILE = "asklake-continuous-manifest.json";

export function emrServerlessConfig(environment = process.env) {
  if (!environmentFlag(environment.ASKLAKE_EMR_SERVERLESS_ENABLED, false)) {
    throw emrConfigurationError(
      "EMR Serverless runtime is disabled. Set ASKLAKE_EMR_SERVERLESS_ENABLED=true to opt in.",
      "EMR_SERVERLESS_DISABLED",
    );
  }
  const applicationId = requiredPattern(
    environment.ASKLAKE_EMR_SERVERLESS_APPLICATION_ID,
    "ASKLAKE_EMR_SERVERLESS_APPLICATION_ID",
    /^[0-9a-z]{1,64}$/,
  );
  const executionRoleArn = requiredPattern(
    environment.ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN,
    "ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN",
    /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[\w+=,.@\/-]+$/,
  );
  const region = requiredPattern(
    environment.AWS_REGION,
    "AWS_REGION",
    /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/,
  );
  const entryPointUri = canonicalAwsS3Uri(
    environment.ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI,
    "ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI",
    environment,
  );
  if (!/\.py$/i.test(entryPointUri)) {
    throw emrConfigurationError("ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI must identify a PySpark .py artifact.");
  }
  const artifactRootUri = canonicalAwsS3Uri(
    environment.ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI,
    "ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI",
    environment,
  );
  const logUri = `${canonicalAwsS3Uri(
    environment.ASKLAKE_EMR_SERVERLESS_LOG_URI,
    "ASKLAKE_EMR_SERVERLESS_LOG_URI",
    environment,
  )}/`;
  return Object.freeze({
    applicationId,
    artifactRootUri,
    cancelGracePeriodSeconds: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_CANCEL_GRACE_SECONDS,
      120,
      15,
      1800,
      "ASKLAKE_EMR_SERVERLESS_CANCEL_GRACE_SECONDS",
    ),
    driverCores: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_DRIVER_CORES,
      1,
      1,
      16,
      "ASKLAKE_EMR_SERVERLESS_DRIVER_CORES",
    ),
    driverMemory: sparkMemory(environment.ASKLAKE_EMR_SERVERLESS_DRIVER_MEMORY || "4g", "driver memory"),
    entryPointUri,
    executionRoleArn,
    executionTimeoutMinutes: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_EXECUTION_TIMEOUT_MINUTES,
      120,
      1,
      1_000_000,
      "ASKLAKE_EMR_SERVERLESS_EXECUTION_TIMEOUT_MINUTES",
    ),
    executorCores: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_EXECUTOR_CORES,
      2,
      1,
      16,
      "ASKLAKE_EMR_SERVERLESS_EXECUTOR_CORES",
    ),
    executorMemory: sparkMemory(environment.ASKLAKE_EMR_SERVERLESS_EXECUTOR_MEMORY || "4g", "executor memory"),
    initialExecutors: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_INITIAL_EXECUTORS,
      1,
      0,
      10_000,
      "ASKLAKE_EMR_SERVERLESS_INITIAL_EXECUTORS",
    ),
    logUri,
    maxExecutors: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_MAX_EXECUTORS,
      10,
      1,
      10_000,
      "ASKLAKE_EMR_SERVERLESS_MAX_EXECUTORS",
    ),
    minExecutors: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_MIN_EXECUTORS,
      0,
      0,
      10_000,
      "ASKLAKE_EMR_SERVERLESS_MIN_EXECUTORS",
    ),
    pollIntervalMs: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_POLL_INTERVAL_MS,
      2_000,
      250,
      10_000,
      "ASKLAKE_EMR_SERVERLESS_POLL_INTERVAL_MS",
    ),
    region,
  });
}

export function emrServerlessArtifactUris(runId, environment = process.env) {
  const config = emrServerlessConfig(environment);
  const runSegment = safeEmrSegment(runId, "runId").toLowerCase();
  const runRoot = `${config.artifactRootUri}/runs/${runSegment}`;
  return Object.freeze({
    manifestUri: `${runRoot}/job-manifest.json`,
    reportUri: `${runRoot}/job-report.json`,
    runRoot,
  });
}

export function emrServerlessContinuousConfig(environment = process.env) {
  if (!environmentFlag(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED, false)) {
    throw emrConfigurationError(
      "EMR Serverless Continuous runtime is disabled. Set ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED=true to opt in.",
      "EMR_SERVERLESS_CONTINUOUS_DISABLED",
    );
  }
  const scopedEnvironment = { ...environment };
  for (const suffix of continuousScopedEnvironmentNames) {
    const scopedName = `ASKLAKE_EMR_SERVERLESS_CONTINUOUS_${suffix}`;
    const commonName = `ASKLAKE_EMR_SERVERLESS_${suffix}`;
    if (String(environment[scopedName] || "").trim()) scopedEnvironment[commonName] = environment[scopedName];
  }
  const common = emrServerlessConfig(scopedEnvironment);
  const dependencyMode = String(
    environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DEPENDENCY_MODE || "packages",
  ).trim().toLowerCase();
  if (!EMR_CONTINUOUS_DEPENDENCY_MODES.has(dependencyMode)) {
    throw emrConfigurationError(
      "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DEPENDENCY_MODE must be packages or jars.",
    );
  }
  const allowMavenEgress = environmentFlag(
    environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ALLOW_MAVEN_EGRESS,
    false,
  );
  if (dependencyMode === "packages" && !allowMavenEgress) {
    throw emrConfigurationError(
      "EMR Continuous packages mode requires ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ALLOW_MAVEN_EGRESS=true after NAT/Maven egress is verified.",
    );
  }
  const kafkaPackage = optionalPackage(
    environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_KAFKA_PACKAGE,
    "org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.5",
    "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_KAFKA_PACKAGE",
  );
  const mskIamPackage = optionalPackage(
    environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MSK_IAM_PACKAGE,
    "software.amazon.msk:aws-msk-iam-auth:2.3.6",
    "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MSK_IAM_PACKAGE",
  );
  const explicitPyFiles = String(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PYFILES_URIS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicitPyFiles.length > 0 && explicitPyFiles.length !== 3) {
    throw emrConfigurationError(
      "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PYFILES_URIS must contain exactly three helper .py URIs.",
    );
  }
  const entryPointRoot = common.entryPointUri.slice(0, common.entryPointUri.lastIndexOf("/"));
  const pyFilesUris = (explicitPyFiles.length > 0
    ? explicitPyFiles
    : [
        "kafka_schema_paths.py",
        "object_storage_runtime.py",
        "snapshot_rule_runtime.py",
      ].map((name) => `${entryPointRoot}/python/${name}`))
    .map((value, index) => canonicalAwsS3Uri(
      value,
      `ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PYFILES_URIS[${index}]`,
      environment,
    ));
  if (pyFilesUris.some((value) => !/\.py$/i.test(value))) {
    throw emrConfigurationError("EMR Continuous helper artifacts must identify .py files.");
  }
  const jarUris = String(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_JAR_URIS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => canonicalAwsS3Uri(
      value,
      `ASKLAKE_EMR_SERVERLESS_CONTINUOUS_JAR_URIS[${index}]`,
      environment,
    ));
  if (dependencyMode === "jars" && jarUris.length === 0) {
    throw emrConfigurationError(
      "EMR Continuous jars mode requires ASKLAKE_EMR_SERVERLESS_CONTINUOUS_JAR_URIS.",
    );
  }
  if (jarUris.some((value) => !/\.jar$/i.test(value))) {
    throw emrConfigurationError("EMR Continuous dependency artifacts must identify .jar files.");
  }
  return Object.freeze({
    ...common,
    allowMavenEgress,
    dependencyMode,
    jarUris: Object.freeze(jarUris),
    kafkaPackage,
    maxFailedAttemptsPerHour: boundedInteger(
      environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_FAILED_ATTEMPTS_PER_HOUR,
      5,
      1,
      10,
      "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_FAILED_ATTEMPTS_PER_HOUR",
    ),
    mskIamPackage,
    pyFilesUris: Object.freeze(pyFilesUris),
  });
}

export function emrServerlessContinuousArtifactUris(jobId, workerAttemptId, environment = process.env) {
  const config = emrServerlessContinuousConfig(environment);
  const jobSegment = safeEmrSegment(jobId, "jobId").toLowerCase();
  const attemptSegment = safeEmrSegment(workerAttemptId, "workerAttemptId").toLowerCase();
  const jobRoot = `${config.artifactRootUri}/continuous/jobs/${jobSegment}`;
  return Object.freeze({
    attemptRoot: `${jobRoot}/attempts/${attemptSegment}`,
    jobRoot,
    manifestUri: `${jobRoot}/attempts/${attemptSegment}/job-manifest.json`,
    reportUri: `${jobRoot}/job-report.json`,
  });
}

export function createEmrServerlessContinuousSubmission({
  appName,
  checkpointPath,
  jobId,
  manifestUri,
  outputPath,
  reportUri,
  workerAttemptId,
}, environment = process.env) {
  const config = emrServerlessContinuousConfig(environment);
  const safeJobId = safeEmrSegment(jobId, "jobId");
  const safeAttemptId = safeEmrSegment(workerAttemptId, "workerAttemptId");
  const canonicalManifestUri = canonicalAwsS3Uri(manifestUri, "EMR Continuous manifest URI", environment);
  canonicalAwsS3Uri(reportUri, "EMR Continuous report URI", environment);
  canonicalSparkS3APath(checkpointPath, "EMR Continuous checkpoint path", environment);
  canonicalSparkS3APath(outputPath, "EMR Continuous output path", environment);
  if (config.minExecutors > config.initialExecutors || config.initialExecutors > config.maxExecutors) {
    throw emrConfigurationError(
      "EMR Continuous executor bounds must satisfy minExecutors <= initialExecutors <= maxExecutors.",
    );
  }
  const driverEnvironment = {
    ASKLAKE_CONTINUOUS_MANIFEST_FILE: EMR_SERVERLESS_CONTINUOUS_MANIFEST_FILE,
    ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
    AWS_REGION: config.region,
    S3_FORCE_PATH_STYLE: "false",
  };
  const sparkArguments = [
    "--files",
    `${canonicalManifestUri}#${EMR_SERVERLESS_CONTINUOUS_MANIFEST_FILE}`,
    "--py-files",
    config.pyFilesUris.join(","),
    ...sparkConf("spark.driver.cores", config.driverCores),
    ...sparkConf("spark.driver.memory", config.driverMemory),
    ...sparkConf("spark.executor.cores", config.executorCores),
    ...sparkConf("spark.executor.memory", config.executorMemory),
    ...sparkConf("spark.dynamicAllocation.enabled", "true"),
    ...sparkConf("spark.dynamicAllocation.initialExecutors", config.initialExecutors),
    ...sparkConf("spark.dynamicAllocation.minExecutors", config.minExecutors),
    ...sparkConf("spark.dynamicAllocation.maxExecutors", config.maxExecutors),
    ...sparkConf("spark.sql.streaming.stopGracefullyOnShutdown", "true"),
    ...Object.entries(driverEnvironment).flatMap(([name, value]) => (
      sparkConf(`spark.emr-serverless.driverEnv.${name}`, value)
    )),
  ];
  if (config.dependencyMode === "packages") {
    const packages = [config.kafkaPackage, config.mskIamPackage].filter(Boolean);
    if (packages.length > 0) sparkArguments.push(...sparkConf("spark.jars.packages", packages.join(",")));
  } else {
    sparkArguments.push("--jars", config.jarUris.join(","));
  }
  const sparkSubmitParameters = sparkArguments.map(shellToken).join(" ");
  if (sparkSubmitParameters.length > 102_400) {
    throw emrConfigurationError("EMR Continuous sparkSubmitParameters exceed the 102400 character API limit.");
  }
  return Object.freeze({
    applicationId: config.applicationId,
    clientToken: `asklake-cont-${safeAttemptId}`.slice(0, 64),
    configurationOverrides: {
      applicationConfiguration: [{
        classification: "spark",
        properties: { dynamicAllocationOptimization: "true" },
      }],
      monitoringConfiguration: {
        s3MonitoringConfiguration: { logUri: config.logUri },
      },
    },
    executionRoleArn: config.executionRoleArn,
    jobDriver: {
      sparkSubmit: {
        entryPoint: config.entryPointUri,
        sparkSubmitParameters,
      },
    },
    mode: "STREAMING",
    name: String(appName || `asklake-continuous-${safeJobId}`).trim().slice(0, 256),
    retryPolicy: { maxFailedAttemptsPerHour: config.maxFailedAttemptsPerHour },
    tags: {
      AskLakeJobId: safeJobId.slice(0, 256),
      AskLakeWorkerAttemptId: safeAttemptId.slice(0, 256),
    },
  });
}

export function createEmrServerlessBatchSubmission({
  appName,
  jobId,
  manifestUri,
  packages = [],
  reportUri,
  runId,
  sparkEnvironment = {},
}, environment = process.env) {
  const config = emrServerlessConfig(environment);
  const safeRunId = safeEmrSegment(runId, "runId");
  const safeJobId = safeEmrSegment(jobId || "asklake-job", "jobId");
  const canonicalManifestUri = canonicalAwsS3Uri(manifestUri, "EMR manifest URI", environment);
  const canonicalReportUri = canonicalAwsS3Uri(reportUri, "EMR report URI", environment);
  const sourcePath = canonicalSparkS3APath(sparkEnvironment.ASKLAKE_SPARK_SOURCE_PATH, "Spark source path", environment);
  const outputPath = canonicalSparkS3APath(sparkEnvironment.ASKLAKE_SPARK_OUTPUT_PATH, "Spark output path", environment);
  assertCredentialFree(sparkEnvironment, "EMR Spark environment");

  const driverEnvironment = {
    ...Object.fromEntries(
      driverEnvironmentNames
        .filter((name) => sparkEnvironment[name] !== undefined && sparkEnvironment[name] !== null)
        .map((name) => [name, String(sparkEnvironment[name])]),
    ),
    ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
    ASKLAKE_SPARK_JOB_MANIFEST_FILE: "asklake-job-manifest.json",
    ASKLAKE_SPARK_OUTPUT_PATH: outputPath,
    ASKLAKE_SPARK_REPORT_FILE: canonicalReportUri.replace(/^s3:\/\//, "s3a://"),
    ASKLAKE_SPARK_RUN_ID: safeRunId,
    ASKLAKE_SPARK_SOURCE_PATH: sourcePath,
    ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE: "asklake-job-manifest.json",
    AWS_REGION: config.region,
    S3_FORCE_PATH_STYLE: "false",
  };
  assertCredentialFree(driverEnvironment, "EMR driver environment");

  if (config.minExecutors > config.initialExecutors || config.initialExecutors > config.maxExecutors) {
    throw emrConfigurationError(
      "EMR executor bounds must satisfy minExecutors <= initialExecutors <= maxExecutors.",
    );
  }
  const sparkArguments = [
    "--files",
    `${canonicalManifestUri}#asklake-job-manifest.json`,
    ...sparkConf("spark.driver.cores", config.driverCores),
    ...sparkConf("spark.driver.memory", config.driverMemory),
    ...sparkConf("spark.executor.cores", config.executorCores),
    ...sparkConf("spark.executor.memory", config.executorMemory),
    ...sparkConf("spark.dynamicAllocation.enabled", "true"),
    ...sparkConf("spark.dynamicAllocation.initialExecutors", config.initialExecutors),
    ...sparkConf("spark.dynamicAllocation.minExecutors", config.minExecutors),
    ...sparkConf("spark.dynamicAllocation.maxExecutors", config.maxExecutors),
    ...Object.entries(driverEnvironment).flatMap(([name, value]) => (
      sparkConf(`spark.emr-serverless.driverEnv.${name}`, value)
    )),
  ];
  const emrPackages = [...new Set(packages
    .map((value) => String(value || "").trim())
    .filter((value) => value && !/^org\.apache\.hadoop:hadoop-aws:/i.test(value)))];
  if (emrPackages.length > 0) {
    sparkArguments.push(...sparkConf("spark.jars.packages", emrPackages.join(",")));
  }
  const sparkSubmitParameters = sparkArguments.map(shellToken).join(" ");
  if (sparkSubmitParameters.length > 102_400) {
    throw emrConfigurationError("EMR sparkSubmitParameters exceed the 102400 character API limit.");
  }
  const name = String(appName || `asklake-${safeJobId}`).trim().slice(0, 256);
  return Object.freeze({
    applicationId: config.applicationId,
    clientToken: `asklake-${safeRunId}`.slice(0, 64),
    configurationOverrides: {
      applicationConfiguration: [{
        classification: "spark",
        properties: { dynamicAllocationOptimization: "true" },
      }],
      monitoringConfiguration: {
        s3MonitoringConfiguration: { logUri: config.logUri },
      },
    },
    executionRoleArn: config.executionRoleArn,
    executionTimeoutMinutes: config.executionTimeoutMinutes,
    jobDriver: {
      sparkSubmit: {
        entryPoint: config.entryPointUri,
        sparkSubmitParameters,
      },
    },
    mode: "BATCH",
    name,
    retryPolicy: { maxAttempts: 1 },
    tags: {
      AskLakeJobId: safeJobId.slice(0, 256),
      AskLakeRunId: safeRunId.slice(0, 256),
    },
  });
}

export function normalizeEmrServerlessState(value) {
  const state = String(value || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
  if (["SUBMITTED", "QUEUED", "PENDING", "SCHEDULED"].includes(state)) return "queued";
  if (state === "RUNNING") return "running";
  if (state === "SUCCESS") return "success";
  if (state === "FAILED") return "failed";
  if (state === "CANCELLING") return "canceling";
  if (state === "CANCELLED") return "canceled";
  return "unknown";
}

export function emrServerlessLogReference({ applicationId, attempt, attemptPath = false, jobRunId, logUri }) {
  const base = String(logUri || "").replace(/\/+$/, "");
  const attemptSuffix = attemptPath && Number(attempt) > 0 ? `/attempts/${Number(attempt)}` : "";
  return Object.freeze({
    applicationId: String(applicationId || ""),
    jobRunId: String(jobRunId || ""),
    provider: "s3",
    runtime: EMR_SERVERLESS_RUNTIME_ID,
    uri: `${base}/applications/${applicationId}/jobs/${jobRunId}${attemptSuffix}/`,
  });
}

export function safeEmrServerlessMessage(value) {
  return String(value || "EMR Serverless operation failed.")
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/((?:aws_access_key_id|aws_secret_access_key|aws_session_token|accessKeyId|secretAccessKey|sessionToken))\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function assertCredentialFree(value, label = "EMR payload") {
  const forbidden = [];
  visitObject(value, (name) => {
    const leaf = String(name || "").split(".").at(-1)?.toUpperCase() || "";
    const compactLeaf = leaf.replace(/[^A-Z0-9]/g, "");
    if (
      forbiddenCredentialNames.has(leaf)
      || forbiddenCredentialNames.has(compactLeaf)
      || /(?:^|\.)fs\.s3a\.(?:access|secret)\.key$/i.test(name)
    ) {
      forbidden.push(name);
    }
  });
  if (forbidden.length > 0) {
    throw emrConfigurationError(`${label} contains forbidden static credential fields: ${forbidden.join(", ")}.`);
  }
  return value;
}

function visitObject(value, visitor, prefix = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    visitor(name);
    visitObject(child, visitor, name);
  }
}

function sparkConf(name, value) {
  return ["--conf", `${name}=${String(value)}`];
}

function shellToken(value) {
  const text = String(value ?? "");
  if (/\0|[\r\n]/.test(text)) throw emrConfigurationError("EMR Spark arguments must not contain control characters.");
  if (/^[A-Za-z0-9_./:=,@%+\-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function canonicalSparkS3APath(value, name, environment) {
  return canonicalObjectStorageUri(requiredText(value, name), environment);
}

function canonicalAwsS3Uri(value, name, environment) {
  const canonical = canonicalObjectStorageUri(requiredText(value, name), {
    ...environment,
    ASKLAKE_SPARK_OUTPUT_BUCKET: "asklake-output",
  })
    .replace(/^s3a:\/\//, "s3://")
    .replace(/\/+$/, "");
  if (!/^s3:\/\/[^/]+\/.+/.test(canonical)) {
    throw emrConfigurationError(`${name} must include an S3 object key or prefix.`);
  }
  return canonical;
}

function safeEmrSegment(value, name) {
  const safe = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") throw emrConfigurationError(`${name} is required.`);
  return safe;
}

function requiredPattern(value, name, pattern) {
  const text = requiredText(value, name);
  if (!pattern.test(text)) throw emrConfigurationError(`${name} is invalid.`);
  return text;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw emrConfigurationError(`${name} is required.`);
  return text;
}

function sparkMemory(value, name) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[1-9][0-9]*(?:g|m)$/.test(text)) {
    throw emrConfigurationError(`EMR ${name} must use a positive Spark memory value such as 4g.`);
  }
  return text;
}

function optionalPackage(value, fallback, name) {
  const text = String(value === undefined || value === null || value === "" ? fallback : value).trim();
  if (text.toLowerCase() === "none") return "";
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+$/.test(text)) {
    throw emrConfigurationError(`${name} must be a Maven coordinate or none.`);
  }
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw emrConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function environmentFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function emrConfigurationError(message, code = "EMR_SERVERLESS_CONFIGURATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.status = 500;
  return error;
}
