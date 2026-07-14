import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EMRServerlessClient, GetJobRunCommand } from "@aws-sdk/client-emr-serverless";
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  AWS_STAGING_SMOKE_EVIDENCE_SCHEMA,
  createAwsStagingSmokePlan,
  evaluateAwsStagingSmokeEvidence,
  smokeEvidenceSha256,
} from "../src/awsStagingSmoke.mjs";
import {
  createEmrServerlessBatchSubmission,
  emrServerlessArtifactUris,
  emrServerlessContinuousArtifactUris,
} from "../src/emrServerless.mjs";
import {
  assertKafkaTopicPolicy,
  createKafkaClient,
  kafkaTopicCreationSpec,
  resolveKafkaRuntimeConfig,
} from "../src/kafkaRuntime.mjs";
import { runKafkaRoundtripProbe } from "../src/kafkaRoundtripProbe.mjs";
import { runEmrServerlessRequest } from "./emr-serverless-client.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const backendRoot = path.join(repositoryRoot, "backend");
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));

if (isMain()) {
  try {
    const result = await runAwsStagingSmoke();
    console.log(`ASKLAKE_AWS_STAGING_SMOKE_RESULT=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`AWS staging smoke failed (${error?.code || "AWS_STAGING_SMOKE_FAILED"}).`);
    process.exitCode = 1;
  }
}

export async function runAwsStagingSmoke(environment = process.env, dependencies = {}) {
  if (String(environment.APP_ENV || "").trim().toLowerCase() !== "production") {
    fail("Phase 4 smoke requires APP_ENV=production.");
  }
  const plan = createAwsStagingSmokePlan({
    runtimeRootUri: environment.ASKLAKE_AWS_STAGING_RUNTIME_ROOT_URI,
    sourceRevision: environment.ASKLAKE_AWS_STAGING_SOURCE_REVISION,
    smokeBundleSha256: environment.ASKLAKE_AWS_STAGING_SMOKE_BUNDLE_SHA256,
    stackId: environment.ASKLAKE_AWS_STAGING_STACK_ID,
  }, contract);
  const evidenceUri = requiredS3Uri(environment.ASKLAKE_AWS_STAGING_EVIDENCE_URI, "evidence URI");
  const priceSnapshotUri = requiredS3Uri(environment.ASKLAKE_AWS_STAGING_PRICE_SNAPSHOT_URI, "price snapshot URI");
  const runId = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const temporary = mkdtempSync(path.join(os.tmpdir(), "asklake-aws-smoke-"));
  const s3 = dependencies.s3Client || new S3Client({ region: plan.region });
  const emr = dependencies.emrClient || new EMRServerlessClient({ region: plan.region });
  let continuousJobId = null;
  let continuousRequest = null;
  try {
    const s3Result = await verifyS3Readiness(s3, environment, runId);
    const kafka = resolveKafkaRuntimeConfig({ env: environment });
    const kafkaRuntime = await createKafkaClient({ clientId: `asklake-${runId}`, config: kafka });
    const probe = await runKafkaRoundtripProbe({
      client: kafkaRuntime.client,
      config: kafka,
      createTopic: true,
      kafkaJs: kafkaRuntime.kafkaJs,
      timeoutMs: 30_000,
      topic: `${kafka.topicPrefix}.probe`,
    });
    const continuousTopic = `${kafka.topicPrefix}.continuous-smoke.${runId}`;
    const continuousTopicPolicy = await ensureKafkaTopic(
      kafkaRuntime.client,
      kafkaRuntime.kafkaJs,
      kafka,
      continuousTopic,
    );
    const msk = {
      ...probe,
      continuousTopic,
      continuousTopicPartitions: continuousTopicPolicy.partitions,
      continuousTopicPolicyMismatches: continuousTopicPolicy.mismatches,
    };

    const batch = await runBatchSmoke({ emr, environment, runId, s3, temporary });
    continuousJobId = `phase4-${plan.stackId}`;
    continuousRequest = continuousRequestFor(environment, continuousJobId, continuousTopic, runId);
    const continuous = await runContinuousSmoke({
      client: kafkaRuntime.client,
      contract,
      emr,
      environment,
      request: continuousRequest,
      runId,
    });
    const storage = await verifyStorageEvidence(s3, batch, continuous);
    await s3.send(new HeadObjectCommand(parseS3Command(priceSnapshotUri)));
    const emrJobRuns = [];
    emrJobRuns.push(await readJobRunEvidence(emr, batch.applicationId, batch.jobRunId, "batch"));
    for (const attempt of continuous.attempts) {
      emrJobRuns.push(await readJobRunEvidence(emr, continuous.applicationId, attempt.jobRunId, "continuous"));
    }
    const checks = Object.fromEntries(contract.smoke.requiredChecks.map((name) => [name, { status: "passed" }]));
    const evidence = {
      schemaVersion: AWS_STAGING_SMOKE_EVIDENCE_SCHEMA,
      batch,
      checks,
      completedAt: new Date().toISOString(),
      continuous,
      contractId: contract.contractId,
      environment: plan.environment,
      msk,
      region: plan.region,
      resources: {
        emrJobRuns,
        priceSnapshotCaptured: true,
        priceSnapshotUri,
      },
      runtimeRootUri: plan.runtimeRootUri,
      s3: s3Result,
      sourceRevision: plan.sourceRevision,
      smokeBundleSha256: plan.smokeBundleSha256,
      stackId: plan.stackId,
      startedAt,
      storage,
    };
    const evaluated = evaluateAwsStagingSmokeEvidence(evidence, contract);
    const evidenceBody = `${JSON.stringify(evidence, null, 2)}\n`;
    await putJsonWithChecksum(s3, evidenceUri, evidenceBody);
    return Object.freeze({
      evidenceSha256: smokeEvidenceSha256(evidence),
      evidenceUri,
      ...evaluated.summary,
    });
  } catch (error) {
    if (continuousJobId && continuousRequest) {
      continuousAction({ ...continuousRequest, action: "terminate" }, environment, true);
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

async function verifyS3Readiness(client, environment, runId) {
  const readBuckets = csv(environment.ASKLAKE_S3_READINESS_READ_BUCKETS);
  const writeBuckets = csv(environment.ASKLAKE_S3_READINESS_WRITE_BUCKETS);
  if (readBuckets.length !== 4 || writeBuckets.length !== 4) fail("Phase 4 requires four readable and writable staging buckets.");
  for (const bucket of [...new Set([...readBuckets, ...writeBuckets])]) {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  }
  for (const bucket of writeBuckets) {
    const key = `__asklake_readiness/${runId}.txt`;
    const body = Buffer.from("asklake-phase4-readiness\n");
    const checksum = sha256Base64(body);
    try {
      const uploaded = await client.send(new PutObjectCommand({
        Body: body,
        Bucket: bucket,
        ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: checksum,
        ContentType: "text/plain",
        Key: key,
      }));
      if (uploaded?.ChecksumSHA256 !== checksum) fail("S3 readiness upload checksum response is invalid.");
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: key }));
      if (head.ChecksumSHA256 !== checksum || head.ContentLength !== body.length) fail("S3 readiness object verification failed.");
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  }
  return { readBucketCount: readBuckets.length, roundTripObjectsDeleted: true, writeBucketCount: writeBuckets.length };
}

async function ensureKafkaTopic(client, kafkaJs, config, topic) {
  const admin = client.admin();
  await admin.connect();
  try {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) {
      const created = await admin.createTopics({
        topics: [kafkaTopicCreationSpec(topic, config)],
        waitForLeaders: true,
      });
      if (!created) fail("Continuous smoke topic was not created.");
    }
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const described = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [{
        configNames: ["retention.ms"],
        name: topic,
        type: kafkaJs.ConfigResourceTypes?.TOPIC ?? 2,
      }],
    });
    return assertKafkaTopicPolicy({
      config,
      configEntries: described?.resources?.[0]?.configEntries || [],
      metadata,
      topic,
    });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function runBatchSmoke({ emr, environment, runId, s3, temporary }) {
  const sourceBucket = requiredBucket(environment.ASKLAKE_AWS_STAGING_ARTIFACT_BUCKET, "artifact bucket");
  const outputBucket = requiredBucket(environment.ASKLAKE_AWS_STAGING_OUTPUT_BUCKET, "output bucket");
  const sourceKey = `smoke/${runId}/batch-input/fixture.jsonl`;
  const fixture = batchFixture(contract.smoke.batchFixtureBytes);
  await putBufferWithChecksum(s3, `s3://${sourceBucket}/${sourceKey}`, fixture.body, "application/x-ndjson");
  const manifestFile = path.join(temporary, "batch-manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify({
    partitionColumns: "",
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleOutputSchema: [],
    rules: [],
    schemaColumns: [
      { included: true, nullable: false, sourceName: "id", targetName: "id", type: "String" },
      { included: true, nullable: false, sourceName: "value", targetName: "value", type: "String" },
    ],
    transformSteps: [],
  })}\n`, { mode: 0o600 });
  const artifacts = emrServerlessArtifactUris(runId, environment);
  const sparkEnvironment = {
    ASKLAKE_REVIEW_ANALYSIS_RUNTIME: "disabled",
    ASKLAKE_SPARK_APP_NAME: `asklake-phase4-batch-${runId}`,
    ASKLAKE_SPARK_OUTPUT_PATH: `s3a://${outputBucket}/smoke/${runId}/batch-output`,
    ASKLAKE_SPARK_RUN_ROW_LIMIT: "0",
    ASKLAKE_SPARK_SOURCE_FORMAT: "jsonl",
    ASKLAKE_SPARK_SOURCE_PATH: `s3a://${sourceBucket}/${sourceKey}`,
  };
  const submission = createEmrServerlessBatchSubmission({
    appName: sparkEnvironment.ASKLAKE_SPARK_APP_NAME,
    jobId: `phase4-batch-${runId}`,
    manifestUri: artifacts.manifestUri,
    reportUri: artifacts.reportUri,
    runId,
    sparkEnvironment,
  }, environment);
  const completed = await runEmrServerlessRequest({
    manifestFile,
    manifestUri: artifacts.manifestUri,
    pollIntervalMs: 5_000,
    reportUri: artifacts.reportUri,
    stateFile: path.join(temporary, "batch-state.json"),
    submission,
    timeoutMs: 45 * 60 * 1000,
  }, { emrClient: emr, s3Client: s3 });
  if (completed.report.status !== "success") fail("EMR Batch smoke did not succeed.");
  return {
    applicationId: completed.state.applicationId,
    inputRows: Number(completed.report.inputRows),
    jobRunId: completed.state.jobRunId,
    outputRows: Number(completed.report.outputRows),
    outputUri: sparkEnvironment.ASKLAKE_SPARK_OUTPUT_PATH.replace(/^s3a:/, "s3:"),
    reportUri: artifacts.reportUri,
    status: completed.report.status,
  };
}

