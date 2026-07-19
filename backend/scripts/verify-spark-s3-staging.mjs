import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const fixturePath = path.join(backendDir, "fixtures", "rules", "snapshot-pipeline-input.jsonl");
const enabled = process.env.ASKLAKE_VERIFY_S3_STAGING_LIVE === "true";

if (!enabled) {
  console.log("verify-spark-s3-staging: skipped (set ASKLAKE_VERIFY_S3_STAGING_LIVE=true)");
  process.exit(0);
}

const bucket = requiredEnvironment("ASKLAKE_VERIFY_S3_STAGING_BUCKET");
const region = requiredEnvironment("AWS_REGION");
assertValidBucket(bucket);

const runId = `issue-931-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const runPrefix = `asklake-validation/issue-931/${runId}/`;
const sourceKey = `${runPrefix}input.jsonl`;
const outputKey = `${runPrefix}output`;
const sourceUri = `s3a://${bucket}/${sourceKey}`;
const outputUri = `s3a://${bucket}/${outputKey}`;
const tempDir = mkdtempSync(path.join(os.tmpdir(), "asklake-s3-staging-"));
const ivyDir = path.join(backendDir, "tmp", "spark-ivy");
const manifestPath = path.join(tempDir, "manifest.json");
const reportPath = path.join(tempDir, "report.json");
const client = new S3Client({ region });
let verificationError;

chmodSync(tempDir, 0o777);
mkdirSync(ivyDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(snapshotManifest(), null, 2)}\n`, "utf8");

try {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: sourceKey,
    Body: readFileSync(fixturePath),
    ContentType: "application/x-ndjson",
  }));

  const credentials = await client.config.credentials();
  const childEnvironment = {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_EC2_METADATA_DISABLED: "true",
  };
  if (credentials.sessionToken) {
    childEnvironment.AWS_SESSION_TOKEN = credentials.sessionToken;
  } else {
    delete childEnvironment.AWS_SESSION_TOKEN;
  }

  const processResult = spawnSync("docker", [
    "run",
    "--rm",
    "-e", "AWS_ACCESS_KEY_ID",
    "-e", "AWS_SECRET_ACCESS_KEY",
    ...(credentials.sessionToken ? ["-e", "AWS_SESSION_TOKEN"] : []),
    "-e", "AWS_REGION",
    "-e", "AWS_DEFAULT_REGION",
    "-e", "AWS_EC2_METADATA_DISABLED",
    "-e", "ASKLAKE_OBJECT_STORAGE_PROVIDER=aws",
    "-e", "S3_FORCE_PATH_STYLE=false",
    "-e", "SPARK_LOCAL_IP=127.0.0.1",
    "-e", `ASKLAKE_SPARK_SOURCE_PATH=${sourceUri}`,
    "-e", "ASKLAKE_SPARK_SOURCE_FORMAT=jsonl",
    "-e", `ASKLAKE_SPARK_OUTPUT_PATH=${outputUri}`,
    "-e", `ASKLAKE_SPARK_RUN_ID=${runId}`,
    "-e", "ASKLAKE_SPARK_JOB_MANIFEST_FILE=/work/runtime/manifest.json",
    "-e", "ASKLAKE_SPARK_REPORT_FILE=/work/runtime/report.json",
    "-e", "ASKLAKE_SPARK_RUN_ROW_LIMIT=0",
    "-e", "HOME=/tmp",
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${tempDir}:/work/runtime`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master", "local[2]",
    "--conf", "spark.ui.enabled=false",
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    "--packages",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
    "/work/scripts/spark_job_run.py",
  ], {
    cwd: backendDir,
    encoding: "utf8",
    env: childEnvironment,
    maxBuffer: 32 * 1024 * 1024,
  });

  assert(processResult.status === 0, `Spark process failed (exit=${processResult.status ?? "unknown"})`);
  assertFileReport(reportPath);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(report.status === "success", "Spark report did not record success");
  assert(report.inputRows === 3, `Expected 3 input rows, got ${report.inputRows}`);
  assert(report.outputRows === 3, `Expected 3 output rows, got ${report.outputRows}`);
  assert(report.sparkResources?.cacheStorageLevel === "NONE", "Executor DataFrame cache must remain disabled");
  assert(
    report.sparkResources?.materializationMode === "run_scoped_parquet_staging",
    "Run-scoped Parquet materialization evidence is missing",
  );
  assert(
    report.sparkResources?.outputFrameCacheMode === "staged_parquet_reuse",
    "Downstream stages did not report staged Parquet reuse",
  );
  assert(
    report.sparkResources?.materializationFileCount > 0,
    "No staged Parquet files were observed",
  );
  assert(
    report.sparkResources?.materializationCleanupStatus === "success",
    "Spark did not report successful staging cleanup",
  );
  assert(
    report.phaseTimings?.materializationStaging?.durationMs >= 0,
    "Materialization timing evidence is missing",
  );

  const sourceReadMarker = `FileScanRDD: Reading File path: ${sourceUri}`;
  const sourceReadCount = processResult.stderr.split(sourceReadMarker).length - 1;
  assert(sourceReadCount === 1, `Expected exactly 1 raw source read, got ${sourceReadCount}`);

  const objectsBeforeCleanup = await listCurrentObjects(client, bucket, runPrefix);
  const outputParquetCount = objectsBeforeCleanup.filter(
    (key) => key.startsWith(`${outputKey}/`) && key.endsWith(".parquet"),
  ).length;
  const stagingResidueCount = objectsBeforeCleanup.filter(
    (key) => key.includes(".__materialization__") || key.includes(".__staging__"),
  ).length;
  assert(outputParquetCount > 0, "Published S3 output contains no Parquet objects");
  assert(stagingResidueCount === 0, `Expected no Spark staging objects, got ${stagingResidueCount}`);

  console.log("verify-spark-s3-staging: Spark/S3 assertions ok");
  console.log(`rows: source=${report.inputRows}, output=${report.outputRows}`);
  console.log(`rawSourceReads=${sourceReadCount}, publishedParquetObjects=${outputParquetCount}, stagingResidue=${stagingResidueCount}`);
} catch (error) {
  verificationError = error;
} finally {
  try {
    await deleteCurrentObjects(client, bucket, runPrefix);
    await deleteObjectVersions(client, bucket, runPrefix);
    const remainingObjects = await listCurrentObjects(client, bucket, runPrefix);
    const remainingVersions = await listObjectVersions(client, bucket, runPrefix);
    assert(remainingObjects.length === 0, `Current-object cleanup left ${remainingObjects.length} objects`);
    assert(
      remainingVersions.length === 0,
      `Version cleanup left ${remainingVersions.length} versions or delete markers`,
    );
    console.log("S3 cleanup: currentObjects=0, versionsAndDeleteMarkers=0");
  } catch (cleanupError) {
    verificationError = verificationError
      ? new Error(`${safeError(verificationError)}; cleanup failed: ${safeError(cleanupError)}`)
      : cleanupError;
  }
  client.destroy();
  rmSync(tempDir, { force: true, recursive: true });
}

