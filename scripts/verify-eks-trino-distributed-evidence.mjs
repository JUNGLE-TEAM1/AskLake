#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ISSUE_BASELINE_COMMIT = 'a782ab7aee560df8c68b4e64452a8d00e415d8ab';

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\n') !== expected.join('\n')) throw new Error(`${label} keys do not match the evidence contract`);
};
const positiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
};
const workerReplicaCount = (value, label, expectedWorkerCount) => {
  if (expectedWorkerCount === null) {
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`${label} must be an integer between 1 and 5`);
    return;
  }
  if (value !== expectedWorkerCount) throw new Error(`${label} must be exactly ${expectedWorkerCount}`);
};
const nonNegativeInteger = (value, label) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
};
const truth = (value, label) => {
  if (value !== true) throw new Error(`${label} must be true`);
};
const hash = (value, label) => {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`${label} must be a redacted SHA-256 identity`);
};
const commit = (value, label) => {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${label} must be a full Git commit`);
};
const timestamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
};
const hashList = (value, label) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  value.forEach((entry, index) => hash(entry, `${label}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
};
const unchangedHashPair = (value, beforeKey, afterKey, label) => {
  hash(value[beforeKey], `${label}.${beforeKey}`);
  hash(value[afterKey], `${label}.${afterKey}`);
  if (value[beforeKey] !== value[afterKey]) throw new Error(`${label} changed during the campaign`);
};

