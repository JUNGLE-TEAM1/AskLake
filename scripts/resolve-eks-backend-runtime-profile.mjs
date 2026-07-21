#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const [scope, contractPath] = process.argv.slice(2);
if (!['bounded', 'full-service'].includes(scope) || !contractPath) {
  console.error('usage: resolve-eks-backend-runtime-profile.mjs bounded|full-service <runtime-contract.json>');
  process.exit(2);
}

const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const backend = contract.runtimeProfiles?.backend;
const declared = new Set(contract.secrets?.backend?.keys ?? []);

function exactSelection(name) {
  const decision = contract.runtimeDecisions?.[name];
  if (decision?.status !== 'selected' || typeof decision.selected !== 'string' || !decision.selected) {
    throw new Error(`${name} is unresolved`);
  }
  return decision.selected;
}

function ensureDeclared(keys) {
  const unique = [...new Set(keys)].sort();
  if (unique.some((key) => !declared.has(key))) throw new Error('runtime profile references an undeclared Backend key');
  return unique;
}

try {
  if (scope === 'bounded') {
    console.log(JSON.stringify(ensureDeclared(backend?.boundedKeys ?? [])));
    process.exit(0);
  }
  const matrix = backend?.fullServiceKeys;
  const airflow = exactSelection('airflowApiAuth');
  const ai = exactSelection('aiRuntime');
  const airflowKeys = matrix?.airflowApiAuth?.[airflow];
  const aiKeys = matrix?.aiRuntime?.[ai];
  if (!Array.isArray(matrix?.common) || !Array.isArray(airflowKeys) || !Array.isArray(aiKeys)) {
    throw new Error('selected full-service profile has no approved key mapping');
  }
  if (ai === 'gateway' && contract.runtimeDecisions?.aiProviderWorkload?.status !== 'selected') {
    throw new Error('gateway provider workload contract is unresolved');
  }
  console.log(JSON.stringify(ensureDeclared([...matrix.common, ...airflowKeys, ...aiKeys])));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'runtime profile resolution failed');
  process.exit(1);
}
