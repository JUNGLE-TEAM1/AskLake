#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const verifier = join(root, 'scripts/verify-eks-ai-gateway-runtime.mjs');
const directory = mkdtempSync(join(tmpdir(), 'asklake-ai-gateway-runtime-'));
const backendKeys = [
  'AI_CONTEXT_SIGNING_SECRET', 'AI_GATEWAY_SERVICE_TOKEN', 'AI_MCP_SERVICE_TOKEN',
  'AIRFLOW_EXECUTION_API_TOKEN', 'AIRFLOW_INTERNAL_TOKEN', 'AIRFLOW_PASSWORD',
  'BOOTSTRAP_ADMIN_PASSWORD', 'DATABASE_URL', 'TRINO_AUTH_PASSWORD', 'TRINO_AUTH_USERNAME',
  'TRINO_MATERIALIZER_PASSWORD', 'TRINO_MATERIALIZER_USERNAME', 'TRINO_QUERY_CONFIRMATION_SECRET',
  'TRINO_RESULT_CURSOR_SECRET', 'trino-ca.pem',
];
const gatewayKeys = ['AI_GATEWAY_SERVICE_TOKEN', 'AI_MCP_SERVICE_TOKEN', 'AI_PROVIDER_API_KEY'];
const paths = ['backend-es.json', 'gateway-es.json', 'backend-secret.json', 'gateway-secret.json', 'config.json'].map((name) => join(directory, name));

const externalSecret = (name, keys, ready = true) => ({
  spec: {target: {name, creationPolicy: 'Owner'}, data: keys.map((secretKey) => ({secretKey}))},
  status: {conditions: [{type: 'Ready', status: ready ? 'True' : 'False'}]},
});
const secret = (name, keys) => ({
  metadata: {ownerReferences: [{kind: 'ExternalSecret', name, controller: true}]},
  data: Object.fromEntries(keys.map((key) => [key, key.includes('SERVICE_TOKEN') ? 'c2hhcmVk' : key.includes('MCP_SERVICE') ? 'bWNw' : 'dmFsdWU='])),
});
const config = () => ({metadata: {annotations: {'meta.helm.sh/release-name': 'asklake-runtime-config'}, labels: {'app.kubernetes.io/managed-by': 'Helm'}}, data: {AI_QUERY_PROVIDER: 'gateway', AI_GATEWAY_BASE_URL: 'http://ai-gateway:8090'}});

function run(change = () => {}) {
  const fixtures = [externalSecret('asklake-backend-runtime', backendKeys), externalSecret('asklake-ai-gateway-runtime', gatewayKeys), secret('asklake-backend-runtime', backendKeys), secret('asklake-ai-gateway-runtime', gatewayKeys), config()];
  change(fixtures);
  fixtures.forEach((fixture, index) => writeFileSync(paths[index], JSON.stringify(fixture)));
  return spawnSync(process.execPath, [verifier, ...paths], {encoding: 'utf8'});
}

try {
  if (run().status !== 0) throw new Error('valid Gateway runtime was rejected');
  if (run((fixtures) => { fixtures[1].status.conditions[0].status = 'False'; }).status === 0) throw new Error('non-Ready ExternalSecret was accepted');
  if (run((fixtures) => { delete fixtures[2].data.DATABASE_URL; }).status === 0) throw new Error('incomplete Backend Secret was accepted');
  if (run((fixtures) => { fixtures[3].data.AI_GATEWAY_SERVICE_TOKEN = 'ZGlmZmVyZW50'; }).status === 0) throw new Error('mismatched shared token was accepted');
  if (run((fixtures) => { fixtures[2].metadata.ownerReferences[0].name = 'manual-secret'; }).status === 0) throw new Error('manual Secret ownership was accepted');
  if (run((fixtures) => { fixtures[4].metadata.annotations['meta.helm.sh/release-name'] = 'unknown'; }).status === 0) throw new Error('wrong ConfigMap owner was accepted');
  if (run((fixtures) => { fixtures[4].data.AI_QUERY_PROVIDER = 'direct'; }).status === 0) throw new Error('direct config was accepted as Gateway');
  console.log('EKS AI Gateway runtime preflight tests passed (7 scenarios).');
} finally {
  rmSync(directory, {recursive: true, force: true});
}
