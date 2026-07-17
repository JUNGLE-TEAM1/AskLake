#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const receiptPath = resolve(
  process.cwd(),
  process.argv[2] ?? 'infra/eks/delivery/image-receipt.example.json',
);
const errors = [];
const fail = (message) => errors.push(message);

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read image receipt: ${error.message}`);
  process.exit(1);
}

const exactKeys = (value, expected, label) => {
  const actual = new Set(Object.keys(value ?? {}));
  for (const key of expected) if (!actual.has(key)) fail(`${label} is missing ${key}`);
  for (const key of actual) if (!expected.has(key)) fail(`${label} contains unapproved key ${key}`);
};

exactKeys(receipt, new Set([
  'contractVersion',
  'environment',
  'gitRevision',
  'platform',
  'images',
  'upstreamImages',
  'createdAt',
]), 'receipt');

if (receipt.contractVersion !== '1.0') fail('contractVersion must be 1.0');
if (!['dev', 'staging'].includes(receipt.environment)) fail('environment must be dev or staging');
if (!/^[a-f0-9]{40}$/.test(receipt.gitRevision ?? '')) fail('gitRevision must be a full Git SHA');
if (receipt.platform !== 'linux/amd64') fail('platform must be linux/amd64');
if (Number.isNaN(Date.parse(receipt.createdAt ?? ''))) fail('createdAt must be an ISO-8601 timestamp');

const components = {
  frontend: 'frontend',
  backend: 'backend',
  airflow: 'airflow',
  sparkRuntime: 'spark-runtime',
  trino: 'trino',
};
exactKeys(receipt.images, new Set(Object.keys(components)), 'images');

const immutableEcrImage = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)@sha256:([a-f0-9]{64})$/;
let registry;
for (const [key, component] of Object.entries(components)) {
  const image = receipt.images?.[key] ?? '';
  const match = image.match(immutableEcrImage);
  if (!match) {
    fail(`${key} must use an immutable ECR digest`);
    continue;
  }
  const currentRegistry = `${match[1]}.dkr.ecr.${match[2]}.amazonaws.com`;
  if (registry && registry !== currentRegistry) fail('all images must use the same ECR registry and region');
  registry = currentRegistry;
  const repository = match[3];
  if (!repository.endsWith(`/asklake/${receipt.environment}/${component}`) &&
      repository !== `asklake/${receipt.environment}/${component}`) {
    fail(`${key} repository must end with asklake/${receipt.environment}/${component}`);
  }
}

exactKeys(receipt.upstreamImages, new Set(['airflow', 'trino']), 'upstreamImages');
if (receipt.upstreamImages?.airflow !== 'apache/airflow:3.3.0') fail('Airflow upstream image must remain pinned to 3.3.0');
if (receipt.upstreamImages?.trino !== 'trinodb/trino:482') fail('Trino upstream image must remain pinned to 482');

const serialized = JSON.stringify(receipt);
if (/AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/i.test(serialized)) {
  fail('credential-like content is forbidden in image receipts');
}

if (errors.length > 0) {
  console.error(`EKS image receipt verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS image receipt verification passed.');
