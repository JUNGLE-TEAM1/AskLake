#!/usr/bin/env node

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CONFIRMATION = "run-read-only-api-load";

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    rate: 50,
    durationSeconds: 60,
    concurrency: 64,
    timeoutMs: 5_000,
    phase: "probe-50",
    statusPath: "/private/tmp/asklake-day17-load-status.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--rate") options.rate = parseInteger(argv[++index], "rate", 1, 200);
    else if (argument === "--duration") {
      options.durationSeconds = parseInteger(argv[++index], "duration", 1, 600);
    } else if (argument === "--concurrency") {
      options.concurrency = parseInteger(argv[++index], "concurrency", 1, 64);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseInteger(argv[++index], "timeout-ms", 100, 5_000);
    } else if (argument === "--phase") {
      options.phase = String(argv[++index] || "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24);
    } else if (argument === "--status") options.statusPath = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.phase) throw new Error("phase must not be empty");
  return options;
}

function assertExternalStatusPath(statusPath) {
  if (!isAbsolute(statusPath)) throw new Error("status path must be absolute");
  const relation = relative(REPOSITORY_ROOT, statusPath);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("status path must be outside the repository");
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function writeStatus(statusPath, status) {
  await mkdir(dirname(statusPath), { recursive: true });
  const temporaryPath = `${statusPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, statusPath);
  await chmod(statusPath, 0o600);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const endpoint = process.env.ASKLAKE_DAY17_LOAD_URL;
  if (process.env.ASKLAKE_DAY17_LOAD_CONFIRM !== CONFIRMATION) {
    throw new Error(`set ASKLAKE_DAY17_LOAD_CONFIRM=${CONFIRMATION}`);
  }
  if (!endpoint || !/^http:\/\/[^/\s]+\/api\/health$/.test(endpoint)) {
    throw new Error("ASKLAKE_DAY17_LOAD_URL must be the reviewed HTTP ALB /api/health endpoint");
  }
  assertExternalStatusPath(options.statusPath);

  const state = {
    totalRequests: 0,
    non2xx: 0,
    serverErrors: 0,
    databaseFailures: 0,
    transportErrors: 0,
    consecutiveTransportErrors: 0,
    skippedRequests: 0,
    inFlight: 0,
    durations: [],
    aborted: false,
    abortReason: null,
  };
  const startedAt = Date.now();
  const deadline = startedAt + options.durationSeconds * 1_000;

  const publicStatus = (phase = options.phase) => ({
    phase,
    targetRps: options.rate,
    totalRequests: state.totalRequests,
    non2xx: state.non2xx,
    serverErrors: state.serverErrors,
    p95Ms: percentile(state.durations, 0.95),
    observedAt: new Date().toISOString(),
  });

  const abort = (reason) => {
    state.aborted = true;
    state.abortReason ||= reason;
  };

  const issueRequest = async () => {
    if (state.aborted || state.inFlight >= options.concurrency) {
      if (!state.aborted) state.skippedRequests += 1;
      return;
    }
    state.inFlight += 1;
    const requestStarted = performance.now();
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "asklake-day17-scale-probe" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const duration = performance.now() - requestStarted;
      state.durations.push(duration);
      state.totalRequests += 1;
      if (response.status < 200 || response.status >= 300) state.non2xx += 1;
      if (response.status >= 500) state.serverErrors += 1;

      let document = null;
      try {
        document = await response.json();
      } catch {
        state.non2xx += response.ok ? 1 : 0;
      }
      if (document?.ok !== true || document?.database?.ok !== true) {
        state.databaseFailures += 1;
      }
      state.consecutiveTransportErrors = 0;

      if (state.serverErrors > 0) abort("server-error");
      if (state.databaseFailures > 0) abort("database-health-failure");
      if (state.totalRequests >= 100 && state.non2xx / state.totalRequests > 0.001) {
        abort("non-2xx-ratio");
      }
    } catch {
      state.totalRequests += 1;
      state.non2xx += 1;
      state.transportErrors += 1;
      state.consecutiveTransportErrors += 1;
      if (state.consecutiveTransportErrors >= 5) abort("consecutive-transport-errors");
    } finally {
      state.inFlight -= 1;
    }
  };

  await writeStatus(options.statusPath, publicStatus("starting"));
  const requestIntervalMs = 100;
  const requestsPerTick = options.rate / (1_000 / requestIntervalMs);
  let requestCredit = 0;
  let lastTickAt = performance.now();
  let lastStatusAt = 0;

  while (!state.aborted && Date.now() < deadline) {
    const now = performance.now();
    const elapsed = now - lastTickAt;
    lastTickAt = now;
    requestCredit += requestsPerTick * (elapsed / requestIntervalMs);
    const requestsToIssue = Math.floor(requestCredit);
    requestCredit -= requestsToIssue;
    for (let index = 0; index < requestsToIssue; index += 1) void issueRequest();

    if (Date.now() - lastStatusAt >= 1_000) {
      lastStatusAt = Date.now();
      await writeStatus(options.statusPath, publicStatus());
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, requestIntervalMs));
  }

  while (state.inFlight > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const finalPhase = state.aborted ? `aborted-${options.rate}` : `completed-${options.rate}`;
  await writeStatus(options.statusPath, publicStatus(finalPhase));

  const result = {
    phase: finalPhase,
    targetRps: options.rate,
    durationSeconds: Math.round((Date.now() - startedAt) / 1_000),
    totalRequests: state.totalRequests,
    non2xx: state.non2xx,
    serverErrors: state.serverErrors,
    databaseFailures: state.databaseFailures,
    transportErrors: state.transportErrors,
    skippedRequests: state.skippedRequests,
    p95Ms: percentile(state.durations, 0.95),
    aborted: state.aborted,
    abortReason: state.abortReason,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (state.aborted || state.skippedRequests > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Day 17 API load runner failed: ${error.message}\n`);
  process.exitCode = 1;
});
