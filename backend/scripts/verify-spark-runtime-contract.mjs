import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sparkExecutionMode } from "../src/sparkRunner.mjs";
import {
  createSparkRuntime,
  hasExplicitSparkRuntime,
  resolveSparkRuntime,
  SPARK_RUNTIME_IDS,
  SPARK_RUNTIME_OPERATIONS,
} from "../src/sparkRuntime.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const localDefault = resolveSparkRuntime({});
assert.equal(localDefault.id, SPARK_RUNTIME_IDS.DOCKER);
assert.equal(localDefault.legacyRunner, "docker");
assert.equal(localDefault.configuredBy, "default");
assert.equal(localDefault.explicit, false);
assert.equal(localDefault.remote, false);
assert.equal(localDefault.requiresDockerSocket, true);
assert.deepEqual(localDefault.capabilities, {
  batch: true,
  continuous: true,
  maintenance: true,
  sourceInspect: true,
});
assert(Object.isFrozen(localDefault));
assert(Object.isFrozen(localDefault.capabilities));

const canonicalDocker = resolveSparkRuntime({ ASKLAKE_SPARK_RUNTIME: "docker" });
assert.equal(canonicalDocker.id, SPARK_RUNTIME_IDS.DOCKER);
assert.equal(canonicalDocker.configuredBy, "ASKLAKE_SPARK_RUNTIME");
assert.equal(canonicalDocker.explicit, true);
assert.equal(hasExplicitSparkRuntime({ ASKLAKE_SPARK_RUNTIME: "docker" }), true);

const canonicalRest = resolveSparkRuntime({ ASKLAKE_SPARK_RUNTIME: "SPARK-REST" });
assert.equal(canonicalRest.id, SPARK_RUNTIME_IDS.SPARK_REST);
assert.equal(canonicalRest.legacyRunner, "rest");
assert.equal(canonicalRest.remote, true);
assert.equal(canonicalRest.requiresDockerSocket, false);

const legacyRest = resolveSparkRuntime({ ASKLAKE_SPARK_RUNNER: "rest" });
assert.equal(legacyRest.id, SPARK_RUNTIME_IDS.SPARK_REST);
assert.equal(legacyRest.configuredBy, "ASKLAKE_SPARK_RUNNER");
assert.equal(hasExplicitSparkRuntime({ ASKLAKE_SPARK_RUNNER: "rest" }), true);
assert.equal(hasExplicitSparkRuntime({}), false);

const canonicalEmr = resolveSparkRuntime({ ASKLAKE_SPARK_RUNTIME: "emr-serverless" });
assert.equal(canonicalEmr.id, SPARK_RUNTIME_IDS.EMR_SERVERLESS);
assert.equal(canonicalEmr.legacyRunner, "emr-serverless");
assert.equal(canonicalEmr.remote, true);
assert.equal(canonicalEmr.requiresDockerSocket, false);
assert.deepEqual(canonicalEmr.capabilities, {
  batch: true,
  continuous: false,
  maintenance: false,
  sourceInspect: false,
});

assert.equal(
  resolveSparkRuntime({
    ASKLAKE_SPARK_RUNNER: "rest",
    ASKLAKE_SPARK_RUNTIME: "spark-rest",
  }).id,
  SPARK_RUNTIME_IDS.SPARK_REST,
  "Canonical and legacy aliases with the same meaning must coexist during migration.",
);
assert.equal(sparkExecutionMode({ ASKLAKE_SPARK_RUNTIME: "spark-rest" }), "rest");
assert.equal(sparkExecutionMode({ ASKLAKE_SPARK_RUNTIME: "emr-serverless" }), "emr-serverless");
assert.equal(sparkExecutionMode({ ASKLAKE_SPARK_RUNNER: "docker" }), "docker");

assert.equal(
  resolveSparkRuntime({ APP_ENV: "production", ASKLAKE_SPARK_RUNTIME: "spark-rest" }).id,
  SPARK_RUNTIME_IDS.SPARK_REST,
);
assert.equal(
  resolveSparkRuntime({ APP_ENV: "production", ASKLAKE_SPARK_RUNNER: "rest" }).id,
  SPARK_RUNTIME_IDS.SPARK_REST,
);
assert.equal(
  resolveSparkRuntime({ APP_ENV: "production", ASKLAKE_SPARK_RUNTIME: "emr-serverless" }).id,
  SPARK_RUNTIME_IDS.EMR_SERVERLESS,
);

