import { buildJobListResult } from "../src/createPipeline.mjs";

const jobs = [
  jobFixture({ id: "JOB-001", owner: "admin", schedule: "매일 00:00", status: "scheduled" }),
  jobFixture({
    id: "JOB-002",
    owner: "data-team",
    runHistory: [{ status: "failed" }],
    schedule: "10분마다",
    status: "failed",
  }),
  jobFixture({ id: "JOB-003", owner: "platform", schedule: "실시간 수집", status: "stopped" }),
];

const all = buildJobListResult(jobs);
assert(all.facets.total === 3, "전체 facet은 모든 Job을 집계해야 합니다.");
assert(all.facets.statusCounts.scheduled === 2, "legacy 실패 상태는 실행 대기로 정규화해야 합니다.");
assert(all.facets.statusCounts.failed === 0, "실패는 현재 Job 상태 facet에 남기지 않아야 합니다.");
assert(all.facets.latestRunOutcomeCounts.failed === 1, "최근 실행 실패는 독립 결과 facet으로 집계해야 합니다.");
assert(all.facets.owners.join(",") === "admin,data-team,platform", "소유자 facet은 전체 목록 기준이어야 합니다.");

const failedRuns = buildJobListResult(jobs, { lastRunOutcome: "failed" });
assert(failedRuns.jobs.length === 1 && failedRuns.jobs[0].id === "JOB-002", "최근 실행 결과 필터가 동작해야 합니다.");

const scheduledOwner = buildJobListResult(jobs, { owner: "data-team", statuses: ["scheduled"] });
assert(scheduledOwner.jobs.length === 1 && scheduledOwner.jobs[0].id === "JOB-002", "정규화된 상태와 소유자 필터를 조합해야 합니다.");

const realtime = buildJobListResult(jobs, { scheduleKind: "realtime" });
assert(realtime.jobs.length === 1 && realtime.jobs[0].id === "JOB-003", "실시간 실행 주기 필터가 동작해야 합니다.");

console.log("verify-job-list: ok");

function jobFixture(overrides) {
  return {
    id: "JOB-000",
    owner: "owner",
    runHistory: [],
    schedule: "수동",
    status: "scheduled",
    ...overrides,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
