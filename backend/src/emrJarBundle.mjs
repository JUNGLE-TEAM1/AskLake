import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PutObjectCommand } from "@aws-sdk/client-s3";

export const EMR_JAR_BUNDLE_SCHEMA = "asklake.emr-continuous-jar-bundle.v1";

const REQUIRED_JARS = Object.freeze([
  /^spark-sql-kafka-0-10_2\.12-3\.5\.5\.jar$/,
  /^aws-msk-iam-auth-2\.3\.6\.jar$/,
]);

export function createEmrJarBundle(directoryValue, artifactRootValue) {
  const directory = path.resolve(directoryValue);
  const artifactRootUri = canonicalArtifactRoot(artifactRootValue);
  const fileNames = readdirSync(directory).filter((name) => name.endsWith(".jar")).sort();
  if (fileNames.length === 0 || fileNames.length > 256) fail("EMR Continuous JAR bundle size is invalid.");
  for (const required of REQUIRED_JARS) {
    if (!fileNames.some((name) => required.test(name))) fail("EMR Continuous JAR bundle is missing a required direct dependency.");
  }
  const entries = [];
  let totalSizeBytes = 0;
  for (const fileName of fileNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$/.test(fileName) || /snapshot/i.test(fileName)) {
      fail("EMR Continuous JAR filename is invalid or mutable.");
    }
    const absolutePath = path.join(directory, fileName);
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 256 * 1024 * 1024) {
      fail("EMR Continuous JAR file is invalid.");
    }
    totalSizeBytes += stats.size;
    if (totalSizeBytes > 1024 * 1024 * 1024) fail("EMR Continuous JAR bundle exceeds the bounded size.");
    entries.push(Object.freeze({
      absolutePath,
      fileName,
      sha256: sha256(readFileSync(absolutePath)),
      sizeBytes: stats.size,
    }));
  }
  const bundleSha256 = sha256(JSON.stringify(entries.map(({ fileName, sha256: checksum, sizeBytes }) => ({
    fileName,
    sha256: checksum,
    sizeBytes,
  }))));
  const bundleRootUri = `${artifactRootUri}/dependencies/${bundleSha256}`;
  const manifest = Object.freeze({
    schemaVersion: EMR_JAR_BUNDLE_SCHEMA,
    artifactRootUri,
    bundleRootUri,
    bundleSha256,
    jarCount: entries.length,
    jars: Object.freeze(entries.map(({ fileName, sha256: checksum, sizeBytes }) => Object.freeze({
      fileName,
      sha256: checksum,
      sizeBytes,
      uri: `${bundleRootUri}/${fileName}`,
    }))),
    manifestUri: `${bundleRootUri}/bundle.json`,
    totalSizeBytes,
  });
  return Object.freeze({ entries: Object.freeze(entries), manifest });
}

export async function uploadEmrJarBundle(bundle, s3Client) {
  if (!s3Client || typeof s3Client.send !== "function") fail("S3 client is required for EMR JAR upload.");
  const manifest = bundle?.manifest;
  if (manifest?.schemaVersion !== EMR_JAR_BUNDLE_SCHEMA) fail("EMR JAR bundle manifest is invalid.");
  const target = parseS3Uri(manifest.bundleRootUri);
  for (const entry of bundle.entries) {
    await s3Client.send(new PutObjectCommand({
      Body: readFileSync(entry.absolutePath),
      Bucket: target.bucket,
      ContentType: "application/java-archive",
      Key: `${target.key}/${entry.fileName}`,
      Metadata: {
        "asklake-bundle-sha256": manifest.bundleSha256,
        "asklake-sha256": entry.sha256,
      },
    }));
  }
  await s3Client.send(new PutObjectCommand({
    Body: `${JSON.stringify(manifest, null, 2)}\n`,
    Bucket: target.bucket,
    ContentType: "application/json; charset=utf-8",
    Key: `${target.key}/bundle.json`,
    Metadata: { "asklake-bundle-sha256": manifest.bundleSha256 },
  }));
  return manifest;
}

function canonicalArtifactRoot(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(text)) {
    fail("EMR artifact root URI is invalid.");
  }
  if (text.includes("..") || /[?#\r\n\0]/.test(text)) fail("EMR artifact root URI is invalid.");
  return text;
}

function parseS3Uri(value) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(value);
  if (!match) fail("EMR artifact S3 URI is invalid.");
  return { bucket: match[1], key: match[2] };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  const error = new Error(message);
  error.code = "EMR_JAR_BUNDLE_INVALID";
  throw error;
}
