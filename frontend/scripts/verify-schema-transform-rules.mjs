import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  applyQuickTransformExpression,
  detectQuickTransformFunctions,
  toggleQuickTransformExpression,
} from "../src/components/etl/quickTransformExpression.js";

const upperExpression = applyQuickTransformExpression({
  expression: "amount",
  name: "UPPER",
  outputType: "double",
  sourceExpression: "amount",
});
assert.equal(upperExpression, "UPPER(CAST(amount AS STRING))");
assert.deepEqual(
  detectQuickTransformFunctions(upperExpression),
  ["UPPER"],
  "The CAST used internally by UPPER must not appear as a user-selected quick transform.",
);
const combinedExpression = applyQuickTransformExpression({
  expression: upperExpression,
  name: "CAST",
  outputType: "double",
  sourceExpression: "amount",
});
assert.equal(
  combinedExpression,
  "CAST(UPPER(CAST(amount AS STRING)) AS DOUBLE)",
  "Quick transforms must wrap the current expression instead of concatenating SQL fragments.",
);
assert.deepEqual(detectQuickTransformFunctions(combinedExpression), ["UPPER", "CAST"]);
assert.equal(
  toggleQuickTransformExpression({
    expression: combinedExpression,
    name: "UPPER",
    outputType: "double",
    sourceExpression: "amount",
  }),
  "CAST(amount AS DOUBLE)",
  "Clicking a selected nested transform must remove only that transform.",
);
assert.equal(
  toggleQuickTransformExpression({
    expression: upperExpression,
    name: "UPPER",
    outputType: "double",
    sourceExpression: "amount",
  }),
  "amount",
  "Clicking the only selected transform must restore the source expression.",
);
const roundedExpression = applyQuickTransformExpression({
  expression: "amount",
  name: "ROUND",
  outputType: "double",
  sourceExpression: "amount",
});
assert.deepEqual(detectQuickTransformFunctions(roundedExpression), ["ROUND"]);
const substringExpression = toggleQuickTransformExpression({
  expression: "amount",
  name: "SUBSTR",
  outputType: "double",
  sourceExpression: "amount",
});
assert.equal(
  toggleQuickTransformExpression({
    expression: substringExpression,
    name: "SUBSTR",
    outputType: "double",
    sourceExpression: "amount",
  }),
  "amount",
  "A quick transform must not be duplicated when its selected button is clicked again.",
);

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
assert.equal(
  fieldRules[3].onError,
  "Fail Run",
  "An explicit required field must stop execution after default-value handling still leaves it empty.",
);

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
assert.equal(explicitQuality.failurePolicyCount, 1);
assert.equal(explicitQuality.failureTargetCount, 1);
assert.deepEqual(explicitQuality.failurePolicyApplications, [{
  action: "Quarantine",
  category: "quality",
  label: "Not Null",
  target: "review",
}]);

const sharedFailurePolicy = summarizeSchemaRuleState([], [{
  enabled: true,
  failureAction: "Warn",
  id: "review-not-null",
  kind: "notNull",
  params: "",
  severity: "Error",
  targetColumn: "review",
  validationType: "Not Null",
}, {
  enabled: true,
  failureAction: "Warn",
  id: "rating-range",
  kind: "range",
  params: "1,5",
  severity: "Error",
  targetColumn: "rating",
  validationType: "Range Check",
}], []);
assert.equal(sharedFailurePolicy.failureApplicationCount, 2);
assert.equal(sharedFailurePolicy.failurePolicyCount, 1, "The same action must count as one policy type.");
assert.equal(sharedFailurePolicy.failureTargetCount, 2, "Applied targets must be reported separately.");

console.log("verify-schema-transform-rules: ok");
