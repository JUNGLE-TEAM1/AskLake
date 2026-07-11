import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = path.resolve(scriptDir, "../fixtures/kafka/amazon-review-fixture.jsonl");

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}
const dryRun = options.dryRun;
const broker = options.broker || process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const topic = options.topic || process.env.ASKLAKE_REVIEW_KAFKA_TOPIC || "reviews.raw";
const inputPath = path.resolve(
  process.cwd(),
  options.input || process.env.ASKLAKE_REVIEW_FIXTURE_PATH || defaultFixturePath,
);
const sourceName = options.source || process.env.ASKLAKE_REVIEW_SOURCE || "amazon-review-dataset";
const eventPrefix = options.eventPrefix || process.env.ASKLAKE_REVIEW_EVENT_PREFIX || "amazon-review";
const recreateTopic = options.recreateTopic ?? process.env.ASKLAKE_RECREATE_REVIEW_TOPIC === "true";
const limit = positiveInteger(options.limit ?? process.env.ASKLAKE_REVIEW_REPLAY_LIMIT, "limit");
const rate = positiveInteger(options.rate ?? process.env.ASKLAKE_REVIEW_REPLAY_RATE, "rate");
const batchSize = positiveInteger(options.batchSize ?? process.env.ASKLAKE_REVIEW_REPLAY_BATCH_SIZE, "batch-size") || 100;
const progressEvery = positiveInteger(options.progressEvery ?? process.env.ASKLAKE_REVIEW_REPLAY_PROGRESS_EVERY, "progress-every") || 1000;
const loop = options.loop ?? process.env.ASKLAKE_REVIEW_REPLAY_LOOP === "true";
const maxCycles = positiveInteger(options.maxCycles ?? process.env.ASKLAKE_REVIEW_REPLAY_MAX_CYCLES, "max-cycles");
const maxMessages = positiveInteger(options.maxMessages ?? process.env.ASKLAKE_REVIEW_REPLAY_MAX_MESSAGES, "max-messages");
const cycleDelayMs = nonnegativeInteger(options.cycleDelayMs ?? process.env.ASKLAKE_REVIEW_REPLAY_CYCLE_DELAY_MS, "cycle-delay-ms") || 0;
let stopRequested = false;

if (maxCycles && !loop) {
  throw new Error("--max-cycles requires --loop");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopRequested = true;
    console.log(`Review Kafka replay stop requested (${signal}). Finishing the current send batch.`);
  });
}

if (!existsSync(inputPath)) {
  throw new Error(`Review replay input does not exist: ${inputPath}`);
}

if (dryRun) {
  const stats = await inspectInput();
  console.log(`Review Kafka replay input valid: ${stats.validRecords} messages from ${inputPath}`);
  console.log(`Target topic: ${topic}`);
  console.log(`Broker: ${broker}`);
  console.log(`Limit: ${limit || "all"}`);
  console.log(`Rate: ${rate || "unlimited"} messages/sec`);
  console.log(`Loop: ${loop ? "enabled" : "disabled"}`);
  console.log(`Max cycles: ${maxCycles || "unlimited"}`);
  console.log(`Max messages: ${maxMessages || "unlimited"}`);
  console.log(`Topic recreation: ${recreateTopic ? "enabled" : "disabled"}`);
  process.exit(0);
}

const { Kafka, Partitioners } = await import("kafkajs");
const kafka = new Kafka({
  brokers: [broker],
  clientId: "asklake-review-replay-producer",
  retry: { retries: 2 },
});
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });

try {
  await admin.connect();
  await ensureTopic(admin, topic);
  await producer.connect();
  const stats = await produceRecords(producer);
  console.log(`Review Kafka replay finished: ${stats.sentRecords} messages across ${stats.completedCycles} cycle(s) to ${topic} at ${broker}${stats.stopped ? " (stopped by signal)" : ""}`);
} finally {
  await producer.disconnect().catch(() => {});
  await admin.disconnect().catch(() => {});
}

