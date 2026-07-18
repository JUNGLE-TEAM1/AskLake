#!/usr/bin/env node

import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeExecutionScopeHash,
  validateExecutionContract,
  validatePrivateExecutionContractOutputPath,
} from "./verify-eks-day18-execution-contract.mjs";
import { verifyBoundExecutionContract } from "./bind-eks-day18-execution-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "approve-eks-day18-resilience-scope";

export async function approveExecutionContract({
  input,
  output,
  confirmation,
  currentReceipt,
  candidateReceipt,
  rollbackReceipt,
  baseRef = "origin/pair1",
  requiredMergedRefs = [],
  approvedAt = new Date().toISOString(),
} = {}) {
  if (!input || !output) throw new Error("input and output are required");
  const outputErrors = validatePrivateExecutionContractOutputPath(output);
  if (outputErrors.length > 0) {
    throw new Error(`approved execution contract output: ${outputErrors.join("; ")}`);
  }
  if (confirmation !== CONFIRMATION) {
    throw new Error(`confirmation must equal ${CONFIRMATION}`);
  }
  const pending = await verifyBoundExecutionContract({
    input,
    currentReceipt,
    candidateReceipt,
    rollbackReceipt,
    baseRef,
    requiredMergedRefs,
  });
  const contract = {
    ...pending,
    approval: {
      state: "approved",
      approvedAt,
      scopeHash: null,
    },
  };
  contract.approval.scopeHash = computeExecutionScopeHash(contract);
  const errors = validateExecutionContract(contract, { execution: true });
  if (errors.length > 0) {
    throw new Error(`execution contract is not approvable: ${errors.join("; ")}`);
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
  const options = { baseRef: "origin/pair1", requiredMergedRefs: [] };
  const keys = {
    "--input": "input",
    "--output": "output",
    "--confirm": "confirmation",
    "--current-receipt": "currentReceipt",
    "--candidate-receipt": "candidateReceipt",
    "--rollback-receipt": "rollbackReceipt",
    "--base-ref": "baseRef",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--require-merged-ref") {
      options.requiredMergedRefs.push(value);
      continue;
    }
    if (!keys[flag]) throw new Error(`unknown argument: ${flag}`);
    options[keys[flag]] = value;
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { output } = await approveExecutionContract(options);
    console.log(`Day 18 approved execution contract prepared: ${output}`);
  } catch (error) {
    console.error(`Day 18 contract approval failed: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) await main();
