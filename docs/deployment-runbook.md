# AskLake EC2 배포 운영 Runbook

이 문서는 개발 중 EC2 배포 서버를 켜고, 재배포하고, 끄는 반복 절차를 정리한다.
정식 GitHub Actions 자동 배포 전에도 같은 절차를 로컬에서 실행할 수 있게 하는 것이 목표다.

## 전제

- EC2, Elastic IP, Security Group, Docker, Docker Compose, 서버 `deploy/.env`는 최초 bootstrap에서 이미 준비되어 있어야 한다.
- 실제 AWS 계정 값, EC2 id, IP, domain, SSH key, secret은 repo에 커밋하지 않는다.
- 로컬 실행자는 AWS CLI와 SSH 접근 권한을 가지고 있어야 한다.
- 서버 repo는 기본적으로 `/opt/asklake`에 clone되어 있다고 가정한다. release checkout처럼 다른 경로를 쓰면 로컬 deploy env에 `ASKLAKE_DEPLOY_PATH`로 실제 경로를 명시한다.
- 서버 `deploy/.env`에는 Postgres/Mongo/OpenAI 값과 S3 bucket 이름만 보존한다. 장기 AWS access key/secret과 MinIO credential은 넣지 않는다.
- EC2에는 Raw list/read와 Output list/read/write/delete 권한을 가진 instance profile IAM Role을 연결한다. `TRINO_ENABLED=true`이면 Warehouse와 Query Result bucket의 list/read/write/delete 최소 권한도 같은 role에 추가한다. Container credential 전달을 위해 IMDSv2 token required, response hop limit 2를 사용한다.

## 1. 로컬 환경 파일 준비

예시 파일을 복사해서 개인 환경 파일을 만든다.

```bash
cp deploy/ec2.env.example deploy/ec2.env
```

`deploy/ec2.env`에 실제 값을 채운다.

```bash
export AWS_REGION=ap-northeast-2
export ASKLAKE_EC2_INSTANCE_ID=i-xxxxxxxxxxxxxxxxx
export ASKLAKE_EC2_HOST=asklake.example.com
export ASKLAKE_APP_URL=https://asklake.example.com
export ASKLAKE_SSH_KEY="$HOME/.ssh/asklake-ec2.pem"
export ASKLAKE_DEPLOY_BRANCH=dev
```

무료 IP 기반 demo domain을 쓰는 동안에는 `ASKLAKE_EC2_HOST`와 `ASKLAKE_APP_URL`에 `sslip.io` host를 넣는다.
형식은 `<IP를 하이픈으로 바꾼 값>.sslip.io`다.

```bash
export ASKLAKE_EC2_HOST=203-0-113-10.sslip.io
export ASKLAKE_APP_URL=https://203-0-113-10.sslip.io
```

작업 shell에서 환경 파일을 불러온다.

```bash
source deploy/ec2.env
```

## 2. 상태 확인

```bash
scripts/deploy.sh status
```

Before deploying a branch, run the dependency verification from the repo root:

```bash
scripts/verify-deploy-dependencies.sh
```

It checks the production Compose file, local Airflow orchestration Compose file, backend Python and Node dependencies, absence of Docker CLI in the backend image, UID 185 and embedded scripts in the Spark runtime image, Spark/Airflow image availability, Airflow DAG import, and the frontend production build image. If this fails, fix the declared dependency or env key before running `scripts/deploy.sh deploy`.

Trino profile이 정상 기동한 뒤에는 아래 명령으로 운영 runtime edge를 확인한다.

```bash
scripts/deploy.sh smoke
```

이 smoke는 backend container에서 Spark REST endpoint, Redpanda Kafka metadata, Trino query/materializer 권한, Iceberg 임시 CTAS와 Query Result S3 round-trip을 확인한다. Trino readiness가 만드는 임시 table/object는 종료 전에 삭제하며, 사용자 Job, Catalog dataset, Kafka topic은 생성하지 않는다. 배포 과정에 함께 넣으려면 명시적으로 `ASKLAKE_RUN_POST_DEPLOY_SMOKE=true`를 설정한다. `TRINO_ENABLED=false` compatibility 배포에서는 이 명령을 실행할 수 없다.

실제 Job 경로까지 확인해야 할 때만 아래 opt-in smoke를 실행한다.

```bash
ASKLAKE_RUN_PRODUCTION_JOB_E2E=true scripts/deploy.sh job-smoke
```

