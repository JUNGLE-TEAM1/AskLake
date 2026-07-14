import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  emrServerlessConfig,
  emrServerlessContinuousConfig,
  safeEmrServerlessMessage,
} from "../src/emrServerless.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function uploadEmrServerlessArtifact(environment = process.env, dependencies = {}, options = {}) {
  const continuous = options.continuous === true;
  const config = continuous ? emrServerlessContinuousConfig(environment) : emrServerlessConfig(environment);
  const sourceFile = path.resolve(continuous
    ? environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENTRY_POINT_FILE
      || path.join(backendDir, "scripts", "kafka_continuous_stream.py")
    : environment.ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_FILE
      || path.join(backendDir, "scripts", "spark_job_run.py"));
  const artifacts = [{ sourceFile, uri: config.entryPointUri }];
  if (continuous) {
    const helperNames = [
      "kafka_schema_paths.py",
      "object_storage_runtime.py",
      "snapshot_rule_runtime.py",
    ];
    artifacts.push(...helperNames.map((name, index) => ({
      sourceFile: path.join(backendDir, "scripts", name),
      uri: config.pyFilesUris[index],
    })));
  } else {
    const helperNames = [
      "object_storage_runtime.py",
      "snapshot_rule_runtime.py",
      "spark_snapshot_rules.py",
      "spark_source_identity.py",
    ];
    artifacts.push(...helperNames.map((name, index) => ({
      sourceFile: path.join(backendDir, "scripts", name),
      uri: config.pyFilesUris[index],
    })));
  }
  for (const item of artifacts) {
    if (!existsSync(item.sourceFile)) {
      throw artifactError(`The configured EMR Serverless PySpark artifact does not exist: ${path.basename(item.sourceFile)}`);
    }
  }
  const client = dependencies.s3Client || new S3Client({ region: config.region });
  const uploaded = [];
  try {
    for (const item of artifacts) {
      const artifact = readFileSync(item.sourceFile);
      const checksum = createHash("sha256").update(artifact).digest("hex");
      const target = parseS3Uri(item.uri);
      const result = await client.send(new PutObjectCommand({
        Body: artifact,
        Bucket: target.bucket,
        ContentType: "text/x-python; charset=utf-8",
        Key: target.key,
        Metadata: {
          "asklake-sha256": checksum,
        },
      }));
      uploaded.push({
        checksum,
        etag: String(result?.ETag || "").replace(/^\"|\"$/g, ""),
        sizeBytes: artifact.byteLength,
        uri: item.uri,
      });
    }
    const entryPoint = uploaded[0];
    return Object.freeze({
      checksum: entryPoint.checksum,
      dependencies: Object.freeze(uploaded.slice(1)),
      entryPointUri: config.entryPointUri,
      etag: entryPoint.etag,
      mode: continuous ? "STREAMING" : "BATCH",
      region: config.region,
      sizeBytes: entryPoint.sizeBytes,
    });
  } catch (error) {
    const wrapped = artifactError(
      `EMR Serverless artifact upload failed: ${safeEmrServerlessMessage(error?.message || error)}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseS3Uri(value) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/i.exec(String(value || ""));
  if (!match) throw artifactError("EMR Serverless entry-point URI must identify an S3 object.");
  return { bucket: match[1], key: match[2] };
}

function artifactError(message) {
  const error = new Error(safeEmrServerlessMessage(message));
  error.code = "EMR_SERVERLESS_ARTIFACT_UPLOAD_FAILED";
  error.status = 502;
  return error;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await uploadEmrServerlessArtifact(
      process.env,
      {},
      { continuous: process.argv.includes("--continuous") },
    );
    console.log(`ASKLAKE_EMR_SERVERLESS_ARTIFACT=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(safeEmrServerlessMessage(error?.message || error));
    process.exitCode = 1;
  }
}
