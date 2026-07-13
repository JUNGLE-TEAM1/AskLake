import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KAFKA_RUNTIME_IDS,
  KafkaRuntimeError,
  assertKafkaTopicPolicy,
  assertKafkaTopicRecreationAllowed,
  kafkaClientOptions,
  normalizeKafkaError,
  resolveKafkaRuntimeConfig,
  serializeKafkaError,
  validateKafkaTopic,
} from "../src/kafkaRuntime.mjs";
import { runKafkaRoundtripProbe } from "../src/kafkaRoundtripProbe.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(backendDir, "..");

const local = resolveKafkaRuntimeConfig({ env: {} });
assert.equal(local.runtime, KAFKA_RUNTIME_IDS.REDPANDA);
assert.deepEqual(local.brokers, ["127.0.0.1:19092"]);
assert.equal(local.tls, false);
assert.equal(local.topicPolicy.enforced, false);
assert.equal(validateKafkaTopic("_local.internal", local), "_local.internal");
const localOptions = await kafkaClientOptions({ clientId: "asklake-local-test", config: local });
assert.equal(localOptions.ssl, undefined);
assert.equal(localOptions.sasl, undefined);

assert.throws(
  () => resolveKafkaRuntimeConfig({ env: { ASKLAKE_KAFKA_RUNTIME: "msk" } }),
  (error) => error instanceof KafkaRuntimeError && error.code === "KAFKA_RUNTIME_CONFIGURATION_INVALID",
);

const mskEnv = {
  ASKLAKE_KAFKA_ENVIRONMENT: "staging",
  ASKLAKE_KAFKA_RUNTIME: "msk",
  ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS: "3",
  ASKLAKE_KAFKA_TOPIC_RETENTION_MS: "604800000",
  ASKLAKE_MSK_AUTH_MODE: "iam",
  ASKLAKE_MSK_BOOTSTRAP_BROKERS: "broker-1.example:9098,broker-2.example:9098",
  ASKLAKE_MSK_ENABLED: "true",
  ASKLAKE_MSK_REGION: "ap-northeast-2",
  ASKLAKE_MSK_TLS_ENABLED: "true",
};
const msk = resolveKafkaRuntimeConfig({ env: mskEnv });
assert.equal(msk.runtime, KAFKA_RUNTIME_IDS.MSK);
assert.deepEqual(msk.brokers, ["broker-1.example:9098", "broker-2.example:9098"]);
assert.equal(msk.topicPrefix, "asklake.staging");
assert.equal(msk.topicPolicy.enforced, true);

let tokenRegion = "";
const mskOptions = await kafkaClientOptions({
  clientId: "asklake-msk-contract",
  config: msk,
  tokenGenerator: async ({ region }) => {
    tokenRegion = region;
    return { token: "short-lived-test-token" };
  },
});
assert.equal(mskOptions.ssl, true);
assert.equal(mskOptions.logLevel, 0);
assert.equal(mskOptions.sasl.mechanism, "oauthbearer");
assert.deepEqual(await mskOptions.sasl.oauthBearerProvider(), { value: "short-lived-test-token" });
assert.equal(tokenRegion, "ap-northeast-2");
assert.equal(JSON.stringify(mskOptions).includes("short-lived-test-token"), false);

for (const env of [
  { ...mskEnv, ASKLAKE_MSK_AUTH_MODE: "scram" },
  { ...mskEnv, ASKLAKE_MSK_TLS_ENABLED: "false" },
  { ...mskEnv, ASKLAKE_MSK_BOOTSTRAP_BROKERS: "https://broker.example:9098" },
]) {
  assert.throws(
    () => resolveKafkaRuntimeConfig({ env }),
    (error) => error.code === "KAFKA_RUNTIME_CONFIGURATION_INVALID",
  );
}

assert.equal(validateKafkaTopic("asklake.staging.probe", msk), "asklake.staging.probe");
assert.throws(
  () => validateKafkaTopic("reviews.raw", msk),
  (error) => error.code === "KAFKA_TOPIC_NAMESPACE_INVALID" && error.status === 422,
);
assert.throws(
  () => assertKafkaTopicRecreationAllowed(msk, true),
  (error) => error.code === "KAFKA_TOPIC_RECREATION_FORBIDDEN",
);

