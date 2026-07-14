import { readFileSync } from "node:fs";
import { listSourceAssets } from "../src/connectors.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const sourceType = payload.sourceType;
const sourceConfig = Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [];
const prefix = typeof payload.prefix === "string" ? payload.prefix : "";

try {
  const result = await listSourceAssets(sourceType, sourceConfig, prefix);
  console.log(`ASKLAKE_SOURCE_ASSETS_RESULT=${JSON.stringify(result)}`);
  process.exit(0);
} catch (error) {
  console.log(`ASKLAKE_SOURCE_ASSETS_ERROR=${JSON.stringify({
    code: error?.code || "SOURCE_ASSETS_FAILED",
    message: error?.message || "Source asset listing failed.",
    status: error?.status || 502,
  })}`);
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
