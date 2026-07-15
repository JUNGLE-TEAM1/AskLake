#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const verifier = join(root, 'scripts/verify-eks-runtime-secrets.mjs');
const source = JSON.parse(readFileSync(
  join(root, 'infra/eks/secrets/runtime-secret-contract.example.json'),
  'utf8',
));
const directory = mkdtempSync(join(tmpdir(), 'asklake-runtime-secrets-'));
let count = 0;

const clone = () => structuredClone(source);
const run = (name, contract, args, expectedSuccess) => {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify(contract));
  const result = spawnSync(process.execPath, [verifier, ...args, path], { encoding: 'utf8' });
  const succeeded = result.status === 0;
  if (succeeded !== expectedSuccess) {
    console.error(`${name}: expected ${expectedSuccess ? 'success' : 'failure'}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exitCode = 1;
  }
  count += 1;
};

try {
  run('default-planning', clone(), [], true);
  run('default-ready', clone(), ['--ready'], false);
  run('default-full-service', clone(), ['--full-service-ready'], false);

  const workflow = clone();
  workflow.delivery = {
    mode: 'workflow_sync',
    controllerReady: false,
    controllerOwner: null,
    rotationOwner: 'service-team',
    sourcePrefix: '/asklake/dev/runtime',
  };
  run('workflow-ready', workflow, ['--ready'], true);
  run('workflow-unresolved-full-service', workflow, ['--full-service-ready'], false);

  const workflowFull = structuredClone(workflow);
  workflowFull.runtimeDecisions.airflowApiAuth.status = 'selected';
  workflowFull.runtimeDecisions.airflowApiAuth.selected = 'api_token';
  workflowFull.runtimeDecisions.aiRuntime.status = 'selected';
  workflowFull.runtimeDecisions.aiRuntime.selected = 'direct';
  run('workflow-full-service', workflowFull, ['--full-service-ready'], true);

  const external = clone();
  external.delivery = {
    mode: 'external_secrets',
    controllerReady: true,
    controllerOwner: 'platform-team',
    rotationOwner: 'service-team',
    sourcePrefix: '/asklake/dev/runtime',
  };
  run('external-ready', external, ['--ready'], true);

  for (const [name, mutate] of [
    ['blank-controller-owner', (value) => { value.delivery = { ...external.delivery, controllerOwner: '   ' }; }],
    ['blank-rotation-owner', (value) => { value.delivery = { ...workflow.delivery, rotationOwner: '   ' }; }],
    ['blank-source-prefix', (value) => { value.delivery = { ...workflow.delivery, sourcePrefix: '   ' }; }],
    ['invalid-source-prefix', (value) => { value.delivery = { ...workflow.delivery, sourcePrefix: '/asklake/dev runtime' }; }],
    ['enabled-partial', (value) => { value.delivery.mode = 'external_secrets'; }],
    ['disabled-partial', (value) => { value.delivery.rotationOwner = 'service-team'; }],
    ['secret-key-drift', (value) => { value.secrets.backend.keys.pop(); }],
    ['shared-binding-drift', (value) => { value.sharedBindings[0].bindings.pop(); }],
    ['file-mount-drift', (value) => { value.fileMounts[0].mountPath = '/tmp/ca.pem'; }],
    ['env-binding-drift', (value) => { value.envBindings[0].binding = 'backend:UNKNOWN'; }],
    ['airflow-token-env-drift', (value) => {
      value.envBindings.find((item) => item.binding === 'airflow:AIRFLOW_EXECUTION_API_TOKEN').env = 'AIRFLOW_EXECUTION_API_TOKEN';
    }],
    ['static-aws-key', (value) => { value.secrets.backend.keys.push('AWS_ACCESS_KEY_ID'); }],
    ['secret-value-property', (value) => { value.delivery.value = 'must-not-exist'; }],
  ]) {
    const contract = clone();
    mutate(contract);
    run(name, contract, [], false);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`EKS runtime Secret verifier tests passed (${count} scenarios).`);
