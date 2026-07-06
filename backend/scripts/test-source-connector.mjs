import { readFileSync } from "node:fs";
import { testSourceConnector } from "../src/connectors.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const sourceType = payload.sourceType;
const sourceConfig = Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [];

try {
  const result = await testSourceConnector(sourceType, sourceConfig);
  console.log(`ASKLAKE_SOURCE_CONNECTOR_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_SOURCE_CONNECTOR_ERROR=${JSON.stringify({
    code: error?.code || "SOURCE_CONNECTOR_FAILED",
    message: error?.message || "Source connector failed.",
    status: error?.status || 502,
  })}`);
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
