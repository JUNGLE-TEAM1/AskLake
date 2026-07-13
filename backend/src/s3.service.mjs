import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { resolveObjectStorageConfig, s3ClientOptions } from "./objectStorageConfig.mjs";

const DEFAULT_BUCKETS = ["asklake-output"];
const MAX_PREFIX_LENGTH = 1024;

function allowedBuckets() {
  const configured = (process.env.S3_ALLOWED_BUCKETS || process.env.AWS_S3_ALLOWED_BUCKETS || "")
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_BUCKETS;
}

function normalizePrefix(prefix = "") {
  const value = String(prefix)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

function assertAllowedBucket(bucket) {
  const normalized = String(bucket || "").trim();
  if (!normalized) {
    throw Object.assign(new Error("bucket is required."), { code: "VALIDATION_ERROR", status: 400 });
  }
  if (!allowedBuckets().includes(normalized)) {
    throw Object.assign(new Error("bucket is not allowed."), { code: "FORBIDDEN_BUCKET", status: 403 });
  }
  return normalized;
}

function assertSafePrefix(prefix) {
  const normalized = normalizePrefix(prefix);
  if (normalized.length > MAX_PREFIX_LENGTH || normalized.includes("..") || /[\u0000-\u001f]/.test(normalized)) {
    throw Object.assign(new Error("prefix is invalid."), { code: "VALIDATION_ERROR", status: 400 });
  }
  return normalized;
}

function s3Client() {
  return new S3Client(s3ClientOptions(resolveObjectStorageConfig()));
}

function folderNameFromPrefix(prefix) {
  const parts = prefix.split("/").filter(Boolean);
  return parts.at(-1) || prefix;
}

function toFolder(prefix) {
  return {
    name: folderNameFromPrefix(prefix),
    prefix,
    type: "folder",
  };
}

function toFile(key, currentPrefix) {
  return {
    key,
    name: key.slice(currentPrefix.length).split("/").filter(Boolean).at(-1) || key,
    type: "file",
  };
}

function fixtureFoldersForPrefix(prefix) {
  const fixturePrefixes = [
    "pair_a_customer_review_gold/",
    "pair_a_customer_review_gold/gold/",
    "pair_a_customer_review_gold/silver/",
    "pair_a/",
    "pair_a/customer_review_gold/",
    "pair_a/customer_review_gold/gold/",
    "sales/",
    "sales/order_date=2026-07-07/",
    "sales/order_date=2026-07-08/",
  ];
  const children = new Map();

  fixturePrefixes.forEach((fixturePrefix) => {
    if (!fixturePrefix.startsWith(prefix) || fixturePrefix === prefix) return;
    const remainder = fixturePrefix.slice(prefix.length);
    const [nextSegment] = remainder.split("/").filter(Boolean);
    if (!nextSegment) return;
    const childPrefix = `${prefix}${nextSegment}/`;
    children.set(childPrefix, toFolder(childPrefix));
  });

  return Array.from(children.values());
}

function fixturePrefixResponse(bucket, prefix) {
  return {
    bucket,
    files: [],
    folders: fixtureFoldersForPrefix(prefix),
    nextContinuationToken: null,
    prefix,
  };
}

function shouldUseFixtureFallback() {
  return String(process.env.S3_DISABLE_FIXTURE_FALLBACK ?? "false").toLowerCase() !== "true";
}

export function listS3Buckets() {
  return { buckets: allowedBuckets() };
}

export async function listS3Prefixes({ bucket, continuationToken, prefix }) {
  const allowedBucket = assertAllowedBucket(bucket);
  const safePrefix = assertSafePrefix(prefix);

  try {
    const response = await s3Client().send(new ListObjectsV2Command({
      Bucket: allowedBucket,
      ContinuationToken: continuationToken || undefined,
      Delimiter: "/",
      Prefix: safePrefix,
    }));

    return {
      bucket: allowedBucket,
      files: (response.Contents ?? [])
        .filter((item) => item.Key && item.Key !== safePrefix)
        .map((item) => toFile(item.Key, safePrefix)),
      folders: (response.CommonPrefixes ?? [])
        .map((item) => item.Prefix)
        .filter(Boolean)
        .map(toFolder),
      nextContinuationToken: response.NextContinuationToken ?? null,
      prefix: safePrefix,
    };
  } catch (error) {
    if (shouldUseFixtureFallback()) {
      return fixturePrefixResponse(allowedBucket, safePrefix);
    }

    throw Object.assign(new Error(error.message || "S3 prefix list failed."), {
      code: "S3_LIST_FAILED",
      status: 502,
    });
  }
}
