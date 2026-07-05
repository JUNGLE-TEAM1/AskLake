# AskLake Frontend

AskLake frontend is a React/Vite app for the data lake workflow. It expects a backend at `VITE_API_BASE_URL`; source tests, schema inference, pipeline creation, job commands, and SQL runs all go through backend endpoints.

## Run

```powershell
cd frontend
npm install
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

Vite prints the local URL after startup.

## Build

```powershell
cd frontend
npm run build
```

## Environment

```powershell
VITE_API_BASE_URL=http://localhost:8080
```

Restart the dev server after changing environment variables.

## Main Files

```text
frontend/src/
  hooks/
    useAskLakeData.ts      # jobs, datasets, draft, SQL result state
    useAuditLogs.ts        # audit log, toast, recent API panel state
  services/
    apiClient.ts           # backend fetch client
    pipelineApi.ts         # create, command, SQL adapters
    sourceConnectorService.ts # source test adapter
  data/
    appShellData.ts        # navigation and static shell data
  types/
    audit.ts
    catalog.ts
    dashboard.ts
    etl.ts
    navigation.ts
    sql.ts
  pages/
    etl/
    ingest/
    catalog/
    sql/
    dashboard/
```

## Connected Flow

1. Open the ETL creation flow.
2. Choose a real source connector such as File / S3, PostgreSQL, MongoDB, REST API, Data Lake, or Stream / Kafka.
3. Run connection test to fetch a bounded backend sample.
4. Review and edit inferred schema fields.
5. Continue through Review and create the pipeline.
6. The backend returns `{ job, dataset }`; the UI prepends them to ETL and Catalog state.

Initial ETL and Catalog lists come from backend hydrate endpoints and start empty.
