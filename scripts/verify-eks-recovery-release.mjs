#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = 'e6f86eb8f02a16772d945c405af80d75eff96db2';
const DASHBOARD_SOURCE = 'e6d6b7f868d2bb2b1f376aa6a5174608fefe6249';
const EXPECTED_BACKEND_TREE = '375f427a0c6ff7034edd07cdfdebc6415d9725f3';
const EXPECTED_JOBS_TREE = 'e28a35c6b1d4475c269565d8626965de1eb42378';
const FORBIDDEN_ANCESTORS = [
  '1de45135',
  'e6d6b7f8',
];

const exactDashboardFiles = [
  'frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx',
  'frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx',
  'frontend/src/pages/dashboard/runtime/barChartAxes.ts',
  'frontend/src/pages/dashboard/runtime/widgetConfigValidation.ts',
  'frontend/src/pages/dashboard/runtime/widgetDefinitions.ts',
  'frontend/scripts/dashboard-bar-orientation.test.mts',
];

const exactAllowedPaths = new Set([
  '.github/workflows/eks-image-delivery.yml',
  'AGENTS.md',
  'airflow/Dockerfile',
  'docs/02-architecture.md',
  'docs/04-development-guide.md',
  'docs/eks-ec2-recovery-release.md',
  'docs/system-guardrails.md',
  'frontend/package.json',
  ...exactDashboardFiles,
  'scripts/create-eks-image-receipt.mjs',
  'scripts/rollout-eks-recovery-release.sh',
  'scripts/test-eks-image-source-ref.sh',
  'scripts/verify-eks-image-receipt.mjs',
  'scripts/verify-eks-image-source-ref.sh',
  'scripts/verify-eks-recovery-release.mjs',
]);

const allowedPrefixes = [
  'infra/eks/',
];

const errors = [];
const fail = (message) => errors.push(message);

