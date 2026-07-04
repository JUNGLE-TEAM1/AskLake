# 01. Product Planning

AskLake is a trusted data lake workflow for source onboarding, schema review, catalog creation, SQL analysis, dashboarding, and future AI usage.

## 1. Current Product Slice

The active Day 1 Pair A person-1 scope is:

- Source connection
- Connection test state
- Schema inference
- Schema preview and editable field mapping
- Sample rows
- Source and schema summary in Review
- Source and schema fields in create request
- Create Job submit
- `{ job, dataset }` response mapping
- `jobs`, `datasets`, `selectedJob`, `selectedDataset` update

Initial ETL jobs and catalog datasets must be empty. MinIO 100GB data is validation input, not preloaded application data.

## 2. User Flow

1. User opens the ETL creation flow.
2. User selects a source connector.
3. User runs connection test.
4. Backend fetches a bounded source sample and infers schema.
5. User reviews, edits, excludes, or renames fields.
6. User continues through Review Summary.
7. User creates the pipeline.
8. Backend returns `{ job, dataset }`.
9. UI prepends the job to ETL and the dataset to Catalog.

## 3. Supported Source Direction

Current backend source support:

| Source | Current behavior |
| --- | --- |
| File / S3 | Reads bounded sample from MinIO/S3-compatible object storage |
| REST API | Fetches backend-side HTTP response and profiles JSON/CSV/text payloads |
| PostgreSQL | Connects to PostgreSQL and samples the selected table |
| MongoDB | Connects to MongoDB and samples the selected collection |
| Data Lake | Lists object data and validates physical formats through Spark harness |
| Stream / Kafka | Verifies topic metadata; payload sampling is a follow-up |

## 4. Non-Goals For This Slice

- Durable production metadata storage
- Production scheduler
- Full transform/run ownership for Pair A person-2
- Production authentication and authorization
- Full Kafka payload schema inference
- Full Data Lake catalog persistence
- RAG ingestion runtime

## 5. Success Criteria

- Frontend build passes.
- Backend verification passes.
- Source fixtures for PostgreSQL, MongoDB, and Kafka can be started locally.
- Source connector verification passes for File/S3, REST, PostgreSQL, MongoDB, Data Lake, and Stream/Kafka.
- MinIO 1GB-per-type sample preparation works where source data is available.
- Spark standalone validation reads CSV, JSONL, JSON, TXT, and Parquet samples and validates transform type casting.
- No frontend source path bypasses the backend.
