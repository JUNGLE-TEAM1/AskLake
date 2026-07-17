# 04. Development Guide

AI Gateway 로컬 실행과 backend/MCP 검증 명령은 [ai-gateway-mcp-rollout.md](./ai-gateway-mcp-rollout.md)를 참고한다.

이 문서는 AskLake 개발, 실행, 검증, 브랜치 작업 기준을 정리한다.

## 1) 로컬 실행

```bash
cd frontend
npm install
npm run dev
```

기본 dev server는 Vite 설정을 따른다.
macOS Homebrew 환경에서는 Vite 5 dev server를 Node 22 LTS로 실행하는 것을 권장한다. Node 26/Homebrew dependency mismatch와 Vite cold start 지연이 겹쳤던 원인 분석은 [frontend-dev-server-incident-analysis.md](./frontend-dev-server-incident-analysis.md)를 참고한다.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd frontend
npm run dev
```

Dashboard draft editor는 `react-grid-layout`과 `react-resizable`을 사용하므로 새 checkout에서는 `npm install`을 먼저 실행해야 한다.
Dashboard chart widget은 ApexCharts(`apexcharts`, `react-apexcharts`)를 사용한다. 현재 사용 목적은 부트캠프 파이널 프로젝트의 비영리 데모이며, 상업 배포나 제품화 단계로 전환될 경우 ApexCharts 공식 라이선스 조건을 다시 확인한다.
Dashboard runtime widget contract는 `metric`, `table`, ApexCharts 차트 8종을 기준으로 둔다. 색상은 문자열이나 팔레트 이름이 아니라 차트 config의 `color: { colors: string[] }` 배열을 사용한다. `metric`과 `table`에는 색상 config를 보내지 않으며, 향후 AI widget 생성 기능도 같은 type/config 계약을 사용한다. 지원 차트의 초기/동적 데이터 전환은 180ms animation을 사용하고 treemap은 기존처럼 animation을 끈다.
SQL 결과 위젯 설정도 별도 form이나 renderer를 만들지 않고 Dashboard runtime `WidgetConfigPanel`, `WidgetRenderer`, `DashboardDatasetOption` adapter를 재사용한다. SQL 화면은 SQL 결과와 선택 데이터셋을 설정 panel의 데이터 소스로 제공하되 Dashboard 저장 상태는 만들지 않는다.
Dashboard table widget은 chart renderer 전환 범위에 포함하지 않으며, 후속 작업에서 TanStack Table 기반으로 별도 전환한다.

## 2) 빌드

```bash
cd frontend
npm run test:trino-timeline
npm run verify:ui-regressions
npm run build
```

현재 package script는 TypeScript build와 Vite build를 함께 실행한다.
`npm run test:trino-timeline`은 `쿼리 실행 -> 첫 결과 준비 -> 전체 결과 수집` 단계의 순서, terminal/만료 상태, 2초 progress 지연, 실제 분자/분모 없는 bar 생략, manifest 마무리와 legacy timing fallback을 순수 상태 모델로 검증한다.

### 단계적 리팩토링 기준선

2026년 단계적 리팩토링은 [리팩토링 진행 원장](./refactor-2026/progress-ledger.md)의 순서와 rollback 경계를 따른다. 코드·계약 기준선을 다시 생성할 때는 저장소 root에서 아래 명령을 실행한다.

```bash
python3 scripts/refactor_audit/collect_baseline.py

# backend/requirements.txt의 mcp==1.28.1 때문에 Python 3.10 이상이 필요하다.
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
PYTHONPATH=backend backend/.venv/bin/python scripts/refactor_audit/export_openapi.py
```

수집기는 제품 코드를 import하지 않고 정량 지표와 정적 계약 JSON을 만든다. OpenAPI exporter만 FastAPI app을 import하며 network service를 시작하지 않는다. 생성물에는 timestamp, hostname, credential을 포함하지 않는다. 기준선 결과와 변경 전 실패는 [테스트 명령 지도](./refactor-2026/baseline/test-command-map.md)와 [기존 실패 목록](./refactor-2026/baseline/pre-existing-failures.md)에 기록한다.

최종 재감사와 release 준비는 [최종 감사](./refactor-2026/final-audit.md)와 [단계적 rollout·rollback runbook](./refactor-2026/operations/staged-rollout-and-rollback.md)을 따른다.

```bash
cd backend
npm run verify:refactor-final-audit
npm run verify:refactor-release-plan

# production 실행 직전 전용. 수동 증거가 없으면 exit 2가 정상이다.
npm run verify:refactor-release-execution
```

`verify:refactor-release-plan`은 network나 production state를 변경하지 않는다. production deploy, clean reboot, traffic promotion은 별도 운영 승인 없이는 실행하지 않는다.

ETL runtime 외부 I/O 경계를 변경할 때는 subprocess나 network service 없이 Port/Adapter unit과 기존 Continuous facade 회귀를 먼저 실행한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_runtime_io_ports \
  tests.test_kafka_continuous_dashboard_sync \
  tests.test_kafka_snapshot_iceberg \
  tests.test_continuous_maintenance_fencing -v
```

새 subprocess, raw runtime JSON read/write, Continuous manifest boto3 호출을 `etl_service.py`에 직접 추가하지 않는다. 호출·오류·rollback 계약은 [Runtime 외부 I/O Port·Adapter 계약](./refactor-2026/contracts/runtime-io-ports.md)을 따른다.

Continuous 명령 또는 reconciliation을 변경할 때는 application use case 테스트를 먼저 실행한다. durable intent commit 이전의 worker 제출, report 부재를 곧바로 `failed`로 만드는 판정, active fencing token과 다른 report 수용을 금지한다. 세부 순서와 복구 정책은 [Continuous 명령·Reconciliation Application 계약](./refactor-2026/contracts/continuous-command-reconciliation.md)을 따른다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_continuous_application_use_cases \
  tests.test_continuous_runtime_contract \
  tests.test_continuous_maintenance_fencing \
  tests.test_kafka_continuous_dashboard_sync -v
```

Continuous output·manifest·Catalog·Dashboard 발행을 변경할 때는 단계별 transaction과 재시도 테스트를 먼저 실행한다. Catalog와 Dashboard를 하나의 transaction으로 합치거나, Dashboard 실패 때문에 기존 Iceberg/Catalog 성공을 실패 처리하거나, 같은 batch retry에서 Spark output을 다시 만드는 변경을 금지한다. 상세 멱등 키와 복구 표는 [Continuous Materialization·Catalog·Dashboard 발행 계약](./refactor-2026/contracts/continuous-publication-workflow.md)을 따른다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_continuous_publication_workflow \
  tests.test_kafka_continuous_dashboard_sync \
  tests.test_dashboard_live_repository -v
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
```

Pipeline create/update, Snapshot command, SQL/Catalog publication을 변경할 때는 [Pipeline·Snapshot·SQL·Catalog Application 경계](./refactor-2026/contracts/pipeline-snapshot-sql-catalog-boundaries.md)를 먼저 확인한다. validation과 draft mapping을 `etl_service.py`에 다시 추가하거나 Snapshot command를 Continuous 상태 머신에 합치거나 SQL service가 ETL runtime/session을 직접 변경하는 변경을 금지한다. 최소 검증은 아래와 같다.

```bash
cd backend
.venv/bin/python -m unittest tests.test_pipeline_snapshot_catalog_boundaries -v
.venv/bin/python scripts/verify-etl-job-update-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-dataset-identity-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-rule-persistence-contract.py
.venv/bin/python scripts/verify-permission-create-flow-contract.py
```

`npm run verify:ui-regressions`는 timeline 상태 테스트와 ETL wizard 순차 이동 테스트를 먼저 실행한 뒤 SQL 분석의 Nessie Popover/Bubble/Collapsible 흐름, SQL editor 불변 높이, 결과 panel의 `차트 보기`/`데이터 미리보기`/`실행 정보` 전환, Trino cursor pagination과 server CSV, Dashboard `WidgetConfigPanel` 재사용, SQL 내부 Job wizard와 최근 UI 회귀 계약을 정적으로 확인한다.

ETL 생성 화면의 상위 단계 제목은 `EtlStepHeader`, 내부 섹션 제목은 `EtlSectionHeader`를 사용한다. 기본 섹션 헤더는 20px 제목, 44px 색상 타일과 22px 아이콘, 공통 여백을 유지하고 상태 차이는 타일과 옅은 배경 tone으로만 표현한다. 더 작은 탐색 하위 패널은 `EtlSectionHeader density="compact"`를 사용하며 화면별 전용 제목·아이콘 CSS를 새로 만들지 않는다.

ETL 화면의 표는 `DataTable`을 사용한다. 이 컴포넌트가 TanStack Table의 row/column model과 shadcn `Table` primitives를 함께 제공하므로, 미리보기·검증 결과·편집 셀도 별도 `<table>` 마크업을 만들지 않고 `ColumnDef`의 `cell` renderer로 구현한다. 화면별 스타일은 최소 너비, 말줄임, 상태 표현처럼 데이터 의미에 필요한 범위만 `tableClassName`, `viewportClassName`, column meta로 추가한다.
`npm run test:dashboard-live-refresh`는 published runtime의 Continuous dataset ID 중복 제거, `latestRevision > appliedRevision`인 widget 선택, 서버 polling 힌트의 1~60초 범위, 성공 widget만 기존 runtime에 병합하는 계약을 확인한다. partial 응답이 실제 전진했을 때만 250ms catch-up 대상이 되고 같은 revision을 다시 받으면 일반 주기로 돌아가는지도 검증한다.
SQL/Catalog pagination 변경 시에는 같은 script가 SQL 전체 snapshot의 페이지 조작, 편집기 단일 스크롤·빈 SQL 유지, Catalog schema/sample viewer와 새로고침·첫/마지막 page 연결을 함께 확인한다. Backend unit test는 10,000행 경계뿐 아니라 20,001행 결과의 마지막 page까지 검증해 총행 제한이 다시 생기지 않게 한다.

SQL run/Catalog row page의 backend 경계값은 전체 metadata를 초기화하는 `npm run verify`대신 다음 격리 unit test로 확인한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_sql_service_pagination \
  tests.test_catalog_dataset_rows
```

Trino Query Run protocol, storage, collector, registration, actor isolation은 프로젝트 가상환경에서 아래 명령으로 각각 확인한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-foundation
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:query-engine-registration
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-history
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-result-storage
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-collector-resilience
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-submission-guard
.venv/bin/python -m unittest tests.test_query_route_compatibility tests.test_trino_production_hardening -v
```

Production Compose의 Trino on/off profile, strict env/file/bucket/ACL guard와 기존 배포 호환성은 root에서 `bash tests/deploy/deploy-scripts-regression.sh`로 확인한다. 로컬 기존 PostgreSQL volume upgrade는 `docker compose run --rm trino-postgres-bootstrap`을 두 번 실행해도 같은 catalog table/owner/grant 상태를 유지해야 한다.
Spark runtime bind mount 변경은 `cd backend && npm run verify:spark-runtime-paths`와 `ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:production-spark`를 필수로 실행한다. Docker daemon이 있으면 `npm run verify:spark-runtime-paths:container`로 실제 UID 185 write/atomic rename, guard restart, 기존 report/checkpoint 보존까지 확인한다.
ETL Schedule 화면은 shadcn `Card`, `ToggleGroup`, `Field`, `Select`, `Switch`, `Separator`를 조합한다. 예전 `schedule-config-*` 전용 CSS와 중복 안내·상태 카드는 제거했으며, regression check는 실행 방식에 따른 조건부 필드와 저장 계약 문구가 다시 갈라지지 않는지 확인한다.
Dashboard CSS는 `dashboard.css`와 `dashboard-runtime.css` manifest가 책임별 하위 파일을 import한다. regression script는 로컬 CSS import를 같은 순서로 확장해 검사하므로 selector를 다른 모듈로 옮길 때 manifest 순서와 해당 check를 함께 유지한다.

