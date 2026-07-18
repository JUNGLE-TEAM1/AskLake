import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { getWorkspaceDataRequirements } from "../src/state/asklake/routeDataRequirements.ts";

const root = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

test("each route enables only the workspace data it consumes", () => {
  for (const flow of ["jobs", "jobDetail", "jobRuns"] as const) {
    assert.deepEqual(getWorkspaceDataRequirements(flow), { catalog: false, jobs: true });
  }

  for (const flow of ["catalog", "catalogDetail", "sql", "ai"] as const) {
    assert.deepEqual(getWorkspaceDataRequirements(flow), { catalog: true, jobs: false });
  }

  for (const flow of ["source", "recordParsing", "schema", "rules", "repeat", "manual", "target", "permission", "review", "dashboard", "admin", "profile", "login"] as const) {
    assert.deepEqual(getWorkspaceDataRequirements(flow), { catalog: false, jobs: false });
  }
});

test("Jobs and Catalog hydration cannot call each other's list API", () => {
  const jobsHydration = read("src/state/asklake/useJobsHydration.ts");
  const catalogHydration = read("src/state/asklake/useCatalogHydration.ts");

  assert.match(jobsHydration, /\bgetJobs\b/);
  assert.doesNotMatch(jobsHydration, /\bgetDatasets\b/);
  assert.match(catalogHydration, /\bgetDatasets\b/);
  assert.doesNotMatch(catalogHydration, /\bgetJobs\b/);
});

test("route changes invalidate stale domain reads and errors stay domain-owned", () => {
  const jobsHydration = read("src/state/asklake/useJobsHydration.ts");
  const catalogHydration = read("src/state/asklake/useCatalogHydration.ts");
  const state = read("src/state/asklake/useAskLakeWorkspaceState.ts");

  for (const hydration of [jobsHydration, catalogHydration]) {
    assert.match(hydration, /requests\.current\.invalidate\(\)/);
    assert.match(hydration, /requests\.current\.isCurrent\(lease\)/);
  }
  assert.match(state, /\[jobsError, setJobsError\]/);
  assert.match(state, /\[catalogError, setCatalogError\]/);
  assert.doesNotMatch(state, /\[dataError, setDataError\]/);
});

test("the compatibility refresh reads only the active route domain", () => {
  const workspace = read("src/state/asklake/useAskLakeWorkspace.ts");

  assert.match(workspace, /if \(dataRequirements\.jobs\) return jobsHydration\.refreshJobs\(\);/);
  assert.match(workspace, /if \(dataRequirements\.catalog\) return catalogHydration\.refreshCatalog\(\);/);
  assert.doesNotMatch(workspace, /Promise\.all/);
});

test("Job polling does not refresh the full Catalog list", () => {
  const jobController = read("src/state/asklake/useJobController.ts");
  assert.doesNotMatch(jobController, /await getDatasets\(\)/);
});

test("Dashboard Catalog loading is enabled only for views that use datasets", () => {
  const dashboardPage = read("src/pages/dashboard/DashboardPage.tsx");
  const dashboardDatasets = read("src/pages/dashboard/runtime/useDashboardDatasets.ts");

  assert.match(dashboardPage, /useDashboardDatasets\(view === "runtime"\)/);
  assert.match(dashboardDatasets, /export function useDashboardDatasets\(enabled = true\)/);
});

test("Dashboard route loads reject stale responses and live routes do not import legacy mock storage", () => {
  const loaders = read("src/pages/dashboard/runtime/useDashboardRuntimeLoaders.ts");
  const dashboardPage = read("src/pages/dashboard/DashboardPage.tsx");
  const dashboardTypes = read("src/types/dashboard.ts");

  assert.match(loaders, /LatestRequestGate/);
  assert.match(loaders, /\.isCurrent\(lease\)/);
  assert.match(loaders, /\.invalidate\(\)/);
  assert.doesNotMatch(dashboardPage, /services\/mockApi/);
  assert.doesNotMatch(dashboardPage, /DashboardLegacy(?:Builder|Detail)View/);
  assert.match(dashboardTypes, /DashboardView = "list" \| "runtime"/);
});
