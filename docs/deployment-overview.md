# AskLake 배포 방향 정리

이 문서는 AskLake를 AWS에 배포할 때 팀원이 빠르게 공유해야 할 결정을 정리한다.
목표는 한 번 수동으로 올리는 것이 아니라, 고정된 AWS 인프라 위에서 `dev` 브랜치 변경을 반복 배포할 수 있게 만드는 것이다.

Job A 담당자는 큰 방향을 이해한 뒤 `docs/job-a-aws-deployment-e2e-playbook.md`의 Phase 체크리스트와 증거 기록을 따라 진행한다.

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

## 현재 데모 구조

초기 배포는 AWS EC2 한 대에 여러 컨테이너를 띄우는 구조로 간다.

```text
AWS EC2
  - caddy
  - frontend
  - backend
  - postgres
  - mongo
  - airflow
  - redpanda

AWS S3
  - raw
  - spark output
```

Iceberg Warehouse와 Query Result bucket은 이미 만들어 두어도 되지만 현재 `dev` runtime은 사용하지 않는다. Trino/query engine 복원은 별도 이슈와 검증을 거쳐야 한다.

이 단일 EC2 Compose는 demo/staging topology이며 HA 또는 production-ready ClickHouse topology로 표시하지 않는다. ClickHouse Realtime Serving V2의 production 목표인 2개 replica, 3개 Keeper, 2개 이상의 Kafka Connect worker와 backend replica는 [V2 구현 명세](ASKLAKE_CLICKHOUSE_REALTIME_IMPLEMENTATION_SPEC.md)의 cutover gate와 별도 운영 승인을 통과한 뒤 적용한다. PR09까지의 코드 merge만으로 production traffic을 전환하지 않는다.

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
로컬 개발은 root Compose의 MinIO를 사용한다. EC2 production은 MinIO를 띄우지 않고 AWS S3를 사용한다.
File / S3, Data Lake source, Target S3 picker, Spark S3A, DuckDB는 EC2 instance profile IAM Role/default credential chain을 사용하며 browser와 서버 `.env`에는 AWS access key/secret을 두지 않는다.

기본 fixture는 다음처럼 고정한다.

| 저장소 | Fixture | 용도 |
| --- | --- | --- |
| PostgreSQL `asklake_metadata` | `catalog_datasets`, `sql_runs`, ETL/Dashboard metadata | FastAPI가 실제로 읽고 쓰는 metadata |
| PostgreSQL `asklake_sources` | `orders_clean` | Catalog -> SQL Preview -> Job 생성 메인 demo |
| PostgreSQL `asklake_sources` | `customers`, `user_activity` | 추후 join/event demo 후보 |
| MongoDB `asklake_sources` | `customer_reviews`, `app_events` | document source와 nested schema 보조 demo |
| AWS S3 raw bucket | 합성 commerce 파일과 seeded object | File / S3와 Data Lake Spark S3A demo |

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
| EC2 IAM Role 연결 | Raw list/read와 Output list/read/write/delete 최소 권한을 instance profile로 연결한다. |
| S3 bucket 생성 | Raw와 Spark Output bucket을 같은 리전에 private으로 만든다. Warehouse/Query Result bucket은 현재 runtime에 연결하지 않는다. |
| IMDSv2 설정 | token required, container credential용 response hop limit 2를 설정한다. |
| Elastic IP 연결 | 서버 public IP를 고정한다. |
| 보안 그룹 설정 | 22, 80, 443 포트를 연다. |
| DNS 연결 | 도메인 A record를 Elastic IP로 연결한다. |
| Docker 설치 | EC2에 Docker와 Docker Compose를 설치한다. |
| 배포 디렉터리 생성 | 예: `/opt/asklake` |
| 서버 `.env` 작성 | 실제 secret과 connection string은 서버에만 둔다. |
| 최초 compose up | S3 readiness 통과 후 Caddy, frontend, backend, DB, Airflow, Kafka 컨테이너를 띄운다. |

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
- 로컬은 MinIO, EC2 production은 AWS S3로 환경 분리한다.
- production storage runtime은 EC2 IAM Role/default credential chain을 사용하고 static AWS key를 저장하지 않는다.
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
- Host directories under `ASKLAKE_HOST_DATA_DIR`; Compose prepares them for Spark UID/GID `185:185`.
- EC2 repo checkout at `ASKLAKE_DEPLOY_PATH`, default `/opt/asklake`.

