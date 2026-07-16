#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";

import { generateAuthToken } from "aws-msk-iam-sasl-signer-js";
import { Kafka, logLevel } from "kafkajs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const brokers = required("ASKLAKE_KAFKA_BROKER").split(",").map((value) => value.trim()).filter(Boolean);
const topic = required("ASKLAKE_FIXTURE_TOPIC");
const batchId = required("ASKLAKE_FIXTURE_BATCH_ID");
const region = required("AWS_REGION");
const expectedCount = Number.parseInt(required("ASKLAKE_FIXTURE_EXPECTED_COUNT"), 10);
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 10_000) {
  throw new Error("ASKLAKE_FIXTURE_EXPECTED_COUNT must be between 1 and 10000");
}
if (!/^eks-mvp-[a-z0-9-]{8,80}$/.test(batchId)) throw new Error("fixture batch ID is invalid");

const createdAt = new Date().toISOString();
const payloads = Array.from({ length: expectedCount }, (_, index) => {
  const sequence = index + 1;
  return {
    schema_version: "eks-mvp-fixture-v1",
    event_id: `${batchId}-${String(sequence).padStart(6, "0")}`,
    source: "asklake-eks-external-fixture-producer",
    offset: sequence,
    review: `AskLake EKS bounded fixture review ${sequence}`,
    created_at: createdAt,
    raw: { fixture_batch_id: batchId, sequence, expected_count: expectedCount },
  };
});
const serialized = payloads.map((payload) => JSON.stringify(payload));
const digest = createHash("sha256").update(serialized.join("\n")).digest("hex");
const kafka = new Kafka({
  clientId: `asklake-external-fixture-${batchId.slice(-16)}`,
  brokers,
  ssl: true,
  sasl: {
    mechanism: "oauthbearer",
    oauthBearerProvider: async () => ({ value: (await generateAuthToken({ region })).token }),
  },
  connectionTimeout: 10_000,
  authenticationTimeout: 10_000,
  requestTimeout: 60_000,
  retry: { retries: 4, initialRetryTime: 300, maxRetryTime: 3_000 },
  logLevel: logLevel.NOTHING,
});
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

try {
  await producer.connect();
  const metadata = await producer.send({
    topic,
    acks: -1,
    messages: serialized.map((value, index) => ({ key: `${batchId}-${index + 1}`, value })),
  });
  const producedCount = serialized.length;
  if (producedCount !== expectedCount || metadata.length === 0) throw new Error("fixture produce acknowledgement is incomplete");
  console.log(JSON.stringify({
    contractVersion: "1.0",
    batchId,
    topic,
    expectedCount,
    producedCount,
    payloadSha256: digest,
    createdAt,
    sequence: { first: 1, last: expectedCount },
    partitionsAcknowledged: [...new Set(metadata.map((item) => item.partition))].length,
  }));
} catch (error) {
  const message = String(error?.cause?.message || error?.message || "");
  const category = /not host this topic|unknown topic/i.test(message) ? "TOPIC_UNAVAILABLE"
    : /authoriz|access denied|sasl/i.test(message) ? "AUTHORIZATION"
      : /timeout|timed out/i.test(message) ? "TIMEOUT"
        : /connection|network|socket/i.test(message) ? "NETWORK"
          : "UNKNOWN";
  console.error(JSON.stringify({
    status: "failed",
    name: String(error?.name || "Error").slice(0, 80),
    code: String(error?.code || error?.type || "UNKNOWN").slice(0, 80),
    causeName: String(error?.cause?.name || "Error").slice(0, 80),
    causeCode: String(error?.cause?.code || error?.cause?.type || "UNKNOWN").slice(0, 80),
    category,
  }));
  process.exitCode = 1;
} finally {
  await producer.disconnect().catch(() => undefined);
}
