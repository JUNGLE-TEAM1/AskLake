#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateExecutionContract,
  validatePrivateExecutionContractOutputPath,
} from "./verify-eks-day18-execution-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_SOURCE = resolve(
  ROOT_DIR,
  "infra/eks/delivery/day18-resilience-execution.example.json",
);
const DEFAULT_OUTPUT = "/private/tmp/asklake-day18-execution-contract.json";

export async function prepareExecutionContract({
  source = DEFAULT_SOURCE,
  output = DEFAULT_OUTPUT,
  baseRevision,
  createdAt = new Date().toISOString(),
} = {}) {
  const outputErrors = validatePrivateExecutionContractOutputPath(output);
  if (outputErrors.length > 0) {
    throw new Error(`pending execution contract output: ${outputErrors.join("; ")}`);
  }
  const revision =
    baseRevision ??
    execFileSync("git", ["-C", ROOT_DIR, "rev-parse", "origin/pair1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const template = JSON.parse(await readFile(source, "utf8"));
  const contract = {
    ...template,
    createdAt,
    baseRevision: revision,
  };
  const errors = validateExecutionContract(contract, { execution: false });
  if (errors.length > 0) {
    throw new Error(`template contract is invalid: ${errors.join("; ")}`);
  }
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { output, contract };
}

function parseArguments(argv) {
  if (argv.length === 0) return { output: DEFAULT_OUTPUT };
  if (argv.length === 2 && argv[0] === "--output") {
    return { output: resolve(process.cwd(), argv[1]) };
  }
  throw new Error(
    "usage: prepare-eks-day18-execution-contract.mjs [--output <private-contract.json>]",
  );
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { output } = await prepareExecutionContract(options);
    console.log(`Day 18 pending execution contract prepared: ${output}`);
  } catch (error) {
    console.error(`Day 18 execution contract preparation failed: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) await main();
