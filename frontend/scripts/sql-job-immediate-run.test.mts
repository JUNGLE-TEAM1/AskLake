import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("batch SQL Job creation requests exactly one initial run", () => {
  const mutations = source("state/asklake/usePipelineMutations.ts");

  assert.match(mutations, /const requestInitialSqlRun = async \(createdJob: JobRowData\)/);
  assert.match(mutations, /runMockJobCommand\(createdJob, "run"\)/);
  assert.match(mutations, /runLiveJobCommand\(createdJob, "run"\)/);
  assert.match(mutations, /runAfterCreate: true/);

  const trinoCreate = mutations.indexOf("await createLiveTrinoSqlJob(request)");
  const trinoRun = mutations.indexOf("await requestInitialSqlRun(normalizedJob)", trinoCreate);
  assert.ok(trinoCreate >= 0 && trinoRun > trinoCreate);
});

test("batch initial-run failure preserves the created Job and reports partial success", () => {
  const mutations = source("state/asklake/usePipelineMutations.ts");

  assert.match(mutations, /applyJobSnapshot\(await getLiveJob\(createdJob\.id\)\)/);
  assert.match(mutations, /analysis\.sql_job\.initial_run_failed/);
  assert.match(mutations, /SQL Job은 생성됐지만 첫 실행 요청에 실패했습니다/);
  assert.match(mutations, /반복 SQL Job은 생성됐지만 첫 실행 요청에 실패했습니다/);
});

test("Continuous SQL separates durable creation from the start command", () => {
  const continuous = source("pages/sql/useContinuousSqlJoin.ts");
  const createdAudit = continuous.indexOf('onAction("analysis.continuous_sql.created"');
  const startCommand = continuous.indexOf("await commandContinuousSqlJob(job.id, \"start\"");

  assert.ok(createdAudit >= 0 && startCommand > createdAudit);
  assert.match(continuous, /Continuous SQL Job은 생성됐지만 시작에 실패했습니다/);
  assert.match(continuous, /analysis\.continuous_sql\.start_failed/);
});
