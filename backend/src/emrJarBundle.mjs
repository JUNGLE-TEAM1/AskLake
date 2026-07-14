import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

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
    const body = readFileSync(entry.absolutePath);
    await putImmutableObject(s3Client, {
      Body: body,
      Bucket: target.bucket,
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: base64Sha256(body),
      ContentType: "application/java-archive",
      IfNoneMatch: "*",
      Key: `${target.key}/${entry.fileName}`,
      Metadata: {
        "asklake-bundle-sha256": manifest.bundleSha256,
        "asklake-sha256": entry.sha256,
      },
    });
  }
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestChecksum = sha256(manifestBody);
  await putImmutableObject(s3Client, {
    Body: manifestBody,
    Bucket: target.bucket,
    ChecksumAlgorithm: "SHA256",
    ChecksumSHA256: base64Sha256(manifestBody),
    ContentType: "application/json; charset=utf-8",
    IfNoneMatch: "*",
    Key: `${target.key}/bundle.json`,
    Metadata: {
      "asklake-bundle-sha256": manifest.bundleSha256,
      "asklake-manifest-sha256": manifestChecksum,
    },
  });
  return manifest;
}

async function putImmutableObject(s3Client, input) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await s3Client.send(new PutObjectCommand(input));
      if (response?.ChecksumSHA256 !== input.ChecksumSHA256) fail("S3 upload checksum response is invalid.");
      await verifyRemoteObject(s3Client, input);
      return;
    } catch (error) {
      if (isS3Status(error, 412)) {
        await verifyRemoteObject(s3Client, input);
        return;
      }
      if (isS3Status(error, 409) && attempt < 3) continue;
      throw error;
    }
  }
  fail("S3 immutable upload retry limit was exceeded.");
}

async function verifyRemoteObject(s3Client, input) {
  const head = await s3Client.send(new HeadObjectCommand({
    Bucket: input.Bucket,
    ChecksumMode: "ENABLED",
    Key: input.Key,
  }));
  if (head?.ChecksumSHA256 !== input.ChecksumSHA256
    || head?.ContentLength !== byteLength(input.Body)) {
    fail("S3 immutable object checksum or size does not match.");
  }
  for (const [name, value] of Object.entries(input.Metadata || {})) {
    if (head.Metadata?.[name.toLowerCase()] !== value) fail("S3 immutable object metadata does not match.");
  }
}

function isS3Status(error, status) {
  return error?.$metadata?.httpStatusCode === status
    || (status === 412 && ["PreconditionFailed", "ConditionalRequestFailed"].includes(error?.name))
    || (status === 409 && error?.name === "ConditionalRequestConflict");
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

function base64Sha256(value) {
  return createHash("sha256").update(value).digest("base64");
}

function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
}

function fail(message) {
  const error = new Error(message);
  error.code = "EMR_JAR_BUNDLE_INVALID";
  throw error;
}
