import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

test("the typography contract is the final global style import", () => {
  const entrypoint = read("src/styles.css");
  const imports = [...entrypoint.matchAll(/@import\s+(?:url\([^)]*\)|["']([^"']+)["']);/g)]
    .map((match) => match[1])
    .filter(Boolean);

  assert.equal(imports.at(-1), "./styles/typography.css");
});

test("the shared weight scale stops at 700 and documents each semantic tier", () => {
  const typography = read("src/styles/typography.css");

  for (const [token, weight] of [
    ["regular", 400],
    ["medium", 500],
    ["semibold", 600],
    ["bold", 700],
  ] as const) {
    assert.match(typography, new RegExp(`--asklake-font-weight-${token}: ${weight};`));
  }

  assert.doesNotMatch(typography, /font-weight:\s*(?:8|9)\d{2}/);
  assert.match(typography, /#root :where\(span, em\)/);
  assert.match(typography, /\[data-slot="metric-value"\]/);
  assert.match(typography, /\[data-slot="button"\]\[data-variant="primary"\]/);
  assert.match(typography, /\[data-slot="tabs-trigger"\]\[data-state="active"\]/);
});

test("shared primitives keep emphasis on meaning instead of every control", () => {
  const button = read("src/components/ui/button.tsx");
  const badge = read("src/components/ui/badge.tsx");
  const field = read("src/components/ui/field.tsx");
  const metric = read("src/components/ui/metric-card.tsx");
  const panel = read("src/components/ui/panel.tsx");
  const pageHeader = read("src/components/ui/page-header.tsx");
  const table = read("src/components/ui/table.tsx");
  const statusBadge = read("src/components/ui/status-badge.tsx");

  assert.match(badge, /border font-medium/);
  assert.match(button, /text-base font-medium/);
  assert.match(button, /primary: "bg-blue-600 font-semibold/);
  assert.match(button, /data-slot="button"/);
  assert.doesNotMatch(field, /font-semibold/);
  assert.match(table, /text-xs font-medium text-slate-500/);
  assert.match(panel, /data-slot="panel-title"/);
  assert.match(panel, /font-normal leading-snug/);
  assert.doesNotMatch(panel, /font-\[850\]/);
  assert.match(metric, /font-bold leading-none/);
  assert.match(metric, /data-slot="metric-value"/);
  assert.match(metric, /font-normal leading-snug/);
  assert.match(pageHeader, /font-bold leading-tight/);
  assert.match(pageHeader, /data-slot="page-title"/);
  assert.match(statusBadge, /data-status="true"/);
});
