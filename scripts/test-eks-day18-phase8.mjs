#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  Phase8BlockedError,
  classifyPersistedFaultCheckpoint,
  countActiveJobs,
  countActiveSparkApplications,
  executeMode,
  parseArguments,
  parseDenyProbeLog,
  renderDenyProbeJob,
  runCleanup,
  runFaultE,
  runPreflight,
  stateArtifactPaths,
  summarizeFaultObservability,
  validateAbcReceipt,
  validateDenyProbeJob,
  validateDescribeOnlyPolicy,
  validateDriverPod,
  validateFirstAttemptProcessResult,
  validateRoundTripEvidence,
  validateStateBinding,
} from "./run-eks-day18-phase8.mjs";


const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `example.invalid/asklake/backend@${DIGEST}`;


function exactDescribeOnlyDocument() {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "kafka-cluster:Connect",
        Resource:
          "arn:aws:kafka:ap-northeast-2:123456789012:cluster/dev/uuid",
      },
      {
        Effect: "Allow",
        Action: "kafka-cluster:DescribeTopic",
        Resource:
          "arn:aws:kafka:ap-northeast-2:123456789012:topic/dev/uuid/asklake.eks-mvp.fixture.v1",
      },
    ],
  };
}


test("round-trip evidence requires ordered re-promotion and exact candidate", () => {
  assert.deepEqual(
    validateRoundTripEvidence(
      {
        state: "candidate_repromotion_passed",
        prior: { helmRevision: "10", backendImage: "old@sha256:old" },
        candidate: {
          backendImage: IMAGE,
          firstPromotionRevision: "11",
          rollbackRevision: "12",
          finalPromotionRevision: "13",
        },
      },
      IMAGE,
    ),
    {
      statePassed: true,
      candidateImageExact: true,
      rollbackImageDifferent: true,
      revisionSequence: true,
    },
  );
  assert.throws(
    () =>
      validateRoundTripEvidence(
        {
          state: "candidate_promotion_passed",
          prior: { helmRevision: "10", backendImage: "old@sha256:old" },
          candidate: {
            backendImage: IMAGE,
            firstPromotionRevision: "11",
            rollbackRevision: "12",
            finalPromotionRevision: "13",
          },
        },
        IMAGE,
      ),
    Phase8BlockedError,
  );
});


test("Describe-only policy rejects any write or wildcard expansion", () => {
  const valid = validateDescribeOnlyPolicy({
    documents: [exactDescribeOnlyDocument()],
    attachedPolicyCount: 1,
    inlinePolicyCount: 0,
  });
  assert.equal(valid.actionCount, 2);
  assert.equal(valid.topic, "asklake.eks-mvp.fixture.v1");

  const expanded = exactDescribeOnlyDocument();
  expanded.Statement.push({
    Effect: "Allow",
    Action: "kafka-cluster:WriteData",
    Resource: "*",
  });
  assert.throws(
    () =>
      validateDescribeOnlyPolicy({
        documents: [expanded],
        attachedPolicyCount: 1,
        inlinePolicyCount: 0,
      }),
    Phase8BlockedError,
  );
});


test("deny probe is one immutable tokenless bounded Job", () => {
  const campaignId = "b".repeat(32);
  const manifest = renderDenyProbeJob({
    campaignId,
    image: IMAGE,
  });
  assert.equal(
    validateDenyProbeJob(manifest, IMAGE, {
      campaignId,
      expectedName: manifest.metadata.name,
    }),
    true,
  );
  assert.equal(manifest.spec.backoffLimit, 0);
  assert.equal(
    manifest.spec.template.spec.automountServiceAccountToken,
    false,
  );
  assert.equal(
    manifest.spec.template.spec.containers[0].env.find(
      ({ name }) => name === "ASKLAKE_FIXTURE_EXPECTED_COUNT",
    ).value,
    "1",
  );

  const unsafe = structuredClone(manifest);
  unsafe.spec.template.spec.automountServiceAccountToken = true;
  assert.throws(
    () => validateDenyProbeJob(unsafe, IMAGE),
    Phase8BlockedError,
  );
  assert.throws(
    () =>
      validateDenyProbeJob(manifest, IMAGE, {
        campaignId: "c".repeat(32),
        expectedName: manifest.metadata.name,
      }),
    Phase8BlockedError,
  );
});


