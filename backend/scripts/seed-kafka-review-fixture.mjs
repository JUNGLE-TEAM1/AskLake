import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = path.resolve(scriptDir, "../fixtures/kafka/amazon-review-fixture.jsonl");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const topic = process.env.ASKLAKE_REVIEW_KAFKA_TOPIC || "reviews.raw";
const fixturePath = process.env.ASKLAKE_REVIEW_FIXTURE_PATH || defaultFixturePath;
const recreateTopic = process.env.ASKLAKE_RECREATE_REVIEW_TOPIC !== "false";

const records = loadFixtureRecords(fixturePath);

if (dryRun) {
  console.log(`Review Kafka fixture valid: ${records.length} messages from ${fixturePath}`);
  console.log(`Target topic: ${topic}`);
  process.exit(0);
}

const { Kafka } = await import("kafkajs");
const kafka = new Kafka({
  brokers: [broker],
  clientId: "asklake-review-fixture-producer",
  retry: { retries: 2 },
});
const admin = kafka.admin();
const producer = kafka.producer();

try {
  await admin.connect();
  await ensureTopic(admin, topic);
  await producer.connect();
  await producer.send({
    topic,
    messages: records.map((record) => ({
      key: record.event_id,
      value: JSON.stringify(record),
    })),
  });
  console.log(`Review Kafka fixture produced: ${records.length} messages to ${topic} at ${broker}`);
} finally {
  await producer.disconnect().catch(() => {});
  await admin.disconnect().catch(() => {});
}

function loadFixtureRecords(targetPath) {
  const lines = readFileSync(targetPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`Review fixture is empty: ${targetPath}`);
  return lines.map((line, index) => validateRecord(JSON.parse(line), index + 1));
}

function validateRecord(record, lineNumber) {
  const required = ["schema_version", "event_id", "source", "offset", "review", "created_at", "raw"];
  for (const field of required) {
    if (record[field] === undefined || record[field] === null || record[field] === "") {
      throw new Error(`Invalid review fixture line ${lineNumber}: missing ${field}`);
    }
  }
  if (record.schema_version !== "1.0") {
    throw new Error(`Invalid review fixture line ${lineNumber}: schema_version must be 1.0`);
  }
  if (typeof record.raw !== "object" || Array.isArray(record.raw)) {
    throw new Error(`Invalid review fixture line ${lineNumber}: raw must be an object`);
  }
  if (Number.isNaN(Date.parse(record.created_at))) {
    throw new Error(`Invalid review fixture line ${lineNumber}: created_at must be ISO-like datetime`);
  }
  return record;
}

async function ensureTopic(adminClient, targetTopic) {
  if (recreateTopic) {
    const topics = await adminClient.listTopics();
    if (topics.includes(targetTopic)) {
      await adminClient.deleteTopics({ topics: [targetTopic], timeout: 5000 });
      await sleep(750);
    }
  }
  await adminClient.createTopics({
    topics: [{ topic: targetTopic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  }).catch((error) => {
    if (!String(error?.message || error).includes("already exists")) throw error;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