async function inspectInput() {
  let validRecords = 0;
  for await (const _record of readStandardReviewRecords()) {
    validRecords += 1;
  }
  if (validRecords === 0) throw new Error(`Review replay input produced no messages: ${inputPath}`);
  return { validRecords };
}

async function produceRecords(producerClient) {
  let sentRecords = 0;
  let lastProgressAt = 0;
  let completedCycles = 0;

  while (!stopRequested && (loop || completedCycles === 0) && (!maxCycles || completedCycles < maxCycles) && (!maxMessages || sentRecords < maxMessages)) {
    const cycle = completedCycles + 1;
    let batch = [];
    let recordsInCycle = 0;

    for await (const baseRecord of readStandardReviewRecords()) {
      if (stopRequested || (maxMessages && sentRecords + batch.length >= maxMessages)) break;
      const record = decorateReplayRecord(baseRecord, cycle, sentRecords + batch.length + 1);
      batch.push({ key: record.event_id, value: JSON.stringify(record) });
      recordsInCycle += 1;
      if (batch.length >= batchSize) {
        sentRecords += await sendBatch(producerClient, batch);
        lastProgressAt = logProgress(sentRecords, lastProgressAt, false, cycle);
        batch = [];
      }
    }

    if (batch.length > 0) {
      sentRecords += await sendBatch(producerClient, batch);
      lastProgressAt = logProgress(sentRecords, lastProgressAt, true, cycle);
    }
    if (recordsInCycle === 0 && sentRecords === 0) throw new Error(`Review replay input produced no messages: ${inputPath}`);
    completedCycles += 1;
    console.log(`Review Kafka replay cycle ${cycle} complete: ${recordsInCycle.toLocaleString()} messages sent`);

    if (stopRequested || !loop || (maxCycles && completedCycles >= maxCycles) || (maxMessages && sentRecords >= maxMessages)) break;
    if (cycleDelayMs > 0) await sleep(cycleDelayMs);
  }

  return { sentRecords, completedCycles, stopped: stopRequested };
}

async function sendBatch(producerClient, messages) {
  const startedAt = Date.now();
  await producerClient.send({ topic, messages });
  if (rate) {
    const targetMs = Math.ceil((messages.length / rate) * 1000);
    const elapsedMs = Date.now() - startedAt;
    if (targetMs > elapsedMs) await sleep(targetMs - elapsedMs);
  }
  return messages.length;
}

function logProgress(sentRecords, lastProgressAt, force = false, cycle = 1) {
  if (!force && sentRecords - lastProgressAt < progressEvery) return lastProgressAt;
  console.log(`Review Kafka replay progress: ${sentRecords.toLocaleString()} messages sent (cycle ${cycle})`);
  return sentRecords;
}

function decorateReplayRecord(record, cycle, streamOffset) {
  if (!loop) return record;
  return {
    ...record,
    event_id: `${record.event_id}--cycle-${String(cycle).padStart(6, "0")}`,
    offset: streamOffset,
  };
}

async function* readStandardReviewRecords() {
  let offset = 0;
  let emitted = 0;
  for await (const line of readJsonLines(inputPath)) {
    offset += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rawRecord = parseJsonLine(trimmed, offset);
    const record = toStandardReviewRecord(rawRecord, offset);
    validateRecord(record, offset);
    yield record;
    emitted += 1;
    if (limit && emitted >= limit) return;
  }
}

async function* readJsonLines(targetPath) {
  const input = createReadStream(targetPath);
  const source = targetPath.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const reader = createInterface({ input: source, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      yield line;
    }
  } finally {
    reader.close();
    source.destroy?.();
    input.destroy?.();
  }
}

