import assert from "node:assert/strict";
import test from "node:test";

import {
  createKubernetesClient,
  kubernetesRuntimeConfig,
  sparkApplicationName,
  sparkApplicationState,
} from "./spark-kubernetes-client.mjs";

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