test("deny log accepts exactly one authorization failure with zero ack", () => {
  const raw = `${JSON.stringify({
    status: "failed",
    category: "AUTHORIZATION",
    code: "29",
    acknowledgedMessages: 0,
  })}\n`;
  const parsed = parseDenyProbeLog(raw);
  assert.equal(parsed.attemptedMessages, 1);
  assert.equal(parsed.acknowledgedMessages, 0);
  assert.equal(parsed.protocolCode, "29");
  assert.match(parsed.evidenceSha256, /^[a-f0-9]{64}$/);

  const idempotentWriteDenied = parseDenyProbeLog(`${JSON.stringify({
    status: "failed",
    category: "AUTHORIZATION",
    code: "31",
  })}\n`);
  assert.equal(idempotentWriteDenied.protocolCode, "31");

  assert.throws(
    () =>
      parseDenyProbeLog(
        `${JSON.stringify({
          status: "failed",
          category: "NETWORK",
          code: "29",
          acknowledgedMessages: 0,
        })}\n`,
      ),
    Phase8BlockedError,
  );
  assert.throws(
    () =>
      parseDenyProbeLog(
        `${JSON.stringify({
          status: "failed",
          category: "AUTHORIZATION",
          code: "TOPIC_AUTHORIZATION_FAILED",
        })}\n${JSON.stringify({
          status: "failed",
          category: "AUTHORIZATION",
          code: "TOPIC_AUTHORIZATION_FAILED",
        })}\n`,
      ),
    Phase8BlockedError,
  );
  assert.throws(
    () =>
      parseDenyProbeLog(
        `${JSON.stringify({
          status: "failed",
          category: "AUTHORIZATION",
          code: "SASL_AUTHENTICATION_FAILED",
        })}\n`,
      ),
    Phase8BlockedError,
  );
});


test("driver deletion identity requires exact pod, app label and owner UID", () => {
  const pod = {
    metadata: {
      name: "driver-private",
      uid: "pod-uid-private",
      labels: {
        "spark-role": "driver",
        "sparkoperator.k8s.io/app-name": "app-private",
      },
      ownerReferences: [
        {
          kind: "SparkApplication",
          uid: "application-uid-private",
        },
      ],
    },
    status: { phase: "Running" },
  };
  const validated = validateDriverPod(pod, {
    applicationName: "app-private",
    applicationUid: "application-uid-private",
    driverPodName: "driver-private",
  });
  assert.equal(validated.podUid, "pod-uid-private");

  const wrongOwner = structuredClone(pod);
  wrongOwner.metadata.ownerReferences[0].uid = "other-uid";
  assert.throws(
    () =>
      validateDriverPod(wrongOwner, {
        applicationName: "app-private",
        applicationUid: "application-uid-private",
        driverPodName: "driver-private",
      }),
    Phase8BlockedError,
  );
});