function continuousRequestFor(environment, jobId, topic, runId) {
  const outputBucket = requiredBucket(environment.ASKLAKE_AWS_STAGING_OUTPUT_BUCKET, "output bucket");
  const rules = [];
  return {
    action: "start",
    checkpointPath: `s3a://${outputBucket}/smoke/${runId}/continuous-checkpoint`,
    consumerGroupId: `${environment.ASKLAKE_KAFKA_TOPIC_PREFIX}.continuous-smoke`,
    initialCounts: {},
    initialMetrics: {},
    initialOffsetPolicy: "earliest",
    initialSchemaState: {},
    jobId,
    maxOffsetsPerTrigger: contract.smoke.maxOffsetsPerTrigger,
    outputPath: `s3a://${outputBucket}/smoke/${runId}/continuous-output`,
    ruleContractVersion: "1.0",
    ruleFingerprint: sha256Hex(JSON.stringify({ contractVersion: "1.0", rules })),
    ruleOutputSchema: [],
    rules,
    schemaColumns: [
      { included: true, nullable: false, sourceName: "id", targetName: "id", type: "String" },
      { included: true, nullable: false, sourceName: "value", targetName: "value", type: "String" },
      { included: true, nullable: false, sourceName: "producedAt", targetName: "producedAt", type: "Timestamp" },
    ],
    schemaEvolutionPolicy: { unknownField: "quarantine" },
    topic,
    triggerIntervalSeconds: contract.smoke.microBatchTriggerSeconds,
  };
}