const metadata = topicMetadata("asklake.staging.probe", 3);
const configEntries = [{ configName: "retention.ms", configValue: "604800000" }];
assert.deepEqual(
  assertKafkaTopicPolicy({ config: msk, configEntries, metadata, topic: "asklake.staging.probe" }),
  {
    mismatches: [],
    partitions: 3,
    retentionMs: 604800000,
    topic: "asklake.staging.probe",
  },
);
assert.throws(
  () => assertKafkaTopicPolicy({
    config: msk,
    configEntries: [{ configName: "retention.ms", configValue: "3600000" }],
    metadata: topicMetadata("asklake.staging.probe", 1),
    topic: "asklake.staging.probe",
  }),
  (error) => error.code === "KAFKA_TOPIC_POLICY_MISMATCH"
    && error.details.mismatches.map((item) => item.field).join(",") === "partitions,retention.ms",
);

const successFake = fakeKafkaClient({ configEntries, metadata });
const clock = [1000, 1125];
const success = await runKafkaRoundtripProbe({
  client: successFake.client,
  config: msk,
  kafkaJs: { ConfigResourceTypes: { TOPIC: 2 } },
  makeCorrelationId: () => "00000000-0000-4000-8000-000000000001",
  now: () => clock.shift(),
  timeoutMs: 100,
  topic: "asklake.staging.probe",
});
assert.equal(success.status, "success");
assert.equal(success.latencyMs, 125);
assert.equal(success.partition, 1);
assert.equal(success.offset, "42");
assert.equal(success.createdTopic, false);
assert.equal(successFake.calls.createTopics, 0);
assert.equal(successFake.calls.createPartitions, 0);
assert.equal(successFake.calls.deleteTopics, 0);
assert.equal(successFake.calls.disconnects, 3);

const createFake = fakeKafkaClient({ configEntries, metadata, topics: [] });
const createClock = [2000, 2001];
const created = await runKafkaRoundtripProbe({
  client: createFake.client,
  config: msk,
  createTopic: true,
  kafkaJs: { ConfigResourceTypes: { TOPIC: 2 } },
  makeCorrelationId: () => "00000000-0000-4000-8000-000000000002",
  now: () => createClock.shift(),
  timeoutMs: 100,
  topic: "asklake.staging.probe",
});
assert.equal(created.createdTopic, true);
assert.equal(createFake.calls.createTopics, 1);
assert.deepEqual(createFake.calls.createdSpec, {
  configEntries: [{ name: "retention.ms", value: "604800000" }],
  numPartitions: 3,
  topic: "asklake.staging.probe",
});
assert.equal(createFake.calls.createPartitions, 0);
assert.equal(createFake.calls.deleteTopics, 0);

const timeoutFake = fakeKafkaClient({ configEntries, deliver: false, metadata });
await assert.rejects(
  runKafkaRoundtripProbe({
    client: timeoutFake.client,
    config: msk,
    kafkaJs: { ConfigResourceTypes: { TOPIC: 2 } },
    makeCorrelationId: () => "00000000-0000-4000-8000-000000000003",
    timeoutMs: 10,
    topic: "asklake.staging.probe",
  }),
  (error) => error.code === "KAFKA_ROUNDTRIP_TIMEOUT" && error.status === 504,
);

const secretError = new Error("SASL Access denied at broker-1.example:9098 using credential-secret-example");
const safeError = serializeKafkaError(secretError, { runtime: "msk", stage: "producer" });
assert.equal(safeError.code, "KAFKA_AUTHENTICATION_FAILED");
assert.equal(JSON.stringify(safeError).includes("broker-1.example"), false);
assert.equal(JSON.stringify(safeError).includes("credential-secret-example"), false);
assert.equal(
  normalizeKafkaError(new Error("UNKNOWN_TOPIC_OR_PARTITION"), { runtime: "msk" }).code,
  "KAFKA_TOPIC_NOT_FOUND",
);
assert.equal(
  normalizeKafkaError(new Error("connect ETIMEDOUT broker-2.example:9098"), { runtime: "msk" }).code,
  "KAFKA_CONNECTION_TIMEOUT",
);

