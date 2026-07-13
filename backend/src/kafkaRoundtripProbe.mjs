import { randomUUID } from "node:crypto";
import {
  KafkaRuntimeError,
  assertKafkaTopicPolicy,
  kafkaTopicCreationSpec,
  normalizeKafkaError,
  validateKafkaTopic,
} from "./kafkaRuntime.mjs";

export async function runKafkaRoundtripProbe({
  client,
  config,
  createTopic = false,
  kafkaJs,
  makeCorrelationId = randomUUID,
  now = () => Date.now(),
  timeoutMs = 15000,
  topic,
} = {}) {
  if (!client || !config || !kafkaJs) {
    throw new KafkaRuntimeError(
      "KAFKA_PROBE_CONFIGURATION_INVALID",
      "Kafka roundtrip probe requires a client, Runtime config, and KafkaJS module.",
      { runtime: config?.runtime, stage: "probe", status: 500 },
    );
  }
  const validatedTopic = validateKafkaTopic(topic, config);
  const boundedTimeoutMs = positiveInteger(timeoutMs, "timeoutMs");
  const correlationId = String(makeCorrelationId());
  const consumerGroupId = `${config.topicPrefix || `asklake.${config.environment}`}.probe.${correlationId}`;
  const admin = client.admin();
  const consumer = client.consumer({ groupId: consumerGroupId });
  const producer = client.producer();
  let adminConnected = false;
  let consumerConnected = false;
  let consumerRunning = false;
  let producerConnected = false;
  let createdTopic = false;
  let receiveTimeout;

  try {
    await admin.connect();
    adminConnected = true;
    if (createTopic) {
      const topics = await admin.listTopics();
      if (!topics.includes(validatedTopic)) {
        createdTopic = await admin.createTopics({
          topics: [kafkaTopicCreationSpec(validatedTopic, config)],
          waitForLeaders: true,
        });
      }
    }

    const metadata = await admin.fetchTopicMetadata({ topics: [validatedTopic] });
    const described = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [{
        configNames: ["retention.ms"],
        name: validatedTopic,
        type: kafkaJs.ConfigResourceTypes?.TOPIC ?? 2,
      }],
    });
    const policy = assertKafkaTopicPolicy({
      config,
      configEntries: described?.resources?.[0]?.configEntries || [],
      metadata,
      topic: validatedTopic,
    });

    let finishReceive;
    let failReceive;
    const receivePromise = new Promise((resolve, reject) => {
      finishReceive = resolve;
      failReceive = reject;
    });
    receivePromise.catch(() => undefined);
    await consumer.connect();
    consumerConnected = true;
    await consumer.subscribe({ fromBeginning: false, topic: validatedTopic });
    await consumer.run({
      autoCommit: true,
      eachMessage: async ({ message, partition }) => {
        const payload = parseProbePayload(message?.value);
        if (payload?.correlationId !== correlationId) return;
        finishReceive({
          consumedAtMs: now(),
          offset: String(message.offset),
          partition,
          payload,
        });
      },
    });
    consumerRunning = true;
    await producer.connect();
    producerConnected = true;
    receiveTimeout = setTimeout(() => {
      failReceive(new KafkaRuntimeError(
        "KAFKA_ROUNDTRIP_TIMEOUT",
        "Kafka roundtrip message was not received within the bounded timeout.",
        { runtime: config.runtime, stage: "bounded-consumer", status: 504 },
      ));
    }, boundedTimeoutMs);
    const producedAtMs = now();
    const payload = {
      correlationId,
      environment: config.environment,
      kind: "asklake.kafka.roundtrip",
      producedAt: new Date(producedAtMs).toISOString(),
      version: 1,
    };
    await producer.send({
      acks: -1,
      messages: [{ key: correlationId, value: JSON.stringify(payload) }],
      topic: validatedTopic,
    });
    const received = await receivePromise;

    return {
      correlationId,
      createdTopic: Boolean(createdTopic),
      environment: config.environment,
      latencyMs: Math.max(0, received.consumedAtMs - producedAtMs),
      offset: received.offset,
      partition: received.partition,
      partitions: policy.partitions,
      policyMismatches: policy.mismatches,
      retentionMs: policy.retentionMs,
      runtime: config.runtime,
      status: "success",
      topic: validatedTopic,
    };
  } catch (error) {
    throw normalizeKafkaError(error, { runtime: config.runtime, stage: error?.stage || "roundtrip-probe" });
  } finally {
    if (receiveTimeout) clearTimeout(receiveTimeout);
    if (consumerRunning) await consumer.stop().catch(() => undefined);
    if (consumerConnected) await consumer.disconnect().catch(() => undefined);
    if (producerConnected) await producer.disconnect().catch(() => undefined);
    if (adminConnected) await admin.disconnect().catch(() => undefined);
  }
}

function parseProbePayload(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new KafkaRuntimeError(
      "KAFKA_PROBE_CONFIGURATION_INVALID",
      `${label} must be a positive integer.`,
      { stage: "probe", status: 400 },
    );
  }
  return parsed;
}
