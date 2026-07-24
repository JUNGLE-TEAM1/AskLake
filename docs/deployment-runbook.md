# AskLake EC2 Compose 호환 운영 Runbook

> **문서 상태 — Runbook / 현재 실행 가능한 호환 운영 lane**
>
> 이 문서는 `deploy/docker-compose.prod.yml`로 web·batch·Continuous service를 한 EC2에서 운영하는 호환 lane의 절차다. 현재 canonical owner는 EKS web·finite batch + Realtime V1이며 EC2 Continuous worker는 rollback standby다. EC2로 owner를 이전하도록 별도 승인된 경우에만 web backend의 Continuous loop를 끄고 전용 `continuous-worker` 하나가 side effect를 소유한다. AskLake 전체 Production topology의 기준은 [Architecture](02-architecture.md)와 [Control-plane Deployment Ownership](refactor-2026/contracts/control-plane-deployment-ownership.md)을 따른다.

이 문서는 EC2 Compose 배포 서버를 켜고, 재배포하고, 끄는 반복 절차를 정리한다. 해당 호환 lane을 정식 GitHub Actions 자동 배포 전에도 로컬에서 같은 방식으로 운영할 수 있게 하는 것이 목표다.

## 전제

- EC2, Elastic IP, Security Group, Docker, Docker Compose, 서버 `deploy/.env`는 최초 bootstrap에서 이미 준비되어 있어야 한다.
- 실제 AWS 계정 값, EC2 id, IP, domain, SSH key, secret은 repo에 커밋하지 않는다.
- 로컬 실행자는 AWS CLI와 SSH 접근 권한을 가지고 있어야 한다.
- 서버 repo는 기본적으로 `/opt/asklake`에 clone되어 있다고 가정한다.
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
export ASKLAKE_APP_URL='https://<public-app-host>'
```

작업 shell에서 환경 파일을 불러온다.

```bash
source deploy/ec2.env
```

## 2. 상태 확인

```bash
scripts/deploy.sh status
```

기존 Compose stack을 운영 명령으로 다시 제어할 때는 private `deploy/ec2.env`의
`ASKLAKE_COMPOSE_PROJECT_NAME`을 실제 container의 `com.docker.compose.project` label과
같게 지정한다. 값이 다르면 public health가 우연히 통과해도 `status`, `start`, `logs`가
빈 project나 새 project를 대상으로 할 수 있다. 운영 script는 lowercase project 이름만
허용하며 host의 다른 project를 자동 채택하지 않는다.

Before deploying a branch, run the dependency verification from the repo root:

```bash
scripts/verify-deploy-dependencies.sh
```

It checks the production Compose file, local Airflow orchestration Compose file, backend Python and Node dependencies, absence of Docker CLI in the backend image, UID 185 and embedded scripts in the Spark runtime image, Spark/Airflow image availability, Airflow DAG import, and the frontend production build image. If this fails, fix the declared dependency or env key before running `scripts/deploy.sh deploy`.

Backend run/retry actions require these Airflow variables in the server `deploy/.env` when DAG submission is expected:

```bash
AIRFLOW_API_BASE_URL=http://airflow-apiserver:8080
AIRFLOW_DAG_ID=asklake_etl_job
AIRFLOW_UI_BASE_URL=
AIRFLOW_API_TOKEN=
AIRFLOW_USERNAME=airflow
AIRFLOW_PASSWORD=replace-with-strong-airflow-password
AIRFLOW_REQUEST_TIMEOUT_SECONDS=10
AIRFLOW_RUN_SYNC_INTERVAL_SECONDS=5
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
# 선택 사항: 새 빈 Source draft에만 표시할 비밀이 아닌 기본값
ASKLAKE_SOURCE_DEFAULT_S3_BUCKET=
ASKLAKE_SOURCE_DEFAULT_S3_PREFIX=
ASKLAKE_SOURCE_DEFAULT_KAFKA_TOPIC=asklake-source-events
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

