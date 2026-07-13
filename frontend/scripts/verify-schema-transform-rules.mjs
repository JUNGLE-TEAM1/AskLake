import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  bundle: true,
  define: {
    "import.meta.env": JSON.stringify({ DEV: false }),
  },
  entryPoints: [fileURLToPath(new URL("../src/pages/etl/SchemaTransformWorkbench.tsx", import.meta.url))],
  format: "esm",
  loader: { ".png": "dataurl" },
  platform: "node",
  plugins: [{
    name: "ignore-css",
    setup(context) {
      context.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    },
  }],
  target: "es2022",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert(source, "Schema Transform adapter bundle was empty.");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { buildTransformSteps, ensureRequiredFieldTransformSteps } = await import(moduleUrl);

const summaryBundle = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("../src/services/schemaRuleSummary.ts", import.meta.url))],
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
});
const summarySource = summaryBundle.outputFiles[0]?.text;
assert(summarySource, "Schema rule summary bundle was empty.");
const summaryModuleUrl = `data:text/javascript;base64,${Buffer.from(summarySource).toString("base64")}`;
const { summarizeSchemaRuleState } = await import(summaryModuleUrl);

const passThrough = buildTransformSteps([{
  name: "review",
  notNull: true,
  nullGuardExplicit: false,
  originalName: "review",
  originalType: "string",
  type: "string",
}]);
assert.deepEqual(passThrough, [], "Inferred non-null schema must not create an implicit Rule.");

const requiredAlias = ensureRequiredFieldTransformSteps([{
  name: "raw_reviewerid",
  originalName: "raw.reviewerID",
  originalType: "string",
  type: "string",
}], [{
  enabled: true,
  id: "existing-portable-rule",
  input: "review",
  kind: "trim",
  label: "Lowercase + Trim",
  onError: "Warn",
  operation: "Lowercase + Trim",
  output: "review",
  params: "",
}]);
assert.deepEqual(requiredAlias.map((step) => step.operation), ["Rename", "Lowercase + Trim"]);
assert.equal(requiredAlias[0].input, "raw.reviewerID");
assert.equal(requiredAlias[0].output, "raw_reviewerid");
assert.equal(requiredAlias[1].id, "existing-portable-rule");

const fieldRules = buildTransformSteps([{
  defaultValue: "0",
  name: "rating_value",
  notNull: true,
  nullGuardExplicit: true,
  originalName: "rating",
  originalType: "string",
  type: "double",
}]);
assert.deepEqual(fieldRules.map((step) => step.operation), [
  "Rename",
  "Cast Double",
  "Default Value",
  "Null Guard",
]);
assert.equal(fieldRules[0].input, "rating");
assert.equal(fieldRules[1].input, "rating_value");
assert.deepEqual(fieldRules[1].canonicalParameters, { targetType: "Double" });
assert.deepEqual(fieldRules[2].canonicalParameters, { value: "0" });
assert.deepEqual(fieldRules[3].canonicalParameters, {});

const portable = buildTransformSteps([{
  name: "review_clean",
  originalName: "review",
  originalType: "string",
  transformChain: [{ operation: "Lowercase + Trim", params: "", onError: "Quarantine" }],
  type: "string",
}]);
assert.deepEqual(portable.map((step) => step.operation), ["Rename", "Lowercase + Trim"]);
assert.equal(portable[1].input, "review_clean");
assert.equal(portable[1].onError, "Quarantine");

const schemaOnlyRequired = summarizeSchemaRuleState([{
  included: true,
  nullable: false,
  sourceName: "review",
  targetName: "review",
  type: "String",
}], [], []);
assert.equal(schemaOnlyRequired.requiredColumnCount, 1);
assert.equal(schemaOnlyRequired.qualityRuleCount, 0, "Required output schema must not count as a quality Rule.");

const explicitQuality = summarizeSchemaRuleState([{
  included: true,
  nullable: false,
  sourceName: "review",
  targetName: "review",
  type: "String",
}], [{
  enabled: true,
  failureAction: "Quarantine",
  id: "review-not-null",
  kind: "notNull",
  params: "",
  severity: "Error",
  targetColumn: "review",
  validationType: "Not Null",
}], []);
assert.equal(explicitQuality.requiredColumnCount, 1);
assert.equal(explicitQuality.qualityRuleCount, 1);
assert.deepEqual(explicitQuality.failureActions, ["Quarantine"]);

console.log("verify-schema-transform-rules: ok");
