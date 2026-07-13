# AskLake

AskLake is a trusted data lake workflow project. This branch includes the Pair A person-1 vertical slice: Source connection, Schema inference, and Create pipeline handoff through a local backend.

## Structure

```text
backend/    # FastAPI backend plus source/Spark launcher and validation helpers
frontend/   # React/Vite frontend
docs/       # Product, architecture, API, validation, and team guardrails
```

## Quick Start

```powershell
docker compose up -d postgres

cd backend
npm install
npm run verify
npm run sources:fixtures
$env:ASKLAKE_SOURCE_REST_PORT = "19080"
npm run sources:rest-fixture
npm run dev
```

In another terminal:

```powershell
cd frontend
npm install
$env:VITE_API_BASE_URL = "http://localhost:8080"
npm run dev
```

For frontend-only mock mode, set `VITE_USE_MOCK_API` to `"true"`. In live mode, initial ETL jobs and catalog datasets may start empty. Creating a pipeline adds the Job. In Phase 3, Airflow's final task publishes a verified Spark result to Catalog, and the frontend refreshes Catalog after observing that Run's terminal success.
The local backend stores ETL jobs, catalog datasets, and SQL run snapshots in the Postgres JSONB metadata tables from `docker-compose.yml`. Override `DATABASE_URL` only when using a different metadata database.

## Validation

```powershell
cd backend
$env:ASKLAKE_WITH_KAFKA = "true"
$env:ASKLAKE_RECREATE_KAFKA = "true"
npm run sources:fixtures
npm run kafka:reviews-fixture:generate -- --count 100
npm run kafka:reviews-fixture
npm run kafka:reviews-replay -- --dry-run --limit 100
$env:ASKLAKE_VERIFY_KAFKA = "true"
npm run verify:sources
npm run minio:prepare-samples
npm run spark:start
npm run spark:validate
```

For the MinIO 100GB and 1GB-per-type Spark validation flow, see [docs/minio-100gb-spark-harness.md](docs/minio-100gb-spark-harness.md).
For Kafka/Spark load, fault, latency, and EMR billed-cost evidence, see [docs/kafka-spark-phase7-validation.md](docs/kafka-spark-phase7-validation.md).
For source connector setup and per-source input values, see [docs/source-connector-test-guide.md](docs/source-connector-test-guide.md).

## Docs

- [Codex work rules](AGENTS.md)
- [Product planning](docs/01-product-planning.md)
- [Architecture](docs/02-architecture.md)
- [API reference](docs/03-api-reference.md)
- [Development guide](docs/04-development-guide.md)
- [System guardrails](docs/system-guardrails.md)
- [Backend status](docs/backend-integration-readiness.md)
