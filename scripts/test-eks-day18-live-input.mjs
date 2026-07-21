import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  computeTargetSelectionHash,
  loadAndVerifyDay18LiveInput,
  validateDay18LiveInput,
} from "./verify-eks-day18-live-input.mjs";

function fixture() {
  const bounded = ["Run A", "Run B", "Run C"].map((alias, index) => ({
    alias,
    jobId: `raw-job-${index + 1}`,
    datasetId: `raw-dataset-${index + 1}`,
    fixtureBatchId: "raw-shared-batch",
    consumerGroup: `raw-group-${index + 1}`,
    icebergTable: `raw_table_${index + 1}`,
    expectedCount: 100,
  }));
  return {
    contractVersion: "1.0",
    campaign: "eks-day18-resilience",
    environment: "dev",
    createdAt: "2026-07-19T00:00:00.000Z",
    cluster: {
      name: "asklake-dev",
      namespace: "asklake-dev",
      region: "ap-northeast-2",
    },
    preservedEc2: {
      instanceId: "i-0123456789abcdef0",
      envFileSha256: "a".repeat(64),
    },
    visibility: {
      mode: "in-cluster-backend-service-account",
      sparkApplicationsReadable: true,
    },
    baseline: {
      activeFixtureRuns: 0,
      activeSparkApplications: 0,
      activeKubernetesJobs: 0,
      pendingOrTerminatingPods: 0,
      fastApiReady: 2,
      collectorReady: 1,
      hpaCurrent: 2,
      hpaDesired: 2,
      continuousActive: 0,
    },
    checks: {
      fastApiImageMatchesReceipt: true,
      collectorImageMatchesReceipt: true,
      externalHealthSteady: true,
      airflowConfigured: true,
      mskDenyServiceAccountPresent: true,
      driverDeleteAllowed: true,
      continuousBoundaryVerified: true,
    },
    targets: {
      bounded,
      faults: [
        {
          ...bounded[0],
          alias: "Run D",
          sourceAlias: "Run A",
          failure: "mskAuthorization",
        },
        {
          ...bounded[1],
          alias: "Run E",
          sourceAlias: "Run B",
          failure: "sparkTerminal",
        },
      ],
    },
  };
}

test("accepts the exact private live input and derives stable target hash", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-live-input-"));
  const path = join(directory, "input.json");
  const input = fixture();
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  const verified = loadAndVerifyDay18LiveInput(path);
  assert.equal(verified.targetSelectionSha256, computeTargetSelectionHash(input));
  assert.equal(verified.summary.boundedTargets, 3);
  assert.equal(verified.summary.faultTargets, 2);
});

test("fails closed for unsafe baseline and mismatched fault source", () => {
  const input = fixture();
  input.baseline.activeFixtureRuns = 1;
  input.checks.driverDeleteAllowed = false;
  input.targets.faults[0].consumerGroup = "wrong-group";
  const errors = validateDay18LiveInput(input);
  assert.ok(errors.some((error) => error.includes("activeFixtureRuns must be 0")));
  assert.ok(errors.some((error) => error.includes("driverDeleteAllowed must be true")));
  assert.ok(errors.some((error) => error.includes("consumerGroup must match Run A")));
});

test("requires 3/3 isolation and the shared fixture batch", () => {
  const input = fixture();
  input.targets.bounded[2].consumerGroup = input.targets.bounded[1].consumerGroup;
  input.targets.bounded[2].fixtureBatchId = "different-batch";
  const errors = validateDay18LiveInput(input);
  assert.ok(errors.some((error) => error.includes("consumerGroup values must be 3/3 unique")));
  assert.ok(errors.some((error) => error.includes("fixtureBatchId must be shared")));
});

test("CLI output is sanitized and does not reveal raw identifiers", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-live-cli-"));
  const path = join(directory, "input.json");
  const input = fixture();
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  const output = execFileSync(
    process.execPath,
    [new URL("./verify-eks-day18-live-input.mjs", import.meta.url).pathname, path],
    { encoding: "utf8" },
  );
  assert.match(output, /day18_live_input=verified/);
  assert.doesNotMatch(output, /raw-job|raw-dataset|raw-group|raw_table|instance/i);
});

test("rejects non-private file mode", async () => {
  const directory = await mkdtemp(join("/private/tmp", "asklake-day18-live-mode-"));
  const path = join(directory, "input.json");
  await writeFile(path, `${JSON.stringify(fixture())}\n`, { mode: 0o600 });
  await chmod(path, 0o644);
  assert.throws(() => loadAndVerifyDay18LiveInput(path), /mode 0600/);
});

test("preparation stages the live input inside the private verifier boundary", async () => {
  const source = await readFile(
    new URL("./prepare-eks-day18-live-input.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /mktemp -d \/private\/tmp\/asklake-day18-live-input\.XXXXXX/,
  );
  assert.match(source, /chmod 0700 "\$TEMP_DIR"/);
});
