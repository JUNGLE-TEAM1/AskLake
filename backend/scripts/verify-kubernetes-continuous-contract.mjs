import assert from "node:assert/strict";
import test from "node:test";

import {
  continuousSparkApplication,
} from "./manage-kafka-continuous.mjs";
import {
  sparkApplicationState,
  waitForKubernetesWorkerDeletion,
} from "./spark-kubernetes-client.mjs";

const request = {
  broker: "redpanda:9092",
  checkpointPath: "s3a://asklake-output/checkpoints/job-k8s-contract",
  consumerGroupId: "asklake-k8s-contract",
  icebergTarget: {
    catalog: "iceberg",
    namespace: "asklake",
    partitionColumns: [],
    table: "reviews_k8s_contract",
    tableUri: "iceberg://iceberg/asklake/reviews_k8s_contract",
    writeMode: "append",
  },
  initialCounts: {},
  initialMetrics: {},
  initialOffsetPolicy: "earliest",
  initialSchemaState: {},
  jobId: "job-k8s-contract",
  maxOffsetsPerTrigger: 100,
  outputPath: "s3a://asklake-output/reviews_k8s_contract/bronze",
  ruleFingerprint: "rules-k8s-contract-v1",
  ruleOutputSchema: [],
  rules: [],
  schemaColumns: [],
  schemaEvolutionPolicy: {},
  topic: "reviews.k8s.contract",
  triggerIntervalSeconds: 5,
};

test("Kubernetes Continuous SparkApplication keeps JDBC credentials in Secret refs", () => {
  const saved = captureEnvironment([
    "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
    "TRINO_ICEBERG_JDBC_USER",
    "TRINO_ICEBERG_JDBC_PASSWORD",
    "TRINO_ICEBERG_WAREHOUSE_BUCKET",
  ]);
  Object.assign(process.env, {
    ASKLAKE_SPARK_ICEBERG_JDBC_URL: "jdbc:postgresql://postgres:5432/asklake",
    TRINO_ICEBERG_JDBC_USER: "contract-user",
    TRINO_ICEBERG_JDBC_PASSWORD: "K8S_SECRET_SENTINEL",
    TRINO_ICEBERG_WAREHOUSE_BUCKET: "asklake-warehouse",
  });
  try {
    const application = continuousSparkApplication(request, {
      image: "registry/asklake-spark@sha256:1234",
      namespace: "asklake-dev",
      serviceAccount: "asklake-spark",
    }, "attempt-1", {
      ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX: "s3a://asklake-runtime/continuous",
      ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET_NAME: "asklake-spark-runtime",
      ASKLAKE_SPARK_KUBERNETES_NODE_SELECTOR: '{"asklake.io/workload-class":"spark"}',
      ASKLAKE_SPARK_KUBERNETES_TOLERATIONS: '[{"key":"asklake.io/workload","operator":"Equal","value":"spark","effect":"NoSchedule"}]',
    });
    const serialized = JSON.stringify(application);
    const password = application.spec.driver.env.find((entry) => entry.name === "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD");

    assert.equal(password.value, undefined);
    assert.deepEqual(password.valueFrom, {
      secretKeyRef: { name: "asklake-spark-runtime", key: "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD" },
    });
    assert.equal(serialized.includes("K8S_SECRET_SENTINEL"), false);
    assert.equal(application.spec.hadoopConf["fs.s3a.aws.credentials.provider"], "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider");
    assert.equal(application.spec.driver.nodeSelector["asklake.io/workload-class"], "spark");
    assert.equal(application.spec.executor.tolerations[0].effect, "NoSchedule");
    assert.equal(application.spec.driver.env.find((entry) => entry.name === "ASKLAKE_KAFKA_AUTH_MODE")?.value, "none");
    assert.equal(application.spec.deps.jars, undefined);
  } finally {
    restoreEnvironment(saved);
  }
});

test("Kubernetes Continuous MSK IAM is image-local and fails closed on a different JAR", () => {
  const saved = captureEnvironment([
    "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
    "TRINO_ICEBERG_JDBC_USER",
    "TRINO_ICEBERG_JDBC_PASSWORD",
    "TRINO_ICEBERG_WAREHOUSE_BUCKET",
  ]);
  Object.assign(process.env, {
    ASKLAKE_SPARK_ICEBERG_JDBC_URL: "jdbc:postgresql://postgres:5432/asklake",
    TRINO_ICEBERG_JDBC_USER: "contract-user",
    TRINO_ICEBERG_JDBC_PASSWORD: "contract-password",
    TRINO_ICEBERG_WAREHOUSE_BUCKET: "asklake-warehouse",
  });
  const environment = {
    ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX: "s3a://asklake-runtime/continuous",
    ASKLAKE_KAFKA_AUTH_MODE: "iam",
    ASKLAKE_SPARK_MSK_IAM_AUTH_JAR: "local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar",
  };
  try {
    const application = continuousSparkApplication({
      ...request,
      broker: "b-1.example:9098,b-2.example:9098",
    }, {
      image: "registry/asklake-spark@sha256:1234",
      namespace: "asklake-dev",
      serviceAccount: "asklake-spark",
    }, "attempt-msk-iam", environment);

    assert.deepEqual(application.spec.deps.jars, [
      "local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar",
    ]);
    assert.equal(
      application.spec.driver.env.find((entry) => entry.name === "ASKLAKE_KAFKA_AUTH_MODE")?.value,
      "iam",
    );
    assert.throws(
      () => continuousSparkApplication({
        ...request,
        broker: "b-1.example:9098,b-2.example:9098",
      }, {
        image: "registry/asklake-spark@sha256:1234",
        namespace: "asklake-dev",
        serviceAccount: "asklake-spark",
      }, "attempt-invalid-jar", {
        ...environment,
        ASKLAKE_SPARK_MSK_IAM_AUTH_JAR: "s3a://runtime-jars/unreviewed.jar",
      }),
      /requires local:\/\/\/opt\/asklake\/jars\/aws-msk-iam-auth/,
    );
  } finally {
    restoreEnvironment(saved);
  }
});

test("Kubernetes completed state is the shared exited terminal state", () => {
  assert.equal(sparkApplicationState({ status: { applicationState: { state: "COMPLETED" } } }), "exited");
});

test("Kubernetes terminate waits until the SparkApplication is absent", async () => {
  const observations = [
    { metadata: { name: "asklake-continuous-job-delete" } },
    { metadata: { name: "asklake-continuous-job-delete" } },
    null,
  ];
  const sleeps = [];
  await waitForKubernetesWorkerDeletion(
    {
      async get() {
        return observations.shift();
      },
    },
    "asklake-continuous-job-delete",
    {
      maxAttempts: 3,
      pollIntervalMs: 25,
      sleepFn: async (milliseconds) => sleeps.push(milliseconds),
    },
  );
  assert.deepEqual(sleeps, [25, 25]);
});

test("Kubernetes terminate fails closed while the SparkApplication remains", async () => {
  await assert.rejects(
    waitForKubernetesWorkerDeletion(
      {
        async get() {
          return { metadata: { name: "asklake-continuous-job-stuck" } };
        },
      },
      "asklake-continuous-job-stuck",
      {
        maxAttempts: 2,
        pollIntervalMs: 1,
        sleepFn: async () => undefined,
      },
    ),
    /still exists after terminate/,
  );
});

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
