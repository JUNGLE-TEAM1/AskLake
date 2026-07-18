import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  approveExecutionContract,
  parseArguments as parseApprovalArguments,
} from "./approve-eks-day18-execution-contract.mjs";
import {
  bindExecutionContract,
  parseArguments as parseBindingArguments,
} from "./bind-eks-day18-execution-contract.mjs";
import { prepareExecutionContract } from "./prepare-eks-day18-execution-contract.mjs";
import {
  computeExecutionScopeHash,
  validateExecutionContract,
} from "./verify-eks-day18-execution-contract.mjs";

const ROOT_DIR = new URL("..", import.meta.url).pathname;

function gitRevision(ref) {
  return execFileSync("git", ["-C", ROOT_DIR, "rev-parse", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
}

function imageReceipt(revision, digestCharacter) {
  const registry =
    "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/dev";
  const digest = `sha256:${digestCharacter.repeat(64)}`;
  return {
    contractVersion: "1.0",
    environment: "dev",
    gitRevision: revision,
    platform: "linux/amd64",
    images: {
      frontend: `${registry}/frontend@${digest}`,
      backend: `${registry}/backend@${digest}`,
      airflow: `${registry}/airflow@${digest}`,
      sparkRuntime: `${registry}/spark-runtime@${digest}`,
      trino: `${registry}/trino@${digest}`,
    },
    upstreamImages: {
      airflow: "apache/airflow:3.3.0",
      trino: "trinodb/trino:482",
    },
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

function liveInput() {
  const bounded = ["Run A", "Run B", "Run C"].map((alias, index) => ({
    alias,
    jobId: `job-${index + 1}`,
    datasetId: `dataset-${index + 1}`,
    fixtureBatchId: "fixture-batch-shared",
    consumerGroup: `consumer-group-${index + 1}`,
    icebergTable: `iceberg_table_${index + 1}`,
    expectedCount: 100,
  }));
  const faults = [
    {
      ...bounded[0],
      alias: "Run D",
      sourceAlias: "Run A",
      failure: "mskAuthorization",
    },
    {
      ...bounded[1],
      alias: "Run E",
      sourceAlias: "Run B",
      failure: "sparkTerminal",
    },
  ];
  return {
    contractVersion: "1.0",
    campaign: "eks-day18-resilience",
    environment: "dev",
    createdAt: "2026-07-18T00:00:00.000Z",
    cluster: {
      name: "asklake-dev",
      namespace: "asklake-dev",
      region: "ap-northeast-2",
    },
    preservedEc2: {
      instanceId: "i-0123456789abcdef0",
      envFileSha256: "c".repeat(64),
    },
    visibility: {
      mode: "in-cluster-backend-service-account",
      sparkApplicationsReadable: true,
    },
    baseline: {
      activeFixtureRuns: 0,
      activeSparkApplications: 0,
      activeKubernetesJobs: 0,
      pendingOrTerminatingPods: 0,
      fastApiReady: 2,
      collectorReady: 1,
      hpaCurrent: 2,
      hpaDesired: 2,
      continuousActive: 0,
    },
    checks: {
      fastApiImageMatchesReceipt: true,
      collectorImageMatchesReceipt: true,
      externalHealthSteady: true,
      airflowConfigured: true,
      mskDenyServiceAccountPresent: true,
      driverDeleteAllowed: true,
      continuousBoundaryVerified: true,
    },
    targets: { bounded, faults },
  };
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("binds verified receipts to the selected base without manual hashes", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-bind-"));
  const pendingPath = join(directory, "pending.json");
  const boundPath = join(directory, "bound.json");
  const currentPath = join(directory, "current.json");
  const candidatePath = join(directory, "candidate.json");
  const rollbackPath = join(directory, "rollback.json");
  const candidateRevision = gitRevision("HEAD");
  const parentLine = execFileSync(
    "git",
    ["-C", ROOT_DIR, "rev-list", "--parents", "-n", "1", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/);
  const rollbackRevision = parentLine[1] ?? candidateRevision;

  await prepareExecutionContract({
    output: pendingPath,
    baseRevision: candidateRevision,
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  const rollbackReceipt = imageReceipt(rollbackRevision, "a");
  await writePrivateJson(currentPath, rollbackReceipt);
  await writePrivateJson(rollbackPath, rollbackReceipt);
  await writePrivateJson(
    candidatePath,
    imageReceipt(candidateRevision, "b"),
  );

  const { contract } = await bindExecutionContract({
    input: pendingPath,
    output: boundPath,
    currentReceipt: currentPath,
    candidateReceipt: candidatePath,
    rollbackReceipt: rollbackPath,
    baseRef: candidateRevision,
    requiredMergedRefs: [candidateRevision],
    createdAt: "2026-07-18T00:01:00.000Z",
  });
  assert.equal(contract.baseRevision, candidateRevision);
  assert.equal(contract.images.candidate.gitRevision, candidateRevision);
  assert.equal(contract.images.rollback.gitRevision, rollbackRevision);
  assert.equal(contract.approval.state, "pending");
  assert.equal((await stat(boundPath)).mode & 0o777, 0o600);
});

test("binding derives capability proof and approval rejects manual tampering", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-approve-"));
  const pendingPath = join(directory, "pending.json");
  const boundPath = join(directory, "bound.json");
  const tamperedPath = join(directory, "tampered.json");
  const approvedPath = join(directory, "approved.json");
  const currentPath = join(directory, "current.json");
  const candidatePath = join(directory, "candidate.json");
  const rollbackPath = join(directory, "rollback.json");
  const liveInputPath = join(directory, "live-input.json");
  const revision = gitRevision("HEAD");
  const rollbackRevision = gitRevision("HEAD^");
  await prepareExecutionContract({
    output: pendingPath,
    baseRevision: revision,
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  const rollbackReceipt = imageReceipt(rollbackRevision, "a");
  await writePrivateJson(currentPath, rollbackReceipt);
  await writePrivateJson(rollbackPath, rollbackReceipt);
  await writePrivateJson(candidatePath, imageReceipt(revision, "b"));
  await writePrivateJson(liveInputPath, liveInput());
  await bindExecutionContract({
    input: pendingPath,
    output: boundPath,
    currentReceipt: currentPath,
    candidateReceipt: candidatePath,
    rollbackReceipt: rollbackPath,
    baseRef: revision,
    requiredMergedRefs: [revision],
    createdAt: "2026-07-18T00:01:00.000Z",
  });

  const bound = JSON.parse(await readFile(boundPath, "utf8"));
  assert.deepEqual(bound.capabilities, {
    mskFaultUsesPersistedRun: true,
    sparkTerminalRetrySupported: true,
  });
  assert.equal(bound.capabilityEvidence.state, "verified");
  const tampered = structuredClone(bound);
  tampered.capabilities.mskFaultUsesPersistedRun = false;
  await writePrivateJson(tamperedPath, tampered);
  await assert.rejects(
    approveExecutionContract({
      input: tamperedPath,
      output: approvedPath,
      confirmation: "approve-eks-day18-resilience-scope",
      currentReceipt: currentPath,
      candidateReceipt: candidatePath,
      rollbackReceipt: rollbackPath,
      liveInput: liveInputPath,
      baseRef: revision,
      requiredMergedRefs: [revision],
    }),
    /does not match the verified Git base, image receipts, and capability proof/,
  );

  const { contract } = await approveExecutionContract({
    input: boundPath,
    output: approvedPath,
    confirmation: "approve-eks-day18-resilience-scope",
    currentReceipt: currentPath,
    candidateReceipt: candidatePath,
    rollbackReceipt: rollbackPath,
    liveInput: liveInputPath,
    baseRef: revision,
    requiredMergedRefs: [revision],
    approvedAt: "2026-07-18T00:02:00.000Z",
  });
  assert.equal(contract.approval.scopeHash, computeExecutionScopeHash(contract));
  assert.equal(contract.liveInputEvidence.state, "verified");
  assert.deepEqual(
    validateExecutionContract(contract, { execution: true }),
    [],
  );
  assert.equal((await stat(approvedPath)).mode & 0o777, 0o600);
});

test("binding and approval CLIs reject ambiguous arguments", () => {
  assert.deepEqual(
    parseBindingArguments([
      "--base-ref",
      "origin/pair1",
      "--require-merged-ref",
      "abc",
    ]),
    {
      baseRef: "origin/pair1",
      requiredMergedRefs: ["abc"],
    },
  );
  assert.deepEqual(
    parseApprovalArguments([
      "--input",
      "/private/tmp/in.json",
      "--output",
      "/private/tmp/out.json",
      "--confirm",
      "approve-eks-day18-resilience-scope",
      "--current-receipt",
      "/private/tmp/current.json",
      "--candidate-receipt",
      "/private/tmp/candidate.json",
      "--rollback-receipt",
      "/private/tmp/rollback.json",
      "--live-input",
      "/private/tmp/live-input.json",
      "--base-ref",
      "origin/pair1",
      "--require-merged-ref",
      "abc",
    ]),
    {
      baseRef: "origin/pair1",
      requiredMergedRefs: ["abc"],
      input: "/private/tmp/in.json",
      output: "/private/tmp/out.json",
      confirmation: "approve-eks-day18-resilience-scope",
      currentReceipt: "/private/tmp/current.json",
      candidateReceipt: "/private/tmp/candidate.json",
      rollbackReceipt: "/private/tmp/rollback.json",
      liveInput: "/private/tmp/live-input.json",
    },
  );
  assert.throws(() => parseBindingArguments(["--unknown", "value"]));
  assert.throws(() => parseApprovalArguments(["--unknown", "value"]));
});