Source schema의 JSON native type, legacy `Float` 호환, CSV fallback을 확인하고 Continuous dotted source path 계약을 검증할 때는 프로젝트 Python 가상환경을 사용한다.

```bash
cd backend
npm run verify:schema-type-contract
npm run verify:rule-compiler
npm run verify:snapshot-rule-conformance
npm run verify:snapshot-spark-pipeline
npm run verify:kafka-target-projection
npm run verify:target-mode-contract
npm run verify:kafka-continuous-contract
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-rules

cd ../frontend
npm run verify:rule-compiler
npm run verify:schema-transform-rules
```

backend의 `npm run verify:rule-compiler`는 FastAPI와 local Node compiler의 공통 fixture, canonical Rule DB 영속성, legacy fallback을 함께 검사한다. frontend의 같은 명령은 동일 fixture와 `canonicalParameters`를 통한 `0`, `false`, 빈 문자열, `null` 왕복을 확인한다. create/update/review 변경 시 explicit empty pass-through, output schema, 구조화된 validation issue가 유지돼야 한다.

`npm run verify:schema-transform-rules`는 Visual Transform의 rename/cast/default/null guard 순서, canonical parameter, portable operation, 초기 pass-through를 실제 adapter 함수로 검증한다.

`npm run verify:snapshot-rule-conformance`는 같은 JSON fixture를 Node Kafka runtime과 실제 Spark 4 DataFrame runtime에 적용해 실행 의미의 동등성을 검증한다. `npm run verify:snapshot-spark-pipeline`은 `spark_job_run.py`를 직접 실행해 drop/quarantine/set-null 결과가 Parquet에 반영되고 portable/SQL 혼합 `Fail Batch` target과 staging 경로가 남지 않는지 확인하며, 실제 JSONL `FileScanRDD` 로그를 세어 단일 cast transform-only Snapshot의 raw source action 예산도 회귀 검증한다. `npm run verify:kafka-target-projection`은 Job의 범용 JSON object 파싱, nested field projection, legacy review 필수 계약을 함께 확인하고 `npm run verify:target-mode-contract`은 mode별 layer/format 선제 검증을 확인한다. `npm run verify:kafka-review-scheduled-ingest`는 Job identity가 없는 direct JSONL compatibility 경로를 검증하고, Kafka Snapshot Job의 Iceberg/Catalog/offset E2E는 `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg`로 확인한다. Continuous 변경 시에는 `npm run verify:kafka-continuous-rules`와 `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-continuous-iceberg`로 Rule, checkpoint, Iceberg append/retry/Catalog 계약을 확인한다.

`npm run verify:spark-schema-contract`는 실제 Spark 4에서 필수 컬럼 1개와 10개를 검증할 때 내부 job 수가 동일한지 확인해, 컬럼별 action 대신 하나의 집계 action을 사용하는 계약을 검증한다. JSON/JSONL은 승인된 `schemaColumns`와 transform input path로 명시적 reader schema를 만들며, `properties.position` 같은 중첩 필드는 물리 target alias로 펼친다. DataFrame 생성 시 schema inference Spark job이 없어야 하고 null과 cast 실패가 있는 경우에는 기존과 같이 실패한 필수 컬럼 이름을 모두 보고하고 target write 전에 중단해야 한다.

## 3) Backend Live Mode

Catalog snapshot/delta projection의 순수 회귀 테스트는 공유 DB나 object storage를 사용하지 않는다.

```bash
cd backend
npm run verify:materialization-projection
```

프론트는 기본적으로 live backend API를 호출한다. local backend는 Postgres metadata DB를 필요로 한다. Trino SQL 수동 테스트에서는 backend와 result collector를 따로 실행하지 말고 아래 단일 명령을 사용한다. 이 스크립트는 실행 중인 MinIO의 Compose project를 재사용하고, Trino storage/catalog bootstrap을 멱등 실행한 뒤 backend와 collector에 같은 `DATABASE_URL`과 storage credential을 전달한다. 둘 중 하나가 종료되면 다른 프로세스도 함께 종료하므로 DB가 다른 collector만 남는 상태를 방지한다.
프론트 dev server는 같은 출처의 `/api` 요청을 FastAPI `http://127.0.0.1:8080`으로 proxy한다.

```bash
cd backend
npm install
DATABASE_URL=postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake \
  npm run dev:query-runtime
```

인프라와 bootstrap만 복구할 때는 root에서 `bash scripts/start-local-query-runtime.sh --prepare-only`, 현재 MinIO/Trino 연결만 확인할 때는 `bash scripts/start-local-query-runtime.sh --check`를 사용한다. 기존 backend가 8080을 사용 중이면 스크립트는 임의 종료하지 않고 실패한다.

로컬 Trino Query Run 결과 object는 `asklake-query-results` bucket에 gzip JSON으로 저장되고 DB에는 page metadata/checksum만 남는다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-foundation
```

브라우저 polling 없이 collector를 한 번만 실행할 때는 `npm run trino:collect-results`, 만료 결과를 one-shot 정리할 때는 `npm run trino:cleanup-results`를 사용한다. Production에서는 worker가 같은 작업을 계속 실행하며 DB lease/generation으로 재시작과 takeover를 복구한다. 실제 Iceberg 반복 갱신은 local stack에서 `ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-sql-job-e2e`로 확인한다.

일반 non-Kafka Spark batch, Kafka Snapshot과 Kafka Continuous Job은 backend-owned `icebergTarget`에 native Iceberg commit하고 Trino physical mapping 검증 뒤 Catalog를 확정한다. Job identity가 없는 direct ingest endpoint는 기존 JSONL 경로를 유지하므로 Iceberg `queryEngineTable`을 임의로 추가하지 않는다. writer별 전환 순서와 검증 경계는 [Iceberg Writer Migration Plan](iceberg-writer-migration-plan.md)을 따른다.

일반 Spark Iceberg writer의 실제 commit/replace/rollback 검증은 로컬 PostgreSQL, MinIO, Docker와 Trino가 실행 중일 때 아래처럼 수행한다. 이 검증은 고유 table을 만들고 종료 시 삭제하며 기존 Trino container를 재시작하지 않는다.

```bash
cd backend
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:spark-iceberg-batch

# Kafka Snapshot: commit 후 offset 직전 실패, 같은 snapshot retry, 중복 방지, empty run
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg
```

Spark 4 runtime에는 `ASKLAKE_SPARK_ICEBERG_PACKAGE`와 `ASKLAKE_SPARK_POSTGRES_PACKAGE`를 추가하며 기본값은 각각 Iceberg Spark 4 runtime과 PostgreSQL JDBC driver다. Spark와 Trino가 같은 JDBC catalog를 공유하므로 외부 Spark commit을 즉시 확인해야 하는 Trino catalog는 `iceberg.metadata-cache.enabled=false`를 사용한다.

```bash
cd backend
npm run verify:iceberg-writer-foundation

# Postgres + MinIO + Trino가 떠 있을 때 실제 고유 fixture append/replace commit
ASKLAKE_VERIFY_ICEBERG_LIVE=true \
TRINO_ENABLED=true \
TRINO_BASE_URL=http://localhost:8088 \
npm run verify:iceberg-writer-foundation
```

`frontend/.env` 또는 로컬 env에는 API base URL만 둔다.

```bash
VITE_API_BASE_URL=http://localhost:8080
```

Backend `DATABASE_URL`은 미설정 시 `postgres://asklake:asklake_dev@127.0.0.1:54328/asklake`를 사용한다. `npm run verify`와 `npm run verify:spark-run`은 검증 시작 시 metadata를 초기화하지만, 일반 `npm run dev`는 생성한 Job과 Dataset을 Postgres에 유지한다.

Kafka Continuous 대시보드의 table, unique constraint, revision/source range, partition watermark, widget result/state를 실제 PostgreSQL 16에서 확인할 때는 opt-in verifier를 사용한다. 스크립트는 고유 fixture를 만들어 같은 `run_id`, 다른 `run_id`의 같은 offset, 부분 겹침 거절, manifest/fingerprint/cursor와 결과 재조회를 확인한 뒤 자신이 만든 행을 정리한다.

```powershell
docker compose up -d postgres
cd backend
$env:ASKLAKE_VERIFY_DASHBOARD_POSTGRES = "true"
$env:DATABASE_URL = "postgresql+psycopg://asklake:asklake_dev@localhost:54328/asklake"
npm run verify:dashboard-live-postgres
```

### Local Airflow + Spark batch runtime

Airflow run polling과 실제 Spark batch를 확인하려면 AskLake backend와 별도로 local Airflow API server를 띄운다. Airflow는 `http://127.0.0.1:8081`에서 열리며 기본 계정은 local 전용 `airflow` / `airflow`다. `AIRFLOW_EXECUTION_API_TOKEN`은 Airflow task와 FastAPI에 같은 값을 설정하고 저장소나 로그에 운영 token을 남기지 않는다.

```bash
export AIRFLOW_EXECUTION_API_TOKEN=asklake-local-airflow-execution
docker compose up airflow-init
docker compose up -d airflow-apiserver airflow-scheduler airflow-dag-processor
curl -fsS http://127.0.0.1:8081/api/v2/monitor/health
```

FastAPI backend는 아래 환경변수를 준 뒤 재시작한다.

```bash
AIRFLOW_API_BASE_URL=http://127.0.0.1:8081
AIRFLOW_DAG_ID=asklake_etl_job
AIRFLOW_UI_BASE_URL=http://127.0.0.1:8081
AIRFLOW_USERNAME=airflow
AIRFLOW_PASSWORD=airflow
AIRFLOW_EXECUTION_API_TOKEN=asklake-local-airflow-execution
AIRFLOW_INTERNAL_TOKEN=asklake-local-airflow-token
ASKLAKE_SPARK_OUTPUT_MODE=s3a
ASKLAKE_DOCKER_NETWORK=asklake-dev_default
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ENDPOINT_IN_DOCKER=http://m3-minio:9000
MINIO_ACCESS_KEY=m3admin
MINIO_SECRET_KEY=wishuponastar
MINIO_BUCKET=asklake-output
```

`ASKLAKE_DOCKER_NETWORK`는 현재 Compose project의 실제 network 이름과 같아야 한다. 예를 들어 `docker compose -p asklake-dev`로 올렸다면 `asklake-dev_default`를 사용한다. FastAPI가 시작하는 Node/Spark subprocess에도 이 값이 전달되어야 하므로 `.env.local`만 Pydantic 설정으로 읽는 대신, 아래처럼 프로세스 환경으로 export한 상태에서 FastAPI를 실행한다.

로컬 MinIO 소스 연결에는 브라우저와 backend가 접근할 `http://127.0.0.1:9000`을 저장한다. Docker Spark 실행 시 이 loopback endpoint는 `MINIO_ENDPOINT_IN_DOCKER` 값으로 자동 치환된다. loopback이 아닌 명시적 endpoint는 사용자 설정을 그대로 유지한다.

내부 Data Lake source의 Catalog/Iceberg 검토 계약과 Spark source identity는 `cd backend && npm run verify:data-lake-iceberg-source`로 검증한다.

```bash
cd backend
set -a
source .env.local
set +a
./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080
```

헤더 없는 공백 구분 TXT의 조건부 레코드 구조화는 fixture와 계약 검증 후 실제 Airflow/Spark E2E로 확인한다. E2E는 실행 중인 FastAPI `:8080`, Airflow `:8081`, MinIO, Spark runtime을 사용하고 성공 시 생성한 임시 Job, Catalog row, Parquet output을 정리한다.

