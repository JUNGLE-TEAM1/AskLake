import pg from "pg";
import { seedDashboards, seedDatasets, seedJobs } from "./seedData.js";

const { Pool } = pg;

export const databaseUrl = process.env.DATABASE_URL ?? "postgres://asklake:asklake_dev@localhost:54328/asklake";

export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
});

const runtimeWidgetTypeMap = {
  bar: "bar_chart",
  donut: "donut_chart",
  kpi: "metric",
  line: "line_chart",
  table: "table",
};

const defaultLayoutByType = {
  bar_chart: { x: 0, y: 0, w: 6, h: 5, minW: 3, minH: 3 },
  donut_chart: { x: 6, y: 5, w: 4, h: 5, minW: 3, minH: 3 },
  line_chart: { x: 6, y: 0, w: 6, h: 5, minW: 3, minH: 3 },
  metric: { x: 0, y: 5, w: 3, h: 3, minW: 2, minH: 2 },
  table: { x: 0, y: 10, w: 9, h: 5, minW: 4, minH: 3 },
};

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function formatDashboardTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeRuntimeWidgetType(type) {
  return runtimeWidgetTypeMap[type] ?? type ?? "table";
}

function layoutNumber(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function normalizeLayout(input = {}) {
  const x = layoutNumber(input.x, 0);
  const y = layoutNumber(input.y, 0);
  const w = layoutNumber(input.w, 4, 1);
  const h = layoutNumber(input.h, 4, 1);
  const minW = layoutNumber(input.minW, 2, 1);
  const minH = layoutNumber(input.minH, 2, 1);
  return { x, y, w, h, minW, minH };
}

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

    CREATE TABLE IF NOT EXISTS dashboard_revisions (
      id text PRIMARY KEY,
      dashboard_id text NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('draft', 'published')),
      source_revision_id text NULL REFERENCES dashboard_revisions(id) ON DELETE SET NULL,
      version integer NOT NULL DEFAULT 1,
      created_by text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_pages (
      id text PRIMARY KEY,
      revision_id text NOT NULL REFERENCES dashboard_revisions(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT 'Untitled page',
      order_index integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id text PRIMARY KEY,
      page_id text NOT NULL REFERENCES dashboard_pages(id) ON DELETE CASCADE,
      type text NOT NULL,
      title text NULL,
      query_id text NULL,
      dataset_id text NULL,
      config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      layout_json jsonb NOT NULL,
      data_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dashboard_tags (
      dashboard_id text NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      tag text NOT NULL,
      PRIMARY KEY (dashboard_id, tag)
    );

    CREATE INDEX IF NOT EXISTS dashboard_revisions_dashboard_kind_idx
      ON dashboard_revisions (dashboard_id, kind, created_at DESC);

    CREATE INDEX IF NOT EXISTS dashboard_pages_revision_order_idx
      ON dashboard_pages (revision_id, order_index ASC);

    CREATE INDEX IF NOT EXISTS dashboard_widgets_page_idx
      ON dashboard_widgets (page_id);
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
  for (const dashboard of seedDashboards) {
    await upsertJson("dashboards", dashboard);
    await ensureDashboardRuntimeSeed(dashboard);
  }

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

function withDashboardRevisionFlags(dashboard, hasPublishedRevision) {
  return {
    ...dashboard,
    hasPublishedRevision: Boolean(hasPublishedRevision || dashboard.hasPublishedRevision || dashboard.status === "published"),
  };
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
      SELECT
        payload,
        EXISTS (
          SELECT 1
          FROM dashboard_revisions
          WHERE dashboard_revisions.dashboard_id = dashboards.id
            AND dashboard_revisions.kind = 'published'
        ) AS has_published_revision
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
    items: dashboardsResult.rows.map((row) => withDashboardRevisionFlags(row.payload, row.has_published_revision)),
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

export async function getDashboard(dashboardId) {
  const result = await pool.query("SELECT payload FROM dashboards WHERE id = $1", [dashboardId]);
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

export async function createDashboard(input = {}, actor = {}) {
  const createdAt = new Date();
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : `새 대시보드 ${formatDashboardTimestamp(createdAt)}`;
  const createdAtValue = createdAt.toISOString();
  const dashboard = {
    createdAt: formatDashboardTimestamp(createdAt),
    createdAtValue,
    datasetId: typeof input.datasetId === "string" ? input.datasetId : undefined,
    hasPublishedRevision: false,
    id: makeId("dash"),
    meta: "0개 위젯 · 수동 생성",
    name: title,
    owner: typeof input.owner === "string" && input.owner.trim() ? input.owner.trim() : actor.name ?? "Admin User",
    sourceRunId: typeof input.sqlRunId === "string" ? input.sqlRunId : undefined,
    status: "draft",
    tags: "초안 · Dashboard",
    updated: "방금 전",
    updatedAtValue: createdAtValue,
    widgets: [],
  };

  await saveDashboard(dashboard);
  return dashboard;
}

async function saveDashboardPatch(dashboardId, patch) {
  const dashboard = await getDashboard(dashboardId);
  if (!dashboard) return null;
  const nextDashboard = { ...dashboard, ...patch };
  await saveDashboard(nextDashboard);
  return nextDashboard;
}

export async function updateDashboardTitle(dashboardId, title) {
  const nextTitle = typeof title === "string" ? title.trim() : "";
  if (!nextTitle) return { error: { code: "VALIDATION_ERROR", message: "Dashboard title is required", status: 400 } };

  const updatedAtValue = new Date().toISOString();
  const dashboard = await saveDashboardPatch(dashboardId, {
    name: nextTitle,
    title: nextTitle,
    updated: "방금 전",
    updatedAtValue,
  });
  if (!dashboard) return null;

  return dashboard;
}

async function getLatestRevision(dashboardId, kind) {
  const result = await pool.query(
    `
      SELECT *
      FROM dashboard_revisions
      WHERE dashboard_id = $1
        AND kind = $2
      ORDER BY created_at DESC, version DESC
      LIMIT 1
    `,
    [dashboardId, kind],
  );
  return result.rows[0] ?? null;
}

async function nextRevisionVersion(dashboardId, kind) {
  const result = await pool.query(
    "SELECT COALESCE(max(version), 0)::int + 1 AS version FROM dashboard_revisions WHERE dashboard_id = $1 AND kind = $2",
    [dashboardId, kind],
  );
  return result.rows[0]?.version ?? 1;
}

async function createRevision({ dashboardId, kind, sourceRevisionId = null, publishedAt = null }) {
  const id = makeId(`dashrev_${kind}`);
  const version = await nextRevisionVersion(dashboardId, kind);
  const result = await pool.query(
    `
      INSERT INTO dashboard_revisions (id, dashboard_id, kind, source_revision_id, version, created_by, published_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [id, dashboardId, kind, sourceRevisionId, version, "demo.user@asklake.local", publishedAt],
  );
  return result.rows[0];
}

async function createPage({ revisionId, title = "Untitled page", orderIndex = 0 }) {
  const id = makeId("dashpage");
  const result = await pool.query(
    `
      INSERT INTO dashboard_pages (id, revision_id, title, order_index)
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, order_index
    `,
    [id, revisionId, title, orderIndex],
  );
  return result.rows[0];
}

async function createWidget({ pageId, type, title = null, layout, config = {}, data = [], queryId = null, datasetId = null }) {
  const id = makeId("dashwidget");
  const result = await pool.query(
    `
      INSERT INTO dashboard_widgets (id, page_id, type, title, query_id, dataset_id, config_json, layout_json, data_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
      RETURNING id
    `,
    [id, pageId, type, title, queryId, datasetId, JSON.stringify(config), JSON.stringify(normalizeLayout(layout)), JSON.stringify(data)],
  );
  return result.rows[0];
}

async function seedWidgetsForPage(pageId, dashboard) {
  const countResult = await pool.query("SELECT count(*)::int AS count FROM dashboard_widgets WHERE page_id = $1", [pageId]);
  if ((countResult.rows[0]?.count ?? 0) > 0) return;

  const widgetTypes = Array.isArray(dashboard.widgets) && dashboard.widgets.length ? dashboard.widgets : [];
  for (const [index, rawType] of widgetTypes.entries()) {
    const type = normalizeRuntimeWidgetType(rawType);
    await createWidget({
      pageId,
      type,
      title: null,
      layout: {
        ...(defaultLayoutByType[type] ?? defaultLayoutByType.table),
        y: Math.floor(index / 2) * 5,
        x: index % 2 === 0 ? 0 : 6,
      },
      config: {},
      data: [],
      datasetId: dashboard.datasetId ?? null,
    });
  }
}

async function createEmptyRuntimeRevision(dashboardId, kind, dashboard, options = {}) {
  const revision = await createRevision({
    dashboardId,
    kind,
    publishedAt: options.publishedAt ?? null,
    sourceRevisionId: options.sourceRevisionId ?? null,
  });
  const page = await createPage({ revisionId: revision.id, title: "Untitled page", orderIndex: 0 });
  if (dashboard) await seedWidgetsForPage(page.id, dashboard);
  return revision;
}

async function cloneRevision({ sourceRevisionId, kind, publishedAt = null }) {
  const sourceRevisionResult = await pool.query("SELECT * FROM dashboard_revisions WHERE id = $1", [sourceRevisionId]);
  const sourceRevision = sourceRevisionResult.rows[0];
  if (!sourceRevision) return null;

  const revision = await createRevision({
    dashboardId: sourceRevision.dashboard_id,
    kind,
    publishedAt,
    sourceRevisionId,
  });

  const pagesResult = await pool.query(
    "SELECT * FROM dashboard_pages WHERE revision_id = $1 ORDER BY order_index ASC",
    [sourceRevisionId],
  );

  for (const sourcePage of pagesResult.rows) {
    const page = await createPage({
      revisionId: revision.id,
      title: sourcePage.title,
      orderIndex: sourcePage.order_index,
    });
    const widgetsResult = await pool.query(
      "SELECT * FROM dashboard_widgets WHERE page_id = $1 ORDER BY created_at ASC, id ASC",
      [sourcePage.id],
    );
    for (const sourceWidget of widgetsResult.rows) {
      await createWidget({
        pageId: page.id,
        type: sourceWidget.type,
        title: sourceWidget.title,
        queryId: sourceWidget.query_id,
        datasetId: sourceWidget.dataset_id,
        config: sourceWidget.config_json ?? {},
        layout: sourceWidget.layout_json ?? {},
        data: sourceWidget.data_json ?? [],
      });
    }
  }

  return revision;
}

async function ensureDashboardRuntimeSeed(dashboard) {
  const existingDraft = await getLatestRevision(dashboard.id, "draft");
  const existingPublished = await getLatestRevision(dashboard.id, "published");
  const draftRevision = existingDraft ?? (await createEmptyRuntimeRevision(dashboard.id, "draft", dashboard));
  const publishedRevision = dashboard.status === "published"
    ? existingPublished ?? (await cloneRevision({ sourceRevisionId: draftRevision.id, kind: "published", publishedAt: new Date().toISOString() }))
    : existingPublished;

  await saveDashboard({
    ...dashboard,
    draftRevisionId: draftRevision.id,
    hasPublishedRevision: Boolean(publishedRevision),
    publishedRevisionId: publishedRevision?.id ?? null,
  });
}

function toDashboardMeta(dashboard, hasPublishedRevision) {
  return {
    hasPublishedRevision,
    id: dashboard.id,
    status: dashboard.status === "published" || hasPublishedRevision ? "published" : "draft",
    title: dashboard.name ?? dashboard.title ?? "Untitled dashboard",
    updatedAt: dashboard.updatedAtValue ?? dashboard.createdAtValue ?? new Date().toISOString(),
  };
}

async function buildRuntimePayload({ dashboard, mode, revision }) {
  const hasPublishedRevision = Boolean(await getLatestRevision(dashboard.id, "published"));

  if (!revision) {
    return {
      dashboard: toDashboardMeta(dashboard, hasPublishedRevision),
      filters: [],
      mode,
      pages: [],
      revision: null,
      widgetsByPageId: {},
    };
  }

  const pagesResult = await pool.query(
    "SELECT id, title, order_index FROM dashboard_pages WHERE revision_id = $1 ORDER BY order_index ASC",
    [revision.id],
  );
  const pages = pagesResult.rows.map((page) => ({
    id: page.id,
    orderIndex: page.order_index,
    title: page.title,
  }));
  const widgetsByPageId = {};

  for (const page of pages) {
    const widgetsResult = await pool.query(
      `
        SELECT id, page_id, type, title, query_id, dataset_id, config_json, layout_json, data_json
        FROM dashboard_widgets
        WHERE page_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [page.id],
    );
    widgetsByPageId[page.id] = widgetsResult.rows.map((widget) => ({
      config: widget.config_json ?? {},
      data: widget.data_json ?? [],
      datasetId: widget.dataset_id,
      id: widget.id,
      layout: normalizeLayout(widget.layout_json ?? {}),
      pageId: widget.page_id,
      queryId: widget.query_id,
      title: widget.title,
      type: widget.type,
    }));
  }

  return {
    dashboard: toDashboardMeta(dashboard, hasPublishedRevision),
    filters: [],
    mode,
    pages,
    revision: {
      id: revision.id,
      kind: revision.kind,
      publishedAt: revision.published_at,
      version: revision.version,
    },
    widgetsByPageId,
  };
}

export async function getPublishedDashboardRuntime(dashboardId) {
  const dashboard = await getDashboard(dashboardId);
  if (!dashboard) return null;
  const publishedRevision = await getLatestRevision(dashboardId, "published");
  return buildRuntimePayload({ dashboard, mode: "published", revision: publishedRevision });
}

export async function ensureDraftDashboardRuntime(dashboardId) {
  const dashboard = await getDashboard(dashboardId);
  if (!dashboard) return null;

  let draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision) {
    const publishedRevision = await getLatestRevision(dashboardId, "published");
    draftRevision = publishedRevision
      ? await cloneRevision({ sourceRevisionId: publishedRevision.id, kind: "draft" })
      : await createEmptyRuntimeRevision(dashboardId, "draft", dashboard);
  }

  await saveDashboardPatch(dashboardId, {
    draftRevisionId: draftRevision.id,
  });
  const nextDashboard = await getDashboard(dashboardId);
  return buildRuntimePayload({ dashboard: nextDashboard, mode: "draft", revision: draftRevision });
}

export async function createDraftDashboardPage(dashboardId, { title = "제목 없는 페이지" } = {}) {
  const draftPayload = await ensureDraftDashboardRuntime(dashboardId);
  if (!draftPayload?.revision) return null;
  const maxOrderResult = await pool.query(
    "SELECT COALESCE(max(order_index), -1)::int + 1 AS next_order FROM dashboard_pages WHERE revision_id = $1",
    [draftPayload.revision.id],
  );
  const page = await createPage({
    revisionId: draftPayload.revision.id,
    title,
    orderIndex: maxOrderResult.rows[0]?.next_order ?? draftPayload.pages.length,
  });
  return {
    id: page.id,
    orderIndex: page.order_index,
    title: page.title,
  };
}

export async function createDraftDashboardWidget(dashboardId, pageId, input = {}) {
  const draftPayload = await ensureDraftDashboardRuntime(dashboardId);
  if (!draftPayload?.revision || !pageId) return null;

  const pageResult = await pool.query(
    "SELECT id FROM dashboard_pages WHERE id = $1 AND revision_id = $2",
    [pageId, draftPayload.revision.id],
  );
  if (!pageResult.rows[0]) return null;

  const type = normalizeRuntimeWidgetType(input.type);
  const fallbackLayout = defaultLayoutByType[type] ?? defaultLayoutByType.table;
  const layout = normalizeLayout(input.layout ?? fallbackLayout);
  const widget = await createWidget({
    pageId,
    type,
    title: input.title ?? null,
    layout,
    config: input.config ?? {},
    data: Array.isArray(input.data) ? input.data : [],
    queryId: input.queryId ?? null,
    datasetId: input.datasetId ?? null,
  });

  return {
    id: widget.id,
  };
}

export async function deleteDraftDashboardPage(dashboardId, pageId) {
  const draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision || !pageId) return null;

  const deleteResult = await pool.query(
    `
      DELETE FROM dashboard_pages
      WHERE id = $1
        AND revision_id = $2
      RETURNING id
    `,
    [pageId, draftRevision.id],
  );
  if (!deleteResult.rows[0]) return null;

  const remainingPages = await pool.query(
    "SELECT id FROM dashboard_pages WHERE revision_id = $1 ORDER BY order_index ASC, created_at ASC",
    [draftRevision.id],
  );
  for (const [index, page] of remainingPages.rows.entries()) {
    await pool.query("UPDATE dashboard_pages SET order_index = $1 WHERE id = $2", [index, page.id]);
  }

  return { ok: true };
}

export async function deleteDraftDashboardWidget(dashboardId, widgetId) {
  const draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision || !widgetId) return null;

  const deleteResult = await pool.query(
    `
      DELETE FROM dashboard_widgets
      USING dashboard_pages
      WHERE dashboard_widgets.id = $1
        AND dashboard_widgets.page_id = dashboard_pages.id
        AND dashboard_pages.revision_id = $2
      RETURNING dashboard_widgets.id
    `,
    [widgetId, draftRevision.id],
  );
  const widget = deleteResult.rows[0];
  if (!widget) return null;

  await saveDashboardPatch(dashboardId, {
    updated: "방금 전",
    updatedAtValue: new Date().toISOString(),
  });

  return { deletedWidgetId: widget.id, ok: true };
}

export async function updateDraftDashboardPageTitle(dashboardId, pageId, title) {
  const nextTitle = typeof title === "string" ? title.trim() : "";
  if (!nextTitle) return { error: { code: "VALIDATION_ERROR", message: "Page title is required", status: 400 } };

  const draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision || !pageId) return null;

  const updateResult = await pool.query(
    `
      UPDATE dashboard_pages
      SET title = $1,
          updated_at = now()
      WHERE id = $2
        AND revision_id = $3
      RETURNING id, title, order_index
    `,
    [nextTitle, pageId, draftRevision.id],
  );
  const page = updateResult.rows[0];
  if (!page) return null;

  await saveDashboardPatch(dashboardId, {
    updated: "방금 전",
    updatedAtValue: new Date().toISOString(),
  });

  return {
    id: page.id,
    orderIndex: page.order_index,
    title: page.title,
  };
}

export async function saveDraftDashboardLayouts(dashboardId, { pageId, layouts = [] } = {}) {
  const draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision || !pageId || !Array.isArray(layouts)) return null;

  const pageResult = await pool.query(
    "SELECT id FROM dashboard_pages WHERE id = $1 AND revision_id = $2",
    [pageId, draftRevision.id],
  );
  if (!pageResult.rows[0]) return null;

  for (const layout of layouts) {
    const widgetId = layout.widgetId ?? layout.i;
    if (!widgetId) continue;
    await pool.query(
      `
        UPDATE dashboard_widgets
        SET layout_json = $1::jsonb,
            updated_at = now()
        WHERE id = $2
          AND page_id = $3
      `,
      [JSON.stringify(normalizeLayout(layout)), widgetId, pageId],
    );
  }

  return { ok: true };
}

export async function publishDashboardRuntime(dashboardId) {
  const dashboard = await getDashboard(dashboardId);
  if (!dashboard) return null;

  const draftRevision = await getLatestRevision(dashboardId, "draft");
  if (!draftRevision) return { error: { code: "NO_DRAFT_REVISION", message: "No draft revision", status: 422 } };

  const publishedAt = new Date().toISOString();
  const publishedRevision = await cloneRevision({
    sourceRevisionId: draftRevision.id,
    kind: "published",
    publishedAt,
  });
  await saveDashboardPatch(dashboardId, {
    hasPublishedRevision: true,
    publishedRevisionId: publishedRevision.id,
    status: "published",
    updated: "방금 전",
    updatedAtValue: publishedAt,
  });

  return {
    dashboardId,
    publishedAt,
    publishedRevisionId: publishedRevision.id,
  };
}

export async function deleteDashboard(dashboardId) {
  const result = await pool.query("DELETE FROM dashboards WHERE id = $1 RETURNING payload", [dashboardId]);
  return result.rows[0]?.payload ?? null;
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
