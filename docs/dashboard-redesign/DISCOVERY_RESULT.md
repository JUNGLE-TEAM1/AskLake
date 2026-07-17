# Discovery Result

> Historical snapshot: the browser mock mode described below has since been removed. The current dashboard uses live backend APIs only.

## Framework

- Frontend framework: React + Vite + TypeScript.
- App entry: `frontend/src/main.tsx`.
- Vite config: `frontend/vite.config.ts`.
- Current frontend lives under `frontend/`.
- There is also a lightweight Node HTTP API server under `frontend/server/`.

## Package Manager

- Package manager: npm.
- Lockfile: `frontend/package-lock.json`.
- No pnpm/yarn/bun lockfile was found.
- Commands should run from `frontend/`.

## Routing

- The app does not currently use React Router or Next.js routing.
- Navigation is state-based in `frontend/src/App.tsx`.
  - `activeFlow` decides the main module.
  - `DashboardPage` receives a `DashboardEntry`.
- Dashboard internal views are also state-based:
  - `DashboardView = "list" | "builder" | "detail"` in `frontend/src/types/dashboard.ts`.
  - `DashboardPage.tsx` switches between list, builder, and detail internally.
- Current dashboard share URL construction mentions `/dashboards/...`, but no real URL route handles it yet.
- Phase 01 should add a small URL synchronization layer or introduce a router. Because no router dependency exists today, the conservative path is to add a narrow browser history/path parser first rather than adding `react-router-dom`.

## Existing Dashboard Files

- Main dashboard page:
  - `frontend/src/pages/dashboard/DashboardPage.tsx`
- Existing white dashboard list page:
  - `frontend/src/pages/dashboard/DashboardLandingPage.tsx`
  - `frontend/src/pages/dashboard/components/DashboardTable.tsx`
  - `frontend/src/pages/dashboard/components/DashboardListToolbar.tsx`
  - `frontend/src/pages/dashboard/components/DashboardPagination.tsx`
- Existing dashboard helper/components:
  - `frontend/src/pages/dashboard/DashboardParts.tsx`
  - `frontend/src/pages/dashboard/dashboardListData.ts`
  - `frontend/src/pages/dashboard/dashboardListUtils.ts`
  - `frontend/src/pages/dashboard/useDashboardLandingList.ts`
- Existing dashboard styles:
  - `frontend/src/styles/dashboard.css`
- Existing dashboard types:
  - `frontend/src/types/dashboard.ts`

Current list UI is close to the reference white dashboard list and should be preserved. It already includes search, owner filter, tag filter, sort, pagination, status tags, and a create button. It does not currently expose a delete action column in `DashboardTable.tsx`.

## Existing API Files

Frontend API boundary:

- `frontend/src/services/apiClient.ts`
  - Common fetch wrapper.
  - Uses `VITE_API_BASE_URL`, defaulting to `http://localhost:8080`.
  - At the time of discovery, an environment switch enabled browser mock mode; this path is no longer available.
- `frontend/src/services/mockApi.ts`
  - Handles jobs, datasets, dashboard cards, job commands, SQL execution.
  - In live mode calls the Node API server.
- `frontend/src/services/dashboardApi.ts`
  - Dashboard list query adapter.
  - Calls `POST /api/dashboards/query` in live mode.

Node API server:

- `frontend/server/index.js`
  - `GET /api/health`
  - `GET /api/etl/jobs`
  - `POST /api/etl/jobs`
  - `POST /api/etl/jobs/:jobId/commands`
  - `GET /api/catalog/datasets`
  - `POST /api/query/runs`
  - `GET /api/dashboards`
  - `POST /api/dashboards/query`
  - `PUT|PATCH /api/dashboards/:dashboardId`
- `frontend/server/db.js`
  - Postgres connection and JSONB table helpers.
- `frontend/server/seed.js`
- `frontend/server/seedData.js`

The current dashboard API stores whole dashboard cards, not dashboard runtime revisions/pages/widgets.

## Database / ORM

- Database: PostgreSQL via `pg`.
- Docker config: `docker-compose.yml`, service `postgres`, port `54328`.
- Default server connection:
  - `postgres://asklake:asklake_dev@localhost:54328/asklake`
- ORM: none.
- Migration system: none found.
- Schema is created imperatively in `frontend/server/db.js` via `ensureSchema()`.
- Current tables:
  - `etl_jobs`
  - `catalog_datasets`
  - `dashboards`
  - `sql_runs`
- Tables use `id text primary key` plus `payload jsonb`.
- No existing tables for:
  - `dashboard_revisions`
  - `dashboard_pages`
  - `dashboard_widgets`
  - `dashboard_tags`

Phase 02 should extend `ensureSchema()` or introduce a project-local migration strategy before adding revision tables. Given the current server style, extending `ensureSchema()` is the smallest compatible first step.

## Installed UI Libraries

