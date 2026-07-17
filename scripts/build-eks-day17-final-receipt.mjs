#!/usr/bin/env node

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULTS = {
  race: "/private/tmp/asklake-day17-hpa-race-receipt.json",
  load: "/private/tmp/asklake-day17-load-status.json",
  scaleObserver: "/private/tmp/asklake-day17-scale-observer.jsonl",
  campaign: "/private/tmp/asklake-day17-multi-spark-baked-receipt.json",
  multiObserver: "/private/tmp/asklake-day17-multi-spark-observer.jsonl",
  multiResults: "/private/tmp/asklake-day17-multi-spark-results.json",
  cleanup: "/private/tmp/asklake-day17-cleanup-audit.json",
  output: "/private/tmp/asklake-day17-final-receipt.json",
  prior: [
    "/private/tmp/asklake-day17-multi-spark-receipt.json",
    "/private/tmp/asklake-day17-multi-spark-rerun-receipt.json",
    "/private/tmp/asklake-day17-multi-spark-retry2-receipt.json",
  ],
};
const FORBIDDEN_KEYS = new Set([
  "privateIdentity",
  "runId",
  "jobId",
  "applicationName",
  "applicationUid",
  "snapshotId",
  "datasetId",
  "consumerGroup",
  "icebergTable",
  "outputPath",
  "checkpointPath",
  "fixtureBatchId",
  "nodeName",
  "ip",
  "endpoint",
  "arn",
]);
const PRIVATE_IDENTIFIER_KEYS = new Set([
  "runId",
  "jobId",
  "applicationName",
  "applicationUid",
  "snapshotId",
  "datasetId",
  "consumerGroup",
  "icebergTable",
  "outputPath",
  "checkpointPath",
  "fixtureBatchId",
]);

function parseArguments(argv) {
  const options = { ...DEFAULTS, prior: [...DEFAULTS.prior] };
  let priorMode = "default";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-prior") {
      if (priorMode !== "default") {
        throw new Error("--no-prior cannot be combined with --prior");
      }
      options.prior = [];
      priorMode = "none";
      continue;
    }
    if (argument === "--prior") {
      const value = argv[index + 1];
      if (!value) throw new Error("--prior requires a path");
      if (priorMode === "none") {
        throw new Error("--prior cannot be combined with --no-prior");
      }
      if (priorMode === "default") {
        options.prior = [];
        priorMode = "paths";
      }
      options.prior.push(value);
      index += 1;
      continue;
    }
    const key = {
      "--race": "race",
      "--load": "load",
      "--scale-observer": "scaleObserver",
      "--campaign": "campaign",
      "--multi-observer": "multiObserver",
      "--multi-results": "multiResults",
      "--cleanup": "cleanup",
      "--output": "output",
    }[argument];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function allChecksPass(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((item) => item === true)
  );
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function phaseCount(record, role, phase) {
  return Number(record?.pods?.totals?.[role]?.[phase] ?? 0);
}

function activeSparkPods(record) {
  return (
    phaseCount(record, "driver", "Pending") +
    phaseCount(record, "driver", "Running") +
    phaseCount(record, "executor", "Pending") +
    phaseCount(record, "executor", "Running")
  );
}

function runEntriesAllSuccess(record) {
  const entries = record?.runs?.entries ?? [];
  return (
    entries.length === 3 &&
    entries.every(
      (entry) =>
        entry.rds === "success" &&
        entry.airflow === "success" &&
        entry.spark === "success" &&
        entry.catalog === "success",
    )
  );
}

function first(records, predicate) {
  return records.find(predicate) ?? null;
}

function timelinePoint(record, event, details = {}) {
  return {
    at: record?.observedAt ?? null,
    event,
    ...details,
  };
}