test("fault observability keeps only bounded aggregate Event and marker counts", () => {
  const startTimeMs = Date.parse("2026-07-19T00:00:00Z");
  const endTimeMs = startTimeMs + 60_000;
  const summary = summarizeFaultObservability({
    startTimeMs,
    endTimeMs,
    resourceIdentities: ["private-pod", "private-uid"],
    cloudWatchMarker: "private-pod",
    requiredCloudWatchTerm: "AUTHORIZATION",
    events: {
      items: [
        {
          type: "Warning",
          reason: "Failed",
          count: 2,
          lastTimestamp: "2026-07-19T00:00:10Z",
          involvedObject: {
            kind: "Pod",
            name: "private-pod",
            uid: "private-uid",
          },
        },
        {
          type: "Normal",
          reason: "Scheduled",
          lastTimestamp: "2026-07-19T00:00:20Z",
          involvedObject: {
            kind: "Pod",
            name: "other-pod",
            uid: "other-uid",
          },
        },
        {
          type: "Warning",
          reason: "secret/private-pod",
          lastTimestamp: "2026-07-19T00:00:30Z",
          involvedObject: {
            kind: "Pod",
            name: "private-pod",
            uid: "private-uid",
          },
        },
      ],
    },
    cloudWatchEvents: [
      {
        timestamp: startTimeMs + 10_000,
        message: "private-pod AUTHORIZATION",
      },
      {
        timestamp: startTimeMs + 20_000,
        message: "private-pod NETWORK",
      },
    ],
  });
  assert.deepEqual(summary, {
    cloudWatchMarkerCount: 1,
    eventCount: 3,
    eventSummary: [
      { type: "Warning", reason: "Other", kind: "Pod", count: 1 },
      { type: "Warning", reason: "Failed", kind: "Pod", count: 2 },
    ].sort((left, right) =>
      left.type.localeCompare(right.type)
      || left.reason.localeCompare(right.reason)
      || left.kind.localeCompare(right.kind)),
  });
  assert.equal(JSON.stringify(summary).includes("private-pod"), false);
  assert.equal(JSON.stringify(summary).includes("private-uid"), false);
});


test("first Spark fault child accepts only a sanitized terminal failure", () => {
  assert.deepEqual(
    validateFirstAttemptProcessResult({
      error: false,
      status: 0,
      stdout: JSON.stringify({
        status: "failed",
        attemptGeneration: 1,
      }),
    }),
    { mode: "terminal_manifest", status: "failed" },
  );
  assert.deepEqual(
    validateFirstAttemptProcessResult({
      error: false,
      status: 1,
      stdout: JSON.stringify({
        status: "blocked",
        errorType: "RuntimeError",
      }),
    }),
    { mode: "raised_failure", status: "failed" },
  );
  assert.throws(
    () =>
      validateFirstAttemptProcessResult({
        error: false,
        status: 0,
        stdout: JSON.stringify({
          status: "success",
          attemptGeneration: 1,
        }),
      }),
    Phase8BlockedError,
  );
});


test("private state is bound to contract, targets, candidate and scope", () => {
  const inputs = {
    contract: { approval: { scopeHash: "1".repeat(64) } },
    contractSha256: "2".repeat(64),
    liveInputSha256: "3".repeat(64),
    targetSelectionSha256: "4".repeat(64),
    candidateReceiptSha256: "5".repeat(64),
  };
  const state = {
    campaignId: "6".repeat(32),
    executionContractSha256: inputs.contractSha256,
    liveInputSha256: inputs.liveInputSha256,
    targetSelectionSha256: inputs.targetSelectionSha256,
    candidateReceiptSha256: inputs.candidateReceiptSha256,
    scopeHash: inputs.contract.approval.scopeHash,
  };
  assert.equal(validateStateBinding(state, inputs), true);
  assert.throws(
    () =>
      validateStateBinding(
        { ...state, targetSelectionSha256: "7".repeat(64) },
        inputs,
      ),
    Phase8BlockedError,
  );
});


test("A/B/C artifacts satisfy the reused Day 17 private path contract", () => {
  const paths = stateArtifactPaths({
    campaignId: "8".repeat(32),
  });
  assert.match(
    paths.abcReceipt,
    /^\/private\/tmp\/asklake-day17-[a-z0-9-]+[.]json$/,
  );
  assert.match(
    paths.abcResults,
    /^\/private\/tmp\/asklake-day17-[a-z0-9-]+[.]json$/,
  );
  assert.match(
    paths.msk,
    /^\/private\/tmp\/asklake-day18-[a-z0-9-]+[.]json$/,
  );
});


