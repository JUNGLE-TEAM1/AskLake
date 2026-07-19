#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateExecutionContract,
  validatePrivateExecutionContractFile,
} from "./verify-eks-day18-execution-contract.mjs";
import {
  loadAndVerifyDay18LiveInput,
} from "./verify-eks-day18-live-input.mjs";


const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INCLUSTER_SOURCE = resolve(
  ROOT_DIR,
  "scripts/run_eks_day18_phase8_incluster.py",
);
const NAMESPACE = "asklake-dev";
const REGION = "ap-northeast-2";
const SERVICE_ACCOUNT = "asklake-msk-smoke";
const RUNTIME_CONFIG_MAP = "asklake-runtime";
const FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1";
const CONFIRMATION = "run-approved-day18-phase8-fault-and-e2e";
const MUTATING_MODES = new Set(["run-d", "run-e", "run-abc", "cleanup", "all"]);
const TERMINAL_FAILED_STATES = new Set(["FAILED", "SUBMISSION_FAILED"]);


export class Phase8BlockedError extends Error {
  constructor(code, phase = "input_validation") {
    super(code);
    this.name = "Phase8BlockedError";
    this.code = code;
    this.phase = phase;
  }
}


function block(code, phase) {
  throw new Phase8BlockedError(code, phase);
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function sha256File(path) {
  return sha256(readFileSync(path));
}


function shortHash(value) {
  return sha256(String(value ?? "")).slice(0, 12);
}


function portablePrivatePath(path, label, { mustExist = true } = {}) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    if (mustExist) block(`${label}_missing`);
    let parent;
    try {
      parent = realpathSync(dirname(resolved));
    } catch {
      block(`${label}_parent_unavailable`);
    }
    if (parent !== "/private/tmp" && !parent.startsWith("/private/tmp/")) {
      block(`${label}_outside_private_tmp`);
    }
    return resolved;
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    block(`${label}_symlink_not_allowed`);
  }
  const real = realpathSync(resolved);
  if (!real.startsWith("/private/tmp/")) {
    block(`${label}_outside_private_tmp`);
  }
  if ((statSync(real).mode & 0o777) !== 0o600) {
    block(`${label}_mode_not_0600`);
  }
  return real;
}


function readPrivateJson(path, label) {
  const resolved = portablePrivatePath(path, label);
  try {
    return {
      bytes: readFileSync(resolved),
      path: resolved,
      value: JSON.parse(readFileSync(resolved, "utf8")),
    };
  } catch {
    block(`${label}_invalid_json`);
  }
}