```bash
cd backend
npm run minio:seed-click-log
npm run verify:record-parsing
npm run verify:record-parsing:e2e
```

Local Compose의 Airflow task에는 backend URL과 `AIRFLOW_EXECUTION_API_TOKEN` 기반 bearer token이 주입된다. `AIRFLOW_INTERNAL_TOKEN`은 기존 단일 호출 endpoint 호환용으로 함께 유지한다. 그 다음 `수집/처리` 화면에서 Job 실행 버튼을 누르면 `spark_process_write`가 실제 Spark runner와 Iceberg commit을 실행하고, `publish_run_result`가 Trino table/snapshot/data-file mapping을 검증해 Catalog를 확정한다. Run History와 DAG modal은 `GET /api/etl/jobs/{jobId}` polling으로 DAG Run/Task Instance 상태를 반영한다.

실행 중인 local Airflow 자체의 DAG 발견/import error/성공 Run/강제 실패 Run을 한 번에 확인할 때는 아래 smoke를 실행한다.

```bash
cd backend
AIRFLOW_API_BASE_URL=http://127.0.0.1:8081 \
AIRFLOW_DAG_ID=asklake_etl_job \
AIRFLOW_USERNAME=airflow \
AIRFLOW_PASSWORD=airflow \
npm run verify:airflow-smoke
```

AskLake backend의 `run` 접수, 실제 PySpark 처리, MinIO Parquet, terminal polling/task state 동기화를 확인하려면 `asklake-output` bucket을 준비하고 같은 Airflow/Spark 환경변수와 Python interpreter로 아래 검증을 실행한다.

```bash
cd backend
AIRFLOW_API_BASE_URL=http://127.0.0.1:8081 \
AIRFLOW_DAG_ID=asklake_etl_job \
AIRFLOW_UI_BASE_URL=http://127.0.0.1:8081 \
AIRFLOW_USERNAME=airflow \
AIRFLOW_PASSWORD=airflow \
AIRFLOW_EXECUTION_API_TOKEN=asklake-local-airflow-execution \
ASKLAKE_SPARK_OUTPUT_MODE=s3a \
MINIO_ENDPOINT=http://127.0.0.1:9000 \
MINIO_ENDPOINT_IN_DOCKER=http://m3-minio:9000 \
MINIO_BUCKET=asklake-output \
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python \
npm run verify:airflow-spark
```

품질 실패 전파는 같은 명령에 `ASKLAKE_FASTAPI_ETL_EXPECT_SPARK_FAILURE=true`를 추가해 확인한다. 검증 fixture의 음수 amount가 `Fail Run` 규칙에 걸리면 Spark manifest, Airflow DAG Run, AskLake Run/Job이 모두 `failed`가 되고 대상 Catalog dataset은 생성되지 않아야 한다.

CSV의 quoted comma, doubled quote, 값의 시작·끝 큰따옴표, 큰따옴표 한 글자가 Spark read와 Parquet write 뒤에도 보존되는지는 실제 Spark 4 container로 검증한다.

```bash
cd backend
npm run verify:spark-csv-quoting
```

현재 `asklake_etl_job`은 `receive_asklake_run -> validate_spark_request -> spark_process_write -> publish_run_result`로 실행된다. 실제 source read/transform/quality/Parquet write는 PySpark가 담당한다. 실제 Spark mode의 `publish_run_result`는 저장된 성공 manifest를 `POST /api/internal/airflow/spark-runs/{runId}/catalog`로 멱등 반영하고, 그 commit 뒤에만 DAG Run을 성공시킨다. 독립 Airflow runtime 확인용 `executionMode=smoke`는 실제 Job/Run/Parquet가 없으므로 Catalog 호출을 건너뛴다.

Live frontend는 같은 Run id를 `queued` 또는 `running`으로 관찰한 뒤 `success`가 된 경우에만 `GET /api/catalog/datasets`를 한 번 다시 호출한다. 실행 버튼 직후의 optimistic 상태에서 서버의 이전 성공 Run을 읽더라도 조기 refresh하지 않는다. Catalog 재조회만 실패한 경우에는 이미 확정된 Job/Run 성공을 되돌리지 않고 기존 목록과 수동 새로고침 안내를 유지한다. Job 목록의 실행 관측 모달은 열 때 받은 객체 snapshot을 고정하지 않고 `jobId`와 `runId`로 중앙 polling이 갱신한 최신 Job/Run을 다시 찾아 표시한다. 별도 모달 polling을 만들지 않으므로 terminal 중단, 연속 오류 안내, Catalog 갱신 정책은 기존 단일 poller가 계속 소유한다. 정적 연결과 production build는 `cd frontend && npm run verify:ui-regressions && npm run build`로 확인한다.

DAG에서 Catalog endpoint를 호출하는 경로, 인증 header/body, smoke 우회, Run identity mismatch, Catalog HTTP 실패 전파를 외부 runtime 없이 확인할 때는 아래 명령을 실행한다.

```bash
cd backend
npm run verify:airflow-catalog-wiring
```

Phase 3 FastAPI Catalog endpoint의 transaction과 실패 계약은 아래 명령으로 검증한다. script는 고유 fixture를 만들고 종료 시 정리한다. 같은 Run 중복 방지, 두 번째 Run append, local/S3 physical evidence, Spark 미완료, identity mismatch, output 부재, 강제 transaction rollback, stale polling 동시성, Airflow sync 후 failure evidence 보존을 확인한다.

```bash
cd backend
DATABASE_URL=postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake \
PYTHONPATH=. .venv/bin/python scripts/verify-airflow-catalog-reconciliation.py
```


대시보드 draft editor의 AskLake 보조 패널과 시각화 요청 위젯은 아래 optional 값으로 Assistant API 경로를 지정한다.
현재 FastAPI는 `POST /api/dashboards/assistant`에서 DB runtime/catalog 컨텍스트를 모아 OpenAI Responses API를 호출한다.

```bash
# VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant
```

대시보드 데이터셋 사이드바와 Assistant는 `GET /api/catalog/datasets` 기준의 available catalog dataset을 함께 사용한다.
로컬 PostgreSQL에 대시보드 demo dataset이 없으면 아래 seed를 먼저 실행한다.
이 seed에는 커머스 데모용 `commerce_orders_daily`, `commerce_marketing_spend_daily`, `gold_commerce_channel_roi` dataset이 포함되어 Catalog와 Dashboard 흐름을 바로 확인할 수 있다.

```bash
cd backend
.venv/bin/python -m app.seed.seed_dashboard_demo
```

OpenAI API key는 프론트가 아니라 backend env에만 둔다. 로컬에서는 `backend/.env` 또는 실행 환경에 아래 값을 둔다.
`OPENAI_API_KEY`가 없거나 `OPENAI_ASSISTANT_ENABLED=false`이면 backend는 응답에 `mock fallback`을 명시한 fallback 응답을 반환한다.
Assistant guard는 OpenAI가 없는 컬럼/부적절한 값축을 반환해도 catalog schema와 sample rows 기준으로 보정한다. 차원 컬럼만 제시된 요청은 `count` 집계 차트로, 매출/금액 지표가 포함된 요청은 `revenue`/`total_amount` 같은 실제 수치 컬럼으로 보정한다. OpenAI 응답이 비어 있으면 요청 문장과 available dataset 기준의 기본 막대 차트 action을 생성한다.

```bash
OPENAI_API_KEY=sk-...
OPENAI_ASSISTANT_ENABLED=true
OPENAI_ASSISTANT_MODEL=gpt-4o-mini
OPENAI_ASSISTANT_MAX_OUTPUT_TOKENS=1200
OPENAI_ASSISTANT_MAX_SAMPLE_ROWS=5
OPENAI_ASSISTANT_TIMEOUT_SECONDS=20
```

```bash
cd backend
npm run verify:dashboard-assistant-guard
```

Source/Schema/Create/Run 흐름은 항상 live backend 기준으로 검증한다. run/retry 명령은 Airflow 접수 직후 non-terminal 상태를 응답하고, 프론트는 `GET /api/etl/jobs/{jobId}` polling으로 Airflow task와 Spark 처리 완료 상태를 반영한다. 백엔드가 꺼져 있으면 연결 실패 상태를 확인하고, 백엔드를 켠 뒤 실제 connector와 Spark run 경로로 재검증한다.

Job 목록의 query/facet/legacy 상태 정규화는 외부 인프라 없이 `cd backend && npm run verify:job-list`로 먼저 확인한다. Target 표시명과 내부 ID 분리는 `cd backend && npm run verify:dataset-identity`로 확인하며, 서로 다른 한글 이름과 같은 ASCII slug를 만드는 이름이 별도 Job으로 남고 정확히 같은 target만 append 재사용되는지 검증한다. 전체 `npm run verify`는 PostgreSQL, MinIO, REST fixture를 포함한다.

### AI 활용 UI Skeleton

`AI 활용` 메뉴의 대화형 화면은 현재 UI-only 범위다. 실제 OpenAI/RAG runtime을 호출하지 않으며, 질문을 전송하면 사용자 메시지와 `AI runtime 연결 대기` 상태만 표시한다. 답변, 근거, SQL, 결과 미리보기는 가짜 데이터로 만들지 않는다.

수동 확인은 다음 순서로 한다.

1. `AI 활용` 메뉴를 열어 empty state와 composer가 겹치지 않는지 확인한다.
2. `데이터셋 선택`에서 `available`이며 query 권한이 있는 Catalog Dataset을 선택한다.
3. 추천 질문을 누르거나 질문을 입력한 뒤 Enter로 전송한다. Shift+Enter는 줄바꿈으로 유지돼야 한다.
4. 질문 카드에 선택 Dataset 이름이 보이고, 응답 카드는 `AI runtime 미연결`만 보이는지 확인한다.
5. `새 대화`를 눌러 빈 대화가 목록에 추가되는지 확인한다. 새 대화에는 Dataset context가 복사되지 않아야 한다.
6. 대화 항목 위에 마우스를 올려 삭제 아이콘이 보이는지 확인하고, 삭제 후 다음 대화로 전환되는지 확인한다. 마지막 대화를 삭제하면 빈 대화 하나가 유지되어야 한다.
7. 이전 대화를 다시 선택해 질문, Dataset context, runtime 미연결 상태가 복원되는지 확인한다.
8. Dataset selector가 Escape와 바깥 클릭으로 닫히고, Tab으로 checkbox focus를 확인할 수 있는지 확인한다.

```bash
cd frontend
npm run verify:ui-regressions
npm run build
```

생성된 Job의 수정 hydrate 계약은 아래 명령으로 별도 확인한다. 이 검증은 Kafka source와 schema/rule/permission/target metadata가 `GET /api/etl/jobs/{jobId}` 형태의 `JobRowData`로 다시 나오는지 확인한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
```

브라우저에서는 생성된 Kafka Job의 `수정`을 열어 broker, topic, consumer group 값이 저장된 값으로 표시되고 편집할 수 없는지 확인한다. 목록에서 다른 Job의 `수정`을 직접 선택한 경우에도 해당 Job이 상세 기준으로 선택되고, 성공 Run 유무에 맞춰 target identity 잠금이 적용돼야 한다. Review 단계의 `변경사항 저장`은 기존 Job을 update하며 새 Job을 만들지 않아야 한다.

수정 저장은 같은 Job ID에 반영되는지 확인한다. target identity를 바꾸지 않은 상태에서 transform, schedule 또는 permission을 수정하고 `변경사항 저장`을 누른 뒤 작업 상세로 돌아가 Job ID와 Kafka source 값이 유지되는지 확인한다. 실행 중인 Job과 성공 Run이 있는 Job의 target identity 변경은 각각 오류로 차단돼야 한다.

성공 Run이 있는 Job을 수정할 때는 Target 화면의 데이터셋명, DB, 포맷, 저장 경로가 읽기 전용으로 보이는지 확인한다. 설명, 태그, 파티션은 수정할 수 있어야 하며 Source 단계의 `이전`은 변경을 버리고 작업 상세로 돌아가야 한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py
```

