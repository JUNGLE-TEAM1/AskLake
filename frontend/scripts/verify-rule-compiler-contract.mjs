import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const fixture = JSON.parse(readFileSync(
  new URL("../../backend/fixtures/rules/rule-compiler-conformance.json", import.meta.url),
  "utf8",
));
const bundle = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("../src/services/ruleContract.ts", import.meta.url))],
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
if (!source) throw new Error("Frontend Rule compiler bundle was empty.");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  canonicalRulesFromLegacy,
  compileRuleContract,
  legacyRulesFromCanonical,
} = await import(moduleUrl);

for (const testCase of fixture.cases) {
  const compilation = compileRuleContract({
    contractVersion: testCase.request.ruleContractVersion,
    executionMode: "snapshot",
    qualityRules: [],
    schemaColumns: fixture.schemaColumns,
    sourceType: "File / S3",
    transformOutputColumns: [],
    transformSteps: [],
    ...testCase.request,
  });
  const actualCodes = [...new Set(compilation.issues.map((item) => item.code))].sort();
  assert(compilation.status === testCase.expectedStatus, `${testCase.name}: status mismatch.`);
  assert(JSON.stringify(actualCodes) === JSON.stringify([...testCase.expectedIssueCodes].sort()), `${testCase.name}: issue mismatch ${JSON.stringify(actualCodes)}.`);
  if (testCase.expectedOutputSchema) {
    assert(JSON.stringify(compilation.outputSchema) === JSON.stringify(testCase.expectedOutputSchema), `${testCase.name}: output schema mismatch.`);
  }
}

for (const value of [0, false, "", null]) {
  const canonicalRule = {
    contractVersion: "1.0",
    enabled: true,
    failureDisposition: "keep",
    id: `default-${String(value)}`,
    inputColumns: ["rating"],
    kind: "transform",
    onError: "warn",
    operation: "default_value",
    outputColumns: ["rating_default"],
    outputType: "Double",
    parameters: { value },
  };
  const legacy = legacyRulesFromCanonical([canonicalRule]);
  const roundTrip = canonicalRulesFromLegacy(
    legacy.transformSteps,
    legacy.qualityRules,
    fixture.schemaColumns,
    [["rating_default", "Double"]],
  );
  assert(
    JSON.stringify(roundTrip[0]?.parameters) === JSON.stringify({ value }),
    `Default value ${String(value)} should round-trip through the frontend adapter.`,
  );
}

console.log("verify-rule-compiler-contract-frontend: ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
