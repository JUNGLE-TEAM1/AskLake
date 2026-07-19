#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const verifier = resolve(import.meta.dirname, 'verify-eks-realtime-v2-live-evidence.mjs');
const image = (component, digit) => `111122223333.dkr.ecr.region.amazonaws.com/asklake/dev/${component}@sha256:${digit.repeat(64)}`;
const pvcUids = { clickhouse: 'pvc-clickhouse-uid', keeper: 'pvc-keeper-uid' };
const position = { topic: 'fixture.events', partition: 0, offset: 42 };

const fixture = () => ({
  contractVersion: '1.0', evidenceType: 'live', environment: 'dev', capturedAt: '2026-07-20T03:00:00+09:00',
  images: { backend: image('backend', '1'), clickhouse: image('clickhouse-v2', '2'), kafkaConnect: image('kafka-connect-v2', '3') },
  fixture: { jobId: 'job-1', runId: 'run-1', outputDatasetId: 'dataset-gold', dashboardId: 'dashboard-1', widgetId: 'widget-1', generation: 1, position },
  health: { v2: { enabled: true, ready: true, status: 'ready', consumerOwner: 'kafka_connect_v2', clickhouse: { ready: true }, connector: { state: 'RUNNING', workerReady: true, taskStates: ['RUNNING'] } } },
  ownership: {
    v1Kafka: { desired: 1, ready: 1, scope: 'kafka', owner: 'eks-continuous-worker-v1' },
    v2Continuous: { desired: 1, ready: 1, scope: 'continuous_sql', owner: 'eks-continuous-worker-v2' },
    ec2ContinuousProcesses: 0,
    activeControlPlanes: ['kafka-continuous-runtime-sync:eks-realtime-v1-worker', 'continuous-sql-runtime-sync:eks-realtime-v2-worker'],
  },
  regressions: {
    finiteBatch: { jobId: 'batch-job-1', status: 'success', orchestrator: 'airflow', runtime: 'spark', storage: 'iceberg', icebergSnapshotId: 'snapshot-batch-1', catalogStatus: 'available', queryEngine: 'trino', returnedRows: 1 },
    v1Kafka: { jobId: 'v1-job-1', status: 'success', runtime: 'spark_structured_streaming', storage: 'iceberg', icebergSnapshotId: 'snapshot-v1-1', catalogStatus: 'available', queryEngine: 'trino', returnedRows: 1, position: { topic: 'fixture.v1', partition: 0, offset: 7 } },
  },
  job: { id: 'job-1', activeRunId: 'run-1', generation: 1, servingMode: 'clickhouse', outputLayer: 'GOLD', desiredState: 'running', observedState: 'running', outputDatasetId: 'dataset-gold' },
  batch: { runId: 'run-1', generation: 1, stage: 'dashboard_ready', datasetRevision: 1, rowCount: 1, sourceBoundaryId: 'boundary-1', sourcePositions: [position] },
  catalog: { id: 'dataset-gold', status: 'available', layer: 'GOLD', freshness: 'realtime', servingEngine: 'clickhouse', servingVersionId: 'version-1', datasetRevision: 1, sourceBoundaryId: 'boundary-1' },
  dashboard: { id: 'dashboard-1', widgetId: 'widget-1', datasetId: 'dataset-gold', datasetRevision: 1, generation: 1, usesFinalProjection: true, returnedRows: 1 },
  clickhouse: { outputUsesFinal: true, rawRowCount: 1, outputRowCount: 1, rawPositions: [position], outputPositions: [position], duplicateSourcePositions: 0 },
  persistence: { pvcUidsBefore: pvcUids, pvcUidsAfterReapply: pvcUids, helmRevisionBefore: 1, helmRevisionAfter: 2, webConfigPreserved: true, workerConfigPreserved: true },
  faults: ['continuous-worker-pod', 'kafka-connect-deployment', 'clickhouse-pod'].map((scenario) => ({ scenario, injected: true, recovered: true, jobGeneration: 1, duplicatePublications: 0, dataLoss: 0, recoverySeconds: 5 })),
  rollback: { executed: true, completed: true, v1KafkaReady: 1, v2ContinuousDesired: 0, finiteBatchSmokeJobId: 'batch-job-1', pvcUids, catalogDatasetId: 'dataset-gold' },
  redeploy: { executed: true, healthReady: true, v1KafkaReady: 1, v2ContinuousReady: 1, jobId: 'job-1', catalogDatasetId: 'dataset-gold', dashboardDatasetRevision: 1, dashboardRows: 1, pvcUids },
});

const run = (mutate = (value) => value) => {
  const directory = mkdtempSync(join(tmpdir(), 'asklake-realtime-live-evidence-'));
  try {
    const evidence = fixture();
    mutate(evidence);
    const path = join(directory, 'evidence.json');
    writeFileSync(path, JSON.stringify(evidence), { mode: 0o600 });
    return spawnSync(process.execPath, [verifier, path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('accepts correlated E2E, fault, rollback, and redeploy evidence', () => {
  assert.equal(run().status, 0);
});

test('rejects a Catalog revision that differs from the published batch', () => {
  const result = run((value) => { value.catalog.datasetRevision = 2; });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Catalog publication/);
});

test('rejects missing source-position continuity and duplicate ClickHouse rows', () => {
  const result = run((value) => {
    value.dashboard.returnedRows = 0;
    value.clickhouse.outputPositions = [];
    value.clickhouse.duplicateSourcePositions = 1;
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dashboard result/);
  assert.match(result.stderr, /source position/);
  assert.match(result.stderr, /duplicate/);
});

test('rejects incomplete fault, rollback, and PVC persistence evidence', () => {
  const result = run((value) => {
    value.faults.pop();
    value.rollback.finiteBatchSmokeJobId = 'unproven-job';
    value.regressions.v1Kafka.returnedRows = 0;
    value.redeploy.pvcUids = { ...pvcUids, clickhouse: 'replacement-pvc' };
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fault evidence/);
  assert.match(result.stderr, /V1 Kafka/);
  assert.match(result.stderr, /rollback/);
  assert.match(result.stderr, /redeploy/);
});

test('rejects credential-like content', () => {
  const result = run((value) => { value.fixture.password = 'forbidden'; });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential/);
});
