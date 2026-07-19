#!/usr/bin/env node
import assert from 'node:assert/strict';
import { validateDistributedTrinoEvidence } from './verify-eks-trino-distributed-evidence.mjs';

const h = (character) => `sha256:${character.repeat(64)}`;
const deploymentCommit = '1'.repeat(40);
const unchangedContracts = () => ({
  rdsCatalogHashBefore: h('1'), rdsCatalogHashAfter: h('1'),
  warehouseLocationHashBefore: h('2'), warehouseLocationHashAfter: h('2'),
  tlsServiceNameHashBefore: h('3'), tlsServiceNameHashAfter: h('3'),
  serviceAccountHashBefore: h('4'), serviceAccountHashAfter: h('4'),
  podIdentityHashBefore: h('5'), podIdentityHashAfter: h('5'),
});
const valid = () => ({
  schemaVersion: 2,
  baselineCommit: 'a782ab7aee560df8c68b4e64452a8d00e415d8ab',
  deploymentCommit,
  status: 'passed',
  deployment: {
    namespace: 'asklake-dev', release: 'asklake-trino', helmRevision: 19,
    declaredWorkerReplicas: 2, imageDigest: h('6'), chartSha256: h('7'), valuesSha256: h('8'),
    deployedAt: '2026-07-19T12:00:00Z',
  },
  nodes: { coordinatorCount: 1, activeWorkerCount: 2, coordinatorNodeHash: h('a'), workerNodeHashes: [h('b'), h('c')] },
  query: { queryIdHash: h('d'), catalog: 'iceberg', nonEmptyInput: true, processedRows: 10, workerTaskNodeHashes: [h('b')], status: 'succeeded' },
  failure: {
    removedWorkerPodUidHash: h('e'), removedWorkerOwnerDeploymentUidHash: h('f'), deletePreconditionUidHash: h('e'),
    replacementWorkerPodUidHash: h('9'), replacementWorkerNodeHash: h('0'), recoveredWorkerNodeHashes: [h('c'), h('0')],
    recoveredActiveWorkerCount: 2, inFlightQueryOutcome: 'failed', postRecoveryQuerySucceeded: true,
  },
  contracts: unchangedContracts(),
  rollback: { targetMode: 'single-coordinator-recreate', previousHelmRevision: 18, backendHealthy: true, querySucceeded: true, workerResourcesAbsent: true },
  cleanup: { temporaryResourceCount: 0, privateFixtureRemoved: true, durableEvidencePreserved: true },
});

assert.equal(validateDistributedTrinoEvidence(valid(), deploymentCommit).status, 'passed');

const maximumWorkers = valid();
maximumWorkers.deployment.declaredWorkerReplicas = 5;
maximumWorkers.nodes.activeWorkerCount = 5;
maximumWorkers.nodes.workerNodeHashes = [h('b'), h('c'), h('1'), h('2'), h('3')];
maximumWorkers.failure.recoveredWorkerNodeHashes = [h('b'), h('c'), h('1'), h('2'), h('0')];
maximumWorkers.failure.recoveredActiveWorkerCount = 5;
assert.equal(validateDistributedTrinoEvidence(maximumWorkers, deploymentCommit).status, 'passed');

const excessiveWorkers = valid();
excessiveWorkers.deployment.declaredWorkerReplicas = 6;
assert.throws(
  () => validateDistributedTrinoEvidence(excessiveWorkers, deploymentCommit),
  /deployment\.declaredWorkerReplicas must be an integer between 1 and 5/,
);

for (const mutate of [
  (receipt) => { receipt.deploymentCommit = '2'.repeat(40); },
  (receipt) => { receipt.nodes.coordinatorCount = 2; },
  (receipt) => { receipt.nodes.activeWorkerCount = 1; },
  (receipt) => { receipt.nodes.workerNodeHashes[0] = receipt.nodes.coordinatorNodeHash; },
  (receipt) => { receipt.query.workerTaskNodeHashes = [h('9')]; },
  (receipt) => { receipt.failure.deletePreconditionUidHash = h('7'); },
  (receipt) => { receipt.failure.replacementWorkerPodUidHash = receipt.failure.removedWorkerPodUidHash; },
  (receipt) => { receipt.failure.replacementWorkerNodeHash = h('7'); },
  (receipt) => { receipt.failure.inFlightQueryOutcome = 'assumed-recovered'; },
  (receipt) => { receipt.contracts.podIdentityHashAfter = h('8'); },
  (receipt) => { receipt.rollback.workerResourcesAbsent = false; },
  (receipt) => { receipt.cleanup.temporaryResourceCount = 1; },
]) {
  const receipt = valid();
  mutate(receipt);
  assert.throws(() => validateDistributedTrinoEvidence(receipt, deploymentCommit));
}
console.log('EKS distributed Trino evidence contract tests passed.');
