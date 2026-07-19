#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const contractPath = resolve(process.cwd(), process.argv[2] ?? '');
const errors = [];
const fail = (message) => errors.push(message);

let contract;
try {
  contract = JSON.parse(readFileSync(contractPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read realtime V2 Kafka contract: ${error.message}`);
  process.exit(1);
}

const array = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const statements = array(contract.policyDocuments)
  .flatMap((document) => array(document?.Statement))
  .filter((statement) => statement?.Effect === 'Allow');
const grants = statements.flatMap((statement) =>
  array(statement.Resource).flatMap((resource) =>
    array(statement.Action).map((action) => ({ action, resource })),
  ),
);

if (grants.length === 0) fail('Pod Identity policy has no Allow grants');
for (const { resource } of grants) {
  if (typeof resource !== 'string' || resource.includes('*')) {
    fail('Pod Identity policy resources must be exact ARNs without wildcards');
  }
}

const hasGrant = (action, resourcePattern) => grants.some(({ action: granted, resource }) =>
  granted === action && typeof resource === 'string' && resourcePattern.test(resource),
);
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicArn = (topic) => new RegExp(`:topic/[^/]+/[^/]+/${escaped(topic)}$`);

if (!hasGrant('kafka-cluster:Connect', /:cluster\/[^/]+\/[^/]+$/)) {
  fail('Pod Identity policy is missing kafka-cluster:Connect on an exact cluster ARN');
}
if (!hasGrant('kafka-cluster:WriteDataIdempotently', /:cluster\/[^/]+\/[^/]+$/)) {
  fail('Pod Identity policy is missing kafka-cluster:WriteDataIdempotently on an exact cluster ARN');
}
for (const action of ['kafka-cluster:DescribeGroup', 'kafka-cluster:AlterGroup']) {
  if (!hasGrant(action, /:group\/[^/]+\/[^/]+\/[^/]+$/)) {
    fail(`Pod Identity policy is missing ${action} on an exact group ARN`);
  }
}

const safeTopic = /^[A-Za-z0-9._-]+$/;
const derivedDlq = (topic) => {
  const suffix = '.asklake-v2-dlq';
  if (topic.length + suffix.length <= 249) return `${topic}${suffix}`;
  const digest = createHash('sha256').update(topic, 'utf8').digest('hex').slice(0, 16);
  return `${topic.slice(0, 225).replace(/[.\-_]+$/, '')}-${digest}.dlq`;
};
const requiredTopics = new Map();
const requireTopic = (topic, actions, label) => {
  if (typeof topic !== 'string' || !safeTopic.test(topic)) {
    fail(`${label} is not a safe non-empty Kafka topic`);
    return;
  }
  const existing = requiredTopics.get(topic) ?? new Set();
  for (const action of actions) existing.add(action);
  requiredTopics.set(topic, existing);
};

for (const topic of array(contract.internalTopics)) {
  requireTopic(topic, [
    'kafka-cluster:CreateTopic',
    'kafka-cluster:DescribeTopic',
    'kafka-cluster:ReadData',
    'kafka-cluster:WriteData',
  ], 'Kafka Connect internal topic');
}

for (const topic of array(contract.sourceTopics)) {
  requireTopic(topic, ['kafka-cluster:DescribeTopic', 'kafka-cluster:ReadData'], 'approved source topic');
  if (typeof topic === 'string' && safeTopic.test(topic)) {
    requireTopic(derivedDlq(topic), [
      'kafka-cluster:CreateTopic',
      'kafka-cluster:DescribeTopic',
      'kafka-cluster:WriteData',
    ], 'FastAPI-derived DLQ topic');
  }
}

const sourceOwners = new Map();
for (const connector of array(contract.connectors)) {
  const name = String(connector?.name ?? 'unnamed');
  const config = connector?.config ?? {};
  const source = config.topics;
  const dlq = config['errors.deadletterqueue.topic.name'];
  requireTopic(source, ['kafka-cluster:DescribeTopic', 'kafka-cluster:ReadData'], `${name} source topic`);
  requireTopic(dlq, [
    'kafka-cluster:CreateTopic',
    'kafka-cluster:DescribeTopic',
    'kafka-cluster:WriteData',
  ], `${name} DLQ topic`);
  if (typeof source === 'string') {
    const owners = sourceOwners.get(source) ?? [];
    owners.push(name);
    sourceOwners.set(source, owners);
    const expected = derivedDlq(source);
    if (expected && dlq !== expected) {
      fail(`${name} DLQ does not match the FastAPI derived DLQ contract for its source topic`);
    }
  }

  const taskStates = array(connector?.status?.tasks).map((task) => task?.state);
  if (taskStates.includes('FAILED')) fail(`${name} has a FAILED Kafka Connect task`);
  if (contract.requireRunning === true) {
    if (connector?.status?.connector?.state !== 'RUNNING') fail(`${name} connector is not RUNNING`);
    if (taskStates.length === 0 || taskStates.some((state) => state !== 'RUNNING')) {
      fail(`${name} does not have only RUNNING tasks`);
    }
  }
}

for (const [topic, owners] of sourceOwners) {
  if (owners.length > 1) fail(`source topic has multiple Kafka Connect sink owners: ${topic}`);
}

for (const [topic, actions] of requiredTopics) {
  for (const action of actions) {
    if (!hasGrant(action, topicArn(topic))) {
      fail(`Pod Identity policy is missing ${action} for required exact topic: ${topic}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`EKS realtime V2 Kafka contract verification failed (${errors.length}):`);
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS realtime V2 Kafka connector and exact IAM contract verification passed.');
