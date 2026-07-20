import { createHash } from "node:crypto";

function configurationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  error.status = 500;
  return error;
}

export function kubernetesIdentifier(value, fallback = "run") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || fallback;
}

export function normalizeSparkAttemptGeneration(value) {
  const parsed = Number(value);
  const generation = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  if (generation > 3) {
    throw configurationError(
      "Spark Kubernetes attempt generation must be between 1 and 3.",
    );
  }
  return generation;
}

export function sparkKubernetesAnnotations({
  executorInstances,
  fixtureBatchId,
  imageDigest,
  jobId,
  normalizedAttemptGeneration,
  resourcePlanAnnotations = {},
  runId,
}) {
  return {
    "asklake.io/image-digest": imageDigest,
    "asklake.io/job-id": String(jobId),
    "asklake.io/run-id": String(runId),
    "asklake.io/executor-instances": String(executorInstances),
    "asklake.io/execution-generation": String(normalizedAttemptGeneration),
    ...resourcePlanAnnotations,
    ...(fixtureBatchId ? { "asklake.io/fixture-batch-id": fixtureBatchId } : {}),
  };
}

export function sparkKubernetesApplicationName(runId, attemptGeneration = 1) {
  const normalized = kubernetesIdentifier(runId);
  const digest = createHash("sha256").update(String(runId || "")).digest("hex").slice(0, 10);
  const generation = normalizeSparkAttemptGeneration(attemptGeneration);
  const suffix = generation > 1 ? `-g${generation}` : "";
  const identity = normalized.slice(0, 38 - suffix.length).replace(/-+$/g, "");
  return `asklake-run-${identity}-${digest}${suffix}`;
}
