import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import { createEmrJarBundle, uploadEmrJarBundle } from "../src/emrJarBundle.mjs";

export async function uploadContinuousJarDirectory({ directory, environment = process.env, resultFile, s3Client }) {
  const region = String(environment.AWS_REGION || "").trim();
  if (region !== "ap-northeast-2") throw jarUploadError("AWS staging JAR upload requires ap-northeast-2.");
  const bundle = createEmrJarBundle(directory, environment.ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI);
  const manifest = await uploadEmrJarBundle(bundle, s3Client || new S3Client({ region }));
  if (resultFile) atomicPrivateWrite(resultFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function atomicPrivateWrite(targetValue, content) {
  const target = path.resolve(targetValue);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !["--directory", "--result-file"].includes(name)) throw jarUploadError("JAR upload arguments are invalid.");
    result[name === "--directory" ? "directory" : "resultFile"] = value;
  }
  if (!result.directory || !result.resultFile) throw jarUploadError("JAR directory and result file are required.");
  return result;
}

function jarUploadError(message) {
  const error = new Error(message);
  error.code = "EMR_JAR_UPLOAD_INVALID";
  return error;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await uploadContinuousJarDirectory(options);
    console.log(`ASKLAKE_EMR_JAR_BUNDLE=${JSON.stringify({
      bundleSha256: manifest.bundleSha256,
      jarCount: manifest.jarCount,
      manifestUri: manifest.manifestUri,
    })}`);
  } catch (error) {
    console.error(`EMR Continuous JAR upload failed (${error?.code || "INVALID_INPUT"}).`);
    process.exitCode = 1;
  }
}
