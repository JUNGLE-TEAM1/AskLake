#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ZERO_SHA = "0".repeat(40);
const ZERO_HASH = "0".repeat(64);
const CREDENTIAL_PATTERN =
  /AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|(?:password|secret|token)\s*[:=]\s*[^,\s}]+/i;
const RAW_IDENTIFIER_KEYS = new Set([
  "runId",
  "jobId",
  "applicationName",
  "applicationUid",
  "snapshotId",
  "datasetId",
  "consumerGroup",
  "icebergTable",
  "outputPath",
  "checkpointPath",
  "fixtureBatchId",
  "podName",
  "nodeName",
  "ip",
  "endpoint",
  "arn",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function computeExecutionScopeHash(contract) {
  const {
    approval: _approval,
    createdAt: _createdAt,
    ...scope
  } = contract ?? {};
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(scope)))
    .digest("hex");
}

export function validatePrivateExecutionContractFile(path) {
  const errors = [];
  let realPath;
  let mode;
  try {
    realPath = realpathSync(path);
    mode = statSync(realPath).mode & 0o777;
  } catch (error) {
    return [`execution contract file is unavailable: ${error.message}`];
  }
  if (!realPath.startsWith("/private/tmp/")) {
    errors.push("execution contract file must be stored under /private/tmp");
  }
  if (mode !== 0o600) {
    errors.push("execution contract file must use mode 0600");
  }
  return errors;
}

export function validatePrivateExecutionContractOutputPath(path) {
  const errors = [];
  let realDirectory;
  try {
    realDirectory = realpathSync(dirname(resolve(path)));
  } catch (error) {
    return [`execution contract output directory is unavailable: ${error.message}`];
  }
  if (
    realDirectory !== "/private/tmp" &&
    !realDirectory.startsWith("/private/tmp/")
  ) {
    errors.push("execution contract output must be stored under /private/tmp");
  }
  return errors;
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = new Set(Object.keys(value));
  for (const key of expected) {
    if (!actual.has(key)) errors.push(`${label} is missing ${key}`);
  }
  for (const key of actual) {
    if (!expected.has(key)) errors.push(`${label} contains unapproved key ${key}`);
  }
}

