# 03. API Reference

Base URL is configured by `VITE_API_BASE_URL`, usually `http://localhost:8080`.

All request and response bodies are JSON unless a source system returns a sampled payload internally to the backend connector.

## 1. Implemented Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend health check |
| `GET` | `/api/etl/jobs` | Hydrate ETL jobs; starts as `[]` |
| `GET` | `/api/catalog/datasets` | Hydrate catalog datasets; starts as `[]` |
| `GET` | `/api/harness/rest-sample` | Local REST fixture endpoint |
| `POST` | `/api/etl/sources/test` | Test source connector and return bounded sample/schema draft patch |
| `POST` | `/api/etl/schema-inference` | Return schema portion from source profiling |
| `POST` | `/api/etl/jobs` | Create pipeline and return `{ job, dataset }` |
| `POST` | `/api/etl/jobs/{jobId}/commands` | Run, retry, pause, or cancel a job |
| `POST` | `/api/query/runs` | Return read result for a selected dataset |

## 2. Source Test Request

```ts
type SourceTestRequest = {
  sourceType: "File / S3" | "REST API" | "PostgreSQL" | "MongoDB" | "Data Lake" | "Stream / Kafka";
  sourceConfig: Array<[string, string]>;
};
```

Response:

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

## 3. Create Pipeline Contract

Submit uses `frontend/src/services/draftPipelineContract.ts` to convert nested `DraftPipeline` into flat `CreatePipelineRequest`.

Required person-1 fields:

- `sourceType`
- `sourceLabel`
- `sourceConfig`
- `schemaColumns`
- `schemaSampleRows`
- `schemaFingerprint`
- `schemaSummary`

Response:

```ts
type CreateJobResponse = {
  job: JobRowData;
  dataset: CatalogDataset;
};
```

After success the frontend prepends `job` and `dataset` and updates `selectedJob` and `selectedDataset`.

## 4. Job Command Contract

```ts
type JobCommandRequest = {
  command: "run" | "retry" | "pause" | "cancel";
};
```

Response includes:

- `action`
- `apiPath`
- updated `job`
- `run`
- `dagSteps`

Pair A person-2 owns full run/history/DAG behavior.

## 5. Error Envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "field is required"
  }
}
```

Frontend should show the message to the user and preserve the previous stable state when a write fails.