이 검증은 source field 요청 거부, source config 보존, 성공 Run 이후 target identity 변경 차단, 실행 중 update 차단을 함께 확인한다.
MongoDB Source connector는 Node MongoDB driver로 컬렉션 목록과 제한 문서 샘플을 조회한다. backend live mode 환경에는 `backend/package.json`의 `mongodb` dependency가 설치되어 있어야 하며, MongoDB Shell(`mongosh`)은 connector 실행 조건이 아니다.
PostgreSQL과 MongoDB Source QA에서는 연결 테스트 직후 schema가 생기지 않는지 먼저 확인한다. 데이터 탐색에서 테이블 또는 컬렉션을 선택한 뒤에만 제한 샘플과 schema가 표시되어야 하며, 선택값 없는 `/api/etl/sources/test` 요청은 `400`으로 거부되어야 한다.
Job 실행 중 새로고침했을 때 수집/처리 목록 대신 `DB 데이터를 불러오는 중입니다` 화면이 오래 남는 증상은 [job-refresh-loading-incident-analysis.md](./job-refresh-loading-incident-analysis.md)를 참고한다.

### Amazon review Kafka fixture

Kafka replay와 ingest pipeline 작업자는 실제 6.6GB Amazon review replay가 준비되기 전에도 같은 메시지 계약으로 병렬 개발할 수 있다. 로컬 Redpanda를 켠 뒤 review fixture producer를 실행한다.

```bash
cd backend
npm run kafka:reviews-fixture:generate -- --count 100
ASKLAKE_WITH_KAFKA=true ASKLAKE_RECREATE_KAFKA=true npm run sources:fixtures
npm run kafka:reviews-fixture
```

기본 broker와 topic은 `127.0.0.1:19092`, `reviews.raw`이다. 기본 fixture는 `backend/fixtures/kafka/amazon-review-fixture.jsonl`에 100건 mock review로 유지한다. producer는 이 fixture 또는 실제 Amazon review JSONL/JSONL.gz 파일을 스트리밍으로 읽어 `schema_version`, `event_id`, `source`, `offset`, `review`, `created_at`, `raw` top-level 필드를 가진 JSON 메시지를 전송한다. A/B 최소 필수 필드는 `event_id`, `review`, `offset`, `created_at`이며, B ingest는 빠진 `schema_version`, `source`, `raw`를 표준 shape로 보강한다.

Kafka 없이 fixture 계약만 확인하려면 아래처럼 실행한다.

```bash
cd backend
node scripts/seed-kafka-review-fixture.mjs --dry-run
npm run kafka:reviews-replay -- --dry-run --limit 100
```

실제 replay 입력 파일을 지정할 때는 `--input`을 사용한다. Amazon review 원본 row는 `reviewText`, `unixReviewTime`, `reviewTime`을 표준 필드로 정규화하며, 원본 row 전체는 `raw`에 보존한다.

```bash
cd backend
npm run kafka:reviews-replay -- --input /path/to/amazon_reviews.jsonl.gz --limit 100 --rate 100
```

배포 환경의 클릭 로그를 Kafka Continuous 입력으로 재사용할 때는 raw S3 object를 서버의 허용된 replay 디렉터리로 내려받는다. 레코드 구조화 데모에서는 변환 CLI를 거치지 않고 `payloadMode=raw_text`로 10필드 원문 줄을 그대로 전송한다. 기존 JSON envelope 회귀 검증이 필요할 때만 아래 변환 CLI로 `raw.*` 필드를 가진 JSONL을 만든다.

```bash
aws s3 cp s3://<raw-bucket>/commerce/click-events.log /var/lib/asklake/replay-input/click-events.log

# 레코드 구조화 데모: 원문 한 줄을 Kafka value로 그대로 전송
curl -X POST https://<asklake-host>/api/etl/kafka/replay-producer \
  -H 'Content-Type: application/json' \
  -b '<session-cookie>' \
  -d '{
    "topic": "synthetic-commerce.click-events.raw",
    "inputPath": "click-events.log",
    "payloadMode": "raw_text",
    "rate": 100,
    "batchSize": 100,
    "loop": false
  }'

# 기존 JSON envelope 회귀 검증 경로
cd backend
npm run kafka:click-log:convert -- \
  --input /var/lib/asklake/replay-input/click-events.log \
  --output /var/lib/asklake/replay-input/click-events.kafka.jsonl
npm run kafka:reviews-replay -- \
  --broker redpanda:9092 \
  --topic click-events.raw \
  --input /var/lib/asklake/replay-input/click-events.kafka.jsonl \
  --rate 1000 \
  --batch-size 1000
```

주요 옵션:

```txt
--input <path>          기본 fixture 대신 사용할 JSONL 또는 JSONL.gz 파일
--topic <topic>         기본값 reviews.raw
--broker <host:port>    기본값 127.0.0.1:19092
--limit <count>         생략하면 전체 replay
--rate <count>          초당 전송 메시지 수 제한
--batch-size <count>    Kafka send batch 크기, 기본값 100
--loop                  파일 끝에서 다시 시작하며 cycle별 고유 event_id/offset을 생성
--max-cycles <count>    loop replay의 최대 cycle 수
--max-messages <count>  전체 replay의 최대 메시지 수
--cycle-delay-ms <ms>   loop cycle 사이 대기 시간
--burst-min-messages <n> / --burst-max-messages <n> / --burst-interval-seconds <n>
                         loop mode에서 interval마다 랜덤 n건을 빠르게 전송하는 burst mode
--recreate-topic        시작 전에 topic을 삭제하고 다시 생성(명시적 요청만)
--dry-run               Kafka 전송 없이 메시지 계약만 검증
--no-recreate-topic     기존 topic을 삭제하지 않고 사용(기본값)
```

`--loop`는 실행별 run ID, cycle, stream offset을 조합해 envelope `event_id`와 원본 `raw.event_id`/`raw.eventId`를 고유하게 만든다. Continuous merge key가 envelope 또는 nested source event ID인 파이프라인 모두에서 반복 데이터가 기존 행 upsert로 소거되지 않고 새 이벤트로 누적되며, producer를 재시작해도 이전 실행의 ID와 충돌하지 않는다.

Continuous 적재를 눈으로 확인하려면 낮은 rate로 loop producer를 실행한다. 기본 실행은 topic을 보존하므로 이미 실행 중인 Continuous worker의 checkpoint를 훼손하지 않는다.

```bash
cd backend
npm run kafka:reviews-loop -- --topic reviews.raw --rate 2 --max-cycles 5
```

Continuous trigger와 같은 cadence를 재현하려면 burst mode를 쓴다. 아래는 10초마다 500~1,000건을 Kafka에 넣는다.

```bash
npm run kafka:reviews-loop -- --topic reviews.raw --burst-min-messages 500 --burst-max-messages 1000 --burst-interval-seconds 10
```

배포 Compose에서는 Kafka broker가 내부 `redpanda:9092`만 노출되므로 backend API를 사용한다. `POST`/`DELETE`는 admin `manage` 권한이 필요하며, producer 하나만 동시에 실행할 수 있다. 기본 fixture 외 대용량 `.jsonl`/`.jsonl.gz`를 쓰려면 host의 `ASKLAKE_REPLAY_HOST_INPUT_DIR`에 파일을 두고 body의 `inputPath`에 상대 경로를 넣는다.

```bash
curl -X POST "$ASKLAKE_API_URL/api/etl/kafka/replay-producer" \
  -H 'Content-Type: application/json' \
  -H 'X-AskLake-Role: admin' \
  -d '{"topic":"reviews.raw","rate":2,"loop":true,"maxMessages":500}'

curl -H 'X-AskLake-Role: admin' "$ASKLAKE_API_URL/api/etl/kafka/replay-producer"
curl -X DELETE -H 'X-AskLake-Role: admin' "$ASKLAKE_API_URL/api/etl/kafka/replay-producer"
```

Kafka Source -> direct target -> Catalog 등록 -> schedule tick 계약까지 한 번에 확인하려면 아래 smoke를 실행한다. 이 스크립트는 고유 `reviews.raw.verify.*` topic에 100건 fixture를 넣고, due 상태의 Kafka ETL Job을 만든 뒤 `/api/etl/schedules/run-due`로 실행해 다음 예약 시각이 advance되는지까지 확인한다. 이 smoke는 durable snapshot range 재사용, 실패 후 capture 이후 메시지 append, malformed payload raw quarantine, custom Regex quality parameter, `Fail Run` offset 미커밋, failed Job Run/DAG, 2개 partition의 독립된 max range/offset commit, target write 뒤 Catalog 실패 후 idempotent retry까지 함께 검증한다.

Snapshot Rule 실행 변경 후에는 위 smoke와 함께 `npm run verify:snapshot-rule-conformance`, `npm run verify:snapshot-spark-pipeline`을 실행한다. 첫 명령은 언어별 의미를 비교하고, 둘째 명령은 실제 Spark target publication 순서를 검증한다.

Kafka Continuous Ingestion은 Issue #500 Phase 3에서 long-running Spark Structured Streaming worker까지 연결됐다. Snapshot Job은 wizard의 스케줄 단계에서 수동/반복 실행을 고르고, Continuous Job은 해당 단계를 건너뛰어 생성 후 스트림 시작/중지로 제어한다. Continuous Source 고급 설정은 시작 위치, trigger 간격, micro-batch 최대 메시지를 제공한다. production-like smoke에서는 continuous Job 시작, retained backlog 처리, 새 이벤트 자동 append, pause/resume API 호환, checkpoint restart, lag/heartbeat, conflicting consumer identity `409`을 검증한다. Snapshot smoke는 계속 유지하며 Continuous 검증으로 대체하지 않는다.

`verify:continuous-runtime-contract`는 command 전이표, desired/observed/public projection, command revision, worker fencing, legacy hydrate, 단계별 오류와 frontend stale polling 차단을 검증한다. 보호 범위와 아직 opt-in인 live 장애 시험은 [Characterization Test Matrix](refactor-2026/testing/characterization-matrix.md)에 기록한다. `verify:kafka-continuous-contract`는 long-running worker를 시작하지 않고 Continuous Job의 기본 config/runtime identity, Rule payload/fingerprint, PostgreSQL partition cursor의 worker 전달, start request 상태와 충돌 정책, stream publication manifest/batch identity gate, 종료 report의 stale window/S3 manifest 복구, replay Catalog 재조정, 로컬 result 유실 시 S3 replay manifest 복구와 pending replay start/resume `409` 차단을 확인한다. backend unit test는 전체·부분 offset 중복 필터, durable publication 순번, exact snapshot Run 행 수, replay manifest 실패 rollback과 `count`/`sum`/`avg`의 full baseline, Iceberg `_asklake_run_id` revision catch-up, backfill/legacy full fallback을 확인한다. `verify:kafka-continuous-rules`는 독립 Docker Spark에서 bounded micro-batch Rule 의미와 checkpoint contract를 실행한다. Kafka/MinIO/Catalog를 포함한 실동작은 production-like smoke에서 별도로 확인한다.

```bash
cd backend
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
```

