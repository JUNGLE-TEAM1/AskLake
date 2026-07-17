import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

function lineCount(path: string) {
  return read(path).trimEnd().split("\n").length;
}

test("JobsPages remains a compatibility facade over bounded feature modules", () => {
  const facade = read("src/pages/ingest/JobsPages.tsx");
  assert.match(facade, /export \{ JobsLandingPage \} from "\.\/jobs\/JobsLandingPage";/);
  assert.match(facade, /export \{ JobDetailPage \} from "\.\/jobs\/JobDetailPage";/);
  assert.match(facade, /export \{ JobRunsPage \} from "\.\/jobs\/JobRunsPage";/);
  assert.ok(lineCount("src/pages/ingest/JobsPages.tsx") <= 10);

  for (const path of [
    "src/pages/ingest/jobs/JobsLandingPage.tsx",
    "src/pages/ingest/jobs/JobDetailPage.tsx",
    "src/pages/ingest/jobs/ContinuousJobRunsPage.tsx",
    "src/pages/ingest/jobs/SnapshotJobRunsPage.tsx",
    "src/pages/ingest/jobs/jobShared.tsx",
    "src/pages/ingest/jobs/jobDetailModel.tsx",
  ]) {
    assert.ok(lineCount(path) <= 850, `${path} exceeded the bounded feature-module budget`);
  }
});

test("AskLake data facade composes domain controllers instead of owning server state", () => {
  const compatibilityFacade = read("src/hooks/useAskLakeData.ts");
  const workspace = read("src/state/asklake/useAskLakeWorkspace.ts");
  assert.match(compatibilityFacade, /useAskLakeWorkspace as useAskLakeData/);
  assert.doesNotMatch(compatibilityFacade, /useState|useEffect|getJobs|getDatasets/);
  assert.match(workspace, /useJobsHydration/);
  assert.match(workspace, /useCatalogHydration/);
  assert.match(workspace, /getWorkspaceDataRequirements/);
  assert.match(workspace, /usePipelineMutations/);
  assert.match(workspace, /useJobController/);
  assert.match(workspace, /useCatalogController/);
  assert.ok(lineCount("src/hooks/useAskLakeData.ts") <= 10);
  assert.ok(lineCount("src/state/asklake/useAskLakeWorkspace.ts") <= 120);

  for (const path of [
    "src/state/asklake/useJobsHydration.ts",
    "src/state/asklake/useCatalogHydration.ts",
    "src/state/asklake/routeDataRequirements.ts",
    "src/state/asklake/useJobRouteHydration.ts",
    "src/state/asklake/usePipelineMutations.ts",
    "src/state/asklake/useJobController.ts",
    "src/state/asklake/useSnapshotJobStatusPolling.ts",
    "src/state/asklake/useCatalogController.ts",
  ]) {
    assert.ok(lineCount(path) <= 400, `${path} exceeded the controller budget`);
  }
});

test("Job command rollback is guarded by an entity mutation revision", () => {
  const controller = read("src/state/asklake/useJobController.ts");
  assert.match(controller, /new MutationRevisionGate\(\)/);
  assert.match(controller, /mutationRevisions\.current\.begin\(job\.id\)/);
  assert.match(controller, /if \(!mutationRevisions\.current\.isCurrent\(mutationLease\)\) return false;/);
});

test("Jobs hydration owns list state without importing Catalog reads", () => {
  const hydration = read("src/state/asklake/useJobsHydration.ts");
  assert.match(hydration, /readInitialResource\(\s*getJobs,/);
  assert.match(hydration, /applyHydratedJobs\(result\.data\);/);
  assert.match(hydration, /setJobsError/);
  assert.doesNotMatch(hydration, /getDatasets|setCatalogLoading|setCatalogError/);
});

test("Job detail routes hydrate full history separately from the list summary", () => {
  const app = read("src/App.tsx");
  const routeHydration = read("src/state/asklake/useJobRouteHydration.ts");
  assert.match(app, /useJobRouteHydration\(\{/);
  assert.match(routeHydration, /getJob as getPipelineJob/);
  assert.match(routeHydration, /flow === "jobDetail" \|\| flow === "jobRuns"/);
  assert.match(routeHydration, /getPipelineJob\(matchedJobId\)/);
  assert.match(routeHydration, /mergeJobDetailWithCurrentStatus\(job, normalizedDetail\)/);
  assert.match(routeHydration, /\[flow, matchedJobId, setSelectedJob\]/);
});

test("Snapshot status refresh is one page-level request and pauses for hidden tabs", () => {
  const controller = read("src/state/asklake/useJobController.ts");
  const polling = read("src/state/asklake/useSnapshotJobStatusPolling.ts");
  assert.match(controller, /useSnapshotJobStatusPolling/);
  assert.doesNotMatch(controller, /pollSnapshotJobUntilTerminal|snapshotPollIntervalMs/);
  assert.match(polling, /getJobStatuses\(activeJobIds\)/);
  assert.match(polling, /document\.visibilityState === "hidden"/);
  assert.match(polling, /visibilitychange/);
  assert.match(polling, /snapshotStatusPollDelayMs\(consecutiveErrors\)/);
});
