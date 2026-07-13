import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { fieldValue } from "../src/profile.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const sourceConfig = Array.isArray(payload.sourceConfig) ? payload.sourceConfig : [];
const outputPath = path.resolve(requiredText(payload.outputPath, "PostgreSQL execution output path is required."));
const runId = requiredText(payload.runId, "PostgreSQL execution runId is required.");

try {
  const result = await exportPostgresExecutionSource({ outputPath, runId, sourceConfig });
  console.log(`ASKLAKE_POSTGRES_EXECUTION_SOURCE=${JSON.stringify(result)}`);
} catch (error) {
  await rm(outputPath, { force: true }).catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function exportPostgresExecutionSource({ outputPath: targetPath, runId: executionRunId, sourceConfig: fields }) {
  const host = requiredField(fields, "Endpoint / Host");
  const port = positiveInteger(requiredField(fields, "Port"), "Port");
  const database = requiredField(fields, "Database Name");
  const schema = fieldValue(fields, "Schema") || "public";
  const user = requiredField(fields, "Username");
  const password = requiredField(fields, "Password / Auth Token");
  const requestedTable = fieldValue(fields, "DATASET OR TABLE SELECTOR")
    || fieldValue(fields, "__Selected Object")
    || fieldValue(fields, "__Sample Object");
  const batchRows = boundedInteger(process.env.ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS, 1000, 100, 10000);
  const client = new pg.Client({
    connectionTimeoutMillis: boundedInteger(process.env.ASKLAKE_POSTGRES_EXECUTION_CONNECT_TIMEOUT_MS, 5000, 1000, 60000),
    database,
    host,
    password,
    port,
    query_timeout: 0,
    statement_timeout: 0,
    user,
  });
  let transactionOpen = false;
  let stream;

  try {
    await client.connect();
    const tableResult = await client.query(
      "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name",
      [schema],
    );
    const table = requestedTable || tableResult.rows[0]?.table_name || "";
    if (!table || !tableResult.rows.some((row) => row.table_name === table)) {
      throw new Error(`PostgreSQL execution table was not found: ${schema}.${table || "<empty>"}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    stream = createWriteStream(targetPath, { encoding: "utf8", flags: "w" });
    await once(stream, "open");
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query(`DECLARE asklake_execution_source NO SCROLL CURSOR FOR SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}`);

    let rowCount = 0;
    let columns = [];
    while (true) {
      const batch = await client.query(`FETCH FORWARD ${batchRows} FROM asklake_execution_source`);
      if (columns.length === 0) columns = batch.fields.map((field) => field.name);
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, "drain");
      }
      rowCount += batch.rows.length;
    }

    await client.query("CLOSE asklake_execution_source");
    await client.query("COMMIT");
    transactionOpen = false;
    const finished = once(stream, "finish");
    stream.end();
    await finished;
    if (rowCount === 0) {
      throw new Error(`PostgreSQL execution source is empty: ${schema}.${table}`);
    }

    return {
      batchRows,
      columns,
      outputPath: targetPath,
      rowCount,
      runId: executionRunId,
      schema,
      table,
    };
  } catch (error) {
    if (stream && !stream.closed) stream.destroy();
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function requiredField(fields, label) {
  const value = fieldValue(fields, label);
  if (!value) throw new Error(`PostgreSQL execution field is required: ${label}`);
  return value;
}

function requiredText(value, message) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(message);
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`PostgreSQL execution ${label} must be a positive integer.`);
  return number;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
