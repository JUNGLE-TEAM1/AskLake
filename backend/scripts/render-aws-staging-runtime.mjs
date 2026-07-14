import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AWS_STAGING_RUNTIME_SCHEMA,
  renderAwsStagingRuntime,
} from "../src/awsStagingRuntime.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));

export function writeAwsStagingRuntimeFiles(terraformOutput, options = {}) {
  const rendered = renderAwsStagingRuntime(terraformOutput, contract);
  const outputDirectory = path.resolve(
    options.outputDirectory || path.join(repositoryRoot, "deploy", "generated", "aws-staging"),
  );
  const envFile = path.join(outputDirectory, `${rendered.stackId}.env`);
  const manifestFile = path.join(outputDirectory, `${rendered.stackId}.manifest.json`);
  if (!options.overwrite && (existsSync(envFile) || existsSync(manifestFile))) {
    const error = new Error("Generated AWS staging Runtime files already exist; pass --overwrite to replace them atomically.");
    error.code = "AWS_STAGING_RUNTIME_OUTPUT_EXISTS";
    throw error;
  }
  mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  atomicPrivateWrite(envFile, rendered.envText);
  try {
    atomicPrivateWrite(manifestFile, `${JSON.stringify(rendered.manifest, null, 2)}\n`);
  } catch (error) {
    rmSync(envFile, { force: true });
    throw error;
  }
  return Object.freeze({
    brokerCount: rendered.brokerCount,
    brokerFingerprint: rendered.brokerFingerprint,
    envFile,
    manifestFile,
    schemaVersion: AWS_STAGING_RUNTIME_SCHEMA,
    stackId: rendered.stackId,
  });
}

function atomicPrivateWrite(target, content) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseArguments(argv) {
  const options = { outputDirectory: null, overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--overwrite") {
      options.overwrite = true;
    } else if (argument === "--output-dir") {
      options.outputDirectory = argv[index + 1];
      index += 1;
      if (!options.outputDirectory) throw new Error("--output-dir requires a path.");
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  terraform output -json | node scripts/render-aws-staging-runtime.mjs [--output-dir PATH] [--overwrite]",
    "",
    "The private .env contains the sensitive broker endpoint and is written with mode 0600.",
    "The adjacent manifest never contains broker endpoints or AWS credentials.",
  ].join("\n");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const input = await readStandardInput();
      const terraformOutput = JSON.parse(input);
      const result = writeAwsStagingRuntimeFiles(terraformOutput, options);
      console.log(`ASKLAKE_AWS_STAGING_RUNTIME_FILES=${JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error(`AWS staging Runtime render failed (${error?.code || "INVALID_INPUT"}).`);
    process.exitCode = 1;
  }
}
