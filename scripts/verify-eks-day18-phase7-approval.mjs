#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateExecutionContract,
  validatePrivateExecutionContractFile,
} from "./verify-eks-day18-execution-contract.mjs";
import { loadAndVerifyDay18LiveInput } from "./verify-eks-day18-live-input.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(dirname(SCRIPT_PATH), "..");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function privateRegularFile(path, label, {
  allowRepository = false,
  requirePrivateTmp = false,
} = {}) {
  if (!path) throw new Error(`${label} is required`);
  const absolute = resolve(path);
  const link = lstatSync(absolute);
  if (link.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = realpathSync(absolute);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must use mode 0600`);
  }
  if (requirePrivateTmp && !real.startsWith("/private/tmp/")) {
    throw new Error(`${label} must be stored under /private/tmp`);
  }
  if (!allowRepository && (real === ROOT_DIR || real.startsWith(`${ROOT_DIR}/`))) {
    throw new Error(`${label} must be stored outside the repository`);
  }
  return real;
}

export function validatePhase7ApprovalBinding({
  contract,
  candidateReceipt,
  candidateReceiptSha256,
  liveInputSha256,
  targetSelectionSha256,
  ec2EnvSha256,
  exportedCluster,
}) {
  const errors = [];
  if (contract?.approval?.state !== "approved") {
    errors.push("execution contract is not approved");
  }
  if (contract?.images?.candidate?.receiptSha256 !== candidateReceiptSha256) {
    errors.push("candidate receipt is not bound to the execution contract");
  }
  if (contract?.images?.candidate?.gitRevision !== candidateReceipt?.gitRevision) {
    errors.push("candidate revision is not bound to the execution contract");
  }
  if (contract?.liveInputEvidence?.inputSha256 !== liveInputSha256) {
    errors.push("live input is not bound to the execution contract");
  }
  if (
    contract?.liveInputEvidence?.targetSelectionSha256
      !== targetSelectionSha256
  ) {
    errors.push("target selection is not bound to the execution contract");
  }
  if (candidateReceipt?.platform !== "linux/amd64") {
    errors.push("candidate receipt is not linux/amd64");
  }
  if (!contract?.actions?.rollingUpdate || !contract?.actions?.rollback) {
    errors.push("execution contract does not approve the Phase 7 round trip");
  }
  if (!exportedCluster) errors.push("exact cluster name is not exported");
  if (!ec2EnvSha256) errors.push("preserved EC2 env hash is unavailable");
  return errors;
}

export function verifyPhase7ApprovalFiles({
  contractPath,
  liveInputPath,
  candidateReceiptPath,
  ec2EnvPath,
  exportedCluster,
}) {
  const contractFileErrors = validatePrivateExecutionContractFile(contractPath);
  if (contractFileErrors.length > 0) throw new Error(contractFileErrors.join("; "));
  const contractBytes = readFileSync(contractPath);
  const contract = JSON.parse(contractBytes);
  const contractErrors = validateExecutionContract(contract, { execution: true });
  if (contractErrors.length > 0) throw new Error(contractErrors.join("; "));

  const candidatePath = privateRegularFile(
    candidateReceiptPath,
    "candidate receipt",
    { allowRepository: true },
  );
  execFileSync(
    process.execPath,
    [resolve(ROOT_DIR, "scripts/verify-eks-image-receipt.mjs"), candidatePath],
    { cwd: ROOT_DIR, stdio: "ignore" },
  );
  const candidateBytes = readFileSync(candidatePath);
  const candidateReceipt = JSON.parse(candidateBytes);
  const verifiedLiveInput = loadAndVerifyDay18LiveInput(liveInputPath);
  const ec2Path = privateRegularFile(ec2EnvPath, "preserved EC2 env");
  if (verifiedLiveInput.liveInput.cluster.name !== exportedCluster) {
    throw new Error("exact cluster name is not bound to the live input");
  }
  const ec2EnvSha256 = sha256(readFileSync(ec2Path));
  if (verifiedLiveInput.liveInput.preservedEc2.envFileSha256 !== ec2EnvSha256) {
    throw new Error("preserved EC2 env is not bound to the live input");
  }
  const errors = validatePhase7ApprovalBinding({
    contract,
    candidateReceipt,
    candidateReceiptSha256: sha256(candidateBytes),
    liveInputSha256: verifiedLiveInput.inputSha256,
    targetSelectionSha256: verifiedLiveInput.targetSelectionSha256,
    ec2EnvSha256,
    exportedCluster,
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return true;
}

function parseArguments(argv) {
  const options = {};
  const keys = {
    "--contract": "contractPath",
    "--live-input": "liveInputPath",
    "--candidate-receipt": "candidateReceiptPath",
    "--ec2-env": "ec2EnvPath",
    "--cluster": "exportedCluster",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]];
    const value = argv[index + 1];
    if (!key || !value) throw new Error(`invalid argument: ${argv[index] ?? "missing"}`);
    options[key] = value;
  }
  return options;
}

async function main() {
  try {
    verifyPhase7ApprovalFiles(parseArguments(process.argv.slice(2)));
    console.log("day18_phase7_approval=verified");
  } catch (error) {
    console.error(`Day 18 Phase 7 approval verification failed: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) await main();
