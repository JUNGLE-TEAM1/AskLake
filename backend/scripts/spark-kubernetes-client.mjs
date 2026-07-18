import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "SUBMISSION_FAILED", "FAILING", "INVALIDATING"]);
const SUCCESS_STATE = "COMPLETED";
const DEFAULT_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compactText(value, limit = 2_000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function kubernetesApiUrl(environment = process.env) {
  const configured = String(environment.ASKLAKE_KUBERNETES_API_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = String(environment.KUBERNETES_SERVICE_HOST || "").trim();
  const port = String(environment.KUBERNETES_SERVICE_PORT_HTTPS || environment.KUBERNETES_SERVICE_PORT || "443").trim();
  if (!host) throw new Error("KUBERNETES_SERVICE_HOST is required");
  return `https://${host}:${port}`;
}

function serviceAccountToken(environment = process.env) {
  const direct = String(environment.ASKLAKE_KUBERNETES_BEARER_TOKEN || "").trim();
  if (direct) return direct;
  return readFileSync(environment.ASKLAKE_KUBERNETES_TOKEN_FILE || DEFAULT_TOKEN_FILE, "utf8").trim();
}

function kubernetesAgent(environment = process.env) {
  const apiUrl = kubernetesApiUrl(environment);
  if (!apiUrl.startsWith("https://")) return undefined;
  const ca = readFileSync(environment.ASKLAKE_KUBERNETES_CA_FILE || DEFAULT_CA_FILE);
  return new https.Agent({ ca, rejectUnauthorized: true });
}

export function createKubernetesRequest(environment = process.env) {
  const baseUrl = kubernetesApiUrl(environment);
  const token = serviceAccountToken(environment);
  const agent = kubernetesAgent(environment);
  return async function requestJson(method, path, { body, timeoutMs = 15_000 } = {}) {
    const target = new URL(path, `${baseUrl}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const request = https.request(target, {
        agent,
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload), "Content-Type": "application/json" } : {}),
        },
        timeout: timeoutMs,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = String(response.headers["content-type"] || "");
          let parsed = text;
          if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              parsed = text;
            }
          }
          resolve({ body: parsed, status: Number(response.statusCode || 0), text });
        });
      });
      request.on("timeout", () => request.destroy(new Error(`Kubernetes API ${method} ${path} timed out`)));
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  };
}

function apiError(operation, response) {
  const reason = response?.body?.message || response?.body?.reason || response?.text || `HTTP ${response?.status || 0}`;
  const error = new Error(`${operation} failed: ${compactText(reason)}`);
  error.status = response?.status;
  return error;
}

function applicationPath(namespace, name = "") {
  const root = `/apis/sparkoperator.k8s.io/v1beta2/namespaces/${encodeURIComponent(namespace)}/sparkapplications`;
  return name ? `${root}/${encodeURIComponent(name)}` : root;
}

function validateExistingApplication(application, existing) {
  const expectedAnnotations = application.metadata?.annotations || {};
  const actualAnnotations = existing?.metadata?.annotations || {};
  for (const key of ["asklake.io/run-id", "asklake.io/job-id", "asklake.io/image-digest"]) {
    if (String(actualAnnotations[key] || "") !== String(expectedAnnotations[key] || "")) {
      throw new Error(`Existing SparkApplication identity mismatch for ${key}`);
    }
  }
  if (String(existing?.spec?.image || "") !== String(application?.spec?.image || "")) {
    throw new Error("Existing SparkApplication image identity mismatch");
  }
}

async function getApplication(requestJson, namespace, name) {
  const response = await requestJson("GET", applicationPath(namespace, name));
  if (response.status === 404) return null;
  if (response.status !== 200) throw apiError("SparkApplication get", response);
  return response.body;
}

export async function createOrRecoverApplication({ application, expectedKubernetesExecution, requestJson }) {
  const namespace = application?.metadata?.namespace;
  const name = application?.metadata?.name;
  if (!namespace || !name) throw new Error("SparkApplication namespace and name are required");
  if (expectedKubernetesExecution) {
    const expectedNamespace = String(expectedKubernetesExecution.namespace || "").trim();
    const expectedName = String(expectedKubernetesExecution.applicationName || "").trim();
    const expectedUid = String(expectedKubernetesExecution.applicationUid || "").trim();
    if (!expectedNamespace || !expectedName || !expectedUid) {
      throw new Error("Persisted SparkApplication namespace, name, and UID are required for recovery");
    }
    if (expectedNamespace !== namespace || expectedName !== name) {
      throw new Error("Persisted SparkApplication name or namespace does not match the deterministic application identity");
    }
    const existing = await getApplication(requestJson, namespace, name);
    if (!existing) {
      throw new Error(
        `Persisted SparkApplication ${namespace}/${name} with UID ${expectedUid} was not found; refusing to create a replacement`,
      );
    }
    validateExistingApplication(application, existing);
    const actualUid = String(existing?.metadata?.uid || "").trim();
    if (actualUid !== expectedUid) {
      throw new Error(
        `Persisted SparkApplication UID mismatch for ${namespace}/${name}: expected ${expectedUid}, observed ${actualUid || "missing"}`,
      );
    }
    return { application: existing, recovered: true };
  }
  try {
    const response = await requestJson("POST", applicationPath(namespace), { body: application });
    if (response.status === 200 || response.status === 201) return { application: response.body, recovered: false };
    if (response.status !== 409) throw apiError("SparkApplication create", response);
  } catch (error) {
    const existing = await getApplication(requestJson, namespace, name).catch(() => null);
    if (!existing) throw error;
    validateExistingApplication(application, existing);
    return { application: existing, recovered: true };
  }
  const existing = await getApplication(requestJson, namespace, name);
  if (!existing) throw new Error("SparkApplication create conflicted but the existing object was not found");
  validateExistingApplication(application, existing);
  return { application: existing, recovered: true };
}

function applicationState(application) {
  return String(application?.status?.applicationState?.state || "SUBMITTED").toUpperCase();
}

function applicationError(application) {
  return compactText(
    application?.status?.applicationState?.errorMessage
      || application?.status?.errorMessage
      || application?.status?.submissionAttempts?.at?.(-1)?.errorMessage
      || "SparkApplication failed",
  );
}

async function driverLogs(requestJson, namespace, podName, { allowMissing = false } = {}) {
  if (!podName) return "";
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log`
    + "?container=spark-kubernetes-driver&timestamps=false&limitBytes=4194304";
  const response = await requestJson("GET", path, { timeoutMs: 30_000 });
  if (response.status === 403) throw new Error("Spark driver log access was denied by Kubernetes RBAC");
  if (response.status === 404 && allowMissing) return "";
  if (response.status !== 200) throw apiError("Spark driver log", response);
  return typeof response.body === "string" ? response.body : response.text;
}

function reportFromLogs(logs) {
  const marker = String(logs || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_SPARK_JOB_RESULT="));
  if (!marker) return null;
  try {
    return JSON.parse(marker.slice("ASKLAKE_SPARK_JOB_RESULT=".length));
  } catch {
    return null;
  }
}

async function driverPod(requestJson, namespace, podName) {
  if (!podName) return null;
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`;
  const response = await requestJson("GET", path);
  if (response.status === 404) return null;
  if (response.status !== 200) throw apiError("Spark driver Pod get", response);
  return response.body;
}

function driverPodExecution(pod) {
  const statuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
  const driver = statuses.find((item) => item?.name === "spark-kubernetes-driver") || statuses[0];
  const terminated = driver?.state?.terminated;
  return {
    driverExitCode: Number.isInteger(terminated?.exitCode) ? terminated.exitCode : undefined,
    driverFinishedAt: String(terminated?.finishedAt || "") || undefined,
    driverPodPhase: String(pod?.status?.phase || "") || undefined,
    driverTerminationReason: String(terminated?.reason || pod?.status?.reason || "") || undefined,
  };
}

function kubernetesExecutionIdentity(application, observed, recovered, extra = {}) {
  const annotations = application?.metadata?.annotations || {};
  return {
    applicationName: String(observed?.metadata?.name || application?.metadata?.name || ""),
    applicationUid: String(observed?.metadata?.uid || ""),
    driverPodName: String(observed?.status?.driverInfo?.podName || "") || undefined,
    imageDigest: String(annotations["asklake.io/image-digest"] || ""),
    jobId: String(annotations["asklake.io/job-id"] || ""),
    namespace: String(observed?.metadata?.namespace || application?.metadata?.namespace || ""),
    observedAt: new Date().toISOString(),
    recovered,
    runId: String(annotations["asklake.io/run-id"] || ""),
    state: applicationState(observed),
    ...extra,
  };
}

function writeProgressFile(progressFile, execution) {
  const raw = String(progressFile || "");
  if (!raw) return;
  if (!path.isAbsolute(raw) || raw.includes("\0")) {
    throw new Error("Spark Kubernetes progress file must be an absolute path");
  }
  const target = path.resolve(raw);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(temporary, JSON.stringify(execution), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

export async function submitAndWait({
  application,
  expectedKubernetesExecution,
  requestJson,
  timeoutMs,
  pollIntervalMs = 2_000,
  delay = sleep,
  now = () => Date.now(),
  onProgress,
}) {
  const namespace = application.metadata.namespace;
  const name = application.metadata.name;
  const created = await createOrRecoverApplication({ application, expectedKubernetesExecution, requestJson });
  const startedAt = now();
  let observed = created.application;
  let lastProgressFingerprint = "";
  const publishProgress = async (execution) => {
    if (!onProgress) return;
    const { observedAt: _observedAt, ...stableExecution } = execution;
    const fingerprint = JSON.stringify(stableExecution);
    if (fingerprint === lastProgressFingerprint) return;
    lastProgressFingerprint = fingerprint;
    await onProgress(execution);
  };
  await publishProgress(kubernetesExecutionIdentity(application, observed, created.recovered));
  while (!TERMINAL_STATES.has(applicationState(observed))) {
    if (now() - startedAt >= timeoutMs) {
      await requestJson("DELETE", applicationPath(namespace, name), {
        body: { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground" },
      }).catch(() => undefined);
      throw new Error(`SparkApplication ${name} exceeded ${timeoutMs}ms and was deleted`);
    }
    await delay(pollIntervalMs);
    observed = await getApplication(requestJson, namespace, name);
    if (!observed) throw new Error(`SparkApplication ${name} disappeared before reaching a terminal state`);
    await publishProgress(kubernetesExecutionIdentity(application, observed, created.recovered));
  }

  const state = applicationState(observed);
  const podName = String(observed?.status?.driverInfo?.podName || "");
  const pod = await driverPod(requestJson, namespace, podName);
  const logs = await driverLogs(requestJson, namespace, podName, {
    allowMissing: state !== SUCCESS_STATE,
  });
  const reportedResult = reportFromLogs(logs);
  const report = reportedResult || {
    endedAt: new Date().toISOString(),
    error: state === SUCCESS_STATE
      ? "Spark driver completed without an AskLake result marker"
      : applicationError(observed),
    failedStage: "Kubernetes SparkApplication",
    inputRows: 0,
    outputPath: "-",
    outputRows: 0,
    runId: application.metadata.annotations["asklake.io/run-id"],
    startedAt: new Date(startedAt).toISOString(),
    status: "failed",
  };
  const kubernetesExecution = kubernetesExecutionIdentity(application, observed, created.recovered, {
    ...driverPodExecution(pod),
    resultMarkerFound: reportedResult !== null,
  });
  await publishProgress(kubernetesExecution);
  return {
    logs,
    report: {
      ...report,
      kubernetesExecution,
      ...(state !== SUCCESS_STATE && report.status === "success"
        ? { error: applicationError(observed), failedStage: "Kubernetes SparkApplication", status: "failed" }
        : {}),
    },
  };
}

export function kubernetesRuntimeConfig(environment = process.env) {
  const namespace = required(environment.ASKLAKE_SPARK_KUBERNETES_NAMESPACE, "ASKLAKE_SPARK_KUBERNETES_NAMESPACE");
  const image = required(environment.ASKLAKE_SPARK_KUBERNETES_IMAGE, "ASKLAKE_SPARK_KUBERNETES_IMAGE");
  if (!image.includes("@sha256:")) {
    throw new Error("ASKLAKE_SPARK_KUBERNETES_IMAGE must be pinned by digest.");
  }
  return {
    apiServer: String(environment.ASKLAKE_KUBERNETES_API_SERVER || "https://kubernetes.default.svc").replace(/\/$/, ""),
    caFile: environment.ASKLAKE_KUBERNETES_CA_FILE || DEFAULT_CA_FILE,
    image,
    namespace,
    serviceAccount: required(environment.ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT, "ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT"),
    tokenFile: environment.ASKLAKE_KUBERNETES_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
}

export function sparkApplicationName(jobId) {
  const safe = String(jobId || "job")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "job";
  return `asklake-continuous-${safe}`.slice(0, 63).replace(/-+$/, "");
}

export function createKubernetesClient(config = kubernetesRuntimeConfig(), request = kubernetesRequest) {
  const applicationPath = (name = "") => (
    `/apis/sparkoperator.k8s.io/v1beta2/namespaces/${encodeURIComponent(config.namespace)}/sparkapplications${name ? `/${encodeURIComponent(name)}` : ""}`
  );
  return {
    async create(application) {
      return request(config, "POST", applicationPath(), application);
    },
    async delete(name) {
      return request(config, "DELETE", applicationPath(name));
    },
    async get(name) {
      try {
        return await request(config, "GET", applicationPath(name));
      } catch (error) {
        if (Number(error?.statusCode) === 404) return null;
        throw error;
      }
    },
  };
}

export function sparkApplicationState(application) {
  const state = String(application?.status?.applicationState?.state || "").toUpperCase();
  if (["RUNNING", "SUBMITTED", "PENDING", "SCHEDULED"].includes(state)) return "running";
  // Reconciliation already treats `exited` as the normal terminal worker
  // state across Docker and Spark REST. Keep the Kubernetes adapter within
  // that shared runtime contract while preserving the raw state in logs.
  if (["COMPLETED", "SUCCEEDING"].includes(state)) return "exited";
  if (["FAILED", "FAILING"].includes(state)) return "failed";
  return state ? "unknown" : "starting";
}

export async function kubernetesRequest(config, method, requestPath, body = undefined) {
  const serialized = body === undefined ? null : JSON.stringify(body);
  const token = readFileSync(config.tokenFile, "utf8").trim();
  const ca = readFileSync(config.caFile);
  const target = new URL(requestPath, config.apiServer);
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method,
      ca,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(serialized ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(serialized),
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(String(payload?.message || `Kubernetes API ${response.statusCode}`));
          error.statusCode = response.statusCode;
          error.payload = payload;
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    request.once("error", reject);
    if (serialized) request.write(serialized);
    request.end();
  });
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required for Kubernetes Continuous execution.`);
  return normalized;
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const result = await submitAndWait({
    application: input.application,
    expectedKubernetesExecution: input.expectedKubernetesExecution,
    requestJson: createKubernetesRequest(process.env),
    timeoutMs: Number(input.timeoutMs || 7_200_000),
    pollIntervalMs: Number(input.pollIntervalMs || 2_000),
    onProgress: input.progressFile
      ? (execution) => writeProgressFile(input.progressFile, execution)
      : undefined,
  });
  console.log(`ASKLAKE_SPARK_KUBERNETES_RESULT=${JSON.stringify(result)}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(compactText(error?.stack || error?.message || error, 8_000));
    process.exitCode = 1;
  });
}