const git = (...args) => execFileSync('git', args, {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const gitExit = (...args) => spawnSync('git', args, {
  cwd: ROOT,
  stdio: 'ignore',
}).status ?? 1;

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const requireText = (path, snippets) => {
  const value = read(path);
  for (const snippet of snippets) {
    if (!value.includes(snippet)) fail(`${path} is missing required boundary: ${snippet}`);
  }
};

if (gitExit('merge-base', '--is-ancestor', BASE, 'HEAD') !== 0) {
  fail(`release must descend from the approved application base ${BASE}`);
}
for (const revision of FORBIDDEN_ANCESTORS) {
  if (gitExit('merge-base', '--is-ancestor', revision, 'HEAD') === 0) {
    fail(`forbidden broad merge revision is an ancestor of HEAD: ${revision}`);
  }
}

const backendTree = git('rev-parse', 'HEAD:backend');
if (backendTree !== EXPECTED_BACKEND_TREE) {
  fail(`backend tree drifted: expected ${EXPECTED_BACKEND_TREE}, got ${backendTree}`);
}
const jobsTree = git('rev-parse', 'HEAD:frontend/src/pages/ingest/jobs');
if (jobsTree !== EXPECTED_JOBS_TREE) {
  fail(`Jobs UI tree drifted: expected ${EXPECTED_JOBS_TREE}, got ${jobsTree}`);
}

const changed = new Set(
  git('diff', '--name-only', BASE, '--').split('\n').filter(Boolean),
);
const untracked = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter(Boolean);
for (const path of untracked) changed.add(path);

for (const path of [...changed].sort()) {
  const allowed = exactAllowedPaths.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
  if (!allowed) fail(`unapproved path changed from the recovery base: ${path}`);
  if (path.startsWith('backend/')) fail(`backend edits are forbidden: ${path}`);
  if (path.startsWith('deploy/')) fail(`legacy deploy edits are forbidden: ${path}`);
  if (path.startsWith('airflow/dags/')) fail(`DAG source edits are forbidden: ${path}`);
  if (/useJobController|frontend\/src\/pages\/ingest\/jobs\//.test(path)) {
    fail(`Jobs behavior edits are forbidden: ${path}`);
  }
}

for (const path of exactDashboardFiles) {
  const actual = git('hash-object', path);
  const expected = git('rev-parse', `${DASHBOARD_SOURCE}:${path}`);
  if (actual !== expected) {
    fail(`dashboard exception must exactly match ${DASHBOARD_SOURCE.slice(0, 8)}: ${path}`);
  }
}

const packageJson = JSON.parse(read('frontend/package.json'));
const basePackageJson = JSON.parse(git('show', `${BASE}:frontend/package.json`));
if (
  packageJson.scripts?.['test:dashboard-bar-orientation'] !==
  'node --experimental-strip-types --test scripts/dashboard-bar-orientation.test.mts'
) {
  fail('frontend/package.json is missing the exact horizontal-bar regression command');
}
const restoredPackageJson = structuredClone(packageJson);
delete restoredPackageJson.scripts['test:dashboard-bar-orientation'];
restoredPackageJson.scripts['verify:ui-regressions'] =
  restoredPackageJson.scripts['verify:ui-regressions']
    .replace(' && npm run test:dashboard-bar-orientation', '');
if (JSON.stringify(restoredPackageJson) !== JSON.stringify(basePackageJson)) {
  fail('frontend/package.json contains changes outside the horizontal-bar regression command');
}

requireText('infra/eks/images/ec2-recovery.Dockerfile', [
  'COPY backend/app ./app',
  'COPY --chown=185:185 backend/scripts /opt/asklake/scripts',
  '/opt/spark/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar',
  'com.asklake.release.profile="ec2-recovery-e6f86eb8"',
]);
requireText('infra/eks/images/ai-gateway.Dockerfile', [
  'COPY --chown=10001:10001 ai-server/app ./app',
  'USER 10001:10001',
  'com.asklake.release.profile="ec2-recovery-e6f86eb8"',
]);
requireText('infra/eks/images/ec2-recovery.Dockerfile.dockerignore', [
  '**',
  '!backend/**',
  '!infra/eks/images/spark-msk-iam-shaded.pom.xml',
]);
requireText('infra/eks/images/ai-gateway.Dockerfile.dockerignore', [
  '**',
  '!ai-server/app/**',
]);
requireText('infra/eks/helm/asklake-web/templates/backend.yaml', [
  '{name: CONTINUOUS_CONTROL_PLANE, value: "disabled"}',
]);
requireText('infra/eks/helm/asklake-workloads/templates/realtime-v1-worker.yaml', [
  'previous EC2 Kafka owner is fenced',
  '{name: CONTINUOUS_CONTROL_PLANE, value: "worker"}',
  '{name: CONTINUOUS_WORKER_OWNER, value: "eks-continuous-worker-v1"}',
  '{name: ASKLAKE_CONTINUOUS_SPARK_RUNNER, value: "kubernetes"}',
  'ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT',
  'ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET_NAME',
  '@{{ required "Spark image digest is required"',
]);
requireText('.github/workflows/eks-image-delivery.yml', [
  "release_profile:",
  "node scripts/verify-eks-recovery-release.mjs",
  "infra/eks/images/ec2-recovery.Dockerfile",
  '--build-arg ASKLAKE_BACKEND_TREE="$backend_tree"',
]);

const manifest = JSON.parse(read('infra/eks/delivery/ec2-recovery-release.json'));
if (manifest.applicationBaseRevision !== BASE) fail('recovery manifest base revision drifted');
if (manifest.protectedTrees?.backend !== EXPECTED_BACKEND_TREE) fail('recovery manifest backend tree drifted');
if (manifest.protectedTrees?.jobsUi !== EXPECTED_JOBS_TREE) fail('recovery manifest Jobs tree drifted');
if (manifest.runtimeBoundary?.webControlPlane !== 'disabled') fail('web control plane must be disabled');
if (manifest.runtimeBoundary?.continuousWorkerControlPlane !== 'worker') fail('worker control plane must be worker');
if (manifest.runtimeBoundary?.previousEc2OwnerMustRemainFenced !== true) {
  fail('previous EC2 owner fencing must be mandatory');
}

if (errors.length > 0) {
  console.error(`EKS EC2 recovery release verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS EC2 recovery release verification passed.');
console.log(`applicationBase=${BASE}`);
console.log(`backendTree=${backendTree}`);
console.log(`jobsUiTree=${jobsTree}`);
