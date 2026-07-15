import process from "node:process";

import { generateAuthToken } from "aws-msk-iam-sasl-signer-js";
import { Kafka, logLevel } from "kafkajs";

const CONTRACT_ONLY = process.argv.includes("--contract-only");

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(String(process.env[name] || fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function mskIamClientConfig({ brokers, region, timeoutMs }) {
  if (!Array.isArray(brokers) || brokers.length === 0 || brokers.some((broker) => !broker.includes(":"))) {
    throw new Error("ASKLAKE_KAFKA_BROKER must contain at least one host:port broker");
  }
  if (!region) throw new Error("AWS_REGION is required");
  return {
    clientId: "asklake-eks-msk-iam-smoke",
    brokers,
    ssl: true,
    sasl: {
      mechanism: "oauthbearer",
      oauthBearerProvider: async () => {
        const response = await generateAuthToken({ region });
        return { value: response.token };
      },
    },
    connectionTimeout: Math.min(timeoutMs, 10_000),
    authenticationTimeout: Math.min(timeoutMs, 10_000),
    requestTimeout: timeoutMs,
    retry: { retries: 2, initialRetryTime: 300, maxRetryTime: 2_000 },
    logLevel: logLevel.NOTHING,
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MSK metadata check exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (CONTRACT_ONLY) {
    const config = mskIamClientConfig({
      brokers: ["broker.example.invalid:9098"],
      region: "ap-northeast-2",
      timeoutMs: 60_000,
    });
    if (!config.ssl || config.sasl.mechanism !== "oauthbearer" || typeof config.sasl.oauthBearerProvider !== "function") {
      throw new Error("MSK IAM KafkaJS contract is incomplete");
    }
    console.log(JSON.stringify({ authMode: "iam", contract: "valid", port: 9098, ssl: true }));
    return;
  }

  const authMode = requiredEnvironment("ASKLAKE_KAFKA_AUTH_MODE").toLowerCase();
  if (authMode !== "iam") throw new Error("ASKLAKE_KAFKA_AUTH_MODE must be iam");
  const brokers = requiredEnvironment("ASKLAKE_KAFKA_BROKER")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const region = requiredEnvironment("AWS_REGION");
  const topic = requiredEnvironment("ASKLAKE_MSK_SMOKE_TOPIC");
  const timeoutMs = boundedInteger("ASKLAKE_MSK_SMOKE_TIMEOUT_SECONDS", 60, 10, 300) * 1_000;
  const kafka = new Kafka(mskIamClientConfig({ brokers, region, timeoutMs }));
  const admin = kafka.admin();

  try {
    await withTimeout(admin.connect(), timeoutMs);
    const metadata = await withTimeout(admin.fetchTopicMetadata({ topics: [topic] }), timeoutMs);
    const topicMetadata = metadata.topics.find((item) => item.name === topic);
    if (!topicMetadata || topicMetadata.partitions.length === 0) {
      throw new Error(`MSK topic metadata is empty for ${topic}`);
    }
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      partitionCount: topicMetadata.partitions.length,
      region,
      status: "success",
      topic,
    }));
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    message: String(error?.message || error).slice(0, 1_000),
    status: "failed",
  }));
  process.exitCode = 1;
});
