import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const defaultRunDir = path.join(
  backendDir,
  "tmp",
  "synthetic-commerce",
  "commerce-250mb-seed-20260711",
);
const runDir = path.resolve(
  process.env.ASKLAKE_SYNTHETIC_COMMERCE_DIR || defaultRunDir,
);
const manifestPath = path.join(runDir, "manifest.json");
const bucket = process.env.ASKLAKE_SYNTHETIC_COMMERCE_BUCKET
  || process.env.MINIO_BUCKET
  || "m3-raw";
const region = process.env.ASKLAKE_SYNTHETIC_COMMERCE_REGION
  || process.env.MINIO_REGION
  || "us-east-1";
const endpointValue = process.env.ASKLAKE_SYNTHETIC_COMMERCE_ENDPOINT
  ?? process.env.MINIO_ENDPOINT
  ?? "http://127.0.0.1:9000";
const endpoint = endpointValue.trim() || undefined;
const accessKeyId = process.env.ASKLAKE_SYNTHETIC_COMMERCE_ACCESS_KEY
  || process.env.MINIO_ACCESS_KEY
  || process.env.MINIO_ROOT_USER
  || "m3admin";
const secretAccessKey = process.env.ASKLAKE_SYNTHETIC_COMMERCE_SECRET_KEY
  || process.env.MINIO_SECRET_KEY
  || process.env.MINIO_ROOT_PASSWORD
  || "wishuponastar";
const useDefaultCredentials = booleanEnv(
  "ASKLAKE_SYNTHETIC_COMMERCE_USE_DEFAULT_CREDENTIALS",
  false,
);
const forcePathStyle = booleanEnv(
  "ASKLAKE_SYNTHETIC_COMMERCE_FORCE_PATH_STYLE",
  Boolean(endpoint),
);
const createBucket = booleanEnv(
  "ASKLAKE_SYNTHETIC_COMMERCE_CREATE_BUCKET",
  Boolean(endpoint),
);
const concurrency = positiveInteger(
  process.env.ASKLAKE_SYNTHETIC_COMMERCE_UPLOAD_CONCURRENCY,
  3,
);

const s3 = new S3Client({
  ...(useDefaultCredentials ? {} : { credentials: { accessKeyId, secretAccessKey } }),
  ...(endpoint ? { endpoint } : {}),
  forcePathStyle,
  region,
});