async function runContinuousSmoke({ client, contract: smokeContract, emr, environment, request }) {
  const firstTarget = Math.floor(smokeContract.smoke.recordCount / 2);
  const secondTarget = smokeContract.smoke.recordCount - firstTarget;
  const first = continuousAction(request, environment);
  await waitForDriverRunning(request, environment);
  await produceMessages(client, request.topic, 0, firstTarget, smokeContract.smoke);
  const firstReport = await waitForContinuousCount(request, environment, firstTarget);
  const firstPaused = await pauseAndWait(request, environment);
  const firstState = continuousState(request.jobId);
  const firstAttempt = attemptEvidence(firstPaused, firstState);

  const resumedRequest = {
    ...request,
    initialCounts: {
      consumedCount: Number(firstReport.consumedCount || 0),
      quarantinedCount: Number(firstReport.quarantinedCount || 0),
      storedCount: Number(firstReport.storedCount || 0),
    },
    initialMetrics: firstReport,
    initialSchemaState: {
      schemaChanges: firstReport.schemaChanges || [],
      schemaFingerprint: firstReport.schemaFingerprint,
      schemaStatus: firstReport.schemaStatus,
      schemaVersion: firstReport.schemaVersion,
    },
  };
  const resumed = continuousAction(resumedRequest, environment);
  if (resumed.workerAttemptId === first.workerAttemptId) fail("Continuous resume reused the worker attempt identity.");
  await waitForDriverRunning(resumedRequest, environment);
  await produceMessages(client, request.topic, firstTarget, secondTarget, smokeContract.smoke);
  const finalReport = await waitForContinuousCount(resumedRequest, environment, smokeContract.smoke.recordCount);
  const secondPaused = await pauseAndWait(resumedRequest, environment);
  const secondState = continuousState(request.jobId);
  const secondAttempt = attemptEvidence(secondPaused, secondState);
  const artifacts = emrServerlessContinuousArtifactUris(request.jobId, secondPaused.workerAttemptId, environment);
  return {
    applicationId: secondPaused.applicationId,
    attempts: [firstAttempt, secondAttempt],
    checkpointResumed: firstPaused.lastSuccessfulCheckpoint === secondPaused.lastSuccessfulCheckpoint,
    checkpointUri: request.checkpointPath.replace(/^s3a:/, "s3:"),
    consumedCount: Number(finalReport.consumedCount || 0),
    finalLag: Number(finalReport.lag || 0),
    lagAvailable: finalReport.lagAvailable === true,
    outputUri: request.outputPath.replace(/^s3a:/, "s3:"),
    producedCount: smokeContract.smoke.recordCount,
    quarantinedCount: Number(finalReport.quarantinedCount || 0),
    reportUri: artifacts.reportUri,
    sinkCount: Number(finalReport.storedCount || 0),
  };
}

