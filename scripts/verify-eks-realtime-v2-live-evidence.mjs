#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const evidencePath = resolve(process.cwd(), process.argv[2] ?? '');
const allowExample = process.argv.includes('--allow-example');
const errors = [];
const fail = (message) => errors.push(message);

let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
} catch (error) {
  console.error(`Unable to read realtime V2 live evidence: ${error.message}`);
  process.exit(1);
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const immutableEcr = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const positionKey = (value) => `${value?.topic ?? ''}:${value?.partition ?? ''}:${value?.offset ?? ''}`;

if (evidence.contractVersion !== '1.0') fail('contractVersion must be 1.0');
if (evidence.evidenceType !== 'live' && !(allowExample && evidence.evidenceType === 'example')) {
  fail('evidenceType must be live');
}
if (!['dev', 'staging'].includes(evidence.environment)) fail('environment must be dev or staging');
if (Number.isNaN(Date.parse(evidence.capturedAt ?? ''))) fail('capturedAt must be ISO-8601');

for (const [component, image] of Object.entries(evidence.images ?? {})) {
  if (!immutableEcr.test(String(image))) fail(`${component} image must be an immutable ECR digest`);
}
if (!same(Object.keys(evidence.images ?? {}).sort(), ['backend', 'clickhouse', 'kafkaConnect'])) {
  fail('images must contain exactly backend, clickhouse, and kafkaConnect');
}

const fixture = evidence.fixture ?? {};
if (![fixture.jobId, fixture.runId, fixture.outputDatasetId, fixture.dashboardId, fixture.widgetId]
  .every(nonEmpty)) fail('fixture IDs must be non-empty');
if (!nonEmpty(fixture.position?.topic)
  || !Number.isInteger(fixture.position?.partition)
  || !Number.isInteger(fixture.position?.offset)) fail('fixture source position is invalid');
if (!positiveInteger(fixture.generation)) fail('fixture generation must be positive');

const health = evidence.health?.v2 ?? {};
if (health.enabled !== true || health.ready !== true || health.status !== 'ready') {
  fail('FastAPI V2 health must be enabled and ready');
}
if (health.consumerOwner !== 'kafka_connect_v2') fail('FastAPI V2 consumer owner must be kafka_connect_v2');
if (health.clickhouse?.ready !== true) fail('FastAPI ClickHouse probe must be ready');
if (health.connector?.state !== 'RUNNING' || health.connector?.workerReady !== true
  || !Array.isArray(health.connector?.taskStates) || health.connector.taskStates.length === 0
  || health.connector.taskStates.some((state) => state !== 'RUNNING')) {
  fail('FastAPI Kafka Connect probe and every task must be RUNNING');
}

const ownership = evidence.ownership ?? {};
if (ownership.v1Kafka?.desired !== 1 || ownership.v1Kafka?.ready !== 1
  || ownership.v1Kafka?.scope !== 'kafka'
  || ownership.v1Kafka?.owner !== 'eks-continuous-worker-v1') {
  fail('V1 must remain the single ready Kafka owner');
}
if (ownership.v2Continuous?.desired !== 1 || ownership.v2Continuous?.ready !== 1
  || ownership.v2Continuous?.scope !== 'continuous_sql'
  || ownership.v2Continuous?.owner !== 'eks-continuous-worker-v2') {
  fail('V2 must be the single ready Continuous SQL owner');
}
if (ownership.ec2ContinuousProcesses !== 0) fail('EC2 Continuous processes must be quiesced');
if (!same(ownership.activeControlPlanes, [
  'kafka-continuous-runtime-sync:eks-realtime-v1-worker',
  'continuous-sql-runtime-sync:eks-realtime-v2-worker',
])) fail('active control planes do not match the canonical exactly-one topology');

const regressions = evidence.regressions ?? {};
const finiteBatch = regressions.finiteBatch ?? {};
if (!nonEmpty(finiteBatch.jobId) || finiteBatch.status !== 'success'
  || finiteBatch.orchestrator !== 'airflow' || finiteBatch.runtime !== 'spark'
  || finiteBatch.storage !== 'iceberg' || !nonEmpty(finiteBatch.icebergSnapshotId)
  || finiteBatch.catalogStatus !== 'available' || finiteBatch.queryEngine !== 'trino'
  || !positiveInteger(finiteBatch.returnedRows)) {
  fail('finite batch Airflow/Spark/Iceberg/Catalog/Trino regression evidence is incomplete');
}
const v1Kafka = regressions.v1Kafka ?? {};
if (!nonEmpty(v1Kafka.jobId) || v1Kafka.status !== 'success'
  || v1Kafka.runtime !== 'spark_structured_streaming' || v1Kafka.storage !== 'iceberg'
  || !nonEmpty(v1Kafka.icebergSnapshotId) || v1Kafka.catalogStatus !== 'available'
  || v1Kafka.queryEngine !== 'trino' || !positiveInteger(v1Kafka.returnedRows)
  || !nonEmpty(v1Kafka.position?.topic) || !Number.isInteger(v1Kafka.position?.partition)
  || !Number.isInteger(v1Kafka.position?.offset)) {
  fail('V1 Kafka/Spark/Iceberg/Catalog/Trino regression evidence is incomplete');
}

const job = evidence.job ?? {};
if (job.id !== fixture.jobId || job.activeRunId !== fixture.runId
  || job.generation !== fixture.generation || job.servingMode !== 'clickhouse'
  || job.outputLayer !== 'GOLD' || job.desiredState !== 'running'
  || job.observedState !== 'running' || job.outputDatasetId !== fixture.outputDatasetId) {
  fail('Continuous SQL job does not match the running ClickHouse GOLD fixture');
}

const batch = evidence.batch ?? {};
if (batch.runId !== fixture.runId || batch.generation !== fixture.generation
  || batch.stage !== 'dashboard_ready' || !positiveInteger(batch.datasetRevision)
  || !positiveInteger(batch.rowCount)) fail('batch is not a published dashboard-ready fixture batch');
const fixturePosition = positionKey(fixture.position);
if (!(batch.sourcePositions ?? []).some((position) => positionKey(position) === fixturePosition)) {
  fail('batch does not contain the exact produced Kafka source position');
}

const catalog = evidence.catalog ?? {};
if (catalog.id !== fixture.outputDatasetId || catalog.status !== 'available'
  || catalog.layer !== 'GOLD' || catalog.freshness !== 'realtime'
  || catalog.servingEngine !== 'clickhouse' || !nonEmpty(catalog.servingVersionId)
  || catalog.datasetRevision !== batch.datasetRevision
  || catalog.sourceBoundaryId !== batch.sourceBoundaryId) {
  fail('GOLD Catalog publication does not match the batch revision and boundary');
}

const dashboard = evidence.dashboard ?? {};
if (dashboard.id !== fixture.dashboardId || dashboard.widgetId !== fixture.widgetId
  || dashboard.datasetId !== fixture.outputDatasetId
  || dashboard.datasetRevision !== batch.datasetRevision
  || dashboard.generation !== fixture.generation || dashboard.usesFinalProjection !== true
  || !positiveInteger(dashboard.returnedRows)) {
  fail('published Dashboard result does not match the GOLD fixture generation and revision');
}

const clickhouse = evidence.clickhouse ?? {};
if (clickhouse.outputUsesFinal !== true || !positiveInteger(clickhouse.rawRowCount)
  || !positiveInteger(clickhouse.outputRowCount)) fail('ClickHouse FINAL output evidence is incomplete');
for (const [label, positions] of Object.entries({raw: clickhouse.rawPositions, output: clickhouse.outputPositions})) {
  if (!(positions ?? []).some((position) => positionKey(position) === fixturePosition)) {
    fail(`ClickHouse ${label} rows do not contain the exact fixture source position`);
  }
}
if (clickhouse.duplicateSourcePositions !== 0) fail('ClickHouse contains duplicate fixture source positions');

const pvcBefore = evidence.persistence?.pvcUidsBefore ?? {};
const pvcAfter = evidence.persistence?.pvcUidsAfterReapply ?? {};
if (!nonEmpty(pvcBefore.clickhouse) || !nonEmpty(pvcBefore.keeper) || !same(pvcBefore, pvcAfter)) {
  fail('Helm reapply did not preserve both retained PVC UIDs');
}
if (!positiveInteger(evidence.persistence?.helmRevisionBefore)
  || !positiveInteger(evidence.persistence?.helmRevisionAfter)
  || evidence.persistence.helmRevisionAfter <= evidence.persistence.helmRevisionBefore
  || evidence.persistence?.webConfigPreserved !== true
  || evidence.persistence?.workerConfigPreserved !== true) {
  fail('Helm reapply persistence evidence is incomplete');
}

const requiredFaults = new Set(['clickhouse-pod', 'continuous-worker-pod', 'kafka-connect-deployment']);
const faults = evidence.faults ?? [];
if (faults.length !== requiredFaults.size || faults.some((fault) => !requiredFaults.delete(fault.scenario))) {
  fail('fault evidence must contain each approved scenario exactly once');
}
for (const fault of faults) {
  if (fault.injected !== true || fault.recovered !== true
    || fault.jobGeneration !== fixture.generation || fault.duplicatePublications !== 0
    || fault.dataLoss !== 0 || !positiveInteger(fault.recoverySeconds)) {
    fail(`fault recovery evidence is incomplete: ${fault.scenario ?? 'unknown'}`);
  }
}

const rollback = evidence.rollback ?? {};
if (rollback.executed !== true || rollback.completed !== true
  || rollback.v1KafkaReady !== 1 || rollback.v2ContinuousDesired !== 0
  || rollback.finiteBatchSmokeJobId !== finiteBatch.jobId || !same(rollback.pvcUids, pvcBefore)
  || rollback.catalogDatasetId !== fixture.outputDatasetId) {
  fail('rollback did not restore the canonical standby state and finite batch path');
}
const redeploy = evidence.redeploy ?? {};
if (redeploy.executed !== true || redeploy.healthReady !== true
  || redeploy.v1KafkaReady !== 1 || redeploy.v2ContinuousReady !== 1
  || redeploy.jobId !== fixture.jobId || redeploy.catalogDatasetId !== fixture.outputDatasetId
  || redeploy.dashboardDatasetRevision !== batch.datasetRevision
  || !positiveInteger(redeploy.dashboardRows) || !same(redeploy.pvcUids, pvcBefore)) {
  fail('redeploy did not restore the V2 E2E state on the retained PVCs');
}

const serialized = JSON.stringify(evidence);
if (/AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|password|server\.key/i.test(serialized)) {
  fail('credential or private-key material is forbidden in live evidence');
}

if (errors.length > 0) {
  console.error(`EKS realtime V2 live evidence verification failed (${errors.length}):`);
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS realtime V2 E2E, fault, rollback, and redeploy evidence verification passed.');
