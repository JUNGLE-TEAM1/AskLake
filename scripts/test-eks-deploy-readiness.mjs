#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(root, 'scripts/verify-eks-deploy-readiness.mjs');
const deliverySource = JSON.parse(readFileSync(join(root, 'infra/eks/delivery/dev.handoff.example.json'), 'utf8'));
const secretSource = JSON.parse(readFileSync(join(root, 'infra/eks/secrets/runtime-secret-contract.example.json'), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'asklake-deploy-readiness-'));

const verify = (name, delivery, secrets, expectedSuccess) => {
  const deliveryPath = join(directory, `${name}.handoff.json`);
  const secretPath = join(directory, `${name}.runtime-secret-contract.json`);
  writeFileSync(deliveryPath, JSON.stringify(delivery));
  writeFileSync(secretPath, JSON.stringify(secrets));
  const result = spawnSync(process.execPath, [
    verifier,
    '--delivery', deliveryPath,
    '--runtime-secrets', secretPath,
  ], { encoding: 'utf8' });
  if ((result.status === 0) !== expectedSuccess) {
    console.error(`${name}: expected ${expectedSuccess ? 'success' : 'failure'}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exitCode = 1;
  }
};

try {
  verify('default-planning', structuredClone(deliverySource), structuredClone(secretSource), true);

  const selectedDelivery = structuredClone(deliverySource);
  selectedDelivery.decisions.secretDelivery = { status: 'selected', selected: 'external_secrets' };
  const workflowSecrets = structuredClone(secretSource);
  workflowSecrets.delivery = {
    mode: 'workflow_sync',
    controllerReady: false,
    controllerOwner: null,
    rotationOwner: 'service-team',
    sourcePrefix: '/asklake/dev/runtime',
  };
  verify('delivery-mode-mismatch', selectedDelivery, workflowSecrets, false);

  selectedDelivery.decisions.secretDelivery.selected = 'workflow_sync';
  verify('selected-planning-match', selectedDelivery, workflowSecrets, true);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log('EKS combined deploy readiness tests passed (3 scenarios).');
