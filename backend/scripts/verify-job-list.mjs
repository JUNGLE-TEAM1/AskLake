import { buildJobListResult } from "../src/createPipeline.mjs";

const jobs = [
  jobFixture({ id: "JOB-001", owner: "admin", schedule: "daily 00:00", status: "scheduled" }),
  jobFixture({ id: "JOB-002", owner: "data-team", runHistory: [{ status: "failed" }], schedule: "manual", status: "failed" }),
  jobFixture({ id: "JOB-003", owner: "platform", schedule: "realtime", status: "stopped" }),
];

const all = buildJobListResult(jobs);
assert(all.facets.total === 3, "all jobs should be counted");
assert(all.facets.statusCounts.scheduled === 1, "scheduled status should remain scheduled");
assert(all.facets.statusCounts.failed === 1, "failed status should remain visible");
assert(all.facets.latestRunOutcomeCounts.failed === 1, "latest failed outcome should be counted");

const failedOwner = buildJobListResult(jobs, { owner: "data-team", statuses: ["failed"] });
assert(failedOwner.jobs.length === 1 && failedOwner.jobs[0].id === "JOB-002", "failed status filtering should work");

const realtime = buildJobListResult(jobs, { scheduleKind: "realtime" });
assert(realtime.jobs.length === 1 && realtime.jobs[0].id === "JOB-003", "realtime schedule filtering should work");

console.log("verify-job-list: ok");

function jobFixture(overrides) {
  return { id: "JOB-000", owner: "owner", runHistory: [], schedule: "manual", status: "scheduled", ...overrides };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
