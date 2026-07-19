import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { testObjectStorageSource } from "../src/connectors.mjs";
import {
  objectStorageDockerEnv,
  resolveObjectStorageConfig,
  resolveInheritedObjectStorageCredentials,
  s3ClientOptions,
} from "../src/objectStorageConfig.mjs";
import { listS3Buckets } from "../src/s3.service.mjs";
import { assertSparkRestStorageCredentials, normalizeSparkOutputTargetPath } from "../src/sparkRunner.mjs";

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
  "S3_ALLOWED_BUCKETS",
  "AWS_S3_ALLOWED_BUCKETS",
  "ASKLAKE_S3_ALLOWED_BUCKETS",
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
  const minioWithMaskedDraftCredentials = resolveObjectStorageConfig([
    ["Storage Provider", "MinIO"],
    ["Access Key", "********"],
    ["Secret Key", "[REDACTED]"],
  ]);
  assert.equal(minioWithMaskedDraftCredentials.accessKeyId, "local-access");
  assert.equal(minioWithMaskedDraftCredentials.secretAccessKey, "local-secret");
  assert.ok(objectStorageDockerEnv().some(([name, value]) => name === "MINIO_ENDPOINT" && value === "http://m3-minio:9000"));
  const loopbackFields = [
    ["Storage Provider", "MinIO"],
    ["Endpoint URL", "http://127.0.0.1:9000"],
  ];
  assert.equal(resolveObjectStorageConfig(loopbackFields).endpoint, "http://127.0.0.1:9000");
  assert.equal(resolveObjectStorageConfig(loopbackFields, { docker: true }).endpoint, "http://m3-minio:9000");
  assert.equal(
    resolveObjectStorageConfig([
      ["Storage Provider", "MinIO"],
      ["Endpoint URL", "http://minio.internal:9000"],
    ], { docker: true }).endpoint,
    "http://minio.internal:9000",
  );

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
  process.env.AWS_ACCESS_KEY_ID = "local-compatible-access";
  process.env.AWS_SECRET_ACCESS_KEY = "local-compatible-secret";
  assert.deepEqual(resolveInheritedObjectStorageCredentials([], { docker: true }), {
    accessKeyId: "local-compatible-access",
    secretAccessKey: "local-compatible-secret",
  });
  assert.doesNotThrow(() => assertSparkRestStorageCredentials([
    ["Storage Provider", "MinIO"],
    ["Access Key", "local-compatible-access"],
    ["Secret Key", "local-compatible-secret"],
  ], "rest"));
  assert.throws(
    () => assertSparkRestStorageCredentials([
      ["Storage Provider", "MinIO"],
      ["Access Key", "different-access"],
      ["Secret Key", "different-secret"],
    ], "rest"),
    (error) => error?.code === "SPARK_RUNNER_CONFIGURATION_INVALID",
  );
  assert.throws(
    () => listS3Buckets(),
    (error) => error?.code === "SERVICE_UNAVAILABLE" && error?.status === 503,
  );

  const selectedObject = "e2e/smoke/products.csv";
  const csvSample = "product_id,name\np-100,Desk Lamp\np-101,Monitor Stand\n";
  const requestedCommands = [];
  const preview = await testObjectStorageSource([
    ["Storage Provider", "Amazon S3"],
    ["Region", "ap-northeast-2"],
    ["Bucket / Stage Name", "asklake-dev-output-123-apne2"],
    ["Path / Prefix", selectedObject],
    ["Access Key", ""],
    ["Secret Key", ""],
    ["Use Path Style", "false"],
    ["__Selected Object", selectedObject],
    ["__Sample Object", selectedObject],
  ], "File / S3", {
    async send(command) {
      requestedCommands.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: [{ Key: selectedObject, LastModified: new Date("2026-07-13T00:00:00Z"), Size: Buffer.byteLength(csvSample) }],
        };
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: Readable.from([csvSample]) };
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    },
  });
  assert.deepEqual(requestedCommands, ["ListObjectsV2Command", "GetObjectCommand"]);
  assert.equal(preview.status, "success");
  assert.deepEqual(preview.previewColumns, ["product_id", "name"]);
  assert.deepEqual(preview.previewRows, [["p-100", "Desk Lamp"], ["p-101", "Monitor Stand"]]);
  await assert.rejects(
    testObjectStorageSource([
      ["Storage Provider", "MinIO"],
      ["Endpoint URL", "http://127.0.0.1:9000"],
      ["Bucket / Stage Name", "m3-raw"],
      ["Path / Prefix", selectedObject],
      ["Access Key", ""],
      ["Secret Key", ""],
      ["__Selected Object", selectedObject],
    ], "File / S3", { send: async () => ({}) }),
    (error) => error?.code === "SOURCE_CREDENTIALS_REQUIRED",
  );

  process.env.ASKLAKE_SPARK_OUTPUT_BUCKET = "asklake-dev-output-123-apne2";
  process.env.S3_ALLOWED_BUCKETS = "asklake-dev-raw-123-apne2,asklake-dev-output-123-apne2";
  assert.deepEqual(listS3Buckets().buckets, [
    "asklake-dev-output-123-apne2",
    "asklake-dev-raw-123-apne2",
  ]);
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
