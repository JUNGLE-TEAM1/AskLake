# AskLake EC2 배포 운영 Runbook

이 문서는 개발 중 EC2 배포 서버를 켜고, 재배포하고, 끄는 반복 절차를 정리한다.
정식 GitHub Actions 자동 배포 전에도 같은 절차를 로컬에서 실행할 수 있게 하는 것이 목표다.

Job A의 현재 진행 상태, Phase별 완료 기준, E2E 증거는 `docs/job-a-aws-deployment-e2e-playbook.md`에서 관리한다.

## 전제

- EC2, instance profile IAM Role, Elastic IP, Security Group, Docker, Docker Compose, 서버 `deploy/.env`는 최초 bootstrap에서 이미 준비되어 있어야 한다.
- 실제 AWS 계정 값, EC2 id, IP, domain, SSH key, secret은 repo에 커밋하지 않는다.
- 로컬 실행자는 AWS CLI와 SSH 접근 권한을 가지고 있어야 한다.
- 서버 repo는 기본적으로 `/opt/asklake`에 clone되어 있다고 가정한다.
- 서버 `deploy/.env`에는 Postgres/Mongo/OpenAI secret만 보존한다. AWS S3 access key/secret은 넣지 않고 EC2 IAM Role을 사용한다.

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

It checks the production Compose file, local Airflow orchestration Compose file, backend Python dependencies, backend Node connector dependencies, Docker CLI availability for the Spark runner, Spark image availability, Airflow image availability, Airflow DAG import, and the frontend production build image. If this fails, fix the declared dependency or env key before running `scripts/deploy.sh deploy`.

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
ASKLAKE_EXECUTION_API_TIMEOUT_SECONDS=930
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
  -> Postgres bootstrap + AWS S3 readiness
  -> docker compose up -d
  -> frontend/API health check
  -> docker compose ps
```

Production Compose에는 MinIO가 없다. 로컬 root Compose만 MinIO를 사용하고, EC2에서는 AWS S3를 사용한다.

### 3.1 AWS S3와 EC2 IAM Role 최초 준비

같은 리전에 public access가 차단된 bucket 네 개를 먼저 만든다. 이름은 AWS 전체에서 유일해야 하므로 실제 팀 prefix를 붙인다.

```text
<team>-asklake-raw
<team>-asklake-output
<team>-asklake-warehouse
<team>-asklake-query-results
```

EC2 instance profile policy에는 raw bucket 읽기와 output/warehouse/result bucket 읽기·쓰기·삭제 권한을 준다. Spark의 publish/rename, Iceberg, result cleanup, startup readiness 때문에 write bucket에는 `PutObject`, `GetObject`, `DeleteObject`, multipart 권한이 함께 필요하다. 아래 placeholder를 실제 ARN으로 바꾼다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListAskLakeBuckets",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": [
        "arn:aws:s3:::<team>-asklake-raw",
        "arn:aws:s3:::<team>-asklake-output",
        "arn:aws:s3:::<team>-asklake-warehouse",
        "arn:aws:s3:::<team>-asklake-query-results"
      ]
    },
    {
      "Sid": "ReadRawObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::<team>-asklake-raw/*"
    },
    {
      "Sid": "ManageAskLakeOutputs",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::<team>-asklake-output/*",
        "arn:aws:s3:::<team>-asklake-warehouse/*",
        "arn:aws:s3:::<team>-asklake-query-results/*"
      ]
    }
  ]
}
```

Docker container가 IMDSv2로 instance role credential을 받을 수 있도록 EC2 metadata option은 token required, hop limit 2로 둔다.

```bash
aws ec2 modify-instance-metadata-options \
  --region ap-northeast-2 \
  --instance-id i-xxxxxxxxxxxxxxxxx \
  --http-tokens required \
  --http-put-response-hop-limit 2 \
  --http-endpoint enabled
```

단일 EC2 demo에서는 backend, Spark, DuckDB, Trino container가 같은 instance role을 공유한다. 서비스별 S3 권한 분리가 필요한 운영 단계에서는 ECS task role 또는 개별 assume-role로 분리한다.

