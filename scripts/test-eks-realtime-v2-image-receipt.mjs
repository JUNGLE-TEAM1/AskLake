#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const verifier = join(root, 'scripts/verify-eks-realtime-v2-image-receipt.mjs');
const example = JSON.parse(readFileSync(
  join(root, 'infra/eks/delivery/realtime-v2-image-receipt.example.json'),
  'utf8',
));

const run = (mutate = (receipt) => receipt) => {
  const directory = mkdtempSync(join(tmpdir(), 'asklake-realtime-receipt-'));
  try {
    const receipt = structuredClone(example);
    mutate(receipt);
    const path = join(directory, 'receipt.json');
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
    return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('accepts the exact immutable realtime V2 receipt contract', () => {
  assert.equal(run().status, 0);
});

test('rejects mutable or wrong component repositories', () => {
  const result = run((receipt) => {
    receipt.images.kafkaConnect = 'confluentinc/cp-kafka-connect:latest';
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /immutable ECR digest/);
});

test('rejects plugin checksum drift and extra fields', () => {
  const result = run((receipt) => {
    receipt.artifacts.clickhouseSinkArchiveSha256 = '0'.repeat(64);
    receipt.unreviewed = true;
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unapproved key/);
  assert.match(result.stderr, /checksum/);
});

test('rejects credential-like receipt content', () => {
  const result = run((receipt) => {
    receipt.images.backend = 'aws_secret_access_key=<redacted>';
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-like content/);
});