function rawPrivateValues(...documents) {
  const values = [];
  const collect = (privateValue) => {
    if (Array.isArray(privateValue)) {
      privateValue.forEach(collect);
      return;
    }
    if (!privateValue || typeof privateValue !== "object") return;
    Object.entries(privateValue).forEach(([key, item]) => {
      if (
        PRIVATE_IDENTIFIER_KEYS.has(key) &&
        typeof item === "string" &&
        item.length > 0
      ) {
        values.push(item);
        return;
      }
      if (item && typeof item === "object") collect(item);
    });
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.privateIdentity !== undefined) collect(value.privateIdentity);
    Object.values(value).forEach(visit);
  };
  documents.forEach(visit);
  return values;
}

function forbiddenKeyPaths(value, path = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenKeyPaths(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenKeyPaths(item, `${path}.${key}`),
  ]);
}

function receiptIsSanitized(receipt, sourceDocuments) {
  if (forbiddenKeyPaths(receipt).length > 0) return false;
  const serialized = JSON.stringify(receipt);
  return rawPrivateValues(...sourceDocuments).every(
    (privateValue) => !serialized.includes(privateValue),
  );
}

export function buildFinalReceipt({
  race,
  load,
  scaleRecords,
  campaign,
  multiRecords,
  multiResults,
  cleanup,
  priorReceipts = [],
  createdAt = new Date().toISOString(),
}) {
  const expectedRunHashes = (campaign.redactedRuns ?? []).map((item) => item.run);
  const campaignRecords = multiRecords.filter(
    (record) =>
      record.observedAt >= campaign.createdAt &&
      sameSet(
        (record?.runs?.entries ?? []).map((entry) => entry.runHash),
        expectedRunHashes,
      ),
  );
  const latestCampaignRecord = campaignRecords.at(-1) ?? null;
  const apiLoadStart = first(
    scaleRecords,
    (record) =>
      record?.load?.state === "connected" &&
      Number(record?.hpa?.currentReplicas ?? 0) === 2,
  );
  const hpaSix = first(
    scaleRecords,
    (record) => Number(record?.hpa?.currentReplicas ?? 0) === 6,
  );
  const driverPendingStart = first(
    campaignRecords,
    (record) => phaseCount(record, "driver", "Pending") > 0,
  );
  const driverPendingPeak = first(
    campaignRecords,
    (record) => phaseCount(record, "driver", "Pending") >= 3,
  );
  const driverRunning = first(
    campaignRecords,
    (record) => phaseCount(record, "driver", "Running") >= 3,
  );
  const executorPendingStart = first(
    campaignRecords,
    (record) => phaseCount(record, "executor", "Pending") > 0,
  );
  const executorPendingPeak = first(
    campaignRecords,
    (record) => phaseCount(record, "executor", "Pending") >= 3,
  );
  const executorRunning = first(
    campaignRecords,
    (record) => phaseCount(record, "executor", "Running") >= 3,
  );
  const nodeIncrease = first(
    campaignRecords,
    (record) =>
      Number(record?.nodeScale?.sparkNodes ?? 0) >
      Number(record?.nodeScale?.baselineSparkNodes ?? 0),
  );
  const peakSparkNodes = Math.max(
    0,
    ...campaignRecords.map((record) => Number(record?.nodeScale?.sparkNodes ?? 0)),
  );
  const nodePeak = first(
    campaignRecords,
    (record) =>
      peakSparkNodes > Number(record?.nodeScale?.baselineSparkNodes ?? 0) &&
      Number(record?.nodeScale?.sparkNodes ?? 0) === peakSparkNodes,
  );
  const allRunsSuccess = first(campaignRecords, runEntriesAllSuccess);
  const baselineRecovered = first(
    campaignRecords,
    (record) =>
      runEntriesAllSuccess(record) &&
      activeSparkPods(record) === 0 &&
      Number(record?.nodeScale?.sparkNodes ?? -1) ===
        Number(record?.nodeScale?.baselineSparkNodes ?? -2),
  );
  const removalSignals = new Set(
    campaignRecords.flatMap((record) =>
      (record?.events?.items ?? [])
        .filter((event) =>
          ["Drained", "DisruptionTerminating", "RemovingNode"].includes(event.reason),
        )
        .map((event) => `${event.observedAt}:${event.reason}:${event.kind}`),
    ),
  ).size;

  const observedEntries = new Map(
    (latestCampaignRecord?.runs?.entries ?? []).map((entry) => [entry.runHash, entry]),
  );
  const identityLinks = (campaign.redactedRuns ?? [])
    .map((redacted) => {
      const entry = observedEntries.get(redacted.run) ?? {};
      return {
        alias: redacted.alias,
        runHash: redacted.run,
        jobHash: redacted.job,
        applicationUidHash: entry.uidHash ?? null,
        snapshotHash: entry.snapshotHash ?? null,
        datasetHash: redacted.dataset,
        groupHash: entry.groupHash ?? null,
        tableHash: entry.tableHash ?? null,
        outputHash: entry.outputHash ?? null,
        checkpointHash: entry.checkpointHash ?? null,
      };
    })
    .sort((left, right) => left.alias.localeCompare(right.alias));
  const identitiesComplete =
    identityLinks.length === 3 &&
    identityLinks.every((identity) =>
      Object.entries(identity)
        .filter(([key]) => key !== "alias")
        .every(([, value]) => typeof value === "string" && value.length === 12),
    );

  const raceStart = (race.timeline ?? []).find(
    (item) => item.event === "race-run-created-at-six-replicas",
  );
  const raceVerified = (race.timeline ?? []).at(-1) ?? null;
  const checks = {
    apiLoadObserved:
      apiLoadStart !== null &&
      hpaSix !== null &&
      load.phase === "completed-200" &&
      Number(load.targetRps) === 200,
    fastApiScaleOut:
      Number(hpaSix?.hpa?.currentReplicas ?? 0) === 6 &&
      Number(race?.counts?.raceTargets ?? 0) === 6,
    sameRunExactOne:
      race.status === "passed" &&
      allChecksPass(race.checks) &&
      race.counts.externalExecutions === 1 &&
      race.counts.sparkApplications === 1 &&
      race.counts.newIcebergSnapshots === 1 &&
      race.counts.catalogMaterializations === 1,
    apiContinuity:
      Number(load.non2xx) === 0 &&
      Number(load.serverErrors) === 0 &&
      Number(load.totalRequests) > 0,
    fastApiScaleIn:
      cleanup.status === "passed" &&
      cleanup.checks?.hpaAtMinimum === true &&
      cleanup.checks?.fastApiStable === true &&
      cleanup.checks?.fastApiPodsStable === true,
    exactlyThreeSparkRuns:
      campaign.status === "submitted" &&
      expectedRunHashes.length === 3 &&
      multiResults.counts?.runs === 3,
    pendingToRunning:
      driverPendingStart !== null &&
      driverPendingPeak !== null &&
      driverRunning !== null &&
      executorPendingStart !== null &&
      executorPendingPeak !== null &&
      executorRunning !== null &&
      driverPendingStart.observedAt <= driverPendingPeak.observedAt &&
      driverPendingPeak.observedAt < driverRunning.observedAt &&
      executorPendingStart.observedAt <= executorPendingPeak.observedAt &&
      executorPendingPeak.observedAt < executorRunning.observedAt,
    sparkNodeScaleOut:
      nodeIncrease !== null &&
      nodePeak !== null &&
      driverPendingStart !== null &&
      driverRunning !== null &&
      executorPendingStart !== null &&
      executorRunning !== null &&
      peakSparkNodes >= 2 &&
      driverPendingStart.observedAt < nodeIncrease.observedAt &&
      nodeIncrease.observedAt < driverRunning.observedAt &&
      executorPendingStart.observedAt <= nodePeak.observedAt &&
      nodePeak.observedAt < executorRunning.observedAt &&
      removalSignals > 0,
    multiRunDataExact:
      multiResults.status === "passed" &&
      allChecksPass(multiResults.checks) &&
      multiResults.counts.expectedRows === 300 &&
      multiResults.counts.sparkInputRows === 300 &&
      multiResults.counts.sparkOutputRows === 300 &&
      multiResults.counts.trinoVerifiedRows === 300 &&
      multiResults.counts.dataFiles === 3 &&
      multiResults.counts.materializations === 3,
    multiRunIsolation:
      multiResults.checks?.consumerGroupsUnique === true &&
      multiResults.checks?.icebergTablesUnique === true &&
      multiResults.checks?.outputsUnique === true &&
      multiResults.checks?.checkpointsUnique === true &&
      multiResults.checks?.snapshotsUnique === true &&
      multiResults.checks?.datasetsUnique === true &&
      identitiesComplete,
    sparkScaleIn:
      allRunsSuccess !== null &&
      baselineRecovered !== null &&
      cleanup.checks?.sparkNodesReturnedToBaseline === true,
    temporaryResourcesClean:
      cleanup.checks?.temporaryResourcesZero === true &&
      cleanup.checks?.loadGeneratorStopped === true,
    continuousBoundary:
      race.counts?.continuousSessionsStarted === 0 &&
      (latestCampaignRecord?.runs?.continuousSessionsStarted ?? 0) === 0,
    priorFailuresNotSubstituted:
      (priorReceipts.length === 0 ||
        (priorReceipts.length >= 3 &&
          priorReceipts.some((receipt) => receipt.status === "partial"))) &&
      multiResults.checks?.noResultSubstitution === true,
    identityLinksComplete: identitiesComplete,
    evidenceSanitized: false,
  };

  const receipt = {
    contractVersion: "1.0",
    scope: "eks-day17-pair-b-scale-and-concurrency",
    createdAt,
    status: "pending",
    checks,
    apiTimeline: [
      timelinePoint(apiLoadStart, "api-load-start", {
        hpaReplicas: Number(apiLoadStart?.hpa?.currentReplicas ?? 0),
        fastApiReady: Number(apiLoadStart?.fastapi?.deployment?.ready ?? 0),
      }),
      timelinePoint(hpaSix, "hpa-scale-out-observed", {
        hpaReplicas: Number(hpaSix?.hpa?.currentReplicas ?? 0),
        fastApiReady: Number(hpaSix?.fastapi?.deployment?.ready ?? 0),
      }),
      {
        at: raceStart?.at ?? null,
        event: "same-run-race-start",
        hpaReplicas: 6,
        fastApiTargets: Number(race.counts?.raceTargets ?? 0),
      },
      {
        at: load.observedAt,
        event: "api-load-stop",
        targetRps: Number(load.targetRps ?? 0),
        totalRequests: Number(load.totalRequests ?? 0),
        non2xx: Number(load.non2xx ?? 0),
        serverErrors: Number(load.serverErrors ?? 0),
      },
      {
        at: raceVerified?.at ?? null,
        event: "same-run-exact-one-verified",
        externalExecutions: Number(race.counts?.externalExecutions ?? 0),
        sparkApplications: Number(race.counts?.sparkApplications ?? 0),
        snapshots: Number(race.counts?.newIcebergSnapshots ?? 0),
        materializations: Number(race.counts?.catalogMaterializations ?? 0),
      },
      {
        at: cleanup.observedAt,
        event: "hpa-scale-in-verified",
        hpaReplicas: Number(cleanup.hpa?.current ?? 0),
        fastApiReady: Number(cleanup.fastapi?.deployment?.ready ?? 0),
        terminatingPods: Number(cleanup.fastapi?.pods?.terminating ?? 0),
      },
    ],
    sparkTimeline: [
      {
        at: campaign.createdAt,
        event: "three-isolated-runs-submitted",
        runs: Number(campaign.counts?.submittedRuns ?? 0),
      },
      timelinePoint(driverPendingStart, "drivers-pending-start", {
        count: phaseCount(driverPendingStart, "driver", "Pending"),
      }),
      timelinePoint(nodeIncrease, "spark-node-scale-out", {
        sparkNodes: Number(nodeIncrease?.nodeScale?.sparkNodes ?? 0),
      }),
      timelinePoint(driverPendingPeak, "drivers-pending-peak", {
        count: phaseCount(driverPendingPeak, "driver", "Pending"),
      }),
      timelinePoint(driverRunning, "drivers-running", {
        count: phaseCount(driverRunning, "driver", "Running"),
      }),
      timelinePoint(executorPendingStart, "executors-pending-start", {
        count: phaseCount(executorPendingStart, "executor", "Pending"),
      }),
      timelinePoint(executorPendingPeak, "executors-pending-peak", {
        count: phaseCount(executorPendingPeak, "executor", "Pending"),
      }),
      timelinePoint(nodePeak, "spark-node-peak", {
        sparkNodes: Number(nodePeak?.nodeScale?.sparkNodes ?? 0),
      }),
      timelinePoint(executorRunning, "executors-running", {
        count: phaseCount(executorRunning, "executor", "Running"),
      }),
      timelinePoint(allRunsSuccess, "all-runs-data-success", {
        activeSparkPods: activeSparkPods(allRunsSuccess),
        sparkNodes: Number(allRunsSuccess?.nodeScale?.sparkNodes ?? 0),
        trinoVerifiedRows: Number(multiResults.counts?.trinoVerifiedRows ?? 0),
        materializations: Number(multiResults.counts?.materializations ?? 0),
      }),
      timelinePoint(baselineRecovered, "spark-node-baseline-recovered", {
        activeSparkPods: activeSparkPods(baselineRecovered),
        sparkNodes: Number(baselineRecovered?.nodeScale?.sparkNodes ?? 0),
        removalSignals,
      }),
    ],
    identityLinks: {
      sameRunRace: {
        alias: "Same-Run Race",
        runHash: race.redactedIdentity?.run ?? null,
        applicationHash: race.redactedIdentity?.application ?? null,
        snapshotHash: race.redactedIdentity?.snapshot ?? null,
        datasetHash: race.redactedIdentity?.dataset ?? null,
        fixtureBatchHash: race.redactedIdentity?.fixtureBatch ?? null,
      },
      multiSpark: identityLinks,
    },
    outcomes: {
      api: {
        peakHpaReplicas: 6,
        finalHpaReplicas: Number(cleanup.hpa?.current ?? 0),
        sameRunExternalExecutions: Number(race.counts?.externalExecutions ?? 0),
        sameRunSparkApplications: Number(race.counts?.sparkApplications ?? 0),
        sameRunSnapshots: Number(race.counts?.newIcebergSnapshots ?? 0),
        sameRunMaterializations: Number(race.counts?.catalogMaterializations ?? 0),
        serverErrors: Number(load.serverErrors ?? 0),
      },
      spark: {
        runs: Number(multiResults.counts?.runs ?? 0),
        peakSparkNodes,
        finalCampaignSparkNodes: Number(cleanup.campaign?.recoveredSparkNodes ?? -1),
        expectedRows: Number(multiResults.counts?.expectedRows ?? 0),
        trinoVerifiedRows: Number(multiResults.counts?.trinoVerifiedRows ?? 0),
        dataFiles: Number(multiResults.counts?.dataFiles ?? 0),
        materializations: Number(multiResults.counts?.materializations ?? 0),
      },
      cleanup: {
        temporaryKubernetesResources:
          Number(cleanup.temporary?.jobs ?? 0) +
          Number(cleanup.temporary?.pods ?? 0) +
          Number(cleanup.temporary?.configMaps ?? 0) +
          Number(cleanup.temporary?.secrets ?? 0),
        localLoadProcesses: Number(cleanup.temporary?.localLoadProcesses ?? 0),
        durableRuns: Number(cleanup.preserved?.durableRuns ?? 0),
        durableSnapshots: Number(cleanup.preserved?.snapshots ?? 0),
        durableMaterializations: Number(cleanup.preserved?.materializations ?? 0),
      },
    },
    executionHistory: {
      priorSubmissionReceipts: priorReceipts.map((prior) => ({
        status: prior.status ?? "unknown",
        submittedRuns: Number(prior.counts?.submittedRuns ?? 0),
        failedSubmissions: Number(prior.counts?.failedSubmissions ?? 0),
      })),
      finalCampaign: "isolated-three-run-campaign",
      automaticPartialFillRetry: false,
      failedRunResultsUsedAsSubstitution: false,
      sameRunRecoveryCreatedNewSparkResult: false,
    },
    executed: [
      "read-only API load at reviewed 50 and 200 RPS stages",
      "same-run race across six FastAPI targets",
      "three isolated Spark runs with baked runtime",
      "read-only exact snapshot and Catalog verification",
      "read-only scale-in and cleanup audit",
    ],
    notExecuted: [
      "fourth Spark run because three runs satisfied the concurrency target",
      "IAM, NodePool, or RBAC expansion",
      "forced FastAPI or Spark Pod deletion",
      "NodePool policy change for faster scale-in",
      "CloudWatch integration or EC2 rollback cutover",
    ],
    references: {
      integratedEvidence: "docs/eks-day17-final-integration-evidence-assembly.md",
      nodePoolContract: "docs/eks-phase-12-auto-mode-node-pools.md",
      nodePoolRuntimeEvidence: "docs/eks-day14-runtime-evidence.md",
      sameRunRaceEvidence: "docs/eks-day17-b-same-run-race-live-evidence.md",
      multiSparkEvidence: "docs/eks-day17-b-multi-spark-live-evidence.md",
    },
    limits: [
      "local operator SparkApplication list RBAC remained forbidden",
      "later cluster workloads after campaign baseline recovery were outside cleanup scope",
      "raw identifiers remain only in mode 0600 private source receipts",
    ],
  };
  receipt.checks.evidenceSanitized = receiptIsSanitized(receipt, [
    race,
    campaign,
    ...priorReceipts,
  ]);
  receipt.status = allChecksPass(receipt.checks) ? "passed" : "failed";
  return receipt;
}