Phase 2부터 prod-like Compose는 내부 broker `redpanda:9092`를 제공한다. 이 broker는 Snapshot fixture와 이후 Continuous Spark worker가 같은 Docker network에서 사용할 endpoint이며, 외부 Kafka endpoint를 쓰려면 배포 env에서 `ASKLAKE_KAFKA_BROKER`를 바꾼다.
ETL 생성 화면은 `GET /api/etl/sources/defaults`에서 backend의 비밀이 아닌 Kafka broker/topic과 S3 bucket/prefix 기본값을 읽는다. 이 값은 새 빈 Source draft에만 한 번 채우고 저장된 draft나 사용자가 편집한 값은 덮어쓰지 않는다. 로컬 Kafka broker 기본값은 `127.0.0.1:19092`, prod-like Compose 기본값은 `redpanda:9092`이며 frontend build 변수로 같은 값을 중복 관리하지 않는다.
Kafka 소스 연결 테스트는 새 샘플 consumer group이 첫 메시지를 받을 때까지 `ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS`(기본 8초)를 기다린다. 첫 메시지 이후 `ASKLAKE_KAFKA_SAMPLE_MIN_MESSAGES`(기본 3건)에 도달하면 `ASKLAKE_KAFKA_SAMPLE_IDLE_MS`(기본 0.5초) idle window로 종료한다. 최소 건수에 도달하지 못한 희소 topic은 `ASKLAKE_KAFKA_SAMPLE_SETTLE_MS`(기본 1.5초)까지만 추가 메시지를 기다린 뒤 현재 샘플을 반환한다.

Continuous worker는 Spark 4.0.1/Scala 2.13 Kafka connector를 사용한다. Production은 `ASKLAKE_SPARK_RUNNER=rest`로 내부 Spark Standalone REST submission을 사용하고 backend에 Docker socket/CLI를 요구하지 않는다. 로컬 개발에서만 `ASKLAKE_SPARK_RUNNER=docker`를 명시해 격리 worker/maintenance container를 실행할 수 있다. 두 경로 모두 같은 Iceberg/JDBC/warehouse package와 runtime environment 계약을 사용한다.

Production-like Continuous E2E는 Compose를 먼저 올린 뒤 opt-in으로 실행한다. retained backlog, schema/Rule quarantine, Transform/Quality 카운터, Rule-aware replay, 신규 이벤트, pause/resume, worker kill 후 checkpoint restart, Catalog fingerprint materialization, duplicate-free counter를 검증한다. worker 시작 시 target `s3a://` bucket은 MinIO에 없으면 자동 생성된다. 사용자 요청으로 인한 pause/stop의 SIGTERM 종료는 각각 `paused`/`stopped`로 처리하고, 요청 없이 종료된 worker만 `failed`가 된다.

Iceberg writer 자체의 격리 검증은 기존 서비스 전체를 올리지 않고 고유 Redpanda/Trino/Spark를 시작한다. 정상 append, Iceberg commit 뒤 manifest 전 fault, 같은 boundary 재사용, checkpoint restart, append 중 Trino snapshot read, maintenance 전후 현재 row count와 과거 snapshot time-travel을 검증하고 종료 시 table/container/metadata를 정리한다.

```bash
cd backend
ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-continuous-iceberg
```

Backend는 `CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS`(기본 1초, 허용 범위 1~60초)마다 active Continuous worker report를 동기화한다. 이 control-plane sync가 Catalog materialization을 수행하므로 Job 목록/상세 조회가 없어도 적재 batch가 Catalog에 등록된다. Worker는 target의 `_batch-manifests/batch_id=*`에 valid/quarantine count를 함께 기록하고, 재시작 때 이 manifest를 읽어 runtime counter를 복구한다.

작은 Kafka Continuous micro-batch는 일반 batch workload와 별도로 `ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS`(기본 4)와 `ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL`(기본 `WARN`)을 사용한다. 기존 checkpoint의 `OffsetSeqMetadata`가 과거 shuffle 값을 복원하더라도 worker는 각 `foreachBatch` 시작에서 Continuous 값을 다시 적용한다. Catalog ACK가 전진할 때 worker는 전체 manifest 이력을 다시 스캔하지 않고 메모리의 bounded publication window를 이동한 뒤 부족한 다음 구간만 한 번에 읽는다. 이 설정은 오래 실행된 stream에서 ACK 처리 비용이 누적 batch 수에 비례해 증가하는 것을 막는다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_E2E=true \
ASKLAKE_CONTINUOUS_E2E_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_CONTINUOUS_ENV_FILE=../deploy/.env \
ASKLAKE_CONTINUOUS_COMPOSE_FILE=../deploy/docker-compose.prod.yml \
npm run verify:kafka-continuous-e2e
```

설정 가능한 장시간 harness는 기본 1,000건 synthetic smoke로 시작한다. `ASKLAKE_CONTINUOUS_SOAK_INPUT`에 `.jsonl` 또는 `.jsonl.gz`를 주면 파일을 메모리에 모두 올리지 않고 line 단위로 Kafka에 replay한다. `ASKLAKE_CONTINUOUS_SOAK_COUNT`, `ASKLAKE_CONTINUOUS_SOAK_RATE`, `ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE`, `ASKLAKE_CONTINUOUS_SOAK_MALFORMED_PERCENT`, `ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE_AT`으로 범위를 조절한다. `ASKLAKE_CONTINUOUS_SOAK_FAULT=worker|backend|kafka|minio`는 한 번의 장애를 주입하며 `FAULT_AFTER`, `FAULT_DURATION_MS`로 시점과 지속 시간을 정한다. 기존 `ASKLAKE_CONTINUOUS_SOAK_KILL_WORKER=true`도 `worker` alias로 유지한다. 기본적으로 적재 중 Catalog rows endpoint를 1초마다 조회해 Iceberg row count가 감소하지 않는지 검증하며 `ASKLAKE_CONTINUOUS_SOAK_CONCURRENT_READ=false`로만 끌 수 있다. `ASKLAKE_CONTINUOUS_SOAK_READ_INTERVAL_MS`로 주기를 조절한다. `ASKLAKE_CONTINUOUS_SOAK_COMPACT=true`는 reconciliation 뒤 worker를 중지하고 Iceberg rewrite, Trino 검증과 논리 row count 불변성까지 수행한다. 6.47GB 전체 replay는 CI가 아니라 이 opt-in 수동 soak로 실행한다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true \
ASKLAKE_CONTINUOUS_SOAK_COUNT=1000 \
ASKLAKE_CONTINUOUS_SOAK_RATE=500 \
ASKLAKE_CONTINUOUS_SOAK_KILL_WORKER=true \
npm run verify:kafka-continuous-soak
```

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true \
ASKLAKE_CONTINUOUS_SOAK_INPUT="$HOME/Downloads/Electronics.jsonl.gz" \
ASKLAKE_CONTINUOUS_SOAK_RATE=1000 \
ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE=500 \
npm run verify:kafka-continuous-soak
```

Job 상세의 Continuous Runtime은 partition lag, 처리량, schema drift, Rule fingerprint/경고/격리/실패 카운터와 bounded/redacted worker log를 표시한다. Quarantine inspection/replay와 Iceberg maintenance는 worker를 일시정지하거나 중지한 상태에서 실행한다. Worker start/resume과 maintenance 시작은 같은 Job/runtime row lock 순서로 직렬화된다. Replay는 Lake의 격리 Parquet를 읽어 Iceberg target의 `partition:offset`과 anti-join하고 현재 schema policy와 canonical Rule을 다시 적용하며, 성공 append를 Trino로 검증한 뒤 Catalog에 반영한다. `POST /continuous/compactions`는 Iceberg `rewrite_data_files`, `POST /continuous/iceberg-maintenance`는 명시적으로 활성화한 rewrite/snapshot expiration/orphan cleanup을 수행한다. 삭제성 옵션은 `manage` 권한과 최소 retention을 요구하며, checkpoint에는 손대지 않는다. Maintenance DB lease가 만료돼도 durable runner heartbeat가 fresh이면 lease를 갱신하고 stale/absent runner만 정리하므로 장시간 rewrite를 고정 timeout으로 kill하지 않는다.

수동 UI 확인에서는 Kafka Source 연결 화면에서 `Continuous`를 선택해 target format이 Parquet로 유지되는지 확인한다. 생성 후 수집/처리 목록과 상세에서 `스트림 시작`, `일시정지`, `체크포인트 재개`, `스트림 중지`가 Snapshot의 run/retry와 섞이지 않는지, runtime counter/heartbeat/checkpoint가 polling으로 갱신되는지 확인한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-review-scheduled-ingest
```

### FastAPI scaffold

FastAPI 전환 작업은 `backend/app/`를 기준으로 한다.
기존 Node helper와 호환성 검증 scripts는 Spark/Kafka launcher 및 회귀 비교를 위해 유지하고, FastAPI 서버는 아래 명령으로 실행한다.
FastAPI backend는 Python 3.13 환경에서 검증한다. production Docker image도 `python:3.13-slim`과 `backend/requirements.txt`를 기준으로 빌드한다.

```bash
cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

로컬 환경 변수는 `backend/.env.example`을 기준으로 둔다. Query AI gateway mode는 `AI_PROVIDER_API_KEY`를 `ai-server` 환경에만 두고, backend는 service token과 signed context secret만 사용한다. `AI_QUERY_PROVIDER=direct` 롤백 모드의 `OPENAI_API_KEY`와 Dashboard Assistant 설정은 별도 호환 경로다.

SQL UI를 변경할 때는 desktop에서 좌측 SQL 도구와 우측 editor/result workspace의 하단이 SQL 실행 전후 모두 일치하는지 확인한다. Trino를 켜도 editor wrapper/textarea 높이, toolbar, 단일 scroll은 바뀌지 않아야 한다. 실행 평가와 timeline을 editor 아래 sibling card로 추가하지 않고 결과 panel의 세 번째 `실행 정보` view에 넣으며, `차트 보기`/`데이터 미리보기`/`실행 정보`가 같은 bounded 높이에서 전환·scroll되는지 확인한다. 실행 정보는 `쿼리 실행`, `첫 결과 준비`, `전체 결과 수집`의 실제 가능한 지표만 표시하고 다른 분모를 하나의 진행률로 합치지 않는다. Trino 결과는 현재 cursor page와 전체 보기, server CSV, 반복 Job 생성을 확인하고 1회성 Dataset materialization action은 toolbar에 노출하지 않는다. Trino page 차트는 현재 표시 범위를 명시하고 persistent Dashboard source로 저장하지 않는다. Catalog 미리보기 이동과 Nessie 초안 적용은 기존처럼 동작하되 자동 실행되지 않아야 한다.
FastAPI 폴더 구조와 설계 결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

## 4) Prod-Like Docker Compose

AWS 배포 전에는 로컬에서 prod-like compose 구성이 유효한지 먼저 확인한다.
실제 secret은 `deploy/.env`에만 두고, repo에는 `deploy/.env.example`만 커밋한다.

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config
```

Object storage provider 회귀는 별도 계약 검증으로 확인한다.

```bash
cd backend
npm run verify:object-storage-mode
PYTHONPATH=. .venv/bin/python -m unittest tests.test_object_storage_mode tests.test_sql_service_object_storage -v
```

로컬 root Compose는 MinIO를 사용한다. Production Compose는 실제 AWS S3만 사용하며, `ASKLAKE_OBJECT_STORAGE_PROVIDER=aws`, `AWS_REGION`, Raw/Output/Warehouse/Query Result bucket을 설정하고 EC2 IAM Role/default credential chain으로 인증한다. Warehouse와 Query Result bucket은 `TRINO_ENABLED=true`일 때만 runtime에 사용하며 배포 전에 생성하고 readiness 대상에 포함한다. Production frontend image에는 Compose가 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 `VITE_SPARK_OUTPUT_BUCKET`으로 주입하므로 Target UI와 Spark writer가 같은 bucket을 사용한다. Production `.env`에는 장기 AWS access key/secret 또는 MinIO credential을 넣지 않는다.

