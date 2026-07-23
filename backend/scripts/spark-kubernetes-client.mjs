import https from "node:https";
import { readFileSync } from "node:fs";

const SERVICE_ACCOUNT_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SERVICE_ACCOUNT_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export function kubernetesRuntimeConfig(environment = process.env) {
  const namespace = required(environment.ASKLAKE_SPARK_KUBERNETES_NAMESPACE, "ASKLAKE_SPARK_KUBERNETES_NAMESPACE");
  const image = required(environment.ASKLAKE_SPARK_KUBERNETES_IMAGE, "ASKLAKE_SPARK_KUBERNETES_IMAGE");
  if (!image.includes("@sha256:")) {
    throw new Error("ASKLAKE_SPARK_KUBERNETES_IMAGE must be pinned by digest.");
  }
  return {
    apiServer: String(environment.ASKLAKE_KUBERNETES_API_SERVER || "https://kubernetes.default.svc").replace(/\/$/, ""),
    caFile: environment.ASKLAKE_KUBERNETES_CA_FILE || SERVICE_ACCOUNT_CA,
    image,
    namespace,
    serviceAccount: required(environment.ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT, "ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT"),
    tokenFile: environment.ASKLAKE_KUBERNETES_TOKEN_FILE || SERVICE_ACCOUNT_TOKEN,
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
