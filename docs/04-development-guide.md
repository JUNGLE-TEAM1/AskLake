# 04. Development Guide

> **문서 상태 — Canonical / 현재 개발·검증 기준**
>
> 이 문서는 AskLake를 처음 실행하고, 변경 영역에 맞는 대표 검증을 선택하기 위한 진입점이다. 상세 API 계약, 대용량 하네스, 배포·복구 절차와 특정 시점의 검증 증거는 전문 문서에서 관리한다.

AskLake의 기본 애플리케이션은 React/Vite Frontend와 FastAPI Backend이며, 사용자-facing metadata는 PostgreSQL에 저장한다. 유한 배치 ETL은 Airflow·Spark, SQL Query Run은 Trino가 담당한다. Node ESM server는 호환·검증 경로이며 기본 Backend가 아니다.

## 1. 빠른 길잡이

### 1.1 목적별 진입점

| 목적 | 먼저 볼 절 | 상세 문서 |
| --- | --- | --- |
| 처음 실행 | [10분 빠른 시작](#3-10분-빠른-시작) | [Frontend README](../frontend/README.md), [Backend README](../backend/README.md) |
| Frontend만 확인 | [Frontend mock profile](#32-frontend-mock-profile) | [Frontend README](../frontend/README.md) |
| Trino·Airflow·Spark 연동 | [로컬 실행 profile](#4-로컬-실행-profile) | [Backend 준비 상태](backend-integration-readiness.md), [MinIO·Spark 하네스](minio-100gb-spark-harness.md) |
| 변경 후 검증 선택 | [변경 영역별 검증 지도](#6-변경-영역별-검증-지도) | [문서 포털](README.md#개발검증) |
| API 변경 | [API·DB](#63-apidbpermission) | [API Reference](03-api-reference.md), [API Contract](api-contract.md) |
| EKS·EC2 운영 | [배포·운영 안전 경계](#8-배포운영-안전-경계) | [Architecture](02-architecture.md), [Deployment Runbook](deployment-runbook.md) |
| Realtime·Continuous | [Kafka·Continuous](#45-kafkacontinuous-profile) | [Kafka Continuous 계약](kafka-continuous-ingestion-contract.md), [Realtime Runbook](realtime-2026/production-runbook.md) |

### 1.2 현재 기준

- 기본 Backend entrypoint는 `backend/app/main.py`의 FastAPI다.
- Frontend는 기본적으로 same-origin `/api`를 사용하며, Vite가 로컬 요청을 FastAPI `127.0.0.1:8080`으로 proxy한다.
- 새 Job과 Catalog Dataset이 없는 빈 상태는 정상이다. Catalog Dataset은 검증된 Job 실행 결과가 발행된 뒤 생성된다.
- RAG/OpenSearch/embedding worker는 현재 제품과 runtime에서 제거됐다. 과거 RAG 명령을 실행하지 않는다.
- 현재 Production control-plane은 EKS web·finite-batch cell과 EKS Realtime V1 worker가 소유한다. EC2 Compose Continuous worker는 비활성 rollback standby다.

현재 제품 범위는 [Product Planning](01-product-planning.md), 상태 소유권과 topology는 [Architecture](02-architecture.md)를 우선한다.

## 2. 사전 요구사항

### 2.1 도구

| 도구 | 기준 |
| --- | --- |
| Node.js | 저장소 기준 `22.23.1` (`.nvmrc`, `.node-version`). Frontend Docker build와 주요 CI도 Node 22를 사용한다. |
| Python | 로컬은 3.10 이상. CI는 3.12·3.13, Production Backend image는 Python 3.13을 사용한다. |
| Docker | Docker Engine 또는 Docker Desktop과 Compose v2 |
| 기타 | Git, `curl` |
| EKS 검증 전용 | Helm 3. 일반 로컬 실행에는 필요하지 않다. |

명령은 POSIX shell 기준이다. Windows에서는 virtual environment 활성화 명령만 현재 shell에 맞게 바꾼다.

### 2.2 기본 로컬 port

| 구성 요소 | 주소·port | 비고 |
| --- | --- | --- |
| Frontend Vite | `http://127.0.0.1:5174` | 기본 개발 서버 |
| FastAPI | `http://127.0.0.1:8080` | API base path는 `/api` |
| PostgreSQL | `localhost:54328` | container 내부는 `5432` |
| Airflow | `http://127.0.0.1:8081` | container 내부는 `8080` |
| Trino | `http://127.0.0.1:8088` | local coordinator |
| MinIO API | `http://127.0.0.1:9000` | Console은 `9001` |
| Redpanda Kafka | `localhost:19092` | container 내부는 `9092` |
| ClickHouse | `http://127.0.0.1:8123` | EC2 compatibility profile 관련 로컬 검증 |

`5173`은 `deploy/docker-compose.local-e2e.yml`의 local E2E Frontend port다. 일반 `npm run dev`의 Vite port `5174`와 혼동하지 않는다.

## 3. 10분 빠른 시작

### 3.1 FastAPI + PostgreSQL + Frontend

새 checkout에서는 Backend와 Frontend dependency를 각각 설치한다.

```bash
cd backend
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

cd ../frontend
npm ci
```

저장소 root에서 PostgreSQL을 시작한다.

```bash
docker compose up -d postgres
```

로컬 HTTP에서 session cookie를 사용할 수 있도록 gitignored `backend/.env.local`에 최소 설정을 둔다.

```dotenv
APP_ENV=local
DATABASE_URL=postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake
AUTH_SESSION_COOKIE_SECURE=false
```

`AUTH_SESSION_COOKIE_SECURE=false`는 로컬 HTTP 전용이다. HTTPS 배포나 Production 설정으로 복사하지 않는다. 로컬에서는 회원가입을 사용할 수 있다. 고정 관리자 계정이 필요하면 `BOOTSTRAP_ADMIN_EMAIL`과 16자 이상의 로컬 전용 `BOOTSTRAP_ADMIN_PASSWORD`를 함께 설정하며 실제 비밀번호를 문서나 Git에 기록하지 않는다.

첫 번째 terminal에서 Backend를 실행한다.

```bash
cd backend
source .venv/bin/activate
npm run dev
```

두 번째 terminal에서 Frontend를 실행한다.

```bash
cd frontend
npm run dev
```

준비 상태와 화면을 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/api/health/ready
```

브라우저에서 `http://127.0.0.1:5174`를 연다. Frontend의 `/api` 요청은 별도 설정 없이 FastAPI로 전달된다. Backend port를 바꾼 경우에만 다음처럼 proxy target을 지정한다.

```bash
VITE_DEV_PROXY_TARGET=http://127.0.0.1:18080 npm run dev
```

종료할 때 Frontend와 Backend는 각 terminal에서 `Ctrl+C`로 멈추고 PostgreSQL은 root에서 중지한다.

```bash
docker compose stop postgres
```

로컬 기본값 `STARTUP_SCHEMA_MANAGEMENT_ENABLED=true`는 개발 편의를 위한 schema bootstrap을 허용한다. migration 자체를 변경하는 작업은 bootstrap과 Alembic을 명시적으로 검증한다.

```bash
cd backend
npm run migrate:metadata-schema
.venv/bin/alembic upgrade head
```

Production EKS에서는 API와 collector가 schema DDL을 실행하지 않는다. `STARTUP_SCHEMA_MANAGEMENT_ENABLED=false`를 유지하고 Helm migration Job이 metadata bootstrap과 Alembic을 담당한다.

### 3.2 Frontend mock profile

Backend 없이 UI 상태와 화면 흐름만 확인할 때 사용한다.

```bash
cd frontend
npm ci
VITE_USE_MOCK_API=true npm run dev
```

- 개발 환경에서만 사용할 수 있다.
- AI 응답은 mock으로 만들지 않으며 live AI 기능은 실패를 명시한다.
- mock 또는 Frontend fixture를 durable state나 Backend 성공 증거로 사용하지 않는다.
- Source·실제 ETL·Catalog 발행을 검증할 때는 live profile로 돌아간다.

### 3.3 선택적 demo seed

Live profile의 Job·Catalog가 비어 있는 것은 정상이다. 화면 연결을 확인할 로컬 fixture가 필요할 때만 seed를 실행한다.

```bash
cd backend
source .venv/bin/activate
python -m app.seed.seed_pair2_demo
python -m app.seed.seed_dashboard_demo
```

Seed는 로컬 개발 편의용이다. 실제 Source → Spark → Catalog 처리 증거를 대신하지 않는다.

## 4. 로컬 실행 profile

```mermaid
flowchart LR
  Browser["Browser :5174"] --> Frontend["Vite Frontend"]
  Frontend --> API["FastAPI :8080"]
  API --> DB[("PostgreSQL :54328")]
  API -. "통합 profile" .-> Airflow["Airflow :8081"]
  Airflow -.-> Spark["Spark"]
  API -. "SQL profile" .-> Trino["Trino :8088"]
  Spark --> Storage[("MinIO :9000")]
  Trino --> Storage
  API -. "Continuous profile" .-> Kafka["Redpanda :19092"]
```

### 4.1 기본 API profile

[10분 빠른 시작](#3-10분-빠른-시작)의 PostgreSQL, FastAPI, Frontend만 실행한다. 일반 UI·API 작업의 기본 profile이다.

기본 `DATABASE_URL`은 다음과 같다.

```text
postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake
```

`postgres://` scheme이나 다른 port를 기본값으로 문서화하지 않는다.

### 4.2 Trino Query Runtime profile

Trino Query Run과 result collector를 함께 확인할 때 사용한다. Backend dependency와 Python virtual environment를 먼저 준비한다.

```bash
cd backend
npm run dev:query-runtime
```

이 명령은 로컬 PostgreSQL·MinIO·Trino storage/catalog bootstrap을 준비하고 FastAPI와 Trino result collector를 같은 환경으로 실행한다. Backend와 collector 중 하나가 종료되면 나머지도 함께 종료한다.

인프라만 준비하거나 현재 연결만 점검할 수 있다.

```bash
bash scripts/start-local-query-runtime.sh --prepare-only
bash scripts/start-local-query-runtime.sh --check
```

스크립트는 root의 `scripts/`에 있으므로 위 두 명령은 저장소 root에서 실행한다. 상태 전이, private result page와 cursor 계약은 [Trino Query Run Contract](trino-query-run-contract.md)와 [Trino Result Storage Contract](trino-query-result-storage-contract.md)를 따른다.

### 4.3 Airflow + Spark batch profile

유한 배치의 orchestration과 물리 처리까지 확인할 때 사용한다.

```bash
docker compose -p asklake up airflow-init
docker compose -p asklake up -d \
  postgres minio \
  airflow-apiserver airflow-scheduler airflow-dag-processor
```

Local Airflow는 `127.0.0.1:8081`에서 열리고 기본 로컬 계정은 `airflow` / `airflow`다. FastAPI에는 다음 목적의 값을 같은 process environment 또는 `backend/.env.local`로 전달한다.

| 환경변수 | 로컬 목적 |
| --- | --- |
| `AIRFLOW_API_BASE_URL=http://127.0.0.1:8081` | FastAPI가 Airflow API 호출 |
| `AIRFLOW_DAG_ID=asklake_etl_job` | canonical ETL DAG |
| `AIRFLOW_EXECUTION_API_TOKEN=asklake-local-airflow-execution` | Airflow task와 FastAPI 내부 실행 token 일치 |
| `AIRFLOW_INTERNAL_TOKEN=asklake-local-airflow-token` | 기존 내부 호출 호환 |
| `MINIO_ENDPOINT=http://127.0.0.1:9000` | host process의 object storage 접근 |
| `MINIO_ENDPOINT_IN_DOCKER=http://m3-minio:9000` | Spark container의 object storage 접근 |
| `ASKLAKE_SPARK_OUTPUT_MODE=s3a` | local MinIO target |
| `ASKLAKE_DOCKER_NETWORK=asklake_default` | 위 `-p asklake` Compose project network |

두 token 값은 root Compose의 local-only 기본값이다. 같은 값을 `backend/.env.local`에 넣거나 Backend process environment로 전달한다. Compose project 이름을 바꾸면 `ASKLAKE_DOCKER_NETWORK`도 실제 `<compose-project>_default`에 맞춘다. 로컬 token을 Production으로 복사하거나 Git·로그에 기록하지 않는다.

Airflow 자체의 최소 smoke는 다음과 같다.

```bash
cd backend
AIRFLOW_API_BASE_URL=http://127.0.0.1:8081 \
AIRFLOW_DAG_ID=asklake_etl_job \
AIRFLOW_USERNAME=airflow \
AIRFLOW_PASSWORD=airflow \
npm run verify:airflow-smoke
```

Spark 물리 결과, MinIO fixture와 Catalog 발행까지 검증할 때는 명령을 이 문서에 복제하지 않고 [MinIO·Spark Validation Harness](minio-100gb-spark-harness.md)를 따른다.

### 4.4 AI Gateway profile

AI 기능은 Frontend나 FastAPI가 provider를 직접 호출하지 않고 private AI Gateway를 사용한다.

- host에서 FastAPI와 AI Gateway를 각각 실행하면 `AI_GATEWAY_BASE_URL=http://127.0.0.1:8090`을 사용한다.
- Compose network 안에서는 `AI_GATEWAY_BASE_URL=http://ai-server:8090`을 사용한다.
- provider API key는 `ai-server`에만 둔다.
- FastAPI에는 Gateway service token과 MCP/signing secret만 둔다.
- Gateway가 없으면 가짜 SQL·차트·성공 결과를 만들지 않고 unavailable 상태를 확인한다.

현재 AI 계약은 [API Contract](api-contract.md)와 [Architecture](02-architecture.md#ai-gateway-mcp-evidence-경계)를 따른다. Historical인 AI Gateway rollout 계획을 현재 실행 가이드로 사용하지 않는다.

### 4.5 Kafka·Continuous profile

Kafka Source의 Snapshot과 Continuous는 서로 다른 실행 방식이다.

- Snapshot Job은 수동 또는 반복 schedule로 실행한다.
- Continuous Job은 schedule 단계를 건너뛰고 start·pause·resume·stop과 checkpoint로 제어한다.
- Continuous smoke가 Snapshot smoke를 대체하지 않는다.
- 신규 EKS Kafka Continuous runtime은 Spark Structured Streaming과 Iceberg publication 경계를 따른다.

로컬 broker가 필요한 검증은 Redpanda를 시작한다.

```bash
docker compose up -d postgres minio redpanda
```

대표 계약 검증은 다음과 같다.

```bash
cd backend
npm run verify:kafka-continuous-contract
npm run verify:continuous-sql-contract
```

실제 fixture, replay, checkpoint와 장애 복구는 [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md)와 [ETL E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md)를 따른다.

### 4.6 EC2 Compose compatibility profile

`deploy/docker-compose.prod.yml`은 현재 전체 Production topology가 아니라 EC2 Compose 호환·rollback lane이다. 시작 전에 우선 render만 확인한다.

```bash
docker compose \
  --env-file deploy/.env.example \
  -f deploy/docker-compose.prod.yml \
  config --quiet
```

실제 `start`, `deploy`, `restart`는 외부 상태를 변경한다. 승인된 owner transfer 없이 EC2 `continuous-worker`를 기동하지 않는다. 반복 운영 절차는 [EC2 Compose 호환 운영 Runbook](deployment-runbook.md)을 따른다.

## 5. 표준 개발 흐름

### 5.1 작업 시작

1. `AGENTS.md`와 필요한 기준 문서를 읽는다.
2. 최신 `dev`에서 작업 branch를 만든다.
3. `git status`로 기존 사용자 변경과 untracked 파일을 확인한다.
4. 제품 범위, Architecture 또는 API 계약 변경이 필요한지 먼저 판단한다.
5. 한 branch는 하나의 명확한 결과에 집중한다.

`main`과 `dev`에는 직접 push하지 않고 PR로 병합한다. 지원 branch 이름과 linked issue 정책은 [System Guardrails](system-guardrails.md)를 따른다.

`AGENTS.local.md`는 개인 환경의 workflow preference에만 사용할 수 있다. Git에 올리거나 shared policy, secret, token을 기록하지 않는다.

### 5.2 구현 순서

1. 기존 흐름과 문서 확인
2. 제품 범위와 사용자 flow 확인
3. Architecture와 interface contract 확인
4. Backend endpoint 또는 adapter 변경
5. Frontend loading·error·rollback 처리
6. fixture와 validation script
7. 회귀 검증
8. 관련 문서 동기화

Frontend fixture와 local fallback을 durable Backend 상태로 승격하지 않는다. 연결 가능한 Source로 표시한 connector는 실제 Backend 경로를 가져야 한다.

### 5.3 PR 전 최소 확인

- 변경 목적과 범위가 한 문장으로 설명되는가?
- API/interface 변경을 API Reference와 API Contract에 반영했는가?
- 상태 소유권·routing 변경을 Architecture에 반영했는가?
- 실행 명령·환경변수 변경을 이 문서에 반영했는가?
- 배포·CI·repository rule 변경을 System Guardrails에 반영했는가?
- 실행한 검증과 실행하지 못한 검증의 이유를 남겼는가?
- `git diff --check`가 통과하는가?

## 6. 변경 영역별 검증 지도

모든 명령을 매번 실행하지 않는다. 공통 gate에 변경 영역의 focused gate를 추가한다. 현재 실행 가능한 script 이름은 `backend/package.json`, `frontend/package.json`과 `.github/workflows/`가 기계적 기준이다.

Python test를 실행하는 Backend 작업은 runtime dependency 대신 test dependency를 준비한다.

```bash
cd backend
source .venv/bin/activate
python -m pip install -r requirements-test.txt
```

### 6.1 공통 gate

```bash
cd backend
npm run verify:backward-compatibility
npm run verify:control-plane-ownership

cd ../frontend
npm run verify:ui-regressions
npm run build

cd ..
node scripts/verify-docs.mjs
git diff --check
```

문서만 변경했다면 애플리케이션 전체 gate를 기계적으로 실행하지 않는다. 문서 링크·명령·계약과 직접 관련된 정적 검증을 선택한다.

### 6.2 Frontend

| 변경 영역 | 대표 gate |
| --- | --- |
| 공통 UI·route·API adapter | `npm run verify:ui-regressions`, `npm run build` |
| Dashboard data state | `npm run test:dashboard-widget-data-state` |
| Realtime UI | `npm run test:realtime-events` |
| SQL AI editor | `npm run test:sql-ai-editor-contract` |
| Continuous SQL UI | `npm run test:continuous-sql-ui` |
| Live AI 경계 | `npm run test:live-ai-api-boundary` |

위 명령은 `frontend/`에서 실행한다. 화면별 세부 계약은 [Frontend README](../frontend/README.md)와 관련 Contract를 확인한다.

### 6.3 API·DB·Permission

```bash
cd backend
npm run verify:backward-compatibility
npm run verify:fastapi-pair2
npm run verify:identity-admin
npm run verify:permission-dataset
npm run verify:permission-job-dashboard
```

`verify:fastapi-pair2`와 PostgreSQL 기반 smoke는 `docker compose up -d postgres` 이후 실행한다. endpoint shape를 변경했다면 [API Reference](03-api-reference.md)와 [API Contract](api-contract.md)를 함께 갱신한다.

`verify:fastapi-pair2`는 역사적인 이름을 유지하지만 현재 `package.json`에 등록된 FastAPI·Catalog·Lineage·SQL smoke다.

### 6.4 Source·ETL·Spark

```bash
cd backend
npm run verify:airflow-catalog-wiring
npm run verify:production-spark
npm run verify:spark-kubernetes-client
npm run verify:etl-e2e-recovery
```

- `verify:production-spark`와 `verify:spark-kubernetes-client`가 현재 package script 이름이다.
- `verify:etl-e2e-recovery`는 deterministic `pr` profile이다.
- 실제 MinIO·Spark, 대용량, 장애 주입은 [MinIO·Spark Harness](minio-100gb-spark-harness.md)와 [ETL E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md)를 따른다.

### 6.5 SQL·Trino

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-foundation
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-preview-full-flow
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-result-storage
```

실제 반복 SQL Job과 Iceberg commit은 local Trino profile을 준비한 뒤 전문 Contract의 live tier를 따른다. Preview, full-result, collector, retention을 하나의 성공 상태로 합치지 않는다.

### 6.6 Dashboard·AI

```bash
cd backend
npm run verify:dashboard-performance
npm run verify:dashboard-assistant-guard

cd ../frontend
npm run test:dashboard-widget-data-state
npm run test:live-ai-api-boundary
npm run build
```

Dashboard 성능 수치와 측정 조건은 [Dashboard Performance Verification](dashboard-performance-verification.md)에 기록한다. AI Gateway가 없는 상태의 명시적 실패를 mock 성공으로 바꾸지 않는다.

### 6.7 Kafka·Continuous·Realtime

```bash
cd backend
npm run verify:kafka-continuous-contract
npm run verify:continuous-sql-contract
npm run verify:kubernetes-continuous-contract
npm run verify:realtime-quality-gates
```

현재 EKS profile 검증은 root의 실제 script를 사용한다.

```bash
bash scripts/verify-eks-realtime-v1-only-profile.sh
```

이 검증은 Helm 3가 필요하며 npm script가 아니라 root shell script로 실행한다.

### 6.8 배포·ownership

```bash
cd backend
npm run verify:control-plane-ownership

cd ..
docker compose \
  --env-file deploy/.env.example \
  -f deploy/docker-compose.prod.yml \
  config --quiet
bash scripts/verify-eks-realtime-v1-only-profile.sh
```

이 명령들은 저장소 계약과 render를 검증하는 진입점이다. 통과 결과를 실제 AWS rollout 또는 Production E2E 증거로 과장하지 않는다.

Release candidate 전체 검증은 아래 명령을 별도로 사용한다.

```bash
bash scripts/verify-deploy-readiness.sh
```

이 script는 Python 3.13을 요구하고 Backend·Frontend Docker image build, dependency 설치와 local release record 작성을 수행한다. 일반 문서·기능 PR의 가벼운 기본 gate로 실행하지 않는다.

### 6.9 문서

```bash
node scripts/verify-docs.mjs
git diff --check
```

검사기는 로컬 Markdown link, heading anchor, code fence, 개인 절대 경로, 대표 mojibake, 완전 중복과 Mermaid 균형을 확인한다. 자동 검사 통과 후에도 code block 안팎의 설명이 의도한 위치에 렌더링되는지 직접 검토한다.

### 6.10 `npm run verify`의 위치

Backend의 전체 `npm run verify`는 기본 FastAPI gate가 아니다. Node compatibility server와 seeded MinIO fixture를 요구한다.

```bash
docker compose up -d minio postgres

cd backend
npm ci
npm run minio:seed-verify
npm run verify
```

실행 전 [Source Connector Test Guide](source-connector-test-guide.md)를 따른다.

## 7. Fixture·E2E와 안전 등급

| 등급 | 예시 | 원칙 |
| --- | --- | --- |
| Local static | unit test, contract parser, Compose render, 문서 검사 | 변경 영역에 맞게 자유롭게 실행 |
| Local integration | PostgreSQL·MinIO·Trino·Airflow·Redpanda container, 고유 fixture | 필요한 service와 cleanup 범위를 먼저 확인 |
| Operator-only | live AWS, EKS apply, EC2 deploy, 10GB·100GB 실행, 장애 주입 | 명시적 승인, 격리 대상, 비용·복구 계획 필요 |

주요 하네스:

- Source fixture와 connector smoke: [Source Connector Test Guide](source-connector-test-guide.md)
- MinIO·Spark 물리 결과 검증: [MinIO·Spark Validation Harness](minio-100gb-spark-harness.md)
- ETL 정상·장애·복구: [ETL E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md)
- Backend 구현·연동 준비 상태: [Backend Integration Readiness](backend-integration-readiness.md)
- Realtime 운영·복구: [Realtime Production Runbook](realtime-2026/production-runbook.md)

하네스가 만든 고유 fixture만 정리한다. 공유 topic, consumer group, table, Dashboard, object prefix 또는 runtime volume을 포괄 삭제하지 않는다. Production fault injection과 외부 배포는 일반 PR 검증에 포함하지 않는다.

## 8. 배포·운영 안전 경계

### 8.1 현재 ownership

| 환경 | 현재 상태 | 책임 |
| --- | --- | --- |
| EKS web·finite batch | Active | Frontend, FastAPI, Airflow, finite Spark batch, Trino Query Run |
| EKS Realtime V1 | Active | Kafka Continuous, Continuous SQL control-plane, Spark Structured Streaming, Iceberg publication |
| EC2 Compose Continuous | Inactive | rollback standby와 승인된 compatibility profile |

기계적 ownership 기준은 [`deploy/control-plane-ownership.json`](../deploy/control-plane-ownership.json), 세부 계약은 [Control-plane Deployment Ownership](refactor-2026/contracts/control-plane-deployment-ownership.md)이다.

- active Continuous owner는 모든 배포 환경을 합쳐 정확히 하나다.
- EC2 lane을 켜기 전에 승인된 owner transfer와 새 generation, checkpoint 보존, 배포 receipt가 필요하다.
- EKS Realtime V1-only profile은 ClickHouse V2와 Kafka Connect workload를 활성화하지 않는다.
- rollback은 checkpoint 삭제, rewind, dual-run 또는 다른 engine으로의 자동 전환을 사용하지 않는다.
- EKS와 EC2 release는 모두 `dev`를 source branch로 사용하고 실제 배포한 exact SHA를 receipt에 남긴다.

### 8.2 Secret과 live 작업

- 실제 token, password, private key, AWS credential을 Git, command output, 문서 또는 evidence에 남기지 않는다.
- browser는 object storage나 AI provider를 직접 호출하지 않는다.
- EKS apply, EC2 `start|deploy|restart`, Production migration, traffic promotion은 operator 승인 대상이다.
- 비용이 드는 Spark benchmark와 100GB 검증은 입력, image digest, 환경, cleanup과 판정 기준을 먼저 고정한다.
- 정적 render나 unit test 통과만으로 Production 완료를 선언하지 않는다.

## 9. 수동 smoke

### 9.1 기본 live profile

1. `/api/health/ready`가 성공하는지 확인한다.
2. Frontend에서 로컬 계정을 생성하거나 준비된 계정으로 로그인한다.
3. Job과 Catalog가 비어 있을 때 empty state가 정상인지 확인한다.
4. Backend를 중지했을 때 live 요청이 mock 성공으로 바뀌지 않는지 확인한다.
5. Backend를 다시 시작했을 때 이전 PostgreSQL metadata가 유지되는지 확인한다.

### 9.2 통합 flow

통합 service와 fixture가 준비된 경우에만 다음 흐름을 확인한다.

```text
Source 연결
  → Schema·Transform·Quality 확인
  → Job 생성·실행
  → Run History와 DAG 확인
  → 물리 결과 검증 후 Catalog 공개
  → SQL 분석
  → Dashboard에서 Dataset 선택
```

- Job command 접수와 Catalog 공개를 같은 성공으로 취급하지 않는다.
- 같은 `runId`의 물리 결과와 manifest가 검증된 뒤에만 Dataset을 공개한다.
- 실패한 Run은 마지막 정상 Catalog mapping을 덮어쓰지 않는다.
- 권한 없는 Dataset은 Catalog·SQL·Dashboard에서 사용하지 못해야 한다.

## 10. 문서 동기화

| 변경 내용 | 함께 갱신할 문서 |
| --- | --- |
| 제품 범위·사용자 flow | `docs/01-product-planning.md` |
| Architecture·routing·상태 소유권 | `docs/02-architecture.md` |
| public endpoint·노출 상태 | `docs/03-api-reference.md` |
| request·response·상태 전이 | `docs/api-contract.md` |
| 개발 명령·검증 선택 | 이 문서 |
| Backend 연결·검증 상태 | `docs/backend-integration-readiness.md` |
| CI·repository·배포 guardrail | `docs/system-guardrails.md` |
| 문서 lifecycle·탐색 경로 | `docs/README.md` |

새 문서는 `Canonical`, `Contract`, `Runbook`, `Evidence`, `Historical` 중 역할을 정해 [문서 포털](README.md)에 연결한다. 날짜·branch·commit 기반 결과는 현재 기준 문서가 아니라 Evidence 또는 Historical로 관리한다.

## 11. Historical·호환 경계

다음 항목은 현재 개발 순서가 아니다.

- 4일 데모 마일스톤과 Pair A/B/C 분업
- Day·Phase·stacked PR별 실행 순서
- `pair1`과 `dev`의 특정 시점 동기화 기록
- FastAPI 전환 계획
- Realtime 4-PR 실행 팩
- RAG/OpenSearch/embedding worker 실행 절차
- 날짜·commit·branch에 묶인 EKS evidence

역사적 맥락은 [문서 포털의 Historical 분류](README.md#historical)에서 확인한다. 과거 문서의 명령과 port를 현재 환경에 그대로 실행하지 않는다.

Node ESM server가 필요한 호환 작업은 다음 entrypoint를 명시적으로 사용한다.

```bash
cd backend
npm run start:node-compat
```

새 사용자-facing API를 Node compatibility 경로에만 추가하지 않는다.

## 12. 관련 문서

- [Product Planning](01-product-planning.md)
- [Architecture](02-architecture.md)
- [API Reference](03-api-reference.md)
- [API Contract](api-contract.md)
- [Backend Integration Readiness](backend-integration-readiness.md)
- [System Guardrails](system-guardrails.md)
- [문서 포털](README.md)
- [EC2 Compose 호환 운영 Runbook](deployment-runbook.md)
- [Control-plane Deployment Ownership](refactor-2026/contracts/control-plane-deployment-ownership.md)
- [Source Connector Test Guide](source-connector-test-guide.md)
- [MinIO·Spark Validation Harness](minio-100gb-spark-harness.md)
- [ETL E2E·Recovery Harness](refactor-2026/contracts/etl-e2e-recovery-harness.md)
- [Trino Query Run Contract](trino-query-run-contract.md)
- [Trino Result Storage Contract](trino-query-result-storage-contract.md)
- [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md)
- [Realtime Production Runbook](realtime-2026/production-runbook.md)
