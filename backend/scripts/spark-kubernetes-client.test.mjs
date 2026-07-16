import assert from "node:assert/strict";
import test from "node:test";

import { kafkaSecurityOptions } from "../src/kafka-codecs.mjs";
import {
  createSparkKubernetesApplication,
  sparkExecutionMode,
  sparkKubernetesApplicationName,
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
  const requestJson = async (method, path) => {
    calls.push([method, path]);
    if (method === "POST") throw new Error("simulated response loss");
    if (path.includes("/pods/") && path.includes("/log")) {
      return {
        body: `ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify({ outputPath: "s3a://output/run-001", runId: RUN_ID, status: "success" })}\n`,
        status: 200,
      };
    }
    return { body: completed, status: 200 };
  };
  const result = await submitAndWait({
    application,
    delay: async () => undefined,
    now: () => 1_000,
    pollIntervalMs: 1,
    requestJson,
    timeoutMs: 1_000,
  });
  assert.equal(calls.filter(([method]) => method === "POST").length, 1);
  assert.equal(result.report.status, "success");
  assert.equal(result.report.kubernetesExecution.applicationUid, "spark-uid-001");
  assert.equal(result.report.kubernetesExecution.recovered, true);
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
