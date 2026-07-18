import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDashboardAssistantMode,
  isWidgetMutationPrompt,
} from "../src/pages/dashboard/runtime/dashboardAssistantIntent.ts";

test("common analytical show requests create a visualization in the dashboard editor", () => {
  assert.equal(classifyDashboardAssistantMode("지역별 매출 보여줘"), "visualization_request");
  assert.equal(classifyDashboardAssistantMode("월별 매출 추이 보여줘"), "visualization_request");
  assert.equal(classifyDashboardAssistantMode("show revenue by region"), "visualization_request");
  assert.equal(isWidgetMutationPrompt("막대그래프 만들어줘"), true);
  assert.equal(isWidgetMutationPrompt("지역별 매출 차트 해줘"), true);
});

test("selected-widget edit requests do not fall back to dashboard chat", () => {
  assert.equal(
    classifyDashboardAssistantMode("색상을 빨간색으로 바꿔줘", { hasSelectedWidget: true }),
    "visualization_request",
  );
  assert.equal(
    classifyDashboardAssistantMode("제목을 지역 매출로 변경해줘", { hasSelectedWidget: true }),
    "visualization_request",
  );
});

test("explanations and summaries remain non-mutating dashboard questions", () => {
  assert.equal(classifyDashboardAssistantMode("왜 매출이 줄었는지 설명해줘"), "dashboard_question");
  assert.equal(classifyDashboardAssistantMode("현재 대시보드 상태를 요약해줘"), "dashboard_question");
  assert.equal(classifyDashboardAssistantMode("what caused the revenue decline?"), "dashboard_question");
});

test("an ambiguous edit without a selected widget stays non-mutating", () => {
  assert.equal(classifyDashboardAssistantMode("색상을 빨간색으로 바꿔줘"), "dashboard_question");
});
