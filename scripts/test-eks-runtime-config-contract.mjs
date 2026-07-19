#!/usr/bin/env node

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const verifier = join(root, 'scripts/verify-eks-runtime-config-contract.mjs');
const directory = mkdtempSync(join(tmpdir(), 'asklake-runtime-config-'));
const receiptPath = join(directory, 'receipt.json');
const configPath = join(directory, 'config.json');
const image = `example.invalid/spark@sha256:${'a'.repeat(64)}`;

writeFileSync(receiptPath, JSON.stringify({images: {sparkRuntime: image}}));

function run({mode = '--audit', owner = '', actualOwner = '', managed = false, actualImage = image, aiProvider = 'gateway', gatewayBaseUrl = 'http://ai-gateway:8090'}) {
  writeFileSync(configPath, JSON.stringify({
    metadata: {
      annotations: actualOwner ? {'meta.helm.sh/release-name': actualOwner} : {},
      labels: managed ? {'app.kubernetes.io/managed-by': 'Helm'} : {},
    },
    data: {
      ASKLAKE_SPARK_KUBERNETES_IMAGE: actualImage,
      AI_QUERY_PROVIDER: aiProvider,
      AI_GATEWAY_BASE_URL: gatewayBaseUrl,
    },
  }));
  const result = spawnSync(process.execPath, [verifier, mode, configPath, receiptPath], {
    encoding: 'utf8',
    env: {...process.env, ASKLAKE_RUNTIME_CONFIG_RELEASE: owner},
  });
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return {status: result.status, output, stderr: result.stderr};
}

try {
  let result = run({});
  if (result.status !== 0 || result.output?.status !== 'blocked' || result.output?.selection !== 'unresolved') {
    throw new Error('audit must report an unresolved unowned ConfigMap without failing');
  }
  result = run({mode: '--ready'});
  if (result.status === 0) throw new Error('ready mode accepted an unresolved owner');
  result = run({mode: '--ready', owner: 'asklake-web', actualOwner: 'asklake-web', managed: true});
  if (result.status !== 0 || result.output?.status !== 'ready') throw new Error('approved exact Helm ownership was rejected');
  result = run({mode: '--ready', owner: 'asklake-web', actualOwner: 'asklake-web', managed: true, actualImage: 'stale'});
  if (result.status === 0 || result.output?.image !== 'blocked') throw new Error('stale Spark image was accepted');
  result = run({mode: '--ready', owner: 'asklake-web', actualOwner: 'asklake-web', managed: true, aiProvider: 'direct'});
  if (result.status === 0 || result.output?.aiRuntime !== 'blocked') throw new Error('direct AI runtime was accepted');
  result = run({mode: '--ready', owner: 'asklake-web', actualOwner: 'asklake-foundation', managed: true});
  if (result.status === 0 || result.output?.ownership !== 'blocked') throw new Error('wrong Helm owner was accepted');
  result = run({mode: '--ready', owner: 'arbitrary-owner', actualOwner: 'arbitrary-owner', managed: true});
  if (result.status === 0 || !result.stderr.includes('not an approved')) throw new Error('unapproved owner was accepted');
  console.log('EKS runtime ConfigMap contract tests passed (7 scenarios).');
} finally {
  rmSync(directory, {recursive: true, force: true});
}