async function assertPrivateInput(path) {
  const absolute = resolve(path);
  if (!absolute.startsWith("/private/tmp/asklake-day17-")) {
    throw new Error("Day 17 receipt inputs must remain under /private/tmp");
  }
  const details = await stat(absolute);
  if ((details.mode & 0o777) !== 0o600 || details.size <= 0) {
    throw new Error("Day 17 receipt inputs must be non-empty mode 0600 files");
  }
  return absolute;
}

async function readJson(path) {
  return JSON.parse(await readFile(await assertPrivateInput(path), "utf8"));
}

async function readJsonLines(path) {
  const content = await readFile(await assertPrivateInput(path), "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = resolve(options.output);
  if (!output.startsWith("/private/tmp/asklake-day17-")) {
    throw new Error("Day 17 final receipt must remain under /private/tmp");
  }
  try {
    await stat(output);
    throw new Error("Day 17 final receipt already exists; preserve it and choose a new output");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const [
    race,
    load,
    scaleRecords,
    campaign,
    multiRecords,
    multiResults,
    cleanup,
    priorReceipts,
  ] = await Promise.all([
    readJson(options.race),
    readJson(options.load),
    readJsonLines(options.scaleObserver),
    readJson(options.campaign),
    readJsonLines(options.multiObserver),
    readJson(options.multiResults),
    readJson(options.cleanup),
    Promise.all(options.prior.map(readJson)),
  ]);
  const receipt = buildFinalReceipt({
    race,
    load,
    scaleRecords,
    campaign,
    multiRecords,
    multiResults,
    cleanup,
    priorReceipts,
  });
  if (receipt.status !== "passed") {
    const failedChecks = Object.entries(receipt.checks)
      .filter(([, passed]) => passed !== true)
      .map(([name]) => name)
      .join(",");
    throw new Error(`Day 17 final receipt checks did not pass: ${failedChecks}`);
  }
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(output, 0o600);
  process.stdout.write(
    `day17_final=${receipt.status} api_peak=${receipt.outcomes.api.peakHpaReplicas} ` +
      `spark_runs=${receipt.outcomes.spark.runs} spark_nodes=${receipt.outcomes.spark.peakSparkNodes}->${receipt.outcomes.spark.finalCampaignSparkNodes} ` +
      `rows=${receipt.outcomes.spark.trinoVerifiedRows}/${receipt.outcomes.spark.expectedRows} temporary=${receipt.outcomes.cleanup.temporaryKubernetesResources}\n`,
  );
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