async function waitForDriverRunning(request, environment) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = continuousAction({ ...request, action: "status" }, environment);
    if (status.driverState === "RUNNING") return status;
    if (["FAILED", "SUCCESS", "CANCELLED"].includes(status.driverState)) fail("Continuous Job became terminal before ingest.");
    await delay(5_000);
  }
  fail("Continuous Job did not enter RUNNING within 15 minutes.");
}

async function waitForContinuousCount(request, environment, expected) {
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = continuousAction({ ...request, action: "status" }, environment);
    const report = status.report || {};
    if (Number(report.consumedCount || 0) === expected
      && Number(report.storedCount || 0) === expected
      && Number(report.quarantinedCount || 0) === 0
      && report.lagAvailable === true
      && Number(report.lag || 0) === 0) return report;
    if (["FAILED", "SUCCESS", "CANCELLED"].includes(status.driverState)) fail("Continuous Job became terminal before reaching the expected count.");
    await delay(10_000);
  }
  fail("Continuous Job did not reach the expected count and zero lag within 45 minutes.");
}

async function pauseAndWait(request, environment) {
  continuousAction({ ...request, action: "pause" }, environment);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = continuousAction({ ...request, action: "status" }, environment);
    if (status.driverState === "CANCELLED" && status.cancelRequestState === "completed") return status;
    if (["FAILED", "SUCCESS"].includes(status.driverState)) fail("Continuous pause did not end in CANCELLED.");
    await delay(5_000);
  }
  fail("Continuous pause did not complete within 15 minutes.");
}

function continuousAction(request, environment, allowFailure = false) {
  const result = spawnSync(process.execPath, [path.join(backendRoot, "scripts", "manage-kafka-continuous.mjs")], {
    cwd: backendRoot,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify(request),
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  const marker = markerPayload(result.stdout, "ASKLAKE_KAFKA_CONTINUOUS_RESULT");
  if (result.status !== 0 || !marker) {
    if (allowFailure) return null;
    fail("Continuous control action failed.");
  }
  return marker;
}

async function produceMessages(client, topic, start, count, smoke) {
  const producer = client.producer();
  await producer.connect();
  const started = Date.now();
  try {
    const batchSize = 500;
    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset);
      const messages = Array.from({ length: size }, (_unused, index) => {
        const id = start + offset + index;
        return { key: String(id), value: fixedPayload(id, smoke.averageMessageBytes) };
      });
      await producer.send({ acks: -1, messages, topic });
      const expectedElapsed = ((offset + size) / smoke.producerRatePerSecond) * 1000;
      const wait = expectedElapsed - (Date.now() - started);
      if (wait > 0) await delay(wait);
    }
  } finally {
    await producer.disconnect().catch(() => undefined);
  }
}