function exactArray(value, expected, label, errors) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    errors.push(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function rawIdentifierPaths(value, path = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      rawIdentifierPaths(item, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(RAW_IDENTIFIER_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...rawIdentifierPaths(item, `${path}.${key}`),
  ]);
}

function isFullGitRevision(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requireBoolean(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${expected}`);
}

export function validateExecutionContract(contract, { execution = false } = {}) {
  const errors = [];
  exactKeys(
    contract,
    new Set([
      "contractVersion",
      "campaign",
      "environment",
      "createdAt",
      "baseRevision",
      "images",
      "targets",
      "actions",
      "capabilities",
      "capabilityEvidence",
      "safety",
      "cleanup",
      "evidence",
      "approval",
    ]),
    "contract",
    errors,
  );

  if (contract?.contractVersion !== "1.0") {
    errors.push("contractVersion must be 1.0");
  }
  if (contract?.campaign !== "eks-day18-resilience") {
    errors.push("campaign must be eks-day18-resilience");
  }
  if (contract?.environment !== "dev") {
    errors.push("environment must be dev");
  }
  if (!Number.isFinite(Date.parse(contract?.createdAt ?? ""))) {
    errors.push("createdAt must be an ISO-8601 timestamp");
  }
  if (!isFullGitRevision(contract?.baseRevision)) {
    errors.push("baseRevision must be a full Git SHA");
  }

  exactKeys(
    contract?.images,
    new Set(["current", "candidate", "rollback"]),
    "images",
    errors,
  );
  for (const name of ["current", "candidate", "rollback"]) {
    const image = contract?.images?.[name];
    exactKeys(
      image,
      new Set(["gitRevision", "receiptSha256"]),
      `images.${name}`,
      errors,
    );
    if (!isFullGitRevision(image?.gitRevision)) {
      errors.push(`images.${name}.gitRevision must be a full Git SHA`);
    }
    if (!isSha256(image?.receiptSha256)) {
      errors.push(`images.${name}.receiptSha256 must be a SHA-256`);
    }
  }

  exactKeys(
    contract?.targets,
    new Set(["workloadAliases", "boundedRuns", "faultRuns"]),
    "targets",
    errors,
  );
  exactArray(
    contract?.targets?.workloadAliases,
    ["Frontend", "FastAPI"],
    "targets.workloadAliases",
    errors,
  );
  exactArray(
    contract?.targets?.boundedRuns,
    ["Run A", "Run B", "Run C"],
    "targets.boundedRuns",
    errors,
  );
  exactArray(
    contract?.targets?.faultRuns,
    ["Run D", "Run E"],
    "targets.faultRuns",
    errors,
  );

  const requiredActions = [
    "podRecovery",
    "rollingUpdate",
    "rollback",
    "mskAuthorizationFailure",
    "sparkDriverOrExecutorFailure",
    "boundedE2EThreeConsecutive",
    "duplicateCatalogVerification",
    "cleanup",
  ];
  const forbiddenActions = [
    "repeatDay17Autoscaling",
    "performanceLoad",
    "ec2RollbackExecution",
  ];
  exactKeys(
    contract?.actions,
    new Set([...requiredActions, ...forbiddenActions]),
    "actions",
    errors,
  );
  for (const key of requiredActions) {
    requireBoolean(contract?.actions?.[key], true, `actions.${key}`, errors);
  }
  for (const key of forbiddenActions) {
    requireBoolean(contract?.actions?.[key], false, `actions.${key}`, errors);
  }

  exactKeys(
    contract?.capabilities,
    new Set([
      "mskFaultUsesPersistedRun",
      "sparkTerminalRetrySupported",
    ]),
    "capabilities",
    errors,
  );
  for (const key of [
    "mskFaultUsesPersistedRun",
    "sparkTerminalRetrySupported",
  ]) {
    if (typeof contract?.capabilities?.[key] !== "boolean") {
      errors.push(`capabilities.${key} must be a boolean`);
    }
  }
  exactKeys(
    contract?.capabilityEvidence,
    new Set([
      "state",
      "implementationRevision",
      "proofManifestSha256",
    ]),
    "capabilityEvidence",
    errors,
  );
  if (!["pending", "verified"].includes(contract?.capabilityEvidence?.state)) {
    errors.push("capabilityEvidence.state must be pending or verified");
  }
  if (!isFullGitRevision(contract?.capabilityEvidence?.implementationRevision)) {
    errors.push("capabilityEvidence.implementationRevision must be a full Git SHA");
  }
  if (!isSha256(contract?.capabilityEvidence?.proofManifestSha256)) {
    errors.push("capabilityEvidence.proofManifestSha256 must be a SHA-256");
  }

  exactKeys(
    contract?.safety,
    new Set([
      "minimumFastApiReady",
      "immutableImagesOnly",
      "platform",
      "autoRollbackOnUnexpectedHealthFailure",
      "autoRollbackOnReadyFloorBreach",
      "stopOnScopeMismatch",
      "allowIamExpansion",
      "allowRbacExpansion",
      "allowNodePoolMutation",
      "allowContinuousMutation",
      "allowDummyImage",
    ]),
    "safety",
    errors,
  );
  if (contract?.safety?.minimumFastApiReady !== 2) {
    errors.push("safety.minimumFastApiReady must be 2");
  }
  if (contract?.safety?.platform !== "linux/amd64") {
    errors.push("safety.platform must be linux/amd64");
  }
  for (const key of [
    "immutableImagesOnly",
    "autoRollbackOnUnexpectedHealthFailure",
    "autoRollbackOnReadyFloorBreach",
    "stopOnScopeMismatch",
  ]) {
    requireBoolean(contract?.safety?.[key], true, `safety.${key}`, errors);
  }
  for (const key of [
    "allowIamExpansion",
    "allowRbacExpansion",
    "allowNodePoolMutation",
    "allowContinuousMutation",
    "allowDummyImage",
  ]) {
    requireBoolean(contract?.safety?.[key], false, `safety.${key}`, errors);
  }

  const cleanupKeys = [
    "temporaryJobsZero",
    "temporaryPodsZero",
    "temporaryConfigMapsZero",
    "temporarySecretsZero",
    "localProcessesZero",
    "hpaReturnsToMinimum",
    "sparkNodesReturnToBaseline",
    "preserveDurableResults",
  ];
  exactKeys(contract?.cleanup, new Set(cleanupKeys), "cleanup", errors);
  for (const key of cleanupKeys) {
    requireBoolean(contract?.cleanup?.[key], true, `cleanup.${key}`, errors);
  }

  exactKeys(
    contract?.evidence,
    new Set([
      "directory",
      "fileMode",
      "aliasesOnly",
      "collectFaultWindowOnly",
    ]),
    "evidence",
    errors,
  );
  if (contract?.evidence?.directory !== "/private/tmp") {
    errors.push("evidence.directory must be /private/tmp");
  }
  if (contract?.evidence?.fileMode !== "0600") {
    errors.push("evidence.fileMode must be 0600");
  }
  requireBoolean(
    contract?.evidence?.aliasesOnly,
    true,
    "evidence.aliasesOnly",
    errors,
  );
  requireBoolean(
    contract?.evidence?.collectFaultWindowOnly,
    true,
    "evidence.collectFaultWindowOnly",
    errors,
  );

  exactKeys(
    contract?.approval,
    new Set(["state", "approvedAt", "scopeHash"]),
    "approval",
    errors,
  );
  if (!["pending", "approved"].includes(contract?.approval?.state)) {
    errors.push("approval.state must be pending or approved");
  }

  if (execution) {
    const imageEntries = ["current", "candidate", "rollback"].map(
      (name) => contract?.images?.[name] ?? {},
    );
    if (contract?.baseRevision === ZERO_SHA) {
      errors.push("execution contract baseRevision cannot use the template value");
    }
    for (const [index, name] of ["current", "candidate", "rollback"].entries()) {
      if (imageEntries[index].gitRevision === ZERO_SHA) {
        errors.push(`execution contract images.${name}.gitRevision is unresolved`);
      }
      if (imageEntries[index].receiptSha256 === ZERO_HASH) {
        errors.push(`execution contract images.${name}.receiptSha256 is unresolved`);
      }
    }
    if (
      contract?.images?.candidate?.gitRevision ===
      contract?.images?.rollback?.gitRevision
    ) {
      errors.push("candidate and rollback Git revisions must differ");
    }
    if (
      contract?.images?.candidate?.receiptSha256 ===
      contract?.images?.rollback?.receiptSha256
    ) {
      errors.push("candidate and rollback image receipt hashes must differ");
    }
    if (contract?.approval?.state !== "approved") {
      errors.push("execution contract approval.state must be approved");
    }
    if (!Number.isFinite(Date.parse(contract?.approval?.approvedAt ?? ""))) {
      errors.push("execution contract approval.approvedAt must be an ISO timestamp");
    }
    if (
      !isSha256(contract?.approval?.scopeHash) ||
      contract?.approval?.scopeHash === ZERO_HASH
    ) {
      errors.push("execution contract approval.scopeHash must be resolved");
    } else {
      const expectedScopeHash = computeExecutionScopeHash(contract);
      if (contract?.approval?.scopeHash !== expectedScopeHash) {
        errors.push("execution contract approval.scopeHash does not match the canonical scope");
      }
    }
    for (const key of [
      "mskFaultUsesPersistedRun",
      "sparkTerminalRetrySupported",
    ]) {
      if (contract?.capabilities?.[key] !== true) {
        errors.push(`execution contract capabilities.${key} must be true`);
      }
    }
    if (contract?.capabilityEvidence?.state !== "verified") {
      errors.push("execution contract capabilityEvidence.state must be verified");
    }
    if (contract?.capabilityEvidence?.implementationRevision === ZERO_SHA) {
      errors.push(
        "execution contract capabilityEvidence.implementationRevision is unresolved",
      );
    }
    if (contract?.capabilityEvidence?.proofManifestSha256 === ZERO_HASH) {
      errors.push(
        "execution contract capabilityEvidence.proofManifestSha256 is unresolved",
      );
    }
  } else {
    if (contract?.approval?.state !== "pending") {
      errors.push("template approval.state must remain pending");
    }
    if (contract?.approval?.approvedAt !== null) {
      errors.push("template approval.approvedAt must be null");
    }
    if (contract?.approval?.scopeHash !== null) {
      errors.push("template approval.scopeHash must be null");
    }
    if (
      contract?.capabilityEvidence?.state !== "pending" &&
      contract?.capabilityEvidence?.state !== "verified"
    ) {
      errors.push("template capabilityEvidence.state must be pending or verified");
    }
  }

  const rawPaths = rawIdentifierPaths(contract);
  if (rawPaths.length > 0) {
    errors.push(`raw identifier keys are forbidden: ${rawPaths.join(", ")}`);
  }
  if (CREDENTIAL_PATTERN.test(JSON.stringify(contract))) {
    errors.push("credential-like content is forbidden");
  }
  return errors;
}

export function parseArguments(argv) {
  if (argv.length !== 2 || !["--template", "--execution"].includes(argv[0])) {
    throw new Error(
      "usage: verify-eks-day18-execution-contract.mjs --template|--execution <contract.json>",
    );
  }
  return {
    execution: argv[0] === "--execution",
    path: resolve(process.cwd(), argv[1]),
  };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  let contract;
  try {
    contract = JSON.parse(readFileSync(options.path, "utf8"));
  } catch (error) {
    console.error(`Unable to read Day 18 execution contract: ${error.message}`);
    process.exit(1);
  }
  const errors = [
    ...(options.execution
      ? validatePrivateExecutionContractFile(options.path)
      : []),
    ...validateExecutionContract(contract, options),
  ];
  if (errors.length > 0) {
    console.error(`Day 18 execution contract verification failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Day 18 ${options.execution ? "execution" : "template"} contract verification passed.`,
  );
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
