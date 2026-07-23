#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const readyMode = args.includes('--ready');
const contractArg = args.find((arg) => !arg.startsWith('--'));
const contractPath = resolve(
  process.cwd(),
  contractArg ?? 'infra/eks/delivery/dev.handoff.example.json',
);

const errors = [];
const fail = (message) => errors.push(message);
const requireExactKeys = (value, expected, label) => {
  const actual = new Set(Object.keys(value ?? {}));
  for (const key of expected) {
    if (!actual.has(key)) fail(`${label} is missing ${key}`);
  }
  for (const key of actual) {
    if (!expected.has(key)) fail(`${label} contains unapproved key ${key}`);
  }
};

let contract;
try {
  contract = JSON.parse(readFileSync(contractPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read delivery handoff: ${error.message}`);
  process.exit(1);
}

const expectedServiceAccounts = {
  frontend: 'asklake-frontend',
  backend: 'asklake-backend',
  aiGateway: 'asklake-ai-gateway',
  airflow: 'asklake-airflow',
  trino: 'asklake-trino',
  mskSmoke: 'asklake-msk-smoke',
  spark: 'asklake-spark',
};

const expectedFlows = new Set([
  'ingress-to-frontend:tcp:80',
  'ingress-to-backend:tcp:8080',
  'backend-to-airflow:tcp:8080',
  'airflow-to-backend:tcp:8080',
  'airflow-to-rds:tcp:5432',
  'backend-to-kubernetes-api:tcp:443',
  'backend-to-rds:tcp:5432',
  'backend-to-trino:tcp:8443',
  'backend-to-ai-gateway:tcp:8090',
  'ai-gateway-to-backend-mcp:tcp:8080',
  'ai-gateway-to-provider:tcp:443',
  'trino-to-rds:tcp:5432',
  'trino-to-s3-sts:tcp:443',
  'backend-spark-to-s3-sts:tcp:443',
  'node-to-ecr-s3:tcp:443',
  'msk-smoke-to-msk:tcp:9098',
  'spark-to-msk:tcp:9098',
  'spark-to-rds:tcp:5432',
  'external-fixture-producer-to-msk:tcp:9098',
]);

const requiredDecisions = new Set([
  'clusterReuseOrCreate',
  'workloadIdentity',
  'secretDelivery',
  'ingressExposure',
  'domainAndCertificate',
  'privateEgress',
  'continuousReadPath',
]);

const expectedConfigReferences = {
  runtimeConfigMap: 'asklake-runtime',
  backendSecret: 'asklake-backend-runtime',
  aiGatewaySecret: 'asklake-ai-gateway-runtime',
  airflowSecret: 'asklake-airflow-runtime',
  sparkSecret: 'asklake-spark-runtime',
  trinoSecret: 'asklake-trino-runtime',
};

requireExactKeys(contract, new Set([
  'contractVersion',
  'environment',
  'readiness',
  'runtimeBoundary',
  'kubernetes',
  'images',
  'configReferences',
  'dataPlaneReferences',
  'isolatedFixture',
  'networkFlows',
  'decisions',
]), 'handoff');

if (contract.contractVersion !== '1.1') fail('contractVersion must be 1.1');
if (contract.environment !== 'dev') fail('environment must be dev for this handoff');
if (!['planning', 'ready-for-deploy'].includes(contract.readiness)) fail('readiness must be planning or ready-for-deploy');

const boundary = contract.runtimeBoundary ?? {};
requireExactKeys(boundary, new Set([
  'kafkaRuntime',
  'kafkaAuth',
  'trinoRuntime',
  'continuousOwner',
  'fixtureProducerLocation',
  'replayWorkloadOnEks',
]), 'runtimeBoundary');
if (boundary.kafkaRuntime !== 'msk-serverless') fail('Kafka runtime must remain MSK Serverless');
if (boundary.kafkaAuth !== 'iam') fail('Kafka authentication must remain IAM');
if (boundary.trinoRuntime !== 'eks-single-coordinator') fail('Trino must remain an EKS single coordinator');
if (boundary.continuousOwner !== 'external-ec2') fail('Continuous control must remain owned by external EC2');
if (boundary.fixtureProducerLocation !== 'outside-eks') fail('fixture producer must remain outside EKS');
if (boundary.replayWorkloadOnEks !== false) fail('Replay workload must not be deployed on EKS');

requireExactKeys(contract.kubernetes, new Set([
  'clusterName',
  'namespace',
  'nodeArchitecture',
  'serviceAccounts',
]), 'kubernetes');
if (contract.kubernetes?.namespace !== 'asklake-dev') fail('namespace must match the asklake-dev foundation contract');
if (contract.kubernetes?.nodeArchitecture !== 'linux/amd64') fail('nodeArchitecture must be linux/amd64');
for (const [key, name] of Object.entries(expectedServiceAccounts)) {
  if (contract.kubernetes?.serviceAccounts?.[key] !== name) {
    fail(`service account ${key} must be ${name}`);
  }
}
if (Object.keys(contract.kubernetes?.serviceAccounts ?? {}).length !== Object.keys(expectedServiceAccounts).length) {
  fail('service account set must contain exactly the nine foundation workloads');
}

for (const [key, name] of Object.entries(expectedConfigReferences)) {
  if (contract.configReferences?.[key] !== name) fail(`config reference ${key} must be ${name}`);
}
if (Object.keys(contract.configReferences ?? {}).length !== Object.keys(expectedConfigReferences).length) {
  fail('configReferences must contain only the approved ConfigMap and Secret references');
}

const fixture = contract.isolatedFixture ?? {};
requireExactKeys(fixture, new Set([
  'topic',
  'consumerGroup',
  'outputPrefix',
  'checkpointPrefix',
]), 'isolatedFixture');
if (fixture.topic !== 'asklake.eks-mvp.fixture.v1') fail('fixture topic must remain isolated');
if (fixture.consumerGroup !== 'asklake-eks-mvp-spark-v1') fail('fixture consumer group must remain isolated');
if (fixture.outputPrefix !== 'eks-mvp/output/') fail('fixture output prefix must remain isolated');
if (fixture.checkpointPrefix !== 'checkpoints/eks-mvp/') fail('fixture checkpoint prefix must remain under the approved S3 checkpoint root');

const imageNames = ['frontend', 'backend', 'aiGateway', 'airflow', 'sparkRuntime', 'trino'];
requireExactKeys(contract.images, new Set(imageNames), 'images');
const immutableImage = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
for (const imageName of imageNames) {
  const image = contract.images?.[imageName];
  if (typeof image === 'string' && (image.endsWith(':latest') || image.includes('@latest'))) {
    fail(`${imageName} image must not use latest`);
  }
  if (readyMode && !immutableImage.test(image ?? '')) {
    fail(`${imageName} image must be an immutable ECR digest in --ready mode`);
  }
}

requireExactKeys(contract.dataPlaneReferences, new Set([
  'mskClusterArn',
  'mskBootstrapBrokersSaslIam',
  'rdsEndpoint',
  'storageBuckets',
  'trinoServiceUrl',
  'workloadIdentityMode',
]), 'dataPlaneReferences');
if (!['disabled', 'irsa', 'pod_identity'].includes(contract.dataPlaneReferences?.workloadIdentityMode)) {
  fail('workloadIdentityMode must be disabled, irsa or pod_identity');
}
if (contract.dataPlaneReferences?.trinoServiceUrl !== 'https://asklake-trino.asklake-dev.svc:8443') {
  fail('Trino service URL must match the in-cluster HTTPS contract');
}

const flowList = Array.isArray(contract.networkFlows) ? contract.networkFlows : [];
if (!Array.isArray(contract.networkFlows)) fail('networkFlows must be an array');
const actualFlows = new Set(flowList);
if (actualFlows.size !== flowList.length) fail('networkFlows must not contain duplicates');
for (const flow of expectedFlows) {
  if (!actualFlows.has(flow)) fail(`required network flow is missing: ${flow}`);
}
for (const flow of actualFlows) {
  if (!expectedFlows.has(flow)) fail(`unapproved network flow is present: ${flow}`);
}

const allowedDecisionStatuses = new Set(['learning-required', 'selected', 'deferred']);
const actualDecisions = new Set(Object.keys(contract.decisions ?? {}));
for (const name of requiredDecisions) {
  if (!actualDecisions.has(name)) fail(`required decision is missing: ${name}`);
}
for (const name of actualDecisions) {
  if (!requiredDecisions.has(name)) fail(`unapproved decision key is present: ${name}`);
}
for (const [name, decision] of Object.entries(contract.decisions ?? {})) {
  if (!allowedDecisionStatuses.has(decision?.status)) fail(`${name} has an invalid decision status`);
  if (decision?.status === 'selected' && !decision.selected) fail(`${name} is selected without a value`);
  if (decision?.status !== 'selected' && decision?.selected !== null) {
    fail(`${name} must not carry a selected value before the decision is selected`);
  }
}
const secretDeliveryDecision = contract.decisions?.secretDelivery;
if (secretDeliveryDecision?.status === 'selected' &&
    !['external_secrets', 'workflow_sync'].includes(secretDeliveryDecision.selected)) {
  fail('secretDelivery must select external_secrets or workflow_sync');
}

const serialized = JSON.stringify(contract);
const credentialPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /aws_secret_access_key/i,
];
for (const pattern of credentialPatterns) {
  if (pattern.test(serialized)) fail(`credential-like content matched ${pattern}`);
}

if (readyMode) {
  if (contract.readiness !== 'ready-for-deploy') fail('readiness must be ready-for-deploy in --ready mode');
  if (!contract.kubernetes?.clusterName) fail('clusterName is required in --ready mode');
  if (!['irsa', 'pod_identity'].includes(contract.dataPlaneReferences?.workloadIdentityMode)) {
    fail('workloadIdentityMode must be irsa or pod_identity in --ready mode');
  }
  for (const key of ['mskClusterArn', 'mskBootstrapBrokersSaslIam', 'rdsEndpoint', 'storageBuckets']) {
    if (!contract.dataPlaneReferences?.[key]) fail(`${key} is required in --ready mode`);
  }
  const httpsIngress = String(contract.decisions?.ingressExposure?.selected ?? '').includes('https');
  for (const [name, decision] of Object.entries(contract.decisions ?? {})) {
    const mayRemainDeferred = name === 'continuousReadPath' ||
      (name === 'domainAndCertificate' && !httpsIngress);
    if (mayRemainDeferred && !['deferred', 'selected'].includes(decision.status)) {
      fail(`${name} must be deferred or selected before deployment`);
    }
    if (!mayRemainDeferred && decision.status !== 'selected') {
      fail(`${name} must be selected before deployment`);
    }
    if (name === 'domainAndCertificate' && httpsIngress && decision.status !== 'selected') {
      fail('domainAndCertificate must be selected for HTTPS ingress');
    }
  }
}

if (errors.length > 0) {
  console.error(`EKS delivery handoff verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`EKS delivery handoff verification passed (${readyMode ? 'ready' : 'planning'} mode).`);