Production에서 Trino를 켜기 전에는 TLS/auth/JDBC role, read-only query identity, materializer CTAS/`DESCRIBE`/drop, Warehouse와 Query Result bucket round trip을 아래 readiness로 확인한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-production-readiness
```

Production은 알려진 legacy demo 계정을 기본 비활성화한다. 재시작 가능한 데모 서버에서 해당 계정을 유지하려면 server `deploy/.env`의 backend/frontend 플래그를 반드시 함께 켠다. 한쪽만 켜면 preflight가 실패한다. 이 설정은 기존 DB status를 보존하므로 이전 startup이 이미 `disabled`로 만든 계정은 opt-in 배포 전후에 한 번만 `active`로 복구하고, 이후 재시작에서는 추가 DB 수정이 없어야 한다.

```bash
AUTH_LEGACY_DEMO_USERS_ENABLED=true
VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true
```

Production bootstrap admin, Secure cookie, public signup 기본 차단, client actor header fallback 차단은 그대로 유지된다. 알려진 demo 비밀번호가 노출되는 구성이므로 공개 서비스나 장기 운영 환경에서는 두 값을 `false`로 둔다.

실제 서버에서는 Compose 실행 전에 durable host root와 env를 준비하고 preflight를 통과시킨다. `ASKLAKE_HOST_DATA_DIR` root와 별도 read-only replay 입력인 `ASKLAKE_REPLAY_HOST_INPUT_DIR`는 먼저 존재해야 한다. `spark-runtime-guard`가 root 아래 `spark-ivy`, `spark-output`, `spark-runs`, `samples`, `review-text-models`를 생성하고 UID/GID `185:185`로 정규화하므로 수동 subdirectory `chown`은 필요 없다.

```bash
mkdir -p /var/lib/asklake /var/lib/asklake/replay-input
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

Production backend에는 `/var/run/docker.sock`과 Docker CLI를 넣지 않는다. Batch/Parquet inspect는 내부 전용 `spark-master:6066` REST endpoint에 제출하고 terminal 상태와 timeout을 확인한다. REST/UI/master port는 host에 publish하지 않는다.

로컬에서 전체 stack을 띄울 때는 예시 env를 기준으로 실행할 수 있다.

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml up -d --build
curl http://localhost:8080/api/health
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml down
```

`VITE_API_BASE_URL`은 `/api`를 붙이지 않은 origin까지만 넣는다.
예를 들어 로컬은 `http://localhost:8080`, EC2 HTTPS 배포는 `https://asklake.example.com` 형태를 사용한다.
대시보드 Assistant를 prod build에서 켜려면 `VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant`를 `deploy/.env`에 유지한다.
EC2 HTTPS 배포에서는 `deploy/.env`의 `APP_DOMAIN`에 scheme 없는 domain을 넣고, Caddy가 인증서를 받을 수 있도록 `HTTP_PORT=80`, `HTTPS_PORT=443`을 사용한다.
배포 PR 전에는 최신 `origin/dev`를 fetch한 뒤 compose config와 관련 문서 예시를 다시 확인한다.

### EC2 배포 운영

AWS EC2 demo 서버는 `scripts/deploy.sh`로 켜고, 재배포하고, 끈다.
실제 EC2 id, host, SSH key path는 `deploy/ec2.env`처럼 git에 올리지 않는 개인 환경 파일에서 관리한다.

```bash
cp deploy/ec2.env.example deploy/ec2.env
source deploy/ec2.env

scripts/deploy.sh status
scripts/deploy.sh start
scripts/deploy.sh deploy
scripts/deploy.sh health
scripts/deploy.sh stop
```

세부 운영 절차는 `docs/deployment-runbook.md`를 기준으로 한다.
서버 `deploy/.env`와 로컬 `deploy/ec2.env`에는 실제 secret이나 AWS resource 값이 들어갈 수 있으므로 커밋하지 않는다.

## 5) 브랜치 전략

`main`과 `dev`는 보호 브랜치다.
직접 push는 금지하며, PR source branch 정책을 따른다.

허용되는 병합 흐름:

- `pair1` -> `dev`
- `pair2` -> `dev`
- `pair3` -> `dev`
- 이슈에 `Target Branch: dev`가 명시된 `feature/*`, `bugfix/*`, `hotfix/*`, `chore/*`, `refactor/*`, `docs/*`, `test/*` 작업 브랜치 -> `dev`
- 이슈에 `Target Branch: dev`가 명시된 개인 issue-first 브랜치 `<type>-#<issue-number>` -> `dev`
- `dev` -> `main`

`main`으로 직접 여는 feature PR이나, 연결 이슈·지원되는 이름 규칙·이슈의 대상 브랜치 선언이 없는 `dev` PR은 branch policy check에서 실패한다.

권장 브랜치 타입:

- `feature/<name>`
- `bugfix/<name>`
- `fix/<name>`
- `docs/<name>`
- `test/<name>`
- `chore/<name>`
- 개인 issue-first workflow에서는 `feat-#123`, `fix-#123`, `hotfix-#123`, `docs-#123` 형식

PR 본문 마지막에는 `Closes #<issue-number>`를 둔다. `dev`처럼 기본 브랜치가 아닌 곳에 머지돼도 Notion Issue Sync가 연결 이슈를 명시적으로 닫고 Project/Notion을 `Done`으로 맞춘다. `Refs #<issue-number>`는 연관 관계만 표시하며 이슈를 닫지 않는다. 동기화 자동화 자체를 변경한 PR은 `dev` 반영 뒤 `dev -> main` 통합까지 완료해야 기본 브랜치에서 실행되는 5분 주기 복구에도 적용된다.

작업 분리 기준:

- frontend screen/UI change
- API contract change
- backend scaffold/API implementation
- live backend hydration
- docs-only update
- guardrail/CI update

## 6) 구현 순서

백엔드 연결 작업은 아래 순서를 기본으로 한다.

1. 문서에서 endpoint와 response shape 확인
2. backend API와 frontend API adapter 구현
3. frontend loading/error/rollback 처리
4. `npm run build` 실행
5. 관련 docs 업데이트

상태값을 다룰 때는 API와 frontend internal state에 영어 canonical value를 사용한다.
화면의 한국어 배지, 버튼명, 필터명은 프론트 mapper에서 변환한다.

## 7) Pair Ownership

4일 데모 마일스톤은 2인 3개 Pair 기준으로 운영한다.
Pair 이름은 작업 경계를 나타내며, 실제 구성원 이름은 sprint 시작 시 채운다.

| Pair | Primary Area | Deliverables | Handoff |
| --- | --- | --- | --- |
| Pair A - ETL Creation & Job Operations | Review 생성, Job 생성/실행, Run 이력, DAG | create `{ job, catalogTarget }`, run 성공 `dataset`, `RunSummary`, `JobCommandResponse` | Pair B에는 성공 run 이후 Dataset/Run, Pair C에는 `datasetId`, `runId`, Job/Run 표시 이름 전달 |
| Pair B - Catalog, Lineage & SQL Analysis | Dataset 목록/상세, schema, lineage, Catalog -> SQL, read-only SQL 실행 | `SqlResult`, Dataset/Lineage consistency check, SQL 내부 Job wizard handoff | Pair A에는 명시적 처리 Job draft, Pair C에는 SQL Result, Dataset 이름, SQL query 요약 전달 |
| Pair C - Dashboard Builder & Publish | Dashboard list/builder, Widget 생성/수정/삭제, save/publish, fallback | Dashboard draft/published snapshot, localStorage fallback, known issues | 전체 팀에 Dashboard 저장/Publish 확인 방법과 fallback 기준 전달 |

## 8) Daily Operating Loop

매일 종료 전 아래 질문을 확인한다.

- 오늘 데모 흐름에서 끊기는 화면은 어디인가?
- Pair 간 넘겨야 하는 `jobId`, `runId`, `datasetId`, `sqlResult.runId`, `dashboardId`, `sourceRunId`가 같은가?
- SQL Result를 처리 Job으로 저장할 때 Review draft에 `sourceRunId`, `query`, `referenceDatasetIds`, target DB/포맷/압축/경로/태그/다중 파티션 metadata가 유지되는가?
- Dataset을 바꾸면 schema, lineage, SQL query, SQL result가 같이 바뀌는가?
- Dashboard Widget은 SQL Result의 `columns`/`rows`를 실제로 쓰는가?
- 실패했을 때 입력값과 이전 상태가 유지되는가?
- fallback caveat가 숨겨지지 않았는가?
- 오늘 끝나야 할 화면 결과가 실제 클릭으로 확인되었는가?

Day 4에는 신규 기능을 멈추고 Source -> ETL -> Catalog -> Lineage -> SQL -> Dashboard -> Publish 흐름 1회, 실패 케이스 1회, fallback 케이스 1회를 확인한다.

## 9) PR 체크리스트

- [ ] GitHub 기본 PR 템플릿을 채웠다.
- [ ] 변경 목적이 명확하다.
- [ ] `npm run build`를 실행했거나 실행하지 못한 이유를 남겼다.
- [ ] API/interface 변경이 있으면 `docs/03-api-reference.md`와 `docs/api-contract.md`가 최신 상태다.
- [ ] backend 연결 순서 변경이 있으면 `docs/backend-integration-readiness.md`가 최신 상태다.
- [ ] architecture, routing, state ownership 변경이 있으면 `docs/02-architecture.md`가 최신 상태다.
- [ ] 배포 파일이나 env key가 바뀌면 `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config`를 실행했다.
- [ ] repository/CI/platform guardrail 변경이 있으면 `docs/system-guardrails.md`가 최신 상태다.

## 10) 테스트 전략

현재 최소 검증:

- TypeScript build
- Vite production build
- 핵심 화면 manual smoke

백엔드 도입 후 추가 후보:

- API contract tests
- adapter unit tests
- backend endpoint tests
- FastAPI `/api/health` smoke test
- Pair2 FastAPI Catalog / Lineage / SQL smoke:

```bash
docker compose up -d postgres
cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:fastapi-pair2
```

Dataset 권한 기준을 확인할 때는 아래 smoke를 실행한다. 권한 없는 viewer의 Catalog 목록/상세/SQL preview 차단, user grant에 따른 view/query 허용, group grant에 따른 detail 허용, `delete` grant의 materialization-run 삭제 허용을 검증한다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:permission-dataset
```

Job/Dashboard 권한 기준을 확인할 때는 아래 smoke를 실행한다. 권한 없는 viewer의 Job command, Dashboard 목록/runtime/title/draft/delete 차단과 user grant 변경 후 즉시 허용되는 흐름을 검증한다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:permission-job-dashboard
```

로컬 auth/session, 프로필, 관리자 권한 fallback을 확인할 때는 아래 smoke를 실행한다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:auth-session
```

FastAPI ETL Job 생성과 Airflow 비동기 접수/polling 계약만 확인할 때는 아래 호환 smoke를 실행한다. `AIRFLOW_API_BASE_URL`을 지정하지 않으면 내장 mock을 사용한다. 실제 Spark/MinIO까지 확인할 때는 위 Local Airflow + Spark batch runtime의 `npm run verify:airflow-spark`를 사용한다.

```bash
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:fastapi-etl-catalog
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:etl-lineage
```

이 검증 명령의 이름은 기존 호환을 위해 유지한다. 실제 Airflow 환경변수를 지정하면 같은 script가 Spark manifest, 물리 Parquet, 성공 `catalogResult`, Catalog dataset/materialization/lineage까지 검증한다. Airflow URL이 없으면 내장 mock으로 비동기 접수와 상태 동기화 계약만 확인한다.

- live backend browser smoke tests
- Spark run regression tests
- dashboard persistence regression tests
- dashboard publish/share/refresh runtime smoke tests

### Synthetic commerce dataset 검증

SQL 및 ETL 분석용 커머스 데이터는 `backend/scripts/synthetic-commerce/`의 결정적 generator로 만든다. Amazon Electronics metadata JSONL은 저장소에 포함하지 않으며 실행자가 로컬 경로로 전달한다. 임시 생성 결과는 ignored `backend/tmp/` 아래에 둔다. `meta`, `users`, `click_events`는 서로 다른 스키마이므로 각각 별도 Prefix/Job으로 취급하며, 한 Prefix 안에는 같은 스키마의 `part-*.jsonl`만 둔다.

```bash
python3 backend/scripts/synthetic-commerce/generate.py \
  --source "$HOME/Downloads/meta_Electronics.jsonl" \
  --output-dir backend/tmp/synthetic-commerce \
  --run-id commerce-250mb-seed-20260711 \
  --target-total-size-mb 250 \
  --max-file-size-mb 64 \
  --products 10000 \
  --seed 20260711 \
  --start-date 2026-06-01 \
  --days 30

