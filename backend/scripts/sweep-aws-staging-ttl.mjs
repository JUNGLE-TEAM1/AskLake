import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAwsStagingTtlSweepEvidence,
  evaluateAwsStagingTtlSweepEvidence,
  inspectAwsStagingTerraformState,
} from "../src/awsStagingLifecycle.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"), "utf8"));

if (isMain()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runAwsStagingTtlSweep(options);
    console.log(`ASKLAKE_AWS_STAGING_TTL_SWEEP=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`AWS staging TTL sweep failed (${error?.code || "AWS_STAGING_TTL_SWEEP_FAILED"}).`);
    process.exitCode = 1;
  }
}

export async function runAwsStagingTtlSweep(options, dependencies = {}) {
  const stateBucket = requiredBucket(options.stateBucket);
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) fail("TTL sweep time is invalid.");
  const s3 = dependencies.s3Client || new S3Client({ region: contract.region });
  const keys = await listStateKeys(s3, stateBucket, contract.lifecycle.ttlSweep.maximumStateFilesPerRun);
  const states = [];
  for (const stateKey of keys) {
    try {
      const body = await s3.send(new GetObjectCommand({ Bucket: stateBucket, Key: stateKey }));
      const terraformState = JSON.parse(await bodyToText(body.Body));
      states.push(inspectAwsStagingTerraformState({ stateKey, terraformState }, contract, now));
    } catch {
      states.push({ reason: "terraform-state-unreadable", stateKey, status: "invalid" });
    }
  }
  const evidence = createAwsStagingTtlSweepEvidence({ states }, contract, now);
  const evaluated = evaluateAwsStagingTtlSweepEvidence(evidence, contract);
  writeFileSync(options.outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze({
    attentionRequired: evaluated.attentionRequired,
    ...evaluated.summary,
    outputFile: options.outputFile,
  });
}

async function listStateKeys(s3, bucket, maximum) {
  const keys = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      Prefix: "asklake/staging/",
    }));
    for (const item of page.Contents || []) {
      const key = String(item?.Key || "");
      if (/^asklake\/staging\/[a-z0-9][a-z0-9-]{2,15}\/terraform\.tfstate$/.test(key)) keys.push(key);
      if (keys.length > maximum) fail("TTL sweep state count exceeds the Phase contract.");
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
}

async function bodyToText(body) {
  if (!body) fail("Terraform state object body is missing.");
  if (typeof body.transformToString === "function") return body.transformToString("utf8");
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const name = key === "--state-bucket" ? "stateBucket" : key === "--output-file" ? "outputFile" : key === "--now" ? "now" : null;
    if (!name || !argv[index + 1]) fail("TTL sweep arguments are invalid.");
    result[name] = argv[index + 1];
    index += 1;
  }
  if (!result.stateBucket || !result.outputFile) fail("TTL sweep arguments are incomplete.");
  return result;
}

function requiredBucket(value) {
  const bucket = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail("TTL sweep state bucket is invalid.");
  return bucket;
}

function isMain() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_TTL_SWEEP_FAILED";
  throw error;
}