function parseJsonLine(line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON on review replay line ${lineNumber}: ${error.message}`);
  }
}

function toStandardReviewRecord(rawRecord, lineNumber) {
  const review = firstPresent(rawRecord.review, rawRecord.reviewText, rawRecord.text, rawRecord.content, rawRecord.body);
  const rawPayload = objectOrNull(rawRecord.raw) || rawRecord;

  return {
    schema_version: "1.0",
    event_id: firstPresent(rawRecord.event_id, rawRecord.eventId) || `${eventPrefix}-${String(lineNumber).padStart(6, "0")}`,
    source: firstPresent(rawRecord.source) || sourceName,
    offset: Number.isFinite(Number(rawRecord.offset)) ? Number(rawRecord.offset) : lineNumber,
    review,
    created_at: normalizeCreatedAt(rawRecord, lineNumber),
    raw: rawPayload,
  };
}

function validateRecord(record, lineNumber) {
  const required = ["schema_version", "event_id", "source", "offset", "review", "created_at", "raw"];
  for (const field of required) {
    if (record[field] === undefined || record[field] === null || record[field] === "") {
      throw new Error(`Invalid review replay line ${lineNumber}: missing ${field}`);
    }
  }
  if (record.schema_version !== "1.0") {
    throw new Error(`Invalid review replay line ${lineNumber}: schema_version must be 1.0`);
  }
  if (!Number.isInteger(record.offset) || record.offset < 1) {
    throw new Error(`Invalid review replay line ${lineNumber}: offset must be a positive integer`);
  }
  if (typeof record.raw !== "object" || Array.isArray(record.raw)) {
    throw new Error(`Invalid review replay line ${lineNumber}: raw must be an object`);
  }
  if (Number.isNaN(Date.parse(record.created_at))) {
    throw new Error(`Invalid review replay line ${lineNumber}: created_at must be ISO-like datetime`);
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

function normalizeCreatedAt(rawRecord, lineNumber) {
  const explicit = firstPresent(rawRecord.created_at, rawRecord.createdAt, rawRecord.review_created_at);
  if (explicit && !Number.isNaN(Date.parse(explicit))) return new Date(explicit).toISOString();

  const unixReviewTime = Number(rawRecord.unixReviewTime ?? rawRecord.unix_review_time);
  if (Number.isFinite(unixReviewTime) && unixReviewTime > 0) {
    return new Date(unixReviewTime * 1000).toISOString();
  }

  const reviewTime = firstPresent(rawRecord.reviewTime, rawRecord.review_time);
  const parsedReviewTime = parseAmazonReviewTime(reviewTime);
  if (parsedReviewTime) return parsedReviewTime;

  const fallbackBase = Date.UTC(2026, 6, 9, 0, 0, 0, 0);
  return new Date(fallbackBase + (lineNumber - 1) * 60_000).toISOString();
}

function parseAmazonReviewTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const [, month, day, year] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)).toISOString();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--dry-run" || arg === "--loop" || arg === "--no-recreate-topic" || arg === "--recreate-topic") {
      if (arg === "--dry-run") parsed.dryRun = true;
      if (arg === "--loop") parsed.loop = true;
      if (arg === "--no-recreate-topic") parsed.recreateTopic = false;
      if (arg === "--recreate-topic") parsed.recreateTopic = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    const rawKey = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const key = camelCase(rawKey);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    parsed[key] = value;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function positiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return number;
}

function nonnegativeInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${label} must be a non-negative integer`);
  }
  return number;
}

function printUsage() {
  console.log(`Usage: node scripts/seed-kafka-review-fixture.mjs [options]

  --input <path>             JSONL or JSONL.gz review input
  --topic <topic>            Kafka topic (default: reviews.raw)
  --broker <host:port>       Kafka broker (default: 127.0.0.1:19092)
  --limit <count>            Maximum records per replay cycle
  --rate <count>             Messages per second limit
  --batch-size <count>       Kafka send batch size (default: 100)
  --loop                     Replay input continuously
  --max-cycles <count>       Stop after this many cycles (requires --loop)
  --max-messages <count>     Stop after this many total messages
  --cycle-delay-ms <ms>      Wait between loop cycles
  --recreate-topic           Delete and recreate the topic before sending
  --no-recreate-topic        Keep the current topic (default)
  --dry-run                  Validate input and print the resolved settings
  --help, -h                 Print this help

Loop mode appends a cycle suffix to event_id and emits a globally increasing logical offset.`);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
