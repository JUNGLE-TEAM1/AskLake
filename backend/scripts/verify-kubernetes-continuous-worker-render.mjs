import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(os.tmpdir(), "asklake-k8s-worker-"));
const output = path.join(directory, "worker.yaml");
try {
  const result = spawnSync(process.execPath, ["scripts/render-kubernetes-continuous-worker.mjs", "--output", output], {
    cwd: backendDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ASKLAKE_K8S_NAMESPACE: "asklake-dev",
      ASKLAKE_BACKEND_IMAGE: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/backend@sha256:abc123",
      ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX: "s3a://asklake-runtime-dev/continuous",
      ASKLAKE_SPARK_KUBERNETES_IMAGE: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/spark@sha256:def456",
      ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: "asklake-spark",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const rendered = readFileSync(output, "utf8");
  assert.match(rendered, /name: asklake-continuous-worker/);
  assert.match(rendered, /serviceAccountName: asklake-backend/);
  assert.match(rendered, /ASKLAKE_CONTINUOUS_SPARK_RUNNER/);
  assert.equal(rendered.includes("${"), false);
  console.log("Kubernetes Continuous worker manifest rendering verified.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
