#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = args.find((arg) => ['--audit', '--ready'].includes(arg)) ?? '--audit';
const runtimeArg = args.find((arg) => arg.startsWith('--ai-runtime='));
const expectedAiRuntime = runtimeArg?.split('=')[1] ?? 'gateway';
const paths = args.filter((arg) => !arg.startsWith('--'));
const [configPath, receiptPath] = paths;
const selectedOwner = String(process.env.ASKLAKE_RUNTIME_CONFIG_RELEASE || '').trim();
const allowedOwners = new Set(['asklake-web', 'asklake-foundation', 'asklake-runtime-config']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!configPath || !receiptPath || !['gateway', 'direct-rollback'].includes(expectedAiRuntime)) {
  fail('usage: verify-eks-runtime-config-contract.mjs --audit|--ready [--ai-runtime=gateway|direct-rollback] <configmap.json> <receipt.json>');
}
if (selectedOwner && !allowedOwners.has(selectedOwner)) {
  fail('ASKLAKE_RUNTIME_CONFIG_RELEASE is not an approved runtime ConfigMap owner');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const annotations = config.metadata?.annotations ?? {};
const labels = config.metadata?.labels ?? {};
const actualOwner = String(annotations['meta.helm.sh/release-name'] || '').trim();
const managedByHelm = labels['app.kubernetes.io/managed-by'] === 'Helm';
const expectedImage = String(receipt.images?.sparkRuntime || '');
const actualImage = String(config.data?.ASKLAKE_SPARK_KUBERNETES_IMAGE || '');
const selection = selectedOwner ? 'selected' : 'unresolved';
const ownershipReady = Boolean(selectedOwner) && managedByHelm && actualOwner === selectedOwner;
const imageReady = Boolean(expectedImage) && actualImage === expectedImage;
const aiRuntimeReady = expectedAiRuntime === 'gateway'
  ? config.data?.AI_QUERY_PROVIDER === 'gateway' && config.data?.AI_GATEWAY_BASE_URL === 'http://ai-gateway:8090'
  : config.data?.AI_QUERY_PROVIDER === 'direct' && !String(config.data?.AI_GATEWAY_BASE_URL ?? '').trim();
const keyCount = Object.keys(config.data ?? {}).length;
const status = ownershipReady && imageReady && aiRuntimeReady && keyCount > 0 ? 'ready' : 'blocked';

console.log(JSON.stringify({
  status,
  selection,
  ownership: ownershipReady ? 'ready' : 'blocked',
  image: imageReady ? 'ready' : 'blocked',
  aiRuntime: aiRuntimeReady ? 'ready' : 'blocked',
  expectedAiRuntime,
  keyCount,
}));

if (mode === '--ready' && status !== 'ready') process.exit(1);
