import path from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprintTerraformPlan } from "../src/terraformPlanFingerprint.mjs";

async function standardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const fingerprint = fingerprintTerraformPlan(JSON.parse(await standardInput()));
    process.stdout.write(`${fingerprint.sha256}\n`);
  } catch (error) {
    console.error(`Terraform plan fingerprint failed (${error?.code || "INVALID_PLAN"}).`);
    process.exitCode = 1;
  }
}
