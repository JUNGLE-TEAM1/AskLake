#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const receiptPath = resolve(process.cwd(), process.argv[2] ?? '');
const errors = [];
const fail = (message) => errors.push(message);

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read realtime V2 image receipt: ${error.message}`);
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
  'artifacts',
  'createdAt',
]), 'receipt');
exactKeys(receipt.images, new Set(['clickhouse', 'kafkaConnect', 'backend']), 'images');
exactKeys(receipt.artifacts, new Set([
  'clickhouseSinkVersion',
  'clickhouseSinkArchiveSha256',
  'mskIamAuthVersion',
]), 'artifacts');

if (receipt.contractVersion !== '1.0') fail('contractVersion must be 1.0');
if (!['dev', 'staging'].includes(receipt.environment)) fail('environment must be dev or staging');
if (!/^[a-f0-9]{40}$/.test(receipt.gitRevision ?? '')) fail('gitRevision must be a full Git SHA');
if (receipt.platform !== 'linux/amd64') fail('platform must be linux/amd64');
if (Number.isNaN(Date.parse(receipt.createdAt ?? ''))) fail('createdAt must be an ISO-8601 timestamp');

const componentRepositories = {
  clickhouse: 'clickhouse-v2',
  kafkaConnect: 'kafka-connect-v2',
  backend: 'backend',
};
const immutableEcrImage = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)@sha256:([a-f0-9]{64})$/;
let registry;
for (const [key, component] of Object.entries(componentRepositories)) {
  const match = String(receipt.images?.[key] ?? '').match(immutableEcrImage);
  if (!match) {
    fail(`${key} must use an immutable ECR digest`);
    continue;
  }
  const currentRegistry = `${match[1]}.dkr.ecr.${match[2]}.amazonaws.com`;
  if (registry && registry !== currentRegistry) fail('all images must use the same ECR registry and region');
  registry = currentRegistry;
  const expectedSuffix = `asklake/${receipt.environment}/${component}`;
  if (match[3] !== expectedSuffix && !match[3].endsWith(`/${expectedSuffix}`)) {
    fail(`${key} repository must end with ${expectedSuffix}`);
  }
}

if (receipt.artifacts?.clickhouseSinkVersion !== '1.4.0') {
  fail('ClickHouse Sink version must remain pinned to 1.4.0');
}
if (receipt.artifacts?.clickhouseSinkArchiveSha256 !== 'de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c083') {
  fail('ClickHouse Sink archive checksum does not match the reviewed artifact');
}
if (receipt.artifacts?.mskIamAuthVersion !== '2.3.6') {
  fail('MSK IAM auth version must remain pinned to 2.3.6');
}

const serialized = JSON.stringify(receipt);
if (/AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/i.test(serialized)) {
  fail('credential-like content is forbidden in image receipts');
}

if (errors.length > 0) {
  console.error(`EKS realtime V2 image receipt verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS realtime V2 image receipt verification passed.');
