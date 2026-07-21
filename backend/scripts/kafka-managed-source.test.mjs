import assert from "node:assert/strict";
import test from "node:test";

import { kafkaSecurityOptions, validateManagedKafkaSourceBoundary } from "../src/kafka-codecs.mjs";

const iamEnvironment = {
  ASKLAKE_KAFKA_ALLOWED_TOPIC_PREFIXES: "asklake.",
  ASKLAKE_KAFKA_AUTH_MODE: "iam",
  ASKLAKE_KAFKA_BROKER: "boot.example.amazonaws.com:9098",
  AWS_REGION: "ap-northeast-2",
};

test("MSK IAM options use TLS and OAUTHBEARER", async () => {
  const options = await kafkaSecurityOptions(iamEnvironment);
  assert.equal(options.ssl, true);
  assert.equal(options.sasl.mechanism, "oauthbearer");
  assert.equal(typeof options.sasl.oauthBearerProvider, "function");
});

test("managed Kafka boundary accepts only the deployment broker and topic namespace", () => {
  assert.doesNotThrow(() => validateManagedKafkaSourceBoundary({
    broker: "boot.example.amazonaws.com:9098",
    topic: "asklake.events",
  }, iamEnvironment));
  assert.throws(() => validateManagedKafkaSourceBoundary({
    broker: "other.example.amazonaws.com:9098",
    topic: "asklake.events",
  }, iamEnvironment), { code: "KAFKA_BROKER_OUTSIDE_MANAGED_BOUNDARY" });
  assert.throws(() => validateManagedKafkaSourceBoundary({
    broker: "boot.example.amazonaws.com:9098",
    topic: "foreign.events",
  }, iamEnvironment), { code: "KAFKA_TOPIC_OUTSIDE_MANAGED_BOUNDARY" });
});
