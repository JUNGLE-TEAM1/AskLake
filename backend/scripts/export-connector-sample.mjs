import { readFileSync } from "node:fs";
import { testSourceConnector } from "../src/connectors.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const sourceType = payload.sourceType;
const sourceConfig = Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [];

const result = await testSourceConnector(sourceType, sourceConfig);
const schema = result?.draftPatch?.schema ?? {};
const output = {
  columns: Array.isArray(schema.columns) ? schema.columns : [],
  rows: Array.isArray(schema.sampleRows) ? schema.sampleRows : [],
};

console.log(`ASKLAKE_CONNECTOR_SAMPLE=${JSON.stringify(output)}`);
