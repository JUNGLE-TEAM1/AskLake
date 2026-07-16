import assert from "node:assert/strict";
import test from "node:test";

import { kafkaSecurityOptions } from "../src/kafka-codecs.mjs";
import {
  createSparkKubernetesApplication,
  SPARK_MSK_IAM_SHADED_JAR,
  sparkDependencyJars,
  sparkExecutionMode,
  sparkKafkaFixtureEnvironment,
  sparkJobManifest,
  sparkKubernetesApplicationName,
  sparkPackages,
  sparkSourceFromJob,
} from "../src/sparkRunner.mjs";
import {
  createOrRecoverApplication,
  submitAndWait,
} from "./spark-kubernetes-client.mjs";

const RUN_ID = "run/with a long unsafe identity that should remain deterministic across replicas-001";
const JOB_ID = "job-001";
const IMAGE = `example.invalid/spark@sha256:${"a".repeat(64)}`;

function applicationFixture() {
  return createSparkKubernetesApplication({
    appName: "asklake-test",
    environmentVariables: {
      ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
      ASKLAKE_SPARK_JOB_MANIFEST_JSON: JSON.stringify({ jobId: JOB_ID }),
      ASKLAKE_SPARK_RUN_ID: RUN_ID,
      AWS_REGION: "ap-northeast-2",
    },
    jobId: JOB_ID,
    packages: ["org.postgresql:postgresql:42.7.7"],
    runId: RUN_ID,
  }, {
    APP_ENV: "production",
    ASKLAKE_SPARK_KUBERNETES_IMAGE: IMAGE,
    ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_LIMIT: "2",
    ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_REQUEST: "500m",
    ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
    ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "1500m",
    ASKLAKE_SPARK_KUBERNETES_NAMESPACE: "asklake-dev",
    ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET: "asklake-spark-runtime",
    ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
    AWS_REGION: "ap-northeast-2",
  });
}

test("Kubernetes Spark application uses deterministic identity and Secret references", () => {
  const first = applicationFixture();
  const second = applicationFixture();
  assert.equal(first.metadata.name, second.metadata.name);
  assert.equal(first.metadata.name, sparkKubernetesApplicationName(RUN_ID));
  assert.match(first.metadata.name, /^asklake-run-[a-z0-9-]+$/);
  assert.ok(first.metadata.name.length <= 63);
  assert.equal(first.metadata.annotations["asklake.io/run-id"], RUN_ID);
  assert.equal(first.spec.image, IMAGE);
  assert.equal(first.spec.driver.serviceAccount, "asklake-spark");
  assert.equal(first.spec.executor.serviceAccount, "asklake-spark");
  assert.equal(first.spec.driver.coreRequest, "500m");
  assert.equal(first.spec.driver.coreLimit, "2");
  assert.equal(first.spec.executor.coreRequest, "1500m");
  assert.equal(first.spec.executor.coreLimit, "3");
  assert.equal(first.spec.sparkConf["spark.jars.ivy"], "/tmp/.ivy2");
  const expectedPlacement = {
    nodeSelector: {
      "asklake.io/workload-class": "spark",
      "kubernetes.io/arch": "amd64",
    },
    tolerations: [{
      effect: "NoSchedule",
      key: "asklake.io/workload-class",
      operator: "Equal",
      value: "spark",
    }],
  };
  assert.deepEqual(first.spec.driver.nodeSelector, expectedPlacement.nodeSelector);
  assert.deepEqual(first.spec.driver.tolerations, expectedPlacement.tolerations);
  assert.deepEqual(first.spec.executor.nodeSelector, expectedPlacement.nodeSelector);
  assert.deepEqual(first.spec.executor.tolerations, expectedPlacement.tolerations);
  const jdbcPassword = first.spec.driver.env.find((item) => item.name === "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD");
  assert.deepEqual(jdbcPassword.valueFrom.secretKeyRef, {
    key: "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD",
    name: "asklake-spark-runtime",
  });
  assert.equal("value" in jdbcPassword, false);
  assert.equal(JSON.stringify(first).includes("replace-with-secret"), false);
});

