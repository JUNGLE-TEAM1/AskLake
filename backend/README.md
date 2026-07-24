# AskLake Backend

이 폴더는 기본 FastAPI application과 PostgreSQL 기반 metadata 경계, Node 기반 compatibility adapter·검증 script를 함께 둔다. 기본 runtime entry는 `app.main:app`이며 `src/server.mjs`는 현재 public backend가 아니다.

## FastAPI 실행

로컬은 Python 3.10 이상을 사용하고 CI는 3.12·3.13을 검증한다. Production Docker image는 `python:3.13-slim`과 `backend/requirements.txt`를 기준으로 빌드한다.

```bash
cd backend
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm run dev
```

환경 변수는 `.env.example`을 참고한다. Backend는 OpenAI에 직접 연결하지 않고
`AI_GATEWAY_BASE_URL`과 `AI_GATEWAY_SERVICE_TOKEN`으로 private AI Gateway만
호출한다. Provider API key는 Backend가 아니라 AI Gateway의 비공개 환경 변수로만
주입하며 git에는 올리지 않는다.

## Smoke Check

```bash
curl http://localhost:8080/api/health
```

Pair2 Catalog / Lineage / SQL FastAPI smoke:

```bash
docker compose up -d postgres

cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:fastapi-pair2
```

이 검증은 PostgreSQL이 `localhost:54328`에서 실행 중이어야 한다. `app.seed.seed_pair2_demo`로 commerce demo dataset(`orders_clean`, `customers_clean`, `order_items_clean`, `products_clean`, `payments_clean`)을 넣고, 별도 포트의 FastAPI 서버를 띄운 뒤 아래 흐름을 확인한다.
대시보드 사이드바와 Assistant demo dataset은 `.venv/bin/python -m app.seed.seed_dashboard_demo`로 `catalog_datasets`에 넣을 수 있다.

- `GET /api/catalog/datasets`
- `GET /api/catalog/datasets/{datasetId}`
- `GET /api/catalog/datasets/{datasetId}/lineage`
- `POST /api/query/runs`
- `POST /api/query/ai-suggestions`
- `POST /api/catalog/derived-datasets`
- 생성된 derived dataset의 catalog 재조회와 lineage 조회

`POST /api/query/runs`는 `TRINO_ENABLED=true`일 때 idempotent reservation 뒤 Trino full Query Run을 제출한다. `false`일 때만 DuckDB in-memory compatibility runtime을 사용하며, Catalog dataset의 물리 `storageLocation`을 읽어 bounded SQL을 실행한다. 물리 저장소가 없거나 읽기에 실패하면 `SQL_STORAGE_ERROR`로 종료하며 catalog `sampleRows`는 SQL 실행 데이터로 사용하지 않는다.

Issue #488은 Trino 482 coordinator, Iceberg JDBC catalog, MinIO S3 warehouse와 canonical Query Run service를 제공한다. Query Run과 Iceberg CTAS continuation은 `trino-result-collector`가 browser와 독립적으로 처리하고, result는 private MinIO page와 signed cursor로 조회한다. Query Run의 live telemetry는 collector가 `TRINO_PROGRESS_POLL_SECONDS` 간격으로 읽기 전용 QueryInfo를 샘플링해 progress/driver, elapsed/queued/CPU time, processed bytes/rows, peak memory를 보강하며 실패 시 기존 statement stats로 fallback한다. QueryInfo와 statement page 누적값은 같은 단조 증가 규칙으로 병합해 stale sample로 감소하지 않는다. Query 완료, 결과 수집 시작, 첫 page, 전체 준비 milestone은 UTC 최초 관측값으로 저장해 collector retry/restart/takeover에서 보존한다. SQL 결과 Dataset은 CTAS 뒤 `DESCRIBE` 검증을 통과해야 `queryEngineStatus=available`과 `queryEngineTable` mapping이 자동 저장된다. Spark Parquet/Kafka JSONL처럼 아직 Iceberg table을 만들지 않는 writer는 `unavailable`로 남는다. 기본값은 전환 호환을 위해 `false`다.

Trino client protocol/compiler unit verification:

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-foundation
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:query-engine-registration
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-collector-resilience
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-submission-guard
```

반복 SQL Job의 versioned Iceberg CTAS, 한글 표시명, Catalog mapping 교체, 실패 시 마지막 정상 mapping 보존은 `postgres`, `minio`, `trino`를 올린 뒤 `npm run verify:trino-sql-job-e2e`로 확인한다. 필요한 local MinIO/Trino 환경변수는 `docs/04-development-guide.md`에 정리되어 있다.

Production 환경의 TLS/ACL/materializer/result bucket은 `npm run verify:trino-production-readiness`로 확인한다. `scripts/deploy.sh`는 Trino가 enabled일 때 같은 검증을 자동 실행한다.

Node compatibility API 전체 검증은 MinIO 샘플 fixture가 필요하다. 현재 public FastAPI 전체 gate로 해석하지 않는다.

```bash
docker compose up -d minio postgres

cd backend
npm ci
npm run minio:seed-verify
npm run verify
```

이 검증은 MinIO가 `localhost:9000`에서 실행 중이고 `m3-raw/nyc_taxi/csv/` 아래 CSV 샘플 객체가 있어야 한다.

이미 켜진 서버를 대상으로만 확인하려면 아래처럼 실행한다.

```bash
ASKLAKE_FASTAPI_SMOKE_START_SERVER=false \
ASKLAKE_FASTAPI_SMOKE_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python \
npm run verify:fastapi-pair2
```

## 설계 결정

현재 backend 구조, 상태 소유권과 API 계약은 `../docs/02-architecture.md`, `../docs/03-api-reference.md`, `../docs/api-contract.md`를 기준으로 한다. `../docs/backend-fastapi-transition-plan.md`는 초기 전환 기록이다.
