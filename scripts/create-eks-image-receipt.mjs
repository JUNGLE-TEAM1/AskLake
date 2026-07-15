#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const values = new Map();
const images = {};

for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!flag?.startsWith('--') || value === undefined) {
    console.error('Arguments must be supplied as --name value pairs.');
    process.exit(1);
  }
  if (flag === '--image') {
    const separator = value.indexOf('=');
    if (separator < 1) {
      console.error('--image must use component=immutable-reference.');
      process.exit(1);
    }
    images[value.slice(0, separator)] = value.slice(separator + 1);
  } else {
    values.set(flag.slice(2), value);
  }
}

const output = values.get('output');
const environment = values.get('environment');
const revision = values.get('revision');
if (!output || !environment || !revision) {
  console.error('--output, --environment and --revision are required.');
  process.exit(1);
}

const receipt = {
  contractVersion: '1.0',
  environment,
  gitRevision: revision,
  platform: 'linux/amd64',
  images,
  upstreamImages: {
    airflow: 'apache/airflow:3.3.0',
    trino: 'trinodb/trino:482',
  },
  createdAt: new Date().toISOString(),
};

writeFileSync(resolve(process.cwd(), output), `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
});