function validateDistributedTrinoEvidenceVersion(receipt, expectedDeploymentCommit, schemaVersion, expectedWorkerCount) {
  exactKeys(receipt, ['schemaVersion', 'baselineCommit', 'deploymentCommit', 'status', 'deployment', 'nodes', 'query', 'failure', 'contracts', 'rollback', 'cleanup'], 'receipt');
  if (receipt.schemaVersion !== schemaVersion) throw new Error(`schemaVersion must be ${schemaVersion}`);
  if (receipt.baselineCommit !== ISSUE_BASELINE_COMMIT) throw new Error('baselineCommit does not match the Issue baseline');
  commit(receipt.deploymentCommit, 'deploymentCommit');
  if (expectedDeploymentCommit !== null && receipt.deploymentCommit !== expectedDeploymentCommit) {
    throw new Error('deploymentCommit does not match the deployed pair1 commit');
  }
  if (receipt.status !== 'passed') throw new Error('status must be passed');

  exactKeys(receipt.deployment, ['namespace', 'release', 'helmRevision', 'declaredWorkerReplicas', 'imageDigest', 'chartSha256', 'valuesSha256', 'deployedAt'], 'deployment');
  if (receipt.deployment.namespace !== 'asklake-dev') throw new Error('deployment.namespace must be asklake-dev');
  if (receipt.deployment.release !== 'asklake-trino') throw new Error('deployment.release must be asklake-trino');
  positiveInteger(receipt.deployment.helmRevision, 'deployment.helmRevision');
  workerReplicaCount(receipt.deployment.declaredWorkerReplicas, 'deployment.declaredWorkerReplicas', expectedWorkerCount);
  hash(receipt.deployment.imageDigest, 'deployment.imageDigest');
  hash(receipt.deployment.chartSha256, 'deployment.chartSha256');
  hash(receipt.deployment.valuesSha256, 'deployment.valuesSha256');
  timestamp(receipt.deployment.deployedAt, 'deployment.deployedAt');

  exactKeys(receipt.nodes, ['coordinatorCount', 'activeWorkerCount', 'coordinatorNodeHash', 'workerNodeHashes'], 'nodes');
  if (receipt.nodes.coordinatorCount !== 1) throw new Error('nodes.coordinatorCount must be 1');
  if (receipt.nodes.activeWorkerCount !== receipt.deployment.declaredWorkerReplicas) throw new Error('active worker count does not match the declared replica count');
  hash(receipt.nodes.coordinatorNodeHash, 'nodes.coordinatorNodeHash');
  hashList(receipt.nodes.workerNodeHashes, 'nodes.workerNodeHashes');
  if (receipt.nodes.workerNodeHashes.length !== receipt.nodes.activeWorkerCount) throw new Error('worker node evidence count does not match activeWorkerCount');
  if (receipt.nodes.workerNodeHashes.includes(receipt.nodes.coordinatorNodeHash)) throw new Error('coordinator and worker node identities overlap');

  exactKeys(receipt.query, ['queryIdHash', 'catalog', 'nonEmptyInput', 'processedRows', 'workerTaskNodeHashes', 'status'], 'query');
  hash(receipt.query.queryIdHash, 'query.queryIdHash');
  if (receipt.query.catalog !== 'iceberg') throw new Error('query.catalog must be iceberg');
  truth(receipt.query.nonEmptyInput, 'query.nonEmptyInput');
  positiveInteger(receipt.query.processedRows, 'query.processedRows');
  if (receipt.query.status !== 'succeeded') throw new Error('query.status must be succeeded');
  hashList(receipt.query.workerTaskNodeHashes, 'query.workerTaskNodeHashes');
  for (const taskNode of receipt.query.workerTaskNodeHashes) {
    if (!receipt.nodes.workerNodeHashes.includes(taskNode)) throw new Error('query task evidence references a non-worker node');
  }

  exactKeys(receipt.failure, ['removedWorkerPodUidHash', 'removedWorkerOwnerDeploymentUidHash', 'deletePreconditionUidHash', 'replacementWorkerPodUidHash', 'replacementWorkerNodeHash', 'recoveredWorkerNodeHashes', 'recoveredActiveWorkerCount', 'inFlightQueryOutcome', 'postRecoveryQuerySucceeded'], 'failure');
  hash(receipt.failure.removedWorkerPodUidHash, 'failure.removedWorkerPodUidHash');
  hash(receipt.failure.removedWorkerOwnerDeploymentUidHash, 'failure.removedWorkerOwnerDeploymentUidHash');
  hash(receipt.failure.deletePreconditionUidHash, 'failure.deletePreconditionUidHash');
  hash(receipt.failure.replacementWorkerPodUidHash, 'failure.replacementWorkerPodUidHash');
  hash(receipt.failure.replacementWorkerNodeHash, 'failure.replacementWorkerNodeHash');
  hashList(receipt.failure.recoveredWorkerNodeHashes, 'failure.recoveredWorkerNodeHashes');
  if (receipt.failure.deletePreconditionUidHash !== receipt.failure.removedWorkerPodUidHash) throw new Error('worker delete did not use the captured Pod UID precondition');
  if (receipt.failure.removedWorkerPodUidHash === receipt.failure.replacementWorkerPodUidHash) throw new Error('replacement worker must have a different Pod UID');
  if (receipt.failure.recoveredActiveWorkerCount !== receipt.deployment.declaredWorkerReplicas) throw new Error('worker count did not recover');
  if (receipt.failure.recoveredWorkerNodeHashes.length !== receipt.failure.recoveredActiveWorkerCount) throw new Error('recovered worker node evidence count does not match');
  if (!receipt.failure.recoveredWorkerNodeHashes.includes(receipt.failure.replacementWorkerNodeHash)) throw new Error('replacement worker did not register in the recovered Trino node set');
  if (receipt.failure.recoveredWorkerNodeHashes.includes(receipt.nodes.coordinatorNodeHash)) throw new Error('recovered worker set contains the coordinator');
  if (!['succeeded', 'failed'].includes(receipt.failure.inFlightQueryOutcome)) throw new Error('in-flight query outcome must be recorded without an availability claim');
  truth(receipt.failure.postRecoveryQuerySucceeded, 'failure.postRecoveryQuerySucceeded');

  const contractKeys = [
    'rdsCatalogHashBefore', 'rdsCatalogHashAfter',
    'warehouseLocationHashBefore', 'warehouseLocationHashAfter',
    'tlsServiceNameHashBefore', 'tlsServiceNameHashAfter',
    'serviceAccountHashBefore', 'serviceAccountHashAfter',
    'podIdentityHashBefore', 'podIdentityHashAfter',
  ];
  exactKeys(receipt.contracts, contractKeys, 'contracts');
  unchangedHashPair(receipt.contracts, 'rdsCatalogHashBefore', 'rdsCatalogHashAfter', 'contracts.rdsCatalog');
  unchangedHashPair(receipt.contracts, 'warehouseLocationHashBefore', 'warehouseLocationHashAfter', 'contracts.warehouseLocation');
  unchangedHashPair(receipt.contracts, 'tlsServiceNameHashBefore', 'tlsServiceNameHashAfter', 'contracts.tlsServiceName');
  unchangedHashPair(receipt.contracts, 'serviceAccountHashBefore', 'serviceAccountHashAfter', 'contracts.serviceAccount');
  unchangedHashPair(receipt.contracts, 'podIdentityHashBefore', 'podIdentityHashAfter', 'contracts.podIdentity');

  exactKeys(receipt.rollback, ['targetMode', 'previousHelmRevision', 'backendHealthy', 'querySucceeded', 'workerResourcesAbsent'], 'rollback');
  if (receipt.rollback.targetMode !== 'single-coordinator-recreate') throw new Error('rollback.targetMode must be single-coordinator-recreate');
  positiveInteger(receipt.rollback.previousHelmRevision, 'rollback.previousHelmRevision');
  truth(receipt.rollback.backendHealthy, 'rollback.backendHealthy');
  truth(receipt.rollback.querySucceeded, 'rollback.querySucceeded');
  truth(receipt.rollback.workerResourcesAbsent, 'rollback.workerResourcesAbsent');

  exactKeys(receipt.cleanup, ['temporaryResourceCount', 'privateFixtureRemoved', 'durableEvidencePreserved'], 'cleanup');
  nonNegativeInteger(receipt.cleanup.temporaryResourceCount, 'cleanup.temporaryResourceCount');
  if (receipt.cleanup.temporaryResourceCount !== 0) throw new Error('temporary resources remain');
  truth(receipt.cleanup.privateFixtureRemoved, 'cleanup.privateFixtureRemoved');
  truth(receipt.cleanup.durableEvidencePreserved, 'cleanup.durableEvidencePreserved');
  return receipt;
}