이 명령은 일반 Spark batch, Kafka Snapshot, Kafka Continuous Job을 각각 고유 suffix로 생성하고 Iceberg commit, Catalog `available`, Trino row count를 확인한다. Snapshot은 같은 consumer group의 후속 0건 run도 확인한다. `asklake-production-smoke/` S3 source fixture, `asklake.production.smoke.*` Kafka topic, 생성 Job/Dataset/Iceberg table만 종료 시 정리한다. EC2 Role은 Raw bucket 전체 쓰기·삭제 권한 대신 `asklake-production-smoke/*` prefix에만 `s3:PutObject`와 `s3:DeleteObject`를 허용해야 한다. 기본 `deploy`, `restart`, `smoke`에는 절대 포함되지 않는다.

Backend run/retry actions require these Airflow variables in the server `deploy/.env` when DAG submission is expected:

```bash
AIRFLOW_API_BASE_URL=http://airflow-apiserver:8080
AIRFLOW_DAG_ID=asklake_etl_job
AIRFLOW_UI_BASE_URL=
AIRFLOW_API_TOKEN=
AIRFLOW_USERNAME=airflow
AIRFLOW_PASSWORD=replace-with-strong-airflow-password
AIRFLOW_REQUEST_TIMEOUT_SECONDS=10
AIRFLOW_EXECUTION_API_TOKEN=replace-with-strong-airflow-execution-token
ASKLAKE_EXECUTION_API_TIMEOUT_SECONDS=7500
AIRFLOW_INTERNAL_BASE_URL=http://backend:8080
AIRFLOW_INTERNAL_TOKEN=replace-with-strong-internal-token
AIRFLOW_INTERNAL_TIMEOUT_SECONDS=1800
AIRFLOW_IMAGE_NAME=apache/airflow:3.3.0
AIRFLOW_METADATA_DB_NAME=airflow
AIRFLOW_METADATA_DB_USER=airflow
AIRFLOW_METADATA_DB_PASSWORD=replace-with-strong-airflow-metadata-password
```

확인하는 것:

- EC2 instance state
- public host
- remote Docker Compose service 상태

## 3. 켜기

```bash
scripts/deploy.sh start
```

이 명령은 다음을 수행한다.

```text
EC2 start
  -> instance-running 대기
  -> SSH 가능할 때까지 대기
  -> docker compose up -d
  -> frontend/API health check
  -> docker compose ps
```

Prod compose는 MinIO를 포함하지 않고 실제 AWS S3를 사용한다. 시작 전에 같은 리전의 Raw/Output bucket을 만들고 서버 `/opt/asklake/deploy/.env`에 아래 값을 채운다.

```bash
ASKLAKE_OBJECT_STORAGE_PROVIDER=aws
AWS_REGION=ap-northeast-2
ASKLAKE_RAW_BUCKET=replace-with-asklake-raw-bucket
ASKLAKE_SPARK_OUTPUT_MODE=s3a
ASKLAKE_SPARK_OUTPUT_BUCKET=replace-with-asklake-output-bucket
COMPOSE_PROFILES=
TRINO_ENABLED=false
TRINO_BASE_URL=https://trino:8443
TRINO_CATALOG=iceberg
TRINO_SCHEMA=asklake
TRINO_USER=asklake-api
TRINO_ICEBERG_WAREHOUSE_BUCKET=replace-with-asklake-warehouse-bucket
TRINO_ICEBERG_WAREHOUSE_PREFIX=warehouse
TRINO_RESULT_STORAGE_BUCKET=replace-with-asklake-query-results-bucket
TRINO_RESULT_STORAGE_PREFIX=query-results
TRINO_RESULT_STORAGE_AUTO_CREATE_BUCKET=false
TRINO_RESULT_RETENTION_SECONDS=86400
TRINO_RESULT_CURSOR_SECRET=replace-with-a-long-random-production-secret
TRINO_QUERY_CONFIRMATION_SECRET=replace-with-a-long-random-production-secret
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ALLOWED_BUCKETS=replace-with-asklake-raw-bucket,replace-with-asklake-output-bucket,replace-with-asklake-warehouse-bucket,replace-with-asklake-query-results-bucket
ASKLAKE_S3_READINESS_READ_BUCKETS=replace-with-asklake-raw-bucket
ASKLAKE_S3_READINESS_WRITE_BUCKETS=replace-with-asklake-output-bucket
```

`TRINO_ENABLED=false`에서는 `COMPOSE_PROFILES`를 비워 둔다. 이때 coordinator/bootstrap/collector/cleanup service는 Compose graph에서 빠지며 Trino bucket, password, HMAC secret, CA/keystore/password file 없이 기존 DuckDB 호환 배포가 기동한다. `aws-s3-readiness`는 Raw bucket list와 Output bucket put/head/delete만 검증한다.

