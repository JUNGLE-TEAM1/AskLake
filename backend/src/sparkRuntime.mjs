export const SPARK_RUNTIME_IDS = Object.freeze({
  DOCKER: "docker",
  EMR_SERVERLESS: "emr-serverless",
  SPARK_REST: "spark-rest",
});

export const SPARK_RUNTIME_OPERATIONS = Object.freeze({
  BATCH: "batch",
  CONTINUOUS: "continuous",
  MAINTENANCE: "maintenance",
  SOURCE_INSPECT: "sourceInspect",
});

const runtimeDefinitions = Object.freeze({
  [SPARK_RUNTIME_IDS.DOCKER]: Object.freeze({
    capabilities: Object.freeze({
      [SPARK_RUNTIME_OPERATIONS.BATCH]: true,
      [SPARK_RUNTIME_OPERATIONS.CONTINUOUS]: true,
      [SPARK_RUNTIME_OPERATIONS.MAINTENANCE]: true,
      [SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT]: true,
    }),
    id: SPARK_RUNTIME_IDS.DOCKER,
    legacyRunner: "docker",
    remote: false,
    requiresDockerSocket: true,
  }),
  [SPARK_RUNTIME_IDS.SPARK_REST]: Object.freeze({
    capabilities: Object.freeze({
      [SPARK_RUNTIME_OPERATIONS.BATCH]: true,
      [SPARK_RUNTIME_OPERATIONS.CONTINUOUS]: true,
      [SPARK_RUNTIME_OPERATIONS.MAINTENANCE]: true,
      [SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT]: true,
    }),
    id: SPARK_RUNTIME_IDS.SPARK_REST,
    legacyRunner: "rest",
    remote: true,
    requiresDockerSocket: false,
  }),
  [SPARK_RUNTIME_IDS.EMR_SERVERLESS]: Object.freeze({
    capabilities: Object.freeze({
      [SPARK_RUNTIME_OPERATIONS.BATCH]: true,
      [SPARK_RUNTIME_OPERATIONS.CONTINUOUS]: false,
      [SPARK_RUNTIME_OPERATIONS.MAINTENANCE]: false,
      [SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT]: false,
    }),
    id: SPARK_RUNTIME_IDS.EMR_SERVERLESS,
    legacyRunner: "emr-serverless",
    remote: true,
    requiresDockerSocket: false,
  }),
});

const supportedOperations = new Set(Object.values(SPARK_RUNTIME_OPERATIONS));

export function resolveSparkRuntime(environment = process.env) {
  const canonical = canonicalRuntimeId(environment.ASKLAKE_SPARK_RUNTIME);
  const legacy = legacyRuntimeId(environment.ASKLAKE_SPARK_RUNNER);
  if (canonical && legacy && canonical !== legacy) {
    throw sparkRuntimeConfigurationError(
      `Conflicting Spark runtime configuration: ASKLAKE_SPARK_RUNTIME=${canonical} `
      + `does not match ASKLAKE_SPARK_RUNNER=${String(environment.ASKLAKE_SPARK_RUNNER).trim()}.`,
    );
  }

  const id = canonical || legacy || SPARK_RUNTIME_IDS.DOCKER;
  const definition = runtimeDefinitions[id];
  if (!definition) {
    throw sparkRuntimeConfigurationError(`Unsupported Spark runtime: ${id}`);
  }

  if (isProductionEnvironment(environment) && !definition.remote) {
    throw sparkRuntimeConfigurationError(
      "Production Spark execution requires ASKLAKE_SPARK_RUNTIME=spark-rest or emr-serverless "
      + "(or legacy ASKLAKE_SPARK_RUNNER=rest); Docker-based submission is not allowed.",
    );
  }

  return Object.freeze({
    ...definition,
    configuredBy: canonical
      ? "ASKLAKE_SPARK_RUNTIME"
      : legacy
        ? "ASKLAKE_SPARK_RUNNER"
        : "default",
    explicit: Boolean(canonical || legacy),
  });
}

export function createSparkRuntime(environment = process.env, adapters = {}) {
  const definition = resolveSparkRuntime(environment);
  return Object.freeze({
    ...definition,
    execute(operation, payload) {
      const normalizedOperation = normalizeOperation(operation);
      if (!definition.capabilities[normalizedOperation]) {
        throw sparkRuntimeOperationError(
          `Spark runtime ${definition.id} does not support operation ${normalizedOperation}.`,
        );
      }
      const handler = adapters?.[definition.id]?.[normalizedOperation];
      if (typeof handler !== "function") {
        throw sparkRuntimeOperationError(
          `Spark runtime ${definition.id} has no adapter for operation ${normalizedOperation}.`,
        );
      }
      return handler(payload, definition);
    },
  });
}

export function hasExplicitSparkRuntime(environment = process.env) {
  return Boolean(
    String(environment.ASKLAKE_SPARK_RUNTIME || "").trim()
    || String(environment.ASKLAKE_SPARK_RUNNER || "").trim(),
  );
}

function canonicalRuntimeId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (Object.hasOwn(runtimeDefinitions, normalized)) return normalized;
  throw sparkRuntimeConfigurationError(
    `Unsupported ASKLAKE_SPARK_RUNTIME value: ${normalized}. Expected docker, spark-rest, or emr-serverless.`,
  );
}

function legacyRuntimeId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "docker") return SPARK_RUNTIME_IDS.DOCKER;
  if (normalized === "rest") return SPARK_RUNTIME_IDS.SPARK_REST;
  throw sparkRuntimeConfigurationError(
    `Unsupported ASKLAKE_SPARK_RUNNER mode: ${normalized}. Expected docker or rest.`,
  );
}

function normalizeOperation(value) {
  const operation = String(value || "").trim();
  if (supportedOperations.has(operation)) return operation;
  throw sparkRuntimeOperationError(`Unsupported Spark runtime operation: ${operation || "(empty)"}.`);
}

function isProductionEnvironment(environment) {
  return [environment.APP_ENV, environment.NODE_ENV]
    .some((value) => ["prod", "production"].includes(String(value || "").trim().toLowerCase()));
}

function sparkRuntimeConfigurationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  error.status = 500;
  return error;
}

function sparkRuntimeOperationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNTIME_OPERATION_UNAVAILABLE";
  error.status = 500;
  return error;
}
