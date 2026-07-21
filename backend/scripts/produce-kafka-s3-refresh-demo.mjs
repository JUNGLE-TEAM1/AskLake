import { randomUUID } from "node:crypto";

import { Kafka, Partitioners } from "kafkajs";

import {
  createDemoEvent,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_RATE,
  DEMO_TOPIC,
  parsePositiveInteger,
} from "./kafka-s3-refresh-demo-contract.mjs";

const options = parseArgs(process.argv.slice(2));
const broker = options.broker || process.env.ASKLAKE_DEMO_KAFKA_BROKER || "127.0.0.1:19092";
const topic = options.topic || process.env.ASKLAKE_DEMO_KAFKA_TOPIC || DEMO_TOPIC;
const rate = parsePositiveInteger(options.rate || process.env.ASKLAKE_DEMO_RATE || DEFAULT_RATE, "rate");
const durationSeconds = parsePositiveInteger(
  options.durationSeconds || process.env.ASKLAKE_DEMO_DURATION_SECONDS || DEFAULT_DURATION_SECONDS,
  "duration-seconds",
);
const runId = options.runId || `demo-${randomUUID().slice(0, 8)}`;
const totalMessages = rate * durationSeconds;
let stopRequested = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopRequested = true;
    console.log(`Stop requested (${signal}); the current 1-second batch will finish.`);
  });
}

if (options.dryRun) {
  console.log(JSON.stringify({ broker, topic, rate, durationSeconds, totalMessages, runId }, null, 2));
  process.exit(0);
}

const kafka = new Kafka({ brokers: [broker], clientId: "asklake-kafka-s3-demo-producer" });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });

try {
  await admin.connect();
  const topics = await admin.listTopics();
  if (!topics.includes(topic)) {
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  }
  await producer.connect();

  console.log(`Kafka demo started: ${rate} messages/sec for ${durationSeconds} sec (${totalMessages.toLocaleString()} total)`);
  console.log(`Topic: ${topic}`);
  console.log(`Run ID: ${runId}`);

  const startedAt = Date.now();
  let sent = 0;
  for (let second = 0; second < durationSeconds && !stopRequested; second += 1) {
    const tickAt = startedAt + second * 1000;
    await waitUntil(tickAt);
    const now = new Date();
    const messages = Array.from({ length: rate }, (_, index) => {
      const sequence = sent + index + 1;
      const event = createDemoEvent({ runId, sequence, now });
      return { key: event.product_id, value: JSON.stringify(event) };
    });
    await producer.send({ topic, messages });
    sent += messages.length;

    if ((second + 1) % 60 === 0 || second === 0 || second + 1 === durationSeconds) {
      console.log(`Progress: ${sent.toLocaleString()} / ${totalMessages.toLocaleString()} messages`);
    }
    await waitUntil(startedAt + (second + 1) * 1000);
  }

  console.log(`Kafka demo finished: ${sent.toLocaleString()} messages sent to ${topic}${stopRequested ? " (stopped early)" : ""}`);
} finally {
  await producer.disconnect().catch(() => {});
  await admin.disconnect().catch(() => {});
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--broker") parsed.broker = requiredValue(args, ++index, arg);
    else if (arg === "--topic") parsed.topic = requiredValue(args, ++index, arg);
    else if (arg === "--rate") parsed.rate = requiredValue(args, ++index, arg);
    else if (arg === "--duration-seconds") parsed.durationSeconds = requiredValue(args, ++index, arg);
    else if (arg === "--run-id") parsed.runId = requiredValue(args, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(args, index, flag) {
  if (!args[index]) throw new Error(`${flag} requires a value`);
  return args[index];
}

async function waitUntil(targetMs) {
  const remainingMs = targetMs - Date.now();
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
}
