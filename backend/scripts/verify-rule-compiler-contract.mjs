import { compileRuleContract } from "../src/ruleCompiler.mjs";

const schemaColumns = [
  { included: true, sourceName: "review", targetName: "review", type: "string" },
  { included: true, sourceName: "rating", targetName: "rating", type: "float" },
];

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

console.log("verify-rule-compiler-contract-node: ok");

function compile(overrides) {
  return compileRuleContract({
    executionMode: "snapshot",
    qualityRules: [],
    schemaColumns,
    sourceType: "File / S3",
    transformOutputColumns: [],
    transformSteps: [],
    ...overrides,
  });
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
