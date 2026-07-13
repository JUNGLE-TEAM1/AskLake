# AskLake EC2 배포 운영 Runbook

이 문서는 개발 중 EC2 배포 서버를 켜고, 재배포하고, 끄는 반복 절차를 정리한다.
정식 GitHub Actions 자동 배포 전에도 같은 절차를 로컬에서 실행할 수 있게 하는 것이 목표다.

## 전제

- EC2, Elastic IP, Security Group, Docker, Docker Compose, 서버 `deploy/.env`는 최초 bootstrap에서 이미 준비되어 있어야 한다.
- 실제 AWS 계정 값, EC2 id, IP, domain, SSH key, secret은 repo에 커밋하지 않는다.
- 로컬 실행자는 AWS CLI와 SSH 접근 권한을 가지고 있어야 한다.
- 서버 repo는 기본적으로 `/opt/asklake`에 clone되어 있다고 가정한다.
- 서버 `deploy/.env`에는 Postgres/Mongo/OpenAI 값과 S3 bucket 이름만 보존한다. 장기 AWS access key/secret과 MinIO credential은 넣지 않는다.
- EC2에는 Raw list/read와 Output list/read/write/delete 권한을 가진 instance profile IAM Role을 연결한다. Container credential 전달을 위해 IMDSv2 token required, response hop limit 2를 사용한다.

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
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ALLOWED_BUCKETS=replace-with-asklake-raw-bucket,replace-with-asklake-output-bucket
ASKLAKE_S3_READINESS_READ_BUCKETS=replace-with-asklake-raw-bucket
ASKLAKE_S3_READINESS_WRITE_BUCKETS=replace-with-asklake-output-bucket
```

`aws-s3-readiness` one-shot service가 Raw bucket list와 Output bucket put/head/delete를 검증한다. Production frontend build는 Compose가 `ASKLAKE_SPARK_OUTPUT_BUCKET` 값을 `VITE_SPARK_OUTPUT_BUCKET`으로 전달해 Target 경로와 Spark 출력 경로를 일치시킨다. 이 검증이 실패하면 backend 시작도 실패해야 하며, bucket 자동 생성이나 static AWS key 추가로 우회하지 않는다. Warehouse와 Query Result bucket은 현재 runtime에서 사용하지 않는다.

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
  -> docker compose ps
```

`git pull --ff-only`가 실패하면 서버 작업 tree가 배포 branch와 다르다는 뜻이므로 자동으로 덮어쓰지 않고 실패시킨다.

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
