import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(backendDir, "fixtures", "contracts", "storage-layout-v1.json");
const contract = Object.freeze(JSON.parse(readFileSync(contractPath, "utf8")));

export const STORAGE_LAYOUT_VERSION = contract.version;

export function storageLayoutConfig(environment = process.env) {
  const configuredEnvironment = environment.ASKLAKE_STORAGE_ENVIRONMENT
    || environment.APP_ENV
    || environment.NODE_ENV
    || contract.defaults.environment;
  return Object.freeze({
    basePrefix: normalizePrefix(
      environment.ASKLAKE_STORAGE_BASE_PREFIX || contract.defaults.basePrefix,
      "ASKLAKE_STORAGE_BASE_PREFIX",
    ),
    bucket: normalizeBucket(
      environment.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output",
      "ASKLAKE_SPARK_OUTPUT_BUCKET",
    ),
    environment: safeStorageSegment(configuredEnvironment, "ASKLAKE_STORAGE_ENVIRONMENT").toLowerCase(),
    retentionDays: Object.freeze({
      data: retentionDays(environment.ASKLAKE_STORAGE_DATA_RETENTION_DAYS, contract.defaults.retentionDays.data),
      checkpoints: retentionDays(
        environment.ASKLAKE_STORAGE_CHECKPOINT_RETENTION_DAYS,
        contract.defaults.retentionDays.checkpoints,
      ),
      manifests: retentionDays(
        environment.ASKLAKE_STORAGE_MANIFEST_RETENTION_DAYS,
        contract.defaults.retentionDays.manifests,
      ),
      quarantine: retentionDays(
        environment.ASKLAKE_STORAGE_QUARANTINE_RETENTION_DAYS,
        contract.defaults.retentionDays.quarantine,
      ),
      logs: retentionDays(environment.ASKLAKE_STORAGE_LOG_RETENTION_DAYS, contract.defaults.retentionDays.logs),
    }),
  });
}

export function createStorageLayout(input = {}, environment = process.env) {
  const config = storageLayoutConfig(environment);
  const datasetId = safeStorageSegment(input.datasetId, "datasetId");
  const layer = safeStorageSegment(input.layer || "bronze", "layer").toLowerCase();
  const explicitRoot = String(input.explicitRoot || "").trim();
  const root = explicitRoot
    ? canonicalObjectStorageUri(explicitRoot, environment)
    : joinObjectStorageUri(
      `s3a://${normalizeBucket(input.bucket || config.bucket, "bucket")}`,
      config.basePrefix,
      config.environment,
      contract.segments.datasets,
      datasetId,
      layer,
    );
  const jobId = input.jobId ? safeStorageSegment(input.jobId, "jobId") : null;
  const runId = input.runId ? safeStorageSegment(input.runId, "runId") : null;
  const batchDataPath = runId ? joinObjectStorageUri(root, runId) : null;
  return Object.freeze({
    batchDataPath,
    batchQuarantinePath: batchDataPath ? `${batchDataPath}_quarantine` : null,
    checkpointPath: jobId
      ? joinObjectStorageUri(root, contract.segments.checkpoints, jobId)
      : null,
    continuousDataRoot: joinObjectStorageUri(root, contract.segments.continuousData),
    logReferenceRoot: joinObjectStorageUri(
      root,
      contract.segments.logs,
      jobId || datasetId,
    ),
    manifestRoot: joinObjectStorageUri(root, contract.segments.manifests),
    quarantineRoot: joinObjectStorageUri(root, contract.segments.quarantine),
    retentionDays: config.retentionDays,
    root,
    version: STORAGE_LAYOUT_VERSION,
  });
}