Compose/runtime services declared in `deploy/docker-compose.prod.yml`:

- `caddy:2.8-alpine`
- `frontend`, built from `frontend/Dockerfile`
- `backend`, built from `backend/Dockerfile`
- `postgres:16-alpine`
- `mongo:7`
- `apache/airflow:3.3.0`
- Airflow metadata `postgres:16-alpine`
- `redpandadata/redpanda:v24.3.1`
- one-shot `aws-s3-readiness`, built from `backend/Dockerfile`
- `spark-master`, `spark-worker`, and restart-safe `spark-runtime-guard`, built from the `spark-runtime` target

Airflow orchestration dependencies:

- Production compose declares `apache/airflow:3.3.0`, Airflow API server, scheduler, DAG processor, and Airflow metadata Postgres.
- The backend deploy container reads `AIRFLOW_API_BASE_URL`, `AIRFLOW_DAG_ID`, `AIRFLOW_UI_BASE_URL`, `AIRFLOW_API_TOKEN`, `AIRFLOW_USERNAME`, `AIRFLOW_PASSWORD`, `AIRFLOW_REQUEST_TIMEOUT_SECONDS`, and `AIRFLOW_RUN_SYNC_INTERVAL_SECONDS`. The last value defaults to 5 seconds and controls server-owned active Snapshot Run reconciliation.
- ETL `run` and `retry` commands require a reachable Airflow API. The default prod value is `http://airflow-apiserver:8080`, the internal Compose service URL.
- The smoke DAG is committed at `airflow/dags/asklake_etl_job.py`; it uses only packages included in the Airflow image.

Backend deploy image dependencies:

- OS packages from `backend/Dockerfile`: `nodejs`, `npm`, `ca-certificates`. The backend image intentionally omits Docker CLI.
- Python packages from `backend/requirements.txt`: FastAPI/Uvicorn, SQLAlchemy, psycopg, pydantic settings, dotenv, and DuckDB.
- Node connector packages from `backend/package.json`: S3, Kafka, MongoDB, Parquet, and PostgreSQL clients.

Spark runtime dependencies:

- Spark services use the `apache/spark:4.0.1`-based `spark-runtime` image with application scripts baked in.
- Production backend submits cluster-mode drivers to the internal Spark Standalone REST endpoint and polls terminal state; it does not receive the Docker socket.
- S3A jobs use `ASKLAKE_SPARK_HADOOP_AWS_PACKAGE`, default `org.apache.hadoop:hadoop-aws:3.4.1`.
- Spark output/report/sample host directories are rooted at `ASKLAKE_HOST_DATA_DIR`, default `/tmp/asklake`.

Frontend deploy image dependencies:

- Node 22 build image and Nginx runtime from `frontend/Dockerfile`.
- Frontend packages from `frontend/package.json`.
- Required build args are listed in `deploy/.env.example`: `VITE_API_BASE_URL`, `VITE_USE_MOCK_API`, `VITE_DASHBOARD_ASSISTANT_API_PATH`, `VITE_OBJECT_STORAGE_PROVIDER`, and `VITE_S3_REGION`.

Local deploy dependency verification:

```bash
scripts/verify-deploy-dependencies.sh
```

This renders the production and local Airflow Compose configs, builds backend/frontend/Spark runtime images, checks backend Python and Node imports, verifies Docker CLI is absent from backend, verifies UID 185 and embedded Spark scripts, checks Spark/Airflow image availability, and imports the Airflow DAG inside the Airflow image. 실제 AWS bucket/IAM 검증은 EC2에서 one-shot `aws-s3-readiness`가 수행한다.

## Realtime SSE deployment

- Production Caddy는 `/api/realtime/events` exact path를 compression에서 제외하고 `flush_interval -1`로 backend chunk를 즉시 전달한다.
- legacy EC2 NGINX 설정은 같은 exact path에서 buffering/cache/gzip을 끄고 75초 read/send timeout을 사용한다.
- backend 기본 heartbeat는 15초다. 외부 ALB/CDN idle timeout은 heartbeat보다 충분히 길어야 하며 현재 저장소에는 해당 ALB IaC가 없으므로 배포 환경에서 별도 확인한다.
- 일반 `/api/health`는 전체 backend readiness이고 `/api/health/realtime`은 event dispatcher/listener 진단이다. SSE stream 자체를 healthcheck로 호출하지 않는다.
- `DASHBOARD_SYNC_MODE=polling`, `REALTIME_EVENTS_ENABLED=false`가 rollback 기본값이다.

