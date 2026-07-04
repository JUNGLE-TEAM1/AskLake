# 04. Development Guide

## 1. Backend

```powershell
cd backend
npm install
npm run verify
npm run dev
```

The backend listens on `http://localhost:8080` by default.

## 2. Frontend

```powershell
cd frontend
npm install
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

## 3. Build

```powershell
cd frontend
npm run build
```

## 4. Source Fixtures

```powershell
cd backend
npm run sources:fixtures
```

With Kafka:

```powershell
cd backend
$env:ASKLAKE_WITH_KAFKA = "true"
$env:ASKLAKE_RECREATE_KAFKA = "true"
npm run sources:fixtures
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources
```

## 5. MinIO And Spark

```powershell
cd backend
npm run minio:prepare-samples
npm run spark:start
npm run spark:validate
```

`minio:prepare-samples` creates local 1GB-style samples under the OS temp directory. Spark validates CSV, JSONL, JSON, TXT, Parquet, and transform type casts.

## 6. Branch And PR Rules

- Do not push directly to `main`.
- Use one branch per clear feature or vertical slice.
- Link the relevant issue in the PR body.
- Include verification commands and known limitations.
- Update docs when API behavior, commands, or source support changes.

## 7. PR Checklist

- [ ] Backend verification passed or failure is explained.
- [ ] Frontend build passed or failure is explained.
- [ ] Source connector changes updated `docs/03-api-reference.md`.
- [ ] Backend/source validation changes updated `docs/backend-integration-readiness.md`.
- [ ] Spark/MinIO changes updated `docs/minio-100gb-spark-harness.md`.
- [ ] UI changes were checked in a browser.

## 8. Manual Smoke Checklist

- ETL list loads empty from backend.
- Catalog list loads empty from backend.
- New ETL creation opens in Korean.
- Source selector shows File/S3, PostgreSQL, MongoDB, REST API, Data Lake, and Stream/Kafka.
- Connection test calls backend and produces schema/sample data.
- Schema screen allows rename, type edit, null toggle, role edit, and exclude.
- Review contains Source and Schema summary.
- Create returns `{ job, dataset }` and updates ETL/Catalog state.
