import assert from "node:assert/strict";
import test from "node:test";

import { canNavigateToWizardStep } from "../src/utils/wizardNavigation.ts";

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