이 compatibility mode는 기존 DuckDB 조회를 위한 기동 경로다. 최신 일반 Spark, Kafka Snapshot, Kafka Continuous Job은 Iceberg commit 뒤 Trino 물리 검증을 요구하므로 새 Iceberg target을 실행하려면 아래 Trino profile을 활성화해야 한다.

Trino를 켤 때는 `TRINO_ENABLED=true`와 `COMPOSE_PROFILES=trino`를 함께 설정하고 Warehouse와 Query Result bucket도 `ASKLAKE_S3_READINESS_WRITE_BUCKETS`에 포함한다. 배포 preflight는 두 bucket, fixed ACL identity(`asklake-api`, `asklake-materializer`), `iceberg.asklake`, 서로 다른 production secret, 읽을 수 있는 TLS/htpasswd file을 모두 검증한다. Warehouse와 Query Result bucket은 배포 전에 같은 리전에 생성하고 EC2 instance profile에 필요한 list/read/write/delete 최소 권한을 부여한다. backend, Trino, collector/cleanup worker는 endpoint나 장기 AWS access key/secret 없이 default credential chain을 사용한다. Query Result bucket은 lifecycle policy로 애플리케이션 retention보다 늦게 만료되도록 설정하고 공개 access를 차단한다.

Spark Iceberg 실행에는 아래 값이 backend에서 Spark REST driver까지 전달된다. package coordinate는 Spark 4.0/Scala 2.13 호환값을 유지하고, Continuous는 publication report와 stale runner 정리 범위를 명시적으로 제한한다.

```bash
ASKLAKE_SPARK_ICEBERG_PACKAGE=org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.11.0
ASKLAKE_SPARK_POSTGRES_PACKAGE=org.postgresql:postgresql:42.7.7
ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW=100
ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS=900
ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS=30
ASKLAKE_PRODUCTION_SMOKE_RETRIES=12
ASKLAKE_PRODUCTION_SMOKE_RETRY_DELAY_SECONDS=5
```

`ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW`은 1~1000, lease는 120~86400초, stale timeout은 10~3600초, runtime smoke retry/delay는 각각 1~60 범위만 허용한다. Trino 활성 preflight는 backend와 coordinator가 같은 JDBC catalog/warehouse 설정을 받고 Spark Iceberg package와 Continuous 값을 실제 backend environment에 전달하는지도 확인한다.

Production Trino는 public port를 열지 않고 backend/PostgreSQL과 통신하는 internal network에서 HTTPS/password authentication을 사용한다. 별도 outbound network는 EC2 instance profile의 IMDS credential과 AWS S3에 나갈 때만 사용한다. Query identity는 read-only, materializer identity는 `asklake` schema CTAS/`DESCRIBE`/drop 최소 권한으로 분리한다. JDBC role/password, TLS CA/keystore, password hash file과 shared secret은 서버 secret mount에만 두고 Git에 저장하지 않는다. 로컬 root Compose에서만 MinIO와 local credential을 사용한다.

Production frontend build는 Compose가 `ASKLAKE_SPARK_OUTPUT_BUCKET` 값을 `VITE_SPARK_OUTPUT_BUCKET`으로 전달해 Target 경로와 Spark 출력 경로를 일치시킨다. readiness 실패를 bucket 자동 생성이나 static AWS key 추가로 우회하지 않는다.

## 4. 재배포

```bash
scripts/deploy.sh deploy
```

기본 branch는 `ASKLAKE_DEPLOY_BRANCH=dev`다.
pair branch나 현재 검증 branch를 올릴 때는 shell에서 branch만 바꿔 실행한다.

```bash
ASKLAKE_DEPLOY_BRANCH=pair2 scripts/deploy.sh deploy
```

재배포는 서버에서 다음 흐름을 실행한다.

```text
EC2 running 보장
  -> git fetch origin <branch>
  -> git checkout <branch>
  -> git pull --ff-only origin <branch>
  -> docker compose up -d --build
  -> frontend/API health check
  -> TRINO_ENABLED=true이면 query identity, materializer CTAS, Warehouse/Query Result S3 readiness
  -> TRINO_ENABLED=false이면 stale Trino profile container 제거 후 readiness 생략
  -> docker compose ps
```

`git pull --ff-only`가 실패하면 서버 작업 tree가 배포 branch와 다르다는 뜻이므로 자동으로 덮어쓰지 않고 실패시킨다.

