const MINIO_PROVIDER = "minio";
const AWS_PROVIDER = "aws";

function fieldValue(fields, label) {
  return Array.isArray(fields)
    ? String(fields.find(([key]) => key === label)?.[1] ?? "").trim()
    : "";
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isLoopbackEndpoint(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

export function objectStorageProvider(fields = []) {
  const configured = fieldValue(fields, "Storage Provider")
    || process.env.ASKLAKE_OBJECT_STORAGE_PROVIDER
    || MINIO_PROVIDER;
  const normalized = configured.trim().toLowerCase();
  if (["aws", "amazon s3", "s3"].includes(normalized)) return AWS_PROVIDER;
  if (["minio", "minio/s3"].includes(normalized)) return MINIO_PROVIDER;
  throw new Error(`Unsupported object storage provider: ${configured}`);
}

export function resolveObjectStorageConfig(fields = [], { docker = false } = {}) {
  const provider = objectStorageProvider(fields);
  const isMinio = provider === MINIO_PROVIDER;
  const endpointFromFields = fieldValue(fields, "Endpoint URL") || fieldValue(fields, "Endpoint");
  const dockerLoopbackEndpoint = docker && isMinio && isLoopbackEndpoint(endpointFromFields)
    ? process.env.MINIO_ENDPOINT_IN_DOCKER
    : "";
  const endpoint = dockerLoopbackEndpoint
    || endpointFromFields
    || (isMinio
      ? (docker ? process.env.MINIO_ENDPOINT_IN_DOCKER : process.env.MINIO_ENDPOINT)
      : (process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3))
    || (isMinio ? (docker ? "http://m3-minio:9000" : "http://127.0.0.1:9000") : "");
  const region = fieldValue(fields, "Region")
    || (isMinio ? process.env.MINIO_REGION : (process.env.S3_REGION || process.env.AWS_REGION))
    || (isMinio ? "us-east-1" : "ap-northeast-2");
  const forcePathStyle = parseBoolean(
    fieldValue(fields, "Use Path Style") || process.env.S3_FORCE_PATH_STYLE,
    isMinio,
  );

  const accessKeyId = isMinio
    ? fieldValue(fields, "Access Key") || process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || ""
    : "";
  const secretAccessKey = isMinio
    ? fieldValue(fields, "Secret Key") || process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || ""
    : "";

  return {
    accessKeyId,
    endpoint,
    forcePathStyle,
    provider,
    region,
    secretAccessKey,
  };
}

export function s3ClientOptions(config) {
  const options = {
    forcePathStyle: config.forcePathStyle,
    region: config.region,
  };
  if (config.endpoint) options.endpoint = config.endpoint;
  if (config.accessKeyId && config.secretAccessKey) {
    options.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  return options;
}

export function objectStorageDockerEnv(fields = []) {
  const config = resolveObjectStorageConfig(fields, { docker: true });
  const entries = [
    ["ASKLAKE_OBJECT_STORAGE_PROVIDER", config.provider],
    ["AWS_REGION", config.region],
    ["S3_FORCE_PATH_STYLE", String(config.forcePathStyle)],
  ];
  if (config.provider === MINIO_PROVIDER) {
    entries.push(
      ["MINIO_ENDPOINT", config.endpoint],
      ["MINIO_ACCESS_KEY", config.accessKeyId],
      ["MINIO_SECRET_KEY", config.secretAccessKey],
      ["MINIO_REGION", config.region],
    );
  } else {
    if (config.endpoint) entries.push(["S3_ENDPOINT", config.endpoint]);
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      if (process.env[name]) entries.push([name, process.env[name]]);
    }
  }
  return entries.filter(([, value]) => value !== undefined && value !== null && String(value) !== "");
}

export function toDockerEnvArgs(entries) {
  return entries.flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

export function defaultRawBucket() {
  return process.env.ASKLAKE_RAW_BUCKET || process.env.MINIO_BUCKET || "m3-raw";
}

export function validateConfiguredBucket(bucketValue, settingName) {
  const bucket = String(bucketValue || "").trim();
  if (
    bucket.toLowerCase().includes("replace-with-")
    || bucket.length < 3
    || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
  ) {
    throw new Error(`${settingName} is invalid or still contains a deployment placeholder`);
  }
  return bucket;
}

export function defaultOutputBucket() {
  return validateConfiguredBucket(
    process.env.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output",
    "ASKLAKE_SPARK_OUTPUT_BUCKET",
  );
}

export function defaultWarehouseBucket() {
  return validateConfiguredBucket(
    process.env.TRINO_ICEBERG_WAREHOUSE_BUCKET || "",
    "TRINO_ICEBERG_WAREHOUSE_BUCKET",
  );
}

export function validateConfiguredS3Location(locationValue, settingName) {
  const location = String(locationValue || "").trim().replace(/\/+$/, "");
  const match = /^s3a?:\/\/([^/]+)(?:\/.*)?$/i.exec(location);
  if (!match) {
    throw new Error(`${settingName} must be an s3:// or s3a:// location`);
  }
  validateConfiguredBucket(match[1], settingName);
  return location;
}

export function isMinioProvider(fields = []) {
  return objectStorageProvider(fields) === MINIO_PROVIDER;
}