test("baseline counts unstarted Jobs and non-terminal SparkApplications as active", () => {
  assert.equal(
    countActiveJobs({
      items: [
        { metadata: {}, status: {} },
        {
          metadata: {},
          status: {
            conditions: [{ type: "Complete", status: "True" }],
          },
        },
      ],
    }),
    1,
  );
  assert.equal(
    countActiveSparkApplications({
      items: [
        {
          metadata: {},
          status: { applicationState: { state: "SUBMITTED" } },
        },
        {
          metadata: {},
          status: { applicationState: { state: "COMPLETED" } },
        },
      ],
    }),
    1,
  );
});


test("A/B/C receipt is exact-bound to all three approved targets", () => {
  const approvedTargets = ["A", "B", "C"].map((letter) => ({
    alias: `Run ${letter}`,
    jobId: `job-${letter}`,
    datasetId: `dataset-${letter}`,
    fixtureBatchId: "fixture-shared",
    consumerGroup: `group-${letter}`,
    icebergTable: `table_${letter}`,
    expectedCount: 100,
  }));
  const privateIdentity = approvedTargets.map((target) => ({
    ...target,
    runId: `run-${target.alias}`,
    outputPath: `s3a://private/output/${target.alias}`,
    checkpointPath: `s3a://private/checkpoint/${target.alias}`,
  }));
  const receipt = {
    status: "submitted",
    checks: {
      submittedExactlyThree: true,
      isolation: true,
    },
    privateIdentity,
  };
  assert.equal(
    validateAbcReceipt(receipt, approvedTargets),
    receipt,
  );
  const drifted = structuredClone(receipt);
  drifted.privateIdentity[1].consumerGroup = "group-drift";
  assert.throws(
    () => validateAbcReceipt(drifted, approvedTargets),
    Phase8BlockedError,
  );
});


test("persisted fault checkpoints recover lost local responses without widening scope", () => {
  assert.equal(
    classifyPersistedFaultCheckpoint("Run D", {
      campaignState: "msk_fault_recorded",
      executionGeneration: 1,
      faultAttemptCount: 1,
    }),
    "msk_fault_recorded",
  );
  assert.equal(
    classifyPersistedFaultCheckpoint("Run D", {
      campaignState: "airflow_submitted",
      executionGeneration: 2,
      faultAttemptCount: 1,
    }),
    "airflow_submitted",
  );
  assert.equal(
    classifyPersistedFaultCheckpoint("Run E", {
      campaignState: "airflow_submitted",
    }),
    "airflow_submitted",
  );
  assert.throws(
    () =>
      classifyPersistedFaultCheckpoint("Run D", {
        campaignState: "airflow_submitted",
        executionGeneration: 2,
        faultAttemptCount: 2,
      }),
    Phase8BlockedError,
  );
});


class FakeRunEResumeRunner {
  constructor({
    campaignState = "airflow_submitted",
    currentApplication = { attemptGeneration: 2 },
  } = {}) {
    this.calls = [];
    this.campaignState = campaignState;
    this.currentApplication = currentApplication;
  }

  incluster(payload) {
    this.calls.push(payload.action);
    if (payload.action === "inspect") {
      return {
        value: {
          runStatus: "success",
          airflowState: "success",
          sparkResultStatus: "success",
          catalogStatus: "success",
          campaignState: this.campaignState,
          currentApplication: this.currentApplication,
        },
      };
    }
    if (payload.action === "verify") {
      return {
        value: {
          status: "passed",
          generation: 2,
          checks: { exactOnce: true },
        },
      };
    }
    throw new Error(`unexpected action: ${payload.action}`);
  }

  inclusterAsync() {
    this.calls.push("execute_async");
    throw new Error("unexpected async execution");
  }

  json() {
    this.calls.push("json");
    throw new Error("unexpected Kubernetes mutation");
  }
}


