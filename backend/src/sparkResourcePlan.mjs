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
  const canonicalPlan = canonicalizeResourcePlan(
    Object.fromEntries(Object.entries(resourcePlan).filter(([key]) => key !== "planHash")),
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
  if (![1, 2, 3].includes(policyVersion)) {
    throw configurationError("Spark Resource Plan policy version is unsupported.");
  }
  if (policyVersion === 2) {
    validateV2ResourcePlan(resourcePlan, environment);
  } else if (policyVersion === 3) {
    validateV3ResourcePlan(resourcePlan, environment);
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


function canonicalizeResourcePlan(value) {
  if (Array.isArray(value)) return value.map(canonicalizeResourcePlan);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalizeResourcePlan(item)]),
  );
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


function validateV3ResourcePlan(resourcePlan, environment) {
  if (resourcePlan.policyName !== "history-sla-cost-v1") {
    throw configurationError("Spark Resource Plan policy is invalid.");
  }
  if (
    resourcePlan.policyTargetCompletionSeconds !== 1800
    || resourcePlan.costProxy !== "executor_seconds"
    || resourcePlan.slaMetric !== "spark_duration_ms"
    || resourcePlan.modelScalingExponent !== 0.8
  ) {
    throw configurationError("Spark Resource Plan history policy metadata is invalid.");
  }
  if (
    resourcePlan.targetPartitionBytes !== 134_217_728
    || resourcePlan.targetPartitionsPerExecutor !== 384
  ) {
    throw configurationError("Spark Resource Plan seed partition budget is invalid.");
  }
  if (
    !new Set(["planned", "fallback"]).has(resourcePlan.decisionStatus)
    || !new Set(["history_sla_cost", "size_seed", "fallback"]).has(resourcePlan.decisionBasis)
  ) {
    throw configurationError("Spark Resource Plan decision metadata is invalid.");
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
  validateV3HistoryEvidence(resourcePlan, candidates);
  validateExecutorProfile(resourcePlan, environment);
  validateV3Decision(resourcePlan, candidates);
}


function validateV3HistoryEvidence(resourcePlan, candidates) {
  if (
    !Number.isSafeInteger(resourcePlan.historyEvidenceCount)
    || resourcePlan.historyEvidenceCount < 0
    || resourcePlan.historyEvidenceCount > 20
    || !Number.isSafeInteger(resourcePlan.historyComparableCount)
    || resourcePlan.historyComparableCount < 0
    || resourcePlan.historyComparableCount > 20
    || resourcePlan.historyComparableCount > resourcePlan.historyEvidenceCount
  ) {
    throw configurationError("Spark Resource Plan history counts are invalid.");
  }
  if (
    !Array.isArray(resourcePlan.historyRunIds)
    || resourcePlan.historyRunIds.length !== resourcePlan.historyEvidenceCount
    || new Set(resourcePlan.historyRunIds).size !== resourcePlan.historyRunIds.length
    || resourcePlan.historyRunIds.some((runId) => typeof runId !== "string" || !runId.trim())
  ) {
    throw configurationError("Spark Resource Plan history Run identities are invalid.");
  }
  if (
    !Array.isArray(resourcePlan.candidateEvaluations)
    || resourcePlan.candidateEvaluations.length !== candidates.length
  ) {
    throw configurationError("Spark Resource Plan candidate evaluations are invalid.");
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const evaluation = resourcePlan.candidateEvaluations[index];
    if (
      !evaluation
      || typeof evaluation !== "object"
      || evaluation.executors !== candidates[index]
      || !new Set(["measured", "modeled", "unavailable"]).has(evaluation.estimateSource)
      || !Number.isSafeInteger(evaluation.evidenceCount)
      || evaluation.evidenceCount < 0
    ) {
      throw configurationError("Spark Resource Plan candidate evaluation is invalid.");
    }
    const unavailable = evaluation.estimatedDurationMs === null;
    if (unavailable) {
      if (
        evaluation.estimatedExecutorSeconds !== null
        || evaluation.meetsTarget !== null
        || evaluation.evidenceCount !== 0
        || evaluation.estimateSource !== "unavailable"
      ) {
        throw configurationError("Spark Resource Plan unavailable candidate is invalid.");
      }
    } else if (
      !Number.isSafeInteger(evaluation.estimatedDurationMs)
      || evaluation.estimatedDurationMs < 1
      || !Number.isFinite(evaluation.estimatedExecutorSeconds)
      || evaluation.estimatedExecutorSeconds <= 0
      || evaluation.meetsTarget !== (evaluation.estimatedDurationMs <= 1_800_000)
    ) {
      throw configurationError("Spark Resource Plan candidate estimate is invalid.");
    }
  }
}


function validateV3Decision(resourcePlan, candidates) {
  if (resourcePlan.decisionStatus === "planned") {
    if (
      resourcePlan.executorProfileName !== "standard-v1"
      || !candidates.includes(resourcePlan.recommendedExecutors)
      || !new Set(["history_sla_cost", "size_seed"]).has(resourcePlan.decisionBasis)
    ) {
      throw configurationError("Planned Spark Resource Plan is invalid.");
    }
    if (resourcePlan.decisionBasis === "history_sla_cost" && resourcePlan.historyComparableCount < 1) {
      throw configurationError("History-based Spark Resource Plan lacks comparable evidence.");
    }
    if (resourcePlan.decisionBasis === "history_sla_cost") {
      const available = resourcePlan.candidateEvaluations.filter(
        (evaluation) => evaluation.estimatedDurationMs !== null,
      );
      const meetingTarget = available.filter((evaluation) => evaluation.meetsTarget === true);
      const selected = meetingTarget.length > 0
        ? [...meetingTarget].sort((left, right) => (
          left.estimatedExecutorSeconds - right.estimatedExecutorSeconds
          || left.executors - right.executors
        ))[0]
        : [...available].sort((left, right) => right.executors - left.executors)[0];
      if (!selected || selected.executors !== resourcePlan.recommendedExecutors) {
        throw configurationError("History-based Spark Resource Plan recommendation is inconsistent.");
      }
    }
    if (resourcePlan.decisionBasis === "size_seed") {
      const seed = candidates.find(
        (candidate) => candidate >= resourcePlan.calculatedExecutors,
      ) || candidates[candidates.length - 1];
      if (seed !== resourcePlan.recommendedExecutors) {
        throw configurationError("Size-seed Spark Resource Plan recommendation is inconsistent.");
      }
    }
  } else if (
    resourcePlan.recommendedExecutors !== resourcePlan.baselineExecutors
    || resourcePlan.decisionBasis !== "fallback"
  ) {
    throw configurationError("Fallback Spark Resource Plan must preserve its baseline.");
  }
}


function validateExecutorProfile(resourcePlan, environment) {
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
}
