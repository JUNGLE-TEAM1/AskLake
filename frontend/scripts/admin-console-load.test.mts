import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adminConsoleLoadSections,
  createLatestAdminAuditRequestTracker,
  deriveAdminConsoleViewState,
  settleAdminConsoleRequests,
} from "../src/pages/admin/adminConsoleLoadState.ts";
import type { AdminConsoleLoadData } from "../src/pages/admin/adminConsoleLoadState.ts";

const adminConsolePage = readFileSync(
  new URL("../src/pages/admin/AdminConsolePage.tsx", import.meta.url),
  "utf8",
);
const adminConsoleInitialLoad = readFileSync(
  new URL("../src/pages/admin/useAdminConsoleInitialLoad.ts", import.meta.url),
  "utf8",
);
const auditTypes = readFileSync(
  new URL("../src/types/audit.ts", import.meta.url),
  "utf8",
);

function response<Section extends keyof AdminConsoleLoadData>(
  section: Section,
): AdminConsoleLoadData[Section] {
  const responses: AdminConsoleLoadData = {
    users: { users: [] },
    groups: { groups: [] },
    permissions: { resources: [] },
    governance: { principalControls: [], resourceLocks: [] },
    audit: { logs: [] },
  };
  return responses[section];
}

test("one failed admin API preserves every fulfilled section", async () => {
  const auditError = Object.assign(new Error("감사 로그 장애"), { status: 500 });
  const result = await settleAdminConsoleRequests({
    users: Promise.resolve(response("users")),
    groups: Promise.resolve(response("groups")),
    permissions: Promise.resolve(response("permissions")),
    governance: Promise.resolve(response("governance")),
    audit: Promise.reject(auditError),
  });

  assert.deepEqual(Object.keys(result.data).sort(), ["governance", "groups", "permissions", "users"]);
  assert.deepEqual(result.errors, {
    audit: { message: "감사 로그 장애", status: 500 },
  });
});

test("failure state stays section-owned and preserves authorization status", async () => {
  const requests = Object.fromEntries(adminConsoleLoadSections.map((section) => [
    section,
    Promise.reject(Object.assign(new Error(`${section} forbidden`), { status: 403 })),
  ])) as { [Section in keyof AdminConsoleLoadData]: Promise<AdminConsoleLoadData[Section]> };

  const result = await settleAdminConsoleRequests(requests);

  assert.deepEqual(result.data, {});
  for (const section of adminConsoleLoadSections) {
    assert.equal(result.errors[section]?.status, 403);
  }
});

test("audit initial failure leaves unrelated metrics and tabs usable", () => {
  const errors = { audit: { message: "감사 로그 장애", status: 500 } };

  const usersView = deriveAdminConsoleViewState({ activeTab: "users", errors, loading: false });
  const auditView = deriveAdminConsoleViewState({ activeTab: "audit", errors, loading: false });

  assert.equal(usersView.canRenderActiveTab, true);
  assert.deepEqual(usersView.activeLoadFailures, []);
  assert.equal(auditView.canRenderActiveTab, false);
  assert.deepEqual(auditView.activeLoadFailures, [errors.audit]);
});

test("all five forbidden responses become a global admin denial", () => {
  const errors = Object.fromEntries(adminConsoleLoadSections.map((section) => [
    section,
    { message: `${section} forbidden`, status: 403 },
  ]));
  const view = deriveAdminConsoleViewState({ activeTab: "users", errors, loading: false });

  assert.equal(view.permissionDenied, true);
  assert.equal(view.canRenderActiveTab, false);
});

test("governance failure blocks management tabs that depend on controls", () => {
  const errors = { governance: { message: "통제 상태 장애", status: 500 } };

  for (const activeTab of ["users", "groups", "permissions"] as const) {
    const view = deriveAdminConsoleViewState({ activeTab, errors, loading: false });
    assert.equal(view.canRenderActiveTab, false);
    assert.deepEqual(view.activeLoadFailures, [errors.governance]);
  }
});

test("audit refresh failure is a non-blocking stale-data warning", () => {
  const refreshFailure = { message: "새로고침 장애", status: 502 };
  const view = deriveAdminConsoleViewState({
    activeTab: "audit",
    auditRefreshFailure: refreshFailure,
    errors: {},
    loading: false,
  });

  assert.equal(view.canRenderActiveTab, true);
  assert.equal(view.showAuditStaleWarning, true);
  assert.deepEqual(view.activeLoadFailures, []);
});

test("late audit requests cannot claim ownership after a newer refresh", () => {
  const tracker = createLatestAdminAuditRequestTracker();
  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(tracker.isLatest(second), true);
  assert.equal(tracker.isLatest(first), false);
  tracker.invalidate();
  assert.equal(tracker.isLatest(second), false);
});

test("admin page renders settled sections instead of using fail-fast loading", () => {
  assert.match(adminConsoleInitialLoad, /settleAdminConsoleRequests\(/);
  assert.doesNotMatch(adminConsoleInitialLoad, /Promise\.all\(/);
  assert.doesNotMatch(adminConsolePage, /Promise\.all\(/);
  assert.match(adminConsolePage, /loading \|\| loadErrors\.users \? "—"/);
  assert.match(adminConsolePage, /deriveAdminConsoleViewState/);
});

test("frontend audit target contract accepts backend query and compatibility types", () => {
  assert.match(auditTypes, /"query_run"/);
  assert.match(auditTypes, /"unknown"/);
});