정적 배포 계약 검증:

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\verify-realtime-proxy-contract.py
cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
```

## ClickHouse Realtime V2 foundation deployment

PR02는 기존 Kafka Engine/ClickHouse V1 옆에 `clickhouse-realtime-v2` profile을 추가한다. 일반 production Compose 기동에는 포함되지 않으며 profile을 켜도 connector 등록, consumer owner 이전 또는 Dashboard routing은 일어나지 않는다.

Production profile은 아래 경계만 제공한다.

- `clickhouse/clickhouse-server:26.3.17.4`의 검증된 OCI index digest를 Keeper와 ClickHouse에 동일하게 사용
- 단일 Keeper, 단일 ClickHouse, 단일 Kafka Connect worker와 별도 named volume
- ClickHouse final process의 native TCP/interserver HTTP/MySQL/PostgreSQL/gRPC listener 제거(`127.0.0.1:9000`은 entrypoint init bootstrap 동안만 사용), HTTPS 8443와 secure native 9440 server cert/key/CA mount, healthcheck CA 검증과 Connect worker의 PR03용 CA mount
- host port 없이 `clickhouse_v2_internal` private network 안에서만 ClickHouse와 Connect REST 노출
- admin, ingest, materializer, reader, migration, observer password의 길이·placeholder·상호 중복 fail-closed
- Kafka Connect base digest와 공식 ClickHouse Sink v1.4.0 release asset checksum 검증

Kafka Connect production image는 [Dockerfile](../deploy/kafka-connect/Dockerfile)로 build/publish한 뒤 server `deploy/.env`의 `KAFKA_CONNECT_V2_IMAGE`를 immutable `name@sha256:...`로 바꿔야 한다. example의 invalid registry/digest placeholder로 실제 profile을 배포하지 않는다. ClickHouse certificate/key/CA는 repository 밖의 readable host path에 준비하고 connector properties secret은 mode `0600`으로 제한한다.

Backend V2 설정은 기본값 `false/false/disabled`다. PR02에는 connector registration과 live probe가 없으므로 production에서 아래 값을 활성화하지 않는다.

```dotenv
CLICKHOUSE_REALTIME_V2_ENABLED=false
KAFKA_CONNECT_SINK_ENABLED=false
CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled
KAFKA_CONNECT_URL=
KAFKA_CONNECT_CONNECTOR_NAME=asklake-clickhouse-realtime-v2
```

실제 V2 profile 값을 준비한 뒤 기존 production preflight를 통과해야 한다. Profile-only shadow도 strict TLS listener, readable cert/secret file, pairwise-distinct password, immutable ClickHouse/Connect image digest와 Compose network wiring을 검사한다. 세 flag·owner를 활성화하면 private Connect origin과 stable connector name을 추가로 검사하고 Kafka Engine V1의 active ownership을 거부한다. 기존 V1 backend ClickHouse credential은 V2 identity로 바꾸지 않는다.

```bash
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

Schema는 runtime startup DDL이 아니라 Alembic이 소유한다. Backend image에는 migration 파일이 포함되며 기존 PostgreSQL을 기동한 상태에서 web/worker rollout 전에 다음 one-shot을 실행한다.

```bash
cd deploy
docker compose --env-file .env -f docker-compose.prod.yml run --rm --no-deps \
  backend python -m alembic -c alembic.ini upgrade head
```

`0012_clickhouse_realtime_v2_foundation`은 신규 V2 table 10개만 추가한다. disabled rollback은 owner와 두 flag를 끄고 schema/volume을 보존한다. production downgrade, offset reset, volume 삭제는 금지한다.

현재 topology는 demo/staging이며 HA가 아니다. 격리 production profile에서 생성한 test certificate로 clean start/restart, strict CA 9440 health, 8443/9440-only listener와 six-account RBAC는 확인했다. 실제 EC2 certificate/hostname, clean host reboot, connector task/Kafka ingest와 backup/restore는 아직 실행 증거가 없다. profile을 production traffic에 연결하는 것은 PR03 이후 integration과 PR09 operator gate 및 별도 승인 전까지 No-Go다. exact artifact, local/prod 차이와 검증 결과는 [V2 기반시설 운영 계약](clickhouse-realtime-v2-foundation.md)을 따른다.
