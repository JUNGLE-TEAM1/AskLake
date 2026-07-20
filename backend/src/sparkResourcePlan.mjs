import { createHash } from "node:crypto";


export const SPARK_EXECUTOR_INSTANCES_MAX = 4;


function configurationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  error.status = 500;
  return error;
}


export function sparkExecutorInstances(environment = process.env) {
  const raw = environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > SPARK_EXECUTOR_INSTANCES_MAX
  ) {
    throw configurationError(
      "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES "
      + `must be an integer between 1 and ${SPARK_EXECUTOR_INSTANCES_MAX}.`,
    );
  }
  return parsed;
}


export function sparkKubernetesResourcePlan(resourcePlan, environment = process.env) {
  const baselineExecutors = sparkExecutorInstances(environment);
  if (resourcePlan === undefined || resourcePlan === null) {
    return { annotations: {}, appliedExecutors: baselineExecutors };
  }
  if (!resourcePlan || typeof resourcePlan !== "object" || Array.isArray(resourcePlan)) {
    throw configurationError("Spark Resource Plan must be an object.");
  }
  const mode = String(resourcePlan.mode || "").trim();
  const planHash = String(resourcePlan.planHash || "").trim();
  const calculatedExecutors = Number(resourcePlan.calculatedExecutors);
  const recommendedExecutors = Number(resourcePlan.recommendedExecutors);
  const persistedBaselineExecutors = Number(resourcePlan.baselineExecutors);
  const appliedExecutors = sparkExecutorInstances({
    ...environment,
    ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: resourcePlan.appliedExecutors,
  });
  if (!new Set(["off", "shadow", "enforce"]).has(mode)) {
    throw configurationError("Spark Resource Plan mode is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(planHash)) {
    throw configurationError("Spark Resource Plan hash is invalid.");
  }
  const canonicalPlan = Object.fromEntries(
    Object.entries(resourcePlan)
      .filter(([key]) => key !== "planHash")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  const calculatedHash = createHash("sha256")
    .update(JSON.stringify(canonicalPlan))
    .digest("hex");
  if (calculatedHash !== planHash) {
    throw configurationError("Spark Resource Plan hash does not match its canonical payload.");
  }
  if (
    !Number.isSafeInteger(calculatedExecutors)
    || calculatedExecutors < 1
    || !Number.isSafeInteger(recommendedExecutors)
    || recommendedExecutors < 1
  ) {
    throw configurationError("Spark Resource Plan executor counts are invalid.");
  }
  if (persistedBaselineExecutors !== baselineExecutors) {
    throw configurationError("Spark Resource Plan baseline does not match the configured executor count.");
  }
  const policyVersion = Number(resourcePlan.policyVersion);
  if (![1, 2].includes(policyVersion)) {
    throw configurationError("Spark Resource Plan policy version is unsupported.");
  }
  if (policyVersion === 2) {
    validateV2ResourcePlan(resourcePlan, environment);
  }
  const decisionStatus = String(resourcePlan.decisionStatus || "planned");
  const expectedExecutors = (
    mode === "enforce" && decisionStatus === "planned"
      ? recommendedExecutors
      : baselineExecutors
  );
  if (appliedExecutors !== expectedExecutors) {
    throw configurationError("Spark Resource Plan applied executor count violates its mode or fallback.");
  }
  return {
    annotations: {
      "asklake.io/applied-executors": String(appliedExecutors),
      "asklake.io/calculated-executors": String(calculatedExecutors),
      "asklake.io/executor-profile": String(resourcePlan.executorProfileName || "legacy"),
      "asklake.io/recommended-executors": String(recommendedExecutors),
      "asklake.io/resource-plan-hash": planHash,
      "asklake.io/resource-plan-mode": mode,
      "asklake.io/resource-policy": String(resourcePlan.policyName || "legacy"),
    },
    appliedExecutors,
  };
}


function validateV2ResourcePlan(resourcePlan, environment) {
  if (resourcePlan.policyName !== "balanced-v1") {
    throw configurationError("Spark Resource Plan policy is invalid.");
  }
  if (resourcePlan.policyTargetCompletionSeconds !== 1800) {
    throw configurationError("Spark Resource Plan target completion time is invalid.");
  }
  if (
    resourcePlan.targetPartitionBytes !== 134_217_728
    || resourcePlan.targetPartitionsPerExecutor !== 384
  ) {
    throw configurationError("Spark Resource Plan balanced-v1 partition budget is invalid.");
  }
  if (!new Set(["planned", "fallback"]).has(resourcePlan.decisionStatus)) {
    throw configurationError("Spark Resource Plan decision status is invalid.");
  }
  const candidates = resourcePlan.executorCandidates;
  if (
    !Array.isArray(candidates)
    || JSON.stringify(candidates) !== JSON.stringify([1, 2, 4])
    || resourcePlan.minExecutors !== 1
    || resourcePlan.maxExecutors !== 4
  ) {
    throw configurationError("Spark Resource Plan executor candidates are invalid.");
  }
  const cores = Number(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES || 2);
  const actualProfile = {
    executorCores: cores,
    executorCpuLimit: String(
      environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT || cores,
    ),
    executorCpuRequest: String(
      environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST || cores,
    ),
    executorMemory: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY || "4g"),
    executorMemoryOverhead: String(
      environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD || "1g",
    ),
  };
  for (const [key, actual] of Object.entries(actualProfile)) {
    if (resourcePlan[key] !== actual) {
      throw configurationError(`Spark Resource Plan ${key} does not match the configured executor profile.`);
    }
  }
  if (
    resourcePlan.decisionStatus === "planned"
    && resourcePlan.executorProfileName !== "standard-v1"
  ) {
    throw configurationError("Planned Spark Resource Plan must use standard-v1.");
  }
  if (
    resourcePlan.decisionStatus === "planned"
    && !candidates.includes(resourcePlan.recommendedExecutors)
  ) {
    throw configurationError("Planned Spark Resource Plan recommendation is outside its candidates.");
  }
  if (
    resourcePlan.decisionStatus === "fallback"
    && resourcePlan.recommendedExecutors !== resourcePlan.baselineExecutors
  ) {
    throw configurationError("Fallback Spark Resource Plan must preserve its baseline recommendation.");
  }
}
