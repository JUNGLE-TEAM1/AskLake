# AskLake Frontend

AskLake frontend is a React/Vite app for the data lake workflow. By default it uses the same-origin live backend API. Set `VITE_USE_MOCK_API=true` only for frontend-only, non-AI compatibility QA; AI clients always call the live backend.

In local dev, `/api` is proxied to the FastAPI backend at `http://127.0.0.1:8080`; set `VITE_API_BASE_URL` only when you need to point at a different backend.

## Run

```bash
cd frontend
npm ci
npm run dev
```

브라우저에서 `http://127.0.0.1:5174`를 연다. 기본 개발 proxy는 `/api` 요청을 `http://127.0.0.1:8080`의 FastAPI로 전달한다.

FastAPI가 기본 주소에서 실행되지 않는다면 `VITE_DEV_PROXY_TARGET`에 backend origin을 지정한다.

```bash
VITE_DEV_PROXY_TARGET=http://127.0.0.1:18080 npm run dev
```

Frontend-only mock QA는 다음처럼 명시적으로 opt-in한다. 이 모드는 AI 결과를 mock하지 않으며 production build에서는 사용할 수 없다.

```bash
VITE_USE_MOCK_API=true npm run dev
```

Semantic Model 관리 화면은 `/catalog?view=semantic`에서 Catalog dataset 목록과 schema context를 재사용한다. 제거된 RAG Dataset API와 UI는 제공하지 않는다.

## Build

```bash
cd frontend
npm run build
```

## Environment

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_DEV_PROXY_TARGET=http://127.0.0.1:8080
VITE_USE_MOCK_API=true # frontend-only mock QA only
```

`VITE_API_BASE_URL` is optional in every build and defaults to same-origin. `VITE_DASHBOARD_ASSISTANT_API_PATH` also defaults to `/api/dashboards/assistant`, including when its Docker build arg is empty. Restart the dev server after changing environment variables.

## Main Files

```text
frontend/src/
  state/
    asklake/               # live API state, mutations, route hydration
  hooks/
    useAskLakeData.ts      # compatibility facade over state/asklake
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