Trino를 활성화한 서버에서는 배포 script와 동일한 readiness를 수동으로 다시 확인할 수 있다.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml \
  exec -T backend python scripts/verify-trino-production-readiness.py
```

## 5. Compose만 재시작

코드 pull 없이 서버 `.env` 변경이나 컨테이너 재기동만 필요할 때 사용한다.

```bash
scripts/deploy.sh restart
```

## 6. Health Check

```bash
scripts/deploy.sh health
```

확인하는 endpoint:

```text
https://APP_DOMAIN/
https://APP_DOMAIN/api/health
```

EC2 재기동 직후에는 Caddy가 443 포트를 열기까지 몇 초 늦을 수 있으므로, health check는 기본적으로 retry한다.
필요하면 로컬 `deploy/ec2.env`에서 아래 값을 조정한다.

```bash
export ASKLAKE_HEALTH_RETRIES=18
export ASKLAKE_HEALTH_RETRY_DELAY=5
```

## 7. 로그 확인

전체 로그 tail:

```bash
scripts/deploy.sh logs
```

특정 service 로그 tail:

```bash
ASKLAKE_LOG_SERVICE=backend scripts/deploy.sh logs
ASKLAKE_LOG_SERVICE=caddy ASKLAKE_LOG_LINES=200 scripts/deploy.sh logs
```

## 8. 데모 데이터 Seed / Reset

배포 직후 또는 리허설 전에 base fixture를 같은 상태로 맞춘다.

```bash
scripts/seed-demo-data.sh
```

이 명령은 다음 데이터를 idempotent하게 upsert한다.

- Pair2 catalog metadata: `orders_clean`, `customers_clean`, `order_items_clean`, `products_clean`, `payments_clean`
- PostgreSQL source fixture: `orders_clean`, `customers_clean`, `order_items_clean`, `products_clean`, `payments_clean`, `user_activity`
- MongoDB document fixture: `customer_reviews`, `app_events`
- MongoDB catalog metadata: `ds_customer_reviews_source`, `ds_app_events_source`

AWS S3 Raw object sample은 권한 있는 운영자 환경에서 별도로 업로드한다.

```bash
aws s3 cp <local-fixture-path> s3://<raw-bucket>/<prefix>/
```

로컬 fixture 검증은 계속 root `docker-compose.yml`의 MinIO와 `npm run minio:seed-verify`를 사용한다.

발표 중 생성된 SQL preview, SQL derived dataset, SQL Result 처리 Job만 정리하려면 먼저 dry-run으로 삭제 범위를 확인한다.

```bash
scripts/reset-demo-data.sh --dry-run
```

문제가 없으면 실제 reset을 실행한다.

```bash
scripts/reset-demo-data.sh
scripts/seed-demo-data.sh
```

기본 reset은 base fixture dataset과 MongoDB fixture 문서를 삭제하지 않는다.
MongoDB fixture 문서까지 지워야 하는 특수 상황에서만 아래처럼 실행한다.

```bash
ASKLAKE_RESET_MONGO_FIXTURES=true scripts/reset-demo-data.sh
```

## 9. 끄기

```bash
scripts/deploy.sh stop
```

이 명령은 가능한 경우 Compose service를 먼저 stop한 뒤 EC2를 stop한다.
EC2를 stop하면 instance compute 비용은 줄지만, EBS volume과 Elastic IP 같은 리소스 비용은 남을 수 있다.

## 10. 권장 개발 루프

```text
작업 시작
  -> source deploy/ec2.env
  -> scripts/deploy.sh start
  -> scripts/deploy.sh deploy
  -> scripts/seed-demo-data.sh
  -> 브라우저에서 demo flow 확인
  -> 필요 시 scripts/deploy.sh logs
  -> 작업 종료 후 scripts/deploy.sh stop
```

## 11. 운영 원칙

- 서버 `deploy/.env`는 repo에서 관리하지 않는다.
- 배포 script는 서버 `.env`를 생성하거나 secret을 출력하지 않는다.
- OpenAI/API/domain 같은 서버 전용 env 값은 최초 bootstrap 뒤 서버 `deploy/.env`에 보존하며, 재배포는 이 파일을 덮어쓰지 않는다.
- 배포 실패 시 DB volume을 자동 reset하지 않는다.
- demo data reset은 별도 seed/reset 절차로만 실행한다.
- 정식 자동 배포는 이 runbook이 안정화된 뒤 GitHub Actions에서 같은 명령을 호출하도록 연결한다.
