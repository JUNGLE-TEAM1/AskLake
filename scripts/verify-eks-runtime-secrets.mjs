#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const readyMode = args.includes('--ready');
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

exactKeys(contract, new Set([
  'contractVersion',
  'namespace',
  'delivery',
  'secrets',
  'sharedBindings',
  'fileMounts',
  'forbiddenKeys',
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

const serialized = JSON.stringify(contract);
for (const pattern of [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\w+:\/\/[^\s:/]+:[^\s@/]+@/,
]) {
  if (pattern.test(serialized)) fail(`credential-like content matched ${pattern}`);
}

if (readyMode) {
  if (!['external_secrets', 'workflow_sync'].includes(contract.delivery?.mode)) {
    fail('delivery mode must be selected in --ready mode');
  }
  if (!contract.delivery?.rotationOwner) fail('rotationOwner is required in --ready mode');
  if (!contract.delivery?.sourcePrefix) fail('sourcePrefix is required in --ready mode');
  if (contract.delivery?.mode === 'external_secrets') {
    if (contract.delivery.controllerReady !== true) fail('external_secrets requires a ready controller');
    if (!contract.delivery.controllerOwner) fail('external_secrets requires controllerOwner');
  }
  if (contract.delivery?.mode === 'workflow_sync') {
    if (contract.delivery.controllerReady !== false || contract.delivery.controllerOwner !== null) {
      fail('workflow_sync must not claim an external Secret controller');
    }
  }
} else if (contract.delivery?.mode === 'disabled') {
  if (contract.delivery.controllerReady !== false ||
      contract.delivery.controllerOwner !== null ||
      contract.delivery.rotationOwner !== null ||
      contract.delivery.sourcePrefix !== null) {
    fail('disabled delivery must not carry partial runtime selections');
  }
}

if (errors.length > 0) {
  console.error(`EKS runtime Secret verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`EKS runtime Secret verification passed (${readyMode ? 'ready' : 'planning'} mode).`);
