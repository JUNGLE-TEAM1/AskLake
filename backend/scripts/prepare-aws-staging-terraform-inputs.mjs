import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractEmrServerlessConcurrentVcpu,
  prepareAwsStagingTerraformInputs,
} from "../src/awsStagingWorkflow.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));

export function writeAwsStagingTerraformInputs(input, options) {
  const prepared = prepareAwsStagingTerraformInputs(input, contract, options);
  atomicPrivateWrite(options.backendFile, prepared.backend);
  try {
    atomicPrivateWrite(options.tfvarsFile, prepared.variablesJson);
    if (options.githubOutputFile) {
      writeFileSync(options.githubOutputFile, `expires_at=${prepared.expiresAt}\nstack_id=${prepared.stackId}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    }
  } catch (error) {
    rmSync(options.backendFile, { force: true });
    rmSync(options.tfvarsFile, { force: true });
    throw error;
  }
  return prepared;
}

export function quotaFromJson(text) {
  return extractEmrServerlessConcurrentVcpu(JSON.parse(text), contract);
}

function atomicPrivateWrite(targetValue, content) {
  const target = path.resolve(targetValue);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--extract-quota") {
      options.extractQuota = true;
      continue;
    }
    if (!["--backend-file", "--tfvars-file", "--github-output"].includes(name)) {
      throw new Error("Unsupported AWS staging input argument.");
    }
    const value = argv[index + 1];
    if (!value) throw new Error("AWS staging input argument requires a value.");
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

async function standardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.extractQuota) {
      process.stdout.write(`${quotaFromJson(await standardInput())}\n`);
    } else {
      if (!args.backendFile || !args.tfvarsFile) throw new Error("Backend and tfvars file paths are required.");
      const prepared = writeAwsStagingTerraformInputs({
        availableEmrServerlessConcurrentVcpu: process.env.AWS_EMR_SERVERLESS_CONCURRENT_VCPU,
        awsAccountId: process.env.AWS_ACCOUNT_ID,
        budgetNotificationEmail: process.env.AWS_BUDGET_NOTIFICATION_EMAIL,
        confirmation: process.env.AWS_STAGING_CONFIRMATION,
        enableSmokeRunner: process.env.AWS_STAGING_ENABLE_SMOKE_RUNNER,
        expiresAt: process.env.AWS_STAGING_EXPIRES_AT,
        githubOidcRoleArn: process.env.AWS_GITHUB_OIDC_ROLE_ARN,
        operation: process.env.AWS_STAGING_OPERATION,
        region: process.env.AWS_REGION,
        smokeRunnerAmiId: process.env.AWS_STAGING_SMOKE_RUNNER_AMI_ID,
        stackId: process.env.AWS_STAGING_STACK_ID,
        stateBucketName: process.env.AWS_TERRAFORM_STATE_BUCKET,
        stateKmsKeyArn: process.env.AWS_TERRAFORM_STATE_KMS_KEY_ARN,
        ttlHours: process.env.AWS_STAGING_TTL_HOURS,
      }, {
        backendFile: args.backendFile,
        githubOutputFile: args.githubOutput,
        tfvarsFile: args.tfvarsFile,
      });
      console.log(`AWS_STAGING_TERRAFORM_INPUTS_READY=${JSON.stringify({
        expiresAt: prepared.expiresAt,
        operation: prepared.operation,
        stackId: prepared.stackId,
      })}`);
    }
  } catch (error) {
    console.error(`AWS staging input preparation failed (${error?.code || "INVALID_INPUT"}).`);
    process.exitCode = 1;
  }
}
