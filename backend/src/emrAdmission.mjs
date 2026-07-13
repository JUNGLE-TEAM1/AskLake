export const EMR_ADMISSION_WORKLOADS = Object.freeze(new Set(["batch", "continuous"]));

export function emrAdmissionPolicy(environment = process.env, workload = "batch") {
  const normalized = String(workload || "").trim().toLowerCase();
  if (!EMR_ADMISSION_WORKLOADS.has(normalized)) {
    throw admissionError(`Unsupported EMR admission workload: ${normalized || "(empty)"}.`);
  }
  const enabled = environmentFlag(environment.ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED, false);
  const prefix = `ASKLAKE_EMR_SERVERLESS_${normalized.toUpperCase()}`;
  const defaults = normalized === "continuous"
    ? { concurrent: 5, disk: 1000, memory: 160, queue: 20, vcpu: 40 }
    : { concurrent: 4, disk: 2000, memory: 320, queue: 20, vcpu: 80 };
  return Object.freeze({
    enabled,
    maxConcurrentRuns: boundedInteger(environment[`${prefix}_MAX_CONCURRENT_RUNS`], defaults.concurrent, 1, 1000, `${prefix}_MAX_CONCURRENT_RUNS`),
    maxDiskGb: boundedInteger(environment[`${prefix}_MAX_DISK_GB`], defaults.disk, 1, 1_000_000, `${prefix}_MAX_DISK_GB`),
    maxIdleMinutes: boundedInteger(environment[`${prefix}_MAX_IDLE_MINUTES`], 15, 1, 10_080, `${prefix}_MAX_IDLE_MINUTES`),
    maxMemoryGb: boundedInteger(environment[`${prefix}_MAX_MEMORY_GB`], defaults.memory, 1, 1_000_000, `${prefix}_MAX_MEMORY_GB`),
    maxQueuedRuns: boundedInteger(environment[`${prefix}_MAX_QUEUED_RUNS`], defaults.queue, 0, 2000, `${prefix}_MAX_QUEUED_RUNS`),
    maxVcpu: boundedInteger(environment[`${prefix}_MAX_VCPU`], defaults.vcpu, 1, 1_000_000, `${prefix}_MAX_VCPU`),
    queueTimeoutMinutes: boundedInteger(environment[`${prefix}_QUEUE_TIMEOUT_MINUTES`], 60, 15, 720, `${prefix}_QUEUE_TIMEOUT_MINUTES`),
    requireJobCostAllocation: environmentFlag(environment.ASKLAKE_EMR_SERVERLESS_REQUIRE_JOB_COST_ALLOCATION, true),
    workload: normalized,
  });
}

export function estimateEmrJobResources(config) {
  const driverMemoryGb = sparkMemoryGb(config.driverMemory);
  const executorMemoryGb = sparkMemoryGb(config.executorMemory);
  const maxExecutors = positiveInteger(config.maxExecutors, "maxExecutors");
  const overheadFactor = finiteNumber(config.memoryOverheadFactor, 0.1, 0, 1, "memoryOverheadFactor");
  return Object.freeze({
    diskGb: positiveInteger(config.driverDiskGb, "driverDiskGb")
      + (positiveInteger(config.executorDiskGb, "executorDiskGb") * maxExecutors),
    maxExecutors,
    memoryGb: roundUp((driverMemoryGb + (executorMemoryGb * maxExecutors)) * (1 + overheadFactor), 3),
    vcpu: positiveInteger(config.driverCores, "driverCores")
      + (positiveInteger(config.executorCores, "executorCores") * maxExecutors),
  });
}