test("MSK IAM dependency is image-local, Kafka-only, and absent from Maven packages", () => {
  const environment = {
    ASKLAKE_KAFKA_AUTH_MODE: "iam",
    ASKLAKE_SPARK_MSK_IAM_AUTH_JAR: SPARK_MSK_IAM_SHADED_JAR,
  };
  assert.deepEqual(sparkDependencyJars({ format: "jsonl" }, "kubernetes", environment), []);
  assert.deepEqual(
    sparkDependencyJars({ format: "kafka" }, "kubernetes", environment),
    [SPARK_MSK_IAM_SHADED_JAR],
  );
  assert.deepEqual(sparkDependencyJars({ format: "kafka" }, "docker", environment), []);

  const kafkaApplication = createSparkKubernetesApplication({
    appName: "asklake-kafka-test",
    environmentVariables: { ASKLAKE_SPARK_SOURCE_FORMAT: "kafka" },
    jars: sparkDependencyJars({ format: "kafka" }, "kubernetes", environment),
    jobId: JOB_ID,
    packages: ["org.apache.hadoop:hadoop-aws:3.4.1"],
    runId: "run-kafka-001",
  }, {
    ASKLAKE_SPARK_KUBERNETES_IMAGE: IMAGE,
    ASKLAKE_SPARK_KUBERNETES_NAMESPACE: "asklake-dev",
    ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
  });
  assert.deepEqual(kafkaApplication.spec.deps.jars, [SPARK_MSK_IAM_SHADED_JAR]);
  assert.equal(kafkaApplication.spec.deps.packages.some((item) => item.includes("aws-msk-iam-auth")), false);
});

test("persisted fixture boundary is copied into the dynamic SparkApplication", () => {
  const runId = "run-fixture-001";
  const boundary = {
    broker: "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098",
    checkpointPath: `s3a://asklake-dev-output/eks-mvp/checkpoints/${runId}`,
    consumerGroup: "asklake-eks-mvp-spark-v1",
    expectedCount: 100,
    fixtureBatchId: "fixture-batch-001",
    kind: "kafka_snapshot",
    outputPath: `s3a://asklake-dev-output/eks-mvp/output/${runId}`,
    snapshotId: runId,
    topic: "asklake.eks-mvp.fixture.v1",
  };
  const job = {
    id: JOB_ID,
    sourceBoundary: boundary,
    sourceConfig: [["__EKS MVP Fixture Batch ID", "fixture-batch-drifted"]],
    sourceType: "Stream / Kafka",
  };
  const source = sparkSourceFromJob(job, runId);
  assert.deepEqual(source, { format: "kafka", path: boundary.topic });
  const fixtureEnvironment = sparkKafkaFixtureEnvironment(job, source, runId, "kubernetes");
  assert.equal(fixtureEnvironment.ASKLAKE_KAFKA_FIXTURE_BATCH_ID, "fixture-batch-001");
  assert.equal(fixtureEnvironment.ASKLAKE_KAFKA_EXPECTED_COUNT, "100");
  assert.equal(fixtureEnvironment.ASKLAKE_SPARK_CHECKPOINT_PATH, boundary.checkpointPath);

  const packages = sparkPackages(job, source, { sparkPath: boundary.outputPath });
  assert.ok(packages.includes("org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1"));
  const application = createSparkKubernetesApplication({
    appName: "asklake-fixture-test",
    environmentVariables: {
      ...fixtureEnvironment,
      ASKLAKE_SPARK_JOB_MANIFEST_JSON: JSON.stringify(sparkJobManifest(job)),
      ASKLAKE_SPARK_OUTPUT_PATH: boundary.outputPath,
      ASKLAKE_SPARK_RUN_ID: runId,
      ASKLAKE_SPARK_SOURCE_FORMAT: source.format,
      ASKLAKE_SPARK_SOURCE_PATH: source.path,
    },
    jars: [SPARK_MSK_IAM_SHADED_JAR],
    jobId: JOB_ID,
    packages,
    runId,
  }, {
    ASKLAKE_SPARK_KUBERNETES_IMAGE: IMAGE,
    ASKLAKE_SPARK_KUBERNETES_NAMESPACE: "asklake-dev",
    ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
  });

  assert.equal(application.metadata.annotations["asklake.io/fixture-batch-id"], "fixture-batch-001");
  const driverEnvironment = Object.fromEntries(
    application.spec.driver.env
      .filter((item) => Object.hasOwn(item, "value"))
      .map((item) => [item.name, item.value]),
  );
  assert.equal(driverEnvironment.ASKLAKE_KAFKA_TOPIC, boundary.topic);
  assert.equal(driverEnvironment.ASKLAKE_KAFKA_CONSUMER_GROUP, boundary.consumerGroup);
  assert.equal(driverEnvironment.ASKLAKE_SPARK_OUTPUT_PATH, boundary.outputPath);
  assert.deepEqual(
    JSON.parse(driverEnvironment.ASKLAKE_SPARK_JOB_MANIFEST_JSON).sourceBoundary,
    boundary,
  );
});

