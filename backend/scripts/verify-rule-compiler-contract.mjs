import { readFileSync } from "node:fs";
import { compileRuleContract } from "../src/ruleCompiler.mjs";

const schemaColumns = [
  { included: true, sourceName: "review", targetName: "review", type: "string" },
  { included: true, sourceName: "rating", targetName: "rating", type: "float" },
];

verifySharedConformance();

const passThrough = compile({});
assert(passThrough.result.status === "pass", "No-rule contract should pass.");
assert(passThrough.result.rules.length === 0, "No-rule contract should stay empty.");
assertSchema(passThrough.result.outputSchema, [["review", "String"], ["rating", "Double"]]);

const legacy = compile({
  transformSteps: [{
    enabled: true,
    id: "trim-review",
    input: "review",
    kind: "trim",
    label: "trim review",
    onError: "Drop Row",
    operation: "Lowercase + Trim",
    output: "review_clean",
    params: "lower(), trim()",
  }],
  qualityRules: [{
    enabled: true,
    failureAction: "Fail Run",
    id: "review-required",
    kind: "notNull",
    severity: "Error",
    targetColumn: "review_clean",
    validationType: "Not Null",
  }],
});
assert(legacy.result.status === "pass", "Legacy rules should compile.");
assert(legacy.result.rules[0].failureDisposition === "drop_row", "Drop Row must survive canonical adaptation.");
assert(legacy.result.rules[1].onError === "fail_batch", "Fail Run must map to fail_batch.");
assert(legacy.transformSteps[0].onError === "Drop Row", "Canonical conversion must preserve Drop Row.");
assertSchema(legacy.result.outputSchema, [["review", "String"], ["rating", "Double"], ["review_clean", "String"]]);

const canonical = compile({
  rules: [{
    contractVersion: "1.0",
    enabled: true,
    failureDisposition: "keep",
    id: "rating-cast",
    inputColumns: ["rating"],
    kind: "transform",
    onError: "quarantine",
    operation: "cast",
    outputColumns: ["rating_long"],
    outputType: "Long",
    parameters: { targetType: "Long" },
  }],
});
assert(canonical.result.status === "pass", "Canonical cast should compile.");
assert(canonical.transformSteps[0].onError === "Quarantine", "Canonical error policy should compile to legacy execution input.");
assert(canonical.result.outputSchema.at(-1)?.[1] === "Long", "Canonical output type should be retained.");

const missingInput = compile({
  rules: [canonicalRule({ id: "missing", inputColumns: ["missing"], outputColumns: ["copy"] })],
});
assertIssue(missingInput, "RULE_INPUT_NOT_FOUND");

const unsupported = compile({
  rules: [canonicalRule({ id: "unknown", operation: "magic", outputColumns: ["magic"] })],
});
assertIssue(unsupported, "RULE_OPERATION_UNSUPPORTED");

const uniqueRule = compile({
  rules: [{
    ...canonicalRule({ id: "unique-review" }),
    kind: "quality",
    operation: "unique",
    outputColumns: [],
  }],
});
assertIssue(uniqueRule, "RULE_OPERATION_UNSUPPORTED");

const continuous = compile({
  executionMode: "continuous",
  sourceType: "Stream / Kafka",
  rules: [canonicalRule({ id: "continuous-rule", outputColumns: ["review_copy"] })],
});
assertIssue(continuous, "RULE_EXECUTION_MODE_UNSUPPORTED");

const kafkaSql = compile({
  sourceType: "Stream / Kafka",
  rules: [canonicalRule({
    id: "kafka-sql",
    operation: "sql_expression",
    outputColumns: ["review_sql"],
    parameters: { expression: "upper(review)" },
  })],
});
assertIssue(kafkaSql, "RULE_EXECUTION_MODE_UNSUPPORTED");

for (const value of [0, false, "", null]) {
  const first = compile({
    rules: [canonicalRule({
      id: `default-${String(value)}`,
      inputColumns: ["rating"],
      operation: "default_value",
      outputColumns: ["rating"],
      outputType: "Double",
      parameters: { value },
    })],
  });
  const roundTrip = compileRuleContract({
    executionMode: "snapshot",
    qualityRules: first.qualityRules,
    schemaColumns,
    sourceType: "File / S3",
    transformOutputColumns: first.result.outputSchema,
    transformSteps: first.transformSteps,
  });
  assert(JSON.stringify(roundTrip.result.rules[0].parameters) === JSON.stringify({ value }), `Default value ${String(value)} should round-trip.`);
}

assertIssue(compile({
  rules: [canonicalRule({ failureDisposition: "drop_row", id: "policy-conflict", onError: "quarantine" })],
}), "RULE_FAILURE_POLICY_CONFLICT");
assertIssue(compile({
  ruleContractVersion: "2.0",
  rules: [canonicalRule({ id: "future-version" })],
}), "RULE_CONTRACT_VERSION_UNSUPPORTED");
assertIssue(compileRuleContract({
  executionMode: "snapshot",
  qualityRules: [],
  rules: [canonicalRule({ id: "missing-version" })],
  schemaColumns,
  sourceType: "File / S3",
  transformSteps: [],
}), "RULE_CONTRACT_VERSION_REQUIRED");
assertIssue(compile({
  rules: [canonicalRule({ id: "unsupported-parameter", parameters: { extra: true } })],
}), "RULE_PARAMETER_UNSUPPORTED");

const explicitEmpty = compile({
  rules: [],
  transformSteps: legacy.transformSteps,
});
assert(explicitEmpty.result.rules.length === 0, "Explicit canonical empty rules must not revive legacy rules.");

console.log("verify-rule-compiler-contract-node: ok");

function compile(overrides) {
  const request = {
    executionMode: "snapshot",
    qualityRules: [],
    schemaColumns,
    sourceType: "File / S3",
    transformOutputColumns: [],
    transformSteps: [],
    ...overrides,
  };
  if (Object.hasOwn(overrides, "rules") && !Object.hasOwn(overrides, "ruleContractVersion")) {
    request.ruleContractVersion = "1.0";
  }
  return compileRuleContract(request);
}

function canonicalRule(overrides = {}) {
  return {
    contractVersion: "1.0",
    enabled: true,
    failureDisposition: "keep",
    id: "copy-review",
    inputColumns: ["review"],
    kind: "transform",
    onError: "warn",
    operation: "copy",
    outputColumns: ["review_copy"],
    parameters: {},
    ...overrides,
  };
}

function assertIssue(compilation, code) {
  assert(compilation.result.status === "fail", `${code} should fail compilation.`);
  assert(compilation.result.issues.some((item) => item.code === code), `${code} should be reported.`);
}

function assertSchema(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected schema ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifySharedConformance() {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/rules/rule-compiler-conformance.json", import.meta.url), "utf8"));
  for (const testCase of fixture.cases) {
    const compilation = compileRuleContract({
      executionMode: "snapshot",
      qualityRules: [],
      schemaColumns: fixture.schemaColumns,
      sourceType: "File / S3",
      transformOutputColumns: [],
      transformSteps: [],
      ...testCase.request,
    });
    const actualCodes = [...new Set(compilation.result.issues.map((item) => item.code))].sort();
    assert(compilation.result.status === testCase.expectedStatus, `${testCase.name}: status mismatch.`);
    assert(JSON.stringify(actualCodes) === JSON.stringify([...testCase.expectedIssueCodes].sort()), `${testCase.name}: issue mismatch ${JSON.stringify(actualCodes)}.`);
    if (testCase.expectedOutputSchema) assertSchema(compilation.result.outputSchema, testCase.expectedOutputSchema);
  }
}
