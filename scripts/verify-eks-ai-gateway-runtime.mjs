#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const [backendExternalSecretPath, gatewayExternalSecretPath, backendSecretPath, gatewaySecretPath, configMapPath] = process.argv.slice(2);
const expectedOwner = String(process.env.ASKLAKE_RUNTIME_CONFIG_RELEASE || 'asklake-runtime-config').trim();
const approvedOwners = new Set(['asklake-runtime-config', 'asklake-web']);

function fail(message) {
  console.error(`AI Gateway runtime preflight failed: ${message}`);
  process.exit(1);
}

if (![backendExternalSecretPath, gatewayExternalSecretPath, backendSecretPath, gatewaySecretPath, configMapPath].every(Boolean)) {
  fail('usage: verify-eks-ai-gateway-runtime.mjs <backend-es.json> <gateway-es.json> <backend-secret.json> <gateway-secret.json> <configmap.json>');
}
if (!approvedOwners.has(expectedOwner)) fail('runtime ConfigMap owner is not approved');

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const backendExternalSecret = read(backendExternalSecretPath);
const gatewayExternalSecret = read(gatewayExternalSecretPath);
const backendSecret = read(backendSecretPath);
const gatewaySecret = read(gatewaySecretPath);
const configMap = read(configMapPath);

const profiles = [
  {
    name: 'asklake-backend-runtime',
    externalSecret: backendExternalSecret,
    secret: backendSecret,
    keys: [
      'AI_CONTEXT_SIGNING_SECRET', 'AI_GATEWAY_SERVICE_TOKEN', 'AI_MCP_SERVICE_TOKEN',
      'AIRFLOW_EXECUTION_API_TOKEN', 'AIRFLOW_INTERNAL_TOKEN', 'AIRFLOW_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD', 'DATABASE_URL', 'TRINO_AUTH_PASSWORD',
      'TRINO_AUTH_USERNAME', 'TRINO_MATERIALIZER_PASSWORD', 'TRINO_MATERIALIZER_USERNAME',
      'TRINO_QUERY_CONFIRMATION_SECRET', 'TRINO_RESULT_CURSOR_SECRET', 'trino-ca.pem',
    ],
  },
  {
    name: 'asklake-ai-gateway-runtime',
    externalSecret: gatewayExternalSecret,
    secret: gatewaySecret,
    keys: ['AI_GATEWAY_SERVICE_TOKEN', 'AI_MCP_SERVICE_TOKEN', 'AI_PROVIDER_API_KEY'],
  },
];

const sorted = (value) => [...value].sort();
for (const profile of profiles) {
  const ready = profile.externalSecret.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
  if (!ready) fail(`${profile.name} ExternalSecret is not Ready`);
  if (profile.externalSecret.spec?.target?.name !== profile.name || profile.externalSecret.spec?.target?.creationPolicy !== 'Owner') {
    fail(`${profile.name} ExternalSecret does not own the canonical target`);
  }
  const declaredKeys = sorted((profile.externalSecret.spec?.data ?? []).map((item) => item.secretKey));
  if (JSON.stringify(declaredKeys) !== JSON.stringify(sorted(profile.keys))) fail(`${profile.name} ExternalSecret key set differs from the contract`);
  const actualKeys = sorted(Object.keys(profile.secret.data ?? {}));
  if (JSON.stringify(actualKeys) !== JSON.stringify(sorted(profile.keys))) fail(`${profile.name} Secret key set differs from the contract`);
  const owner = profile.secret.metadata?.ownerReferences?.find((reference) => reference.controller === true);
  if (owner?.kind !== 'ExternalSecret' || owner?.name !== profile.name) fail(`${profile.name} Secret is not controller-owned by its ExternalSecret`);
  if (profile.keys.some((key) => !String(profile.secret.data?.[key] ?? '').trim())) fail(`${profile.name} Secret contains an empty value`);
}

for (const key of ['AI_GATEWAY_SERVICE_TOKEN', 'AI_MCP_SERVICE_TOKEN']) {
  if (backendSecret.data[key] !== gatewaySecret.data[key]) fail(`${key} bindings do not match`);
}
if ('AI_PROVIDER_API_KEY' in backendSecret.data) fail('provider credentials must not enter the Backend Secret');

const annotations = configMap.metadata?.annotations ?? {};
const labels = configMap.metadata?.labels ?? {};
if (annotations['meta.helm.sh/release-name'] !== expectedOwner || labels['app.kubernetes.io/managed-by'] !== 'Helm') {
  fail('runtime ConfigMap does not have the selected Helm owner');
}
if (configMap.data?.AI_QUERY_PROVIDER !== 'gateway' || configMap.data?.AI_GATEWAY_BASE_URL !== 'http://ai-gateway:8090') {
  fail('runtime ConfigMap is not configured for the private AI Gateway');
}

console.log('AI Gateway runtime preflight passed (ExternalSecret ownership, exact key sets, shared token bindings, Helm config).');
