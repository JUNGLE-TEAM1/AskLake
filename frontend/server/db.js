import pg from "pg";
import { seedDashboards, seedDatasets, seedJobs } from "./seedData.js";

const { Pool } = pg;

export const databaseUrl = process.env.DATABASE_URL ?? "postgres://asklake:asklake_dev@localhost:54328/asklake";

export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
});

export async function ensureSchema() {
  await pool.query(`
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

    CREATE TABLE IF NOT EXISTS dashboards (
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
  `);
}

async function upsertJson(tableName, payload) {
  await pool.query(
    `
      INSERT INTO ${tableName} (id, payload, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
    `,
    [payload.id, JSON.stringify(payload)],
  );
}

export async function seedDatabase() {
  await ensureSchema();
  for (const job of seedJobs) await upsertJson("etl_jobs", job);
  for (const dataset of seedDatasets) await upsertJson("catalog_datasets", dataset);
  for (const dashboard of seedDashboards) await upsertJson("dashboards", dashboard);

  return {
    dashboards: seedDashboards.length,
    datasets: seedDatasets.length,
    jobs: seedJobs.length,
  };
}

export async function listJobs() {
  const result = await pool.query("SELECT payload FROM etl_jobs ORDER BY id ASC");
  return result.rows.map((row) => row.payload);
}

export async function listDatasets() {
  const result = await pool.query("SELECT payload FROM catalog_datasets ORDER BY id ASC");
  return result.rows.map((row) => row.payload);
}

export async function listDashboards() {
  const result = await queryDashboards();
  return result.items;
}

function normalizeDashboardQuery(query = {}) {
  const pageSize = Number.isFinite(Number(query.pageSize)) ? Number(query.pageSize) : 10;
  const page = Number.isFinite(Number(query.page)) ? Number(query.page) : 1;

  return {
    owner: typeof query.owner === "string" && query.owner !== "all" ? query.owner : null,
    page: Math.max(1, Math.floor(page)),
    pageSize: Math.min(50, Math.max(1, Math.floor(pageSize))),
    searchQuery: typeof query.searchQuery === "string" ? query.searchQuery.trim() : typeof query.search === "string" ? query.search.trim() : "",
    sort: typeof query.sort === "string" ? query.sort : "updated-desc",
    tags: Array.isArray(query.tags) ? query.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()) : typeof query.tags === "string" ? query.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function dashboardOrderBy(sort) {
  const orderBy = {
    "created-asc": "COALESCE(payload->>'createdAtValue', payload->>'createdAt', created_at::text) ASC",
    "created-desc": "COALESCE(payload->>'createdAtValue', payload->>'createdAt', created_at::text) DESC",
    "name-asc": "lower(payload->>'name') ASC",
    "name-desc": "lower(payload->>'name') DESC",
    "updated-asc": "COALESCE(payload->>'updatedAtValue', payload->>'createdAtValue', updated_at::text) ASC",
    "updated-desc": "COALESCE(payload->>'updatedAtValue', payload->>'createdAtValue', updated_at::text) DESC",
  };

  return orderBy[sort] ?? orderBy["updated-desc"];
}

function buildDashboardWhere(query) {
  const clauses = [];
  const params = [];

  if (query.searchQuery) {
    params.push(`%${query.searchQuery}%`);
    const placeholder = `$${params.length}`;
    clauses.push(`(
      payload->>'name' ILIKE ${placeholder}
      OR payload->>'owner' ILIKE ${placeholder}
      OR payload->>'tags' ILIKE ${placeholder}
    )`);
  }

  if (query.owner) {
    params.push(query.owner);
    clauses.push(`payload->>'owner' = $${params.length}`);
  }

  for (const tag of query.tags) {
    params.push(`%${tag}%`);
    clauses.push(`payload->>'tags' ILIKE $${params.length}`);
  }

  return {
    params,
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
  };
}

export async function queryDashboardFacets() {
  const [ownerResult, tagResult] = await Promise.all([
    pool.query("SELECT DISTINCT payload->>'owner' AS owner FROM dashboards ORDER BY owner ASC"),
    pool.query("SELECT payload->>'tags' AS tags FROM dashboards"),
  ]);
  const tagSet = new Set();
  for (const row of tagResult.rows) {
    const tags = String(row.tags ?? "")
      .split("|")
      .flatMap((tag) => tag.split("·"))
      .map((tag) => tag.trim())
      .filter(Boolean);
    tags.forEach((tag) => tagSet.add(tag));
  }

  return {
    owners: ownerResult.rows.map((row) => row.owner).filter(Boolean),
    tags: Array.from(tagSet).sort((first, second) => first.localeCompare(second)),
  };
}

export async function queryDashboards(rawQuery = {}) {
  const query = normalizeDashboardQuery(rawQuery);
  const { params, whereSql } = buildDashboardWhere(query);
  const offset = (query.page - 1) * query.pageSize;
  const orderBy = dashboardOrderBy(query.sort);

  const countResult = await pool.query(`SELECT count(*)::int AS total FROM dashboards ${whereSql}`, params);
  const total = countResult.rows[0]?.total ?? 0;

  const dataParams = [...params, query.pageSize, offset];
  const dashboardsResult = await pool.query(
    `
      SELECT payload
      FROM dashboards
      ${whereSql}
      ORDER BY ${orderBy}, id ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    dataParams,
  );

  return {
    filterOptions: await queryDashboardFacets(),
    items: dashboardsResult.rows.map((row) => row.payload),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

export async function getJob(jobId) {
  const result = await pool.query("SELECT payload FROM etl_jobs WHERE id = $1", [jobId]);
  return result.rows[0]?.payload ?? null;
}

export async function getDataset(datasetId) {
  const result = await pool.query("SELECT payload FROM catalog_datasets WHERE id = $1", [datasetId]);
  return result.rows[0]?.payload ?? null;
}

export async function saveJob(job) {
  await upsertJson("etl_jobs", job);
  return job;
}

export async function saveDataset(dataset) {
  await upsertJson("catalog_datasets", dataset);
  return dataset;
}

export async function saveDashboard(dashboard) {
  await upsertJson("dashboards", dashboard);
  return dashboard;
}

export async function deleteDashboard(dashboardId) {
  const result = await pool.query("DELETE FROM dashboards WHERE id = $1 RETURNING id", [dashboardId]);
  return result.rowCount > 0;
}

export async function saveSqlRun(resultDraft) {
  await pool.query(
    `
      INSERT INTO sql_runs (id, dataset_id, query, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET dataset_id = EXCLUDED.dataset_id, query = EXCLUDED.query, payload = EXCLUDED.payload
    `,
    [resultDraft.runId, resultDraft.datasetId, resultDraft.query, JSON.stringify(resultDraft)],
  );
  return resultDraft;
}

export async function nextJobId() {
  const result = await pool.query("SELECT count(*)::int AS count FROM etl_jobs");
  return `JOB-${String(result.rows[0].count + 1).padStart(3, "0")}`;
}
