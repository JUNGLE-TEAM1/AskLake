import assert from "node:assert/strict";

import {
  assertEmrAdmissionApplication,
  emrAdmissionPolicy,
  estimateEmrJobResources,
} from "../src/emrAdmission.mjs";

const environment = {
  ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED: "true",
  ASKLAKE_EMR_SERVERLESS_BATCH_MAX_CONCURRENT_RUNS: "4",
  ASKLAKE_EMR_SERVERLESS_BATCH_MAX_DISK_GB: "2000",
  ASKLAKE_EMR_SERVERLESS_BATCH_MAX_MEMORY_GB: "320",
  ASKLAKE_EMR_SERVERLESS_BATCH_MAX_QUEUED_RUNS: "20",
  ASKLAKE_EMR_SERVERLESS_BATCH_MAX_VCPU: "80",
  ASKLAKE_EMR_SERVERLESS_BATCH_QUEUE_TIMEOUT_MINUTES: "60",
};
const policy = emrAdmissionPolicy(environment, "batch");
const resources = estimateEmrJobResources({
  driverCores: 1,
  driverDiskGb: 20,
  driverMemory: "4g",
  executorCores: 2,
  executorDiskGb: 20,
  executorMemory: "4g",
  maxExecutors: 10,
  memoryOverheadFactor: 0.1,
});

assert.deepEqual(resources, {
  diskGb: 220,
  maxExecutors: 10,
  memoryGb: 48.4,
  vcpu: 21,
});
assert.equal(policy.maxConcurrentRuns, 4);
assert.equal(policy.maxQueuedRuns, 20);

const validApplication = {
  autoStopConfiguration: { enabled: true, idleTimeoutMinutes: 15 },
  jobLevelCostAllocationConfiguration: { enabled: true },
  maximumCapacity: { cpu: "80 vCPU", memory: "320 GB", disk: "2000 GB" },
  schedulerConfiguration: { maxConcurrentRuns: 4, queueTimeoutMinutes: 60 },
};
const snapshot = assertEmrAdmissionApplication(validApplication, policy, resources);
assert.equal(snapshot.enabled, true);
assert.equal(snapshot.requestedResources.vcpu, 21);

assert.throws(
  () => assertEmrAdmissionApplication({
    ...validApplication,
    jobLevelCostAllocationConfiguration: { enabled: false },
  }, policy, resources),
  (error) => error?.code === "EMR_ADMISSION_APPLICATION_MISMATCH" && error?.status === 422,
);
assert.throws(
  () => assertEmrAdmissionApplication({
    ...validApplication,
    schedulerConfiguration: { maxConcurrentRuns: 5, queueTimeoutMinutes: 60 },
  }, policy, resources),
  /maxConcurrentRuns=5 exceeds AskLake policy 4/,
);
assert.throws(
  () => assertEmrAdmissionApplication({
    ...validApplication,
    maximumCapacity: { cpu: "20 vCPU", memory: "320 GB", disk: "2000 GB" },
  }, policy, resources),
  /Job requests 21 vCPU; application maximum is 20/,
);
assert.throws(
  () => emrAdmissionPolicy({
    ...environment,
    ASKLAKE_EMR_SERVERLESS_BATCH_QUEUE_TIMEOUT_MINUTES: "14",
  }, "batch"),
  /between 15 and 720/,
);

console.log("EMR admission contract verified: resource estimate, application cap, scheduler, cost allocation, and queue policy guards.");
