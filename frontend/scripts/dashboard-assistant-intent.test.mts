import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboardAssistantRequestPrompt,
  classifyDashboardAssistantMode,
  isContextualVisualizationFollowUp,
  isWidgetMutationPrompt,
  resolveDashboardAssistantMutationTarget,
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

test("a bounded field-selection follow-up becomes a contextual visualization request", () => {
  const previousUserPrompts = ["아무거나", "field_1 event_id"];
  assert.equal(isContextualVisualizationFollowUp("랜덤으로 진행해줘", previousUserPrompts), true);
  assert.equal(
    classifyDashboardAssistantMode("랜덤으로 진행해줘", { previousUserPrompts }),
    "visualization_request",
  );
  assert.equal(
    buildDashboardAssistantRequestPrompt("랜덤으로 진행해줘", previousUserPrompts),
    "이전 사용자 요청:\n- 아무거나\n- field_1 event_id\n\n현재 사용자 요청:\n랜덤으로 진행해줘",
  );
});

test("a standalone vague follow-up stays non-mutating and does not invent context", () => {
  assert.equal(isContextualVisualizationFollowUp("랜덤으로 진행해줘"), false);
  assert.equal(classifyDashboardAssistantMode("랜덤으로 진행해줘"), "dashboard_question");
  assert.equal(buildDashboardAssistantRequestPrompt("랜덤으로 진행해줘"), "랜덤으로 진행해줘");
});

test("explanation follow-ups do not inherit a prior field as a mutation", () => {
  assert.equal(
    classifyDashboardAssistantMode("그 필드가 왜 중요한지 설명해줘", {
      previousUserPrompts: ["field_1 event_id"],
    }),
    "dashboard_question",
  );
});

test("an explicit create request does not overwrite a merely selected widget", () => {
  assert.equal(
    resolveDashboardAssistantMutationTarget("새 막대 차트를 추가해줘", "widget-1"),
    null,
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("지역별 매출 차트를 만들어줘", "widget-1"),
    null,
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("같은 차트를 하나 더 만들어줘", "widget-1"),
    null,
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("선택한 차트 색상을 빨간색으로 바꿔줘", "widget-1"),
    "widget-1",
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("차트를 빨간색으로 만들어줘", "widget-1"),
    "widget-1",
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("막대차트로 만들어줘", "widget-1"),
    "widget-1",
  );
  assert.equal(
    resolveDashboardAssistantMutationTarget("make the chart red", "widget-1"),
    "widget-1",
  );
});
