#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUN_ALIASES = ["Run A", "Run B", "Run C"];
const FAULT_ALIASES = ["Run D", "Run E"];
const TARGET_KEYS = new Set([
  "alias",
  "jobId",
  "datasetId",
  "fixtureBatchId",
  "consumerGroup",
  "icebergTable",
  "expectedCount",
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function requireString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requireBoolean(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${expected}`);
}

function requireNumber(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} must be ${expected}`);
}

function validateTarget(target, alias, label, errors) {
  exactKeys(target, TARGET_KEYS, label, errors);
  if (target?.alias !== alias) errors.push(`${label}.alias must be ${alias}`);
  for (const key of [
    "jobId",
    "datasetId",
    "fixtureBatchId",
    "consumerGroup",
    "icebergTable",
  ]) {
    requireString(target?.[key], `${label}.${key}`, errors);
  }
  requireNumber(target?.expectedCount, 100, `${label}.expectedCount`, errors);
}

export function computeTargetSelectionHash(liveInput) {
  return sha256(JSON.stringify(canonicalize(liveInput?.targets ?? null)));
}

export function validatePrivateLiveInputFile(path) {
  const errors = [];
  let realPath;
  let mode;
  try {
    realPath = realpathSync(path);
    mode = statSync(realPath).mode & 0o777;
  } catch (error) {
    return [`live input file is unavailable: ${error.message}`];
  }
  if (!realPath.startsWith("/private/tmp/")) {
    errors.push("live input file must be stored under /private/tmp");
  }
  if (mode !== 0o600) errors.push("live input file must use mode 0600");
  return errors;
}

export function validateDay18LiveInput(liveInput) {
  const errors = [];
  exactKeys(
    liveInput,
    new Set([
      "contractVersion",
      "campaign",
      "environment",
      "createdAt",
      "cluster",
      "preservedEc2",
      "visibility",
      "baseline",
      "checks",
      "targets",
    ]),
    "liveInput",
    errors,
  );
  if (liveInput?.contractVersion !== "1.0") {
    errors.push("liveInput.contractVersion must be 1.0");
  }
  if (liveInput?.campaign !== "eks-day18-resilience") {
    errors.push("liveInput.campaign must be eks-day18-resilience");
  }
  if (liveInput?.environment !== "dev") {
    errors.push("liveInput.environment must be dev");
  }
  if (!Number.isFinite(Date.parse(liveInput?.createdAt ?? ""))) {
    errors.push("liveInput.createdAt must be an ISO-8601 timestamp");
  }

  exactKeys(
    liveInput?.cluster,
    new Set(["name", "namespace", "region"]),
    "liveInput.cluster",
    errors,
  );
  if (
    typeof liveInput?.cluster?.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(liveInput.cluster.name)
  ) {
    errors.push("liveInput.cluster.name is invalid");
  }
  if (liveInput?.cluster?.namespace !== "asklake-dev") {
    errors.push("liveInput.cluster.namespace must be asklake-dev");
  }
  if (liveInput?.cluster?.region !== "ap-northeast-2") {
    errors.push("liveInput.cluster.region must be ap-northeast-2");
  }

  exactKeys(
    liveInput?.preservedEc2,
    new Set(["instanceId", "envFileSha256"]),
    "liveInput.preservedEc2",
    errors,
  );
  if (
    typeof liveInput?.preservedEc2?.instanceId !== "string" ||
    !/^i-[a-f0-9]{8,17}$/.test(liveInput.preservedEc2.instanceId)
  ) {
    errors.push("liveInput.preservedEc2.instanceId is invalid");
  }
  if (
    typeof liveInput?.preservedEc2?.envFileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(liveInput.preservedEc2.envFileSha256)
  ) {
    errors.push("liveInput.preservedEc2.envFileSha256 must be a SHA-256");
  }

  exactKeys(
    liveInput?.visibility,
    new Set(["mode", "sparkApplicationsReadable"]),
    "liveInput.visibility",
    errors,
  );
  if (
    liveInput?.visibility?.mode !== "in-cluster-backend-service-account"
  ) {
    errors.push(
      "liveInput.visibility.mode must be in-cluster-backend-service-account",
    );
  }
  requireBoolean(
    liveInput?.visibility?.sparkApplicationsReadable,
    true,
    "liveInput.visibility.sparkApplicationsReadable",
    errors,
  );

  exactKeys(
    liveInput?.baseline,
    new Set([
      "activeFixtureRuns",
      "activeSparkApplications",
      "activeKubernetesJobs",
      "pendingOrTerminatingPods",
      "fastApiReady",
      "collectorReady",
      "hpaCurrent",
      "hpaDesired",
      "continuousActive",
    ]),
    "liveInput.baseline",
    errors,
  );
  for (const key of [
    "activeFixtureRuns",
    "activeSparkApplications",
    "activeKubernetesJobs",
    "pendingOrTerminatingPods",
    "continuousActive",
  ]) {
    requireNumber(liveInput?.baseline?.[key], 0, `liveInput.baseline.${key}`, errors);
  }
  requireNumber(liveInput?.baseline?.fastApiReady, 2, "liveInput.baseline.fastApiReady", errors);
  requireNumber(liveInput?.baseline?.collectorReady, 1, "liveInput.baseline.collectorReady", errors);
  requireNumber(liveInput?.baseline?.hpaCurrent, 2, "liveInput.baseline.hpaCurrent", errors);
  requireNumber(liveInput?.baseline?.hpaDesired, 2, "liveInput.baseline.hpaDesired", errors);

  exactKeys(
    liveInput?.checks,
    new Set([
      "fastApiImageMatchesReceipt",
      "collectorImageMatchesReceipt",
      "externalHealthSteady",
      "airflowConfigured",
      "mskDenyServiceAccountPresent",
      "driverDeleteAllowed",
      "continuousBoundaryVerified",
    ]),
    "liveInput.checks",
    errors,
  );
  for (const key of [
    "fastApiImageMatchesReceipt",
    "collectorImageMatchesReceipt",
    "externalHealthSteady",
    "airflowConfigured",
    "mskDenyServiceAccountPresent",
    "driverDeleteAllowed",
    "continuousBoundaryVerified",
  ]) {
    requireBoolean(liveInput?.checks?.[key], true, `liveInput.checks.${key}`, errors);
  }

  exactKeys(
    liveInput?.targets,
    new Set(["bounded", "faults"]),
    "liveInput.targets",
    errors,
  );
  if (!Array.isArray(liveInput?.targets?.bounded) || liveInput.targets.bounded.length !== 3) {
    errors.push("liveInput.targets.bounded must contain exactly 3 entries");
  } else {
    liveInput.targets.bounded.forEach((target, index) =>
      validateTarget(target, RUN_ALIASES[index], `liveInput.targets.bounded[${index}]`, errors),
    );
  }
  if (!Array.isArray(liveInput?.targets?.faults) || liveInput.targets.faults.length !== 2) {
    errors.push("liveInput.targets.faults must contain exactly 2 entries");
  } else {
    liveInput.targets.faults.forEach((fault, index) => {
      exactKeys(
        fault,
        new Set([...TARGET_KEYS, "sourceAlias", "failure"]),
        `liveInput.targets.faults[${index}]`,
        errors,
      );
      validateTarget(
        Object.fromEntries(
          Object.entries(fault ?? {}).filter(([key]) => TARGET_KEYS.has(key)),
        ),
        FAULT_ALIASES[index],
        `liveInput.targets.faults[${index}]`,
        errors,
      );
      const expectedSource = RUN_ALIASES[index];
      const expectedFailure = ["mskAuthorization", "sparkTerminal"][index];
      if (fault?.sourceAlias !== expectedSource) {
        errors.push(`liveInput.targets.faults[${index}].sourceAlias must be ${expectedSource}`);
      }
      if (fault?.failure !== expectedFailure) {
        errors.push(`liveInput.targets.faults[${index}].failure must be ${expectedFailure}`);
      }
      const source = liveInput?.targets?.bounded?.[index];
      if (source) {
        for (const key of TARGET_KEYS) {
          if (key !== "alias" && fault?.[key] !== source?.[key]) {
            errors.push(
              `liveInput.targets.faults[${index}].${key} must match ${expectedSource}`,
            );
          }
        }
      }
    });
  }

  const bounded = Array.isArray(liveInput?.targets?.bounded)
    ? liveInput.targets.bounded
    : [];
  for (const key of ["jobId", "datasetId", "consumerGroup", "icebergTable"]) {
    const values = bounded.map((target) => target?.[key]).filter(Boolean);
    if (values.length !== 3 || new Set(values).size !== 3) {
      errors.push(`liveInput.targets.bounded ${key} values must be 3/3 unique`);
    }
  }
  const batches = bounded.map((target) => target?.fixtureBatchId).filter(Boolean);
  if (batches.length !== 3 || new Set(batches).size !== 1) {
    errors.push("liveInput.targets.bounded fixtureBatchId must be shared by all 3 entries");
  }
  return errors;
}

export function loadAndVerifyDay18LiveInput(path) {
  const fileErrors = validatePrivateLiveInputFile(path);
  let bytes;
  let liveInput;
  try {
    bytes = readFileSync(path);
    liveInput = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`unable to read Day 18 live input: ${error.message}`);
  }
  const errors = [...fileErrors, ...validateDay18LiveInput(liveInput)];
  if (errors.length > 0) {
    throw new Error(`Day 18 live input verification failed: ${errors.join("; ")}`);
  }
  return {
    liveInput,
    inputSha256: sha256(bytes),
    targetSelectionSha256: computeTargetSelectionHash(liveInput),
    summary: {
      boundedTargets: liveInput.targets.bounded.length,
      faultTargets: liveInput.targets.faults.length,
      visibilityMode: liveInput.visibility.mode,
    },
  };
}

export function parseArguments(argv) {
  if (argv.length !== 1) {
    throw new Error("usage: verify-eks-day18-live-input.mjs <private-live-input.json>");
  }
  return { path: resolve(process.cwd(), argv[0]) };
}

function main() {
  try {
    const { path } = parseArguments(process.argv.slice(2));
    const verified = loadAndVerifyDay18LiveInput(path);
    console.log(
      [
        "day18_live_input=verified",
        `bounded_targets=${verified.summary.boundedTargets}`,
        `fault_targets=${verified.summary.faultTargets}`,
        `visibility=${verified.summary.visibilityMode}`,
        `target_selection=${verified.targetSelectionSha256.slice(0, 12)}`,
      ].join(" "),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
