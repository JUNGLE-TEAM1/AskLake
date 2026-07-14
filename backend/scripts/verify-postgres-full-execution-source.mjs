import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const outputPath = path.join(backendDir, "tmp", `postgres-full-source-verify-${process.pid}.jsonl`);
const port = process.env.ASKLAKE_SOURCE_PGPORT || "15432";
const password = process.env.ASKLAKE_SOURCE_PGPASSWORD || "asklake";
const table = process.env.ASKLAKE_POSTGRES_FULL_SOURCE_TABLE || "products";
const sourceConfig = [
  ["Endpoint / Host", "127.0.0.1"],
  ["Port", port],
  ["Database Name", "asklake_sources"],
  ["Schema", "public"],
  ["Username", "asklake"],
  ["Password / Auth Token", password],
  ["DATASET OR TABLE SELECTOR", table],
  ["__Schema Sample Scope", "current"],
  ["__Schema Sample Scope Label", "현재 행"],
  ["__Sample Row Limit", "10"],
];

try {
  const expectedRows = await tableRowCount();
  const runId = `verify_full_${Date.now().toString(36)}`;
  const result = spawnSync(process.execPath, ["scripts/export-postgres-execution-source.mjs"], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify({ outputPath, runId, sourceConfig }),
    maxBuffer: 4 * 1024 * 1024,
  });
  assert(result.status === 0, `PostgreSQL execution export failed:\n${result.stdout}\n${result.stderr}`);
  const marker = String(result.stdout || "").split(/\r?\n/)
    .findLast((line) => line.startsWith("ASKLAKE_POSTGRES_EXECUTION_SOURCE="));
  assert(marker, "PostgreSQL execution export returned no result marker.");
  const exported = JSON.parse(marker.slice("ASKLAKE_POSTGRES_EXECUTION_SOURCE=".length));
  const actualRows = await jsonlRowCount(outputPath);
  assert(exported.runId === runId, `Run identity drifted: ${exported.runId} != ${runId}`);
  assert(exported.table === table, `Table identity drifted: ${exported.table} != ${table}`);
  assert(Number(exported.rowCount) === expectedRows, `Export marker row count drifted: ${exported.rowCount} != ${expectedRows}`);
  assert(actualRows === expectedRows, `JSONL row count drifted: ${actualRows} != ${expectedRows}`);
  assert(actualRows > 10, `Current preview scope leaked into execution export: ${actualRows} rows.`);
  await verifyMissingTableFails();
  await verifyEmptyTableFails();
  console.log(JSON.stringify({
    emptyTableFailure: "ok",
    executionRows: actualRows,
    missingTableFailure: "ok",
    previewRowLimit: 10,
    previewScope: "current",
    status: "ok",
    table,
  }, null, 2));
} finally {
  await rm(outputPath, { force: true });
}

async function tableRowCount() {
  return withClient(async (client) => {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent("public")}.${quoteIdent(table)}`);
    return Number(result.rows[0]?.count || 0);
  });
}

async function verifyMissingTableFails() {
  const missingTable = `asklake_missing_${process.pid}`;
  const failed = runExporter(sourceConfigForTable(missingTable), `${outputPath}.missing`, `verify_missing_${process.pid}`);
  assert(failed.status !== 0, "Missing PostgreSQL execution table must fail.");
  await rm(`${outputPath}.missing`, { force: true });
}

async function verifyEmptyTableFails() {
  const emptyTable = `asklake_empty_${process.pid}`;
  await withClient((client) => client.query(`CREATE TABLE ${quoteIdent("public")}.${quoteIdent(emptyTable)} (id integer)`));
  try {
    const failed = runExporter(sourceConfigForTable(emptyTable), `${outputPath}.empty`, `verify_empty_${process.pid}`);
    assert(failed.status !== 0, "Empty PostgreSQL execution table must fail.");
    assert(`${failed.stdout}\n${failed.stderr}`.includes("execution source is empty"), "Empty table failure must explain the cause.");
  } finally {
    await withClient((client) => client.query(`DROP TABLE IF EXISTS ${quoteIdent("public")}.${quoteIdent(emptyTable)}`));
    await rm(`${outputPath}.empty`, { force: true });
  }
}

function runExporter(config, targetPath, runId) {
  return spawnSync(process.execPath, ["scripts/export-postgres-execution-source.mjs"], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify({ outputPath: targetPath, runId, sourceConfig: config }),
    maxBuffer: 4 * 1024 * 1024,
  });
}

function sourceConfigForTable(tableName) {
  return sourceConfig.map(([label, value]) => (
    label === "DATASET OR TABLE SELECTOR" ? [label, tableName] : [label, value]
  ));
}

async function withClient(callback) {
  const client = new pg.Client({
    database: "asklake_sources",
    host: "127.0.0.1",
    password,
    port: Number(port),
    user: "asklake",
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function jsonlRowCount(filePath) {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (line.trim()) count += 1;
  }
  return count;
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
