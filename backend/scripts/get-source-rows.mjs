import { readFileSync } from "node:fs";
import { getSourceRows } from "../src/connectors.mjs";

try {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  const result = await getSourceRows(
    payload.sourceType,
    Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [],
    { knownRowCount: payload.knownRowCount, limit: payload.limit, offset: payload.offset },
  );
  console.log(`ASKLAKE_SOURCE_ROWS_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.error(`ASKLAKE_SOURCE_ROWS_ERROR=${JSON.stringify({
    code: error?.code || "SOURCE_ROWS_FAILED",
    message: error?.message || "Source rows could not be loaded.",
    status: error?.status || 500,
  })}`);
  process.exitCode = 1;
}
