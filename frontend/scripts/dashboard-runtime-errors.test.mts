import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dashboardRuntimeErrorMessage } from "../src/pages/dashboard/runtime/dashboardRuntimeErrors.ts";
import { ApiError } from "../src/types/audit.ts";

const dashboardPage = readFileSync(new URL("../src/pages/dashboard/DashboardPage.tsx", import.meta.url), "utf8");
const mutationSources = [
  "useDraftPageMutations.ts",
  "useDraftWidgetCreator.ts",
  "useDraftWidgetLayouts.ts",
  "useDraftWidgetMutations.ts",
].map((fileName) => readFileSync(
  new URL(`../src/pages/dashboard/runtime/${fileName}`, import.meta.url),
  "utf8",
));

test("API 오류 안내에는 운영자가 추적할 수 있는 안전한 진단 정보가 붙는다", () => {
  const error = new ApiError({
    code: "DASHBOARD_DATA_UNAVAILABLE",
    diagnosticId: "diag-dashboard-42",
    message: "위젯 데이터를 불러오지 못했습니다.",
    stage: "physical_query",
    status: 503,
  });

  assert.equal(
    dashboardRuntimeErrorMessage(error, "fallback"),
    "위젯 데이터를 불러오지 못했습니다. (DASHBOARD_DATA_UNAVAILABLE · physical_query · diag-dashboard-42)",
  );
  assert.equal(dashboardRuntimeErrorMessage(new Error("일반 오류"), "fallback"), "일반 오류");
  assert.equal(dashboardRuntimeErrorMessage(null, "fallback"), "fallback");
});

test("페이지와 위젯 변경 실패는 전체 Dashboard 로드 오류를 덮어쓰지 않는다", () => {
  assert.match(dashboardPage, /useDraftPageMutations\(/);
  assert.match(dashboardPage, /useDraftWidgetMutations\(/);
  assert.doesNotMatch(dashboardPage, /const addRuntimePage\s*=/);
  assert.doesNotMatch(dashboardPage, /const updateRuntimeWidget\s*=/);
  for (const source of mutationSources) assert.doesNotMatch(source, /setDraftError/);
});