const backendEnv = readFileSync(path.join(backendDir, ".env.example"), "utf8");
const deployEnv = readFileSync(path.join(repoDir, "deploy/.env.example"), "utf8");
const deployCompose = readFileSync(path.join(repoDir, "deploy/docker-compose.prod.yml"), "utf8");
for (const key of [
  "ASKLAKE_KAFKA_RUNTIME",
  "ASKLAKE_KAFKA_ENVIRONMENT",
  "ASKLAKE_MSK_ENABLED",
  "ASKLAKE_MSK_BOOTSTRAP_BROKERS",
  "ASKLAKE_MSK_REGION",
  "ASKLAKE_MSK_AUTH_MODE",
  "ASKLAKE_MSK_TLS_ENABLED",
  "ASKLAKE_KAFKA_TOPIC_PREFIX",
  "ASKLAKE_KAFKA_TOPIC_POLICY_ENFORCED",
  "ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS",
  "ASKLAKE_KAFKA_TOPIC_RETENTION_MS",
  "ASKLAKE_MSK_PROBE_TIMEOUT_MS",
]) {
  assert.match(backendEnv, new RegExp(`^${key}=`, "m"), `backend env is missing ${key}`);
  assert.match(deployEnv, new RegExp(`^${key}=`, "m"), `deploy env is missing ${key}`);
  assert.match(deployCompose, new RegExp(`^\\s+${key}:`, "m"), `deploy compose is missing ${key}`);
}
const packageJson = JSON.parse(readFileSync(path.join(backendDir, "package.json"), "utf8"));
assert.ok(packageJson.dependencies["aws-msk-iam-sasl-signer-js"]);
assert.equal(packageJson.scripts["kafka:msk-probe"], "node scripts/msk-roundtrip-probe.mjs");
assert.equal(packageJson.scripts["verify:msk-connection-contract"], "node scripts/verify-msk-connection-contract.mjs");
for (const relativePath of [
  "src/connectors.mjs",
  "scripts/ingest-kafka-reviews.mjs",
  "scripts/seed-kafka-review-fixture.mjs",
]) {
  const source = readFileSync(path.join(backendDir, relativePath), "utf8");
  assert.match(source, /createKafkaClient/, `${relativePath} must use the common Kafka Runtime client factory`);
  assert.doesNotMatch(source, /new Kafka\s*\(/, `${relativePath} must not create an unconfigured KafkaJS client`);
}

console.log("MSK connection contract verification passed.");

function topicMetadata(topic, partitions) {
  return {
    topics: [{
      name: topic,
      partitions: Array.from({ length: partitions }, (_, partitionId) => ({ partitionId })),
    }],
  };
}

function fakeKafkaClient({ configEntries: entries, deliver = true, metadata: topicMeta, topics = ["asklake.staging.probe"] }) {
  const calls = {
    createPartitions: 0,
    createTopics: 0,
    createdSpec: null,
    deleteTopics: 0,
    disconnects: 0,
  };
  let eachMessage;
  const admin = {
    async connect() {},
    async createPartitions() { calls.createPartitions += 1; },
    async createTopics({ topics: requested }) {
      calls.createTopics += 1;
      calls.createdSpec = requested[0];
      return true;
    },
    async deleteTopics() { calls.deleteTopics += 1; },
    async describeConfigs() { return { resources: [{ configEntries: entries }] }; },
    async disconnect() { calls.disconnects += 1; },
    async fetchTopicMetadata() { return topicMeta; },
    async listTopics() { return topics; },
  };
  const consumer = {
    async connect() {},
    async disconnect() { calls.disconnects += 1; },
    async run({ eachMessage: handler }) { eachMessage = handler; },
    async stop() {},
    async subscribe() {},
  };
  const producer = {
    async connect() {},
    async disconnect() { calls.disconnects += 1; },
    async send({ messages }) {
      if (!deliver) return;
      await eachMessage({
        message: { offset: "42", value: Buffer.from(messages[0].value) },
        partition: 1,
      });
    },
  };
  return {
    calls,
    client: {
      admin: () => admin,
      consumer: () => consumer,
      producer: () => producer,
    },
  };
}
