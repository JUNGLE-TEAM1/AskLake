import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canNavigateToWizardStep } from "../src/utils/wizardNavigation.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const stepFlows = ["source", "schema", "repeat", "permission", "target", "review"] as const;

test("a new wizard locks every future step", () => {
  const completedFlows = new Set<(typeof stepFlows)[number]>();

  assert.equal(canNavigateToWizardStep({ activeIndex: 0, completedFlows, stepFlows, targetIndex: 0 }), true);
  assert.equal(canNavigateToWizardStep({ activeIndex: 0, completedFlows, stepFlows, targetIndex: 1 }), false);
  assert.equal(canNavigateToWizardStep({ activeIndex: 0, completedFlows, stepFlows, targetIndex: 5 }), false);
});

test("the next step unlocks only after the current step completes", () => {
  const completedFlows = new Set<(typeof stepFlows)[number]>(["source"]);

  assert.equal(canNavigateToWizardStep({ activeIndex: 0, completedFlows, stepFlows, targetIndex: 1 }), true);
  assert.equal(canNavigateToWizardStep({ activeIndex: 0, completedFlows, stepFlows, targetIndex: 2 }), false);

  completedFlows.add("schema");
  assert.equal(canNavigateToWizardStep({ activeIndex: 1, completedFlows, stepFlows, targetIndex: 2 }), true);
});

test("backward navigation is always allowed", () => {
  const completedFlows = new Set<(typeof stepFlows)[number]>();

  assert.equal(canNavigateToWizardStep({ activeIndex: 4, completedFlows, stepFlows, targetIndex: 0 }), true);
  assert.equal(canNavigateToWizardStep({ activeIndex: 4, completedFlows, stepFlows, targetIndex: 3 }), true);
});

test("previously completed steps remain reachable after moving backward", () => {
  const completedFlows = new Set<(typeof stepFlows)[number]>([
    "source",
    "schema",
    "repeat",
    "permission",
  ]);

  assert.equal(canNavigateToWizardStep({ activeIndex: 1, completedFlows, stepFlows, targetIndex: 4 }), true);
  assert.equal(canNavigateToWizardStep({ activeIndex: 1, completedFlows, stepFlows, targetIndex: 5 }), false);
});

test("ETL wizard uses a compact breadcrumb header without a duplicate source heading", () => {
  const app = read("src/App.tsx");
  const header = read("src/components/layout/EtlWizardHeader.tsx");
  const sourcePage = read("src/pages/etl/SourceConnectionPage.tsx");
  const styles = read("src/styles/base.css");

  assert.match(app, /<EtlWizardHeader/);
  assert.match(header, /aria-label="탐색 경로"/);
  assert.match(header, />\s*수집\/처리\s*</);
  assert.match(header, /새 데이터 소스 생성/);
  assert.match(header, /density="compact"/);
  assert.doesNotMatch(sourcePage, /title="소스 연결"/);
  assert.match(styles, /\.stepper\.compact \.stepper-inner\s*\{[\s\S]*?height: 59px;/);
  assert.match(styles, /\.page-body\[data-etl-route\]:not\(\.schema-body\)/);
});