python3 backend/scripts/synthetic-commerce/analyze.py \
  --data-dir backend/tmp/synthetic-commerce/commerce-250mb-seed-20260711

python3 -m unittest backend/scripts/synthetic-commerce/test_generate.py
```

`manifest.json`에는 데이터셋별 전체 행 수·바이트, 파일별 행 수·바이트·SHA-256, seed, 시간 범위가 기록된다. 분석기는 이 증거와 실제 파일을 대조하고 사용자/상품 외래키, 가입 이후 이벤트, 퍼널 순서와 심어 둔 분석 패턴을 검증한다. `--target-total-size-mb`를 늘리면 같은 분포와 계약으로 확장되며 출력 바이트를 정확히 맞추는 기능은 아니다. 생성 규칙, 컬럼 계약, 인사이트 품질 기준과 산출물 커밋 정책은 `backend/scripts/synthetic-commerce/README.md`를 따른다.

생성·분석이 통과하면 local MinIO와 metadata PostgreSQL을 올리고, manifest에 기록된 part만 고유 run prefix에 업로드한 뒤 Prefix Preview부터 Spark/Catalog/SQL까지 이어지는 E2E를 실행한다.

```bash
docker compose up -d minio postgres
cd backend
npm run synthetic-commerce:upload
npm run verify:prefix-spark-e2e
```

기본 run directory는 `backend/tmp/synthetic-commerce/commerce-250mb-seed-20260711`, bucket은 `m3-raw`, key root는 `synthetic-commerce/<run-id>/`다. 다른 실행 결과는 `ASKLAKE_SYNTHETIC_COMMERCE_DIR`, `ASKLAKE_SYNTHETIC_COMMERCE_BUCKET`, `ASKLAKE_SYNTHETIC_COMMERCE_KEY_PREFIX`로 지정한다. 실제 AWS S3에서는 `ASKLAKE_SYNTHETIC_COMMERCE_ENDPOINT=''`, `ASKLAKE_SYNTHETIC_COMMERCE_USE_DEFAULT_CREDENTIALS=true`, AWS region/bucket을 설정해 default credential chain을 사용하며 credential 값을 command, 로그, 저장소에 남기지 않는다. `verify:prefix-spark-e2e`는 connector `datasetSummary`, 입력 file/byte/row 합계, 다중 Parquet, Catalog, SQL `COUNT(*)`와 이벤트 퍼널 분포를 함께 검증한다.

같은 클릭 이벤트를 비정형 `.log`와 조건부 `레코드 구조화` 입력으로 사용할 때는 메모리 제한형 Python 변환기를 사용한다. 로컬 기본 입력은 `backend/fixtures/synthetic-commerce/click_events.jsonl`, 기본 출력은 ignored `backend/tmp/synthetic-commerce/click-events.log`다. 입력 JSONL을 한 줄씩 읽고 헤더 없는 10필드 로그와 행 수·byte·SHA-256 manifest를 함께 만든다.

레코드 구조화 화면은 File/S3와 Kafka raw text 등 소스 종류, 원본 파일명, 감지 필드 수와 무관하게 `AI 필드 자동 추론` action을 항상 노출한다. 현재 action은 향후 AI 추론과 사용자 검증·수정 흐름을 위한 UI placeholder이며 클릭 핸들러, 비활성화 조건, 하드코딩된 클릭 이벤트 schema preset을 갖지 않는다. 사용자는 기존 컬럼명·타입 입력으로 결과를 직접 검증하고 수정하며, backend preview 검증과 최종 확정 절차는 그대로 유지한다.

```bash
cd backend
npm run synthetic-commerce:click-log
npm run verify:synthetic-click-log
```

배포 환경은 파일을 먼저 내려받지 않고 S3 prefix에서 S3 object로 직접 변환할 수 있다. AWS access key/secret을 인자로 받지 않으며 boto3 기본 credential chain과 IAM Role을 사용한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run synthetic-commerce:click-log -- \
  --input-s3-uri s3://raw-bucket/commerce/click_events/ \
  --output-s3-uri s3://raw-bucket/commerce/click-events.log
```

S3 mode는 `backend/requirements.txt`가 설치된 backend Python 환경에서 실행한다. S3 입력은 basename이 `.`/`_`로 시작하는 object를 제외하고 `.jsonl`/`.ndjson` object key 순서로 읽으며 ETag `If-Match`로 변환 중 원본 변경을 거부한다. 출력 `.log`는 기본 64 MiB part의 multipart upload를 사용한다. 새 manifest를 먼저 저장하고 `.log`를 마지막에 commit하며 실패 시 upload abort와 manifest 복원/삭제를 수행한다. 기존 output/manifest는 `--overwrite` 없이는 교체하지 않는다. 필요한 IAM과 MinIO endpoint 옵션, manifest 계약은 `backend/scripts/synthetic-commerce/README.md`를 따른다.

PostgreSQL Source Preview가 `현재 행` 10건이어도 Snapshot Job 실행은 선택 테이블 전체를 처리해야 한다. source fixture를 올린 뒤 아래 검증으로 `products` 10,000행과 50,000행을 넘는 `click_events` 76,640행이 잘리지 않는지 확인한다.

```bash
cd backend
npm run verify:postgres-full-source
ASKLAKE_POSTGRES_FULL_SOURCE_TABLE=click_events npm run verify:postgres-full-source
```

실행 exporter는 `REPEATABLE READ READ ONLY` cursor를 사용하고 기본 1,000행씩 JSONL에 기록한다. `ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS`는 메모리 사용을 조절하는 batch 크기일 뿐 전체 행 제한으로 사용하지 않는다.

## 11) Manual Smoke Checklist

- `/` 랜딩이 표시되고 시작 CTA가 `/login`으로 이동한다.
- session이 없으면 `/jobs`, `/ai`, `/admin` 직접 접근이 `AuthPage`로 이동한다.
- admin 계정 로그인 후 `/jobs`가 표시되고 `/ai`는 `AiChatPage`, `/admin`은 `AdminConsolePage`를 렌더링한다.
- viewer 계정에는 관리 메뉴가 보이지 않고 `/admin` 직접 접근은 프로필로 이동한다.
- 로그아웃 후 보호 route에 다시 접근하면 로그인 화면이 표시된다.
- 수집/처리 목록이 열린다.
- 새 수집/처리 생성 flow가 Review까지 이동한다.
- 생성 요청 후 job과 dataset이 반영된다.
- job 명령 버튼이 상태를 바꾼다.
- catalog 상세에서 SQL 화면으로 이동한다.
- SQL 실행 결과에서 `차트 보기`, `데이터 미리보기`, `실행 정보`를 같은 panel 안에서 전환하고 CSV 다운로드 또는 mode에 맞는 반복/처리 Job 생성을 실행할 수 있다. Trino 실행 전후 SQL editor 높이는 변하지 않는다.
- audit log와 toast가 동작한다.
- dashboard draft를 publish하면 viewer로 이동하고, 공유 링크 복사와 새로고침 feedback이 보인다.

## 12) 문서 업데이트 기준

- 제품 범위 변경: `docs/01-product-planning.md`
- 구조/상태/데이터 소유권 변경: `docs/02-architecture.md`
- API/interface 변경: `docs/03-api-reference.md`, `docs/api-contract.md`
- 개발 명령/검증/브랜치 규칙 변경: 이 문서
- CI/ruleset/platform guardrail 변경: `docs/system-guardrails.md`
- GitHub PR/Issue 템플릿 변경: 이 문서와 `docs/system-guardrails.md`

## 13) Local Codex Workflow Overrides

`AGENTS.local.md` may be used for local-only Codex workflow preferences, such as routing natural-language issue, PR, and review requests to installed personal skills.

This file is ignored by git and must not contain shared team policy, secrets, tokens, private keys, or real credentials.

## 14) Realtime 4-PR 개발 순서

이번 전환은 다음 순서로만 merge한다.

1. 계약·ADR·baseline·feature flag
2. durable SSE backend·Dashboard frontend·proxy/observability
3. Continuous SQL planner·runtime·publication
4. recovery/security/E2E/CI/rollout audit

각 후속 branch는 직전 branch에서 만들지만 GitHub PR base는 dev다. 앞 PR이 merge되기 전 후속 PR은 Draft로 유지한다. 상세 원장은 docs/codex-realtime-pr-pack/WORK_STATUS.md다.

STACK-01 focused validation:

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest tests.test_realtime_feature_flags tests.test_continuous_runtime_sync_config
.\.venv\Scripts\python.exe -m unittest tests.test_dashboard_live_repository tests.test_dashboard_live_results tests.test_kafka_continuous_dashboard_sync

cd ..\frontend
npm run test:dashboard-live-refresh
npm run build

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
```

STACK-02 focused validation:

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest tests.test_realtime_events tests.test_realtime_feature_flags tests.test_dashboard_live_repository
.\.venv\Scripts\python.exe scripts\verify-realtime-proxy-contract.py
.\.venv\Scripts\python.exe -m compileall -q app tests

cd ..\frontend
npm run test:realtime-events
npm run test:dashboard-live-refresh
npm run build

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
git diff --check
```

STACK-03 focused validation:

```powershell
cd backend
npm run verify:continuous-sql-contract
npm run verify:kafka-continuous-contract
.\.venv\Scripts\python.exe -m unittest tests.test_query_route_compatibility tests.test_sql_run_authorization tests.test_continuous_runtime_sync_config tests.test_kafka_continuous_dashboard_sync tests.test_kafka_continuous_replay_publication
.\.venv\Scripts\python.exe -m compileall -q app scripts\continuous_sql_runtime.py scripts\kafka_continuous_stream.py
node --check scripts\manage-kafka-continuous.mjs

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
git diff --check
```

STACK-04 PR smoke:

```powershell
cd backend
npm run verify:realtime-stack

cd ..\frontend
npm run test:realtime-events
npm run test:dashboard-live-refresh
npm run build

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
git diff --check
```

`Realtime Quality Gates / realtime-contracts`는 같은 계약에 disposable PostgreSQL event log/NOTIFY·publication concurrency와 Caddy/NGINX container parser를 추가한다. `realtime-live-e2e`는 매일 schedule 또는 `workflow_dispatch`의 `run_live_iceberg=true`에서 Kafka/Spark/Iceberg fault·restart harness를 실행한다. 실제 ALB와 browser, production-like Continuous SQL stream-static JOIN 증거는 operator gate이며 CI parser나 fake writer test로 대체하지 않는다.

static Dataset JOIN key는 Catalog `uniqueKeySets` 또는 `uniqueKeyColumns`로 명시한다. 기존 `indexColumns`가 실제 unique index임을 보장하는 경우에만 `indexColumnsUnique=true`를 함께 저장한다. `CONTINUOUS_SQL_JOIN_ENABLED=false`가 기본이며 실제 Spark/Iceberg end-to-end, fault/restart와 soak는 STACK-04 gate다.