test("MSK IAM jar rejects remote or arbitrary image paths", () => {
  assert.throws(
    () => sparkDependencyJars({ format: "kafka" }, "kubernetes", {
      ASKLAKE_KAFKA_AUTH_MODE: "iam",
      ASKLAKE_SPARK_MSK_IAM_AUTH_JAR: "https://example.invalid/aws-msk-iam-auth.jar",
    }),
    /must be a local:\/\/\/opt\/asklake\/jars/,
  );
});

test("lost create response recovers the same SparkApplication without another POST", async () => {
  const application = applicationFixture();
  const completed = {
    ...application,
    metadata: { ...application.metadata, uid: "spark-uid-001" },
    status: {
      applicationState: { state: "COMPLETED" },
      driverInfo: { podName: "asklake-driver-001" },
    },
  };
  const calls = [];
  const progress = [];
  const requestJson = async (method, path) => {
    calls.push([method, path]);
    if (method === "POST") throw new Error("simulated response loss");
    if (path.includes("/pods/") && path.includes("/log")) {
      return {
        body: `ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify({ outputPath: "s3a://output/run-001", runId: RUN_ID, status: "success" })}\n`,
        status: 200,
      };
    }
    if (path.includes("/pods/")) {
      return {
        body: {
          status: {
            containerStatuses: [{
              name: "spark-kubernetes-driver",
              state: { terminated: { exitCode: 0, finishedAt: "2026-07-16T02:00:00Z", reason: "Completed" } },
            }],
            phase: "Succeeded",
          },
        },
        status: 200,
      };
    }
    return { body: completed, status: 200 };
  };
  const result = await submitAndWait({
    application,
    delay: async () => undefined,
    now: () => 1_000,
    onProgress: (execution) => progress.push(execution),
    pollIntervalMs: 1,
    requestJson,
    timeoutMs: 1_000,
  });
  assert.equal(calls.filter(([method]) => method === "POST").length, 1);
  assert.equal(result.report.status, "success");
  assert.equal(result.report.kubernetesExecution.applicationUid, "spark-uid-001");
  assert.equal(result.report.kubernetesExecution.recovered, true);
  assert.equal(result.report.kubernetesExecution.namespace, "asklake-dev");
  assert.equal(result.report.kubernetesExecution.runId, RUN_ID);
  assert.equal(result.report.kubernetesExecution.jobId, JOB_ID);
  assert.equal(result.report.kubernetesExecution.driverPodPhase, "Succeeded");
  assert.equal(result.report.kubernetesExecution.driverTerminationReason, "Completed");
  assert.equal(result.report.kubernetesExecution.resultMarkerFound, true);
  assert.equal(progress[0].applicationUid, "spark-uid-001");
  assert.equal(progress.at(-1).resultMarkerFound, true);
});

