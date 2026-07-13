import assert from "node:assert/strict";
import {
  objectStorageDockerEnv,
  resolveObjectStorageConfig,
  s3ClientOptions,
} from "../src/objectStorageConfig.mjs";
import { normalizeSparkOutputTargetPath } from "../src/sparkRunner.mjs";

const managedNames = [
  "ASKLAKE_OBJECT_STORAGE_PROVIDER",
  "ASKLAKE_RAW_BUCKET",
  "ASKLAKE_SPARK_OUTPUT_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_ENDPOINT_URL_S3",
  "MINIO_ACCESS_KEY",
  "MINIO_ENDPOINT",
  "MINIO_ENDPOINT_IN_DOCKER",
  "MINIO_REGION",
  "MINIO_SECRET_KEY",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "S3_REGION",
];

const previous = Object.fromEntries(managedNames.map((name) => [name, process.env[name]]));

try {
  for (const name of managedNames) delete process.env[name];

  process.env.ASKLAKE_OBJECT_STORAGE_PROVIDER = "minio";
  process.env.MINIO_ENDPOINT = "http://127.0.0.1:9000";
  process.env.MINIO_ENDPOINT_IN_DOCKER = "http://m3-minio:9000";
  process.env.MINIO_ACCESS_KEY = "local-access";
  process.env.MINIO_SECRET_KEY = "local-secret";
  const minio = resolveObjectStorageConfig();
  assert.equal(minio.provider, "minio");
  assert.equal(minio.endpoint, "http://127.0.0.1:9000");
  assert.equal(minio.forcePathStyle, true);
  assert.deepEqual(s3ClientOptions(minio).credentials, {
    accessKeyId: "local-access",
    secretAccessKey: "local-secret",
  });
  assert.ok(objectStorageDockerEnv().some(([name, value]) => name === "MINIO_ENDPOINT" && value === "http://m3-minio:9000"));

  for (const name of managedNames) delete process.env[name];
  process.env.ASKLAKE_OBJECT_STORAGE_PROVIDER = "aws";
  process.env.AWS_REGION = "ap-northeast-2";
  const aws = resolveObjectStorageConfig();
  const awsOptions = s3ClientOptions(aws);
  const awsDockerEnv = objectStorageDockerEnv();
  assert.equal(aws.provider, "aws");
  assert.equal(aws.endpoint, "");
  assert.equal(aws.forcePathStyle, false);
  assert.equal(aws.region, "ap-northeast-2");
  assert.equal("credentials" in awsOptions, false);
  assert.equal("endpoint" in awsOptions, false);
  assert.equal(awsDockerEnv.some(([name]) => name.startsWith("MINIO_")), false);
  assert.equal(awsDockerEnv.some(([name]) => name === "AWS_ACCESS_KEY_ID" || name === "AWS_SECRET_ACCESS_KEY"), false);
  process.env.ASKLAKE_SPARK_OUTPUT_BUCKET = "asklake-dev-output-123-apne2";
  assert.equal(
    normalizeSparkOutputTargetPath("s3a://asklake-output/products/gold/"),
    "s3a://asklake-dev-output-123-apne2/products/gold",
  );
  assert.equal(
    normalizeSparkOutputTargetPath("s3://custom-output/products/gold/"),
    "s3a://custom-output/products/gold",
  );

  console.log("Object storage mode verification passed.");
} finally {
  for (const name of managedNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}