export function assertEmrAdmissionApplication(application, policy, requestedResources) {
  if (!policy?.enabled) return Object.freeze({ enabled: false });
  if (!application || typeof application !== "object") {
    throw admissionError("EMR admission preflight did not return an application.", "EMR_ADMISSION_APPLICATION_INVALID", 422);
  }
  const maximumCapacity = {
    diskGb: awsResourceNumber(application.maximumCapacity?.disk, "maximumCapacity.disk"),
    memoryGb: awsResourceNumber(application.maximumCapacity?.memory, "maximumCapacity.memory"),
    vcpu: awsResourceNumber(application.maximumCapacity?.cpu, "maximumCapacity.cpu"),
  };
  const scheduler = application.schedulerConfiguration || {};
  const maxConcurrentRuns = boundedAwsInteger(scheduler.maxConcurrentRuns, 1, 1000, "schedulerConfiguration.maxConcurrentRuns");
  const queueTimeoutMinutes = boundedAwsInteger(scheduler.queueTimeoutMinutes, 15, 720, "schedulerConfiguration.queueTimeoutMinutes");
  const violations = [];
  for (const [key, actual, configured] of [
    ["maximumCapacity.cpu", maximumCapacity.vcpu, policy.maxVcpu],
    ["maximumCapacity.memory", maximumCapacity.memoryGb, policy.maxMemoryGb],
    ["maximumCapacity.disk", maximumCapacity.diskGb, policy.maxDiskGb],
    ["schedulerConfiguration.maxConcurrentRuns", maxConcurrentRuns, policy.maxConcurrentRuns],
    ["schedulerConfiguration.queueTimeoutMinutes", queueTimeoutMinutes, policy.queueTimeoutMinutes],
  ]) {
    if (actual > configured) violations.push(`${key}=${actual} exceeds AskLake policy ${configured}`);
  }
  if (policy.requireJobCostAllocation && application.jobLevelCostAllocationConfiguration?.enabled !== true) {
    violations.push("jobLevelCostAllocationConfiguration.enabled must be true");
  }
  if (application.autoStopConfiguration?.enabled !== true) {
    violations.push("autoStopConfiguration.enabled must be true");
  } else if (Number(application.autoStopConfiguration.idleTimeoutMinutes) > policy.maxIdleMinutes) {
    violations.push(`autoStopConfiguration.idleTimeoutMinutes exceeds AskLake policy ${policy.maxIdleMinutes}`);
  }
  if (requestedResources) {
    for (const [key, requested, maximum] of [
      ["vCPU", requestedResources.vcpu, maximumCapacity.vcpu],
      ["memory GB", requestedResources.memoryGb, maximumCapacity.memoryGb],
      ["disk GB", requestedResources.diskGb, maximumCapacity.diskGb],
    ]) {
      if (Number(requested) > maximum) violations.push(`Job requests ${requested} ${key}; application maximum is ${maximum}`);
    }
  }
  if (violations.length > 0) {
    throw admissionError(
      `EMR application does not satisfy AskLake admission policy: ${violations.join("; ")}.`,
      "EMR_ADMISSION_APPLICATION_MISMATCH",
      422,
    );
  }
  return Object.freeze({
    enabled: true,
    maximumCapacity: Object.freeze(maximumCapacity),
    requestedResources,
    schedulerConfiguration: Object.freeze({ maxConcurrentRuns, queueTimeoutMinutes }),
    workload: policy.workload,
  });
}

function awsResourceNumber(value, name) {
  const match = /^([1-9][0-9]*)\s*(?:vcpu|gb)?$/i.exec(String(value || "").trim());
  if (!match) throw admissionError(`EMR application ${name} is missing or invalid.`, "EMR_ADMISSION_APPLICATION_INVALID", 422);
  return Number(match[1]);
}

function boundedAwsInteger(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw admissionError(`EMR application ${name} is missing or invalid.`, "EMR_ADMISSION_APPLICATION_INVALID", 422);
  }
  return parsed;
}

function sparkMemoryGb(value) {
  const match = /^([1-9][0-9]*)(g|m)$/i.exec(String(value || "").trim());
  if (!match) throw admissionError(`Invalid Spark memory value: ${String(value || "(empty)")}.`);
  const amount = Number(match[1]);
  return match[2].toLowerCase() === "m" ? amount / 1024 : amount;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw admissionError(`${name} must be a positive integer.`);
  return parsed;
}

function finiteNumber(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw admissionError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw admissionError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function environmentFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function roundUp(value, digits) {
  const factor = 10 ** digits;
  return Math.ceil((value * factor) - 1e-9) / factor;
}

function admissionError(message, code = "EMR_ADMISSION_CONFIGURATION_INVALID", status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
