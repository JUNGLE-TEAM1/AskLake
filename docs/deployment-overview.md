# AskLake 배포 방향 정리

이 문서는 AskLake를 AWS에 배포할 때 팀원이 빠르게 공유해야 할 결정을 정리한다.
목표는 한 번 수동으로 올리는 것이 아니라, 고정된 AWS 인프라 위에서 `dev` 브랜치 변경을 반복 배포할 수 있게 만드는 것이다.

## 목표

AskLake 배포의 목표는 다음 흐름을 안정적으로 만드는 것이다.

```text
PR merge to dev
  -> GitHub Actions
  -> AWS EC2
  -> Docker Compose
  -> HTTPS 도메인
  -> seeded fixture 기반 데모
```

발표와 개발 검증에서는 외부 서비스 장애에 덜 흔들리는 구조가 중요하다.
따라서 기본 배포는 실제 FastAPI backend와 실제 DB를 사용하되, source data는 미리 심은 fixture를 사용한다.

## 최종 구조

초기 배포는 AWS EC2 한 대에 여러 컨테이너를 띄우는 구조로 간다.

```text
AWS EC2
  - caddy
  - frontend
  - backend
  - postgres
  - mongo
  - minio
```

외부 요청은 Caddy가 받는다.

```text
https://도메인/
  -> frontend

https://도메인/api/*
  -> backend
```

HTTPS 인증서는 frontend나 backend가 직접 처리하지 않는다.
Caddy가 reverse proxy 역할을 하면서 자동으로 인증서를 발급하고 갱신한다.

## 데이터 전략

데모 데이터는 외부 API나 외부 DB에 직접 의존하지 않는다.

기본 전략은 다음과 같다.

```text
seeded fixture + 실제 FastAPI backend
```

PostgreSQL은 두 역할을 가진다.

```text
postgres
  - asklake_metadata
  - asklake_sources
```

MongoDB는 문서형 source fixture를 보여주기 위한 보조 source로 둔다.

```text
mongo
  - asklake_sources
```

PostgreSQL fixture는 메인 데모 시나리오에 사용한다.
MongoDB fixture는 다른 source type도 처리할 수 있다는 보조 시나리오에 사용한다.
MinIO는 EC2 prod compose의 S3-compatible data lake로 둔다.
File / S3, Data Lake source, Target S3 picker, Spark S3A demo는 서버 `deploy/.env`의 MinIO credential과 bucket allowlist를 사용한다.

기본 fixture는 다음처럼 고정한다.

| 저장소 | Fixture | 용도 |
| --- | --- | --- |
| PostgreSQL `asklake_metadata` | `catalog_datasets`, `sql_runs`, ETL/Dashboard metadata | FastAPI가 실제로 읽고 쓰는 metadata |
| PostgreSQL `asklake_sources` | `orders_clean` | Catalog -> SQL Preview -> Job 생성 메인 demo |
| PostgreSQL `asklake_sources` | `customers`, `user_activity` | 추후 join/event demo 후보 |
| MongoDB `asklake_sources` | `customer_reviews`, `app_events` | document source와 nested schema 보조 demo |
| MinIO `m3-raw` | `nyc_taxi/csv/2019-Nov.csv` 등 seeded object | File / S3와 Data Lake Spark S3A demo |

현재 FastAPI SQL Preview는 물리 DB를 직접 조회하지 않고 Catalog payload의 `sampleRows`를 사용한다.
따라서 `orders_clean`의 catalog `schema`/`sampleRows`와 PostgreSQL fixture row는 같은 seed 기준으로 맞춘다.

다른 demo 후보를 무시하지는 않는다.
다만 모든 후보를 배포 성공 조건으로 삼으면 초기 배포가 무거워지므로, 아래처럼 우선순위를 나눈다.
여기서 `P0`~`P3`의 `P`는 Phase가 아니라 Priority다.

| 우선순위 | 범위 | 판단 기준 |
| --- | --- | --- |
| Priority P0 | `orders_clean` Catalog, SQL Preview, 처리 Job 생성, Catalog 재확인 | 발표 메인 흐름이므로 반드시 통과해야 한다. |
| Priority P1 | `customers`, `user_activity`, MongoDB `customer_reviews`, `app_events`, dashboard preview | 보조 시연과 회귀 테스트에 넣는다. |
| Priority P2 | 기존 mock catalog 후보 전체 | seed 후보 registry에 남기고 시간이 될 때 확장한다. |
| Priority P3 | auth, backup, monitoring, production scheduler | 데모 배포 안정화 뒤 별도 작업으로 분리한다. |

## 처음 한 번 할 일

아래 작업은 최초 세팅 때 한 번만 한다.

