#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateExecutionContract,
  validatePrivateExecutionContractFile,
  validatePrivateExecutionContractOutputPath,
} from "./verify-eks-day18-execution-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(dirname(SCRIPT_PATH), "..");
const IMAGE_RECEIPT_VERIFIER = resolve(
  ROOT_DIR,
  "scripts/verify-eks-image-receipt.mjs",
);
const CAPABILITY_PROOF_PATH = resolve(
  ROOT_DIR,
  "infra/eks/delivery/day18-resilience-capability-proof.json",
);
const BUILD_INPUTS = [
  "backend",
  "infra/eks/helm/asklake-web",
  ".github/workflows/eks-image-delivery.yml",
];

function runGit(args) {
  return execFileSync("git", ["-C", ROOT_DIR, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveRevision(ref, label) {
  try {
    return runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new Error(`${label} is not a resolvable Git commit: ${ref}`);
  }
}

function requireAncestor(ancestor, descendant, label) {
  try {
    execFileSync(
      "git",
      ["-C", ROOT_DIR, "merge-base", "--is-ancestor", ancestor, descendant],
      { stdio: "ignore" },
    );
  } catch {
    throw new Error(`${label} is not merged into the selected base revision`);
  }
}

function assertBuildInputsFresh(candidateRevision, baseRevision) {
  try {
    execFileSync(
      "git",
      [
        "-C",
        ROOT_DIR,
        "diff",
        "--quiet",
        candidateRevision,
        baseRevision,
        "--",
        ...BUILD_INPUTS,
      ],
      { stdio: "ignore" },
    );
  } catch {
    throw new Error(
      "candidate image is stale: backend, asklake-web chart, or image workflow changed after its Git revision",
    );
  }
}

async function readPrivateJson(path, label) {
  const errors = validatePrivateExecutionContractFile(path);
  if (errors.length > 0) {
    throw new Error(`${label}: ${errors.join("; ")}`);
  }
  try {
    return {
      value: JSON.parse(await readFile(path, "utf8")),
      bytes: await readFile(path),
    };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function verifyImageReceipt(path, label) {
  try {
    execFileSync(process.execPath, [IMAGE_RECEIPT_VERIFIER, path], {
      cwd: ROOT_DIR,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`${label} failed the immutable image receipt verifier`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCapabilityProofShape(proof) {
  const capabilities = proof?.capabilities ?? {};
  const sourceProofs = proof?.sourceProofs;
  const regressionProofs = proof?.regressionProofs;
  if (
    proof?.contractVersion !== "1.0" ||
    proof?.campaign !== "eks-day18-resilience" ||
    capabilities.mskFaultUsesPersistedRun !== true ||
    capabilities.sparkTerminalRetrySupported !== true ||
    proof?.validation?.requiredChecksPassed !== true ||
    !Number.isInteger(proof?.validation?.pullRequest) ||
    !Number.isInteger(proof?.validation?.imageDeliveryRun) ||
    !Array.isArray(sourceProofs) ||
    sourceProofs.length === 0 ||
    !Array.isArray(regressionProofs) ||
    regressionProofs.length === 0
  ) {
    throw new Error("Day 18 capability proof manifest is incomplete");
  }
  const entries = [...sourceProofs, ...regressionProofs];
  for (const entry of entries) {
    if (
      typeof entry?.path !== "string" ||
      !entry.path.startsWith("backend/") ||
      entry.path.includes("..") ||
      typeof entry?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Day 18 capability proof manifest contains an invalid source proof");
    }
  }
  return entries;
}

async function resolveCapabilityEvidence({ candidateRevision, baseRevision }) {
  const proofBytes = await readFile(CAPABILITY_PROOF_PATH);
  let proof;
  try {
    proof = JSON.parse(proofBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Day 18 capability proof manifest is invalid JSON: ${error.message}`);
  }
  const implementationRevision = resolveRevision(
    proof.implementationRevision,
    "capability implementation revision",
  );
  requireAncestor(
    implementationRevision,
    candidateRevision,
    "capability implementation revision",
  );
  requireAncestor(
    implementationRevision,
    baseRevision,
    "capability implementation revision",
  );
  for (const entry of requireCapabilityProofShape(proof)) {
    let candidateBytes;
    try {
      candidateBytes = execFileSync(
        "git",
        ["-C", ROOT_DIR, "show", `${candidateRevision}:${entry.path}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      throw new Error(`candidate image revision is missing capability proof input ${entry.path}`);
    }
    if (sha256(candidateBytes) !== entry.sha256) {
      throw new Error(`candidate image revision does not match capability proof input ${entry.path}`);
    }
  }
  return {
    capabilities: {
      mskFaultUsesPersistedRun: true,
      sparkTerminalRetrySupported: true,
    },
    capabilityEvidence: {
      state: "verified",
      implementationRevision,
      proofManifestSha256: sha256(proofBytes),
    },
  };
}

async function resolveVerifiedBinding({
  currentReceipt,
  candidateReceipt,
  rollbackReceipt,
  baseRef,
  requiredMergedRefs,
}) {
  const receiptInputs = {
    current: currentReceipt,
    candidate: candidateReceipt,
    rollback: rollbackReceipt,
  };
  const receipts = {};
  for (const [name, path] of Object.entries(receiptInputs)) {
    const receipt = await readPrivateJson(path, `${name} image receipt`);
    verifyImageReceipt(path, `${name} image receipt`);
    receipts[name] = {
      gitRevision: receipt.value.gitRevision,
      receiptSha256: sha256(receipt.bytes),
    };
  }

  if (
    receipts.current.gitRevision !== receipts.rollback.gitRevision ||
    receipts.current.receiptSha256 !== receipts.rollback.receiptSha256
  ) {
    throw new Error("rollback image receipt must be byte-exact with the current receipt");
  }
  if (
    receipts.candidate.gitRevision === receipts.rollback.gitRevision ||
    receipts.candidate.receiptSha256 === receipts.rollback.receiptSha256
  ) {
    throw new Error("candidate image receipt must differ from the rollback receipt");
  }

  const baseRevision = resolveRevision(baseRef, "base ref");
  for (const [name, receipt] of Object.entries(receipts)) {
    requireAncestor(receipt.gitRevision, baseRevision, `${name} image revision`);
  }
  for (const ref of requiredMergedRefs) {
    const revision = resolveRevision(ref, "required merged ref");
    requireAncestor(revision, baseRevision, `required merged ref ${ref}`);
  }
  assertBuildInputsFresh(receipts.candidate.gitRevision, baseRevision);
  const capabilityBinding = await resolveCapabilityEvidence({
    candidateRevision: receipts.candidate.gitRevision,
    baseRevision,
  });
  return { baseRevision, receipts, ...capabilityBinding };
}

export async function verifyBoundExecutionContract({
  input,
  currentReceipt,
  candidateReceipt,
  rollbackReceipt,
  baseRef = "origin/dev",
  requiredMergedRefs = [],
} = {}) {
  if (!input || !currentReceipt || !candidateReceipt || !rollbackReceipt) {
    throw new Error("input and all three image receipts are required");
  }
  const source = await readPrivateJson(input, "bound execution contract");
  const errors = validateExecutionContract(source.value, { execution: false });
  if (errors.length > 0) {
    throw new Error(`bound execution contract is invalid: ${errors.join("; ")}`);
  }
  const expected = await resolveVerifiedBinding({
    currentReceipt,
    candidateReceipt,
    rollbackReceipt,
    baseRef,
    requiredMergedRefs,
  });
  if (
    source.value.baseRevision !== expected.baseRevision ||
    JSON.stringify(source.value.images) !== JSON.stringify(expected.receipts) ||
    JSON.stringify(source.value.capabilities) !==
      JSON.stringify(expected.capabilities) ||
    JSON.stringify(source.value.capabilityEvidence) !==
      JSON.stringify(expected.capabilityEvidence)
  ) {
    throw new Error(
      "bound execution contract does not match the verified Git base, image receipts, and capability proof",
    );
  }
  return source.value;
}

export async function bindExecutionContract({
  input,
  output,
  currentReceipt,
  candidateReceipt,
  rollbackReceipt,
  baseRef = "origin/dev",
  requiredMergedRefs = [],
  createdAt = new Date().toISOString(),
} = {}) {
  if (!input || !output || !currentReceipt || !candidateReceipt || !rollbackReceipt) {
    throw new Error("input, output, and all three image receipts are required");
  }
  const outputErrors = validatePrivateExecutionContractOutputPath(output);
  if (outputErrors.length > 0) {
    throw new Error(`bound execution contract output: ${outputErrors.join("; ")}`);
  }
  const source = await readPrivateJson(input, "pending execution contract");
  const templateErrors = validateExecutionContract(source.value, {
    execution: false,
  });
  if (templateErrors.length > 0) {
    throw new Error(`pending execution contract is invalid: ${templateErrors.join("; ")}`);
  }

  const {
    baseRevision,
    receipts,
    capabilities,
    capabilityEvidence,
  } = await resolveVerifiedBinding({
    currentReceipt,
    candidateReceipt,
    rollbackReceipt,
    baseRef,
    requiredMergedRefs,
  });

  const contract = {
    ...source.value,
    createdAt,
    baseRevision,
    images: receipts,
    capabilities,
    capabilityEvidence,
    approval: {
      state: "pending",
      approvedAt: null,
      scopeHash: null,
    },
  };
  const errors = validateExecutionContract(contract, { execution: false });
  if (errors.length > 0) {
    throw new Error(`bound execution contract is invalid: ${errors.join("; ")}`);
  }

  const handle = await open(output, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { contract, output };
}

export function parseArguments(argv) {
  const options = { baseRef: "origin/dev", requiredMergedRefs: [] };
  const single = new Set([
    "--input",
    "--output",
    "--current-receipt",
    "--candidate-receipt",
    "--rollback-receipt",
    "--base-ref",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--require-merged-ref") {
      options.requiredMergedRefs.push(value);
      continue;
    }
    if (!single.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const key = {
      "--input": "input",
      "--output": "output",
      "--current-receipt": "currentReceipt",
      "--candidate-receipt": "candidateReceipt",
      "--rollback-receipt": "rollbackReceipt",
      "--base-ref": "baseRef",
    }[flag];
    options[key] = value;
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { output } = await bindExecutionContract(options);
    console.log(`Day 18 image-bound pending contract prepared: ${output}`);
  } catch (error) {
    console.error(`Day 18 contract binding failed: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) await main();
