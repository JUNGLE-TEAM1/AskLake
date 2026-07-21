import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("../src/pages/etl/schemaResultPreviewModel.ts", import.meta.url))],
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert(source, "Schema result preview model bundle was empty.");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { buildSchemaResultPreviewModel } = await import(moduleUrl);

const columns = [{
  included: true,
  nullable: false,
  sourceName: "raw_amount",
  targetName: "amount",
  targetOrder: 1,
  type: "double",
}, {
  included: true,
  nullable: true,
  sourceName: "status",
  targetName: "status_clean",
  targetOrder: 0,
  type: "string",
}];

const transformSteps = [{
  enabled: true,
  id: "rename-amount",
  input: "raw_amount",
  kind: "rename",
  label: "Rename",
  onError: "Warn",
  operation: "Rename",
  output: "amount",
  params: "",
}, {
  canonicalParameters: { targetType: "Double" },
  enabled: true,
  id: "cast-amount",
  input: "amount",
  kind: "cast",
  label: "Cast Double",
  onError: "Warn",
  operation: "Cast Double",
  output: "amount",
  params: "Double",
}, {
  enabled: true,
  id: "rename-status",
  input: "status",
  kind: "rename",
  label: "Rename",
  onError: "Warn",
  operation: "Rename",
  output: "status_clean",
  params: "",
}, {
  canonicalParameters: { expression: "UPPER(TRIM(CAST(status_clean AS STRING)))" },
  enabled: true,
  id: "clean-status",
  input: "status_clean",
  kind: "derive",
  label: "SQL Expression",
  onError: "Warn",
  operation: "SQL Expression",
  output: "status_clean",
  params: "UPPER(TRIM(CAST(status_clean AS STRING)))",
}];

test("result preview applies transforms, output order, and transformed quality rules", () => {
  const sampleRows = [["12.50", " paid "]];
  const model = buildSchemaResultPreviewModel({
    columns,
    qualityRules: [{
      enabled: true,
      failureAction: "Warn",
      id: "accepted-status",
      kind: "acceptedValues",
      params: "PAID,PENDING",
      severity: "Error",
      targetColumn: "status_clean",
      validationType: "Accepted Values",
    }],
    sampleRows,
    transformSteps,
  });

  assert.deepEqual(model.outputColumns.map(({ column }: { column: { targetName: string } }) => column.targetName), [
    "status_clean",
    "amount",
  ]);
  assert.deepEqual(model.rows[0].values, ["PAID", "12.5"]);
  assert.equal(model.rows[0].result.label, "통과");
  assert.deepEqual(sampleRows, [["12.50", " paid "]], "Preview must not mutate the source sample.");
});

test("result preview refresh model reflects the latest quick transform expression", () => {
  const first = buildSchemaResultPreviewModel({
    columns,
    qualityRules: [],
    sampleRows: [["1", " Mixed Case "]],
    transformSteps,
  });
  const lowerSteps = transformSteps.map((step) => step.id === "clean-status"
    ? {
      ...step,
      canonicalParameters: { expression: "LOWER(TRIM(CAST(status_clean AS STRING)))" },
      params: "LOWER(TRIM(CAST(status_clean AS STRING)))",
    }
    : step);
  const refreshed = buildSchemaResultPreviewModel({
    columns,
    qualityRules: [],
    sampleRows: [["1", " Mixed Case "]],
    transformSteps: lowerSteps,
  });

  assert.equal(first.rows[0].values[0], "MIXED CASE");
  assert.equal(refreshed.rows[0].values[0], "mixed case");
});

test("result preview applies an AI-authored scalar SQL expression", () => {
  const customSteps = transformSteps.map((step) => step.id === "clean-status"
    ? {
      ...step,
      canonicalParameters: { expression: "CASE WHEN TRIM(status_clean) = 'paid' THEN CONCAT('PAID-', CAST(amount * 2 AS STRING)) ELSE 'OTHER' END" },
      params: "CASE WHEN TRIM(status_clean) = 'paid' THEN CONCAT('PAID-', CAST(amount * 2 AS STRING)) ELSE 'OTHER' END",
    }
    : step);
  const model = buildSchemaResultPreviewModel({
    columns,
    qualityRules: [],
    sampleRows: [["1", "paid"]],
    transformSteps: customSteps,
  });

  assert.equal(model.rows[0].values[0], "PAID-2");
});
