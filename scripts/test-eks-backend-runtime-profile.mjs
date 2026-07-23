#!/usr/bin/env node

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const resolver = join(root, 'scripts/resolve-eks-backend-runtime-profile.mjs');
const template = JSON.parse(readFileSync(join(root, 'infra/eks/secrets/runtime-secret-contract.example.json'), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'asklake-runtime-profile-'));
const contractPath = join(directory, 'contract.json');

function resolve(scope, mutate = () => {}) {
  const contract = structuredClone(template);
  mutate(contract);
  writeFileSync(contractPath, JSON.stringify(contract));
  const result = spawnSync(process.execPath, [resolver, scope, contractPath], {encoding: 'utf8'});
  return {status: result.status, keys: result.stdout.trim() ? JSON.parse(result.stdout) : [], error: result.stderr};
}

try {
  let result = resolve('bounded');
  if (result.status !== 0 || result.keys.length !== 12 || !result.keys.includes('AIRFLOW_PASSWORD')) {
    throw new Error('bounded profile changed unexpectedly');
  }
  result = resolve('full-service', (contract) => {
    contract.runtimeDecisions.aiRuntime = {...contract.runtimeDecisions.aiRuntime, status: 'learning-required', selected: null};
  });
  if (result.status === 0 || !result.error.includes('aiRuntime is unresolved')) {
    throw new Error('unresolved AI runtime opened the full-service profile');
  }
  result = resolve('full-service');
  if (result.status !== 0 || result.keys.length !== 15 || !result.keys.includes('AI_GATEWAY_SERVICE_TOKEN') || result.keys.includes('OPENAI_API_KEY') || result.keys.includes('AIRFLOW_API_TOKEN')) {
    throw new Error('gateway username/password profile is not decision-aware');
  }
  result = resolve('full-service', (contract) => {
    contract.runtimeDecisions.airflowApiAuth = {...contract.runtimeDecisions.airflowApiAuth, selected: 'api_token'};
    contract.runtimeDecisions.aiRuntime = {...contract.runtimeDecisions.aiRuntime, status: 'selected', selected: 'direct'};
  });
  if (result.status !== 0 || !result.keys.includes('AIRFLOW_API_TOKEN') || result.keys.includes('AIRFLOW_PASSWORD')) {
    throw new Error('Airflow API token profile retained the password-only Backend key');
  }
  result = resolve('full-service', (contract) => {
    contract.runtimeDecisions.aiRuntime = {...contract.runtimeDecisions.aiRuntime, status: 'selected', selected: 'gateway'};
    contract.runtimeDecisions.aiProviderWorkload = {...contract.runtimeDecisions.aiProviderWorkload, status: 'learning-required', selected: null};
  });
  if (result.status === 0 || !result.error.includes('provider workload')) {
    throw new Error('gateway profile opened without provider workload approval');
  }
  result = resolve('full-service', (contract) => {
    contract.runtimeDecisions.aiRuntime = {...contract.runtimeDecisions.aiRuntime, status: 'selected', selected: 'gateway'};
    contract.runtimeDecisions.aiProviderWorkload = {...contract.runtimeDecisions.aiProviderWorkload, status: 'selected', selected: 'contract-approved'};
  });
  if (result.status !== 0 || result.keys.length !== 15 || !result.keys.includes('AI_MCP_SERVICE_TOKEN') || result.keys.includes('OPENAI_API_KEY')) {
    throw new Error('approved gateway profile did not resolve its exact keys');
  }
  result = resolve('full-service', (contract) => {
    contract.runtimeDecisions.aiRuntime = {...contract.runtimeDecisions.aiRuntime, status: 'selected', selected: 'direct'};
    contract.runtimeProfiles.backend.fullServiceKeys.aiRuntime.direct.push('UNDECLARED_KEY');
  });
  if (result.status === 0 || !result.error.includes('undeclared')) throw new Error('undeclared profile key was accepted');
  console.log('EKS Backend runtime profile tests passed (7 scenarios).');
} finally {
  rmSync(directory, {recursive: true, force: true});
}