export function validateDistributedTrinoEvidence(receipt, expectedDeploymentCommit = null) {
  return validateDistributedTrinoEvidenceVersion(receipt, expectedDeploymentCommit, 3, 5);
}

export function validateHistoricalDistributedTrinoEvidenceV2(receipt, expectedDeploymentCommit = null) {
  return validateDistributedTrinoEvidenceVersion(receipt, expectedDeploymentCommit, 2, null);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const historicalV2 = process.argv[2] === '--historical-v2';
  const path = process.argv[historicalV2 ? 3 : 2];
  const expectedDeploymentCommit = process.env.ASKLAKE_TRINO_DEPLOYMENT_COMMIT;
  if (!path || !expectedDeploymentCommit) {
    console.error('usage: ASKLAKE_TRINO_DEPLOYMENT_COMMIT=<merged-pair1-sha> verify-eks-trino-distributed-evidence.mjs [--historical-v2] <redacted-receipt.json>');
    process.exit(2);
  }
  try {
    commit(expectedDeploymentCommit, 'ASKLAKE_TRINO_DEPLOYMENT_COMMIT');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (historicalV2) {
      validateHistoricalDistributedTrinoEvidenceV2(receipt, expectedDeploymentCommit);
    } else {
      validateDistributedTrinoEvidence(receipt, expectedDeploymentCommit);
    }
    console.log(JSON.stringify({ contract: historicalV2 ? 'eks-trino-distributed-evidence-v2-historical' : 'eks-trino-distributed-evidence-v3', status: 'passed' }));
  } catch (error) {
    console.error(`distributed Trino evidence rejected: ${error.message}`);
    process.exit(1);
  }
}
