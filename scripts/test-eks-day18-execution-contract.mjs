import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { prepareExecutionContract } from "./prepare-eks-day18-execution-contract.mjs";
import {
  computeExecutionScopeHash,
  parseArguments,
  validateExecutionContract,
  validatePrivateExecutionContractFile,
} from "./verify-eks-day18-execution-contract.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fixture() {
  const contract = {
    contractVersion: "1.0",
    campaign: "eks-day18-resilience",
    environment: "dev",
    createdAt: "2026-07-18T00:00:00.000Z",
    baseRevision: SHA_A,
    images: {
      current: { gitRevision: SHA_A, receiptSha256: HASH_A },
      candidate: { gitRevision: SHA_B, receiptSha256: HASH_B },
      rollback: { gitRevision: SHA_A, receiptSha256: HASH_A },
    },
    targets: {
      workloadAliases: ["Frontend", "FastAPI"],
      boundedRuns: ["Run A", "Run B", "Run C"],
      faultRuns: ["Run D", "Run E"],
    },
    actions: {
      podRecovery: true,
      rollingUpdate: true,
      rollback: true,
      mskAuthorizationFailure: true,
      sparkDriverOrExecutorFailure: true,
      boundedE2EThreeConsecutive: true,
      duplicateCatalogVerification: true,
      cleanup: true,
      repeatDay17Autoscaling: false,
      performanceLoad: false,
      ec2RollbackExecution: false,
    },
    capabilities: {
      mskFaultUsesPersistedRun: true,
      sparkTerminalRetrySupported: true,
    },
    capabilityEvidence: {
      state: "verified",
      implementationRevision: SHA_A,
      proofManifestSha256: HASH_A,
    },
    liveInputEvidence: {
      state: "verified",
      inputSha256: HASH_A,
      targetSelectionSha256: HASH_B,
    },
    safety: {
      minimumFastApiReady: 2,
      immutableImagesOnly: true,
      platform: "linux/amd64",
      autoRollbackOnUnexpectedHealthFailure: true,
      autoRollbackOnReadyFloorBreach: true,
      stopOnScopeMismatch: true,
      allowIamExpansion: false,
      allowRbacExpansion: false,
      allowNodePoolMutation: false,
      allowContinuousMutation: false,
      allowDummyImage: false,
    },
    cleanup: {
      temporaryJobsZero: true,
      temporaryPodsZero: true,
      temporaryConfigMapsZero: true,
      temporarySecretsZero: true,
      localProcessesZero: true,
      hpaReturnsToMinimum: true,
      sparkNodesReturnToBaseline: true,
      preserveDurableResults: true,
    },
    evidence: {
      directory: "/private/tmp",
      fileMode: "0600",
      aliasesOnly: true,
      collectFaultWindowOnly: true,
    },
    approval: {
      state: "approved",
      approvedAt: "2026-07-18T00:01:00.000Z",
      scopeHash: null,
    },
  };
  contract.approval.scopeHash = computeExecutionScopeHash(contract);
  return contract;
}

test("accepts the complete approved execution contract", () => {
  assert.deepEqual(
    validateExecutionContract(fixture(), { execution: true }),
    [],
  );
});

test("fails closed for pending approval or unresolved image bindings", () => {
  const input = fixture();
  input.approval = { state: "pending", approvedAt: null, scopeHash: null };
  input.images.candidate = {
    gitRevision: "0".repeat(40),
    receiptSha256: "0".repeat(64),
  };
  const errors = validateExecutionContract(input, { execution: true });
  assert.ok(errors.some((error) => error.includes("approval.state")));
  assert.ok(errors.some((error) => error.includes("candidate.gitRevision")));
  assert.ok(errors.some((error) => error.includes("candidate.receiptSha256")));
});

