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

test("ETL wizard exposes its steps from a compact breadcrumb menu without a duplicate source heading", () => {
  const app = read("src/App.tsx");
  const header = read("src/components/layout/EtlWizardHeader.tsx");
  const headerActionsPortal = read("src/components/layout/EtlWizardHeaderActionsPortal.tsx");
  const creationFlow = read("src/components/creation/CreationFlow.tsx");
  const schemaPage = read("src/pages/etl/SchemaInferencePage.tsx");
  const schemaTransformWorkbench = read("src/pages/etl/SchemaTransformWorkbench.tsx");
  const schemaTransformEditor = read("src/components/etl/SchemaTransformEditor.jsx");
  const sourcePage = read("src/pages/etl/SourceConnectionPage.tsx");
  const styles = read("src/styles/base.css");

  assert.match(app, /<EtlWizardHeader/);
  assert.match(app, /className="app-notification-stack"/);
  assert.match(app, /className=\{`app-toast \$\{toast\.tone\}`\} role="status"/);
  assert.match(header, /aria-label="탐색 경로"/);
  assert.match(header, />\s*수집\/처리\s*</);
  assert.match(header, /새 수집\/처리 생성/);
  assert.match(header, /<DropdownMenuTrigger asChild>/);
  assert.match(header, /isStepDisabled\(index\)/);
  assert.match(header, /onStepSelect\(index\)/);
  assert.doesNotMatch(header, /<Stepper/);
  assert.match(header, /id=\{ETL_WIZARD_HEADER_ACTIONS_ID\}/);
  assert.match(headerActionsPortal, /createPortal\(children, target\)/);
  assert.match(creationFlow, /<EtlWizardHeaderActionsPortal>\{actions\}<\/EtlWizardHeaderActionsPortal>/);
  assert.match(schemaPage, /<EtlWizardHeaderActionsPortal>/);
  assert.match(schemaPage, /headerActions=\{\(/);
  assert.match(schemaPage, /변환 결과 미리보기/);
  assert.match(schemaTransformWorkbench, /headerActions=\{headerActions\}/);
  assert.match(schemaTransformEditor, /actions=\{headerActions\}/);
  assert.doesNotMatch(schemaPage, /schema-bottom-bar schema-top-actions/);
  assert.doesNotMatch(sourcePage, /title="소스 연결"/);
  assert.match(styles, /\.etl-wizard-header\s*\{[\s\S]*?min-height: 52px;/);
  assert.match(styles, /\.etl-wizard-header-actions \.creation-top-actions/);
  assert.match(styles, /\.app-notification-stack\s*\{[\s\S]*?bottom: 24px;/);
  assert.doesNotMatch(styles, /\.app-toast\s*\{[^}]*\btop:/);
  assert.doesNotMatch(styles, /\.stepper\.compact/);
  assert.match(styles, /\.page-body\[data-etl-route\]:not\(\.schema-body\)/);
});