test("persisted UID recovery reads the existing SparkApplication without POST", async () => {
  const application = applicationFixture();
  const existing = {
    ...application,
    metadata: { ...application.metadata, uid: "spark-uid-persisted-001" },
  };
  const calls = [];
  const result = await createOrRecoverApplication({
    application,
    expectedKubernetesExecution: {
      applicationName: application.metadata.name,
      applicationUid: "spark-uid-persisted-001",
      namespace: application.metadata.namespace,
    },
    requestJson: async (method, path) => {
      calls.push([method, path]);
      return { body: existing, status: 200 };
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.application.metadata.uid, "spark-uid-persisted-001");
  assert.deepEqual(calls.map(([method]) => method), ["GET"]);
});

test("persisted UID recovery refuses replacement when the SparkApplication is gone", async () => {
  const application = applicationFixture();
  const calls = [];

  await assert.rejects(
    createOrRecoverApplication({
      application,
      expectedKubernetesExecution: {
        applicationName: application.metadata.name,
        applicationUid: "spark-uid-deleted-001",
        namespace: application.metadata.namespace,
      },
      requestJson: async (method, path) => {
        calls.push([method, path]);
        return { body: { message: "not found" }, status: 404 };
      },
    }),
    /refusing to create a replacement/,
  );

  assert.deepEqual(calls.map(([method]) => method), ["GET"]);
});

test("persisted UID recovery rejects a same-name replacement before execution", async () => {
  const application = applicationFixture();
  const calls = [];
  const replacement = {
    ...application,
    metadata: { ...application.metadata, uid: "spark-uid-replacement-002" },
  };

  await assert.rejects(
    createOrRecoverApplication({
      application,
      expectedKubernetesExecution: {
        applicationName: application.metadata.name,
        applicationUid: "spark-uid-original-001",
        namespace: application.metadata.namespace,
      },
      requestJson: async (method, path) => {
        calls.push([method, path]);
        return { body: replacement, status: 200 };
      },
    }),
    /UID mismatch/,
  );

  assert.deepEqual(calls.map(([method]) => method), ["GET"]);
});

test("publishes Kubernetes UID before waiting for a non-terminal application", async () => {
  const application = applicationFixture();
  const submitted = {
    ...application,
    metadata: { ...application.metadata, uid: "spark-uid-running-001" },
    status: { applicationState: { state: "SUBMITTED" } },
  };
  const completed = {
    ...submitted,
    status: {
      applicationState: { state: "COMPLETED" },
      driverInfo: { podName: "asklake-driver-running-001" },
    },
  };
  const progress = [];
  const requestJson = async (method, path) => {
    if (method === "POST") return { body: submitted, status: 201 };
    if (path.includes("/pods/") && path.includes("/log")) {
      return {
        body: `ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify({ runId: RUN_ID, status: "success" })}\n`,
        status: 200,
      };
    }
    if (path.includes("/pods/")) return { body: { status: { phase: "Succeeded" } }, status: 200 };
    return { body: completed, status: 200 };
  };

  await submitAndWait({
    application,
    delay: async () => {
      assert.equal(progress.length, 1);
      assert.equal(progress[0].applicationUid, "spark-uid-running-001");
      assert.equal(progress[0].state, "SUBMITTED");
    },
    now: () => 1_000,
    onProgress: (execution) => progress.push(execution),
    pollIntervalMs: 1,
    requestJson,
    timeoutMs: 1_000,
  });

  assert.equal(progress.at(-1).state, "COMPLETED");
  assert.equal(progress.at(-1).resultMarkerFound, true);
});

test("existing deterministic name with another run identity is rejected", async () => {
  const application = applicationFixture();
  const mismatched = {
    ...application,
    metadata: {
      ...application.metadata,
      annotations: { ...application.metadata.annotations, "asklake.io/run-id": "another-run" },
    },
  };
  const requestJson = async (method) => (
    method === "POST" ? { body: {}, status: 409 } : { body: mismatched, status: 200 }
  );
  await assert.rejects(
    createOrRecoverApplication({ application, requestJson }),
    /identity mismatch/,
  );
});

test("submission failure preserves the SparkApplication error when no driver Pod exists", async () => {
  const application = applicationFixture();
  const failed = {
    ...application,
    metadata: { ...application.metadata, uid: "spark-uid-failed-001" },
    status: {
      applicationState: {
        errorMessage: "spark-submit could not write the Ivy cache",
        state: "FAILED",
      },
      driverInfo: { podName: "driver-that-was-never-created" },
    },
  };
  const requestJson = async (method, path) => {
    if (method === "POST") return { body: failed, status: 201 };
    if (path.includes("/pods/") && path.includes("/log")) {
      return { body: { message: "pods not found" }, status: 404 };
    }
    return { body: failed, status: 200 };
  };
  const result = await submitAndWait({
    application,
    delay: async () => undefined,
    now: () => 1_000,
    pollIntervalMs: 1,
    requestJson,
    timeoutMs: 1_000,
  });
  assert.equal(result.logs, "");
  assert.equal(result.report.status, "failed");
  assert.match(result.report.error, /Ivy cache/);
  assert.equal(result.report.kubernetesExecution.state, "FAILED");
});

test("production mode accepts kubernetes but still rejects Docker", () => {
  assert.equal(sparkExecutionMode({ APP_ENV: "production", ASKLAKE_SPARK_RUNNER: "kubernetes" }), "kubernetes");
  assert.throws(
    () => sparkExecutionMode({ APP_ENV: "production", ASKLAKE_SPARK_RUNNER: "docker" }),
    /requires ASKLAKE_SPARK_RUNNER=rest or kubernetes/,
  );
});

test("MSK IAM KafkaJS adapter is TLS OAUTHBEARER and lazy", async () => {
  const options = await kafkaSecurityOptions({
    ASKLAKE_KAFKA_AUTH_MODE: "iam",
    AWS_REGION: "ap-northeast-2",
  });
  assert.equal(options.ssl, true);
  assert.equal(options.sasl.mechanism, "oauthbearer");
  assert.equal(typeof options.sasl.oauthBearerProvider, "function");
});
