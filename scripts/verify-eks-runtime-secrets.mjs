#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const readyMode = args.includes('--ready');
const fullServiceReadyMode = args.includes('--full-service-ready');
const contractArg = args.find((arg) => !arg.startsWith('--'));
const contractPath = resolve(
  process.cwd(),
  contractArg ?? 'infra/eks/secrets/runtime-secret-contract.example.json',
);

const errors = [];
const fail = (message) => errors.push(message);
const exactKeys = (value, expected, label) => {
  const actual = new Set(Object.keys(value ?? {}));
  for (const key of expected) {
    if (!actual.has(key)) fail(`${label} is missing ${key}`);
  }
  for (const key of actual) {
    if (!expected.has(key)) fail(`${label} contains unapproved key ${key}`);
  }
};
const exactStringSet = (value, expected, label) => {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
    return;
  }
  const actual = new Set(value);
  if (actual.size !== value.length) fail(`${label} must not contain duplicates`);
  for (const item of expected) {
    if (!actual.has(item)) fail(`${label} is missing ${item}`);
  }
  for (const item of actual) {
    if (!expected.has(item)) fail(`${label} contains unapproved item ${item}`);
  }
};

let contract;
try {
  contract = JSON.parse(readFileSync(contractPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read runtime Secret contract: ${error.message}`);
  process.exit(1);
}

const expectedSecrets = {
  backend: {
    name: 'asklake-backend-runtime',
    consumers: new Set(['backend']),
    keys: new Set([
      'DATABASE_URL',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'AI_GATEWAY_SERVICE_TOKEN',
      'AI_MCP_SERVICE_TOKEN',
      'AI_CONTEXT_SIGNING_SECRET',
      'OPENAI_API_KEY',
      'AIRFLOW_API_TOKEN',
      'AIRFLOW_PASSWORD',
      'AIRFLOW_EXECUTION_API_TOKEN',
      'AIRFLOW_INTERNAL_TOKEN',
      'TRINO_AUTH_USERNAME',
      'TRINO_AUTH_PASSWORD',
      'TRINO_MATERIALIZER_USERNAME',
      'TRINO_MATERIALIZER_PASSWORD',
      'TRINO_RESULT_CURSOR_SECRET',
      'TRINO_QUERY_CONFIRMATION_SECRET',
      'trino-ca.pem',
    ]),
  },
  airflow: {
    name: 'asklake-airflow-runtime',
    consumers: new Set([
      'airflow-api-server',
      'airflow-scheduler',
      'airflow-dag-processor',
      'airflow-db-migration',
    ]),
    keys: new Set([
      'AIRFLOW__DATABASE__SQL_ALCHEMY_CONN',
      'AIRFLOW_PASSWORD',
      'AIRFLOW_EXECUTION_API_TOKEN',
      'AIRFLOW_INTERNAL_TOKEN',
      'AIRFLOW__CORE__FERNET_KEY',
      'AIRFLOW__API_AUTH__JWT_SECRET',
    ]),
  },
  spark: {
    name: 'asklake-spark-runtime',
    consumers: new Set(['spark-driver', 'spark-executor']),
    keys: new Set([
      'ASKLAKE_SPARK_ICEBERG_JDBC_URL',
      'ASKLAKE_SPARK_ICEBERG_JDBC_USER',
      'ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD',
    ]),
  },
  trino: {
    name: 'asklake-trino-runtime',
    consumers: new Set(['trino-coordinator']),
    keys: new Set([
      'TRINO_ICEBERG_JDBC_URL',
      'TRINO_ICEBERG_JDBC_USER',
      'TRINO_ICEBERG_JDBC_PASSWORD',
      'TRINO_TLS_KEYSTORE_PASSWORD',
      'TRINO_INTERNAL_SHARED_SECRET',
      'trino-keystore.jks',
      'trino-password.db',
    ]),
  },
};

const expectedSharedBindings = {
  'airflow-api-password': new Set([
    'backend:AIRFLOW_PASSWORD',
    'airflow:AIRFLOW_PASSWORD',
  ]),
  'airflow-execution-api-token': new Set([
    'backend:AIRFLOW_EXECUTION_API_TOKEN',
    'airflow:AIRFLOW_EXECUTION_API_TOKEN',
  ]),
  'airflow-internal-token': new Set([
    'backend:AIRFLOW_INTERNAL_TOKEN',
    'airflow:AIRFLOW_INTERNAL_TOKEN',
  ]),
  'iceberg-jdbc-url': new Set([
    'spark:ASKLAKE_SPARK_ICEBERG_JDBC_URL',
    'trino:TRINO_ICEBERG_JDBC_URL',
  ]),
  'iceberg-jdbc-user': new Set([
    'spark:ASKLAKE_SPARK_ICEBERG_JDBC_USER',
    'trino:TRINO_ICEBERG_JDBC_USER',
  ]),
  'iceberg-jdbc-password': new Set([
    'spark:ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD',
    'trino:TRINO_ICEBERG_JDBC_PASSWORD',
  ]),
};

const expectedMounts = {
  'backend:trino-ca.pem': '/var/run/asklake/secrets/trino-ca.pem',
  'trino:trino-keystore.jks': '/etc/trino/tls/keystore.jks',
  'trino:trino-password.db': '/etc/trino/auth/password.db',
};

const expectedForbiddenKeys = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
]);
const expectedRuntimeDecisions = {
  airflowApiAuth: new Set(['api_token', 'username_password']),
  aiRuntime: new Set(['gateway', 'direct']),
  aiProviderWorkload: new Set(['contract-approved']),
};

exactKeys(contract, new Set([
  'contractVersion',
  'namespace',
  'delivery',
  'secrets',
  'sharedBindings',
  'envBindings',
  'fileMounts',
  'runtimeProfiles',
  'forbiddenKeys',
  'runtimeDecisions',
]), 'contract');
if (contract.contractVersion !== '1.0') fail('contractVersion must be 1.0');
if (contract.namespace !== 'asklake-dev') fail('namespace must be asklake-dev');

exactKeys(contract.delivery, new Set([
  'mode',
  'controllerReady',
  'controllerOwner',
  'rotationOwner',
  'sourcePrefix',
]), 'delivery');
const allowedModes = new Set(['disabled', 'external_secrets', 'workflow_sync']);
if (!allowedModes.has(contract.delivery?.mode)) fail('delivery mode is not approved');

const normalizedOwner = (value) => typeof value === 'string' ? value.trim() : '';
const validSourcePrefix = /^[a-zA-Z0-9/_+=.@-]+$/;
const mode = contract.delivery?.mode;
const controllerOwner = normalizedOwner(contract.delivery?.controllerOwner);
const rotationOwner = normalizedOwner(contract.delivery?.rotationOwner);
const sourcePrefix = normalizedOwner(contract.delivery?.sourcePrefix);
let readyForSync = false;
if (mode === 'disabled') {
  if (contract.delivery?.controllerReady !== false ||
      contract.delivery?.controllerOwner !== null ||
      contract.delivery?.rotationOwner !== null ||
      contract.delivery?.sourcePrefix !== null) {
    fail('disabled delivery must not carry partial runtime selections');
  }
} else if (allowedModes.has(mode)) {
  if (!rotationOwner) fail('enabled delivery requires a non-blank rotationOwner');
  if (!sourcePrefix) fail('enabled delivery requires a non-blank sourcePrefix');
  if (sourcePrefix && !validSourcePrefix.test(sourcePrefix)) fail('sourcePrefix contains unapproved characters');
  if (mode === 'external_secrets') {
    if (contract.delivery?.controllerReady !== true) fail('external_secrets requires a ready controller');
    if (!controllerOwner) fail('external_secrets requires a non-blank controllerOwner');
  }
  if (mode === 'workflow_sync' &&
      (contract.delivery?.controllerReady !== false || contract.delivery?.controllerOwner !== null)) {
    fail('workflow_sync must not claim an external Secret controller');
  }
  readyForSync = errors.length === 0;
}

exactKeys(contract.secrets, new Set(Object.keys(expectedSecrets)), 'secrets');
const knownBindings = new Set();
for (const [workload, expected] of Object.entries(expectedSecrets)) {
  const actual = contract.secrets?.[workload];
  exactKeys(actual, new Set(['name', 'consumers', 'keys']), `secrets.${workload}`);
  if (actual?.name !== expected.name) fail(`${workload} Secret name must be ${expected.name}`);
  exactStringSet(actual?.consumers, expected.consumers, `${workload} consumers`);
  exactStringSet(actual?.keys, expected.keys, `${workload} keys`);
  for (const key of actual?.keys ?? []) knownBindings.add(`${workload}:${key}`);
}

if (!Array.isArray(contract.sharedBindings)) fail('sharedBindings must be an array');
const actualSharedNames = new Set();
for (const binding of contract.sharedBindings ?? []) {
  exactKeys(binding, new Set(['logicalName', 'bindings']), 'shared binding');
  const expected = expectedSharedBindings[binding.logicalName];
  if (!expected) {
    fail(`unapproved shared binding ${binding.logicalName}`);
    continue;
  }
  if (actualSharedNames.has(binding.logicalName)) fail(`duplicate shared binding ${binding.logicalName}`);
  actualSharedNames.add(binding.logicalName);
  exactStringSet(binding.bindings, expected, `${binding.logicalName} bindings`);
  for (const reference of binding.bindings ?? []) {
    if (!knownBindings.has(reference)) fail(`shared binding references unknown key ${reference}`);
  }
}
exactStringSet([...actualSharedNames], new Set(Object.keys(expectedSharedBindings)), 'shared binding names');

if (!Array.isArray(contract.fileMounts)) fail('fileMounts must be an array');
const actualMountBindings = new Set();
for (const mount of contract.fileMounts ?? []) {
  exactKeys(mount, new Set(['binding', 'mountPath', 'readOnly']), 'file mount');
  if (!(mount.binding in expectedMounts)) fail(`unapproved file mount ${mount.binding}`);
  if (actualMountBindings.has(mount.binding)) fail(`duplicate file mount ${mount.binding}`);
  actualMountBindings.add(mount.binding);
  if (!knownBindings.has(mount.binding)) fail(`file mount references unknown key ${mount.binding}`);
  if (mount.mountPath !== expectedMounts[mount.binding]) fail(`${mount.binding} has an invalid mountPath`);
  if (mount.readOnly !== true) fail(`${mount.binding} must be read-only`);
}
exactStringSet([...actualMountBindings], new Set(Object.keys(expectedMounts)), 'file mount bindings');

exactKeys(contract.runtimeProfiles, new Set(['backend']), 'runtimeProfiles');
exactKeys(contract.runtimeProfiles?.backend, new Set(['active', 'boundedKeys']), 'runtimeProfiles.backend');
if (!['bounded', 'full-service'].includes(contract.runtimeProfiles?.backend?.active)) {
  fail('Backend active runtime profile must be bounded or full-service');
}
const expectedBoundedBackendKeys = new Set([
  'DATABASE_URL',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'AIRFLOW_PASSWORD',
  'AIRFLOW_EXECUTION_API_TOKEN',
  'AIRFLOW_INTERNAL_TOKEN',
  'TRINO_AUTH_USERNAME',
  'TRINO_AUTH_PASSWORD',
  'TRINO_MATERIALIZER_USERNAME',
  'TRINO_MATERIALIZER_PASSWORD',
  'TRINO_RESULT_CURSOR_SECRET',
  'TRINO_QUERY_CONFIRMATION_SECRET',
  'trino-ca.pem',
]);
exactStringSet(
  contract.runtimeProfiles?.backend?.boundedKeys,
  expectedBoundedBackendKeys,
  'Backend bounded profile keys',
);
for (const key of contract.runtimeProfiles?.backend?.boundedKeys ?? []) {
  if (!expectedSecrets.backend.keys.has(key)) {
    fail(`Backend bounded profile references a key outside the full-service contract: ${key}`);
  }
}

if (!Array.isArray(contract.envBindings)) fail('envBindings must be an array');
const envBoundSecretKeys = new Set();
const consumerEnvPairs = new Set();
for (const envBinding of contract.envBindings ?? []) {
  exactKeys(envBinding, new Set(['binding', 'consumers', 'env']), 'env binding');
  if (!knownBindings.has(envBinding.binding)) fail(`env binding references unknown key ${envBinding.binding}`);
  if (!Array.isArray(envBinding.consumers) || envBinding.consumers.length === 0) {
    fail(`${envBinding.binding} env binding requires consumers`);
    continue;
  }
  if (typeof envBinding.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(envBinding.env)) {
    fail(`${envBinding.binding} has an invalid environment variable name`);
  }
  const [workload] = String(envBinding.binding).split(':', 1);
  const allowedConsumers = new Set(contract.secrets?.[workload]?.consumers ?? []);
  const uniqueConsumers = new Set(envBinding.consumers);
  if (uniqueConsumers.size !== envBinding.consumers.length) fail(`${envBinding.binding} has duplicate consumers`);
  for (const consumer of uniqueConsumers) {
    if (!allowedConsumers.has(consumer)) fail(`${envBinding.binding} references unapproved consumer ${consumer}`);
    const pair = `${consumer}:${envBinding.env}`;
    if (consumerEnvPairs.has(pair)) fail(`duplicate environment injection ${pair}`);
    consumerEnvPairs.add(pair);
  }
  envBoundSecretKeys.add(envBinding.binding);
}
for (const binding of knownBindings) {
  if (!actualMountBindings.has(binding) && !envBoundSecretKeys.has(binding)) {
    fail(`Secret key has no env or file injection: ${binding}`);
  }
}
const airflowExecutionBinding = (contract.envBindings ?? []).find(
  (item) => item.binding === 'airflow:AIRFLOW_EXECUTION_API_TOKEN',
);
if (airflowExecutionBinding?.env !== 'ASKLAKE_EXECUTION_API_TOKEN') {
  fail('Airflow execution token must inject as ASKLAKE_EXECUTION_API_TOKEN');
}

exactStringSet(contract.forbiddenKeys, expectedForbiddenKeys, 'forbiddenKeys');
for (const secret of Object.values(contract.secrets ?? {})) {
  for (const key of secret.keys ?? []) {
    if (expectedForbiddenKeys.has(key)) fail(`forbidden static credential key is consumed: ${key}`);
  }
}

const forbiddenPropertyNames = new Set(['data', 'stringData', 'value', 'secretValue']);
const visit = (value, path = 'contract') => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenPropertyNames.has(key)) fail(`${path} contains forbidden value property ${key}`);
    visit(child, `${path}.${key}`);
  }
};
visit(contract);

exactKeys(contract.runtimeDecisions, new Set(Object.keys(expectedRuntimeDecisions)), 'runtimeDecisions');
for (const [name, allowed] of Object.entries(expectedRuntimeDecisions)) {
  const decision = contract.runtimeDecisions?.[name];
  exactKeys(decision, new Set(['status', 'selected', 'allowed']), `runtimeDecisions.${name}`);
  exactStringSet(decision?.allowed, allowed, `${name} allowed choices`);
  if (!['learning-required', 'selected'].includes(decision?.status)) fail(`${name} has an invalid status`);
  if (decision?.status === 'selected') {
    if (!allowed.has(decision.selected)) fail(`${name} has an unapproved selection`);
  } else if (decision?.selected !== null) {
    fail(`${name} must have selected=null until selected`);
  }
}

const airflowDecision = contract.runtimeDecisions?.airflowApiAuth;
const aiDecision = contract.runtimeDecisions?.aiRuntime;
const aiProviderDecision = contract.runtimeDecisions?.aiProviderWorkload;
const airflowContractReady = airflowDecision?.status === 'selected';
const aiContractReady = aiDecision?.status === 'selected' && (
  aiDecision.selected === 'direct' ||
  (aiDecision.selected === 'gateway' && aiProviderDecision?.status === 'selected')
);
const fullServiceSecretContractReady = readyForSync && airflowContractReady && aiContractReady;
if (contract.runtimeProfiles?.backend?.active === 'full-service' && !fullServiceSecretContractReady) {
  fail('Backend full-service profile cannot be active while full-service decisions are unresolved');
}

const serialized = JSON.stringify(contract);
for (const pattern of [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\w+:\/\/[^\s:/]+:[^\s@/]+@/,
]) {
  if (pattern.test(serialized)) fail(`credential-like content matched ${pattern}`);
}

if ((readyMode || fullServiceReadyMode) && !readyForSync) fail('runtime Secret contract is not ready for sync');
if (fullServiceReadyMode && !fullServiceSecretContractReady) {
  fail('runtime Secret contract is not ready for the full service');
}

if (errors.length > 0) {
  console.error(`EKS runtime Secret verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const verificationMode = fullServiceReadyMode ? 'full-service-ready' : readyMode ? 'ready' : 'planning';
console.log(`EKS runtime Secret verification passed (${verificationMode} mode).`);
