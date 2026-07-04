# AskLake Backend API Contract

This document defines the local backend contract used by the Pair A person-1 Source, Schema, and Create slice.

## 1. Environment

Frontend:

```powershell
VITE_API_BASE_URL=http://localhost:8080
```

Backend:

```powershell
PORT=8080
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=m3admin
MINIO_SECRET_KEY=wishuponastar
MINIO_BUCKET=m3-raw
```

## 2. Common Rules

- JSON request body.
- JSON response body.
- ISO 8601 timestamps.
- String IDs are opaque to the frontend.
- Errors use `{ error: { code, message } }`.
- Source connector requests are performed by the backend.

## 3. Error Envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "sourceType is required"
  }
}
```

Recommended status codes:

| Status | Use |
| --- | --- |
| `200` | Successful read or command |
| `201` | Successful create |
| `400` | Invalid request |
| `404` | Resource not found |
| `409` | Conflicting state |
| `500` | Unexpected backend error |

## 4. Draft Contract

Frontend keeps a nested `DraftPipeline` so each Pair A slice owns its own fields.

```ts
type DraftPipeline = {
  id: string;
  source: SourceDraft;
  schema: SchemaDraft;
  transform: TransformDraft;
  quality: QualityDraft;
  schedule: ScheduleDraft;
  permission: PermissionDraft;
  target: TargetDraft;
};
```

Submit maps this draft to a flat `CreatePipelineRequest`:

```ts
type CreatePipelineRequest = {
  id: string;
  jobName: string;
  schemaColumns: SchemaColumnDraft[];
  schemaFingerprint?: string;
  schemaSampleRows: string[][];
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  retryPolicy: {
    maxRetries: number;
    retryIntervalMinutes: number;
    timeoutMinutes: number;
    failureAction: "retry_then_fail" | "retry_then_quarantine" | "notify_only";
  };
  retryPolicySummary: string;
  permissionSummary: string;
  targetDataset: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};
```

Mapper rules:

- `schemaColumns`, `schemaSampleRows`, and `schemaFingerprint` come from `draft.schema`.
- `sourceConfig`, `sourceType`, and `sourceLabel` come from `draft.source`.
- `ruleSummary` joins transform and quality summaries when both exist.
- Review Summary and submit payload must derive from the same mapped request.

## 5. Source Test

`POST /api/etl/sources/test`

Request:

```json
{
  "sourceType": "MongoDB",
  "sourceConfig": [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", "27018"],
    ["Database Name", "asklake_sources"],
    ["Dataset or Table Selector", "app_events"]
  ]
}
```

Response shape:

```ts
type SourceTestResponse = {
  status: "success" | "error";
  title: string;
  description: string;
  nextAction: string;
  assets: string[];
  preview: string;
  logs: string[];
  draftPatch: {
    source?: Partial<SourceDraft>;
    schema?: Partial<SchemaDraft>;
  };
};
```

## 6. Schema Inference

`POST /api/etl/schema-inference`

Uses the same request as source test and returns `SourceTestResponse["draftPatch"]["schema"]`.

## 7. Create Pipeline

`POST /api/etl/jobs`

Response:

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

Frontend behavior:

- Prepend `job` to ETL state.
- Prepend `dataset` to Catalog state.
- Set `selectedJob` to `job`.
- Set `selectedDataset` to `dataset`.
- Preserve previous stable state if the request fails.

## 8. Hydrate Lists

`GET /api/etl/jobs`

Returns:

```ts
JobRowData[]
```

`GET /api/catalog/datasets`

Returns:

```ts
CatalogDataset[]
```

Both endpoints return empty arrays before the first create.

## 9. Job Command

`POST /api/etl/jobs/{jobId}/commands`

Request:

```ts
type JobCommandRequest = {
  command: "run" | "retry" | "pause" | "cancel";
};
```

Response:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job: JobRowData;
  run: unknown;
  dagSteps: unknown[];
};
```

Full run store, history rows, DAG updates, and command hardening belong to Pair A person-2.

## 10. Query Run

`POST /api/query/runs`

Request:

```ts
type ExecuteQueryRequest = {
  datasetId: string;
  query: string;
};
```

Response:

```ts
type ExecuteQueryResponse = {
  runId: string;
  datasetId: string;
  datasetName: string;
  query: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  executedAt: string;
};
```

The current local backend returns rows from the selected in-memory dataset. A production SQL engine is a later integration.