function writeExclusivePrivateJson(path, value) {
  const resolved = portablePrivatePath(path, "private_output", {
    mustExist: false,
  });
  const descriptor = openSync(
    resolved,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(resolved, 0o600);
}


function writeAtomicPrivateJson(path, value) {
  const resolved = portablePrivatePath(path, "phase8_state", {
    mustExist: false,
  });
  const temporary = `${resolved}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, resolved);
    chmodSync(resolved, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}


function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}


export function validateRoundTripEvidence(evidence, candidateImage) {
  const revisions = [
    Number(evidence?.prior?.helmRevision),
    Number(evidence?.candidate?.firstPromotionRevision),
    Number(evidence?.candidate?.rollbackRevision),
    Number(evidence?.candidate?.finalPromotionRevision),
  ];
  const checks = {
    statePassed: evidence?.state === "candidate_repromotion_passed",
    candidateImageExact:
      typeof candidateImage === "string"
      && evidence?.candidate?.backendImage === candidateImage,
    rollbackImageDifferent:
      typeof evidence?.prior?.backendImage === "string"
      && evidence.prior.backendImage !== candidateImage,
    revisionSequence:
      revisions.every(Number.isSafeInteger)
      && revisions[0] < revisions[1]
      && revisions[1] < revisions[2]
      && revisions[2] < revisions[3],
  };
  if (!Object.values(checks).every(Boolean)) {
    block("phase7_round_trip_not_passed");
  }
  return checks;
}


export function validateDescribeOnlyPolicy({
  documents,
  attachedPolicyCount,
  inlinePolicyCount,
}) {
  const errors = [];
  if (attachedPolicyCount !== 1) errors.push("managed_policy_count");
  if (inlinePolicyCount !== 0) errors.push("inline_policy_present");
  if (!Array.isArray(documents) || documents.length !== 1) {
    errors.push("policy_document_missing");
  }
  const allowed = [];
  for (const document of documents ?? []) {
    const statements = Array.isArray(document?.Statement)
      ? document.Statement
      : [document?.Statement].filter(Boolean);
    for (const statement of statements) {
      if (Object.hasOwn(statement ?? {}, "NotAction")) {
        errors.push("not_action_present");
      }
      if (statement?.Effect !== "Allow") continue;
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      for (const action of actions) {
        for (const resource of resources) allowed.push({ action, resource });
      }
    }
  }
  const actions = [...new Set(allowed.map(({ action }) => action))].sort();
  const expectedActions = [
    "kafka-cluster:Connect",
    "kafka-cluster:DescribeTopic",
  ];
  if (JSON.stringify(actions) !== JSON.stringify(expectedActions)) {
    errors.push("actions_not_describe_only");
  }
  if (
    allowed.some(
      ({ action, resource }) =>
        typeof action !== "string"
        || typeof resource !== "string"
        || action.includes("*")
        || resource.includes("*"),
    )
  ) {
    errors.push("wildcard_present");
  }
  const clusterResources = [
    ...new Set(
      allowed
        .filter(({ action }) => action === "kafka-cluster:Connect")
        .map(({ resource }) => resource),
    ),
  ];
  const topicResources = [
    ...new Set(
      allowed
        .filter(({ action }) => action === "kafka-cluster:DescribeTopic")
        .map(({ resource }) => resource),
    ),
  ];
  if (
    clusterResources.length !== 1
    || !/^arn:aws:kafka:[^:]+:\d{12}:cluster\/[^/]+\/[^/]+$/.test(
      clusterResources[0] ?? "",
    )
  ) {
    errors.push("cluster_resource_invalid");
  }
  if (
    topicResources.length !== 1
    || !new RegExp(
      `^arn:aws:kafka:[^:]+:\\d{12}:topic/[^/]+/[^/]+/${FIXTURE_TOPIC.replaceAll(".", "[.]")}$`,
    ).test(topicResources[0] ?? "")
  ) {
    errors.push("topic_resource_invalid");
  }
  if (errors.length > 0) block(`msk_policy_${errors[0]}`);
  return {
    actionCount: actions.length,
    clusterArn: clusterResources[0],
    topic: FIXTURE_TOPIC,
  };
}


export function renderDenyProbeJob({
  campaignId,
  image,
  name = `asklake-day18-msk-deny-${campaignId.slice(0, 12)}`,
}) {
  const batchId = `eks-mvp-day18-deny-${campaignId.slice(0, 16)}`;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        "app.kubernetes.io/name": "asklake-day18-msk-deny-probe",
        "asklake.io/day18-fault": "msk-authorization-deny",
        "asklake.io/day18-campaign": campaignId.slice(0, 32),
        "asklake.io/temporary": "true",
      },
    },
    spec: {
      activeDeadlineSeconds: 180,
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "asklake-day18-msk-deny-probe",
            "asklake.io/day18-fault": "msk-authorization-deny",
            "asklake.io/day18-campaign": campaignId.slice(0, 32),
            "asklake.io/temporary": "true",
          },
        },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "deny-probe",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "scripts/produce-eks-msk-fixture.mjs"],
              env: [
                {
                  name: "AWS_REGION",
                  valueFrom: {
                    configMapKeyRef: {
                      name: RUNTIME_CONFIG_MAP,
                      key: "AWS_REGION",
                    },
                  },
                },
                {
                  name: "ASKLAKE_KAFKA_BROKER",
                  valueFrom: {
                    configMapKeyRef: {
                      name: RUNTIME_CONFIG_MAP,
                      key: "ASKLAKE_KAFKA_BROKER",
                    },
                  },
                },
                { name: "ASKLAKE_FIXTURE_TOPIC", value: FIXTURE_TOPIC },
                { name: "ASKLAKE_FIXTURE_BATCH_ID", value: batchId },
                { name: "ASKLAKE_FIXTURE_EXPECTED_COUNT", value: "1" },
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "256Mi" },
              },
            },
          ],
          nodeSelector: {
            "asklake.io/workload-class": "general",
            "kubernetes.io/arch": "amd64",
          },
          restartPolicy: "Never",
          serviceAccountName: SERVICE_ACCOUNT,
        },
      },
    },
  };
}


export function validateDenyProbeJob(
  manifest,
  expectedImage,
  { campaignId, expectedName } = {},
) {
  const pod = manifest?.spec?.template?.spec ?? {};
  const container = pod.containers?.[0] ?? {};
  const env = new Map((container.env ?? []).map((item) => [item.name, item]));
  const labels = manifest?.metadata?.labels ?? {};
  const podLabels = manifest?.spec?.template?.metadata?.labels ?? {};
  const expectedCampaign = campaignId?.slice(0, 32);
  const checks = [
    manifest?.apiVersion === "batch/v1",
    manifest?.kind === "Job",
    manifest?.metadata?.namespace === NAMESPACE,
    !expectedName || manifest?.metadata?.name === expectedName,
    labels["app.kubernetes.io/name"]
      === "asklake-day18-msk-deny-probe",
    labels["asklake.io/day18-fault"] === "msk-authorization-deny",
    labels["asklake.io/temporary"] === "true",
    podLabels["app.kubernetes.io/name"]
      === "asklake-day18-msk-deny-probe",
    podLabels["asklake.io/day18-fault"] === "msk-authorization-deny",
    podLabels["asklake.io/temporary"] === "true",
    !expectedCampaign
      || (
        labels["asklake.io/day18-campaign"] === expectedCampaign
        && podLabels["asklake.io/day18-campaign"] === expectedCampaign
      ),
    manifest?.spec?.backoffLimit === 0,
    manifest?.spec?.activeDeadlineSeconds === 180,
    manifest?.spec?.ttlSecondsAfterFinished === 300,
    pod.serviceAccountName === SERVICE_ACCOUNT,
    pod.automountServiceAccountToken === false,
    pod.restartPolicy === "Never",
    pod.hostNetwork !== true,
    pod.hostPID !== true,
    pod.hostIPC !== true,
    (pod.containers ?? []).length === 1,
    (pod.initContainers ?? []).length === 0,
    (pod.volumes ?? []).length === 0,
    container.image === expectedImage,
    /@sha256:[a-f0-9]{64}$/.test(container.image ?? ""),
    JSON.stringify(container.command)
      === JSON.stringify(["node", "scripts/produce-eks-msk-fixture.mjs"]),
    env.size === 5,
    env.get("ASKLAKE_FIXTURE_TOPIC")?.value === FIXTURE_TOPIC,
    env.get("ASKLAKE_FIXTURE_EXPECTED_COUNT")?.value === "1",
    /^eks-mvp-day18-deny-[a-f0-9]{16}$/.test(
      env.get("ASKLAKE_FIXTURE_BATCH_ID")?.value ?? "",
    ),
    !campaignId
      || env.get("ASKLAKE_FIXTURE_BATCH_ID")?.value
        === `eks-mvp-day18-deny-${campaignId.slice(0, 16)}`,
    env.get("AWS_REGION")?.valueFrom?.configMapKeyRef?.name
      === RUNTIME_CONFIG_MAP,
    env.get("AWS_REGION")?.valueFrom?.configMapKeyRef?.key === "AWS_REGION",
    env.get("ASKLAKE_KAFKA_BROKER")?.valueFrom?.configMapKeyRef?.name
      === RUNTIME_CONFIG_MAP,
    env.get("ASKLAKE_KAFKA_BROKER")?.valueFrom?.configMapKeyRef?.key
      === "ASKLAKE_KAFKA_BROKER",
    pod.nodeSelector?.["asklake.io/workload-class"] === "general",
    pod.nodeSelector?.["kubernetes.io/arch"] === "amd64",
  ];
  if (!checks.every(Boolean)) block("deny_probe_manifest_invalid");
  return true;
}


export function parseDenyProbeLog(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) block("deny_probe_attempt_count_not_one");
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch {
    block("deny_probe_log_invalid_json");
  }
  const protocolCodes = [
    record?.code,
    record?.causeCode,
  ].map((value) => String(value ?? "").toUpperCase());
  const protocolCode = protocolCodes.find(
    (value) =>
      value === "29"
      || value === "31"
      || value.includes("TOPIC_AUTHORIZATION_FAILED")
      || value.includes("CLUSTER_AUTHORIZATION_FAILED"),
  );
  if (
    !record
    || typeof record !== "object"
    || Array.isArray(record)
    || record.status !== "failed"
    || record.category !== "AUTHORIZATION"
    || !protocolCode
    || Object.hasOwn(record, "producedCount")
    || Number(record.acknowledgedMessages ?? 0) !== 0
  ) {
    block("deny_probe_not_exact_authorization_failure");
  }
  return {
    acknowledgedMessages: 0,
    attemptedMessages: 1,
    category: "AUTHORIZATION",
    // KafkaJS enables idempotent production for the normal fixture producer.
    // With the exact Describe-only IAM role, MSK can therefore reject the
    // cluster-scoped idempotent-write request (31) before the topic write (29).
    // Both are exact protocol authorization failures with zero acknowledgement.
    protocolCode: protocolCode.includes("TOPIC_")
      ? "29"
      : protocolCode.includes("CLUSTER_")
        ? "31"
        : protocolCode,
    evidenceSha256: sha256(Buffer.from(String(raw))),
  };
}


function eventTimestampMs(event) {
  const value =
    event?.eventTime
    || event?.lastTimestamp
    || event?.firstTimestamp
    || event?.metadata?.creationTimestamp;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}


function sanitizedEventToken(value) {
  const normalized = String(value ?? "Unknown");
  return /^[A-Za-z0-9_.-]{1,80}$/.test(normalized)
    ? normalized
    : "Other";
}


export function summarizeFaultObservability({
  cloudWatchEvents,
  cloudWatchMarker,
  endTimeMs,
  events,
  requiredCloudWatchTerm,
  resourceIdentities,
  startTimeMs,
}) {
  if (
    !Number.isSafeInteger(startTimeMs)
    || !Number.isSafeInteger(endTimeMs)
    || startTimeMs >= endTimeMs
    || !Array.isArray(resourceIdentities)
    || resourceIdentities.length === 0
    || typeof cloudWatchMarker !== "string"
    || cloudWatchMarker.length === 0
  ) {
    block("fault_observability_input_invalid");
  }
  const identities = new Set(resourceIdentities.filter(Boolean));
  const grouped = new Map();
  let eventCount = 0;
  for (const event of events?.items ?? []) {
    const at = eventTimestampMs(event);
    const involved = event?.involvedObject ?? {};
    if (
      at === null
      || at < startTimeMs
      || at > endTimeMs
      || (!identities.has(involved.uid) && !identities.has(involved.name))
    ) {
      continue;
    }
    const count = Math.max(
      1,
      Number(event?.series?.count ?? event?.count ?? 1) || 1,
    );
    eventCount += count;
    const key = JSON.stringify([
      sanitizedEventToken(event?.type),
      sanitizedEventToken(event?.reason),
      sanitizedEventToken(involved?.kind),
    ]);
    grouped.set(key, (grouped.get(key) ?? 0) + count);
  }
  const eventSummary = [...grouped.entries()]
    .map(([key, count]) => {
      const [type, reason, kind] = JSON.parse(key);
      return { type, reason, kind, count };
    })
    .sort(
      (left, right) =>
        left.type.localeCompare(right.type)
        || left.reason.localeCompare(right.reason)
        || left.kind.localeCompare(right.kind),
    );
  const cloudWatchMarkerCount = (cloudWatchEvents ?? []).filter((event) => {
    const timestamp = Number(event?.timestamp);
    const message = String(event?.message ?? "");
    return (
      Number.isFinite(timestamp)
      && timestamp >= startTimeMs
      && timestamp <= endTimeMs
      && message.includes(cloudWatchMarker)
      && (
        !requiredCloudWatchTerm
        || message.includes(requiredCloudWatchTerm)
      )
    );
  }).length;
  return {
    cloudWatchMarkerCount,
    eventCount,
    eventSummary,
  };
}


export function validateDriverPod(
  pod,
  {
    applicationName,
    applicationUid,
    driverPodName,
  },
) {
  const labels = pod?.metadata?.labels ?? {};
  const owners = pod?.metadata?.ownerReferences ?? [];
  const role = labels["spark-role"] || labels["sparkoperator.k8s.io/role"];
  const appLabel =
    labels["sparkoperator.k8s.io/app-name"]
    || labels["spark-app-name"]
    || labels["sparkoperator.k8s.io/app-name"];
  const checks = {
    exactName: pod?.metadata?.name === driverPodName,
    exactApplicationLabel: appLabel === applicationName,
    driverRole: role === "driver",
    exactOwnerUid: owners.some(
      (owner) =>
        owner?.uid === applicationUid
        && owner?.kind === "SparkApplication",
    ),
    active:
      !pod?.metadata?.deletionTimestamp
      && ["Pending", "Running"].includes(pod?.status?.phase),
    uidPresent: typeof pod?.metadata?.uid === "string"
      && pod.metadata.uid.length > 0,
  };
  if (!Object.values(checks).every(Boolean)) {
    block("driver_pod_identity_mismatch", "run_e_fault");
  }
  return {
    podUid: pod.metadata.uid,
    checks,
  };
}


export function validateStateBinding(state, inputs) {
  const checks = {
    contract: state?.executionContractSha256 === inputs.contractSha256,
    liveInput: state?.liveInputSha256 === inputs.liveInputSha256,
    targetSelection:
      state?.targetSelectionSha256 === inputs.targetSelectionSha256,
    candidateReceipt:
      state?.candidateReceiptSha256 === inputs.candidateReceiptSha256,
    scope: state?.scopeHash === inputs.contract.approval.scopeHash,
    campaign: /^[a-f0-9]{32}$/.test(state?.campaignId ?? ""),
  };
  if (!Object.values(checks).every(Boolean)) {
    block("phase8_state_binding_mismatch");
  }
  return true;
}


export function loadPhase8Inputs(environment = process.env) {
  const required = {
    executionContract:
      environment.ASKLAKE_DAY18_EXECUTION_CONTRACT,
    liveInput: environment.ASKLAKE_DAY18_LIVE_INPUT,
    candidateReceipt: environment.ASKLAKE_DAY18_IMAGE_RECEIPT,
    roundTripEvidence:
      environment.ASKLAKE_DAY18_ROUND_TRIP_PRIVATE_EVIDENCE,
    ec2Env: environment.ASKLAKE_DAY18_EC2_ENV,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) block(`${key}_not_configured`);
  }

  const execution = readPrivateJson(
    required.executionContract,
    "execution_contract",
  );
  const contractErrors = [
    ...validatePrivateExecutionContractFile(execution.path),
    ...validateExecutionContract(execution.value, { execution: true }),
  ];
  if (contractErrors.length > 0) block("execution_contract_not_approved");

  let verifiedLiveInput;
  try {
    verifiedLiveInput = loadAndVerifyDay18LiveInput(required.liveInput);
  } catch {
    block("live_input_not_verified");
  }
  if (
    execution.value.liveInputEvidence.inputSha256
      !== verifiedLiveInput.inputSha256
    || execution.value.liveInputEvidence.targetSelectionSha256
      !== verifiedLiveInput.targetSelectionSha256
  ) {
    block("live_input_not_bound_to_contract");
  }
  const candidate = readPrivateJson(
    required.candidateReceipt,
    "candidate_receipt",
  );
  const candidateHash = sha256(candidate.bytes);
  if (
    execution.value.images.candidate.receiptSha256 !== candidateHash
    || execution.value.images.candidate.gitRevision
      !== candidate.value.gitRevision
  ) {
    block("candidate_receipt_not_bound_to_contract");
  }
  const roundTrip = readPrivateJson(
    required.roundTripEvidence,
    "round_trip_evidence",
  );
  validateRoundTripEvidence(
    roundTrip.value,
    candidate.value?.images?.backend,
  );
  const ec2Env = portablePrivatePath(required.ec2Env, "ec2_env");
  if (
    sha256File(ec2Env)
      !== verifiedLiveInput.liveInput.preservedEc2.envFileSha256
  ) {
    block("ec2_env_not_bound_to_live_input");
  }
  if (
    environment.ASKLAKE_EKS_CLUSTER_NAME
      !== verifiedLiveInput.liveInput.cluster.name
  ) {
    block("exact_cluster_name_not_exported");
  }
  const statePath = portablePrivatePath(
    environment.ASKLAKE_DAY18_PHASE8_STATE
      || "/private/tmp/asklake-day18-phase8-state.json",
    "phase8_state",
    { mustExist: false },
  );
  return {
    candidateReceipt: candidate.value,
    candidateReceiptPath: candidate.path,
    candidateReceiptSha256: candidateHash,
    contract: execution.value,
    contractPath: execution.path,
    contractSha256: sha256(execution.bytes),
    ec2Env,
    liveInput: verifiedLiveInput.liveInput,
    liveInputPath: resolve(required.liveInput),
    liveInputSha256: verifiedLiveInput.inputSha256,
    roundTripEvidence: roundTrip.value,
    roundTripEvidencePath: roundTrip.path,
    statePath,
    targetSelectionSha256: verifiedLiveInput.targetSelectionSha256,
  };
}


export class SystemCommandRunner {
  constructor({ environment = process.env } = {}) {
    this.environment = environment;
    this.inclusterSource = readFileSync(INCLUSTER_SOURCE, "utf8");
  }

  run(command, args, {
    allowFailure = false,
    environment = this.environment,
    input,
    timeout = 60_000,
  } = {}) {
    const result = spawnSync(command, args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: environment,
      input,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    });
    const normalized = {
      ...result,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
    if (!allowFailure && (normalized.error || normalized.status !== 0)) {
      block(`${basename(command)}_command_failed`);
    }
    return normalized;
  }

  json(command, args, options) {
    const result = this.run(command, args, options);
    try {
      return JSON.parse(result.stdout);
    } catch {
      block(`${basename(command)}_invalid_json`);
    }
  }

  incluster(payload, { allowFailure = false, timeout = 120_000 } = {}) {
    const podName = this.fastApiPodName();
    const result = this.run(
      "kubectl",
      [
        "exec",
        "-i",
        podName,
        "-n",
        NAMESPACE,
        "-c",
        "fastapi",
        "--",
        "python",
        "-c",
        this.inclusterSource,
      ],
      {
        allowFailure,
        input: JSON.stringify(payload),
        timeout,
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      block("incluster_invalid_json");
    }
    if (!allowFailure && (result.status !== 0 || parsed?.status === "blocked")) {
      block("incluster_action_blocked");
    }
    return { result, value: parsed };
  }

  inclusterAsync(payload) {
    const podName = this.fastApiPodName();
    const child = spawn(
      "kubectl",
      [
        "exec",
        "-i",
        podName,
        "-n",
        NAMESPACE,
        "-c",
        "fastapi",
        "--",
        "python",
        "-c",
        this.inclusterSource,
      ],
      {
        cwd: ROOT_DIR,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 32 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stdin.end(JSON.stringify(payload));
    const completed = new Promise((resolvePromise) => {
      child.once("error", () =>
        resolvePromise({ status: null, stdout, stderr, error: true }));
      child.once("close", (status) =>
        resolvePromise({ status, stdout, stderr, error: false }));
    });
    return { child, completed };
  }

  fastApiPodName() {
    return selectReadyFastApiPod(this.json("kubectl", [
      "get",
      "pods",
      "-n",
      NAMESPACE,
      "-l",
      "app.kubernetes.io/name=asklake,app.kubernetes.io/component=backend",
      "-o",
      "json",
    ]));
  }
}


export function selectReadyFastApiPod(pods) {
  const candidates = (pods?.items ?? [])
    .filter((pod) =>
      !pod?.metadata?.deletionTimestamp
      && pod?.status?.phase === "Running"
      && (pod?.status?.containerStatuses ?? []).some(
        (container) => container?.name === "fastapi" && container?.ready === true,
      ))
    .sort((left, right) =>
      String(left?.metadata?.creationTimestamp ?? "").localeCompare(
        String(right?.metadata?.creationTimestamp ?? ""),
      ));
  const name = candidates[0]?.metadata?.name;
  if (typeof name !== "string" || name.length === 0) {
    block("fastapi_ready_pod_unavailable");
  }
  return name;
}


function baseFaultRequest(state, inputs, alias) {
  const source = inputs.liveInput.targets.faults.find(
    (target) => target.alias === alias,
  );
  const identity = state.runs?.[alias]?.identity;
  return {
    action: "inspect",
    alias,
    campaignId: state.campaignId,
    identity,
    target: source,
  };
}


export function stateArtifactPaths(state) {
  const suffix = state.campaignId.slice(0, 12);
  return {
    msk:
      `/private/tmp/asklake-day18-phase8-msk-${suffix}.json`,
    abcReceipt:
      `/private/tmp/asklake-day17-phase8-abc-${suffix}.json`,
    abcResults:
      `/private/tmp/asklake-day17-phase8-abc-results-${suffix}.json`,
  };
}


function updateState(inputs, state, patch) {
  const next = {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeAtomicPrivateJson(inputs.statePath, next);
  return next;
}


function initialState(inputs, baseline) {
  const campaignId = randomBytes(16).toString("hex");
  const state = {
    contractVersion: "1.0",
    campaign: "eks-day18-phase8",
    campaignId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    executionContractSha256: inputs.contractSha256,
    liveInputSha256: inputs.liveInputSha256,
    targetSelectionSha256: inputs.targetSelectionSha256,
    candidateReceiptSha256: inputs.candidateReceiptSha256,
    scopeHash: inputs.contract.approval.scopeHash,
    phase: "preflight_passed",
    baseline,
    runs: {},
    evidence: {},
  };
  state.artifacts = stateArtifactPaths(state);
  writeExclusivePrivateJson(inputs.statePath, state);
  return state;
}


function loadState(inputs) {
  const state = readPrivateJson(inputs.statePath, "phase8_state").value;
  validateStateBinding(state, inputs);
  return state;
}


function nodeSummary(nodes) {
  const summary = { general: 0, spark: 0, total: 0 };
  for (const node of nodes?.items ?? []) {
    summary.total += 1;
    const pool = node?.metadata?.labels?.["karpenter.sh/nodepool"];
    if (pool === "asklake-general") summary.general += 1;
    if (pool === "asklake-spark") summary.spark += 1;
  }
  return summary;
}


export function countActiveJobs(document) {
  return (document?.items ?? []).filter((job) => {
    if (job?.metadata?.deletionTimestamp) return true;
    const terminal = (job?.status?.conditions ?? []).some(
      (condition) =>
        condition?.status === "True"
        && ["Complete", "Failed"].includes(condition?.type),
    );
    return !terminal;
  }).length;
}


export function countActiveSparkApplications(document) {
  const terminal = new Set(["COMPLETED", "FAILED", "SUBMISSION_FAILED"]);
  return (document?.items ?? []).filter((application) => {
    if (application?.metadata?.deletionTimestamp) return true;
    const state = String(
      application?.status?.applicationState?.state ?? "",
    ).toUpperCase();
    return !terminal.has(state);
  }).length;
}


function validateDeploymentState(runner, candidateImage) {
  const backend = runner.json("kubectl", [
    "get", "deployment", "fastapi", "-n", NAMESPACE, "-o", "json",
  ]);
  const collector = runner.json("kubectl", [
    "get", "deployment", "trino-result-collector",
    "-n", NAMESPACE, "-o", "json",
  ]);
  const backendImage = backend?.spec?.template?.spec?.containers?.find(
    ({ name }) => name === "fastapi",
  )?.image;
  const collectorImage = collector?.spec?.template?.spec?.containers?.find(
    ({ name }) => name === "trino-result-collector",
  )?.image;
  if (
    backendImage !== candidateImage
    || collectorImage !== candidateImage
    || Number(backend?.status?.readyReplicas ?? 0) !== 2
    || Number(backend?.status?.availableReplicas ?? 0) !== 2
    || Number(collector?.status?.readyReplicas ?? 0) !== 1
    || Number(collector?.status?.availableReplicas ?? 0) !== 1
  ) {
    block("candidate_backend_not_steady");
  }
  const digest = candidateImage.slice(candidateImage.lastIndexOf("@") + 1);
  for (const [label, count, container] of [
    ["app.kubernetes.io/component=backend", 2, "fastapi"],
    [
      "app.kubernetes.io/component=trino-result-collector",
      1,
      "trino-result-collector",
    ],
  ]) {
    const pods = runner.json("kubectl", [
      "get", "pods", "-n", NAMESPACE, "-l", label, "-o", "json",
    ]);
    if (
      pods.items?.length !== count
      || !pods.items.every(
        (pod) =>
          !pod?.metadata?.deletionTimestamp
          && pod?.status?.phase === "Running"
          && pod?.status?.containerStatuses?.some(
            (status) =>
              status.name === container
              && status.ready === true
              && status.restartCount === 0
              && status.imageID?.endsWith(digest),
          ),
      )
    ) {
      block("candidate_pod_image_identity_mismatch");
    }
  }
}


function inspectDescribeOnlyPolicy(runner, clusterName) {
  const associations = runner.json("aws", [
    "eks",
    "list-pod-identity-associations",
    "--region",
    REGION,
    "--cluster-name",
    clusterName,
    "--namespace",
    NAMESPACE,
    "--service-account",
    SERVICE_ACCOUNT,
    "--output",
    "json",
  ]).associations ?? [];
  if (associations.length !== 1) block("msk_pod_identity_not_exact");
  const association = runner.json("aws", [
    "eks",
    "describe-pod-identity-association",
    "--region",
    REGION,
    "--cluster-name",
    clusterName,
    "--association-id",
    associations[0].associationId,
    "--output",
    "json",
  ]).association;
  const roleName = String(association?.roleArn ?? "").split("/").at(-1);
  if (!roleName) block("msk_pod_identity_role_missing");
  const inline = runner.json("aws", [
    "iam", "list-role-policies", "--role-name", roleName, "--output", "json",
  ]).PolicyNames ?? [];
  const attached = runner.json("aws", [
    "iam", "list-attached-role-policies",
    "--role-name", roleName, "--output", "json",
  ]).AttachedPolicies ?? [];
  const documents = attached.map(({ PolicyArn }) => {
    const policy = runner.json("aws", [
      "iam", "get-policy", "--policy-arn", PolicyArn, "--output", "json",
    ]).Policy;
    return runner.json("aws", [
      "iam",
      "get-policy-version",
      "--policy-arn",
      PolicyArn,
      "--version-id",
      policy.DefaultVersionId,
      "--output",
      "json",
    ]).PolicyVersion.Document;
  });
  return validateDescribeOnlyPolicy({
    documents,
    attachedPolicyCount: attached.length,
    inlinePolicyCount: inline.length,
  });
}


function runExternalBoundaryChecks(runner, inputs) {
  runner.run("bash", [
    "-c",
    "set -euo pipefail; source scripts/lib/verify-eks-context.sh; verify_asklake_eks_context >/dev/null",
  ]);
  runner.run(
    "bash",
    [
      "-c",
      "set -euo pipefail; set -a; source \"$1\"; set +a; export ASKLAKE_EXPECTED_EC2_INSTANCE_ID=\"${ASKLAKE_EC2_INSTANCE_ID:?}\"; bash scripts/verify-eks-external-ec2-instance.sh >/dev/null; bash scripts/verify-eks-continuous-process-boundary.sh >/dev/null",
      "_",
      inputs.ec2Env,
    ],
  );
  runner.run("bash", [
    "scripts/verify-eks-day15-alb-runtime.sh",
    "--steady",
  ]);
}


export function runPreflight(inputs, runner) {
  runner.run("node", [
    "scripts/verify-eks-image-receipt.mjs",
    inputs.candidateReceiptPath,
  ]);
  runExternalBoundaryChecks(runner, inputs);
  const candidateImage = inputs.candidateReceipt?.images?.backend;
  if (!/@sha256:[a-f0-9]{64}$/.test(candidateImage ?? "")) {
    block("candidate_backend_image_not_immutable");
  }
  validateDeploymentState(runner, candidateImage);
  inspectDescribeOnlyPolicy(runner, inputs.liveInput.cluster.name);
  const manifest = renderDenyProbeJob({
    campaignId: "0".repeat(32),
    image: candidateImage,
    name: "asklake-day18-msk-deny-server-dry-run",
  });
  validateDenyProbeJob(manifest, candidateImage, {
    campaignId: "0".repeat(32),
    expectedName: manifest.metadata.name,
  });
  const accepted = runner.json(
    "kubectl",
    ["apply", "--dry-run=server", "-f", "-", "-o", "json"],
    { input: `${JSON.stringify(manifest)}\n` },
  );
  validateDenyProbeJob(accepted, candidateImage, {
    campaignId: "0".repeat(32),
    expectedName: manifest.metadata.name,
  });
  const remote = runner.incluster({
    action: "preflight",
    boundedTargets: inputs.liveInput.targets.bounded,
  }).value;
  if (
    remote.status !== "passed"
    || !Object.values(remote.checks ?? {}).every(Boolean)
  ) {
    block("incluster_preflight_blocked");
  }
  const steady = globalCleanupSnapshot(runner);
  if (
    steady.activeJobs !== 0
    || steady.activeSparkApplications !== 0
    || steady.pendingOrTerminatingPods !== 0
    || steady.temporaryPhase8Jobs !== 0
    || steady.temporaryPhase8Pods !== 0
    || steady.fastApiReady !== 2
    || steady.collectorReady !== 1
    || steady.hpaCurrent !== 2
    || steady.hpaDesired !== 2
  ) {
    block("phase8_workload_baseline_not_steady");
  }
  if (steady.nodes.total < 1 || steady.nodes.general < 1) {
    block("node_visibility_unavailable");
  }
  const existingState = existsSync(inputs.statePath)
    ? loadState(inputs)
    : null;
  if (existingState) return existingState;
  return initialState(inputs, {
    activeFixtureRuns: 0,
    activeSparkApplications: steady.activeSparkApplications,
    activeKubernetesJobs: 0,
    pendingOrTerminatingPods: 0,
    continuousRuntimes: Number(remote?.counts?.continuousRuntimes ?? 0),
    continuousSessions: Number(remote?.counts?.continuousSessions ?? 0),
    nodes: steady.nodes,
  });
}


async function sleep(milliseconds) {
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds));
}


async function poll({
  attempt,
  intervalMs = 3_000,
  timeoutMs,
  predicate,
  code,
}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await attempt();
    if (predicate(latest)) return latest;
    await sleep(intervalMs);
  }
  block(code);
}


function reserveFault(inputs, runner, state, alias) {
  if (state.runs?.[alias]?.identity) return state;
  const target = inputs.liveInput.targets.faults.find(
    (item) => item.alias === alias,
  );
  const reserved = runner.incluster({
    action: "reserve",
    alias,
    campaignId: state.campaignId,
    target,
  }).value;
  if (!["reserved", "reconciled"].includes(reserved.status)) {
    block("fault_run_reservation_failed", alias === "Run D" ? "run_d" : "run_e");
  }
  return updateState(inputs, state, {
    phase: alias === "Run D" ? "run_d_reserved" : "run_e_reserved",
    runs: {
      ...(state.runs ?? {}),
      [alias]: {
        alias,
        identity: reserved.identity,
        state: "reserved",
        timeline: [
          {
            at: new Date().toISOString(),
            state: "reserved",
          },
        ],
      },
    },
  });
}


function probeReceiptIsValid(value, campaignId) {
  return (
    value?.contractVersion === "1.0"
    && value?.campaign === "eks-day18-phase8-msk-deny"
    && value?.campaignId === campaignId
    && value?.status === "passed"
    && Number.isFinite(Date.parse(value?.startedAt ?? ""))
    && Number.isFinite(Date.parse(value?.completedAt ?? ""))
    && Date.parse(value.startedAt) <= Date.parse(value.completedAt)
    && ["jobName", "jobUid", "podName", "podUid"].every(
      (key) =>
        typeof value?.privateIdentity?.[key] === "string"
        && value.privateIdentity[key].length > 0,
    )
    && value?.probe?.category === "AUTHORIZATION"
    && ["29", "31"].includes(value?.probe?.protocolCode)
    && value?.probe?.attemptedMessages === 1
    && value?.probe?.acknowledgedMessages === 0
    && /^[a-f0-9]{64}$/.test(value?.probe?.evidenceSha256 ?? "")
  );
}


async function cleanupRecordedDenyProbe(inputs, runner, state, receipt) {
  const image = inputs.candidateReceipt.images.backend;
  const name = receipt.privateIdentity.jobName;
  const selector = `asklake.io/day18-campaign=${state.campaignId}`;
  const jobs = runner.json("kubectl", [
    "get", "jobs", "-n", NAMESPACE, "-l", selector, "-o", "json",
  ]);
  const pods = runner.json("kubectl", [
    "get", "pods", "-n", NAMESPACE, "-l", selector, "-o", "json",
  ]);
  if ((jobs.items ?? []).length > 1 || (pods.items ?? []).length > 1) {
    block("recorded_deny_probe_cleanup_ambiguous", "run_d");
  }
  if ((jobs.items ?? []).length === 1) {
    const job = jobs.items[0];
    validateDenyProbeJob(job, image, {
      campaignId: state.campaignId,
      expectedName: name,
    });
    if (job?.metadata?.uid !== receipt.privateIdentity.jobUid) {
      block("recorded_deny_probe_job_uid_changed", "run_d");
    }
    deleteNamespacedWithUidPrecondition(
      runner,
      "apis/batch/v1",
      "jobs",
      name,
      job.metadata.uid,
    );
  } else if ((pods.items ?? []).length === 1) {
    const pod = pods.items[0];
    const owner = (pod?.metadata?.ownerReferences ?? []).find(
      (item) => item?.kind === "Job",
    );
    if (
      pod?.metadata?.name !== receipt.privateIdentity.podName
      || pod?.metadata?.uid !== receipt.privateIdentity.podUid
      || owner?.uid !== receipt.privateIdentity.jobUid
      || pod?.metadata?.labels?.["asklake.io/day18-campaign"]
        !== state.campaignId.slice(0, 32)
    ) {
      block("recorded_deny_probe_pod_identity_changed", "run_d");
    }
    deleteNamespacedWithUidPrecondition(
      runner,
      "api/v1",
      "pods",
      pod.metadata.name,
      pod.metadata.uid,
    );
  }
  await poll({
    timeoutMs: 180_000,
    intervalMs: 2_000,
    code: "deny_probe_cleanup_pending",
    attempt: () => ({
      jobs: runner.json("kubectl", [
        "get", "jobs", "-n", NAMESPACE, "-l", selector, "-o", "json",
      ]).items?.length ?? 0,
      pods: runner.json("kubectl", [
        "get", "pods", "-n", NAMESPACE, "-l", selector, "-o", "json",
      ]).items?.length ?? 0,
    }),
    predicate: (value) => value.jobs === 0 && value.pods === 0,
  });
}


async function runDenyProbe(inputs, runner, state) {
  const output = state.artifacts.msk;
  const image = inputs.candidateReceipt.images.backend;
  const manifest = renderDenyProbeJob({
    campaignId: state.campaignId,
    image,
  });
  validateDenyProbeJob(manifest, image, {
    campaignId: state.campaignId,
    expectedName: manifest.metadata.name,
  });
  const name = manifest.metadata.name;
  if (existsSync(output)) {
    const existing = readPrivateJson(output, "msk_fault_receipt").value;
    if (!probeReceiptIsValid(existing, state.campaignId)) {
      block("existing_msk_fault_receipt_invalid", "run_d");
    }
    await cleanupRecordedDenyProbe(inputs, runner, state, existing);
    return existing;
  }
  const existing = runner.run(
    "kubectl",
    ["get", "job", name, "-n", NAMESPACE, "-o", "json"],
    { allowFailure: true },
  );
  if (existing.status !== 0) {
    const accepted = runner.json(
      "kubectl",
      ["apply", "--dry-run=server", "-f", "-", "-o", "json"],
      { input: `${JSON.stringify(manifest)}\n` },
    );
    validateDenyProbeJob(accepted, image, {
      campaignId: state.campaignId,
      expectedName: name,
    });
    runner.run("kubectl", ["create", "-f", "-"], {
      input: `${JSON.stringify(manifest)}\n`,
    });
  } else {
    let current;
    try {
      current = JSON.parse(existing.stdout);
    } catch {
      block("existing_deny_probe_invalid_json", "run_d");
    }
    validateDenyProbeJob(current, image, {
      campaignId: state.campaignId,
      expectedName: name,
    });
  }
  const terminal = await poll({
    timeoutMs: 210_000,
    code: "deny_probe_timeout",
    attempt: () =>
      runner.json("kubectl", [
        "get", "job", name, "-n", NAMESPACE, "-o", "json",
      ]),
    predicate: (job) =>
      Number(job?.status?.failed ?? 0) > 0
      || Number(job?.status?.succeeded ?? 0) > 0,
  });
  if (Number(terminal?.status?.succeeded ?? 0) > 0) {
    block("deny_probe_unexpected_success", "run_d");
  }
  validateDenyProbeJob(terminal, image, {
    campaignId: state.campaignId,
    expectedName: name,
  });
  if (!terminal?.metadata?.uid) {
    block("deny_probe_uid_missing", "run_d");
  }
  const pods = runner.json("kubectl", [
    "get",
    "pods",
    "-n",
    NAMESPACE,
    "-l",
    `job-name=${name}`,
    "-o",
    "json",
  ]);
  if (pods.items?.length !== 1) {
    block("deny_probe_pod_not_exact", "run_d");
  }
  if (
    !pods.items[0]?.metadata?.name
    || !pods.items[0]?.metadata?.uid
  ) {
    block("deny_probe_pod_identity_missing", "run_d");
  }
  const logs = runner.run("kubectl", [
    "logs", `job/${name}`, "-n", NAMESPACE,
  ]).stdout;
  const probe = parseDenyProbeLog(logs);
  const receipt = {
    contractVersion: "1.0",
    campaign: "eks-day18-phase8-msk-deny",
    campaignId: state.campaignId,
    startedAt:
      terminal?.metadata?.creationTimestamp
      || pods.items[0]?.metadata?.creationTimestamp,
    completedAt: new Date().toISOString(),
    status: "passed",
    privateIdentity: {
      jobName: name,
      jobUid: terminal.metadata.uid,
      podName: pods.items[0].metadata.name,
      podUid: pods.items[0].metadata.uid,
    },
    probe,
  };
  writeExclusivePrivateJson(output, receipt);
  await cleanupRecordedDenyProbe(inputs, runner, state, receipt);
  return receipt;
}


function appendTimeline(state, alias, event) {
  return {
    ...(state.runs ?? {}),
    [alias]: {
      ...state.runs[alias],
      ...event.patch,
      timeline: [
        ...(state.runs[alias].timeline ?? []),
        {
          at: new Date().toISOString(),
          state: event.state,
          ...(event.details ?? {}),
        },
      ],
    },
  };
}


export function classifyPersistedFaultCheckpoint(alias, observed) {
  const campaignState = String(observed?.campaignState ?? "");
  const allowed = alias === "Run D"
    ? new Set(["reserved", "msk_fault_recorded", "airflow_unknown", "airflow_submitted"])
    : new Set(["reserved", "first_spark_attempt_terminal", "airflow_unknown", "airflow_submitted"]);
  if (!allowed.has(campaignState)) {
    block(
      alias === "Run D"
        ? "run_d_persisted_checkpoint_ambiguous"
        : "run_e_persisted_checkpoint_ambiguous",
      alias === "Run D" ? "run_d" : "run_e",
    );
  }
  if (alias === "Run D" && ["msk_fault_recorded", "airflow_submitted"].includes(
    campaignState,
  )) {
    if (
      observed?.faultAttemptCount !== 1
      || (
        campaignState === "msk_fault_recorded"
        && observed?.executionGeneration !== 1
      )
      || (
        campaignState === "airflow_submitted"
        && Number(observed?.executionGeneration ?? 0) < 1
      )
    ) {
      block("run_d_persisted_fault_evidence_invalid", "run_d");
    }
  }
  if (campaignState === "airflow_submitted") {
    return "airflow_submitted";
  }
  if (alias === "Run D" && campaignState === "msk_fault_recorded") {
    return "msk_fault_recorded";
  }
  return null;
}


function adoptPersistedCheckpoint(inputs, state, alias, checkpoint) {
  if (!checkpoint || state.runs[alias].state === checkpoint) return state;
  const current = state.runs[alias].state;
  const transitionAllowed =
    (
      alias === "Run D"
      && (
        (current === "reserved" && checkpoint === "msk_fault_recorded")
        || (
          ["reserved", "msk_fault_recorded"].includes(current)
          && checkpoint === "airflow_submitted"
        )
      )
    )
    || (
      alias === "Run E"
      && current === "first_attempt_failed"
      && checkpoint === "airflow_submitted"
    );
  if (!transitionAllowed) {
    block(
      alias === "Run D"
        ? "run_d_local_checkpoint_conflicts_with_rds"
        : "run_e_local_checkpoint_conflicts_with_rds",
      alias === "Run D" ? "run_d" : "run_e",
    );
  }
  return updateState(inputs, state, {
    phase:
      checkpoint === "airflow_submitted"
        ? (alias === "Run D"
          ? "run_d_airflow_submitted"
          : "run_e_airflow_submitted")
        : "run_d_fault_recorded",
    runs: appendTimeline(state, alias, {
      state: `${checkpoint}_reconciled`,
      patch: { state: checkpoint },
    }),
  });
}


function readCloudWatchMarkerEvents(
  runner,
  {
    endTimeMs,
    logGroup,
    marker,
    startTimeMs,
  },
) {
  const events = [];
  let nextToken;
  const seenTokens = new Set();
  for (let page = 0; page < 20; page += 1) {
    const result = runner.json("aws", [
      "logs",
      "filter-log-events",
      "--region",
      REGION,
      "--log-group-name",
      logGroup,
      "--start-time",
      String(startTimeMs),
      "--end-time",
      String(endTimeMs),
      "--filter-pattern",
      `"${marker}"`,
      "--limit",
      "10000",
      "--no-paginate",
      ...(nextToken ? ["--next-token", nextToken] : []),
      "--output",
      "json",
    ]);
    events.push(...(result?.events ?? []));
    if (events.length > 10_000) {
      block("fault_cloudwatch_result_too_large");
    }
    const candidate = result?.nextToken;
    if (
      !candidate
      || candidate === nextToken
      || seenTokens.has(candidate)
    ) {
      return events;
    }
    seenTokens.add(candidate);
    nextToken = candidate;
  }
  block("fault_cloudwatch_pagination_incomplete");
}


async function collectFaultObservability(
  inputs,
  runner,
  state,
  alias,
  {
    cloudWatchMarker,
    completedAt,
    requiredCloudWatchTerm,
    resourceIdentities,
    startedAt,
  },
) {
  if (state.runs[alias].observability?.status === "passed") {
    return state;
  }
  const parsedStart = Date.parse(String(startedAt ?? ""));
  const parsedEnd = Date.parse(String(completedAt ?? ""));
  if (
    !Number.isFinite(parsedStart)
    || !Number.isFinite(parsedEnd)
    || parsedStart > parsedEnd
  ) {
    block("fault_observability_window_invalid", alias === "Run D" ? "run_d" : "run_e");
  }
  const startTimeMs = Math.floor(parsedStart - 30_000);
  const endTimeMs = Math.floor(parsedEnd + 60_000);
  const logGroup =
    `/aws/otel/containerinsights/${inputs.liveInput.cluster.name}/application`;
  const observed = await poll({
    timeoutMs: 5 * 60 * 1000,
    intervalMs: 10_000,
    code:
      alias === "Run D"
        ? "run_d_observability_incomplete"
        : "run_e_observability_incomplete",
    attempt: () => {
      const events = runner.json("kubectl", [
        "get", "events", "-n", NAMESPACE, "-o", "json",
      ]);
      const cloudWatchEvents = readCloudWatchMarkerEvents(runner, {
        endTimeMs,
        logGroup,
        marker: cloudWatchMarker,
        startTimeMs,
      });
      return summarizeFaultObservability({
        cloudWatchEvents,
        cloudWatchMarker,
        endTimeMs,
        events,
        requiredCloudWatchTerm,
        resourceIdentities,
        startTimeMs,
      });
    },
    predicate: (value) =>
      value.eventCount >= 1
      && value.cloudWatchMarkerCount >= 1,
  });
  return updateState(inputs, state, {
    runs: appendTimeline(state, alias, {
      state: "fault_observability_passed",
      details: {
        cloudWatchMarkers: observed.cloudWatchMarkerCount,
        kubernetesEvents: observed.eventCount,
      },
      patch: {
        observability: {
          status: "passed",
          startedAt: new Date(startTimeMs).toISOString(),
          completedAt: new Date(endTimeMs).toISOString(),
          cloudWatchMarkerCount: observed.cloudWatchMarkerCount,
          kubernetesEventCount: observed.eventCount,
          eventSummary: observed.eventSummary,
        },
      },
    }),
  });
}


async function waitForFaultSuccess(inputs, runner, state, alias) {
  const request = baseFaultRequest(state, inputs, alias);
  await poll({
    timeoutMs: positiveInteger(
      process.env.ASKLAKE_DAY18_PHASE8_RUN_TIMEOUT_MS,
      30 * 60 * 1000,
    ),
    intervalMs: 5_000,
    code: `${alias === "Run D" ? "run_d" : "run_e"}_terminal_timeout`,
    attempt: () =>
      runner.incluster({ ...request, action: "inspect" }).value,
    predicate: (value) =>
      value.runStatus === "success"
      && value.airflowState === "success"
      && value.sparkResultStatus === "success"
      && value.catalogStatus === "success",
  });
  const verified = runner.incluster({
    ...request,
    action: "verify",
  }).value;
  if (
    verified.status !== "passed"
    || !Object.values(verified.checks ?? {}).every(Boolean)
  ) {
    block(`${alias === "Run D" ? "run_d" : "run_e"}_verification_failed`);
  }
  return verified;
}


export async function runFaultD(inputs, runner, initial) {
  let state = reserveFault(inputs, runner, initial, "Run D");
  if (state.runs["Run D"].state === "passed") return state;
  const probe = await runDenyProbe(inputs, runner, state);
  const observed = runner.incluster({
    ...baseFaultRequest(state, inputs, "Run D"),
    action: "inspect",
  }).value;
  const persistedCheckpoint = classifyPersistedFaultCheckpoint(
    "Run D",
    observed,
  );
  if (
    state.runs["Run D"].state === "msk_fault_recorded"
    && !persistedCheckpoint
    && observed.campaignState !== "airflow_unknown"
  ) {
    block("run_d_local_checkpoint_conflicts_with_rds", "run_d");
  }
  state = adoptPersistedCheckpoint(
    inputs,
    state,
    "Run D",
    persistedCheckpoint,
  );
  if (!["msk_fault_recorded", "airflow_submitted"].includes(
    state.runs["Run D"].state,
  )) {
    const request = baseFaultRequest(state, inputs, "Run D");
    const recorded = runner.incluster({
      ...request,
      action: "record_msk_fault",
      evidenceSha256: probe.probe.evidenceSha256,
    }).value;
    if (recorded.status !== "recorded" || recorded.generation !== 1) {
      block("run_d_fault_generation_invalid", "run_d");
    }
    state = updateState(inputs, state, {
      phase: "run_d_fault_recorded",
      runs: appendTimeline(state, "Run D", {
        state: "authorization_failed",
        details: {
          acknowledged: 0,
          attempted: 1,
          generation: recorded.generation,
        },
        patch: {
          state: "msk_fault_recorded",
          mskEvidenceSha256: probe.probe.evidenceSha256,
        },
      }),
    });
  }
  state = await collectFaultObservability(
    inputs,
    runner,
    state,
    "Run D",
    {
      cloudWatchMarker: probe.privateIdentity.podName,
      completedAt: probe.completedAt,
      requiredCloudWatchTerm: "AUTHORIZATION",
      resourceIdentities: [
        probe.privateIdentity.jobName,
        probe.privateIdentity.jobUid,
        probe.privateIdentity.podName,
        probe.privateIdentity.podUid,
      ],
      startedAt: probe.startedAt,
    },
  );
  if (state.runs["Run D"].state !== "airflow_submitted") {
    const request = baseFaultRequest(state, inputs, "Run D");
    runner.incluster({ ...request, action: "submit" });
    state = updateState(inputs, state, {
      phase: "run_d_airflow_submitted",
      runs: appendTimeline(state, "Run D", {
        state: "airflow_submitted",
        patch: { state: "airflow_submitted" },
      }),
    });
  }
  const verified = await waitForFaultSuccess(
    inputs,
    runner,
    state,
    "Run D",
  );
  state = updateState(inputs, state, {
    phase: "run_d_passed",
    runs: appendTimeline(state, "Run D", {
      state: "passed",
      details: { generation: verified.generation },
      patch: {
        state: "passed",
        result: verified,
      },
    }),
  });
  return state;
}


function deleteNamespacedWithUidPrecondition(
  runner,
  apiPrefix,
  resource,
  name,
  uid,
) {
  const path =
    `/${apiPrefix}/namespaces/${encodeURIComponent(NAMESPACE)}`
    + `/${resource}/${encodeURIComponent(name)}`;
  const deletion = {
    apiVersion: "v1",
    kind: "DeleteOptions",
    gracePeriodSeconds: 0,
    propagationPolicy: "Foreground",
    preconditions: { uid },
  };
  runner.run(
    "kubectl",
    ["delete", "--raw", path, "-f", "-"],
    { input: `${JSON.stringify(deletion)}\n` },
  );
}


function deleteDriverWithUidPrecondition(runner, pod) {
  deleteNamespacedWithUidPrecondition(
    runner,
    "api/v1",
    "pods",
    pod.metadata.name,
    pod.metadata.uid,
  );
}


async function waitForFirstAttemptIdentity(inputs, runner, state) {
  const request = baseFaultRequest(state, inputs, "Run E");
  return poll({
    timeoutMs: 5 * 60 * 1000,
    intervalMs: 2_000,
    code: "run_e_first_attempt_identity_timeout",
    attempt: () =>
      runner.incluster({ ...request, action: "inspect" }).value,
    predicate: (value) =>
      value.sparkExecutionStatus === "running"
      && value.currentApplication?.attemptGeneration === 1
      && value.currentApplication?.name
      && value.currentApplication?.uid
      && value.currentApplication?.driverPodName,
  });
}


async function waitForFirstAttemptFailure(inputs, runner, state) {
  const request = baseFaultRequest(state, inputs, "Run E");
  return poll({
    timeoutMs: 15 * 60 * 1000,
    intervalMs: 3_000,
    code: "run_e_first_attempt_failure_timeout",
    attempt: () =>
      runner.incluster({ ...request, action: "inspect" }).value,
    predicate: (value) =>
      value.sparkExecutionStatus === "failed"
      && value.currentApplication?.attemptGeneration === 1
      && TERMINAL_FAILED_STATES.has(
        String(value.currentApplication?.state ?? "").toUpperCase(),
      ),
  });
}


export function validateFirstAttemptProcessResult(completed) {
  if (completed?.error || ![0, 1].includes(completed?.status)) {
    block("run_e_first_execution_process_failed", "run_e");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(completed.stdout ?? "").trim());
  } catch {
    block("run_e_first_execution_result_invalid", "run_e");
  }
  const terminalManifest =
    completed.status === 0
    && parsed?.status === "failed"
    && parsed?.attemptGeneration === 1;
  const sanitizedExpectedFailure =
    completed.status === 1
    && parsed?.status === "blocked"
    && typeof parsed?.errorType === "string"
    && parsed.errorType.length > 0;
  if (!terminalManifest && !sanitizedExpectedFailure) {
    block("run_e_first_execution_result_unexpected", "run_e");
  }
  return {
    mode: terminalManifest ? "terminal_manifest" : "raised_failure",
    status: "failed",
  };
}


async function stopFirstAttemptProcess(processHandle) {
  if (!processHandle) return;
  if (
    processHandle.child.exitCode === null
    && !processHandle.child.killed
  ) {
    processHandle.child.kill("SIGTERM");
  }
  await Promise.race([
    processHandle.completed,
    sleep(5_000),
  ]);
}


async function waitForFirstAttemptProcess(processHandle) {
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(
      () => resolvePromise({ timedOut: true }),
      60_000,
    );
  });
  const outcome = await Promise.race([
    processHandle.completed.then((completed) => ({ completed })),
    timeout,
  ]);
  clearTimeout(timer);
  if (outcome.timedOut) {
    await stopFirstAttemptProcess(processHandle);
    block("run_e_first_execution_process_timeout", "run_e");
  }
  return outcome.completed;
}


async function submitAndVerifyRunE(inputs, runner, initial) {
  let state = initial;
  const fault = state.runs["Run E"].driverFault;
  if (
    !fault
    || !state.runs["Run E"].firstAttemptFailedAt
  ) {
    block("run_e_fault_evidence_checkpoint_missing", "run_e");
  }
  state = await collectFaultObservability(
    inputs,
    runner,
    state,
    "Run E",
    {
      cloudWatchMarker: runECloudWatchMarker(state),
      completedAt: state.runs["Run E"].firstAttemptFailedAt,
      resourceIdentities: [
        fault.applicationName,
        fault.applicationUid,
        fault.podName,
        fault.podUid,
      ],
      startedAt: fault.injectedAt,
    },
  );
  const request = baseFaultRequest(state, inputs, "Run E");
  if (state.runs["Run E"].state !== "airflow_submitted") {
    const observed = runner.incluster({
      ...request,
      action: "inspect",
    }).value;
    state = adoptPersistedCheckpoint(
      inputs,
      state,
      "Run E",
      classifyPersistedFaultCheckpoint("Run E", observed),
    );
    if (state.runs["Run E"].state !== "airflow_submitted") {
      runner.incluster({ ...request, action: "submit" });
      state = updateState(inputs, state, {
        phase: "run_e_airflow_submitted",
        runs: appendTimeline(state, "Run E", {
          state: "airflow_submitted",
          patch: { state: "airflow_submitted" },
        }),
      });
    }
  }
  const verified = await waitForFaultSuccess(
    inputs,
    runner,
    state,
    "Run E",
  );
  return updateState(inputs, state, {
    phase: "run_e_passed",
    runs: appendTimeline(state, "Run E", {
      state: "passed",
      details: { generation: verified.generation },
      patch: {
        state: "passed",
        result: verified,
      },
    }),
  });
}


export function runECloudWatchMarker(state) {
  const runId = state?.runs?.["Run E"]?.identity?.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    block("run_e_fault_evidence_checkpoint_missing", "run_e");
  }
  return runId;
}


export async function runFaultE(inputs, runner, initial) {
  let state = reserveFault(inputs, runner, initial, "Run E");
  const checkpoint = state.runs["Run E"].state;
  if (checkpoint === "passed") return state;
  if (!new Set([
    "reserved",
    "first_attempt_armed",
    "driver_deleted",
    "first_attempt_failed",
    "airflow_submitted",
  ]).has(checkpoint)) {
    block("run_e_checkpoint_invalid", "run_e");
  }
  if (checkpoint === "airflow_submitted") {
    return submitAndVerifyRunE(inputs, runner, state);
  }
  if (checkpoint === "first_attempt_failed") {
    return submitAndVerifyRunE(inputs, runner, state);
  }

  const request = baseFaultRequest(state, inputs, "Run E");
  let firstProcess;
  try {
    let observed = runner.incluster({ ...request, action: "inspect" }).value;
    if (!observed.currentApplication?.name) {
      if (checkpoint !== "reserved") {
        block("run_e_first_attempt_outcome_ambiguous", "run_e");
      }
      state = updateState(inputs, state, {
        phase: "run_e_first_attempt_armed",
        runs: appendTimeline(state, "Run E", {
          state: "first_attempt_armed",
          patch: { state: "first_attempt_armed" },
        }),
      });
      firstProcess = runner.inclusterAsync({ ...request, action: "execute" });
      observed = await waitForFirstAttemptIdentity(inputs, runner, state);
    }
    if (
      observed.currentApplication?.attemptGeneration !== 1
      || observed.sparkResultStatus === "success"
    ) {
      block("run_e_first_attempt_not_faultable", "run_e");
    }
    const persistedFault = state.runs["Run E"].driverFault;
    if (persistedFault) {
      if (
        persistedFault.applicationName !== observed.currentApplication.name
        || persistedFault.applicationUid !== observed.currentApplication.uid
      ) {
        block("run_e_driver_fault_identity_changed", "run_e");
      }
    } else {
      if (checkpoint === "driver_deleted") {
        block("run_e_driver_fault_checkpoint_incomplete", "run_e");
      }
      const pod = runner.json("kubectl", [
        "get",
        "pod",
        observed.currentApplication.driverPodName,
        "-n",
        NAMESPACE,
        "-o",
        "json",
      ]);
      const validated = validateDriverPod(
        pod,
        {
          applicationName: observed.currentApplication.name,
          applicationUid: observed.currentApplication.uid,
          driverPodName: observed.currentApplication.driverPodName,
        },
      );
      deleteDriverWithUidPrecondition(runner, pod);
      state = updateState(inputs, state, {
        phase: "run_e_driver_deleted",
        runs: appendTimeline(state, "Run E", {
          state: "driver_deleted",
          details: {
            application: shortHash(observed.currentApplication.uid),
            pod: shortHash(validated.podUid),
          },
          patch: {
            state: "driver_deleted",
            driverFault: {
              applicationName: observed.currentApplication.name,
              applicationUid: observed.currentApplication.uid,
              podName: pod.metadata.name,
              podUid: validated.podUid,
              injectedAt: new Date().toISOString(),
            },
          },
        }),
      });
    }
    observed = await waitForFirstAttemptFailure(inputs, runner, state);
    if (firstProcess) {
      const completed = await waitForFirstAttemptProcess(firstProcess);
      firstProcess = null;
      validateFirstAttemptProcessResult(completed);
    }
    state = updateState(inputs, state, {
      phase: "run_e_first_attempt_failed",
      runs: appendTimeline(state, "Run E", {
        state: "first_attempt_failed",
        details: {
          application: shortHash(observed.currentApplication.uid),
          generation: observed.executionGeneration,
        },
        patch: {
          state: "first_attempt_failed",
          firstAttemptFailedAt: new Date().toISOString(),
        },
      }),
    });
  } catch (error) {
    await stopFirstAttemptProcess(firstProcess);
    throw error;
  }
  return submitAndVerifyRunE(inputs, runner, state);
}


export function validateAbcReceipt(receipt, approvedTargets) {
  const identities = receipt?.privateIdentity;
  const identityList = Array.isArray(identities) ? identities : [];
  const aliases = ["Run A", "Run B", "Run C"];
  const approved = new Map(
    (approvedTargets ?? []).map((target) => [target?.alias, target]),
  );
  const groups = new Set(
    identityList.map((identity) => identity?.consumerGroup),
  );
  const tables = new Set(
    identityList.map((identity) => identity?.icebergTable),
  );
  const outputs = new Set(
    identityList.map((identity) => identity?.outputPath),
  );
  const checkpoints = new Set(
    identityList.map((identity) => identity?.checkpointPath),
  );
  const runIds = new Set(
    identityList.map((identity) => identity?.runId),
  );
  const exactTargetKeys = [
    "jobId",
    "datasetId",
    "fixtureBatchId",
    "consumerGroup",
    "icebergTable",
    "expectedCount",
  ];
  const checks = {
    submitted: receipt?.status === "submitted",
    runnerChecks:
      receipt?.checks
      && Object.values(receipt.checks).every(Boolean),
    exactThree: Array.isArray(identities) && identities.length === 3,
    aliases:
      Array.isArray(identities)
      && aliases.every((alias, index) => identities[index]?.alias === alias),
    expected:
      Array.isArray(identities)
      && identities.every((identity) => identity.expectedCount === 100),
    runIds:
      runIds.size === 3
      && identityList.every(
        (identity) =>
          typeof identity?.runId === "string"
          && identity.runId.trim() !== "",
      ),
    approvedTargetsExact:
      approved.size === 3
      && Array.isArray(identities)
      && identities.every((identity) => {
        const target = approved.get(identity.alias);
        return target
          && exactTargetKeys.every((key) => identity[key] === target[key]);
      }),
    isolation:
      groups.size === 3
      && tables.size === 3
      && outputs.size === 3
      && checkpoints.size === 3
      && identityList.every(
        (identity) =>
          typeof identity.outputPath === "string"
          && identity.outputPath.trim() !== ""
          && typeof identity.checkpointPath === "string"
          && identity.checkpointPath.trim() !== "",
      )
      && !groups.has("")
      && !tables.has("")
      && !outputs.has("")
      && !checkpoints.has(""),
  };
  if (!Object.values(checks).every(Boolean)) {
    block("abc_private_receipt_invalid", "run_abc");
  }
  return receipt;
}


export async function runAbc(inputs, runner, initial) {
  let state = initial;
  if (state.phase === "abc_passed" || state.phase === "cleanup_passed") {
    return state;
  }
  const receiptPath = state.artifacts.abcReceipt;
  if (!existsSync(receiptPath)) {
    const environment = {
      ...process.env,
      ASKLAKE_DAY17_MULTI_SPARK_CONFIRM:
        "submit-three-isolated-spark-runs",
      ASKLAKE_DAY17_MULTI_SPARK_RECEIPT: receiptPath,
    };
    runner.run(
      "bash",
      ["scripts/run-eks-day17-multi-spark.sh", "--run"],
      { environment, timeout: 180_000 },
    );
  }
  const receipt = validateAbcReceipt(
    readPrivateJson(receiptPath, "abc_receipt").value,
    inputs.liveInput.targets.bounded,
  );
  state = updateState(inputs, state, {
    phase: "abc_submitted",
    abc: {
      state: "submitted",
      receiptSha256: sha256File(receiptPath),
      submittedAt: receipt.createdAt,
    },
  });
  await poll({
    timeoutMs: positiveInteger(
      process.env.ASKLAKE_DAY18_PHASE8_RUN_TIMEOUT_MS,
      30 * 60 * 1000,
    ),
    intervalMs: 5_000,
    code: "abc_terminal_timeout",
    attempt: () =>
      runner.incluster({
        action: "inspect_bounded",
        identities: receipt.privateIdentity,
      }).value,
    predicate: (value) => value.status === "passed",
  });
  const resultsPath = state.artifacts.abcResults;
  if (!existsSync(resultsPath)) {
    const environment = {
      ...process.env,
      ASKLAKE_DAY17_MULTI_SPARK_RECEIPT: receiptPath,
      ASKLAKE_DAY17_MULTI_SPARK_RESULTS: resultsPath,
    };
    runner.run(
      "bash",
      ["scripts/verify-eks-day17-multi-spark-results.sh", "--verify"],
      { environment, timeout: 15 * 60 * 1000 },
    );
  }
  const results = readPrivateJson(resultsPath, "abc_results").value;
  if (
    results?.status !== "passed"
    || !Object.values(results?.checks ?? {}).every(Boolean)
    || !results?.runs?.every(
      (run) =>
        run.status === "passed"
        && Object.values(run.checks ?? {}).every(Boolean),
    )
  ) {
    block("abc_results_verification_failed", "run_abc");
  }
  state = updateState(inputs, state, {
    phase: "abc_passed",
    abc: {
      ...state.abc,
      state: "passed",
      resultSha256: sha256File(resultsPath),
      counts: results.counts,
      checks: results.checks,
    },
  });
  return state;
}


function cleanupCampaignTemporaryJobs(inputs, runner, state) {
  const jobs = runner.json("kubectl", [
    "get",
    "jobs",
    "-n",
    NAMESPACE,
    "-l",
    `asklake.io/day18-campaign=${state.campaignId}`,
    "-o",
    "json",
  ]);
  if ((jobs.items ?? []).length > 1) {
    block("phase8_temporary_job_count_ambiguous", "cleanup");
  }
  if ((jobs.items ?? []).length === 0) return 0;
  const job = jobs.items[0];
  const expectedName =
    `asklake-day18-msk-deny-${state.campaignId.slice(0, 12)}`;
  validateDenyProbeJob(job, inputs.candidateReceipt.images.backend, {
    campaignId: state.campaignId,
    expectedName,
  });
  if (!job?.metadata?.uid) {
    block("phase8_temporary_job_uid_missing", "cleanup");
  }
  if (existsSync(state.artifacts.msk)) {
    const receipt = readPrivateJson(
      state.artifacts.msk,
      "msk_fault_receipt",
    ).value;
    if (
      !probeReceiptIsValid(receipt, state.campaignId)
      || receipt.privateIdentity.jobUid !== job.metadata.uid
    ) {
      block("phase8_temporary_job_receipt_mismatch", "cleanup");
    }
  }
  deleteNamespacedWithUidPrecondition(
    runner,
    "apis/batch/v1",
    "jobs",
    expectedName,
    job.metadata.uid,
  );
  return 1;
}


function campaignRunIds(inputs, state) {
  const runIds = new Set(
    [state.runs?.["Run D"]?.identity?.runId,
      state.runs?.["Run E"]?.identity?.runId]
      .filter((value) => typeof value === "string" && value.length > 0),
  );
  const receiptPath = state.artifacts?.abcReceipt;
  if (typeof receiptPath === "string" && existsSync(receiptPath)) {
    const receipt = validateAbcReceipt(
      readPrivateJson(receiptPath, "abc_receipt").value,
      inputs.liveInput.targets.bounded,
    );
    for (const identity of receipt.privateIdentity) {
      if (typeof identity.runId !== "string" || identity.runId.trim() === "") {
        block("abc_private_receipt_invalid", "cleanup");
      }
      runIds.add(identity.runId);
    }
  }
  return runIds;
}


export function cleanupCampaignTerminalSparkPods(inputs, runner, state) {
  const runIds = campaignRunIds(inputs, state);
  if (runIds.size === 0) return 0;
  const pods = runner.json("kubectl", [
    "get", "pods", "-n", NAMESPACE, "-o", "json",
  ]);
  const applications = runner.json("kubectl", [
    "get",
    "sparkapplications.sparkoperator.k8s.io",
    "-n",
    NAMESPACE,
    "-o",
    "json",
  ]);
  const applicationsByName = new Map(
    (applications.items ?? []).map((application) => [
      application?.metadata?.name,
      application,
    ]),
  );
  const candidates = [];
  for (const pod of pods.items ?? []) {
    const runId = pod?.metadata?.labels?.["asklake.io/run-id"];
    if (!runIds.has(runId)) continue;
    if (!["Succeeded", "Failed"].includes(pod?.status?.phase)) continue;
    const role = pod?.metadata?.labels?.["spark-role"];
    const owners = (pod?.metadata?.ownerReferences ?? []).filter(
      (owner) => owner?.kind === "SparkApplication" && owner?.controller === true,
    );
    const owner = owners[0];
    const application = owner ? applicationsByName.get(owner.name) : undefined;
    const applicationState = application?.status?.applicationState?.state;
    if (
      owners.length !== 1
      || !["driver", "executor"].includes(role)
      || typeof pod?.metadata?.name !== "string"
      || typeof pod?.metadata?.uid !== "string"
      || !application
      || application?.metadata?.uid !== owner.uid
      || application?.metadata?.labels?.["asklake.io/run-id"] !== runId
      || !["COMPLETED", "FAILED", "SUBMISSION_FAILED"].includes(applicationState)
    ) {
      block("phase8_terminal_spark_pod_identity_ambiguous", "cleanup");
    }
    candidates.push(pod);
  }
  for (const pod of candidates) {
    deleteNamespacedWithUidPrecondition(
      runner,
      "api/v1",
      "pods",
      pod.metadata.name,
      pod.metadata.uid,
    );
  }
  return candidates.length;
}


function globalCleanupSnapshot(runner) {
  const pods = runner.json("kubectl", [
    "get", "pods", "-n", NAMESPACE, "-o", "json",
  ]);
  const jobs = runner.json("kubectl", [
    "get", "jobs", "-n", NAMESPACE, "-o", "json",
  ]);
  const sparkApplications = runner.json("kubectl", [
    "get",
    "sparkapplications.sparkoperator.k8s.io",
    "-n",
    NAMESPACE,
    "-o",
    "json",
  ]);
  const hpa = runner.json("kubectl", [
    "get", "hpa", "fastapi", "-n", NAMESPACE, "-o", "json",
  ]);
  const backend = runner.json("kubectl", [
    "get", "deployment", "fastapi", "-n", NAMESPACE, "-o", "json",
  ]);
  const collector = runner.json("kubectl", [
    "get", "deployment", "trino-result-collector",
    "-n", NAMESPACE, "-o", "json",
  ]);
  return {
    activeJobs: countActiveJobs(jobs),
    activeSparkApplications:
      countActiveSparkApplications(sparkApplications),
    pendingOrTerminatingPods: pods.items.filter(
      (pod) =>
        pod?.status?.phase === "Pending"
        || Boolean(pod?.metadata?.deletionTimestamp),
    ).length,
    temporaryPhase8Pods: pods.items.filter(
      (pod) =>
        pod?.metadata?.labels?.["asklake.io/day18-campaign"],
    ).length,
    temporaryPhase8Jobs: jobs.items.filter(
      (job) =>
        job?.metadata?.labels?.["asklake.io/day18-campaign"],
    ).length,
    fastApiReady: Number(backend?.status?.readyReplicas ?? 0),
    collectorReady: Number(collector?.status?.readyReplicas ?? 0),
    hpaCurrent: Number(hpa?.status?.currentReplicas ?? 0),
    hpaDesired: Number(hpa?.status?.desiredReplicas ?? 0),
    nodes: nodeSummary(
      runner.json("kubectl", ["get", "nodes", "-o", "json"]),
    ),
  };
}


export async function runCleanup(inputs, runner, initial) {
  let state = initial;
  const explicitlyDeletedJobs =
    cleanupCampaignTemporaryJobs(inputs, runner, state);
  const terminalSparkPodsDeleted =
    cleanupCampaignTerminalSparkPods(inputs, runner, state);
  const remote = await poll({
    timeoutMs: positiveInteger(
      process.env.ASKLAKE_DAY18_PHASE8_CLEANUP_TIMEOUT_MS,
      30 * 60 * 1000,
    ),
    intervalMs: 10_000,
    code: "phase8_cleanup_timeout",
    attempt: () => {
      const incluster = runner.incluster({
        action: "preflight",
        boundedTargets: inputs.liveInput.targets.bounded,
      }, { allowFailure: true }).value;
      return {
        incluster,
        local: globalCleanupSnapshot(runner),
      };
    },
    predicate: ({ incluster, local }) =>
      incluster?.status === "passed"
      && local.activeJobs === 0
      && local.activeSparkApplications === 0
      && local.pendingOrTerminatingPods === 0
      && local.temporaryPhase8Jobs === 0
      && local.temporaryPhase8Pods === 0
      && local.fastApiReady === 2
      && local.collectorReady === 1
      && local.hpaCurrent === 2
      && local.hpaDesired === 2
      && Number(incluster?.counts?.continuousRuntimes ?? -1)
        === Number(state.baseline.continuousRuntimes ?? -2)
      && Number(incluster?.counts?.continuousSessions ?? -1)
        === Number(state.baseline.continuousSessions ?? -2)
      && local.nodes.general <= state.baseline.nodes.general
      && local.nodes.spark <= state.baseline.nodes.spark,
  });
  runExternalBoundaryChecks(runner, inputs);
  state = updateState(inputs, state, {
    phase: "cleanup_passed",
    cleanup: {
      checkedAt: new Date().toISOString(),
      activeJobs: remote.local.activeJobs,
      activeSparkApplications: remote.local.activeSparkApplications,
      pendingOrTerminatingPods: remote.local.pendingOrTerminatingPods,
      temporaryJobs: remote.local.temporaryPhase8Jobs,
      temporaryPods: remote.local.temporaryPhase8Pods,
      explicitlyDeletedJobs,
      terminalSparkPodsDeleted,
      fastApiReady: remote.local.fastApiReady,
      collectorReady: remote.local.collectorReady,
      hpa: `${remote.local.hpaCurrent}/${remote.local.hpaDesired}`,
      continuousRows: {
        runtimes: remote.incluster.counts.continuousRuntimes,
        sessions: remote.incluster.counts.continuousSessions,
      },
      nodes: remote.local.nodes,
      continuousBoundary: "unchanged",
      durableEvidence: "preserved",
    },
  });
  return state;
}


function requireConfirmation(mode, environment = process.env) {
  if (
    MUTATING_MODES.has(mode)
    && environment.ASKLAKE_DAY18_PHASE8_CONFIRM !== CONFIRMATION
  ) {
    block("explicit_phase8_confirmation_missing");
  }
}


export function parseArguments(argv) {
  if (argv.length !== 1) {
    block("usage");
  }
  const mode = String(argv[0]).replace(/^--/, "");
  if (!["preflight", "run-d", "run-e", "run-abc", "cleanup", "all"].includes(mode)) {
    block("usage");
  }
  return mode;
}


export async function executeMode({
  mode,
  inputs = loadPhase8Inputs(),
  runner = new SystemCommandRunner(),
}) {
  requireConfirmation(mode);
  let state = mode === "preflight"
    ? runPreflight(inputs, runner)
    : loadState(inputs);
  if (mode === "preflight") return state;
  if (mode === "run-d" || mode === "all") {
    state = await runFaultD(inputs, runner, state);
  }
  if (mode === "run-e" || mode === "all") {
    if (state.runs?.["Run D"]?.state !== "passed") {
      block("run_d_must_pass_before_run_e");
    }
    state = await runFaultE(inputs, runner, state);
  }
  if (mode === "run-abc" || mode === "all") {
    if (
      state.runs?.["Run D"]?.state !== "passed"
      || state.runs?.["Run E"]?.state !== "passed"
    ) {
      block("fault_runs_must_pass_before_abc");
    }
    state = await runAbc(inputs, runner, state);
  }
  if (mode === "cleanup" || mode === "all") {
    state = await runCleanup(inputs, runner, state);
  }
  return state;
}


async function main() {
  const mode = parseArguments(process.argv.slice(2));
  const inputs = loadPhase8Inputs();
  const state = await executeMode({ mode, inputs });
  const summary = [
    "day18_phase8=passed",
    `mode=${mode}`,
    `phase=${state.phase}`,
    `campaign=${shortHash(state.campaignId)}`,
    `run_d=${state.runs?.["Run D"]?.state ?? "waiting"}`,
    `run_e=${state.runs?.["Run E"]?.state ?? "waiting"}`,
    `abc=${state.abc?.state ?? "waiting"}`,
    `cleanup=${state.cleanup ? "passed" : "waiting"}`,
  ];
  console.log(summary.join(" "));
}


if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    const code = error instanceof Phase8BlockedError
      ? error.code
      : "unexpected_error";
    const phase = error instanceof Phase8BlockedError
      ? error.phase
      : "unknown";
    console.error(
      `day18_phase8=blocked phase=${phase} code=${code} additional_mutation=stopped`,
    );
    process.exitCode = 1;
  });
}
