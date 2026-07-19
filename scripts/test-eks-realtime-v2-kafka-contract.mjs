#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const verifier = resolve(import.meta.dirname, 'verify-eks-realtime-v2-kafka-contract.mjs');
const cluster = 'arn:aws:kafka:region:111122223333:cluster/dev/uuid';
const topic = (name) => `arn:aws:kafka:region:111122223333:topic/dev/uuid/${name}`;
const group = (name) => `arn:aws:kafka:region:111122223333:group/dev/uuid/${name}`;

const fixture = () => {
  const source = 'fixture.events';
  const dlq = `${source}.asklake-v2-dlq`;
  const internalTopics = ['connect-config', 'connect-offset', 'connect-status'];
  return {
    requireRunning: false,
    internalTopics,
    sourceTopics: [source],
    connectors: [{
      name: 'fixture-connector',
      config: { topics: source, 'errors.deadletterqueue.topic.name': dlq },
      status: { connector: { state: 'PAUSED' }, tasks: [] },
    }],
    policyDocuments: [{
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['kafka-cluster:Connect', 'kafka-cluster:WriteDataIdempotently'], Resource: cluster },
        { Effect: 'Allow', Action: ['kafka-cluster:CreateTopic', 'kafka-cluster:DescribeTopic', 'kafka-cluster:ReadData', 'kafka-cluster:WriteData'], Resource: [...internalTopics, source, dlq].map(topic) },
        { Effect: 'Allow', Action: ['kafka-cluster:DescribeGroup', 'kafka-cluster:AlterGroup'], Resource: group('connect-worker') },
      ],
    }],
  };
};

const run = (mutate = (value) => value) => {
  const directory = mkdtempSync(join(tmpdir(), 'asklake-realtime-kafka-contract-'));
  try {
    const value = fixture();
    mutate(value);
    const path = join(directory, 'contract.json');
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('accepts a canonical FastAPI DLQ and exact IAM contract', () => {
  assert.equal(run().status, 0);
});

test('rejects a missing derived DLQ IAM grant', () => {
  const result = run((value) => {
    value.policyDocuments[0].Statement[1].Resource = value.policyDocuments[0].Statement[1].Resource
      .filter((resource) => !resource.endsWith('.asklake-v2-dlq'));
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required exact topic/);
});

test('rejects duplicate source ownership and a legacy DLQ name', () => {
  const result = run((value) => {
    const duplicate = structuredClone(value.connectors[0]);
    duplicate.name = 'legacy-duplicate';
    duplicate.config['errors.deadletterqueue.topic.name'] = 'legacy.dlq';
    value.connectors.push(duplicate);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple Kafka Connect sink owners/);
  assert.match(result.stderr, /derived DLQ contract/);
});

test('rejects FAILED tasks and requires running E2E tasks when requested', () => {
  const failed = run((value) => {
    value.connectors[0].status.tasks = [{ id: 0, state: 'FAILED' }];
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FAILED/);

  const notRunning = run((value) => {
    value.requireRunning = true;
  });
  assert.equal(notRunning.status, 1);
  assert.match(notRunning.stderr, /not RUNNING|only RUNNING/);
});

test('rejects wildcard IAM resources', () => {
  const result = run((value) => {
    value.policyDocuments[0].Statement[1].Resource[0] = `${topic('connect')}*`;
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without wildcards/);
});