서버 `/opt/asklake/deploy/.env`의 object storage 값은 아래처럼 둔다.

```bash
ASKLAKE_OBJECT_STORAGE_PROVIDER=aws
AWS_REGION=ap-northeast-2
ASKLAKE_RAW_BUCKET=<team>-asklake-raw
ASKLAKE_SPARK_OUTPUT_MODE=s3a
ASKLAKE_SPARK_OUTPUT_BUCKET=<team>-asklake-output
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ALLOWED_BUCKETS=<team>-asklake-raw,<team>-asklake-output
ASKLAKE_S3_READINESS_READ_BUCKETS=<team>-asklake-raw
ASKLAKE_S3_READINESS_WRITE_BUCKETS=<team>-asklake-output,<team>-asklake-warehouse,<team>-asklake-query-results
VITE_OBJECT_STORAGE_PROVIDER=aws
VITE_S3_REGION=ap-northeast-2
TRINO_RESULT_STORAGE_BUCKET=<team>-asklake-query-results
TRINO_RESULT_STORAGE_PREFIX=query-results
TRINO_RESULT_STORAGE_AUTO_CREATE_BUCKET=false
```

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TRINO_RESULT_STORAGE_ACCESS_KEY`, `TRINO_RESULT_STORAGE_SECRET_KEY`는 production `.env`에 넣지 않는다. `aws-s3-readiness`는 backend/Trino 시작 전에 위 bucket의 head/list와 write bucket put/head/delete를 instance role로 확인한다.

Trino는 같은 Compose stack의 `trino_internal` network에서 실행한다. 외부에 포트를 열지 않고 backend가 CA 검증을 포함한 `https://trino:8443`으로 접근한다. Iceberg catalog metadata는 AskLake Postgres에, table data와 임시 query result는 서로 다른 private S3 bucket에 저장한다. Server `deploy/.env`에는 아래 값도 확인한다.

`trino-result-collector`는 backend와 같은 image/environment로 실행되는 별도 Compose worker다. API request가 아닌 worker만 Query Run과 materialization continuation을 소비하며, worker restart는 DB lease expiry를 통해 recover한다. `trino-result-cleanup`은 terminal result retention을 batch로 계속 정리한다.

```bash
TRINO_ENABLED=true
TRINO_BASE_URL=https://trino:8443
TRINO_CATALOG=iceberg
TRINO_SCHEMA=asklake
TRINO_USER=asklake-api
TRINO_QUERY_TIMEOUT_SECONDS=300
TRINO_RESULT_RETENTION_SECONDS=86400
TRINO_RESULT_CURSOR_SECRET=replace-with-a-long-random-production-secret
TRINO_QUERY_CONFIRMATION_SECRET=replace-with-a-long-random-production-secret
TRINO_QUERY_CONFIRMATION_TTL_SECONDS=300
TRINO_QUERY_WARNING_BYTES=1073741824
TRINO_QUERY_MAX_ESTIMATED_BYTES=0
TRINO_QUERY_ESTIMATED_THROUGHPUT_BYTES_PER_SECOND=268435456
TRINO_COLLECTOR_LEASE_SECONDS=60
TRINO_COLLECTOR_PAGES_PER_LEASE=100
TRINO_COLLECTOR_POLL_SECONDS=1
TRINO_CLEANUP_POLL_SECONDS=3600
TRINO_IMAGE=trinodb/trino:482
TRINO_AUTH_USERNAME=asklake-api
TRINO_AUTH_PASSWORD=replace-with-trino-backend-password
TRINO_MATERIALIZER_USERNAME=asklake-materializer
TRINO_MATERIALIZER_PASSWORD=replace-with-trino-materializer-password
TRINO_TLS_CA_FILE=/opt/asklake/secrets/trino-ca.pem
TRINO_TLS_KEYSTORE_FILE=/opt/asklake/secrets/trino-keystore.jks
TRINO_TLS_KEYSTORE_PASSWORD=replace-with-trino-keystore-password
TRINO_PASSWORD_FILE=/opt/asklake/secrets/trino-password.db
TRINO_INTERNAL_SHARED_SECRET=replace-with-base64-trino-shared-secret
TRINO_ICEBERG_CATALOG_NAME=asklake
TRINO_ICEBERG_JDBC_USER=asklake_trino
TRINO_ICEBERG_JDBC_PASSWORD=replace-with-trino-jdbc-password
TRINO_ICEBERG_WAREHOUSE_BUCKET=<team>-asklake-warehouse
TRINO_ICEBERG_WAREHOUSE_PREFIX=warehouse
```