try {
  const manifest = await readManifest();
  const keyPrefix = normalizeKeyPrefix(
    process.env.ASKLAKE_SYNTHETIC_COMMERCE_KEY_PREFIX
      || `synthetic-commerce/${manifest.run_id}/`,
  );
  const files = await validateManifestFiles(manifest, keyPrefix);
  await ensureBucket();

  // Upload data first and publish manifest.json last as the completion marker.
  await mapWithConcurrency(files, concurrency, uploadAndVerify);
  const manifestStats = await fs.stat(manifestPath);
  const manifestSha256 = await sha256File(manifestPath);
  const manifestObject = {
    bytes: manifestStats.size,
    key: `${keyPrefix}manifest.json`,
    localPath: manifestPath,
    rows: null,
    sha256: manifestSha256,
  };
  await uploadAndVerify(manifestObject);
  await assertExactRemoteKeySet(keyPrefix, [...files, manifestObject]);

  console.log(JSON.stringify({
    bucket,
    dataBytes: files.reduce((total, file) => total + file.bytes, 0),
    dataFileCount: files.length,
    manifestBytes: manifestObject.bytes,
    objectCount: files.length + 1,
    runId: manifest.run_id,
    s3Prefix: `s3://${bucket}/${keyPrefix}`,
    status: "uploaded_and_head_verified",
  }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Synthetic-commerce manifest could not be read: ${manifestPath}: ${error.message}`);
  }
  if (manifest?.generator_version !== 2) {
    throw new Error(`Synthetic-commerce generator_version 2 is required: ${manifestPath}`);
  }
  if (!manifest.run_id || path.basename(String(manifest.run_id)) !== manifest.run_id) {
    throw new Error("manifest.run_id must be one safe path segment.");
  }
  for (const dataset of ["meta", "users", "click_events"]) {
    if (!manifest.datasets?.[dataset] || !Array.isArray(manifest.datasets[dataset].files)) {
      throw new Error(`manifest.datasets.${dataset}.files is required.`);
    }
  }
  return manifest;
}

async function validateManifestFiles(manifest, keyPrefix) {
  const runRealPath = await fs.realpath(runDir);
  const manifestFiles = Object.values(manifest.datasets)
    .flatMap((dataset) => dataset.files || []);
  const paths = new Set();
  const validated = [];
  for (const item of manifestFiles) {
    const relativePath = normalizeManifestPath(item.path);
    if (paths.has(relativePath)) throw new Error(`Duplicate manifest file path: ${relativePath}`);
    paths.add(relativePath);
    const localPath = path.resolve(runDir, relativePath);
    const realPath = await fs.realpath(localPath).catch(() => "");
    if (!realPath || (realPath !== runRealPath && !realPath.startsWith(`${runRealPath}${path.sep}`))) {
      throw new Error(`Manifest file resolves outside the run directory: ${relativePath}`);
    }
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) throw new Error(`Manifest path is not a regular file: ${relativePath}`);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || stats.size !== item.bytes) {
      throw new Error(`Manifest byte mismatch before upload: ${relativePath} expected=${item.bytes} actual=${stats.size}`);
    }
    if (!Number.isSafeInteger(item.rows) || item.rows < 0) {
      throw new Error(`Manifest row count is invalid: ${relativePath}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(item.sha256 || ""))) {
      throw new Error(`Manifest SHA-256 is invalid: ${relativePath}`);
    }
    const actualSha256 = await sha256File(realPath);
    if (actualSha256 !== item.sha256) {
      throw new Error(`Manifest SHA-256 mismatch before upload: ${relativePath}`);
    }
    validated.push({
      bytes: item.bytes,
      key: `${keyPrefix}${relativePath}`,
      localPath: realPath,
      rows: item.rows,
      sha256: item.sha256,
    });
  }
  const dataBytes = validated.reduce((total, file) => total + file.bytes, 0);
  if (Number(manifest.total_bytes) !== dataBytes) {
    throw new Error(`Manifest total_bytes mismatch: expected=${manifest.total_bytes} files=${dataBytes}`);
  }
  return validated.sort((left, right) => left.key.localeCompare(right.key));
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (![0, 404].includes(status) || !createBucket) throw error;
  }
  const request = { Bucket: bucket };
  if (!endpoint && region !== "us-east-1") {
    request.CreateBucketConfiguration = { LocationConstraint: region };
  }
  try {
    await s3.send(new CreateBucketCommand(request));
  } catch (error) {
    if (!["BucketAlreadyExists", "BucketAlreadyOwnedByYou"].includes(error?.name)) throw error;
  }
}

async function uploadAndVerify(file) {
  const metadata = {
    "asklake-sha256": file.sha256,
    ...(file.rows === null ? {} : { "asklake-rows": String(file.rows) }),
  };
  await s3.send(new PutObjectCommand({
    Body: createReadStream(file.localPath),
    Bucket: bucket,
    ContentLength: file.bytes,
    ContentType: file.key.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
    Key: file.key,
    Metadata: metadata,
  }));
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.key }));
  const remoteBytes = Number(head.ContentLength ?? -1);
  if (remoteBytes !== file.bytes) {
    throw new Error(`HeadObject byte mismatch: s3://${bucket}/${file.key} expected=${file.bytes} actual=${remoteBytes}`);
  }
  if (head.Metadata?.["asklake-sha256"] !== file.sha256) {
    throw new Error(`HeadObject SHA-256 metadata mismatch: s3://${bucket}/${file.key}`);
  }
}

async function assertExactRemoteKeySet(prefix, files) {
  const expected = new Set(files.map((file) => file.key));
  const actual = new Set();
  let continuationToken;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      Prefix: prefix,
    }));
    for (const object of listed.Contents || []) {
      if (object.Key) actual.add(object.Key);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  const missing = [...expected].filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !expected.has(key));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Remote run prefix differs from manifest; missing=${missing.length} unexpected=${unexpected.length}. `
      + "Use a new run-id/prefix instead of mixing generated runs.",
    );
  }
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function mapWithConcurrency(items, limit, operation) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await operation(current);
    }
  });
  await Promise.all(workers);
}

function normalizeManifestPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) {
    throw new Error(`Unsafe manifest file path: ${value}`);
  }
  return normalized;
}

function normalizeKeyPrefix(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) {
    throw new Error(`Unsafe S3 key prefix: ${value}`);
  }
  return `${normalized}/`;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redactSecrets(value) {
  let text = String(value || "");
  for (const secret of [accessKeyId, secretAccessKey]) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text.replace(/(secret|password|credential|access[_ -]?key)(["'=:\s]+)[^\s,}"']+/gi, "$1$2<redacted>");
}