async function verifyStorageEvidence(client, batch, continuous) {
  return {
    batchOutput: await s3PrefixExists(client, batch.outputUri),
    batchReport: await s3ObjectExists(client, batch.reportUri),
    continuousCheckpoint: await s3PrefixExists(client, continuous.checkpointUri),
    continuousOutput: await s3PrefixExists(client, continuous.outputUri),
    continuousReport: await s3ObjectExists(client, continuous.reportUri),
  };
}

async function readJobRunEvidence(client, applicationId, jobRunId, workload) {
  const result = await client.send(new GetJobRunCommand({ applicationId, jobRunId }));
  const job = result?.jobRun;
  if (!job || job.jobRunId !== jobRunId) fail("EMR Job Run evidence is invalid.");
  return {
    applicationId,
    billedResourceUtilization: job.billedResourceUtilization || null,
    jobRunId,
    state: job.state,
    workload,
  };
}

function attemptEvidence(status, state) {
  const submissions = (state.events || []).filter((event) => event.type === "submitted").length;
  return {
    duplicateSubmissionCount: Math.max(0, submissions - 1),
    jobRunId: status.jobRunId,
    workerAttemptId: status.workerAttemptId,
  };
}

function continuousState(jobId) {
  const safe = String(jobId).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  return JSON.parse(readFileSync(path.join(backendRoot, "tmp", "spark-runs", `kafka-continuous-${safe}.emr-state.json`), "utf8"));
}

function batchFixture(minimumBytes) {
  const line = `${JSON.stringify({ id: "phase4", value: "x".repeat(960) })}\n`;
  const lineBuffer = Buffer.from(line);
  const rows = Math.ceil(Number(minimumBytes) / lineBuffer.length);
  const body = Buffer.alloc(rows * lineBuffer.length);
  for (let index = 0; index < rows; index += 1) lineBuffer.copy(body, index * lineBuffer.length);
  return { body, rows };
}

function fixedPayload(id, targetBytes) {
  const base = { id: String(id), producedAt: new Date().toISOString(), value: "" };
  const emptyBytes = Buffer.byteLength(JSON.stringify(base));
  base.value = "x".repeat(Math.max(0, targetBytes - emptyBytes));
  return JSON.stringify(base);
}

async function putBufferWithChecksum(client, uri, body, contentType) {
  const checksum = sha256Base64(body);
  const input = parseS3Command(uri);
  const response = await client.send(new PutObjectCommand({
    ...input,
    Body: body,
    ChecksumAlgorithm: "SHA256",
    ChecksumSHA256: checksum,
    ContentType: contentType,
  }));
  if (response?.ChecksumSHA256 !== checksum) fail("S3 fixture upload checksum response is invalid.");
  const head = await client.send(new HeadObjectCommand({ ...input, ChecksumMode: "ENABLED" }));
  if (head.ChecksumSHA256 !== checksum || head.ContentLength !== body.length) fail("S3 fixture checksum verification failed.");
}

async function putJsonWithChecksum(client, uri, body) {
  await putBufferWithChecksum(client, uri, Buffer.from(body), "application/json; charset=utf-8");
}

async function s3ObjectExists(client, uri) {
  try {
    await client.send(new HeadObjectCommand(parseS3Command(uri)));
    return true;
  } catch {
    return false;
  }
}

async function s3PrefixExists(client, uri) {
  const target = parseS3Command(uri);
  const result = await client.send(new ListObjectsV2Command({ Bucket: target.Bucket, MaxKeys: 1, Prefix: `${target.Key.replace(/\/+$/, "")}/` }));
  return Number(result.KeyCount || result.Contents?.length || 0) > 0;
}

function markerPayload(stdout, marker) {
  const line = String(stdout || "").split(/\r?\n/).find((item) => item.startsWith(`${marker}=`));
  if (!line) return null;
  try { return JSON.parse(line.slice(marker.length + 1)); } catch { return null; }
}

function parseS3Command(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(uri || ""));
  if (!match) fail("S3 URI is invalid.");
  return { Bucket: match[1], Key: match[2] };
}

function requiredS3Uri(value, name) {
  const text = String(value || "").trim();
  if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(text)) fail(`${name} is invalid.`);
  return text;
}

function requiredBucket(value, name) {
  const text = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text)) fail(`${name} is invalid.`);
  return text;
}

function csv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function sha256Base64(value) { return createHash("sha256").update(value).digest("base64"); }
function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isMain() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_SMOKE_FAILED";
  throw error;
}
