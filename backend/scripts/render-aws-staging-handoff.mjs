import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAwsStagingHandoff, renderAwsStagingHandoffMarkdown } from "../src/awsStagingHandoff.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"), "utf8"));

try {
  const options = parseArguments(process.argv.slice(2));
  const handoff = createAwsStagingHandoff({
    cleanupReceipt: readJson(options.cleanupReceipt),
    smokeEvidence: readJson(options.smokeEvidence),
    ttlSweepEvidence: readJson(options.ttlSweepEvidence),
  }, contract);
  mkdirSync(path.dirname(options.outputJson), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(options.outputMarkdown), { recursive: true, mode: 0o700 });
  writeFileSync(options.outputJson, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(options.outputMarkdown, renderAwsStagingHandoffMarkdown(handoff), { mode: 0o600 });
  console.log(`ASKLAKE_AWS_STAGING_HANDOFF=${JSON.stringify({ status: handoff.status, stackId: handoff.stackId })}`);
} catch (error) {
  console.error(`AWS staging handoff failed (${error?.code || "AWS_STAGING_HANDOFF_FAILED"}).`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const result = {};
  const names = {
    "--cleanup-receipt": "cleanupReceipt",
    "--output-json": "outputJson",
    "--output-markdown": "outputMarkdown",
    "--smoke-evidence": "smokeEvidence",
    "--ttl-sweep-evidence": "ttlSweepEvidence",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const target = names[argv[index]];
    if (!target || !argv[index + 1]) throw new Error("Handoff arguments are invalid.");
    result[target] = argv[index + 1];
    index += 1;
  }
  if (Object.keys(result).length !== Object.keys(names).length) throw new Error("Handoff arguments are incomplete.");
  return result;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