| 작업 | 설명 |
| --- | --- |
| EC2 생성 | Docker Compose를 실행할 서버를 만든다. |
| Elastic IP 연결 | 서버 public IP를 고정한다. |
| 보안 그룹 설정 | 22, 80, 443 포트를 연다. |
| DNS 연결 | 도메인 A record를 Elastic IP로 연결한다. |
| Docker 설치 | EC2에 Docker와 Docker Compose를 설치한다. |
| 배포 디렉터리 생성 | 예: `/opt/asklake` |
| 서버 `.env` 작성 | 실제 secret과 connection string은 서버에만 둔다. |
| 최초 compose up | Caddy, frontend, backend, DB, MinIO 컨테이너를 띄운다. |

도메인과 서버는 매번 새로 만들지 않는다.
한 번 고정한 뒤, 이후 배포는 코드만 갱신한다.
EC2 HTTPS 배포에서는 `APP_DOMAIN=도메인`, `HTTP_PORT=80`, `HTTPS_PORT=443`을 사용한다.
frontend build-time API origin은 `VITE_API_BASE_URL=https://도메인`처럼 `/api`를 빼고 넣는다.

## 이후 반복 배포 흐름

반복 배포의 최종 형태는 GitHub Actions가 맡는다.
다만 개발 중에는 서버를 필요할 때 켜고 끄는 운영 흐름이 먼저 필요하므로, 현재는 `scripts/deploy.sh`를 로컬에서 실행해 같은 절차를 반복한다.

개발 중 운영 흐름은 다음과 같다.

```text
scripts/deploy.sh start
  -> scripts/deploy.sh deploy
  -> 브라우저/health check 확인
  -> scripts/deploy.sh stop
```

세부 명령은 `docs/deployment-runbook.md`를 기준으로 한다.

GitHub Actions 자동 배포는 이후 아래 흐름으로 연결한다.

```text
dev 브랜치 업데이트
  -> frontend build
  -> backend validation
  -> EC2 SSH 접속
  -> git pull origin dev
  -> docker compose up -d --build
  -> health check
```

초기에는 SSH 기반 배포가 가장 단순하다.
나중에 운영 수준이 필요해지면 ECR, ECS, RDS 같은 구조로 옮길 수 있다.

## 배포 파일

Phase 3에서 추가된 prod-like compose 기준 파일과 이후 자동화 대상 파일은 다음과 같다.

```text
deploy/docker-compose.prod.yml
deploy/Caddyfile
deploy/.env.example
deploy/ec2.env.example
deploy/postgres/init/01-create-source-database.sql
backend/Dockerfile
frontend/Dockerfile
scripts/deploy.sh
scripts/seed-demo-data.sh
scripts/reset-demo-data.sh
.github/workflows/deploy-dev.yml
docs/deployment-runbook.md
```

`deploy/*`, backend/frontend Dockerfile은 prod-like compose baseline이고, seed/reset script는 demo fixture를 같은 상태로 맞추는 운영 계층이다.
GitHub Actions workflow는 후속 phase에서 추가한다.
`scripts/deploy.sh`와 `deploy/ec2.env.example`은 EC2 start/stop/redeploy를 반복하기 위한 로컬 운영 계층이다.

이 문서들은 실제 secret 값을 포함하지 않는다.
실제 값은 GitHub Secrets와 서버 `.env`에서 관리한다.

## 데모 시나리오

기본 데모 흐름은 다음과 같다.

```text
Catalog 검색
  -> SQL 분석 이동
  -> dataset 선택
  -> SQL Preview 실행
  -> 처리 Job 생성
  -> ETL Review
  -> Job 생성 및 실행
  -> Catalog dataset 확인
```

이 흐름이 발표 중 끊기지 않는 것이 배포의 1차 성공 기준이다.

우선 고정한 기본 데모는 `orders_clean` dataset 기준이다.

| 항목 | 값 |
| --- | --- |
| 시작 화면 | 검색/카탈로그 |
| 검색어 | `orders` |
| 기본 dataset | `orders_clean` |
| 기본 dataset id | `ds_orders_clean` |
| source fixture | PostgreSQL |
| preview seed row | 10 rows |
| 생성될 dataset | `orders_clean_analysis` 또는 반복 테스트 suffix가 붙은 이름 |

SQL 분석에서는 아래 query를 기본으로 사용한다.

```sql
SELECT order_id, customer_id, order_date, total_amount, status
FROM orders_clean
LIMIT 100;
```

성공 기준은 Preview row가 1개 이상 보이고, 처리 Job 생성 후 Catalog에서 새 derived dataset을 다시 확인할 수 있는 것이다.
Catalog에 `orders_clean`이 없거나 Preview가 비어 있으면 배포 성공으로 보지 않고 seed/reset부터 다시 확인한다.

## 배포 전 확인

로컬에서 먼저 확인한다.

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config
docker build -t asklake-backend-deploy-check:local backend

