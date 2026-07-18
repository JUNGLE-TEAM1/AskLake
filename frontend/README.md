# AskLake Frontend

AskLake frontend is a React/Vite app for the data lake workflow. By default it uses the live backend API. Set `VITE_USE_MOCK_API=true` only for frontend-only mock QA.

In local dev, `/api` is proxied to the FastAPI backend at `http://127.0.0.1:8080`; set `VITE_API_BASE_URL` only when you need to point at a different backend.

## Run

```powershell
cd frontend
npm install
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

Vite prints the local URL after startup.

For frontend-only mock mode, set `VITE_USE_MOCK_API` to `"true"`.

The Semantic/RAG workspace is available at `/catalog?view=semantic`. It uses the live Semantic Model and RAG endpoints while reusing the Catalog dataset list for selection and schema context.

## Build

```powershell
cd frontend
npm run build
```

## Environment

```powershell
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=true # frontend-only mock QA only
```

`VITE_API_BASE_URL`을 지정하지 않은 production build는 동일 browser origin을 사용한다. EKS에서는 ALB가 `/`와 `/api`를 각각 Frontend와 FastAPI로 routing하므로 public hostname을 Frontend image에 고정하지 않는다.

`VITE_API_BASE_URL` is optional in local dev. `VITE_DASHBOARD_ASSISTANT_API_PATH` also defaults to `/api/dashboards/assistant`, so no frontend env is required when using the local backend. Restart the dev server after changing environment variables.

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
6. The backend returns `{ job, catalogTarget }`; the UI prepends the job to ETL state.
7. Run the job. After Spark succeeds, the command response returns `dataset` and the UI prepends it to Catalog state.

In live mode, initial ETL and Catalog lists come from backend hydrate endpoints and may start empty. In mock mode, the UI uses frontend fixtures and local fallback storage.