for (const environment of [
  { ASKLAKE_SPARK_RUNNER: "emr" },
  { ASKLAKE_SPARK_RUNNER: "docker", ASKLAKE_SPARK_RUNTIME: "spark-rest" },
  { APP_ENV: "production" },
  { APP_ENV: "production", ASKLAKE_SPARK_RUNTIME: "docker" },
]) {
  assert.throws(
    () => resolveSparkRuntime(environment),
    (error) => error?.code === "SPARK_RUNNER_CONFIGURATION_INVALID" && error?.status === 500,
    `Invalid runtime configuration must fail closed: ${JSON.stringify(environment)}`,
  );
}

const dispatchTrace = [];
const dockerRuntime = createSparkRuntime(
  { ASKLAKE_SPARK_RUNTIME: "docker" },
  {
    [SPARK_RUNTIME_IDS.DOCKER]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: (payload, definition) => {
        dispatchTrace.push(`${definition.id}:${payload.runId}`);
        return "docker-result";
      },
    },
    [SPARK_RUNTIME_IDS.SPARK_REST]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: () => "unexpected-rest-result",
    },
  },
);
assert.equal(
  dockerRuntime.execute(SPARK_RUNTIME_OPERATIONS.BATCH, { runId: "run-docker" }),
  "docker-result",
);

const restRuntime = createSparkRuntime(
  { ASKLAKE_SPARK_RUNTIME: "spark-rest" },
  {
    [SPARK_RUNTIME_IDS.DOCKER]: {
      [SPARK_RUNTIME_OPERATIONS.CONTINUOUS]: () => "unexpected-docker-result",
    },
    [SPARK_RUNTIME_IDS.SPARK_REST]: {
      [SPARK_RUNTIME_OPERATIONS.CONTINUOUS]: (payload, definition) => {
        dispatchTrace.push(`${definition.id}:${payload.action}`);
        return Promise.resolve("rest-result");
      },
    },
  },
);
assert.equal(
  await restRuntime.execute(SPARK_RUNTIME_OPERATIONS.CONTINUOUS, { action: "status" }),
  "rest-result",
);

const emrRuntime = createSparkRuntime(
  { ASKLAKE_SPARK_RUNTIME: "emr-serverless" },
  {
    [SPARK_RUNTIME_IDS.EMR_SERVERLESS]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: (payload, definition) => {
        dispatchTrace.push(`${definition.id}:${payload.runId}`);
        return "emr-result";
      },
    },
  },
);
assert.equal(
  emrRuntime.execute(SPARK_RUNTIME_OPERATIONS.BATCH, { runId: "run-emr" }),
  "emr-result",
);
assert.throws(
  () => emrRuntime.execute(SPARK_RUNTIME_OPERATIONS.CONTINUOUS, {}),
  (error) => error?.code === "SPARK_RUNTIME_OPERATION_UNAVAILABLE",
);
assert.deepEqual(dispatchTrace, ["docker:run-docker", "spark-rest:status", "emr-serverless:run-emr"]);

assert.throws(
  () => createSparkRuntime({ ASKLAKE_SPARK_RUNTIME: "docker" }).execute(
    SPARK_RUNTIME_OPERATIONS.MAINTENANCE,
    {},
  ),
  (error) => error?.code === "SPARK_RUNTIME_OPERATION_UNAVAILABLE",
  "A missing adapter must not fall back to another runtime.",
);
assert.throws(
  () => dockerRuntime.execute("unknown-operation", {}),
  (error) => error?.code === "SPARK_RUNTIME_OPERATION_UNAVAILABLE",
);

const migratedPaths = new Map([
  ["src/sparkRunner.mjs", SPARK_RUNTIME_OPERATIONS.BATCH],
  ["src/connectors.mjs", SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT],
  ["scripts/manage-kafka-continuous.mjs", SPARK_RUNTIME_OPERATIONS.CONTINUOUS],
  ["scripts/manage-kafka-continuous-maintenance.mjs", SPARK_RUNTIME_OPERATIONS.MAINTENANCE],
]);
for (const [relativePath, operation] of migratedPaths) {
  const source = readFileSync(path.join(backendDir, relativePath), "utf8");
  assert.match(source, /createSparkRuntime/, `${relativePath} must select the common Spark Runtime.`);
  assert.match(
    source,
    new RegExp(`SPARK_RUNTIME_OPERATIONS\\.${constantNameForOperation(operation)}`),
    `${relativePath} must dispatch the ${operation} operation through the common Runtime.`,
  );
}

console.log(
  "Spark Runtime contract verified: canonical/legacy selection, production guard, capabilities, and four operation dispatch paths.",
);

function constantNameForOperation(operation) {
  return Object.entries(SPARK_RUNTIME_OPERATIONS)
    .find(([, value]) => value === operation)?.[0] || "UNKNOWN";
}