Trino를 켤 때는 `TRINO_ENABLED=true`와 `COMPOSE_PROFILES=trino`를 함께 설정하고 Warehouse와 Query Result bucket도 `ASKLAKE_S3_READINESS_WRITE_BUCKETS`에 포함한다. 배포 preflight는 두 bucket, fixed ACL identity(`asklake-api`, `asklake-materializer`), `iceberg.asklake`, 서로 다른 production secret, 읽을 수 있는 TLS/htpasswd file을 모두 검증한다. Warehouse와 Query Result bucket은 배포 전에 같은 리전에 생성하고 EC2 instance profile에 필요한 list/read/write/delete 최소 권한을 부여한다. backend, Trino, collector/cleanup worker는 endpoint나 장기 AWS access key/secret 없이 default credential chain을 사용한다. Query Result bucket은 lifecycle policy로 애플리케이션 retention보다 늦게 만료되도록 설정하고 공개 access를 차단한다.

Production Trino는 public port를 열지 않고 backend/PostgreSQL과 통신하는 internal network에서 HTTPS/password authentication을 사용한다. 별도 outbound network는 EC2 instance profile의 IMDS credential과 AWS S3에 나갈 때만 사용한다. Query identity는 read-only, materializer identity는 `asklake` schema CTAS/`DESCRIBE`/drop 최소 권한으로 분리한다. JDBC role/password, TLS CA/keystore, password hash file과 shared secret은 서버 secret mount에만 두고 Git에 저장하지 않는다. 로컬 root Compose에서만 MinIO와 local credential을 사용한다.

Production frontend build는 Compose가 `ASKLAKE_SPARK_OUTPUT_BUCKET` 값을 `VITE_SPARK_OUTPUT_BUCKET`으로 전달해 Target 경로와 Spark 출력 경로를 일치시킨다. backend의 `GET /api/s3/buckets`도 같은 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 목록 첫 번째로 반환해야 하며, frontend는 이 runtime 값으로 빌드 시점 기본 경로를 다시 맞춘다. Output bucket은 `S3_ALLOWED_BUCKETS`와 `ASKLAKE_S3_READINESS_WRITE_BUCKETS`에도 포함한다. AWS mode에서는 설정 누락을 local `asklake-output`으로 대체하지 않으므로, `503 SERVICE_UNAVAILABLE`이 보이면 세 값을 먼저 비교한다. readiness 실패를 bucket 자동 생성이나 static AWS key 추가로 우회하지 않는다.

## 4. 재배포

```bash
scripts/deploy.sh deploy
```

배포 branch는 `dev`로 고정한다. `scripts/deploy.sh`는 `ASKLAKE_DEPLOY_BRANCH`가 `dev`가
아니면 start/deploy/restart를 중단한다. pair/feature branch를 직접 올리지 말고 먼저 `dev`에
병합한 뒤 그 exact SHA의 image와 checkout을 사용한다.

`deploy`는 remote checkout의 tracked·untracked 변경을 fetch 전후에 거부하고, pull 뒤
`HEAD`와 `origin/dev`가 정확히 같은 commit인지 양방향 ancestor 검사로 확인한다. 통과한
`git rev-parse HEAD`를 배포 로그/receipt의 EC2 source SHA로 사용한다.
`start`와 `restart`도 EC2를 깨운 뒤 build/start 전에 remote branch가 `dev`이고 clean하며
`HEAD == origin/dev`인지 같은 방식으로 읽기 전용 검증한다. 불일치 상태를 자동 checkout하거나
빌드하지 않는다.

재배포는 서버에서 다음 흐름을 실행한다.

```text
EC2 running 보장
  -> git fetch origin dev
  -> git checkout dev
  -> git pull --ff-only origin dev
  -> deploy env preflight
  -> PostgreSQL만 준비한 metadata schema bootstrap
  -> docker compose up -d --build
  -> backend/Airflow execution control plane force recreate
  -> backend/Airflow execution-token parity check (hash comparison only)
  -> frontend/API health check
  -> TRINO_ENABLED=true이면 query identity, materializer CTAS, Warehouse/Query Result S3 readiness
  -> TRINO_ENABLED=false이면 stale Trino profile container 제거 후 readiness 생략
  -> docker compose ps
```

`git pull --ff-only`가 실패하면 서버 작업 tree가 배포 branch와 다르다는 뜻이므로 자동으로 덮어쓰지 않고 실패시킨다.

