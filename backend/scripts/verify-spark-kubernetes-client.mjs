import assert from "node:assert/strict";
import test from "node:test";

import {
  createKubernetesClient,
  kubernetesRuntimeConfig,
  sparkApplicationName,
  sparkApplicationState,
} from "./spark-kubernetes-client.mjs";
import { createSparkKubernetesApplication } from "../src/sparkKubernetesRunner.mjs";
import { sparkExecutionMode } from "../src/sparkRunner.mjs";

test("Kubernetes Continuous config requires a digest-pinned image", () => {
  assert.throws(
    () => kubernetesRuntimeConfig({
      ASKLAKE_SPARK_KUBERNETES_NAMESPACE: "asklake-dev",
      ASKLAKE_SPARK_KUBERNETES_IMAGE: "repo/asklake-spark:latest",
      ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
    }),
    /pinned by digest/,
  );
});

test("SparkApplication client uses the namespace resource path and treats 404 as absent", async () => {
  const calls = [];
  const client = createKubernetesClient({
    apiServer: "https://kubernetes.example",
    namespace: "asklake-dev",
  }, async (_config, method, resourcePath, payload) => {
    calls.push({ method, payload, resourcePath });
    if (method === "GET") {
      const error = new Error("not found");
      error.statusCode = 404;
      throw error;
    }
    return { metadata: { name: "stream-1" } };
  });

  assert.equal(await client.get("stream-1"), null);
  await client.create({ metadata: { name: "stream-1" } });
  await client.delete("stream-1");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "DELETE"]);
  assert.match(calls[1].resourcePath, /namespaces\/asklake-dev\/sparkapplications$/);
  assert.match(calls[2].resourcePath, /sparkapplications\/stream-1$/);
});

test("SparkApplication names and states are normalized for runtime reconciliation", () => {
  assert.equal(sparkApplicationName("Job With Spaces / 1"), "asklake-continuous-job-with-spaces-1");
  assert.equal(sparkApplicationState({ status: { applicationState: { state: "RUNNING" } } }), "running");
  assert.equal(sparkApplicationState({ status: { applicationState: { state: "COMPLETED" } } }), "exited");
  assert.equal(sparkApplicationState({ status: { applicationState: { state: "FAILED" } } }), "failed");
  assert.equal(sparkApplicationState(null), "starting");
});

test("Production batch runner accepts Kubernetes and renders a digest-pinned SparkApplication", () => {
  const environment = {
    APP_ENV: "production",
    ASKLAKE_SPARK_KUBERNETES_IMAGE: "registry.example/asklake-spark@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ASKLAKE_SPARK_KUBERNETES_NAMESPACE: "asklake-dev",
    ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
    ASKLAKE_SPARK_RUNNER: "kubernetes",
  };
  assert.equal(sparkExecutionMode(environment), "kubernetes");
  const application = createSparkKubernetesApplication({
    appName: "asklake-batch-job",
    environmentVariables: {
      ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD: "must-not-be-rendered",
      ASKLAKE_SPARK_ICEBERG_JDBC_URL: "must-not-be-rendered",
      ASKLAKE_SPARK_ICEBERG_JDBC_USER: "must-not-be-rendered",
      ASKLAKE_SPARK_JOB_MANIFEST_JSON: JSON.stringify({ jobId: "job-contract" }),
    },
    jobId: "job-contract",
    runId: "run-contract",
  }, environment);
  assert.equal(application.metadata.namespace, "asklake-dev");
  assert.match(application.spec.image, /@sha256:/);
  assert.equal(application.spec.driver.serviceAccount, "asklake-spark");
  assert.equal(application.spec.driver.env.find((item) => item.name === "ASKLAKE_SPARK_JOB_MANIFEST_JSON")?.value, '{"jobId":"job-contract"}');
  for (const name of [
    "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD",
    "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
    "ASKLAKE_SPARK_ICEBERG_JDBC_USER",
  ]) {
    const matching = application.spec.driver.env.filter((item) => item.name === name);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].value, undefined);
    assert.equal(matching[0].valueFrom.secretKeyRef.name, "asklake-spark-runtime");
  }
});