function runEResumeFixture(directory, stateName) {
  return {
    inputs: {
      statePath: join(directory, stateName),
      liveInput: {
        targets: {
          faults: [
            {
              alias: "Run E",
              sourceAlias: "Run B",
            },
          ],
        },
      },
    },
    state: {
      phase: "run_e_airflow_submitted",
      campaignId: "d".repeat(32),
      runs: {
        "Run E": {
          state: "airflow_submitted",
          identity: { runId: "private-run" },
          timeline: [],
          firstAttemptFailedAt: "2026-07-19T00:00:20Z",
          driverFault: {
            applicationName: "private-app",
            applicationUid: "private-app-uid",
            podName: "private-driver",
            podUid: "private-driver-uid",
            injectedAt: "2026-07-19T00:00:10Z",
          },
          observability: { status: "passed" },
        },
      },
    },
  };
}


test("Run E resume after Airflow submission never re-executes or re-deletes", async () => {
  const directory = mkdtempSync("/private/tmp/asklake-phase8-run-e-");
  try {
    const { inputs, state } = runEResumeFixture(directory, "state.json");
    const runner = new FakeRunEResumeRunner();
    const completed = await runFaultE(inputs, runner, state);
    assert.equal(completed.runs["Run E"].state, "passed");
    assert.deepEqual(runner.calls, ["inspect", "verify"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("Run E recovers an RDS submission marker after local checkpoint loss", async () => {
  const directory = mkdtempSync("/private/tmp/asklake-phase8-run-e-");
  try {
    const { inputs, state } = runEResumeFixture(directory, "state.json");
    state.phase = "run_e_first_attempt_failed";
    state.runs["Run E"].state = "first_attempt_failed";
    const runner = new FakeRunEResumeRunner();
    const completed = await runFaultE(inputs, runner, state);
    assert.equal(completed.runs["Run E"].state, "passed");
    assert.equal(runner.calls.includes("submit"), false);
    assert.deepEqual(runner.calls, ["inspect", "inspect", "verify"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("Run E ambiguous armed checkpoint stops without a second execution", async () => {
  const directory = mkdtempSync("/private/tmp/asklake-phase8-run-e-");
  try {
    const { inputs, state } = runEResumeFixture(directory, "state.json");
    state.phase = "run_e_first_attempt_armed";
    state.runs["Run E"] = {
      ...state.runs["Run E"],
      state: "first_attempt_armed",
      firstAttemptFailedAt: undefined,
      driverFault: undefined,
      observability: undefined,
    };
    const runner = new FakeRunEResumeRunner({
      currentApplication: {},
    });
    await assert.rejects(
      runFaultE(inputs, runner, state),
      (error) =>
        error instanceof Phase8BlockedError
        && error.code === "run_e_first_attempt_outcome_ambiguous",
    );
    assert.deepEqual(runner.calls, ["inspect"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


class FakeCleanupRunner {
  constructor() {
    this.calls = [];
  }

  run(command, args) {
    this.calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  }

  incluster(payload) {
    this.calls.push({ command: "incluster", args: [payload.action] });
    return {
      value: {
        status: "passed",
        checks: { allSteady: true },
        counts: {
          continuousRuntimes: 1,
          continuousSessions: 4,
        },
      },
    };
  }

  json(command, args) {
    this.calls.push({ command, args });
    const joined = args.join(" ");
    if (joined.includes("get jobs")) return { items: [] };
    if (joined.includes("get sparkapplications.sparkoperator.k8s.io")) {
      return { items: [] };
    }
    if (joined.includes("get pods")) return { items: [] };
    if (joined.includes("get hpa fastapi")) {
      return { status: { currentReplicas: 2, desiredReplicas: 2 } };
    }
    if (joined.includes("get deployment fastapi")) {
      return { status: { readyReplicas: 2 } };
    }
    if (joined.includes("get deployment trino-result-collector")) {
      return { status: { readyReplicas: 1 } };
    }
    if (joined.includes("get nodes")) {
      return {
        items: [
          {
            metadata: {
              labels: { "karpenter.sh/nodepool": "asklake-general" },
            },
          },
          {
            metadata: {
              labels: { "karpenter.sh/nodepool": "asklake-spark" },
            },
          },
        ],
      };
    }
    throw new Error(`unexpected cleanup command: ${command} ${joined}`);
  }
}


test("bounded cleanup remains available before A/B/C success", async () => {
  const directory = mkdtempSync("/private/tmp/asklake-phase8-cleanup-");
  try {
    const inputs = {
      candidateReceipt: { images: { backend: IMAGE } },
      statePath: join(directory, "state.json"),
      ec2Env: "/private/tmp/ec2.env",
      liveInput: {
        targets: {
          bounded: [
            { alias: "Run A" },
            { alias: "Run B" },
            { alias: "Run C" },
          ],
        },
      },
    };
    const state = {
      phase: "run_e_driver_deleted",
      campaignId: "e".repeat(32),
      artifacts: {
        msk: join(directory, "missing-msk.json"),
      },
      baseline: {
        continuousRuntimes: 1,
        continuousSessions: 4,
        nodes: { general: 1, spark: 1 },
      },
      runs: {},
    };
    const runner = new FakeCleanupRunner();
    const cleaned = await runCleanup(inputs, runner, state);
    assert.equal(cleaned.phase, "cleanup_passed");
    assert.equal(cleaned.cleanup.temporaryJobs, 0);
    assert.equal(cleaned.cleanup.temporaryPods, 0);
    assert.equal(cleaned.cleanup.explicitlyDeletedJobs, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


class FakePreflightRunner {
  constructor() {
    this.calls = [];
  }

  run(command, args, options = {}) {
    this.calls.push({ command, args, input: options.input ?? "" });
    return { status: 0, stdout: "", stderr: "" };
  }

  json(command, args, options = {}) {
    this.calls.push({ command, args, input: options.input ?? "" });
    const joined = args.join(" ");
    if (command === "aws" && joined.includes("list-pod-identity-associations")) {
      return { associations: [{ associationId: "association-private" }] };
    }
    if (
      command === "aws"
      && joined.includes("describe-pod-identity-association")
    ) {
      return {
        association: {
          roleArn: "arn:aws:iam::123456789012:role/describe-only",
        },
      };
    }
    if (command === "aws" && joined.includes("list-role-policies")) {
      return { PolicyNames: [] };
    }
    if (command === "aws" && joined.includes("list-attached-role-policies")) {
      return {
        AttachedPolicies: [
          {
            PolicyArn:
              "arn:aws:iam::123456789012:policy/describe-only",
          },
        ],
      };
    }
    if (
      command === "aws"
      && joined.includes("get-policy ")
      && !joined.includes("get-policy-version")
    ) {
      return { Policy: { DefaultVersionId: "v1" } };
    }
    if (command === "aws" && joined.includes("get-policy-version")) {
      return { PolicyVersion: { Document: exactDescribeOnlyDocument() } };
    }
    if (command === "kubectl" && joined.includes("apply --dry-run=server")) {
      return JSON.parse(options.input);
    }
    if (
      command === "kubectl"
      && joined.includes("get deployment fastapi")
    ) {
      return deployment("fastapi", 2);
    }
    if (
      command === "kubectl"
      && joined.includes("get deployment trino-result-collector")
    ) {
      return deployment("trino-result-collector", 1);
    }
    if (command === "kubectl" && joined.includes("get jobs")) {
      return { items: [] };
    }
    if (
      command === "kubectl"
      && joined.includes("get sparkapplications.sparkoperator.k8s.io")
    ) {
      return { items: [] };
    }
    if (command === "kubectl" && joined.includes("get hpa fastapi")) {
      return {
        status: {
          currentReplicas: 2,
          desiredReplicas: 2,
        },
      };
    }
    if (command === "kubectl" && joined.includes("get pods")) {
      const collector = joined.includes("trino-result-collector");
      const count = collector ? 1 : 2;
      const container = collector
        ? "trino-result-collector"
        : "fastapi";
      return {
        items: Array.from({ length: count }, (_, index) => ({
          metadata: { name: `pod-${index}` },
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: container,
                ready: true,
                restartCount: 0,
                imageID: `registry.invalid/image@${DIGEST}`,
              },
            ],
          },
        })),
      };
    }
    if (command === "kubectl" && joined.includes("get nodes")) {
      return {
        items: [
          {
            metadata: {
              labels: { "karpenter.sh/nodepool": "asklake-general" },
            },
          },
          {
            metadata: {
              labels: { "karpenter.sh/nodepool": "asklake-spark" },
            },
          },
        ],
      };
    }
    throw new Error(`unexpected fake command: ${command} ${joined}`);
  }

  incluster(payload) {
    this.calls.push({ command: "incluster", args: [payload.action] });
    return {
      value: {
        status: "passed",
        checks: {
          day17PreflightPassed: true,
          approvedTargetsExact: true,
          activeFixtureRunsZero: true,
          continuousRowsReadable: true,
          sparkApplicationsReadable: true,
        },
        counts: {
          continuousRuntimes: 1,
          continuousSessions: 4,
        },
      },
    };
  }
}


function deployment(name, ready) {
  return {
    spec: {
      template: {
        spec: {
          containers: [{ name, image: IMAGE }],
        },
      },
    },
    status: {
      readyReplicas: ready,
      availableReplicas: ready,
    },
  };
}


test("preflight creates only a mode-0600 state after read-only and dry-run checks", () => {
  const directory = mkdtempSync("/private/tmp/asklake-phase8-test-");
  const statePath = join(directory, "state.json");
  const inputs = {
    candidateReceipt: { images: { backend: IMAGE } },
    candidateReceiptPath: "/private/tmp/candidate.json",
    candidateReceiptSha256: "1".repeat(64),
    contract: { approval: { scopeHash: "2".repeat(64) } },
    contractSha256: "3".repeat(64),
    liveInput: {
      cluster: { name: "cluster-private" },
      targets: {
        bounded: [
          { alias: "Run A" },
          { alias: "Run B" },
          { alias: "Run C" },
        ],
      },
    },
    liveInputSha256: "4".repeat(64),
    targetSelectionSha256: "5".repeat(64),
    statePath,
    ec2Env: "/private/tmp/ec2.env",
  };
  const runner = new FakePreflightRunner();
  const state = runPreflight(inputs, runner);
  assert.equal(state.phase, "preflight_passed");
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(statePath)).phase, "preflight_passed");
  assert.equal(
    runner.calls.some(
      ({ command, args }) =>
        command === "kubectl"
        && args[0] === "create",
    ),
    false,
  );
  assert.equal(
    runner.calls.some(
      ({ command, args }) =>
        command === "kubectl"
        && args[0] === "delete",
    ),
    false,
  );
  unlinkSync(statePath);
  rmSync(directory, { recursive: true, force: true });
});


test("mutating mode fails before runner calls when confirmation is absent", async () => {
  const previous = process.env.ASKLAKE_DAY18_PHASE8_CONFIRM;
  delete process.env.ASKLAKE_DAY18_PHASE8_CONFIRM;
  const runner = new FakePreflightRunner();
  await assert.rejects(
    executeMode({
      mode: "run-d",
      inputs: {},
      runner,
    }),
    (error) =>
      error instanceof Phase8BlockedError
      && error.code === "explicit_phase8_confirmation_missing",
  );
  assert.equal(runner.calls.length, 0);
  if (previous !== undefined) {
    process.env.ASKLAKE_DAY18_PHASE8_CONFIRM = previous;
  }
});


test("CLI exposes only the approved phase modes", () => {
  assert.equal(parseArguments(["--preflight"]), "preflight");
  assert.equal(parseArguments(["--all"]), "all");
  assert.throws(() => parseArguments(["--unsafe"]), Phase8BlockedError);
});