- `lucide-react` is installed and used throughout the app.
- Tailwind is not installed.
- shadcn/ui is not installed.
- UI is styled with plain CSS files imported by `frontend/src/styles.css`.

## Installed Chart Libraries

- No Recharts, ECharts, Chart.js, D3, or react-grid-layout dependency is installed.
- Current dashboard charts are hand-built with JSX/CSS in `DashboardPage.tsx` and `DashboardParts.tsx`.
- Phase 01 needs no chart/grid dependency.
- Phase 04 will need `react-grid-layout` and `react-resizable`.
- Phase 05 should choose one chart library. Because no chart library is installed today, Recharts is the likely smallest option for metric/bar/line/donut/table.

## Auth / User / Owner

- No real authentication layer exists.
- Audit actor is hardcoded as `demo.user@asklake.local` in `frontend/src/hooks/useAuditLogs.ts`.
- Dashboard ownership is a string field on dashboard cards.
- Dataset/job owners are also plain strings.
- Backend API does not currently enforce read/edit/publish permissions.

## Test Scripts

Scripts in `frontend/package.json`:

- `npm run api`: starts `frontend/server/index.js`.
- `npm run dev`: starts Vite.
- `npm run db:seed`: runs `frontend/server/seed.js`.
- `npm run build`: runs `tsc -b && vite build`.
- `npm run preview`: starts Vite preview.

Missing scripts:

- No `lint` script.
- No `typecheck` script.
- No `test` script.

For Phase verification, use `npm run build` unless new scripts are added.

## Risks

- The implementation pack assumes URL routes like `/dashboards/:id` and `/dashboards/:id/edit`; the current app uses state-based navigation.
- Existing docs say backend is planned, but this branch already has a Node/Postgres demo API. Numbered docs may need follow-up sync if backend/API behavior changes.
- Current dashboard runtime does not separate draft and published revisions.
- Current dashboard persistence stores a whole card payload, not pages/widgets/layouts.
- Existing dashboard detail/builder screens contain demo chart values and fallback widgets. Later phases must remove or isolate this behavior from the new DB-backed runtime.
- Widget type names differ:
  - Current: `kpi`, `bar`, `line`, `donut`, `table`
  - Redesign pack: `metric`, `bar_chart`, `line_chart`, `donut_chart`, `table`
- Adding react-grid-layout and a chart library should be delayed until their phases.
- Directly changing global dashboard CSS could affect the existing white list UI. Runtime CSS should stay isolated under `.asklake-dashboard-runtime`.
- There is no migration runner; schema changes need careful idempotent SQL.

## Design Direction Update

- User direction on 2026-07-04: dashboard viewer/editor UI must use a white-tone visual direction going forward.
- Do not continue the earlier dark-shell direction from the external phase pack.
- Keep the existing white dashboard list UI preserved, and make runtime/editor surfaces consistent with that lighter product UI.

## Recommended Phase 01 File Changes

Phase 01 should avoid DB/API changes and preserve the existing white list UI.

Recommended changes:

- `frontend/src/App.tsx`
  - Add minimal dashboard path parsing for `/dashboards/:dashboardId` and `/dashboards/:dashboardId/edit`.
  - Keep the sidebar dashboard navigation opening the existing list.
- `frontend/src/types/dashboard.ts`
  - Add narrow runtime entry/type fields if needed, such as selected dashboard id and runtime mode.
- `frontend/src/pages/dashboard/DashboardPage.tsx`
  - Route from list item status to runtime viewer/editor entry.
  - Keep existing builder/detail code untouched where possible.
- `frontend/src/pages/dashboard/components/DashboardTable.tsx`
  - Pass dashboard id/status to open handlers instead of only name.
  - Add row/title navigation behavior. If a delete action is added later, use `event.stopPropagation()`.
- New runtime components under one folder, for example:
  - `frontend/src/pages/dashboard/runtime/DashboardRuntimeShell.tsx`
  - `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx`
  - `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx`
  - `frontend/src/pages/dashboard/runtime/EmptyDashboardCanvas.tsx`
- New isolated style file:
  - `frontend/src/styles/dashboard-runtime.css`
  - Import from `frontend/src/styles.css`.

No new npm package is required for Phase 01.

## Next Phase Inputs

- List page path: `frontend/src/pages/dashboard/DashboardLandingPage.tsx`.
- List table path: `frontend/src/pages/dashboard/components/DashboardTable.tsx`.
- Published page route target: `/dashboards/:dashboardId`.
- Draft edit route target: `/dashboards/:dashboardId/edit`.
- API style: fetch wrapper in `frontend/src/services/apiClient.ts`, dashboard adapter in `frontend/src/services/dashboardApi.ts`, Node API in `frontend/server/index.js`.
- DB style: Postgres JSONB tables created by idempotent SQL in `frontend/server/db.js`.
- Package manager: npm.