test("rejects an arbitrary approval hash and missing fault capabilities", () => {
  const input = fixture();
  input.approval.scopeHash = HASH_B;
  input.capabilities.mskFaultUsesPersistedRun = false;
  input.capabilities.sparkTerminalRetrySupported = false;
  input.capabilityEvidence = {
    state: "pending",
    implementationRevision: "0".repeat(40),
    proofManifestSha256: "0".repeat(64),
  };
  input.liveInputEvidence = {
    state: "pending",
    inputSha256: "0".repeat(64),
    targetSelectionSha256: "0".repeat(64),
  };
  const errors = validateExecutionContract(input, { execution: true });
  assert.ok(errors.some((error) => error.includes("canonical scope")));
  assert.ok(
    errors.some((error) => error.includes("mskFaultUsesPersistedRun must be true")),
  );
  assert.ok(
    errors.some((error) => error.includes("sparkTerminalRetrySupported must be true")),
  );
  assert.ok(errors.some((error) => error.includes("capabilityEvidence.state")));
  assert.ok(
    errors.some((error) =>
      error.includes("capabilityEvidence.implementationRevision"),
    ),
  );
});

test("canonical scope hash changes with scope but ignores approval metadata", () => {
  const input = fixture();
  const original = computeExecutionScopeHash(input);
  input.approval.approvedAt = "2026-07-18T00:02:00.000Z";
  input.approval.scopeHash = "f".repeat(64);
  assert.equal(computeExecutionScopeHash(input), original);
  input.safety.allowIamExpansion = true;
  assert.notEqual(computeExecutionScopeHash(input), original);
});

test("rejects dummy rollback, scope expansion, and repeated autoscaling", () => {
  const input = fixture();
  input.images.candidate = { ...input.images.rollback };
  input.safety.allowIamExpansion = true;
  input.actions.repeatDay17Autoscaling = true;
  const errors = validateExecutionContract(input, { execution: true });
  assert.ok(errors.some((error) => error.includes("candidate and rollback")));
  assert.ok(errors.some((error) => error.includes("allowIamExpansion")));
  assert.ok(errors.some((error) => error.includes("repeatDay17Autoscaling")));
});

test("rejects raw identifiers, credentials, and changed run aliases", () => {
  const input = fixture();
  input.runId = "raw-run";
  input.targets.faultRuns = ["Run D", "Run X"];
  input.note = "aws_secret_access_key=private";
  const errors = validateExecutionContract(input, { execution: true });
  assert.ok(errors.some((error) => error.includes("unapproved key")));
  assert.ok(errors.some((error) => error.includes("raw identifier keys")));
  assert.ok(errors.some((error) => error.includes("credential-like")));
  assert.ok(errors.some((error) => error.includes("targets.faultRuns")));
});

test("requires an explicit CLI mode", () => {
  assert.deepEqual(parseArguments(["--execution", "contract.json"]), {
    execution: true,
    path: join(process.cwd(), "contract.json"),
  });
  assert.throws(() => parseArguments(["contract.json"]), /usage/);
});

test("prepares a private pending contract without overwriting", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-contract-"));
  const output = join(directory, "contract.json");
  await prepareExecutionContract({
    output,
    baseRevision: SHA_A,
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  const prepared = JSON.parse(await readFile(output, "utf8"));
  assert.equal(prepared.baseRevision, SHA_A);
  assert.equal(prepared.approval.state, "pending");
  assert.equal(prepared.capabilities.mskFaultUsesPersistedRun, false);
  assert.equal(prepared.capabilities.sparkTerminalRetrySupported, false);
  assert.equal(prepared.capabilityEvidence.state, "pending");
  assert.equal(prepared.liveInputEvidence.state, "pending");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(
    prepareExecutionContract({
      output,
      baseRevision: SHA_A,
      createdAt: "2026-07-18T00:00:00.000Z",
    }),
    /EEXIST/,
  );
});

test("execution contract must remain in a private temporary 0600 file", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-private-"));
  const output = join(directory, "contract.json");
  await writeFile(output, "{}\n", { mode: 0o600 });
  assert.deepEqual(validatePrivateExecutionContractFile(output), []);
  await chmod(output, 0o644);
  assert.ok(
    validatePrivateExecutionContractFile(output).some((error) =>
      error.includes("0600"),
    ),
  );
});

test("pending contract preparation rejects tracked output paths", async () => {
  await assert.rejects(
    prepareExecutionContract({
      output: "/day18-contract-must-not-be-created.json",
      baseRevision: SHA_A,
      createdAt: "2026-07-18T00:00:00.000Z",
    }),
    /under \/private\/tmp/,
  );
});
