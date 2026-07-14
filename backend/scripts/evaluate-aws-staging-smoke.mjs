import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAwsStagingSmokePlan,
  evaluateAwsStagingSmokeFailureEvidence,
  evaluateAwsStagingSmokeEvidence,
  smokeEvidenceSha256,
} from "../src/awsStagingSmoke.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.plan) {
    const plan = createAwsStagingSmokePlan({
      runtimeRootUri: options.runtimeRootUri,
      sourceRevision: options.sourceRevision,
      smokeBundleSha256: options.smokeBundleSha256,
      stackId: options.stackId,
    }, contract);
    console.log(JSON.stringify(plan));
  } else if (options.evidenceFile) {
    const evidence = JSON.parse(readFileSync(options.evidenceFile, "utf8"));
    const evaluated = evaluateAwsStagingSmokeEvidence(evidence, contract);
    console.log(`ASKLAKE_AWS_STAGING_SMOKE_EVALUATED=${JSON.stringify({
      ...evaluated.summary,
      evidenceSha256: smokeEvidenceSha256(evidence),
    })}`);
  } else {
    const evidence = JSON.parse(readFileSync(options.failureEvidenceFile, "utf8"));
    const evaluated = evaluateAwsStagingSmokeFailureEvidence(evidence, contract);
    console.log(`ASKLAKE_AWS_STAGING_SMOKE_FAILURE_EVALUATED=${JSON.stringify({
      evidenceSha256: smokeEvidenceSha256(evidence),
      status: evaluated.status,
    })}`);
  }
} catch (error) {
  console.error(`AWS staging smoke evaluation failed (${error?.code || "INVALID_INPUT"}).`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--plan") {
      result.plan = true;
      continue;
    }
    const mapping = {
      "--evidence-file": "evidenceFile",
      "--failure-evidence-file": "failureEvidenceFile",
      "--runtime-root-uri": "runtimeRootUri",
      "--source-revision": "sourceRevision",
      "--smoke-bundle-sha256": "smokeBundleSha256",
      "--stack-id": "stackId",
    };
    if (!mapping[name] || !argv[index + 1]) throw new Error("Smoke evaluation arguments are invalid.");
    result[mapping[name]] = argv[index + 1];
    index += 1;
  }
  if (result.plan) {
    if (!result.runtimeRootUri || !result.sourceRevision || !result.smokeBundleSha256 || !result.stackId || result.evidenceFile || result.failureEvidenceFile) {
      throw new Error("Smoke plan arguments are incomplete.");
    }
  } else if ((Boolean(result.evidenceFile) === Boolean(result.failureEvidenceFile))
    || result.runtimeRootUri || result.sourceRevision || result.smokeBundleSha256 || result.stackId) {
    throw new Error("Exactly one smoke evidence file is required for evaluation.");
  }
  return result;
}
