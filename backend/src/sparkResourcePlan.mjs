import { createHash } from "node:crypto";


export const SPARK_EXECUTOR_INSTANCES_MAX = 6;


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
  if (mode === "enforce" && appliedExecutors !== recommendedExecutors) {
    throw configurationError("Enforcing Spark Resource Plan must apply its recommended executor count.");
  }
  if (mode !== "enforce" && appliedExecutors !== baselineExecutors) {
    throw configurationError("Non-enforcing Spark Resource Plan must preserve the configured executor count.");
  }
  return {
    annotations: {
      "asklake.io/applied-executors": String(appliedExecutors),
      "asklake.io/calculated-executors": String(calculatedExecutors),
      "asklake.io/resource-plan-hash": planHash,
      "asklake.io/resource-plan-mode": mode,
    },
    appliedExecutors,
  };
}
