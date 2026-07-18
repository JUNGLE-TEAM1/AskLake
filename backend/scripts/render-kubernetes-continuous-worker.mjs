import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.resolve(backendDir, "..", "deploy", "kubernetes", "continuous-worker.yaml.template");
const output = outputPath(process.argv.slice(2));
const values = requiredValues(process.env);
const rendered = readFileSync(templatePath, "utf8").replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
  if (!(name in values)) throw new Error(`Template variable ${name} is not allowed.`);
  return values[name];
});

if (/\$\{[A-Z0-9_]+\}/.test(rendered)) throw new Error("Rendered manifest contains unresolved variables.");
if (output) writeFileSync(output, rendered, "utf8");
else process.stdout.write(rendered);

function requiredValues(environment) {
  const values = {
    ASKLAKE_K8S_NAMESPACE: required(environment.ASKLAKE_K8S_NAMESPACE, "ASKLAKE_K8S_NAMESPACE"),
    ASKLAKE_BACKEND_IMAGE: required(environment.ASKLAKE_BACKEND_IMAGE, "ASKLAKE_BACKEND_IMAGE"),
    ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX: required(environment.ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX, "ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX"),
    ASKLAKE_SPARK_KUBERNETES_IMAGE: required(environment.ASKLAKE_SPARK_KUBERNETES_IMAGE, "ASKLAKE_SPARK_KUBERNETES_IMAGE"),
    ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT: required(environment.ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT, "ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT"),
  };
  if (!/^s3a?:\/\/[^/]+\/.+/i.test(values.ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX)) {
    throw new Error("ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX must use s3:// or s3a:// and include a prefix.");
  }
  for (const name of ["ASKLAKE_BACKEND_IMAGE", "ASKLAKE_SPARK_KUBERNETES_IMAGE"]) {
    if (!values[name].includes("@sha256:")) throw new Error(`${name} must be pinned by digest.`);
  }
  return values;
}

function outputPath(arguments_) {
  if (arguments_.length === 0) return null;
  if (arguments_.length === 2 && arguments_[0] === "--output" && arguments_[1]) return path.resolve(arguments_[1]);
  throw new Error("Usage: node scripts/render-kubernetes-continuous-worker.mjs [--output <file>]");
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
