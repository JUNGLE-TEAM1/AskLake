import assert from "node:assert/strict";
import test from "node:test";

import { resolveContinuousWorkerBroker } from "./manage-kafka-continuous.mjs";

test("Docker worker translates a host-loopback Kafka broker", () => {
  assert.equal(
    resolveContinuousWorkerBroker("127.0.0.1:19092", { ASKLAKE_KAFKA_BROKER_IN_DOCKER: "redpanda:9092" }),
    "redpanda:9092",
  );
  assert.equal(
    resolveContinuousWorkerBroker("localhost:19092", { ASKLAKE_KAFKA_BROKER_IN_DOCKER: "redpanda:9092" }),
    "redpanda:9092",
  );
});

test("external Kafka brokers are never replaced", () => {
  assert.equal(
    resolveContinuousWorkerBroker("kafka.example.com:9092", { ASKLAKE_KAFKA_BROKER_IN_DOCKER: "redpanda:9092" }),
    "kafka.example.com:9092",
  );
});
