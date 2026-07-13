import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { emrServerlessConfig, safeEmrServerlessMessage } from "../src/emrServerless.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function uploadEmrServerlessArtifact(environment = process.env, dependencies = {}) {
  const config = emrServerlessConfig(environment);
  const sourceFile = path.resolve(
    environment.ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_FILE
      || path.join(backendDir, "scripts", "spark_job_run.py"),
  );
  if (!existsSync(sourceFile)) {
    throw artifactError("The configured EMR Serverless PySpark entry-point file does not exist.");
  }
  const artifact = readFileSync(sourceFile);
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const target = parseS3Uri(config.entryPointUri);
  const client = dependencies.s3Client || new S3Client({ region: config.region });
  try {
    const result = await client.send(new PutObjectCommand({
      Body: artifact,
      Bucket: target.bucket,
      ContentType: "text/x-python; charset=utf-8",
      Key: target.key,
      Metadata: {
        "asklake-sha256": checksum,
      },
    }));
    return Object.freeze({
      checksum,
      entryPointUri: config.entryPointUri,
      etag: String(result?.ETag || "").replace(/^\"|\"$/g, ""),
      region: config.region,
      sizeBytes: artifact.byteLength,
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
    const result = await uploadEmrServerlessArtifact();
    console.log(`ASKLAKE_EMR_SERVERLESS_ARTIFACT=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(safeEmrServerlessMessage(error?.message || error));
    process.exitCode = 1;
  }
}
