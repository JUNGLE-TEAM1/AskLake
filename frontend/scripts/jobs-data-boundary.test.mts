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
  assert.match(workspace, /useWorkspaceHydration/);
  assert.match(workspace, /usePipelineMutations/);
  assert.match(workspace, /useJobController/);
  assert.match(workspace, /useCatalogController/);
  assert.ok(lineCount("src/hooks/useAskLakeData.ts") <= 10);
  assert.ok(lineCount("src/state/asklake/useAskLakeWorkspace.ts") <= 120);

  for (const path of [
    "src/state/asklake/useWorkspaceHydration.ts",
    "src/state/asklake/usePipelineMutations.ts",
    "src/state/asklake/useJobController.ts",
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
