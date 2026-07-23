import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const minioDockerFailureCache = new Map();
const execFileAsync = promisify(execFile);

export function listObjectsViaMinioContainer({
  accessKeyId,
  bucket,
  endpoint,
  limit = sourceListLimit(),
  prefix,
  secretAccessKey,
}) {
  const normalizedPrefix = normalizePrefix(prefix);
  const maxItems = configuredInlineLimit(limit, sourceListLimit());
  const target = `local/${bucket}/${normalizedPrefix ? `${normalizedPrefix}/` : ""}`;
  const result = runMinioClientCommand({
    accessKeyId,
    command: `mc ls --json ${shellQuote(target)} | head -n ${maxItems}`,
    endpoint,
    secretAccessKey,
  });
  if (!result) return null;

  return parseMinioListedObjects(result, bucket, normalizedPrefix);
}

export function listPrefixObjectsViaMinioContainer({
  accessKeyId,
  bucket,
  endpoint,
  prefix,
  secretAccessKey,
}) {
  const normalizedPrefix = normalizePrefix(prefix);
  const target = `local/${bucket}/${normalizedPrefix ? `${normalizedPrefix}/` : ""}`;
  const result = runMinioClientCommand({
    accessKeyId,
    command: `mc ls --recursive --json ${shellQuote(target)}`,
    endpoint,
    secretAccessKey,
  });
  if (!result) return null;
  return parseMinioListedObjects(result, bucket, normalizedPrefix).sort(compareObjectKeys);
}

export function listDirectObjectsViaMinioContainer(options) {
  return listObjectsViaMinioContainer(options);
}

export function listSelectedObjectViaMinioContainer({
  accessKeyId,
  bucket,
  endpoint,
  key,
  secretAccessKey,
}) {
  const normalizedKey = normalizePrefix(key);
  if (!normalizedKey) return [];
  const result = runMinioClientCommand({
    accessKeyId,
    command: `mc stat --json ${shellQuote(`local/${bucket}/${normalizedKey}`)}`,
    endpoint,
    secretAccessKey,
  });
  if (!result) return null;
  const line = result.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const item = JSON.parse(line);
    return [{
      __folder: false,
      Key: normalizedKey,
      LastModified: item.lastModified ? new Date(item.lastModified) : undefined,
      Size: Number(item.size ?? 0),
    }];
  } catch {
    return null;
  }
}

export function readObjectSampleViaMinioContainer({
  accessKeyId,
  bucket,
  bytes,
  endpoint,
  key,
  secretAccessKey,
}) {
  const byteLimit = Math.max(1, Math.trunc(Number(bytes) || 512 * 1024));
  const target = `local/${bucket}/${key}`;
  return runMinioClientCommand({
    accessKeyId,
    command: `mc cat ${shellQuote(target)} | head -c ${byteLimit}`,
    endpoint,
    secretAccessKey,
  }) ?? "";
}

export async function readObjectSampleRangeViaMinioContainer({
  accessKeyId,
  bucket,
  endByte,
  endpoint,
  key,
  secretAccessKey,
  startByte,
}) {
  const normalizedStart = Math.max(0, Math.trunc(Number(startByte) || 0));
  const normalizedEnd = Math.max(normalizedStart, Math.trunc(Number(endByte) || normalizedStart));
  const byteLength = normalizedEnd - normalizedStart + 1;
  const target = `local/${bucket}/${key}`;
  return runMinioClientCommandAsync({
    accessKeyId,
    command: `mc cat --offset ${normalizedStart} ${shellQuote(target)} | head -c ${byteLength}`,
    endpoint,
    secretAccessKey,
  });
}

function parseMinioListedObjects(result, bucket, normalizedPrefix) {
  const root = `local/${bucket}/`;
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  return result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((item) => item?.status === "success" && item.key)
    .map((item) => {
      const rawKey = String(item.key);
      const normalizedKey = rawKey.startsWith(root) ? rawKey.slice(root.length) : rawKey.replace(/^\/+/, "");
      const key = normalizedPrefix
        ? (normalizedKey.startsWith(normalizedPrefixWithSlash) ? normalizedKey : `${normalizedPrefixWithSlash}${normalizedKey}`)
        : normalizedKey;
      return {
        __folder: item.type === "folder" || String(item.key).endsWith("/"),
        Key: key,
        LastModified: item.lastModified ? new Date(item.lastModified) : undefined,
        Size: Number(item.size ?? 0),
      };
    });
}

