#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const readyMode = args.includes('--ready');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return resolve(process.cwd(), index >= 0 ? args[index + 1] : fallback);
};
const deliveryPath = option('--delivery', 'infra/eks/delivery/dev.handoff.example.json');
const runtimeSecretPath = option('--runtime-secrets', 'infra/eks/secrets/runtime-secret-contract.example.json');

const runVerifier = (script, verifierArgs) => {
  const result = spawnSync(process.execPath, [resolve(scriptDirectory, script), ...verifierArgs], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
};

runVerifier('verify-eks-delivery-handoff.mjs', [...(readyMode ? ['--ready'] : []), deliveryPath]);
runVerifier('verify-eks-runtime-secrets.mjs', [
  ...(readyMode ? ['--full-service-ready'] : []),
  runtimeSecretPath,
]);

const delivery = JSON.parse(readFileSync(deliveryPath, 'utf8'));
const runtimeSecrets = JSON.parse(readFileSync(runtimeSecretPath, 'utf8'));
const decision = delivery.decisions?.secretDelivery;
const mode = runtimeSecrets.delivery?.mode;
const errors = [];

if (decision?.status === 'selected') {
  if (decision.selected !== mode) {
    errors.push(`Phase 5 secretDelivery=${decision.selected} does not match Phase 8 mode=${mode}`);
  }
} else if (mode !== 'disabled') {
  errors.push('Phase 8 delivery must remain disabled until Phase 5 secretDelivery is selected');
}

if (readyMode && decision?.status !== 'selected') {
  errors.push('Phase 5 secretDelivery must be selected before deploy readiness');
}

if (errors.length > 0) {
  console.error(`EKS combined deploy readiness verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`EKS combined deploy readiness verification passed (${readyMode ? 'ready' : 'planning'} mode).`);
