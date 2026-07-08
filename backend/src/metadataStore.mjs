import pg from "pg";
import { normalizeColumnName } from "./profile.mjs";

const { Pool } = pg;

export const databaseUrl = process.env.DATABASE_URL || "postgres://asklake:asklake_dev@127.0.0.1:54328/asklake";

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: Number(process.env.ASKLAKE_DB_CONNECT_TIMEOUT_MS || 10000),
});

let schemaReady;

export function ensureMetadataSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS etl_jobs (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS catalog_datasets (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sql_runs (
        id text PRIMARY KEY,
        dataset_id text NOT NULL,
        query text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS etl_jobs_status_idx
        ON etl_jobs ((payload->>'status'));
      CREATE INDEX IF NOT EXISTS etl_jobs_owner_idx
        ON etl_jobs ((payload->>'owner'));
      CREATE INDEX IF NOT EXISTS etl_jobs_target_idx
        ON etl_jobs ((payload->>'target'));
      CREATE INDEX IF NOT EXISTS catalog_datasets_layer_idx
        ON catalog_datasets ((payload->>'layer'));
      CREATE INDEX IF NOT EXISTS catalog_datasets_owner_idx
        ON catalog_datasets ((payload->>'owner'));
      CREATE INDEX IF NOT EXISTS sql_runs_dataset_id_idx
        ON sql_runs (dataset_id);
    `);
  }
  return schemaReady;
}

export async function resetMetadata() {
  await ensureMetadataSchema();
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.etl_runs') IS NOT NULL THEN
        DELETE FROM etl_runs;
      END IF;
    END $$;
    DELETE FROM sql_runs;
    DELETE FROM catalog_datasets;
    DELETE FROM etl_jobs;
  `);
}

export async function countJobs() {
  await ensureMetadataSchema();
  const result = await pool.query("SELECT count(*)::int AS count FROM etl_jobs");
  return Number(result.rows[0]?.count ?? 0);
}

export async function listJobs() {
  await ensureMetadataSchema();
  const result = await pool.query("SELECT payload FROM etl_jobs ORDER BY updated_at DESC, created_at DESC");
  return result.rows
    .map((row) => row.payload)
    .filter(isPlainObject);
}

export async function listDatasets() {
  await ensureMetadataSchema();
  const result = await pool.query("SELECT payload FROM catalog_datasets ORDER BY updated_at DESC, created_at DESC");
  return result.rows
    .map((row) => row.payload)
    .filter(isPlainObject);
}

export async function getJob(jobId) {
  await ensureMetadataSchema();
  const result = await pool.query("SELECT payload FROM etl_jobs WHERE id = $1", [jobId]);
  return result.rows[0]?.payload ?? null;
}

export async function getDataset(datasetId) {
  await ensureMetadataSchema();
  const result = await pool.query("SELECT payload FROM catalog_datasets WHERE id = $1", [datasetId]);
  return result.rows[0]?.payload ?? null;
}

export async function findDatasetForJob(job) {
  await ensureMetadataSchema();
  const result = await pool.query(
    `
      SELECT payload
      FROM catalog_datasets
      WHERE id = $1
        OR payload->>'name' = $2
        OR payload->>'source' = $3
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [`ds_${normalizeColumnName(job.target || "")}`, job.target, job.name],
  );
  return result.rows[0]?.payload ?? null;
}

export async function saveJob(job) {
  await ensureMetadataSchema();
  await pool.query(
    `
      INSERT INTO etl_jobs (id, payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
    `,
    [job.id, JSON.stringify(job)],
  );
  return job;
}

export async function saveDataset(dataset) {
  await ensureMetadataSchema();
  await pool.query(
    `
      INSERT INTO catalog_datasets (id, payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
    `,
    [dataset.id, JSON.stringify(dataset)],
  );
  return dataset;
}

export async function savePipelineCreation(job, dataset) {
  await ensureMetadataSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO etl_jobs (id, payload)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
      `,
      [job.id, JSON.stringify(job)],
    );
    await client.query(
      `
        INSERT INTO catalog_datasets (id, payload)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
      `,
      [dataset.id, JSON.stringify(dataset)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { dataset, job };
}

export async function saveSqlRun(run) {
  await ensureMetadataSchema();
  await pool.query(
    `
      INSERT INTO sql_runs (id, dataset_id, query, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET dataset_id = EXCLUDED.dataset_id, query = EXCLUDED.query, payload = EXCLUDED.payload
    `,
    [run.runId, run.datasetId, run.query, JSON.stringify(run)],
  );
  return run;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