if (verificationError) {
  console.error(`verify-spark-s3-staging: failed (${safeError(verificationError)})`);
  process.exit(1);
}

console.log("verify-spark-s3-staging: ok");

function snapshotManifest() {
  const schemaColumns = [
    { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
    { included: true, nullable: true, sourceName: "rating", targetName: "rating", type: "String" },
    { included: true, nullable: true, sourceName: "status", targetName: "status", type: "String" },
    { included: true, nullable: true, sourceName: "email", targetName: "email", type: "String" },
    { included: true, nullable: true, sourceName: "raw.reviewerID", targetName: "raw_reviewerid", type: "String" },
  ];
  return {
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: schemaColumns.map((column) => [column.targetName, column.type]),
    rules: [],
    schemaColumns,
    transformSteps: [],
  };
}

async function listCurrentObjects(s3, targetBucket, prefix) {
  const keys = [];
  let continuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: targetBucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of response.Contents || []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteCurrentObjects(s3, targetBucket, prefix) {
  const keys = await listCurrentObjects(s3, targetBucket, prefix);
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const batch = keys.slice(offset, offset + 1000);
    const response = await s3.send(new DeleteObjectsCommand({
      Bucket: targetBucket,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
    assert(
      !(response.Errors?.length),
      `S3 cleanup reported ${response.Errors?.length ?? 0} object errors`,
    );
  }
}

async function listObjectVersions(s3, targetBucket, prefix) {
  const versions = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const response = await s3.send(new ListObjectVersionsCommand({
      Bucket: targetBucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));
    for (const item of [...(response.Versions || []), ...(response.DeleteMarkers || [])]) {
      if (item.Key && item.VersionId) {
        versions.push({ Key: item.Key, VersionId: item.VersionId });
      }
    }
    keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
    versionIdMarker = response.IsTruncated ? response.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return versions;
}

async function deleteObjectVersions(s3, targetBucket, prefix) {
  const versions = await listObjectVersions(s3, targetBucket, prefix);
  for (let offset = 0; offset < versions.length; offset += 1000) {
    const batch = versions.slice(offset, offset + 1000);
    const response = await s3.send(new DeleteObjectsCommand({
      Bucket: targetBucket,
      Delete: {
        Objects: batch,
        Quiet: true,
      },
    }));
    assert(
      !(response.Errors?.length),
      `S3 version cleanup reported ${response.Errors?.length ?? 0} object errors`,
    );
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertValidBucket(value) {
  assert(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !value.includes(".."),
    "ASKLAKE_VERIFY_S3_STAGING_BUCKET is not a valid S3 bucket name",
  );
}

function assertFileReport(value) {
  try {
    readFileSync(value);
  } catch {
    throw new Error("Spark process did not write a report");
  }
}

function safeError(error) {
  if (error instanceof Error && /^[-A-Za-z0-9_ ().;=:]+$/.test(error.message)) {
    return error.message.slice(0, 500);
  }
  if (error?.name) return String(error.name).slice(0, 100);
  return "unknown error";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
