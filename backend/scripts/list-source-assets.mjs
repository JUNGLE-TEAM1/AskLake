import { readFileSync } from "node:fs";
import { listSourceAssets } from "../src/connectors.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const sourceType = payload.sourceType;
const sourceConfig = Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [];
const prefix = typeof payload.prefix === "string" ? payload.prefix : "";

try {
  const result = await listSourceAssets(sourceType, sourceConfig, prefix);
  process.stdout.write(`ASKLAKE_SOURCE_ASSETS_RESULT=${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`ASKLAKE_SOURCE_ASSETS_ERROR=${JSON.stringify({
    code: error?.code || "SOURCE_ASSETS_FAILED",
    message: error?.message || "Source asset listing failed.",
    status: error?.status || 502,
  })}\n`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