Continuous SQL latency tuning은 새 request의 5초 기본 trigger와 `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS` 두 경로를 사용한다. cache 한도는 executor memory/disk와 Catalog 통계 신뢰도를 확인하며 조정하고, memory pressure가 있거나 통계가 불안정하면 0으로 cache를 끈다. 새 output table은 `_asklake_run_id`를 partition column으로 생성하지만 기존 table은 자동 변경하지 않는다. 성능 변경 검증은 아래 계약 suite와 Compose render를 포함하고, 실제 지연 수치는 Kafka/MinIO/Spark/Iceberg/Trino 통합 환경에서 별도로 측정한다.

실제 PostgreSQL multi-worker replay, Caddy/ALB heartbeat, rolling restart와 장시간 burst는 STACK-04 operator gate에서 검증한다. 정적 proxy 계약과 단위 테스트 통과를 production 통합 검증으로 과장하지 않는다. 절차와 판정은 `docs/realtime-2026/final-audit.md`, `docs/realtime-2026/production-runbook.md`를 따른다.

기능을 즉시 되돌릴 때는 DASHBOARD_SYNC_MODE=polling, REALTIME_EVENTS_ENABLED=false, CONTINUOUS_SQL_JOIN_ENABLED=false로 재배포한다.
## 15) Runtime script·Node bridge 변경 검증

Spark/Kafka worker를 수정할 때는 `/scripts/spark_job_run.py`와 `/scripts/kafka_continuous_stream.py`의 경로 및 실행 의미를 유지한다. 신규 정책은 `backend/scripts/runtime/`에 추가하고 entrypoint에는 argument/environment wiring과 exit mapping만 둔다. report/checkpoint/manifest field 변경은 additive version과 backward reader를 함께 추가한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_runtime_script_contracts tests.test_runtime_io_ports tests.test_review_analysis_bridge -v
node --test scripts/node-json-bridge.test.mjs
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:production-spark
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:spark-schema-contract
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-continuous-contract
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:continuous-runtime-contract
```

macOS 시스템 `python3`가 Python 3.9이면 backend의 union type 문법을 읽지 못할 수 있으므로 위 production verifier에는 `.venv/bin/python`을 명시한다. live Spark/Kafka 검증은 별도 opt-in profile로 실행하고 단위·계약 테스트는 Spark 없이 통과해야 한다.

Node 호출을 추가할 때 application/service에서 inline JavaScript, module URI, shell command를 직접 조립하지 않는다. allow-list operation은 `VersionedNodeBridgePort`에 추가하고 Node runner 양쪽의 version/request/error contract test를 함께 갱신한다. stdout은 protocol JSON 전용이며 secret이 포함될 수 있는 진단은 stderr redaction을 거친다.

## 16) Frontend 상태·ETL Wizard 변경 검증

ETL route, 단계 page, draft hydrate, Job/Catalog hydrate 또는 mutation 순서를 변경할 때는 [Frontend 상태 소유권과 ETL Wizard 경계](refactor-2026/contracts/frontend-state-etl-wizard.md)를 먼저 확인한다. `EtlPages.tsx`에 새 화면 구현을 추가하거나, 최신 요청 판정을 page마다 별도 integer ref로 만들거나, credential을 localStorage에 평문 저장하지 않는다.

```bash
cd frontend
npm run test:request-ownership
npm run test:etl-draft-contract
npm run test:etl-step-registry
npm run verify:ui-regressions
npm run build
```

`verify-ui-regressions.mjs`의 ETL 계약은 `etlWizardFiles` 모듈 집합을 검사한다. 화면을 추가로 분리하면 새 module path를 이 목록에 포함하고 기존 positive/forbidden pattern을 유지한다. `EtlPages.tsx` compatibility export와 기존 `/etl/*` URL을 제거하는 변경은 별도 deprecation 단계 없이는 허용하지 않는다.

## 17) Frontend Job 화면·데이터 controller 변경 검증

Job 목록·상세·실행 이력은 `pages/ingest/jobs/`, 앱 서버 상태 조회와 mutation은 `state/asklake/`에서 변경한다. `JobsPages.tsx`와 `useAskLakeData.ts` façade에 새 구현을 직접 추가하지 않는다. 화면 module을 추가하면 `verify-ui-regressions.mjs`의 `jobsPageFiles`, 상태 module을 추가하면 `askLakeDataFiles`에 포함한다.

`App.tsx`와 신규 source는 façade를 import하지 않고 `pages/ingest/jobs/`와 `useAskLakeWorkspace.ts`의 canonical module을 직접 사용한다. 배포 UI 무변경 리팩토링에서는 아래 guard가 façade의 재활성화와 production mock/legacy 기본값 변경을 차단한다.

```bash
cd frontend
npm run test:request-ownership
npm run test:jobs-data-boundary
npm run test:deployed-ui-boundary
npm run verify:ui-regressions
npm run build
```

Job command의 optimistic rollback은 `MutationRevisionGate` ownership 검사를 우회하면 안 된다. 기존 `/jobs` route와 `JobsLandingPage`, `JobDetailPage`, `JobRunsPage` export 또는 compatibility façade 파일을 제거하려면 별도 deprecation PR이 필요하다.

## 18) Frontend CSS·Catalog 경계 변경 검증

ETL/Layout 스타일은 `styles/etl/`, `styles/layout/`의 소유 feature 파일에서 변경한다. entrypoint import 순서 변경, 기존 중복 selector 정리, specificity 변경은 시각 회귀 근거가 있는 별도 PR로 다룬다. Catalog 조회·선택 state는 `useCatalogExplorerState.ts`, 순수 검색·정렬은 `catalogModel.ts`, 표현은 각 page module이 소유한다.

```bash
cd frontend
npm run test:css-catalog-boundary
npm run verify:ui-regressions
npm run build
```

Catalog module을 더 분리하면 `verify-ui-regressions.mjs`의 `catalogPageFiles`에도 경로를 추가한다. `CatalogPage.tsx` façade, 기존 route/DOM class/접근성 속성, CSS entrypoint hash를 바꾸려면 별도 호환 또는 deprecation 단계가 필요하다.

### ETL Permission create-flow 검증

```powershell
cd backend
python scripts/verify-permission-create-flow-contract.py
npm run verify:permission-job-dashboard

cd ..\frontend
npm run verify:ui-regressions
npm run build
```

Windows에서 FastAPI 의존성이 저장소 가상환경에만 설치돼 있으면 `python` 대신 `.\.venv\Scripts\python.exe`를 사용한다. `verify:permission-job-dashboard`는 PostgreSQL metadata DB가 응답 가능한 환경을 요구한다.

## 18) API·DB 하위 호환과 Legacy 경로 검증

API schema, SQLAlchemy/Pydantic model, persisted Job/session/runtime document, frontend route 또는 wizard flow를 변경할 때 baseline 검증을 먼저 실행한다.

```bash
cd backend
npm run verify:backward-compatibility
npm run verify:legacy-paths
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_backward_compatibility_contracts \
  tests.test_runtime_script_contracts

cd ../frontend
npm run test:compatibility-runtime
npm run test:etl-draft-contract
npm run verify:ui-regressions
npm run build
```

운영에서 도달 가능한 fallback/legacy adapter를 추가할 때 `docs/refactor-2026/legacy-path-register.json`에 안정적인 ID, owner, activation, telemetry, 제거 조건과 목표 release를 등록한다. 구조화 warning과 counter 없는 production entry는 검증 실패다. 개발 mock/우회는 명시적 환경 guard가 필요하며 production에서 mock으로 조용히 전환해서는 안 된다.

DB breaking change는 같은 PR에서 바로 수행하지 않는다. expand schema와 rollback reader, idempotent backfill, 호출 0 관측 기간, contract 제거를 각각 검증 가능한 단계로 나눈다. Job, session, runtime artifact, checkpoint를 테스트 편의를 위해 초기화하지 않는다.
# 관측성·품질 게이트 개발 절차 (2026-07-16)

로컬 구조 ratchet은 아래 명령으로 실행한다.

```bash
cd backend
npm run verify:quality-gates
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:backward-compatibility
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:legacy-paths
PYTHONPATH=. .venv/bin/python -m unittest tests.test_observability_contract tests.test_runtime_io_ports tests.test_backward_compatibility_contracts
```

API/schema 변경은 `docs/03-api-reference.md` 또는 아키텍처 문서를, CI/deploy 변경은 이 문서 또는 `docs/system-guardrails.md`를 같은 PR에서 갱신해야 한다. baseline을 다시 생성해 실패를 덮지 말고 개선된 값은 별도 PR에서 낮춘다. 느린 production Spark·Continuous 검증은 `Refactor Quality Gates` workflow dispatch의 `release_suite=true`로 실행한다.

## 20) ETL E2E·복구 프로필 실행

### ETL Job 조회·hydrate 경계 검증

Job 목록·상세의 runtime refresh, Airflow sync, permission projection 또는 facet/filter를 변경할 때는 application 경계 unit과 기존 hydrate/API 계약을 함께 실행한다. `etl_service.py` façade에 조회 정책을 다시 구현하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_queries -v
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py
```

### ETL Job 삭제 command·transaction 경계 검증

Job 삭제 권한, active workload 차단, 종속 레코드 또는 transaction을 변경할 때는 application command unit과 기존 row-lock·동시성 회귀를 함께 실행한다. `etl_service.delete_job` façade에 삭제 정책이나 commit/rollback을 다시 구현하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_commands tests.test_etl_job_delete -v
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py
.venv/bin/python ../scripts/refactor_audit/quality_gate.py --base origin/dev
```

### ETL Pipeline 생성·수정 write 경계 검증

일반 Pipeline POST/PATCH의 Rule validation, mapping, identity, permission 또는 repository write를 변경할 때는 application unit과 기존 create/update 계약 verifier를 함께 실행한다. `etl_service.create_pipeline/update_pipeline` façade에 write 정책을 다시 구현하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_write_commands -v
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-permission-create-flow-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-rule-persistence-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-dataset-identity-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-kafka-continuous-contract.py
```

### Airflow Spark 실행·Catalog 발행 경계 검증

Snapshot Airflow Run identity, Spark execution lease, runner 결과 finalize, physical output 검증 또는 Catalog transaction을 변경할 때는 application unit과 기존 concurrency·Iceberg·PostgreSQL reconciliation 검증을 함께 실행한다. `etl_service.execute_airflow_spark_run/reconcile_airflow_catalog` façade에 실행·발행 순서를 다시 구현하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_airflow_execution_commands -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_delete tests.test_spark_iceberg_reconciliation -v
PYTHONPATH=. .venv/bin/python scripts/verify-airflow-catalog-reconciliation.py
PYTHONPATH=. .venv/bin/python scripts/verify-backward-compatibility.py
```

Continuous, publication, Catalog, Dashboard, Spark runtime path를 변경하면 아래 빠른 프로필을 실행한다.

```bash
cd backend
npm run verify:etl-e2e-recovery
```

배포 후보는 `verify:etl-e2e-recovery:release`를 추가한다. 실제 Kafka/브라우저/서비스 fault가 포함된 `nightly`는 `ASKLAKE_E2E_ISOLATED_ENV=true`와 loopback URL이 설정된 `self-hosted + asklake-e2e` runner에서만 실행한다. production URL·credential로 우회 실행하지 않는다. 결과물은 `.artifacts/etl-e2e-recovery/`의 JSON/JUnit/Markdown 세 파일이며, 실패 시 correlation ID와 해당 check의 bounded output을 PR에 첨부한다.

시나리오를 추가할 때는 [하네스 계약](refactor-2026/contracts/etl-e2e-recovery-harness.md)에 따라 initial state, injection, expected state, timeout, automatic/operator recovery, evidence를 모두 정의한다. fixed sleep이나 화면 문구/CSS selector로 완료를 판정하지 않는다.