`TRINO_ENABLED=false`는 DuckDB bounded compatibility runtime이다. Production에서 위 TLS/credential/bootstrap/readiness가 준비된 뒤에만 `true`로 켜며, `true`에서는 SQL 분석 실행이 곧 Trino full Query Run이다.

새 Postgres volume은 `deploy/postgres/init/02-create-iceberg-jdbc-catalog.sql`을 사용한다. 기존 volume을 포함한 모든 배포는 `trino-postgres-bootstrap`이 전용 JDBC role/password를 만들고 Iceberg metadata table 소유권을 해당 role로 멱등 이전한다. Trino JDBC catalog가 version schema를 확인·갱신하므로 단순 CRUD grant만으로는 부족하다. S3 bucket은 AWS에서 사전 생성하고 `aws-s3-readiness`가 권한을 검증하며 runtime은 bucket을 자동 생성하지 않는다. JDBC role은 Postgres application user와 달라야 한다.

Production Trino는 public port를 열지 않고 backend와만 공유하는 internal network에서 HTTPS/password authentication으로 실행한다. `internal-communication.https.required=true`와 shared secret으로 coordinator/worker 내부 통신도 인증·암호화한다. 아래 secret files는 서버에만 만들고 Git에 올리지 않는다.

```text
/opt/asklake/secrets/trino-ca.pem
/opt/asklake/secrets/trino-keystore.jks
/opt/asklake/secrets/trino-password.db
```

`trino-password.db`에는 bcrypt cost 8 이상(권장 10) 또는 PBKDF2 hash만 넣고, `asklake-api`와 `asklake-materializer` service account를 모두 등록한다. 일반 Query Run은 `asklake-api`, Iceberg CTAS는 `asklake-materializer` identity를 Basic auth와 `X-Trino-User`에 동일하게 사용한다. 실제 로그인 사용자는 AskLake audit actor로 별도 기록한다. File access control은 query identity에 SELECT/자기 query 실행만, materializer에 `asklake` schema CTAS/검증 권한만 허용한다. Trino JDBC identity는 application DB user와 분리하고 S3는 EC2 instance role을 사용한다.

```bash
htpasswd -B -C 10 -bn asklake-api '<query-password>' > /opt/asklake/secrets/trino-password.db
htpasswd -B -C 10 -bn asklake-materializer '<materializer-password>' >> /opt/asklake/secrets/trino-password.db
```

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
  -> Postgres 기동
  -> JDBC role/table bootstrap
  -> AWS S3/IAM readiness
  -> docker compose up -d --build
  -> Trino/backend/frontend health check
  -> Trino ACL/CTAS/result-storage readiness
  -> docker compose ps
```

`git pull --ff-only`가 실패하면 서버 작업 tree가 배포 branch와 다르다는 뜻이므로 자동으로 덮어쓰지 않고 실패시킨다.

배포 script가 호출하는 readiness를 서버에서 다시 확인하려면 아래 명령을 사용한다. 이 검증은 임시 Iceberg table과 result object를 성공 여부와 무관하게 정리한다.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml \
  exec -T backend python scripts/verify-trino-production-readiness.py
```

Trino를 켜기 전 S3만 다시 확인하려면 다음을 실행한다.

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml \
  run --rm aws-s3-readiness
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

S3 object sample이나 생성한 256 MiB 합성 데이터는 IAM 권한이 있는 shell에서 raw bucket으로 올린다.

```bash
aws s3 cp /path/to/generated-file.csv \
  s3://<team>-asklake-raw/synthetic-commerce/generated-file.csv
```

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