function runMinioClientCommand({
  accessKeyId,
  command,
  endpoint = "http://127.0.0.1:9000",
  secretAccessKey,
}) {
  if (process.env.ASKLAKE_MINIO_DOCKER_FALLBACK === "false") return null;
  const container = process.env.ASKLAKE_MINIO_CONTAINER || "m3-minio";
  const minioEndpoint = process.env.ASKLAKE_MINIO_CONTAINER_ENDPOINT || String(endpoint || "");
  const failureKey = `${container}:${minioEndpoint}`;
  const failureUntil = minioDockerFailureCache.get(failureKey) ?? 0;
  if (failureUntil > Date.now()) return null;
  const accessKey = accessKeyId || process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
  const secretKey = secretAccessKey || process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
  const script = [
    `mc alias set local ${shellQuote(minioEndpoint)} ${shellQuote(accessKey)} ${shellQuote(secretKey)} >/dev/null`,
    command,
  ].join(" && ");
  const result = spawnSync("docker", ["exec", "-i", container, "sh", "-lc", script], {
    encoding: "utf8",
    env: { ...process.env, MC_QUIET: "1", MC_DISABLE_PAGER: "1" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: sourceConnectTimeoutMs("ASKLAKE_MINIO_DOCKER_TIMEOUT_MS", 5000),
  });
  if (result.status !== 0) {
    rememberFailure(failureKey);
    return null;
  }
  minioDockerFailureCache.delete(failureKey);
  return result.stdout ?? "";
}

async function runMinioClientCommandAsync({
  accessKeyId,
  command,
  endpoint = "http://127.0.0.1:9000",
  secretAccessKey,
}) {
  if (process.env.ASKLAKE_MINIO_DOCKER_FALLBACK === "false") return null;
  const container = process.env.ASKLAKE_MINIO_CONTAINER || "m3-minio";
  const minioEndpoint = process.env.ASKLAKE_MINIO_CONTAINER_ENDPOINT || String(endpoint || "");
  const failureKey = `${container}:${minioEndpoint}`;
  const failureUntil = minioDockerFailureCache.get(failureKey) ?? 0;
  if (failureUntil > Date.now()) return null;
  const accessKey = accessKeyId || process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
  const secretKey = secretAccessKey || process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
  const script = [
    `mc alias set local ${shellQuote(minioEndpoint)} ${shellQuote(accessKey)} ${shellQuote(secretKey)} >/dev/null`,
    command,
  ].join(" && ");

  try {
    const result = await execFileAsync("docker", ["exec", "-i", container, "sh", "-lc", script], {
      encoding: "buffer",
      env: { ...process.env, MC_QUIET: "1", MC_DISABLE_PAGER: "1" },
      maxBuffer: 32 * 1024 * 1024,
      timeout: sourceConnectTimeoutMs("ASKLAKE_MINIO_DOCKER_TIMEOUT_MS", 5000),
    });
    minioDockerFailureCache.delete(failureKey);
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  } catch {
    rememberFailure(failureKey);
    return null;
  }
}

function rememberFailure(failureKey) {
  minioDockerFailureCache.set(
    failureKey,
    Date.now() + sourceConnectTimeoutMs("ASKLAKE_MINIO_DOCKER_FAILURE_CACHE_MS", 30000),
  );
}

function sourceListLimit() {
  return configuredListLimit("ASKLAKE_SOURCE_LIST_LIMIT", 5000);
}

function configuredListLimit(envName, defaultLimit) {
  const configured = Number(process.env[envName] ?? defaultLimit);
  if (!Number.isFinite(configured) || configured <= 0) return defaultLimit;
  return Math.trunc(configured);
}

function configuredInlineLimit(value, defaultLimit) {
  const configured = Number(value ?? defaultLimit);
  if (!Number.isFinite(configured) || configured <= 0) return defaultLimit;
  return Math.trunc(configured);
}

function sourceConnectTimeoutMs(envName, defaultMs) {
  const configured = Number(process.env[envName] ?? defaultMs);
  if (!Number.isFinite(configured) || configured <= 0) return defaultMs;
  return Math.trunc(configured);
}

function compareObjectKeys(left, right) {
  const leftKey = String(left?.Key ?? "");
  const rightKey = String(right?.Key ?? "");
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function normalizePrefix(prefix) {
  return String(prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