Airflow Spark execution token은 backend와 scheduler가 공유하는 secret이다. `scripts/deploy.sh start`, `deploy`, `restart`는 backend, airflow-apiserver, airflow-scheduler, airflow-dag-processor를 강제 재생성한 다음 두 token의 SHA-256 hash만 비교한다. 값이 다르거나 비어 있으면 health check 전에 배포를 중단하며, 실제 token은 출력하지 않는다.

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

Production Compose는 one-shot 초기화 대신 `spark-runtime-guard`를 `restart: unless-stopped`로 실행한다. guard는 Ivy `cache`/`jars`, report, local checkpoint/output path를 생성하고 기존 파일을 보존한 채 `185:185`, directory `2770`, file `0660` 계약을 복구한다. Spark worker와 backend는 실제 write/read probe가 통과한 뒤 시작하므로 Docker daemon 자동 restart에서도 `compose up` 순서에만 의존하지 않는다.

재부팅 뒤 storage readiness를 별도로 확인하려면 다음을 실행한다.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml ps spark-runtime-guard spark-master spark-worker backend
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml logs --tail=100 spark-runtime-guard
```

오류 JSON의 `code`, `path`, expected/actual owner·mode를 확인한다. 수동 `chmod 777` 또는 report/checkpoint 삭제로 우회하지 않는다. 상세 복구·검증·rollback 절차는 [Spark runtime 경로 재부팅 복구 Runbook](./refactor-2026/operations/spark-runtime-reboot-recovery.md)을 따른다.

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

## 7. Deployment Diagnostic

`health`가 실패하거나 배포 직후 상태를 전달해야 할 때는 원격 상태를 바꾸지 않는 진단 명령을 실행한다.

```bash
scripts/deploy.sh diagnose
```

기본 출력 경로는 `${TMPDIR:-/tmp}/asklake-deploy-diagnostic.json`이며,
필요하면 `ASKLAKE_DEPLOY_DIAGNOSTIC_PATH`로 로컬 경로를 지정한다. record는 EC2 running 상태, canonical URL, deploy env preflight, frontend/backend/AI health, Compose 상태, Trino 및 ClickHouse readiness를 `passed`, `failed`, `skipped`로 남긴다. 실패한 단계가 있어도 가능한 나머지 관찰을 끝까지 수집한 뒤 non-zero로 종료한다.

record에는 server `deploy/.env`, SSH key path, credential, raw remote log를 저장하지 않는다. 이 명령은 EC2 시작/중지, Compose 재기동, Git pull, rollback, checkpoint 또는 데이터 변경을 수행하지 않는다.

## 8. 로그 확인

전체 로그 tail:

```bash
scripts/deploy.sh logs
```

특정 service 로그 tail:

```bash
ASKLAKE_LOG_SERVICE=backend scripts/deploy.sh logs
ASKLAKE_LOG_SERVICE=caddy ASKLAKE_LOG_LINES=200 scripts/deploy.sh logs
```

## 9. 데모 데이터 Seed / Reset

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

## 10. 끄기

```bash
scripts/deploy.sh stop
```

이 명령은 가능한 경우 Compose service를 먼저 stop한 뒤 EC2를 stop한다.
EC2를 stop하면 instance compute 비용은 줄지만, EBS volume과 Elastic IP 같은 리소스 비용은 남을 수 있다.

## 11. 권장 개발 루프

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

## 12. 운영 원칙

- 서버 `deploy/.env`는 repo에서 관리하지 않는다.
- 배포 script는 서버 `.env`를 생성하거나 secret을 출력하지 않는다.
- OpenAI/API/domain 같은 서버 전용 env 값은 최초 bootstrap 뒤 서버 `deploy/.env`에 보존하며, 재배포는 이 파일을 덮어쓰지 않는다.
- 배포 실패 시 DB volume을 자동 reset하지 않는다.
- demo data reset은 별도 seed/reset 절차로만 실행한다.
- 정식 자동 배포는 이 runbook이 안정화된 뒤 GitHub Actions에서 같은 명령을 호출하도록 연결한다.
