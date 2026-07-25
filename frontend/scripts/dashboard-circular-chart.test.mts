import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";
import {
  defaultWidgetColorConfig,
  resolveWidgetColors,
  widgetColorFromConfig,
} from "../src/pages/dashboard/runtime/widgetDefinitions.ts";

const frontendRoot = path.resolve(import.meta.dirname, "..");
const rendererPath = path.join(frontendRoot, "src/pages/dashboard/runtime/WidgetRenderer.tsx");
const stylesPath = path.join(frontendRoot, "src/styles/dashboard-runtime-widgets.css");
const rendererSource = readFileSync(rendererPath, "utf8");
const stylesSource = readFileSync(stylesPath, "utf8");

type ChartPoint = {
  label: string;
  sortValue: number | string;
  value: number;
};

function loadCircularChartFunctions() {
  const sourceFile = ts.createSourceFile(rendererPath, rendererSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const functionNames = new Set(["circularChartTotal", "compactCircularChartPoints"]);
  const functionSources = sourceFile.statements
    .filter((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement)
      && Boolean(statement.name)
      && functionNames.has(statement.name!.text)
    ))
    .map((statement) => statement.getText(sourceFile));

  assert.equal(functionSources.length, functionNames.size, "circular chart helpers must remain directly testable");

  const testModule = `
    type ChartPoint = { label: string; sortValue: number | string; value: number };
    const CIRCULAR_CHART_OTHER_LABEL = "기타";
    ${functionSources.join("\n")}
    globalThis.__circularChartFunctions = { circularChartTotal, compactCircularChartPoints };
  `;
  const compiled = ts.transpileModule(testModule, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = {};
  vm.runInNewContext(compiled, context);

  return context.__circularChartFunctions as {
    circularChartTotal: (points: ChartPoint[]) => number;
    compactCircularChartPoints: (points: ChartPoint[], visibleSliceLimit: number) => ChartPoint[];
  };
}

const { circularChartTotal, compactCircularChartPoints } = loadCircularChartFunctions();
const rgb = ["#f0140a", "#058b4f", "#3b82f6"];

function point(label: string, value: number): ChartPoint {
  return { label, sortValue: label, value };
}

test("eight equal categories preserve the 10,000 total and aggregate the remainder as 기타", () => {
  const allPoints = Array.from({ length: 8 }, (_, index) => point(`category-${index + 1}`, 1_250));
  const visiblePoints = compactCircularChartPoints(allPoints, 6);

  assert.equal(circularChartTotal(allPoints), 10_000);
  assert.equal(circularChartTotal(visiblePoints), 10_000);
  assert.equal(visiblePoints.length, 7);
  assert.deepEqual(
    { ...visiblePoints.at(-1) },
    { label: "기타", sortValue: "기타", value: 2_500 },
  );
});

test("the highest values remain visible and lower values are combined without changing the total", () => {
  const allPoints = [10, 90, 20, 80, 30, 70, 40, 60].map((value, index) => point(`category-${index + 1}`, value));
  const visiblePoints = compactCircularChartPoints(allPoints, 3);

  assert.deepEqual(Array.from(visiblePoints.slice(0, 3), ({ value }) => value), [90, 80, 70]);
  assert.equal(visiblePoints.at(-1)?.label, "기타");
  assert.equal(visiblePoints.at(-1)?.value, 160);
  assert.equal(circularChartTotal(visiblePoints), circularChartTotal(allPoints));
});

test("an existing visible 기타 slice absorbs the hidden total instead of creating a duplicate label", () => {
  const visiblePoints = compactCircularChartPoints([
    point("기타", 100),
    point("A", 90),
    point("B", 80),
    point("C", 70),
  ], 2);

  assert.equal(visiblePoints.filter(({ label }) => label === "기타").length, 1);
  assert.equal(visiblePoints.find(({ label }) => label === "기타")?.value, 250);
  assert.equal(circularChartTotal(visiblePoints), 340);
});

test("non-positive slices never corrupt the displayed circular-chart total", () => {
  const visiblePoints = compactCircularChartPoints([
    point("positive", 10),
    point("zero", 0),
    point("negative", -50),
  ], 6);

  assert.deepEqual(Array.from(visiblePoints, ({ label, value }) => ({ label, value })), [
    { label: "positive", value: 10 },
  ]);
  assert.equal(circularChartTotal(visiblePoints), 10);
});

test("the renderer uses all points for the total and exposes a semantic scrollable legend", () => {
  assert.match(rendererSource, /const total = circularChartTotal\(allPoints\)/);
  assert.match(rendererSource, /compactCircularChartPoints\(allPoints, CIRCULAR_CHART_VISIBLE_SLICE_LIMIT\)/);
  assert.match(rendererSource, /<ul className="asklake-circular-chart-legend" aria-label="차트 범례" tabIndex=\{0\}>/);
  assert.match(rendererSource, /show: false/);
  assert.match(stylesSource, /\.asklake-circular-chart-legend\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(stylesSource, /\.asklake-circular-chart-legend-label\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
});

test("legacy default palettes resolve to the R/G/B default without changing custom colors", () => {
  assert.deepEqual(resolveWidgetColors(["#2563eb", "#f0140a", "#ff5722"], 3), rgb);
  assert.deepEqual(resolveWidgetColors(["#f0140a", "#f0140a", "#ff5722"], 3), rgb);
  assert.deepEqual(
    resolveWidgetColors(["#f0140a", "#3b82f6", "#ff5722"], 3),
    ["#f0140a", "#3b82f6", "#ff5722"],
  );
  assert.deepEqual(defaultWidgetColorConfig.colors, rgb);
});

test("runtime widgets prefer the persisted source color over a stale preview palette", () => {
  assert.deepEqual(
    widgetColorFromConfig({
      color: { colors: ["#2563eb", "#f0140a", "#ff5722"] },
      sourceConfig: { color: { colors: rgb } },
    }),
    { colors: rgb },
  );
});