export function canonicalObjectStorageUri(value, environment = process.env) {
  const raw = String(value || "").trim();
  if (!raw || /[\\\u0000-\u001f\u007f]/.test(raw) || /[?#]/.test(raw)) {
    throw storageLayoutError("Storage path must be a plain s3:// or s3a:// URI without query, fragment, or control characters.");
  }
  const match = /^s3a?:\/\/([^/]+)(?:\/(.*))?$/i.exec(raw);
  if (!match) {
    throw storageLayoutError("Storage path must use the s3:// or s3a:// scheme.");
  }
  let bucket = normalizeBucket(match[1], "storage bucket");
  const configuredBucket = normalizeBucket(
    environment.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output",
    "ASKLAKE_SPARK_OUTPUT_BUCKET",
  );
  if (bucket === "asklake-output" && configuredBucket !== "asklake-output") {
    bucket = configuredBucket;
  }
  const segments = normalizePathSegments(match[2] || "", "storage path");
  return segments.length > 0
    ? `s3a://${bucket}/${segments.join("/")}`
    : `s3a://${bucket}`;
}

export function assertProductionDataPlanePath(value, environment = process.env) {
  if (!isProductionEnvironment(environment)) return value;
  try {
    return canonicalObjectStorageUri(value, environment);
  } catch (error) {
    const wrapped = storageLayoutError(
      "Production Spark data, checkpoint, manifest, and quarantine paths must use canonical object storage URIs.",
      "STORAGE_LAYOUT_LOCAL_PATH_FORBIDDEN",
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

export function normalizeObjectStorageError(error, { bucket = "configured bucket", operation = "access" } = {}) {
  const name = String(error?.name || error?.code || "").trim();
  const httpStatus = Number(error?.$metadata?.httpStatusCode || error?.statusCode || error?.status || 0);
  let code = "OBJECT_STORAGE_UNAVAILABLE";
  let status = 503;
  let reason = "is temporarily unavailable";
  if (httpStatus === 403 || ["AccessDenied", "Forbidden", "Unauthorized"].includes(name)) {
    code = "OBJECT_STORAGE_ACCESS_DENIED";
    status = 403;
    reason = "denied the requested operation";
  } else if (httpStatus === 404 || ["NoSuchBucket", "NotFound", "NoSuchKey"].includes(name)) {
    code = "OBJECT_STORAGE_NOT_FOUND";
    status = 404;
    reason = "does not contain the requested resource";
  }
  const normalized = new Error(`Object storage ${operation} for ${bucket} ${reason}.`);
  normalized.code = code;
  normalized.status = status;
  return normalized;
}

export function isMissingObjectStorageResource(error) {
  const name = String(error?.name || error?.code || "").trim();
  const httpStatus = Number(error?.$metadata?.httpStatusCode || error?.statusCode || error?.status || 0);
  return httpStatus === 404 || ["NoSuchBucket", "NotFound", "NoSuchKey"].includes(name);
}

function joinObjectStorageUri(root, ...segments) {
  const normalizedRoot = String(root || "").replace(/\/+$/, "");
  const suffix = segments.flatMap((segment) => normalizePathSegments(segment, "storage segment"));
  return suffix.length > 0 ? `${normalizedRoot}/${suffix.join("/")}` : normalizedRoot;
}

function normalizePrefix(value, name) {
  return normalizePathSegments(value, name).join("/");
}

function normalizePathSegments(value, name) {
  const raw = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return [];
  return raw.split("/").filter(Boolean).map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw storageLayoutError(`${name} contains invalid percent encoding.`);
    }
    if ([".", ".."].includes(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw storageLayoutError(`${name} contains a forbidden path segment.`);
    }
    return safeStorageSegment(decoded, name);
  });
}

function safeStorageSegment(value, name) {
  const normalized = String(value || "").normalize("NFKC").trim();
  if (!normalized) throw storageLayoutError(`${name} is required.`);
  const safe = normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") {
    throw storageLayoutError(`${name} does not contain a safe storage segment.`);
  }
  return safe;
}

function normalizeBucket(value, name) {
  const bucket = String(value || "")
    .trim()
    .replace(/^s3a?:\/\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw storageLayoutError(`${name} must be a valid S3 bucket name.`);
  }
  return bucket;
}

function retentionDays(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 36_500) {
    throw storageLayoutError("Storage retention days must be an integer between 0 and 36500.");
  }
  return parsed;
}

function isProductionEnvironment(environment) {
  return [environment.APP_ENV, environment.NODE_ENV]
    .some((value) => ["prod", "production"].includes(String(value || "").trim().toLowerCase()));
}

function storageLayoutError(message, code = "STORAGE_LAYOUT_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  return error;
}