cd frontend
npm run build
VITE_USE_MOCK_API=false npm run build
```

서버에서는 다음을 확인한다.

```bash
curl https://도메인/api/health
docker compose ps
docker compose logs backend
```

브라우저에서는 Catalog, SQL Preview, 처리 Job 생성, Catalog dataset 등록까지 확인한다.

## 결정 사항

- AWS EC2 한 대와 Docker Compose를 기본 배포 구조로 사용한다.
- HTTPS는 Caddy가 처리한다.
- demo가 급할 때는 Route 53 구매 domain 대신 `sslip.io` 같은 IP 기반 무료 domain을 사용할 수 있다.
- 배포는 `dev` 브랜치 기준 GitHub Actions로 자동화한다.
- GitHub Actions 전에는 `scripts/deploy.sh`로 start/stop/deploy/status를 반복한다.
- demo data는 seeded fixture로 고정한다.
- PostgreSQL과 MongoDB를 fixture source로 둔다.
- MinIO는 기본 EC2 compose에 포함하고 S3-compatible data lake demo source로 사용한다.
- secret은 repo에 넣지 않는다.

## 아직 하지 않는 일

- ECS/Fargate 전환.
- RDS/DocumentDB 같은 managed DB 전환.
- production-grade scheduler.

- 실제 인증/인가.
- 운영용 backup/monitoring 체계.

이 항목들은 데모 배포가 안정화된 뒤 별도 작업으로 분리한다.

## Deployment Dependency Manifest

The deploy path is expected to be reproducible from declared files only.

Host prerequisites:

- Docker Engine and the Docker Compose plugin.
- Git, SSH, curl, and AWS CLI for `scripts/deploy.sh`.
- A writable Docker socket at `/var/run/docker.sock`; the backend uses it to start Spark submit/master/worker containers.
- EC2 repo checkout at `ASKLAKE_DEPLOY_PATH`, default `/opt/asklake`.

Compose/runtime services declared in `deploy/docker-compose.prod.yml`:

- `caddy:2.8-alpine`
- `frontend`, built from `frontend/Dockerfile`
- `backend`, built from `backend/Dockerfile`
- `postgres:16-alpine`
- `mongo:7`
- `minio/minio:RELEASE.2025-07-23T15-54-02Z`

Airflow orchestration dependencies:

- Local orchestration compose declares `apache/airflow:3.3.0`, Airflow API server, scheduler, DAG processor, and Airflow metadata Postgres.
- The backend deploy container reads `AIRFLOW_API_BASE_URL`, `AIRFLOW_DAG_ID`, `AIRFLOW_UI_BASE_URL`, `AIRFLOW_API_TOKEN`, `AIRFLOW_USERNAME`, `AIRFLOW_PASSWORD`, and `AIRFLOW_REQUEST_TIMEOUT_SECONDS`.
- ETL `run` and `retry` commands require a reachable Airflow API. If `AIRFLOW_API_BASE_URL` is empty, the backend returns `AIRFLOW_CONFIG_MISSING` instead of silently falling back.
- The smoke DAG is committed at `airflow/dags/asklake_etl_job.py`; it uses only packages included in the Airflow image.

Backend deploy image dependencies:

- OS packages from `backend/Dockerfile`: `nodejs`, `npm`, `docker-cli`, `ca-certificates`.
- Python packages from `backend/requirements.txt`: FastAPI/Uvicorn, SQLAlchemy, psycopg, pydantic settings, dotenv, and DuckDB.
- Node connector packages from `backend/package.json`: S3, Kafka, MongoDB, Parquet, and PostgreSQL clients.

Spark runtime dependencies:

- Spark jobs run in `ASKLAKE_SPARK_IMAGE`, default `apache/spark:4.0.1`.
- The backend starts/uses `ASKLAKE_SPARK_MASTER_CONTAINER` and `ASKLAKE_SPARK_WORKER_CONTAINER` through Docker.
- S3A jobs use `ASKLAKE_SPARK_HADOOP_AWS_PACKAGE`, default `org.apache.hadoop:hadoop-aws:3.4.1`.
- Spark output/report/sample host directories are rooted at `ASKLAKE_HOST_DATA_DIR`, default `/tmp/asklake`.

Frontend deploy image dependencies:

- Node 22 build image and Nginx runtime from `frontend/Dockerfile`.
- Frontend packages from `frontend/package.json`.
- Required build args are listed in `deploy/.env.example`: `VITE_API_BASE_URL`, `VITE_USE_MOCK_API`, and `VITE_DASHBOARD_ASSISTANT_API_PATH`.

Local deploy dependency verification:

```bash
scripts/verify-deploy-dependencies.sh
```

This renders the production Compose config, renders the local Airflow orchestration Compose config, builds backend/frontend deploy images, checks backend Python and Node imports, checks Docker CLI availability in the backend image, and verifies that the Spark and Airflow images are available.
