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

Frontend build는 Vite `5.4.21`을 exact version으로 고정한다. 2026-07-17 기준 `npm audit`의 잔여 Vite/esbuild advisory는 Vite 8 major upgrade가 필요하므로 이 동기화 작업에서 `--force`로 자동 변경하지 않는다. 별도 migration 전까지 Vite dev server를 외부 네트워크에 노출하지 않고 production은 build된 정적 asset만 제공한다.

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

### Dashboard DB schema 준비

Dashboard의 테이블 구조는 사용자가 Dashboard를 열거나 저장하는 요청에서 만들지 않는다. backend 시작 전에 Dashboard 전용 versioned migration이 필요한 구조를 준비하고, 적용한 버전은 `dashboard_schema_migrations` 테이블에 기록한다.

일반적인 backend 시작에서는 자동으로 한 번 확인된다. 배포 전 미리 확인하거나 기존 DB를 먼저 올릴 때는 아래 명령을 사용한다.

```bash
cd backend
npm run migrate:dashboard-schema
npm run migrate:metadata-schema
npm run verify:dashboard-storage
```

`migrate:dashboard-schema`는 Dashboard 전용 versioned migration만 실행한다. `migrate:metadata-schema`는 backend traffic 전 Dashboard, ETL, Catalog, SQL metadata와 Continuous/Realtime supporting table을 함께 준비하는 배포 bootstrap이다. backend startup도 같은 bootstrap을 수행하므로 request 또는 control-plane hot path가 최초 DDL을 소유하지 않는다. 현재는 저장소 전체 DB를 관리하는 Alembic 도입 전의 명시적 bootstrap이며, `20260718_dashboard_batch_cache_v1`은 `dashboard_batch_widget_results`를 만들며 배포 전에 적용돼야 한다.

Catalog Dataset 전체 삭제를 변경할 때는 `catalog_dataset_deletions` receipt/fence가 metadata bootstrap에서 준비되는지, impact blocker가 삭제 요청 시 다시 계산되는지, 물리 purge 실패 때 Catalog row가 남는지 확인한다. 로컬 최소 검증은 `cd backend && PYTHONPATH=. .venv/bin/python -m unittest tests.test_catalog_dataset_deletion -v`와 `cd frontend && npm run verify:ui-regressions && npm run build`다. 목록 row 삭제 action은 상세 route를 열지 않아야 하며 `succeeded` 전에는 frontend 목록에서 optimistic removal을 하지 않는다.

Dashboard widget 데이터가 느리거나 실패하면 `dashboard_widget_data` 구조화 로그에서 correlation ID와 `dashboardId`, `pageId`, `widgetId`, `datasetId`, `stage`, `durationMs`, `result`, `errorCode`를 확인한다. `/api/health/metrics`의 `dashboard_widget_data_total{result,stage}`는 request cache hit, PostgreSQL cache hit, 물리 계산 miss와 오류 횟수를 구분한다. 로그와 metric에는 원본 row나 credential을 넣지 않는다.

Dashboard 성능 계약은 `npm run verify:dashboard-performance`, 같은 합성 조건의 10회 중간값은 `npm run measure:dashboard-performance`로 확인한다. 측정값의 의미와 운영 환경에서 추가로 볼 항목은 [Dashboard 성능·회귀 검증 기록](./dashboard-performance-verification.md)에 유지한다.

## 2) 빌드

```bash
cd frontend
npm run test:trino-timeline
npm run test:catalog-lineage-projection
npm run verify:ui-regressions
npm run build
```

현재 package script는 TypeScript build와 Vite build를 함께 실행한다.
`npm run test:trino-timeline`은 preview의 `쿼리 실행 -> 첫 결과 준비` 단계, full run에서만 보이는 전체 결과 수집 단계, terminal/만료 상태, 2초 progress 지연, 실제 분자/분모 없는 bar 생략, manifest 마무리와 legacy timing fallback을 순수 상태 모델로 검증한다.
`npm run test:catalog-lineage-projection`은 저장된 API graph를 변경하지 않으면서 Catalog 화면에서 `PROCESS` node를 제거하고 동일 컬럼의 source→target edge만 만드는지 검증한다. UI 수동 확인에서는 `/etl/source`의 connector 카드, 전역 152px sidebar, `/catalog` 목록·lineage, `/dashboards/:dashboardId/edit`의 기본 닫힌 데이터 패널과 오른쪽 설정 패널 toggle을 desktop과 좁은 viewport에서 함께 확인한다.

관리자 감사 로그 계약을 변경할 때는 test dependency를 설치한 Python 환경에서 `cd backend && npm run verify:admin-audit-contract`를 실행한다. 이 검증은 신규 writer의 enum-only 계약, production producer의 문자열 literal 금지, `query_run` HTTP 직렬화, 레거시 타입의 `unknown` 투영과 원본 metadata, `resourceType=unknown` 필터, OpenAPI enum, backend/frontend 타입 집합 일치와 inline enum/local `$ref` 의미 호환성을 확인한다. 실제 PostgreSQL과 FastAPI smoke는 `npm run verify:identity-admin`으로 임시 PostgreSQL schema에 smoke resource와 demo fixture를 만들고 admin/viewer session cookie로 검증한다. 이 smoke는 actor header fallback을 사용하지 않고 permission test grant, governance 상태와 session을 정리한 뒤 임시 schema를 drop하며 실패 시 non-zero로 종료한다. 프런트 부분 실패·stale 갱신·최신 요청 소유권은 `cd frontend && npm run test:admin-console-load`로 확인한다.

EC2 반영 후에는 admin session으로 `/api/admin/audit-logs?resourceType=query_run&limit=10`과 `/api/admin/audit-logs?resourceType=unknown&limit=10`이 모두 `200`인지 확인한다. 관리 화면에서는 사용자·그룹·권한·제한 metric이 실제 각 API 응답과 일치하고 감사 로그 오류가 다른 탭의 성공 데이터를 `0`으로 바꾸지 않는지 확인한다. `scripts/deploy.sh diagnose`의 backend/frontend/database readiness도 함께 통과해야 하며, 실제 deploy·restart·traffic 전환은 release owner의 별도 승인을 받는다.

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

`npm run verify:ui-regressions`는 관리자 콘솔 API의 section별 부분 실패 격리, timeline 상태 테스트와 ETL wizard 순차 이동 테스트를 먼저 실행한 뒤 SQL 분석의 Nessie Popover/Bubble/Collapsible 흐름, SQL editor 불변 높이, 결과 panel의 `차트 보기`/`데이터 미리보기`/`실행 정보` 전환, Trino cursor pagination과 server CSV, Dashboard `WidgetConfigPanel` 재사용, SQL 내부 Job wizard와 최근 UI 회귀 계약을 정적으로 확인한다. 관리자 콘솔만 빠르게 확인할 때는 `cd frontend && npm run test:admin-console-load`를 실행한다.

Nessie가 생성한 SQL의 대용량 정확성·스캔량·실행시간·자원 사용량을 고정 Dataset snapshot과 질문 suite로 비교하는 내부 검증 기준은 [Nessie SQL 대용량 Benchmark](nessie-sql-benchmark.md)를 따른다. 이 benchmark는 공개 Query AI API나 자동 실행 동작을 추가하지 않으며, live campaign은 preflight와 별도의 명시적 confirmation을 거쳐야 한다.

Benchmark Run 저장 계약과 migration은 다음 집중 테스트로 확인한다.

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_nessie_benchmark_dataset.py \
  tests/test_nessie_benchmark_suite.py \
  tests/test_nessie_benchmark_run.py
.venv/bin/alembic heads
```

Runner의 preflight/live/receipt/timeout 경계는 다음으로 검증한다.

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_nessie_benchmark_runner.py
```

동일 조건의 baseline/candidate 요약 회귀 gate는 raw SQL이나 provider credential 없이 로컬과 CI에서 결정론적으로 재실행할 수 있다.

```bash
cd backend
npm run verify:nessie-benchmark

# 또는 구성요소를 분리해 실행
.venv/bin/python -m pytest -q \
  tests/test_nessie_benchmark_summary.py \
  tests/test_nessie_benchmark_comparison.py
PYTHONPATH=. .venv/bin/python scripts/nessie-sql-benchmark-compare.py \
  --baseline benchmarks/nessie-sql/comparable-baseline-summary.v1.json \
  --candidate benchmarks/nessie-sql/comparable-candidate-summary.v2.json \
  --suite benchmarks/nessie-sql/question-suite.v1.json \
  --policy benchmarks/nessie-sql/regression-policy.v1.json
```

비교 artifact는 기존 파일을 덮어쓰지 않는다. 새 baseline 승격은 gate 통과만으로 자동화하지 않고 새 version과 사람 승인을 요구한다.

실제 Query AI candidate는 synthetic Dataset을 임시 Catalog에 등록한 뒤 공개 API를 통해 private receipt로 수집한다. 등록과 정리는 benchmark 전용 `benchmark_*` ID만 다룬다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/nessie-sql-benchmark-catalog.py register \
  --evidence benchmarks/nessie-sql/dataset-load-evidence.v1.json \
  --map-output /tmp/asklake-benchmark-dataset-map.json \
  --confirm REGISTER_SYNTHETIC_BENCHMARK

PYTHONPATH=. .venv/bin/python scripts/nessie-sql-benchmark-candidates.py \
  --suite benchmarks/nessie-sql/question-suite.v1.json \
  --dataset-map /tmp/asklake-benchmark-dataset-map.json \
  --receipt /tmp/asklake-provider-candidates.json \
  --confirm CALL_LIVE_QUERY_AI

PYTHONPATH=. .venv/bin/python scripts/nessie-sql-benchmark-catalog.py cleanup \
  --evidence benchmarks/nessie-sql/dataset-load-evidence.v1.json \
  --confirm REMOVE_SYNTHETIC_BENCHMARK

PYTHONPATH=. .venv/bin/python scripts/nessie-sql-benchmark-dataset.py \
  --manifest benchmarks/nessie-sql/dataset-manifest.v1.json \
  --live --cleanup --confirm CLEANUP_BENCHMARK_DATASET \
  --receipt /tmp/asklake-nessie-dataset-cleanup.json
```

두 cleanup은 application Catalog의 `benchmark_*` 임시 row와 Iceberg의 `asklake_benchmark` 전용 schema만 제거한다. 다른 Dataset/schema와 shared Trino/MinIO container는 건드리지 않는다.

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

Query Run 내부를 수정할 때는 façade 파일에 새 로직을 다시 쌓지 않는다. 요청 제출은 `trino_query_submission.py`, 권한은 `trino_query_access.py`, 상태 조회·취소는 `trino_query_lifecycle.py`, worker 수집은 `trino_query_collector.py`, 결과 page·CSV·retention은 `trino_query_results.py`에서 수정한다. DB 쿼리는 실행 기록, 결과 page, collector lease에 맞춰 각각 `sql_run_repository.py`, `sql_result_page_repository.py`, `trino_collector_repository.py`에서 수정한다. 프론트는 preview 상태를 `useTrinoPreviewRun.ts`, 검증·estimate를 `useTrinoQueryPreflight.ts`, full-result를 `useTrinoFullResult.ts`, API 호출을 `sqlQueryApi.ts`에서 수정한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-foundation
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-preview-full-flow
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:query-engine-registration
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-query-history
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-result-storage
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-collector-resilience
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-submission-guard
.venv/bin/python -m unittest tests.test_query_route_compatibility tests.test_trino_production_hardening -v
```

프론트 SQL 상태 경계를 바꾼 뒤에는 `cd frontend && npm run verify:ui-regressions && npm run build`를 실행한다. 이 조합이 preview/full-result 경계, timeline, cursor pagination, SQL Job wizard, TypeScript 연결과 production bundle을 함께 확인한다.

`scripts/verify-deploy-readiness.sh`는 Docker 작업 전에 `ASKLAKE_PYTHON_BIN`이 정확히 Python 3.13인지 확인하고 다른 minor version이면 즉시 실패한다.

Production Compose의 Trino on/off profile, strict env/file/bucket/ACL guard와 기존 배포 호환성은 root에서 `bash tests/deploy/deploy-scripts-regression.sh`로 확인한다. Compose render, backend/frontend deploy image build, backend production Node/Python dependency 준비, CI runner의 Spark runtime contract만 빠르게 확인하고 JSON release record를 남길 때는 `bash scripts/verify-deploy-readiness.sh`를 사용한다. 결과 파일 위치는 `ASKLAKE_RELEASE_RECORD_PATH`로 지정하며, record 작성 실패도 readiness 실패로 처리한다. GitHub Actions는 Node 22와 Python 3.13을 준비한다. 이 명령과 workflow는 EC2, production secret, Kafka/Spark long-running runtime을 변경하지 않는다. Phase 0-5 통합 후보의 merge 순서와 회귀 명령은 [배포 파이프라인 Phase 6 통합 후보 검증](./deployment-phase-6-integration.md)에 기록한다. 로컬 기존 PostgreSQL volume upgrade는 `docker compose run --rm trino-postgres-bootstrap`을 두 번 실행해도 같은 catalog table/owner/grant 상태를 유지해야 한다.
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

`npm run verify:snapshot-rule-conformance`는 같은 JSON fixture를 Node Kafka runtime과 실제 Spark 4 DataFrame runtime에 적용해 실행 의미의 동등성을 검증한다. `npm run verify:snapshot-spark-pipeline`은 `spark_job_run.py`를 직접 실행해 drop/quarantine/set-null 결과가 Parquet에 반영되고 portable/SQL 혼합 `Fail Batch` target과 staging 경로가 남지 않는지 확인하며, 실제 JSONL `FileScanRDD` 로그를 세어 단일 cast transform-only Snapshot의 raw source read가 전체 pipeline에서 정확히 1회인지 회귀 검증한다. `npm run verify:kafka-target-projection`은 Job의 범용 JSON object 파싱, nested field projection, legacy review 필수 계약을 함께 확인하고 `npm run verify:target-mode-contract`은 mode별 layer/format 선제 검증을 확인한다. `npm run verify:kafka-review-scheduled-ingest`는 Job identity가 없는 direct JSONL compatibility 경로를 검증하고, Kafka Snapshot Job의 Iceberg/Catalog/offset E2E는 `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg`로 확인한다. Continuous 변경 시에는 `npm run verify:kafka-continuous-rules`와 `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-continuous-iceberg`로 Rule, checkpoint, Iceberg append/retry/Catalog 계약을 확인한다.

`npm run verify:spark-schema-contract`는 실제 Spark 4에서 필수 컬럼 1개와 10개를 검증할 때 내부 job 수가 동일한지 확인해, 컬럼별 action 대신 하나의 집계 action을 사용하는 계약을 검증한다. 같은 verifier는 Quality rule 1개와 10개도 aggregate action 수가 같아야 한다. JSON/JSONL은 승인된 `schemaColumns`와 transform input path로 명시적 reader schema를 만들며, `properties.position` 같은 중첩 필드는 물리 target alias로 펼친다. DataFrame 생성 시 schema inference Spark job이 없어야 하고 null과 cast 실패가 있는 경우에는 기존과 같이 실패한 필수 컬럼 이름을 모두 보고하고 target write 전에 중단해야 한다. cache는 `MEMORY_AND_DISK`이며 성공, `Fail Batch`, 예외 모두에서 해제돼야 한다.

Issue #926의 EKS 10GB 성능 검증은 반드시 `origin/pair1`에서 분기한 revision과 그 revision의 immutable Backend/Spark image receipt를 사용한다. 같은 source object, schema/Rule, target write mode로 기존 1-executor 기준과 최적화 1-executor를 먼저 비교하고, 그 결과를 executor `1`, `2`, `4` matrix의 기준으로 재사용한다. 각 Run은 input/output row, schema/rule fingerprint, quality 결과, exact Iceberg snapshot/file count가 맞아야 성능 표본으로 인정한다. Spark `durationMs` 외에 `phaseTimings`, executor Pod peak, Spark node peak/scale 시간, CPU·memory·network 표본과 command-to-terminal wall time을 같이 기록한다. 각 cold-start 표본 전 Spark NodePool이 0으로 수렴했는지 표시하고 실험 종료 뒤 executor 설정을 `1`로 복구한다. 상세 절차와 결과 표는 [Spark 10GB 성능·executor 실험](spark-10gb-performance-experiment.md)을 따른다.

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

Vite 개발 서버는 기본적으로 같은 출처 `/api`를 `http://127.0.0.1:8080`으로 전달하므로 로컬 frontend env가 없어도 된다. Backend 주소를 바꿀 때는 API base를 브라우저에 굽는 대신 proxy target만 지정할 수 있다.

```bash
VITE_DEV_PROXY_TARGET=http://127.0.0.1:8080
# 다른 origin을 브라우저가 직접 호출해야 할 때만:
# VITE_API_BASE_URL=http://localhost:8080
```

Backend `DATABASE_URL`은 미설정 시 `postgres://asklake:asklake_dev@127.0.0.1:54328/asklake`를 사용한다. `npm run verify`와 `npm run verify:spark-run`은 검증 시작 시 metadata를 초기화하지만, 일반 `npm run dev`는 생성한 Job과 Dataset을 Postgres에 유지한다.

Kafka Continuous 대시보드의 table, unique constraint, revision/source range, partition watermark, widget result/state를 실제 PostgreSQL 16에서 확인할 때는 opt-in verifier를 사용한다. 스크립트는 고유 fixture를 만들어 같은 `run_id`, 다른 `run_id`의 같은 offset, 부분 겹침 거절, manifest/fingerprint/cursor와 결과 재조회를 확인한 뒤 자신이 만든 행을 정리한다.

Dashboard draft의 widget·layout 저장, 새 DB session 재조회, publish snapshot 분리와 잘못된 cross-page layout 요청의 rollback 기준은 외부 서비스 없이 SQLite 회귀 테스트로 확인한다.

```bash
cd backend
npm run verify:dashboard-runtime-persistence
```

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

Local Compose의 Airflow task에는 backend URL과 `AIRFLOW_EXECUTION_API_TOKEN` 기반 bearer token이 주입된다. `AIRFLOW_INTERNAL_TOKEN`은 기존 단일 호출 endpoint 호환용으로 함께 유지한다. 그 다음 `수집/처리` 화면에서 Job 실행 버튼을 누르면 `spark_process_write`가 실제 Spark runner와 Iceberg commit을 실행하고, `publish_run_result`가 Trino table/snapshot/data-file mapping을 검증해 Catalog를 확정한다. 두 내부 호출은 `etl_runs`의 DB lease와 generation으로 같은 `runId`를 한 FastAPI owner만 처리하게 하며, lease를 잃은 owner는 결과를 저장하지 못한다. Backend의 Snapshot reconciliation loop가 DAG Run/Task Instance 상태를 DB에 저장하고, Run History와 DAG modal은 `GET /api/etl/jobs/statuses`의 최신 Run·DAG 단계를 반영한다.

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

현재 `asklake_etl_job`은 `receive_asklake_run -> validate_spark_request -> spark_process_write -> publish_run_result`로 실행된다. 실제 source read/transform/quality/Parquet write는 PySpark가 담당한다. 실제 Spark mode의 `publish_run_result`는 저장된 성공 manifest를 `POST /api/internal/airflow/spark-runs/{runId}/catalog`로 멱등 반영하고, 그 commit 뒤에만 DAG Run을 성공시킨다. EKS bounded fixture의 마지막 단계는 Trino에서 exact snapshot, `_asklake_run_id=runId`의 expected row count, data file/byte를 모두 확인한 뒤에만 Catalog를 확정한다. 독립 Airflow runtime 확인용 `executionMode=smoke`는 실제 Job/Run/Parquet가 없으므로 Catalog 호출을 건너뛴다.

Live frontend의 Snapshot polling은 가장 최근의 실제 Run이 `queued` 또는 `running`인 Job ID를 모아 5초마다 `GET /api/etl/jobs/statuses` 한 요청으로 Job/Run state를 갱신한다. Job 수가 늘어도 주기당 요청은 하나다. hidden tab, Jobs route 이탈, active Job 부재 시 요청을 멈추고 연속 실패는 10·20·30초로 backoff한 뒤 성공하면 5초로 복구한다. 오래된 응답과 terminal-to-active 역행은 버린다. terminal success를 관찰했다는 이유로 Jobs route에서 `GET /api/catalog/datasets`를 추가 호출하지 않는다. Catalog·SQL·AI route에 들어갈 때 Catalog domain loader가 최신 목록을 조회하며, command 응답이 Dataset을 직접 포함하면 해당 응답만 즉시 반영한다. Job 목록의 실행 관측 모달은 열 때 받은 객체 snapshot을 고정하지 않고 `jobId`와 `runId`로 중앙 polling이 갱신한 최신 Job/Run을 다시 찾아 표시한다. 별도 모달 polling을 만들지 않는다. 정적 연결과 production build는 `cd frontend && npm run test:snapshot-status-polling && npm run verify:ui-regressions && npm run build`로 확인한다.

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
현재 FastAPI는 `POST /api/dashboards/assistant`에서 DB runtime/catalog 컨텍스트를 검증하고 private AI Gateway를 호출한다.

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

Provider API key는 프론트나 FastAPI가 아니라 `ai-server` env에만 둔다. FastAPI는 `backend/.env`에서 Gateway service token과 MCP signing/service secret만 사용한다.
AI provider key가 없거나 private AI Gateway가 unavailable이면 backend는 실패를 명시하고 action을 비운다. Assistant guard는 provider가 반환한 action의 Dataset·컬럼·값축을 catalog schema 기준으로 검증하지만, 응답이 비었다고 기본 막대 차트나 성공 결과를 만들어 내지 않는다.
Dashboard Assistant 후속 지시는 최근 사용자 발화 최대 2건의 Dataset/field/column 단서만 제한적으로 결합한다. `field_1 event_id` 다음의 `랜덤으로 진행해줘`처럼 단서가 있는 후속 실행은 `visualization_request`로 분류하지만, 맥락 없는 `랜덤으로 진행해줘`는 로컬 입력 guard가 구체화를 요청하고 provider를 호출하지 않는다. Gateway 502 contract 오류는 질문 mode의 report-only 또는 시각화 mode의 단일 mutation 지침으로 한 번만 교정 재시도하며, 두 번째 실패에도 mock action을 만들지 않는다.
SQL과 Dashboard generation의 `usedEvidenceIds`는 요청별 RAG source allowlist를 structured output schema에 넣어 생성 단계부터 제한한다. Provider 호환성 응답에 범위 밖 ID가 섞이면 citation metadata만 제거하고 경고하며, SQL/widget 본체의 기존 안전 검증은 그대로 적용한다. 이 정규화는 목 SQL·목 차트·fallback 성공 응답을 만들지 않는다.

Semantic/RAG 관리 UI는 `/catalog?view=semantic`에서 확인한다. `/semantic-layer`와 기존 `/ai`는 같은 URL로 replace 이동해야 하며, standalone AI 메뉴나 채팅 화면을 다시 추가하지 않는다. Dataset schema, metric·dimension, RAG 분류·승인·색인·작업 이력은 `semanticApi.ts`의 live endpoint를 사용한다. 최소 frontend 검증은 다음과 같다.

```bash
cd frontend
npm run test:semantic-layer-ui
npm run test:css-catalog-boundary
npm run build
```

```bash
# ai-server/.env (secret 값은 commit하지 않는다)
AI_PROVIDER_API_KEY=...
AI_GATEWAY_SERVICE_TOKEN=...

# backend/.env
AI_GATEWAY_BASE_URL=http://ai-server:8090
AI_GATEWAY_SERVICE_TOKEN=...
AI_MCP_SERVICE_TOKEN=...
AI_CONTEXT_SIGNING_SECRET=...
```

```bash
cd backend
npm run verify:dashboard-assistant-guard
```

이 verifier는 실제 `Settings`의 `OPENAI_ASSISTANT_ENABLED`·`OPENAI_ASSISTANT_MAX_SAMPLE_ROWS` 계약과 현재 fail-closed action 정책을 사용한다. 빈 시각화 응답, 단일 mutation action, 복수 mutation action, 질문 모드 mutation 제거를 검증하며 삭제된 local chart fallback helper를 import하거나 복원하지 않는다.

Source/Schema/Create/Run 흐름은 항상 live backend 기준으로 검증한다. run/retry 명령은 Airflow 접수 직후 non-terminal 상태를 응답하고, backend reconciliation이 Airflow task와 Spark 처리 완료 상태를 DB에 저장한다. 프론트는 `GET /api/etl/jobs/statuses` batch polling으로 저장된 상태를 반영한다. 백엔드가 꺼져 있으면 연결 실패 상태를 확인하고, 백엔드를 켠 뒤 실제 connector와 Spark run 경로로 재검증한다.

Job 목록의 query/facet/legacy 상태 정규화는 외부 인프라 없이 `cd backend && npm run verify:job-list`로 먼저 확인한다. Target 표시명과 내부 ID 분리는 `cd backend && npm run verify:dataset-identity`로 확인하며, 서로 다른 한글 이름과 같은 ASCII slug를 만드는 이름이 별도 Job으로 남고 정확히 같은 target만 append 재사용되는지 검증한다. 전체 `npm run verify`는 PostgreSQL, MinIO, REST fixture를 포함한다.

### 화면별 AI runtime 확인

독립 `AI 활용` 메뉴는 없다. SQL 분석의 `Nessie로 SQL 작성`, Dashboard Assistant, 수집/처리 변환 AI, Semantic Layer의 RAG, 리뷰 분석이 private AI Gateway를 공유한다.

수동 확인은 다음 순서로 한다.

1. sidebar에 `AI 활용` 메뉴가 없고 `/ai`가 별도 채팅 화면 대신 `/catalog?view=semantic`으로 replace 이동하는지 확인한다.
2. SQL 분석에서 실제 Dataset을 선택하고 SQL 초안을 생성한다. 요청 중 prompt·Dataset·editor context를 바꿨을 때 이전 응답이 적용되지 않는지, 자동 실행되지 않으며 적용 후 read-only/scope 검사를 다시 통과하는지 확인한다.
3. 대시보드 편집기에서 시각화를 요청한다. `create_widget` 또는 `update_widget` action이 실제 draft에 저장되고 그래프가 렌더링되는지 확인한다. 저장 API를 실패시킨 경우 성공 문구를 표시하지 않고 기존 draft와 입력을 유지해야 한다. 요청 중 Dashboard, page, Dataset 또는 선택 widget을 바꾸면 이전 요청이 취소되고 그 응답의 mutation이 새 화면에 적용되지 않아야 한다.
4. 수집/처리에서 field transform과 SQL transform을 생성하고 입력 schema 밖의 컬럼·관계·위험 함수를 거부하는지 확인한다.
5. Semantic Layer에서 RAG 역할 승인, 전체 문서 미리보기, 색인 작업 이력, 실제 근거 검색을 차례로 확인한다.
6. SQL과 대시보드의 `RAG 근거`가 검색 후보 전체가 아니라 생성에 실제 사용된 source만 표시하는지 확인한다.
7. Gateway나 serving index가 없을 때 가짜 SQL·차트·근거 대신 명시적인 unavailable/empty 상태가 보이는지 확인한다.
8. 리뷰 분석 Preview와 persisted Run이 실제 row를 처리하고, backend 재시작 뒤 남은 `queued` Run도 worker tick이 다시 claim하는지 확인한다. 일반 사용자의 임의 object source는 `403`이어야 하며, `trainModels=true`에서는 provenance·class coverage·quality gate를 통과한 artifact만 `/api/catalog/models`에 나타나야 한다.

```bash
cd backend
alembic upgrade head
python -m pytest -q \
  tests/test_ai_gateway_mcp.py \
  tests/test_ai_generation_evidence_audit.py \
  tests/test_query_ai_contract.py \
  tests/test_query_ai_api_contract.py \
  tests/test_sql_job_permission_contract.py \
  tests/test_dashboard_assistant_action_contract.py \
  tests/test_dashboard_assistant_evidence.py \
  tests/test_dashboard_runtime_api_persistence.py \
  tests/test_review_model_publication.py \
  tests/test_unified_ai_services.py

cd ../ai-server
python -m pytest -q
```

현재 RAG control-plane head `0011_rag_control_plane_fencing` 다음 AI migration 순서는 `0012_ai_generation_usage -> 0013_ai_context_consumptions -> 0014_review_analysis_runs -> 0015_ai_generation_evidence_audit`이다. Fresh DB와 기존 `0011` DB 모두 `alembic upgrade head`로 검증한다.

```bash
cd frontend
npm run test:sql-ai-editor-contract
npm run test:sql-job-permission-contract
npm run test:dashboard-assistant-intent
npm run test:dashboard-assistant-actions
npm run verify:ui-regressions
npm run build
```

### RAG Data Plane 검증

Semantic RAG 색인은 검증된 Spark Catalog publication이 만든 `sourceManifest`를 backend control plane이 `asklake_rag_index` Airflow DAG에 전달한 뒤, Spark parent staging → chunk staging → embedding worker/OpenSearch publication 순서로 실행한다. Spark 단계는 Catalog가 승인한 Iceberg table과 exact snapshot ID, role column만 읽고, checkpoint가 있는 deterministic parent/chunk ID를 생성한다. Spark REST의 `UNKNOWN`은 제출 직후 나타날 수 있는 비종료 상태로 계속 polling하며 `FAILED`, `ERROR`, `KILLED`만 실패로 종료한다. embedding worker는 provider key를 직접 받지 않고 private AI Gateway의 `/v1/embeddings`만 호출하며, 완성된 generation index를 alias로 원자 전환한다.

빠른 회귀는 실제 provider 호출 없이 다음 명령으로 확인한다. OpenSearch 통합 테스트는 고유 index/alias를 만들고 자신이 만든 리소스만 정리하며 `OPENSEARCH_INTEGRATION_URL`이 있을 때만 실행된다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m pytest -q \
  tests/test_rag_airflow_data_plane.py \
  tests/test_rag_parent_contract.py \
  tests/test_rag_preview_production_parity.py \
  tests/test_rag_chunk_staging_transport.py

cd ../embedding-worker
PYTHONPATH=. ../backend/.venv/bin/python -m pytest -q
```

`.github/workflows/rag-opensearch-integration.yml`은 RAG backend/Spark/worker 경로가 바뀐 PR과 `dev`/`main` push에서 OpenSearch 2.19.1 service, production과 같은 PySpark 4.0.1 import smoke, backend RAG 회귀, quality gate, embedding worker test를 실행한다. feature branch push와 PR 이벤트가 같은 검증을 중복 실행하지 않는다. 로컬 live 확인은 `docker compose up -d opensearch` 뒤 `OPENSEARCH_INTEGRATION_URL=http://127.0.0.1:9200`으로 integration marker를 명시한다.

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

`verify:continuous-runtime-contract`는 command 전이표, desired/observed/public projection, command revision, worker fencing, legacy hydrate, 단계별 오류와 frontend stale polling 차단을 검증한다. 보호 범위와 아직 opt-in인 live 장애 시험은 [Characterization Test Matrix](refactor-2026/testing/characterization-matrix.md)에 기록한다. `verify:kafka-continuous-contract`는 long-running worker를 시작하지 않고 Continuous Job의 기본 config/runtime identity, Rule payload/fingerprint, PostgreSQL partition cursor의 worker 전달, start request 상태와 충돌 정책, stream publication manifest/batch identity gate, 종료 report의 stale window/S3 manifest 복구, replay Catalog 재조정, 로컬 result 유실 시 S3 replay manifest 복구와 pending replay start/resume `409` 차단을 확인한다. Spark REST lifecycle에서는 제출 직후 또는 실행 중의 `UNKNOWN`을 중복 실행으로 막고, 종료 상태가 마지막으로 확인된 뒤 REST가 `UNKNOWN`을 반환한 경우에만 checkpoint와 Kafka consumer identity를 유지한 새 attempt를 허용한다. backend unit test는 전체·부분 offset 중복 필터, durable publication 순번, exact snapshot Run 행 수, replay manifest 실패 rollback과 `count`/`sum`/`avg`의 full baseline, Iceberg `_asklake_run_id` revision catch-up, backfill/legacy full fallback을 확인한다. `verify:kafka-continuous-rules`는 독립 Docker Spark에서 bounded micro-batch Rule 의미와 checkpoint contract를 실행한다. Kafka/MinIO/Catalog를 포함한 실동작은 production-like smoke에서 별도로 확인한다.

```bash
cd backend
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
```

ClickHouse serving mode를 변경할 때는 기존 Spark/Iceberg 검증을 대신하지 말고 아래 실동작 smoke를 추가로 실행한다. 스크립트는 고유 Kafka topic, ClickHouse table, PostgreSQL metadata를 만들고 정확한 이름만 종료 시 정리한다. 공백 구분 원문을 `RawBLOB` Kafka Engine으로 넣어 실제 Continuous SQL Job 생성/시작, 최초 3개 입력 중 INNER JOIN 2개 output, pause 중 적재한 1개 event의 미소비와 resume 후 처리, 이후 10개 event 반영, Catalog revision, published Dashboard의 10개 widget type과 `(partition, offset)` 중복 제거를 한 번에 확인한다. fixed sleep은 pause 상태 불변 확인용 0.5초뿐이며 완료 판정은 offset·revision·widget 값으로 한다.

```bash
# 저장소 root
docker compose up -d postgres redpanda clickhouse

cd backend
PYTHONPATH=. python -m unittest tests.test_clickhouse_continuous_sql tests.test_catalog_unique_key_verification tests.test_realtime_feature_flags -v
npm run verify:clickhouse-kafka-join
```

이 smoke의 static relation은 count query와 page reader를 포함한 exact snapshot 계약을 재현하는 bounded fixture를 사용하고 Kafka·ClickHouse·PostgreSQL·Catalog·Dashboard 경로는 실제 container와 application service를 사용한다. 실제 S3/Iceberg/Trino static snapshot round trip은 기존 Trino/Iceberg readiness와 함께 배포 환경에서 별도로 확인한다.

로컬 MinIO S3에 실제 Iceberg static table을 만들고 exact snapshot을 Trino로 ClickHouse에 적재하는 전체 경계까지 확인하려면 Trino를 함께 올리고 live option을 사용한다. 고유 Iceberg table은 검증 종료 시 `DROP TABLE`로 정리한다.

```bash
# 저장소 root
docker compose up -d --wait minio postgres trino

cd backend
CLICKHOUSE_E2E_LIVE_TRINO=true npm run verify:clickhouse-kafka-join
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

Continuous control-plane worker는 `CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS`(기본 1초, 허용 범위 1~60초)마다 active Continuous worker report를 동기화한다. 이 control-plane sync가 Catalog materialization을 수행하므로 Job 목록/상세 조회가 없어도 적재 batch가 Catalog에 등록된다. Production web/API는 `CONTINUOUS_CONTROL_PLANE=disabled`, 전용 worker는 `worker`로 실행한다. `CONTINUOUS_WORKER_SCOPE=all|kafka|continuous_sql`은 reconciliation 범위를 선택하며 production Compose는 scope `all`, owner `ec2-continuous-worker`, 빈 generation을 기본값으로 보존한다. production EC2 기본 `all`은 rolling upgrade 호환성을 위해 기존 단일 `continuous-runtime-sync` lease를 유지하고, 승인된 split 뒤 `kafka`와 `continuous_sql`만 scope별 lease를 사용한다. EKS owner 또는 generation이 지정된 rollback worker는 PostgreSQL runtime `metrics.ownerClaim`의 full identity·fingerprint·fencing token·state revision이 모두 일치하는 Job만 처리하며, 새 EC2 worker도 EKS claim이 있는 runtime을 건너뛴다. worker는 해당 PostgreSQL lease를 보유한 경우에만 그 scope의 Spark 명령과 reconciliation을 수행한다. Worker는 target의 `_batch-manifests/batch_id=*`에 valid/quarantine count를 함께 기록하고, 재시작 때 이 manifest를 읽어 runtime counter를 복구한다.

API/worker와 Spark driver가 같은 mounted report directory를 공유하지 않는 배포(EKS SparkApplication 등)는 두 process에 같은 private S3 prefix를 `ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX=s3a://<bucket>/<prefix>`로 설정한다. `s3://`도 API 설정에서 허용한다. 이 prefix에는 runtime report, command, catalog ACK가 저장되므로 warehouse나 일반 dataset prefix와 분리하고 해당 workload role에 그 prefix의 `GetObject`, `PutObject`, `ListBucket`만 부여한다. 로컬 Compose는 이 값을 비워 mounted local report directory를 계속 사용한다.

EKS에서만 Continuous SparkApplication gateway를 켜려면 worker workload에 다음을 함께 설정한다.

```bash
ASKLAKE_CONTINUOUS_SPARK_RUNNER=kubernetes
ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX=s3a://<private-runtime-bucket>/asklake/continuous
ASKLAKE_SPARK_KUBERNETES_NAMESPACE=asklake-dev
ASKLAKE_SPARK_KUBERNETES_IMAGE=<registry>/<image>@sha256:<digest>
ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT=asklake-spark
ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET_NAME=asklake-spark-runtime
```

worker service account에는 Spark Operator의 `sparkapplications`에 대한 `get`, `create`, `delete` 권한이 필요하다. Spark driver/executor service account에는 runtime prefix의 `GetObject`, `PutObject`, `ListBucket`과 Iceberg warehouse 권한이 필요하다. `asklake-spark-runtime` Secret은 `ASKLAKE_SPARK_ICEBERG_JDBC_URL`, `ASKLAKE_SPARK_ICEBERG_JDBC_USER`, `ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD` key를 제공해야 하며, 실제값을 ConfigMap 또는 SparkApplication YAML에 넣으면 안 된다. node selector, toleration, S3A/IRSA Hadoop 설정은 `ASKLAKE_SPARK_KUBERNETES_NODE_SELECTOR`, `ASKLAKE_SPARK_KUBERNETES_TOLERATIONS`, `ASKLAKE_SPARK_KUBERNETES_HADOOP_CONF` JSON 설정으로 현재 EKS workload와 맞춘다. `ASKLAKE_CONTINUOUS_SPARK_RUNNER`를 비워 두면 기존 Compose REST/Docker 흐름을 유지한다.

### EKS Continuous worker 렌더와 사전 점검

`asklake-workloads`의 `realtimeV1` component는 전용 `asklake-realtime-v1-worker`와 `asklake-realtime-v1-spark` ServiceAccount를 사용하는 단일 replica worker package다. 기존 web release와 독립적으로 foundation의 `asklake-runtime` ConfigMap을 참조한다. 기본값은 disabled이고 EC2 owner를 중지하거나 `deploy/control-plane-ownership.json`을 자동으로 바꾸지 않는다. exact identity의 owner transfer 승인 전에는 apply하지 않는다.

```bash
cd backend
export ASKLAKE_K8S_NAMESPACE=asklake-dev
export ASKLAKE_BACKEND_IMAGE='<backend>@sha256:<digest>'
export ASKLAKE_SPARK_KUBERNETES_IMAGE='<spark>@sha256:<digest>'
export ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT=asklake-spark
export ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX='s3a://<private-runtime-bucket>/asklake/continuous'

npm run verify:kubernetes-continuous-contract
bash ../scripts/verify-eks-workloads.sh
kubectl -n "$ASKLAKE_K8S_NAMESPACE" auth can-i create sparkapplications.sparkoperator.k8s.io \
  --as=system:serviceaccount:"$ASKLAKE_K8S_NAMESPACE":asklake-backend
```

사전 점검은 Helm render와 RBAC만 확인한다. 실제 S3 runtime document read/write, SparkApplication 생성, start/pause/stop/restart E2E는 owner transfer 승인 이후 canary에서 별도로 확인해야 한다. apply 전에 EC2 Kafka scope를 유지한 채 EKS worker를 기동하면 owner가 둘이 된다. 실제 전환은 EC2 scope 분리·Kafka fence, ownership manifest/evidence 변경, EKS worker canary, Kafka job start/pause/stop 및 S3 report 확인을 하나의 승인된 rollout으로 처리한다.

Issue #1044는 읽기 전용 live inventory로 V1을 단일 EKS MVP 경로로 선택했다. canonical package는 `infra/eks/helm/asklake-workloads/templates/realtime-v1-worker.yaml`이며 기본적으로 render하지 않는다. `realtimeV1.enabled=true`만 주면 실패하고 `ownerTransfer.approved=true`, `previousOwnerFenced=true`, exact generation을 모두 제공해야 render된다. EKS worker는 Kafka scope만 claim하며 Continuous SQL은 EC2에 남긴다. 다음 read-only 검증으로 [`deploy/eks-realtime-kafka-mvp.json`](../deploy/eks-realtime-kafka-mvp.json)의 selected-but-disabled 상태, EC2 단일 claim, transfer에서만 할당되는 generation, S3 checkpoint authority, 격리 fixture와 수동 rollback 불변식을 확인한다.

```bash
python3 -m unittest scripts.test_verify_eks_realtime_kafka_mvp
python3 scripts/verify_eks_realtime_kafka_mvp.py

cd backend
npm run verify:eks-realtime-kafka-mvp
npm run verify:control-plane-ownership
bash scripts/verify-eks-workloads.sh
```

validator 통과는 V1 선택과 disabled-by-default package의 정합성만 뜻하며 owner transfer나 AWS apply 승인이 아니다. Terraform은 same-generation exact topic/group과 Backend·Spark의 `continuous-runtime` prefix를 허용한다. Spark driver가 runtime report를 직접 기록하므로 둘 중 하나라도 빠지면 live readiness가 실패한다. read-only IAM probe의 ready mode는 expected generation과 exact runtime object ARN을 요구하고 action-resource mapping, explicit Deny, target role, permissions boundary, bucket-root wildcard와 ListBucket prefix를 fail-closed로 검사한다. 2026-07-19 격리 canary는 MSK 100건 consume/store와 checkpoint restart 중복 0을 통과했지만 기존 production identity transfer는 별도다. 전체 비교와 gate는 [EKS Realtime Kafka MVP Phase 0](eks-realtime-kafka-mvp-phase0.md), exact 실행 순서와 receipt 판정은 [V1 rollout·rollback runbook](eks-realtime-kafka-v1-rollout.md)을 따른다.

일반 Snapshot Job은 별도의 `AIRFLOW_RUN_SYNC_INTERVAL_SECONDS`(기본 5초, 허용 범위 1~60초)마다 active Airflow Run을 동기화한다. PostgreSQL advisory lock으로 배포 전체에서 한 backend process만 각 cycle을 수행하며 Job별 transaction으로 실패를 격리한다. 따라서 상세 GET이나 브라우저 polling은 Airflow를 직접 호출하거나 DB를 쓰지 않는다.

### EKS bounded fault retry 검증

유한 Spark batch의 terminal retry는 public `retry` command가 아니라 같은 internal Airflow `runId` 경계를 다시 호출한다. public command는 새 Run을 만들기 때문에 Day 18 Run D/E 증거에 사용할 수 없다. non-terminal 복구는 같은 SparkApplication UID를 유지하고, terminal failure 복구는 기본 최대 두 attempt 안에서 `attemptGeneration=2`와 새 UID를 사용한다. Run D의 MSK deny 결과는 실제 Describe-only write probe의 private log SHA-256을 계산한 뒤 internal fault adapter에 연결하고, 같은 Run을 `retry` command 값으로 실행한다. raw Run/Job/application/evidence 값은 `/private/tmp` mode `0600` 파일에만 둔다.

```bash
cd backend
npm run test:spark-kubernetes
./.venv/bin/python -m pytest tests/test_eks_execution_contract.py tests/test_etl_job_delete.py -q
```

위 테스트는 lost response의 동일 UID 복구, terminal-failed attempt의 다음 UID 생성, non-terminal replacement 거부, 최대 attempt 초과 거부, MSK `AUTHORIZATION` 1회/ack 0의 같은 RDS Run 연결, fault 뒤 같은 Run의 성공 Spark result 보존을 검증한다. 실제 deny Job, driver/executor fault와 live retry는 immutable candidate 재승격, clean baseline, exact private Run 입력과 필요한 기존 Kubernetes 권한이 모두 확인된 뒤에만 실행한다. 권한이 없으면 IAM/RBAC/NodePool을 늘리지 않고 blocker로 남긴다.

Day 18 live approval에는 capability boolean을 직접 입력하지 않는다. candidate Git
tree의 구현·회귀 blob SHA-256, 구현 ancestry, 공식 image receipt를 binder가 검증해
private contract에 연결한다. 명령과 현재 blocker는
[EKS Day 18 복원력 실행 계약](eks-day18-resilience-execution-contract.md)을 따른다.

```bash
node --test \
  scripts/test-eks-day18-execution-contract.mjs \
  scripts/test-eks-day18-execution-binding.mjs
```

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

로컬 환경 변수는 `backend/.env.example`과 `ai-server/.env.example`을 기준으로 둔다. `AI_PROVIDER_API_KEY`는 `ai-server`에만 두고, FastAPI는 service token과 signed context secret만 사용한다. Query AI, Dashboard Assistant, ETL transform, RAG, 리뷰 분석은 같은 Gateway를 사용하며 direct/mock provider fallback은 지원하지 않는다.

SQL UI를 변경할 때는 desktop에서 좌측 SQL 도구와 우측 editor/result workspace의 하단이 SQL 실행 전후 모두 일치하는지 확인한다. 데스크톱 workspace와 editor는 각각 기존 높이의 1.5배 토큰을 사용하며, 1180px 이하에서는 자동 높이로 전환되어 가로·세로 overflow가 생기지 않아야 한다. Trino를 켜도 editor wrapper/textarea 높이, toolbar, 단일 scroll 계약은 바뀌지 않아야 한다. 실행 평가와 timeline을 editor 아래 sibling card로 추가하지 않고 결과 panel의 세 번째 `실행 정보` view에 넣으며, `차트 보기`/`데이터 미리보기`/`실행 정보`가 같은 bounded 높이에서 전환·scroll되는지 확인한다. 주요 목록 route에서는 제목과 아이콘이 공통 `Topbar`에 한 번만 표시되고 본문 `PageHeader`가 중복되지 않는지, 대시보드 이름 아래 상태·제품 보조 문구가 제거되면서 소유자와 최근 수정 정보는 유지되는지도 함께 확인한다. 기본 실행은 최대 100행 preview이며 `실행 정보`에는 `쿼리 실행`, `첫 결과 준비`만 표시한다. `전체 보기`/CSV의 full run 저장 진행은 preview와 하나의 진행률로 합치지 않는다. 전체 보기는 준비된 cursor page부터 100행씩 조회하고, CSV는 full result 완료 뒤 server stream을 사용한다. 반복 Job 생성은 full result를 기다리지 않고 preview의 SQL recipe만 저장한다. 1회성 Dataset materialization action은 toolbar에 노출하지 않는다. Trino preview 차트는 현재 최대 100행 범위를 명시하고 persistent Dashboard source로 저장하지 않는다. Catalog 미리보기 이동과 Nessie 초안 적용은 기존처럼 동작하되 자동 실행되지 않아야 한다.

Preview/full-result 저장 경계는 아래 격리 검증으로 확인한다. Preview page가 object storage를 호출하지 않고 PostgreSQL inline manifest를 만들며, full-result 요청이 `mode=run`과 source preview ID를 보존하는지 검사한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-preview-full-flow
```
FastAPI 폴더 구조와 설계 결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

## 4) Prod-Like Docker Compose

AWS 배포 전에는 로컬에서 prod-like compose 구성이 유효한지 먼저 확인한다.
실제 secret은 `deploy/.env`에만 두고, repo에는 `deploy/.env.example`만 커밋한다.

Issue #735의 EKS + MSK MVP를 시작할 때는 resource를 생성하기 전에 [EKS + MSK MVP Phase 0 환경·인수 계약](eks-msk-mvp-phase-0-contract.md)을 완료한다. EKS/ECR/MSK/RDS inventory가 `AccessDenied`인 상태에서는 빈 환경으로 판단하지 않는다. 기존 EKS 재사용 여부, VPC/subnet 경로, RDS/Trino 위치, shared resource lifecycle과 Pair B의 workload별 IAM/network 요구가 채워지기 전에는 과금 resource를 생성하지 않는다. 현재 EC2 Compose와 local Docker/Redpanda/Spark REST 검증은 EKS 후보 경로가 추가되어도 유지한다.

Phase 1 foundation과 Pair B 인수 계약을 변경하면 아래 검증을 실행한다. AWS credential이나 실제 cluster 없이 Helm schema/lint/render, `asklake-backend`와 `asklake-spark` token mount, 나머지 workload의 token 차단, Backend/Spark namespace Role/RoleBinding, Replay Producer `create=false`, Trino handoff와 secret pattern을 검사한다. Terraform CLI가 있으면 format/init/validate/mock-provider test도 함께 실행한다. CLI가 없는 환경은 [EKS foundation README](../infra/eks/README.md)의 Docker 검증을 추가로 실행한다.

```bash
bash scripts/verify-eks-foundation.sh
```

dev 실제 foundation은 기본 fail-closed values 위에 `infra/eks/values/dev.example.yaml`과 `infra/eks/values/identity/pod-identity.example.yaml`을 함께 적용한다. 기존 Helm release를 다른 field manager의 `kubectl apply --server-side`로 강제 인수하지 않는다. `helm upgrade --dry-run=server` 후 같은 release를 upgrade해 ownership을 유지한다. 현재 revision 3은 Backend/Spark token이 `true`, 나머지 application token이 `false`, runtime boundary identity mode가 `pod_identity`이며 Spark shutdown cleanup 권한이 반영됐음을 확인했다. Spark Operator CRD가 없으면 RBAC가 있어도 SparkApplication live smoke는 시작하지 않는다.

Spark Operator는 B manifest의 API group과 일치하는 Kubeflow chart 2.5.1만 사용한다. values는 `infra/eks/values/operators/spark-operator.dev.yaml`이며 chart version, chart archive SHA-256, controller와 CRD hook image digest, `asklake-dev` watch scope, 기존 `asklake-spark` ServiceAccount 재사용과 resource 경계를 고정한다. verifier와 deploy script는 chart를 임시 디렉터리로 내려받아 checksum을 확인한 같은 archive만 `show`·`template`·`upgrade`에 사용하며 임시 파일은 종료 시 삭제한다. 저장소에 binary chart를 vendoring하지 않는다. 설치 전 정적 검증을 실행한다.

```bash
bash scripts/verify-eks-spark-operator.sh

export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_SPARK_OPERATOR_APPLY_CONFIRM='install-spark-operator-2.5.1'
bash scripts/deploy-eks-spark-operator.sh
```

설치 완료는 controller/webhook Ready, SparkApplication CRD `Established`, stored version `v1beta2`, webhook `Fail`과 `asklake-dev` namespace selector, 저장소 admission fixture의 server-side dry-run, `scripts/verify-eks-spark-rbac.sh`의 allow/deny matrix와 세 workload kind의 전역 0개 확인까지다. 실제 SparkApplication은 image digest, runtime Secret과 fixture 입력이 준비되기 전 제출하지 않는다.

삭제는 두 단계다. 첫 확인값은 exact release만 제거하고 CRD를 기본 보존한다. CRD까지 없애려면 전역 `SparkApplication`, `ScheduledSparkApplication`, `SparkConnect`가 모두 0개이고 CRD ownership tuple이 일치한 상태에서 두 번째 확인값도 명시한다.

```bash
ASKLAKE_SPARK_OPERATOR_DESTROY_PREFLIGHT_ONLY=true \
  bash scripts/destroy-eks-spark-operator.sh

export ASKLAKE_SPARK_OPERATOR_DESTROY_CONFIRM='uninstall-spark-operator-after-empty-check'
# CRD도 정말 제거할 때만 추가한다.
export ASKLAKE_SPARK_OPERATOR_CRD_DESTROY_CONFIRM='delete-owned-empty-spark-operator-crds'
bash scripts/destroy-eks-spark-operator.sh
```

Spark 4.0.1 대표 application 실행에서 shutdown client가 label selector로 Pod·Service·ConfigMap·PVC collection cleanup을 호출하는 것을 확인했다. 따라서 driver Role에는 Pod `create/get/list/watch/delete/deletecollection`, Service·ConfigMap `create/get/list/delete/deletecollection`, PVC cleanup-only `get/list/delete/deletecollection`을 둔다. B manifest는 PVC를 생성하지 않으므로 PVC `create/update/patch`는 계속 금지하고 Service·ConfigMap `update/patch`도 추가하지 않는다. `deletecollection`은 selector를 RBAC로 제한할 수 없어 같은 namespace의 다른 resource에 영향을 줄 수 있으므로 Airflow PVC 같은 stateful workload를 추가하기 전에 Spark 전용 namespace 여부를 다시 결정한다. 상세 증거는 [7월 15일 Spark Operator 적용 기록](eks-day15-spark-operator-evidence.md)을 따른다.

`scripts/verify-eks-spark-rbac.sh`는 revision 3의 전체 `deletecollection`·PVC cleanup 허용과 PVC create/update/patch, Secret read, update/patch, 다른 namespace·cluster resource 거부를 실제 API authorization으로 검사한다. `scripts/verify-eks-foundation.sh`도 렌더된 Spark Role의 세 resource/verb rule을 정확히 확인하고 추가 rule이나 과권한을 거절한다.

Phase 2 AWS inventory는 resource name, ARN, endpoint, public IP와 account ID를 출력하지 않는 아래 스크립트로 확인한다. `AccessDenied`는 빈 inventory로 해석하지 않으며 [Phase 2 AWS Inventory](eks-phase-2-inventory.md)의 read-only 권한과 생성 gate를 따른다.

```bash
bash scripts/inspect-eks-aws-inventory.sh
```

Phase 3의 MSK/RDS/S3 Terraform은 기본적으로 모두 `disabled`이며 mock provider test만으로 정적 계약을 검증한다. S3 `managed-existing`은 기존 bucket을 state로 import하고 삭제 보호 아래 설정을 관리한다. `existing`, `managed-existing`, `create` 입력, MSK topic bootstrap, RDS 논리 database bootstrap, IAM identity 연결과 실제 apply 조건은 [Phase 3 Data Plane 계약](eks-phase-3-data-plane.md)을 따른다. 실제 식별자는 `terraform.tfvars` 또는 승인된 secret/config delivery에만 두고 문서나 PR 본문에 복사하지 않는다.

Phase 4의 workload identity 기본값은 `disabled`다. dev EKS Auto Mode는 2026-07-15 Pod Identity를 선택해 Backend/MSK smoke/Spark/Trino의 분리 role과 association, STS·S3 positive/negative smoke까지 적용했다. 다른 환경은 실제 Auto Mode/Agent readiness 확인 없이 이를 활성화하지 않는다. 신규 cluster의 IRSA는 cluster/OIDC provider 단계와 identity 단계를 분리하며, 생성 예정 ARN을 resource key로 사용하지 않는다. dev RDS의 세 database/user bootstrap은 실제 endpoint·backup·rollback 승인, expected host 일치, `verify-full` CA와 명시적 confirmation 아래 EKS Job으로 실행했다. Job은 role flags, 실제 자기 database 로그인과 cross-database 거부를 검사하며 application schema migration을 대신하지 않는다. 상세 절차는 [Phase 4 Workload Identity와 RDS Bootstrap](eks-phase-4-identity-rds-bootstrap.md)을 따른다.

Backend S3 runtime smoke는 현재 FastAPI의 immutable image와 `asklake-backend` Pod Identity를 재사용한다. runner가 live IAM policy에서 허용 resource를 찾으므로 실제 bucket/ARN을 repository argument나 문서에 넣지 않는다. negative GetObject는 존재하지 않는 key가 아니라 실행자가 만든 계약 밖 sentinel을 대상으로 해야 한다. `NoSuchKey`는 권한 거절 증거로 인정하지 않는다. 실행 명령은 다음과 같다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=asklake-dev
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export AWS_REGION=ap-northeast-2
export ASKLAKE_BACKEND_S3_SMOKE_CONFIRM=run-backend-s3-boundary-smoke
bash scripts/run-eks-backend-s3-smoke.sh
```

완료 조건은 예상 Pod Identity role, Raw/Output/Warehouse Get 성공과 Put 거절, Query Result/Evidence Put·Get·Delete 성공, 계약 밖 실제 Warehouse/Query Result object의 Get·prefix List 거절, GetBucketLocation 거절, exact object version/DeleteMarker와 임시 Pod/ConfigMap 정리다. runner는 실행마다 고유 이름을 사용하므로 연속 두 번 실행해 충돌과 잔여 자원이 없는지 확인한다. ListBucket statement는 bucket 하나만 가져야 하며 한 bucket의 `*` 조건을 다른 bucket statement와 합치지 않는다. 이 격리는 Backend뿐 아니라 Spark·Trino에도 적용하지만, 정적 policy 적용은 해당 workload의 runtime smoke를 대신하지 않는다. 실제 결과와 rollback은 [Backend S3 최소 권한 검증 기록](eks-day15-backend-s3-runtime-evidence.md)을 따른다.

2026-07-15 `dev` 환경의 실제 EC2 database 규모, 서울 리전 PostgreSQL·instance·비용 비교, 권장 Terraform 입력과 Continuous DB 분리 위험은 [EKS MVP 7월 15일 RDS 분석 결과](eks-day15-rds-analysis.md)에 기록한다. 실제 격리 RDS 적용, bootstrap 검증과 rollback 경계는 [7월 15일 RDS 적용 기록](eks-day15-rds-apply-receipt.md)을 따른다.

EKS workload에 RDS endpoint를 주입하기 전 [EC2 → RDS·S3 데이터 복사 리허설](eks-day15-data-copy-rehearsal.md)을 수행한다. 사용자 접속이 없더라도 FastAPI background, Airflow scheduler, Trino collector와 Kafka Continuous가 쓰기를 계속할 수 있으므로 active writer와 실행 중 Run을 먼저 확인한다. application DB dump에서는 Iceberg JDBC Catalog 두 테이블을 분리해 각각 `asklake_app`과 `iceberg_catalog`로 복원하고, Airflow DB는 `airflow_metadata`로 복원한다. source role/ACL/secret은 복사하지 않는다. Production object가 기존 관리 S3의 같은 bucket/key에 있으면 재복사하지 않고 존재·version/checksum과 RDS row의 URI를 검증한다. 실제 copy, restore와 cutover는 한 작업으로 묶지 않으며 기존 EC2는 rollback 원본으로 유지한다. dev 실제 분리 복원과 정리 증거는 [데이터 복사 리허설 기록](eks-day15-data-copy-receipt.md)에 남긴다.

RDS bootstrap의 오대상/TLS preflight, 2회 실행 멱등성, role 관리 권한 부재와 database CONNECT 격리는 실제 AWS 없이 아래 Docker 검증으로 확인한다.

```bash
bash scripts/verify-eks-rds-bootstrap.sh
```

Phase 5에서 Pair A는 `infra/eks/delivery/dev.handoff.example.json`을 기준으로 infrastructure output을 Pair B workload에 전달한다. example은 실제 AWS 식별자와 secret을 포함하지 않는 planning 파일이며, 실제 값이 채워진 `*.handoff.json`은 Git ignore 대상이다. 선택이 필요한 항목을 임의로 정하지 않은 상태에서도 아래 검증은 통과하고 deploy-ready gate가 닫혀 있음을 확인한다.

```bash
bash scripts/verify-eks-delivery-handoff.sh
```

승인된 실제 환경 handoff는 Git 밖에서 `node scripts/verify-eks-delivery-handoff.mjs --ready <path>`로 검사한다. `--ready`는 다섯 ECR digest, 실제 MSK/RDS/S3 reference, identity mode와 ingress/secret/network 관련 선택이 모두 채워져야 통과한다. 상세 입력과 A/B 인수 기준은 [Phase 5 배포 Handoff](eks-phase-5-delivery-handoff.md)를 따른다.

Phase 6 image delivery workflow를 수정하면 아래 검증을 실행한다. 이 검증은 image를 build/push하지 않고 수동 trigger, GitHub OIDC, AMD64 platform, immutable receipt와 자동 실행 금지 계약만 확인한다.

```bash
bash scripts/verify-eks-image-delivery.sh
```

실제 ECR push는 GitHub의 `EKS image delivery` workflow를 수동 실행한다. 먼저 선택한 environment에 region, OIDC image role ARN, Frontend output bucket variable을 등록하고 foundation Terraform이 만든 여섯 repository에 `ai-gateway`가 포함됐는지 확인한다. 성공 artifact의 현재 receipt는 `node scripts/verify-eks-image-receipt.mjs --require-ai-gateway <path>`로 재검증한 뒤 Phase 5 handoff의 image 값으로 사용한다. v1.0 receipt는 과거 rollback 소비자에서만 호환되고 새 Gateway 배포에는 사용할 수 없다. 장기 AWS access key를 GitHub Secret이나 repository에 추가하지 않는다. 세부 실행 gate는 [Phase 6 ECR Image Delivery](eks-phase-6-image-delivery.md)를 따른다.

Phase 7/13 network ingress를 변경하면 아래 검증을 실행한다. 기본 values는 Kubernetes resource를 렌더링하지 않아야 한다. enabled values는 Auto Mode readiness, exposure, target/address type, listener protocol과 subnet 2개 이상이 필요하다. HTTP는 AWS 생성 ALB DNS를 사용하므로 host·certificate·DNS owner를 비워 두고, HTTPS를 선택할 때만 세 값을 모두 요구한다. 실제 identifier가 들어간 values는 example 파일에 저장하지 않는다.

```bash
bash scripts/verify-eks-network-ingress.sh
```

`phase13_alb_handoff.ready_for_server_dry_run`은 Auto Mode ALB manifest 입력이 완전하다는 뜻이고 `phase7_network_handoff.decisions_complete`는 private egress와 Pod traffic enforcement 선택까지 끝났다는 호환 상태다. 둘 다 실제 network 동작 성공을 의미하지 않는다. 실제 적용 전 server-side dry-run과 namespace/class/subnet 경계를 확인하고, 적용 후 `/`, `/api/health`, RDS, MSK, ECR/S3/STS의 positive smoke와 차단 대상 negative smoke를 실행한다. 상세 선택 기준은 [Phase 13 Auto Mode ALB 진입 경로](eks-phase-13-auto-mode-alb.md)를 따른다.

Phase 8 runtime Secret 계약을 변경하면 아래 검증을 실행한다. example에는 Secret 이름, key, 공유 binding과 file mount만 있으며 실제 value를 추가하지 않는다. 저장소 기본 delivery mode는 `disabled`지만 dev 환경은 Secrets Manager + ESO를 선택했다. ESO chart는 `infra/eks/values/secrets/external-secrets.dev.yaml`, namespaced store는 `infra/eks/secrets/aws-secrets-manager-store.yaml`을 기준으로 한다.

```bash
bash scripts/verify-eks-runtime-secrets.sh

helm template external-secrets external-secrets/external-secrets \
  --version 2.7.0 \
  --namespace external-secrets \
  -f infra/eks/values/secrets/external-secrets.dev.yaml
```

실제 환경에서는 controller Helm release를 먼저 설치하고 Terraform으로 전용 Pod Identity를 연결한 뒤 controller Pod를 재생성한다. association 전에 시작한 Pod는 credential endpoint가 주입되지 않으므로 재시작이 필수다. 이후 namespaced `SecretStore`가 `Ready=True`인지 확인한다. 전용 IAM policy는 현재 account/region의 `asklake/dev/*`에 대한 read 세 action만 가져야 한다. static access key, `ClusterSecretStore`, PushSecret과 application ServiceAccount의 Secret read RBAC은 추가하지 않는다.

실제 환경의 선택 완료 여부는 `node scripts/verify-eks-runtime-secrets.mjs --ready <path>`로 확인한다. 이 gate와 `SecretStore Ready`는 전달 기반이 완전하다는 의미일 뿐 네 application Secret이 생성됐거나 workload가 기동했다는 증거가 아니다. 배포에서는 value를 출력하지 않고 Secret 이름/key 존재, workload `secretKeyRef`/file mount, rotation rollout과 rollback을 별도로 검증한다. smoke source는 `asklake/dev/smoke/` 아래에만 임시 생성하고 hash 비교 후 `ExternalSecret`, target Kubernetes Secret과 Secrets Manager source를 모두 삭제한다. 상세 경계는 [Phase 8 런타임 Secret 전달 계약](eks-phase-8-runtime-secrets.md)을 따른다.

15일차 최초 Backend runtime 전환은 `DATABASE_URL`, `BOOTSTRAP_ADMIN_PASSWORD` 두 key의 수동 target에서 시작했으며 이후 Airflow 연결에서 5개로 확장됐다. 이 상태는 역사적 migration baseline이다. 현재 `infra/eks/secrets/backend-runtime-external-secret.yaml`은 bounded Backend가 실제 소비하는 DB 2개, Airflow 3개, Trino 인증·서명·CA 7개의 정확한 12-key canonical mapping이다. AI runtime 선택 전에는 planning 계약의 AI key를 placeholder로 만들지 않는다. 기존 target을 같은 이름의 ESO 소유 target으로 인계하기 전에는 AWS source와 staged target의 key 집합 및 전체 byte hash가 일치해야 한다. 값, endpoint와 ARN은 출력하거나 tracked·일반 artifact에 저장하지 않는다.

Backend key 집합은 `runtime-secret-contract.example.json`의 `runtimeProfiles.backend`가 기준이다. `full-service` scope는 공통 key에 선택한 Airflow 인증 방식과 AI runtime profile의 실제 소비 key만 합성한다. username/password 기준 direct rollback은 13개, Gateway target은 provider key를 제외한 15개다. 별도 `asklake-ai-gateway-runtime`은 service/MCP/provider key exact 3개다. `--audit`은 전달 계약을, `--full-service-ready`는 선택과 provider workload 승인을 함께 요구한다.

Gateway 전환은 `promote-eks-ai-gateway-runtime.sh --preflight|--apply <gateway-values> <direct-rollback-values> <direct-rollback-source.json>`를 사용한다. 두 private values, exact 13-key direct source와 runtime contract는 Git 제외·`0600`이어야 한다. apply는 두 Gateway source/임시 target의 전체 canonical hash를 대조하고 ExternalSecret/ConfigMap을 함께 전환하며, 실패하면 Backend Secrets Manager source, 저장한 spec과 direct values를 복원한다. 배포 전 `verify-eks-ai-gateway-runtime.mjs`는 ExternalSecret Ready/Owner, target controller ownerReference, exact 15/3 key, 공유 token binding, Helm ConfigMap owner를 값 출력 없이 확인한다. 제품 동작은 별도 `run-eks-ai-gateway-live-smoke.sh`로 `/api/health/ai`, Query AI, Dashboard Assistant를 확인한다.

```bash
kubectl apply --dry-run=server \
  -f infra/eks/secrets/backend-runtime-external-secret.yaml
bash scripts/migrate-eks-backend-runtime-secret.sh --verify-existing
# 수동 target을 실제로 인계할 때만:
# ASKLAKE_BACKEND_SECRET_HANDOVER_CONFIRM=handover-validated-backend-runtime \
#   bash scripts/migrate-eks-backend-runtime-secret.sh --handover
bash scripts/verify-eks-day15-backend-secret-runtime.sh
```

실제 credential 값을 바꾸지 않은 강제 refresh와 FastAPI rollout restart를 rotation wiring smoke로 사용한다. DB password 자체의 회전은 RDS role password 변경과 source version 갱신을 함께 처리하는 별도 운영 절차이며, 이 smoke에서 수행하지 않는다.

`--handover`는 현재 bounded 12-key source, 수동 target과 staged ESO target의 exact set·전체 hash가 같을 때만 진행한다. 실패 rollback도 12개 전체를 복원하고 canonical Secret 단독 참조, FastAPI 2/2, ALB/RDS health를 확인한다. 2-key 또는 5-key만 복구하는 코드는 허용하지 않는다.

Phase 5와 Phase 8을 함께 검사할 때는 `verify-eks-deploy-readiness.mjs`를 사용한다. planning에서는 Phase 5가 미선택이면 Phase 8이 `disabled`인지 확인하고, `--ready`에서는 두 delivery 값의 일치와 full-service Secret contract까지 요구한다. Airflow 실행 token은 Secret key와 실제 DAG env 이름이 다르므로 `AIRFLOW_EXECUTION_API_TOKEN -> ASKLAKE_EXECUTION_API_TOKEN` binding을 유지한다.

Phase 10은 신규 EKS foundation을 Auto Mode로 생성하고 표준 Managed Node Group을 사용하지 않는다. `cluster_mode = "create"`에는 검토한 `cluster_admin_principal_arn`이 필수이고, `cluster_mode = "existing"`에는 실제 환경에서 확인한 `existing_auto_mode_enabled = true`와 node role ARN이 필수다. 기존 cluster 경로의 입력은 Terraform이 해당 cluster를 활성화하거나 상태를 완전히 검증했다는 뜻이 아니다. AWS CLI/Console과 platform owner evidence가 없는 상태에서는 실제 배포 준비 완료로 표시하지 않는다.

General/Spark custom NodePool과 NodeClass는 Phase 12, VPC와 실제 private network는 Phase 11, 공개/내부 ALB는 Phase 13의 선택·검증 범위다. Phase 10 변경 시 [Auto Mode Foundation](eks-phase-10-auto-mode-foundation.md)의 정적 검증을 실행하고 `aws_eks_node_group` 또는 삭제된 managed-node 입력이 다시 추가되지 않았는지 확인한다.

Phase 11은 `network_mode=external`을 기본으로 유지한다. `create`는 신규 MVP-owned cluster에서만 사용하며 실제 VPC CIDR, 2개 이상 AZ, `subnet_newbits`, 중복되지 않는 public/private netnum과 private egress 결정을 모두 입력해야 한다. subnet CIDR은 VPC CIDR에서 계산하고 example에 실제 주소나 resource ID를 넣지 않는다.

NAT를 선택하면 `single`과 `per_az`의 비용·가용성 차이를 승인 기록에 남긴다. endpoint/hybrid를 선택하면 EC2, ECR API/DKR, Logs, STS interface endpoint와 S3 gateway가 baseline이고 workload/identity/secret/ALB 선택에 따른 추가 endpoint와 non-AWS egress를 별도로 검토한다. private-only Kubernetes API를 유지하면 VPN/SSM/VPC runner 같은 `kubectl`·Helm 실행 경로도 배포 전에 확정한다. Phase 11 plan 성공은 network 연결 증거가 아니다. dev는 EKS private Pod에서 S3/STS, MSK `9098`, RDS `5432`, wrong-port와 VPC 외부 negative smoke를 통과했다. Auto Mode Network Policy Controller는 `infra/eks/network/auto-mode-network-policy-controller.yaml`로 활성화하고 NodeClass `DefaultAllow`에서 임시 deny enforcement를 확인했다. 실제 workload 정책은 B의 Service·port 계약 뒤 추가한다. 상세 기준과 증거는 [Phase 11 VPC와 Private Network Foundation](eks-phase-11-network-foundation.md), [7월 15일 Private Network 검증 기록](eks-day15-private-network-evidence.md)을 따른다.

Phase 12 chart는 disabled 기본값에서 NodeClass와 NodePool을 하나도 렌더하지 않는다. 활성화하려면 custom node role access, private subnet/node security group tag selector, General/Spark capacity type·instance category·generation, CPU/memory 상한과 disruption 값을 실제 workload 기준으로 모두 선택한다. 저장소의 `node-pools.test.example.yaml`은 테스트 fixture이며 운영 권장값이 아니다. B의 일반 workload에는 general selector, SparkApplication driver/executor에는 spark selector와 `NoSchedule` toleration을 각각 넣고 다음 검증을 실행한다.

```bash
bash scripts/verify-eks-auto-mode-node-pools.sh
bash scripts/verify-eks-foundation.sh
```

실제 적용은 Terraform output의 role 이름을 비공개 environment value로 넘기고 server-side dry-run 뒤 수행한다. NodeClass/NodePool Ready, positive/negative scheduling, node scale-out/in, 상한, interruption과 비용 evidence가 없으면 정적 완료 상태로만 기록한다. 7/17 감사에서는 Web/Collector의 General selector와 Spark driver/executor selector·toleration은 일치했지만 Airflow는 selector 없이 우연히 General node에 배치됐고 Trino는 built-in `general-purpose`에 배치됐다. live Deployment patch로 숨기지 않고 component chart owner가 placement를 명시한 뒤 통합한다. 세부 순서는 [Phase 12 Auto Mode NodeClass와 NodePool](eks-phase-12-auto-mode-node-pools.md)과 [Day 17 A 계약 감사](eks-day17-a-nodepool-contract-audit.md)를 따른다.

Phase 13 ingress는 저장소 밖 values 파일로 먼저 `--render`한다. `routesEnabled=false` foundation 적용은 target cluster/context·namespace label·IngressClassParams API와 server-side dry-run을 확인하고 전용 confirmation으로 class/params만 설치한다. 이 상태는 Service를 요구하지 않고 ALB도 요청하지 않는다. 최종 Frontend/FastAPI Service가 준비된 뒤 `routesEnabled=true`를 적용할 때만 두 Service와 비용 confirmation을 요구하고 ALB를 생성한다. self-managed controller용 class/group/scheme/certificate annotation을 다시 추가하지 않는다. 삭제는 Ingress finalizer 완료, Helm class 삭제, AWS 잔여 ALB 확인, cluster/VPC 순서다. 명령과 runtime 증거는 [Phase 13 Auto Mode ALB 진입 경로](eks-phase-13-auto-mode-alb.md)를 따른다.

기존 release upgrade의 API server preflight는 `helm upgrade --install --dry-run=server`로 수행해 Helm field ownership을 유지한다. 별도 `kubectl apply --server-side` manager로 IngressClassParams를 인수하지 않는다. route 적용 후에는 아래 runtime verifier로 두 Ingress의 shared ALB, 2개 AZ, listener route, target port와 health path, `/`, `/api/health`와 RDS health를 확인한다. 정상 상태에서는 `--steady`를 사용해 draining 0과 각 Service의 Ready EndpointSlice IP 집합이 ALB healthy target 집합과 정확히 같은지 확인한다. 의도한 rolling update 도중에만 `--rollout`을 사용하며 healthy/draining 외 상태는 허용하지 않는다. 실제 hostname, target IP와 ARN은 출력하거나 Git에 기록하지 않는다. 적용 결과는 [EKS 15일차 ALB route 적용 기록](eks-day15-alb-runtime-evidence.md)을 따른다.

```bash
bash scripts/verify-eks-day15-alb-runtime.sh --steady
# 의도한 rolling update 중 일시적으로만 사용한다.
bash scripts/verify-eks-day15-alb-runtime.sh --rollout
```

15일차 ALB·Secret·S3 통합을 시작하기 전에는 아래 read-only capture로 Frontend/FastAPI replica와 Service endpoint, RDS health, Ingress/ExternalSecret 부재, 수동 runtime Secret key, SecretStore와 General node 상태를 비밀 제외 JSON으로 고정한다. `--expect-pre-change`는 ALB route나 ExternalSecret을 적용하기 전 한 번만 사용하는 정확한 Phase 0 gate다. 적용 후 상태 확인에는 `--capture`를 사용한다. 기준 판정과 rollback 경계는 [EKS 15일차 통합 마무리 Phase 0 기준점](eks-day15-integration-baseline.md)을 따른다.

```bash
bash scripts/capture-eks-day15-integration-baseline.sh --expect-pre-change
```

위 live 검증 script와 Backend S3 runner는 모두 `ASKLAKE_EKS_CLUSTER_NAME`을 필수로 받고 AWS EKS endpoint와 현재 `kubectl` endpoint가 같은지 먼저 확인한다. namespace 존재 확인까지 통과하기 전에는 Kubernetes 또는 AWS runtime 검증을 수행하지 않는다.

Phase 14 web/collector workload와 FastAPI HPA 변경은 `bash scripts/verify-eks-web-workloads.sh`로 검사한다. verifier는 HPA 활성 render의 `autoscaling/v2`, `2..6`, CPU metric·scale behavior와 FastAPI `spec.replicas` 부재, HPA 비활성 render의 고정 replica 복귀, Collector 보존을 함께 확인한다. 실제 배포 values는 저장소 밖에 두고 Phase 6 image receipt와 함께 `deploy-eks-web-workloads.sh --render`로 먼저 검토한다. apply는 Foundation ServiceAccount, runtime ConfigMap/Secret, General NodePool label, B의 FastAPI runtime 경계가 실제로 준비된 뒤에만 허용하며 HPA 활성화에는 Metrics API와 baseline CPU 확인을 추가한다. 기존 Helm release의 image를 바꾸는 preflight는 `helm upgrade --install --dry-run=server`로 수행해 Helm field ownership을 유지하며, 별도 `kubectl apply --server-side` manager로 Deployment/HPA field를 인수하지 않는다. Phase 13 Ingress보다 workload를 먼저 배포하고 삭제할 때는 Ingress와 ALB finalizer를 먼저 제거한다. 자세한 gate와 명령은 [Phase 14 Frontend·FastAPI·Collector Workload](eks-phase-14-web-workloads.md)를 따른다.

Day 17 A/B 최종 통합 campaign은 반드시 최신 `pair1` merge SHA를 고정한 read-only baseline 뒤에 시작한다. baseline에서 다른 active Job/SparkApplication/Pending·terminating Pod, EndpointSlice drain, stale smoke release를 확인하고 General/Spark placement와 canonical image receipt를 함께 검사한다. exclusive window만 열려 있고 placement나 receipt가 닫혀 있으면 정적 검증은 계속할 수 있지만 API load와 Spark 제출은 시작하지 않는다. 2026-07-17 최초 통합 baseline은 live Airflow·Trino General selector 미반영과 canonical Day 17 receipt 부재를 확인해 live campaign을 차단했다. 상세 상태와 복구 순서는 [Day 17 A/B 최종 통합 검증 기준점](eks-day17-final-integration-baseline.md)을 따른다.

통합 baseline 뒤 정적 검증은 A NodePool/evidence, B workload/HPA/multi-Spark, Backend 집중 회귀, receipt sanitizer와 Terraform을 모두 포함한다. Python 집중 테스트는 CI와 같은 Python 3.13 계열 또는 `backend/.venv/bin/python`으로 실행한다. 프로젝트 dependency가 없는 system Python의 import 실패를 source regression으로 판정하지 않으며 올바른 interpreter로 재실행한 결과를 함께 기록한다. 로컬 Terraform CLI가 없으면 이 문서의 `hashicorp/terraform:1.15.8` Docker 명령으로 `fmt`, `init -backend=false`, `validate`, `test`를 보완한다. Issue #909의 실제 통과 범위는 [Day 17 A/B 최종 통합 정적 검증](eks-day17-final-integration-static-verification.md)을 따른다.

병합된 placement를 기존 component release에 반영할 때는 먼저 `helm get values`를 mode `0600` 임시 파일에 저장하고 현재 manifest와 새 render를 구조 비교한다. image, env, Secret reference, Service, ConfigMap, resource와 probe가 동일하고 nodeSelector delta만 존재할 때 release별 `helm upgrade --install --dry-run=server`를 실행한다. Airflow의 placement-only upgrade는 migration hook을 다시 실행할 이유가 없으므로 `--no-hooks`를 사용한다. Issue #909에서는 Airflow revision `17→18`, Trino `15→16`을 component ownership 그대로 적용했고 모든 대상 Pod의 General 배치, EndpointSlice, ALB/RDS steady를 통과했다. 적용 결과와 rollback 기준은 [Day 17 A/B 최종 통합 placement 적용](eks-day17-final-integration-placement.md)을 따른다.

Phase 3의 canonical image 정렬은 공식 image delivery workflow가 만든 하나의 receipt를 Frontend, Backend/Collector, Airflow, Spark runtime과 Trino에 함께 적용한다. 같은 Kafka topic의 multi-Spark scale candidate가 존재하더라도 HPA same-run fixture 선택은 기본 consumer group 하나만 허용해야 한다. receipt와 live role `5/5`, `linux/amd64`, Backend contract version `2`와 slot `4`, multi-Spark와 HPA preflight를 모두 확인한 실제 결과는 [Day 17 A/B 최종 이미지 정렬과 preflight](eks-day17-final-integration-image-alignment.md)를 따른다.

Issue #909 Phase 4에서는 50 RPS probe 뒤 200 RPS 부하로 HPA `2→4→6`을 확인하고 `6/6/6`에서 same-run 경합을 시작했다. scale-down으로 Airflow 연결이 실패해도 새 Run을 만들지 않고, failed-task dry-run, 같은 DAG run clear, persisted state sync와 read-only recovery verification 순서를 지킨다. 실제 exact-one 결과와 200 RPS 발행 skip 한계는 [Day 17 최종 통합 HPA campaign](eks-day17-final-integration-hpa-campaign.md)을 따른다.

Issue #909 Phase 5의 직접 multi-Spark 제출은 Frontend polling을 동반하지 않으므로 Spark/Catalog가 success여도 RDS 요약이 queued로 남을 수 있다. 이 경우 새 Run을 제출하거나 Spark를 재실행하지 않고 정상 `get_job` 조회 경로를 각 Job에 한 번 호출해 Airflow terminal 상태만 동기화한 뒤 read-only result verifier를 실행한다. 실제 Run 3개, Spark Node `0→1→2`, exact row `300/300`과 전체 pairwise isolation 결과는 [Day 17 최종 통합 multi-Spark campaign](eks-day17-final-integration-multi-spark-campaign.md)을 따른다.

Phase 6 observer를 재시작할 때 submission receipt `createdAt`은 Run 생성 직후 기록되므로 그대로 `--since`에 쓰면 같은 초의 Run이 빠질 수 있다. private receipt 시각보다 2초 앞선 범위로 시작하고 Run A/B/C exact hash set이 일치하는지 확인한 뒤 기존 JSONL에 append한다. HPA/ALB와 Spark Node를 수동 scale/delete하지 않고 cleanup audit이 `2/2`, Spark Node `2→0`, removal event와 임시 자원 `0`을 직접 확인하게 한다. Issue #909 결과는 [Day 17 최종 통합 scale-in과 cleanup](eks-day17-final-integration-scale-in-cleanup.md)을 따른다.

17일 scale 실험을 시작하기 전 별도 터미널에서 아래 read-only observer를 먼저 실행한다. 화면은 선택한 namespace의 HPA CPU/replica, FastAPI Deployment/Pod, Spark driver/executor와 phase, AWS 관리형 NodePool별 node 수, 최근 15분의 autoscaling/scheduling event를 5초마다 집계한다. 원본 Pod·Node·Run 이름, ARN, account, endpoint는 출력하거나 JSONL에 기록하지 않는다. AWS region은 `ASKLAKE_AWS_REGION`/`AWS_REGION`, 현재 kubeconfig, AWS config 순으로 찾고 cluster 이름은 `ASKLAKE_EKS_CLUSTER_NAME`을 우선 사용한다. 환경에서 보이는 EKS cluster가 정확히 하나일 때만 cluster 이름을 자동 선택한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
# 여러 EKS cluster가 보이는 계정에서는 반드시 지정한다.
export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
node scripts/watch-eks-day17-scale.mjs \
  --interval 5 \
  --record /private/tmp/asklake-day17-scale-observer.jsonl
```

observer는 `kubectl get/list/raw/config view`, AWS `list/describe/config get`, 로컬 JSONL append만 수행하고 workload나 autoscaling 설정을 변경하지 않는다. `--record` 경로는 저장소 밖만 허용하고 파일 mode를 `0600`으로 고정한다. 직접 Pod Metrics RBAC가 없으면 화면에 `RBAC forbidden`을 표시하며, HPA가 배포된 뒤에는 HPA status의 aggregate CPU로 scale 판단을 계속 볼 수 있다. 부하 runner가 아래 aggregate JSON을 저장소 밖 파일에 갱신하면 `--load-status <path>`로 같은 화면의 `LOAD` 행에 연결한다. endpoint나 요청별 식별자는 이 파일에 넣지 않는다.

```json
{"phase":"ramp-100","targetRps":100,"totalRequests":4200,"non2xx":0,"serverErrors":0,"p95Ms":84}
```

첫 API 부하 단계는 외부 Backend ALB의 읽기 전용 `/api/health`에 50 RPS를 60초 동안 보낸다. runner는 실행 전에 현재 EKS context와 ALB steady target, Backend/RDS health를 확인하고 endpoint는 출력하거나 status JSON에 저장하지 않는다. status 파일은 저장소 밖에 mode `0600`으로 원자적으로 갱신한다. 5xx 또는 DB health 실패가 한 번이라도 발생하거나 transport 오류가 5회 연속 발생하거나 비-2xx 비율이 0.1%를 넘으면 중단한다. 다음 100/200 RPS 단계는 앞 단계 결과를 검토한 뒤 별도로 실행한다.

```bash
export ASKLAKE_DAY17_LOAD_CONFIRM=run-read-only-api-load
export ASKLAKE_DAY17_LOAD_RATE=50
export ASKLAKE_DAY17_LOAD_DURATION_SECONDS=60
bash scripts/run-eks-day17-api-load.sh
```

같은 `runId`의 HPA 경합 실험은 전용 runner로만 수행한다. runner는 실행 전에 HPA current/desired와 FastAPI Ready가 정확히 `6/6/6`인지 확인하고, Deployment selector에서 서로 다른 Ready Pod 6개를 골라 동일한 내부 실행 요청을 동시에 보낸다. 새 producer fixture를 만들 수 있는 기존 권한이 없으면 IAM이나 NodePool 권한을 넓히지 않는다. 이 경우 exact batch marker와 100-record count가 이미 고정된 성공 fixture만 `--prepare-reuse`로 선택하며, 안전한 fixture가 없으면 실행하지 않는다. fixture 선택은 기본 bounded consumer group `asklake-eks-mvp-spark-v1`과 persisted boundary의 group이 모두 정확히 일치해야 하며, `asklake-eks-mvp-spark-scale17-*` multi-Spark 후보는 같은 topic을 사용하더라도 HPA 경합 후보에서 제외한다. 전용 Run의 결과와 receipt는 항상 새로 만든다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
bash scripts/run-eks-day17-hpa-race.sh --preflight

export ASKLAKE_DAY17_REUSE_CONFIRM=reuse-persisted-bounded-fixture
bash scripts/run-eks-day17-hpa-race.sh --prepare-reuse

# 별도 read-only 부하와 observer에서 HPA/FastAPI 6/6/6을 확인한 뒤 실행한다.
export ASKLAKE_DAY17_RACE_CONFIRM=run-one-day17-hpa-race
bash scripts/run-eks-day17-hpa-race.sh --run
```

성공 receipt는 RDS Run과 Spark owner/attempt/generation, 외부 실행, Airflow DAG run, SparkApplication object/UID, 새 Iceberg snapshot, Catalog materialization을 직접 다시 읽고 각각 exact-one인지 확인해야 한다. input/output/Trino row count, data file, Continuous session도 함께 확인한다. 원본 식별자가 든 fixture/race receipt는 저장소 밖 mode `0600`만 허용하고 Git 문서에는 count와 가린 timeline만 남긴다.

HPA scale-in으로 Airflow task가 실패한 경우 새 Run이나 새 SparkApplication을 만들어 보완하지 않는다. `--status`로 Spark의 영속 성공과 Catalog 미완료를 먼저 구분하고, `--clear-dry-run`이 같은 DAG run의 실패 task만 선택하는지 검토한다. 실제 `--clear-failed`는 별도 confirmation이 필요하며, 복구 뒤 `--sync-recovered`와 `--recover`로 새 외부 실행·SparkApplication·snapshot이 생기지 않았음을 재검증한다. 2026-07-17 실제 결과와 HTTP log 보존 한계는 [same-run race live evidence](eks-day17-b-same-run-race-live-evidence.md)를 따른다.

17todo 7·8번의 동시 Spark 실행과 Node scale은 FastAPI HPA observer와 분리된 아래 read-only 화면으로 관찰한다. 이 observer는 실행 뒤 생기는 세 fixture Run을 A/B/C alias로 고정하고 RDS/Airflow/Spark/Catalog generation, SparkApplication UID short hash, driver/executor phase, group/table/output/checkpoint의 `3/3 unique`, 관리형 General/Spark instance type 집계와 최근 15분 scheduling/NodeClaim/consolidation event를 5초마다 표시한다. 원본 Run·Job·application·snapshot·dataset·group·table·output·checkpoint 식별자는 FastAPI Pod 안의 SELECT-only query에서 SHA-256 short hash로 바뀐 뒤에만 로컬로 반환한다.

```bash
cd /Users/sisu/Projects/jungle/AskLake
node scripts/watch-eks-day17-multi-spark.mjs \
  --interval 5 \
  --record /private/tmp/asklake-day17-multi-spark-observer.jsonl
```

기본 record는 위 저장소 밖 경로이고 mode `0600`이다. observer는 Kubernetes get/list/config-view, AWS list/describe와 기존 FastAPI Pod 안의 RDS SELECT만 사용한다. Run, Job, Pod, Secret, ConfigMap, IAM, RBAC와 NodePool을 생성·수정·삭제하지 않는다. scale slot·candidate Job·SparkApplication RBAC·Node visibility가 아직 준비되지 않았으면 종료하거나 우회하지 않고 각각 `scale slots not configured`, `candidate jobs missing`, `SparkApplication RBAC unavailable`, `Node visibility unavailable` blocker로 남긴다. 화면과 sanitizer 회귀는 다음 명령으로 확인한다.

```bash
node --test scripts/test-eks-day17-multi-spark-observer.mjs
node scripts/watch-eks-day17-multi-spark.mjs --once --no-clear
```

실제 세 Run 제출은 observer와 별도의 fail-closed runner로만 수행한다. `--preflight`는 기존 FastAPI Pod 안에서 RDS와 SparkApplication API를 읽을 뿐 새 Run·Job·Pod·ConfigMap을 만들지 않는다. 정확한 scale group/table 3쌍, snapshot candidate Job 3개, 하나의 100-record fixture batch, 고유 dataset/table, active slot 0, Airflow 설정과 SparkApplication list 권한을 모두 확인한다. 하나라도 실패하면 `--run`은 호출되지 않는다. `--run`은 별도 confirmation이 필요하고 제출 전에 mode `0600` private receipt를 `armed` 상태로 먼저 만들어, 부분 제출이나 터미널 중단 뒤 같은 명령을 자동 재실행하지 못하게 한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
bash scripts/run-eks-day17-multi-spark.sh --preflight

# preflight가 passed이고 observer를 보고 있는 상태에서만 별도로 실행한다.
export ASKLAKE_DAY17_MULTI_SPARK_CONFIRM=submit-three-isolated-spark-runs
bash scripts/run-eks-day17-multi-spark.sh --run
```

성공 제출 receipt는 `/private/tmp/asklake-day17-multi-spark-receipt.json`에만 두며 원본 Run·Job·dataset·group·table·output·checkpoint 식별자를 포함하므로 Git에 넣지 않는다. 제출 결과가 `partial` 또는 `blocked`이면 새 Run으로 빈 자리를 자동 보충하지 않고 receipt와 observer를 먼저 검토한다.

세 Run이 모두 terminal success가 된 뒤 17todo 9번의 데이터 결과는 아래 read-only
verifier로 닫는다. verifier는 기존 FastAPI Pod에 `kubectl exec`하고 RDS
transaction을 `READ ONLY`로 설정한 뒤, persisted Run/Job/dataset/source
boundary/Spark commit/Catalog materialization과 Trino exact snapshot
`_asklake_run_id` count 및 Iceberg snapshot data-file summary를 대조한다. 새
Run·Job·Pod·SparkApplication이나 Kubernetes resource를 만들지 않으며 retry나
Catalog 재실행도 하지 않는다.

```bash
cd /Users/sisu/Projects/jungle/AskLake
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY17_MULTI_SPARK_RECEIPT=/private/tmp/asklake-day17-multi-spark-receipt.json
export ASKLAKE_DAY17_MULTI_SPARK_RESULTS=/private/tmp/asklake-day17-multi-spark-results.json
bash scripts/verify-eks-day17-multi-spark-results.sh --verify

cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_eks_day17_multi_spark_results -v
```

입력과 출력은 모두 저장소 밖 `/private/tmp/asklake-day17-*.json`, mode `0600`만
허용한다. 기존 결과 파일은 덮어쓰지 않으므로 재검증이 필요하면 이전 evidence를
보존하고 새 출력 경로를 명시한다. stdout과 결과에는 Run A/B/C alias, count,
boolean 판정만 남기며 원본 Run·Job·dataset·group·table·output·checkpoint·fixture
식별자는 기록하지 않는다. 2026-07-17 실제 7·8·9번 결과는
[multi-Spark live evidence](eks-day17-b-multi-spark-live-evidence.md)를 따른다.

부하 종료 뒤 10번 scale-in과 cleanup은 다음 read-only audit로 확인한다.

```bash
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY17_MULTI_SPARK_RECEIPT=/private/tmp/asklake-day17-multi-spark-baked-receipt.json
export ASKLAKE_DAY17_MULTI_SPARK_RESULTS=/private/tmp/asklake-day17-multi-spark-results.json
export ASKLAKE_DAY17_MULTI_SPARK_OBSERVER=/private/tmp/asklake-day17-multi-spark-observer.jsonl
export ASKLAKE_DAY17_CLEANUP_AUDIT=/private/tmp/asklake-day17-cleanup-audit.json
bash scripts/audit-eks-day17-cleanup.sh --audit
```

audit은 HPA `2/2`, FastAPI Deployment/Pod steady, campaign Run 3개 terminal,
driver/executor active `0`, Spark Node peak에서 baseline 복귀와 removal event,
Day 17 temporary Job/Pod/ConfigMap/Secret `0`, local load process `0`, durable
Run/snapshot/materialization 보존을 확인한다. cleanup 대상이 남아 있으면
fail-closed하며 자동 삭제하지 않는다. 대상의 정확한 ownership을 검토한 별도
cleanup 전에는 completed Run, SparkApplication, RDS/Catalog/Iceberg object를
삭제하지 않는다.

10번 audit까지 통과하면 11번의 통합 receipt를 아래 fail-closed generator로
만든다. generator는 HPA race/load/scale observer, multi-Spark campaign,
multi-Spark observer/result와 cleanup audit을 함께 읽는다. 현재 캠페인은 제출
`3`, 실패 `0`, 세 Run hash와 observer/result identity chain이 일치할 때만
`currentCampaignResultsNotSubstituted`를 통과한다. 이전 제출 receipt가 있는
캠페인은 모든 이력을 `--prior`로 전달하고 각 receipt의 contract, 시각, count,
alias/hash와 현재 캠페인 비중복을 검증한다. 이번 Issue처럼 운영자가 이전 제출
receipt가 없다고 판단한 독립 캠페인은 `--no-prior`를 명시한다. 이 mode는
`operator-declared-clean`으로 기록되며 과거 이력의 완전성을 machine-proven으로
표현하지 않는다. `--no-prior`와 `--prior`는 함께 사용할 수 없다.
API `2 → 6 → 2`, 동일 Run exact-one, driver/executor
`Pending → Node 증가 → Running`, Run별 데이터/격리, Spark Node baseline 복귀와
임시 리소스 `0`이 모두 참일 때만 출력한다.

```bash
node --test scripts/test-eks-day17-final-receipt.mjs
node scripts/build-eks-day17-final-receipt.mjs

# 과거 제출 이력이 없는 새 독립 캠페인
node scripts/build-eks-day17-final-receipt.mjs --no-prior \
  --race /private/tmp/asklake-day17-issue909-phase4-race-receipt.json \
  --load /private/tmp/asklake-day17-issue909-phase4-load-200.json \
  --scale-observer /private/tmp/asklake-day17-issue909-phase4-scale-observer.jsonl \
  --campaign /private/tmp/asklake-day17-issue909-phase5-multi-spark-receipt.json \
  --multi-observer /private/tmp/asklake-day17-issue909-phase5-multi-spark-observer.jsonl \
  --multi-results /private/tmp/asklake-day17-issue909-phase5-multi-spark-results.json \
  --cleanup /private/tmp/asklake-day17-issue909-phase6-cleanup-audit.json \
  --output /private/tmp/asklake-day17-issue909-phase7-final-receipt-v3.json
```

기본 출력은 저장소 밖
`/private/tmp/asklake-day17-final-receipt.json`이며 mode `0600`이다. 기존 출력은
덮어쓰지 않는다. 다시 검증할 때는 기존 evidence를 보존하고 `--output`으로 새
`/private/tmp/asklake-day17-*.json` 경로를 지정한다. machine receipt에는
Run A/B/C alias와 12자리 hash, timestamp, aggregate count만 남는다. 입력
`privateIdentity`의 원본 Run/Job/application/snapshot/dataset/group/table/output/
checkpoint 값, Kubernetes Node 이름/IP, URL, ARN이 복사되거나 forbidden key가
생기면 실패한다.

2026-07-17의 API/Spark 두 timeline, 가린 identity chain, 실패/재시도와 미실행
범위는 [Day 17 최종 통합 evidence](eks-day17-final-integrated-evidence.md)를
따른다. Pair A의 NodePool event는 기존 Phase 12/Day 14 문서에 링크하고 Pair B
evidence에 복사하지 않는다.

observer 자체 검증과 현재 상태 한 번 읽기는 다음처럼 수행한다.

```bash
node --test scripts/test-eks-day17-scale-observer.mjs
node scripts/watch-eks-day17-scale.mjs --once --no-clear
```

14일 Metrics Server/Node scale 계약은 `bash scripts/verify-eks-metrics-scale.sh`로 검사한다. 실제 cluster에서는 `describe-addon-versions`로 호환되는 exact community add-on version을 선택하고 Terraform plan/apply 뒤 Metrics API와 `kubectl top`을 확인한다. Node scale smoke는 저장소 밖 values와 evidence 경로를 사용하며 비용 confirmation 없이는 실행되지 않는다. scale-out 뒤 임시 Helm release를 제거하고 Auto Mode scale-in까지 별도 기록한다.

7/17 General/Spark 통합 관찰은 `scripts/capture-eks-day17-autoscaling-evidence.sh`의 `baseline → sample → final` 순서를 사용한다. 동일한 비공개 run token을 유지하고 evidence는 저장소 밖 또는 `infra/eks/delivery/*.day17-autoscaling-evidence.json`에 mode `0600`으로 보관한다. request 여유는 cluster 전체 namespace Pod를 합산하되 placement와 blocker는 대상 namespace에서 판정한다. baseline은 blocker를 기록만 하지만 sample의 release identity drift와 final의 placement/blocker/cleanup 미충족은 실패한다. cleanup은 완료 Pod와 0-replica Deployment를 포함한 run 소유 전체 Kubernetes resource와 Helm release 0을 요구한다. 하네스는 조회 전용이며 실제 부하 생성과 cleanup은 별도 승인된 phase가 소유한다. 세부 계약은 [Day 17 autoscaling 관찰 하네스](eks-day17-a-autoscaling-observer.md)를 따른다.

7/18 Pair A 작업은 `scripts/capture-eks-day18-a-baseline.sh --capture`로 읽기 전용
기준선을 먼저 고정한다. receipt는 저장소 밖 `/private/tmp` 또는 Git ignore 대상
`infra/eks/delivery/*.day18-baseline.json`에 mode `0600`으로만 둔다. 이 단계는
EKS·workload steady state, event 조회 가능성, 기존 CloudWatch/collector 상태,
immutable image, Helm/EC2 rollback과 Continuous 경계를 집계할 뿐 어떤 resource도
변경하지 않는다. Application log 전달 방식은 기준선 결과를 바탕으로 Observability
add-on, Fluent Bit, ADOT을 별도 비교한 뒤 선택하며 RDS log export나 control-plane
log만으로 완료 처리하지 않는다. 상세 계약은 [Day 18 Pair A Phase 0 기준점](eks-day18-a-phase0-baseline.md)을 따른다.

Phase 1 선택은 `infra/eks/observability/day18-observability-decision.json`에 고정하고
`bash scripts/verify-eks-day18-observability-decision.sh`로 검사한다. 선택은 관리형
CloudWatch Observability add-on의 OTel Container Insights, Application Signals와
Classic/dual publish 비활성, 전용 Pod Identity다. exact add-on version/schema,
최소 IAM, log group ownership과 retention은 Phase 2 apply 전에 다시 검증한다. 별도
Fluent Bit/ADOT을 설치하거나 AWS managed policy를 조용히 broad 예외로 사용하지
않는다. 상세 근거와 비용 경계는 [Day 18 관찰 방식 결정](eks-day18-observability-decision.md)을 따른다.

Phase 2는 Terraform apply 뒤 반드시
`bash scripts/reconcile-eks-day18-observability-runtime.sh`를 실행한다. 현재 exact add-on
operator는 node agent와 cluster scraper를 모두 host network로 만들어 telemetry port가
충돌하지만 add-on schema가 `hostNetwork`를 노출하지 않기 때문이다. 이 스크립트는
scraper만 Pod network로 전환하고 Ready를 fail-closed 검증한다. Event는 고유한 저장소
밖 경로를 지정해 `scripts/capture-eks-day18-events.sh --once`로 수집한다. receipt는
mode `0600`이며 type/reason/object kind/namespace class/UTC/count만 포함한다. Application
log 적용 결과와 아직 닫히지 않은 OTel metric/CRI parser gate는
[Day 18 Phase 2 실제 적용 기록](eks-day18-observability-live-evidence.md)을 따른다.

Phase 3 비용 검증은 `scripts/capture-eks-day18-cost-cleanup-evidence.sh --capture`로
수행한다. Day 17 private scale evidence를 입력하고 현재 collector 시작 이후 application
유입량을 24시간으로 보정해 관리 대상 전체의 `3 GiB/day`, `20 GiB stored`, 월 `75 USD`
검토 경계를 판정한다. 5분 미만 관찰은 실패하며 24시간 전 receipt는 full-window 완료가
아니다. 기존 control-plane/RDS와 최초 OTel cluster-wide file log의 합산 예측이
일일 경계를 넘을 것으로 확인돼 OTel metric은 유지하고 add-on-managed Fluent Bit
log로 전환했다. Fluent Bit은
`/var/log/containers/*_asklake-dev_*.log`만 읽고 dataplane·host 입력은 비활성이다.
Spark Node가 최근 완료 application의 기본 1시간 TTL 때문에 남아 있으면 runner는 이를
bounded cleanup pending으로만 기록하고 완전 scale-in으로 표시하거나 durable evidence를
삭제하지 않는다. 상세 결과는 [Day 18 Phase 3 비용·정리 가드레일](eks-day18-cost-cleanup-evidence.md)을 따른다.

Phase 4 Pair A 격리 복구는 `scripts/run-eks-day18-isolated-recovery-smoke.sh`를 사용한다.
실행기는 private image receipt, exclusive steady namespace와 explicit confirmation을 요구하고,
Service·Secret·ServiceAccount 없이 임시 Deployment 하나만 만든다. 기존 General Node에
들어가지 않는 instance CPU selector와 request를 사용하며 NodePool CPU·memory limit은
실행 중에만 확장하고 trap과 정상 cleanup 모두 원래 값으로 복구한다. 신규 Node에 임시 Pod
외 비-DaemonSet workload가 있으면 NodeClaim을 삭제하지 않는다. 1초 감시는 ALB
Frontend/Backend, RDS와 HPA를 집계하며 HTTP/RDS는 1% 이하·연속 2회 이하, HPA는 `2..6`
범위를 요구한다. 완료는 Pod·Node 교체, CloudWatch 시작 marker 2건, General Node
scale-out/in과 release 0개를 모두 충족해야 한다. 실제 결과와 B 범위는
[Day 18 Pair A 격리 Pod·Node 복구 검증](eks-day18-isolated-recovery-evidence.md)을 따른다.

Phase 5 EC2 rollback audit은 private `deploy/ec2.env`에 기존 stack의 exact
`ASKLAKE_COMPOSE_PROJECT_NAME`을 지정한 뒤
`scripts/verify-eks-day18-ec2-rollback.sh`로 실행한다. instance status만 확인하지 않고
application URL의 EC2 귀속, SSH, remote branch와 tracked worktree, deploy preflight,
장기 Compose service, 공개 Frontend/Backend/AI health, Spark master/worker의 Continuous
script와 EKS `external_ec2` process 0을 함께 검증한다. 이 audit은 현재 rollback 원본을
중지·재생성하지 않으므로 `scripts/deploy.sh start`를 실제 호출한 failover 증거는 아니다.
실제 결과와 남은 legacy/probe 경계는
[Day 18 Phase 5 EC2 rollback 경로 검증](eks-day18-ec2-rollback-evidence.md)을 따른다.

Phase 6 운영 대응은 [EKS Day 18 운영 runbook](eks-day18-operations-runbook.md)을 따른다.
초기 `kubectl`·ALB·Continuous·CloudWatch 조회, 격리 Pod/Node 복구, immutable digest
preflight/rollout, 보존 EC2 fallback과 비용·cleanup을 한 순서로 사용하되 조회·조정·변경을
구분한다. 최초 진행에서는 Phase 6에서 runbook과 preflight를 고정하고 Pair B 변경이
합쳐진 뒤 Phase 7 confirmation으로 실제 새 digest rolling update를 실행했다. static 계약은
`bash scripts/verify-eks-day18-operations-runbook.sh`, 안전·위험 fixture는
`bash scripts/test-eks-day18-operations-runbook.sh`로 검사한다. Phase 7의 성공 candidate
→ 의도적 이전 revision rollback → 동일 candidate 재승격 순서는
`scripts/run-eks-day18-backend-rollout-round-trip.sh`가 소유하며,
`bash scripts/test-eks-day18-backend-rollout-round-trip.sh`가 preflight 무변경,
confirmation fail-closed, 정상 순서와 rollback/재승격 실패 시 추가 mutation 중단을
검증한다. runner 전에 [EKS Day 18 복원력 실행 계약](eks-day18-resilience-execution-contract.md)의
image/capability binding과 private preflight를 통과해야 한다. formal image receipt는
Git ignore 대상 `infra/eks/delivery/*.image-receipt.json`, 일반 evidence는 저장소 밖의 고유
경로와 mode `0600`을 사용한다. preflight/rollout은 private `deploy/ec2.env`에서 exact 보존
instance를 `ASKLAKE_EXPECTED_EC2_INSTANCE_ID`로 전달하며 파일 누락·권한 drift를 추측으로
복구하지 않는다. 낮은 수준 rollout runner의 postcheck 실패 자동 rollback은 성공 release의
의도적 rollback·재승격 증거가 아니며 round-trip runner의 별도 confirmation과 세 번의
steady gate가 Phase 7 공동 판정이다. CloudWatch는 add-on Ready뿐 아니라
같은 UTC window의 Event, 비식별 log marker count와 alarm 상태 시각을 대조한다. EC2 `start`
성공을 트래픽 cutover 성공으로 확대하지 않고, Phase 4 ALB/RDS/HPA 복구를 S3·Catalog·Iceberg
연속성으로 확대하지 않는다.

Phase 7 private round-trip evidence가 `candidate_repromotion_passed`인 뒤 Phase 8
fault/E2E는 `scripts/run-eks-day18-phase8.mjs`가 소유한다. 먼저 exact EKS cluster,
approved execution contract, live input, candidate receipt, round-trip evidence와
preserved EC2 env를 `/private/tmp` mode `0600` 경로로 전달하고 `--preflight`를 실행한다.
cluster 이름이나 EC2 env 경로는 AWS/kubecontext에서 추론하지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<user-provided-exact-cluster-name>'
export ASKLAKE_DAY18_EC2_ENV='<user-provided-absolute-private-env-path>'
export ASKLAKE_DAY18_EXECUTION_CONTRACT='/private/tmp/asklake-day18-execution-contract-<revision>-approved.json'
export ASKLAKE_DAY18_LIVE_INPUT='/private/tmp/asklake-day18-live-input-<revision>.json'
export ASKLAKE_DAY18_IMAGE_RECEIPT='/private/tmp/asklake-day18-candidate.image-receipt.json'
export ASKLAKE_DAY18_ROUND_TRIP_PRIVATE_EVIDENCE='/private/tmp/asklake-day18-round-trip-<revision>.json'
export ASKLAKE_DAY18_PHASE8_STATE='/private/tmp/asklake-day18-phase8-state-<revision>.json'

node scripts/run-eks-day18-phase8.mjs --preflight
```

preflight가 새 state를 만든 뒤 mutating mode에는 exact confirmation을 별도로
설정한다. 단계별 실행은 Run D deny/retry, Run E driver failure/attempt 2, fresh
Run A/B/C, cleanup 순서다.

```bash
export ASKLAKE_DAY18_PHASE8_CONFIRM='run-approved-day18-phase8-fault-and-e2e'

node scripts/run-eks-day18-phase8.mjs --run-d
node scripts/run-eks-day18-phase8.mjs --run-e
node scripts/run-eks-day18-phase8.mjs --run-abc
node scripts/run-eks-day18-phase8.mjs --cleanup
```

중단 후에는 같은 private state와 input hash를 사용해 실패한 mode를 다시 호출한다.
runner는 완료된 MSK probe, driver delete와 Airflow submit을 반복하지 않는다. binding이
달라지거나 live state가 모호하면 새 state로 덮어쓰지 말고 blocker를 해소해 다시
preflight한다. cleanup은 Run A/B/C 전에도 호출할 수 있지만 runner 소유 temporary
Job과 아래 조건을 만족하는 terminal Spark child Pod만 UID precondition으로 삭제하며
durable RDS/S3/Iceberg/Catalog/SparkApplication evidence는 남긴다. 완료 Spark child
Pod가 `WhenEmpty` Node scale-in을 막으면 current
campaign Run D/E와 검증된 A/B/C receipt의 run ID, terminal phase, driver/executor role,
SparkApplication controller owner name/UID와 terminal state를 모두 대조한 Pod만 UID
precondition으로 정리한다. in-cluster 명령은 Ready/Running/non-terminating FastAPI Pod를
선택하며, Run E CloudWatch marker는 Pod 이름이 아니라 durable run ID를 사용한다.

```bash
node --test scripts/test-eks-day18-phase8.mjs
python3 -m unittest scripts.test_eks_day18_phase8_incluster
python3 -m py_compile \
  scripts/run_eks_day18_phase8_incluster.py \
  scripts/test_eks_day18_phase8_incluster.py
```

위 검증은 sanitizer/Event 집계, private state binding, exact Describe-only deny,
driver owner UID, restart/no-redelete, ambiguous checkpoint 차단과 실패 후 cleanup을
검사하며 live 리소스를 만들지 않는다. 최초 live Phase 7·8은 2026-07-19에 통과했다.
세부 성공 기준과 실제 결과는
[EKS Day 18 복원력 실행 계약](eks-day18-resilience-execution-contract.md)과
[Phase 7·8 결과](eks-day18-phase7-8-result.md)를 따른다.

A 소유 NodePool만 먼저 검증할 때는 confirmation-gated `scripts/run-eks-day17-isolated-nodepool-smoke.sh`를 사용한다. 실행기는 General 1 CPU Pod, Spark 2 CPU Pod와 toleration 없는 Spark 음성 Pod만 만든다. baseline node 목록은 임시 파일에만 보관하며 두 positive Pod가 unscheduled 상태를 거쳐 baseline에 없던 올바른 pool node에서 Ready가 됐는지 확인한다. Spark 음성 판정은 NodePool·node exact taint, Pod toleration 부재와 untolerated event를 결합한다. `isolated` final은 이 신규-node 귀속, scale-out/in과 전체 cleanup이 모두 맞아야 통과한다. 이는 FastAPI HPA와 Spark 비즈니스 Job 통합 증거를 대신하지 않는다. 실제 결과는 [Day 17 Pair A 격리 NodePool 검증 기록](eks-day17-a-isolated-nodepool-evidence.md)을 따른다.

2026-07-15 `dev` 환경의 실제 foundation, Metrics Server, image delivery, node scale과 MSK Serverless 적용 결과 및 후속 경계는 [EKS MVP 14일차 실제 환경 검증 기록](eks-day14-runtime-evidence.md)에 요약한다. 해당 문서는 비밀이 아닌 판정만 기록하며 실제 endpoint·ARN·digest·evidence JSON은 저장소 밖에서 관리한다.

수요일 Pair B의 Frontend/FastAPI rollout, 내부 Service/RDS health, Pod 자동복구, 실제 두 Pod의 RDS lease/generation fence, EC2 Continuous 경계와 MSK IAM client 실행 결과는 [EKS MVP 수요일 Pair B 실환경 검증 기록](eks-day15-b-live-evidence.md)에 요약한다. exact temporary `CreateTopic` permission으로 1 partition test topic을 bootstrap하고 권한을 제거한 뒤, 원래 Describe-only Pod Identity로 private `9098` IAM metadata Job `Complete 1/1`을 확인했다. B 기록 당시 미완료였던 S3 positive/negative 경계는 후속 [Backend S3 최소 권한 검증 기록](eks-day15-backend-s3-runtime-evidence.md)에서 완료했다. PR #774 머지 후에는 최신 `pair1`을 A 브랜치에 merge하고 최종 Backend source commit, ECR immutable digest와 현재 Pod imageID 일치, ALB `--steady`, ExternalSecret Ready와 RDS health를 다시 확인한다.

최종 Backend rollout gate는 새 image를 만들지 않고 확인된 동일 digest로 Deployment를 restart한다. 아래 runner는 실행 전 Phase 6의 Git 제외 image receipt와 full Git SHA, Deployment/Pod imageID, ECR immutable digest를 대조한다. `ASKLAKE_EXPECTED_EC2_INSTANCE_ID`로 지정한 정확한 rollback EC2가 running이고 instance/system status가 모두 `ok`인지 확인하며, 다른 실행 중 instance의 존재로 대신 통과하지 않는다. 이는 EC2 instance 보존 증거이고 Continuous 서비스 자체 health 증거는 아니다. rollout 동안 외부 `/api/health`를 1초 간격으로 측정하고 30초마다 식별자 없는 진행 건수를 출력한다. 종료 후 같은 digest의 FastAPI Pod `2/2`와 Trino result collector Pod `1/1`, ALB steady target, Secret/RDS health, 각 FastAPI Pod의 `external_ec2` 값과 worker·maintenance Continuous process 0개를 다시 확인한다. 실제 receipt, commit과 instance ID는 저장소 밖에서 전달하고 전체 digest·repository·endpoint·instance ID는 출력하거나 Git에 기록하지 않는다.

15.5 물리 조회에서 발견한 Iceberg rows `ApiError` import와 enum reason drift는 Issue #798에서 새 `linux/amd64` immutable digest로 Backend-only atomic upgrade했고 live 오류 계약까지 검증했다. 이후 같은 경로를 변경하거나 재배포할 때도 source 수정만으로 runtime 완료를 선언하지 않는다. formal receipt revision/digest와 Deployment/Pod imageID를 대조한다. Trino 미배포 상태의 sanitized HTTP 502 계약에 이어, 현재 Trino coordinator에서는 CA 검증을 거친 snapshot rows HTTP 200과 Phase 5의 exact row/file 조회까지 통과했다. 세부 handoff와 rollback 기준은 [15.5 Backend image handoff](eks-day15-5-backend-image-handoff.md), 최종 데이터 경로는 [Phase 5 current-runtime E2E](eks-day16-phase5-current-runtime-e2e.md)를 따른다.

Issue #798의 변경 전 기준점은 [15.5 runtime 보완 실행 기록](eks-15-5-runtime-remediation-evidence.md)에 둔다. 새 image rollout 전에는 FastAPI 2/2·Pod digest, ALB/RDS, ExternalSecret source/target hash, `external_ec2` process 0, exact 보존 EC2 status와 직전 Helm revision/ECR digest를 다시 확인한다. Phase 0 확인은 읽기 전용이며 새 image 반영이나 live 재검증 성공으로 확대하지 않는다.

Issue #798 Phase 1은 수동 `EKS image delivery` workflow의 dev 보호 환경과 OIDC를 사용해 `f556e95e`를 포함하는 새 Backend AMD64 digest와 formal receipt를 인수했다. receipt가 함께 제공한 다른 component digest는 이번 Backend-only rollout 입력으로 승인하지 않는다. receipt는 Git 제외 경로에 두고 Phase 2에서 새 Backend digest만 private Helm values에 반영해 render와 server dry-run을 수행한다.

Phase 2 Backend-only 사전 검증은 아래 명령으로 수행한다. 이 script는 현재 Helm release values를 읽되 rollback 뒤 저장 values와 live manifest의 image가 어긋날 수 있으므로 Frontend/Backend image field를 현재 Deployment 값으로 먼저 정규화한다. 그 뒤 임시 candidate의 `backend.image`만 바꾸고, receipt/fix ancestry·ECR immutability·단일 OCI manifest의 실제 image config가 `linux/amd64`인지·Frontend image 보존을 확인한 뒤 `helm upgrade --install --dry-run=server`만 실행한다. Collector가 이미 있으면 FastAPI와 같은 digest이고 steady인지 확인하며, 이슈 재현 상태처럼 없으면 absent baseline을 보존한다. 두 경우 모두 candidate render에는 새 digest를 공유하는 Collector가 반드시 있어야 한다. server dry-run 전후 Helm revision, 기존 Deployment generation/image와 Pod UID가 같지 않으면 실패한다. Backend runtime Secret은 선택한 bounded 또는 full-service profile과 정확히 일치해야 하며 Secrets Manager source와 target 전체 hash가 같아야 한다. operator가 ExternalSecret CRD를 읽을 수 있으면 live mapping과 Ready까지 확인하고, 읽을 수 없으면 target의 controller ownerReference와 source-target 전체 payload 일치가 모두 맞아야만 통과한다. 다른 rollout 때문에 ALB target이 draining이면 기다림 없이 실패하므로 steady 복구 후 다시 실행한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_IMAGE_RECEIPT='<private Git-ignored *.image-receipt.json>'
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID='<preserved instance id>'
bash scripts/preflight-eks-backend-image-rollout.sh
```

이 명령은 실제 Backend image를 배포하지 않는다. 성공 결과는 Backend-only atomic rollout의 입력이 준비됐다는 뜻이며 runtime 수정 완료 증거가 아니다.

새 Backend digest의 실제 atomic rollout은 `scripts/rollout-eks-backend-image.sh`를 사용한다. 같은 `backend.image`를 소비하는 FastAPI와 `trino-result-collector`를 한 Helm revision에서 함께 교체하고 각각 `2/2`, `1/1`과 동일 immutable digest를 확인한다. Collector가 없던 baseline에서 실패하면 rollback은 새 Collector를 제거해 원래 release ownership까지 복원한다. 실행기는 EKS Auto Mode namespace의 `eks.amazonaws.com/pod-readiness-gate-inject=enabled`, FastAPI의 단일 `ip` TargetGroupBinding과 새 Pod의 `target-health.*` readiness condition을 요구한다. operator가 TargetGroupBinding CRD를 읽을 수 있으면 live CR을 직접 확인하고, 읽을 수 없으면 두 FastAPI Pod에 주입된 managed `target-health.*` readiness gate/True condition과 AWS ALB exact target 검증을 함께 요구한다. namespace key는 실제 managed `eks-load-balancing-webhook` selector와 일치해야 하며 self-managed controller용 `elbv2.k8s.aws/...` key로 대체하지 않는다. condition suffix는 controller 구현에 종속되므로 exact prefix 하나를 가정하지 않고 주입된 target-health gate와 같은 condition이 `True`인지 확인한다. 이는 Kubernetes Ready와 ALB Healthy 사이의 간격에서 기존 Pod가 먼저 종료되는 것을 막는다. dev target group의 deregistration delay가 300초이므로 FastAPI chart는 terminating Pod를 `preStop` 310초 동안 유지하고 360초 종료 유예 안에서 정리한다. ALB delay를 바꾸면 이 두 값과 zero-non-200 rollout smoke를 함께 다시 검증한다. 외부 health 표본 하나라도 실패하거나 두 workload의 Pod digest·Frontend·Secret·ALB/RDS·Continuous·보존 EC2 gate가 어긋나면 직전 Helm revision으로 되돌리고 ALB steady 복구까지 확인한다.

외부 health monitor는 HTTP 응답 code를 그대로 판정한다. client transport `000`만 0.2초 뒤 한 번 재확인해 검증 머신의 순간 연결 오류와 실제 ALB 응답을 구분하며, 재확인도 실패하거나 HTTP가 200이 아니면 rollout을 실패 처리한다. HTTP 502 같은 서버/ALB 응답은 재시도로 숨기지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_IMAGE_RECEIPT='<private Git-ignored *.image-receipt.json>'
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID='<preserved instance id>'
export ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM='deploy-new-immutable-backend'
bash scripts/rollout-eks-backend-image.sh
```

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_IMAGE_RECEIPT='<private *.image-receipt.json>'
export ASKLAKE_EXPECTED_BACKEND_COMMIT='<reviewed full 40-character commit>'
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID='<preserved instance id>'
export ASKLAKE_BACKEND_ROLLOUT_CONFIRM='restart-same-immutable-backend'
bash scripts/run-eks-day15-backend-rollout-smoke.sh
```

Issue #794의 페이즈 5 최종 인수는 인프라의 “Phase 5 배포 Handoff”와 다른 작업 단계다. 새 rollout이나 infrastructure apply 없이 formal receipt의 Backend digest, Pod `2/2`, ALB exact steady, Backend Secret/RDS, S3 positive/negative와 cleanup, `external_ec2`/Continuous process 0, 정확한 EC2 instance 보존을 한 번에 재검증한다. S3 sentinel과 임시 Pod·ConfigMap을 생성하므로 read-only 검증이 아니다. 두 mutation confirmation을 모두 명시해야 하며 runner는 현재 실행의 정확한 object version/DeleteMarker를 제거한 뒤 승인된 smoke prefix 전체와 Kubernetes label/name prefix의 과거 잔여물도 검사한다. 전체 audit만 별도로 실행할 때는 `run-eks-backend-s3-smoke.sh --audit-only`를 사용하며 이 mode는 object를 만들거나 삭제하지 않는다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_IMAGE_RECEIPT='<private *.image-receipt.json>'
export ASKLAKE_EXPECTED_BACKEND_COMMIT='<reviewed full 40-character commit>'
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID='<preserved instance id>'
export ASKLAKE_BACKEND_S3_SMOKE_CONFIRM='run-backend-s3-boundary-smoke'
export ASKLAKE_FINAL_INTEGRATION_CONFIRM='run-final-integration-with-s3-sentinels'
bash scripts/verify-eks-day15-final-integration.sh
```

정적 실패 경로는 `bash scripts/test-eks-day15-validation-hardening.sh`로 검사한다. 이 test는 실제 AWS나 Kubernetes를 변경하지 않고 관계없는/stopped/impaired EC2, receipt 누락·short SHA·digest/platform 불일치, 중복 ALB target group·추가 weighted target·wrong port, S3 Version/DeleteMarker 잔여와 ExternalSecret manual rollback의 삭제·apply·hash·rollout 실패를 fake command로 재현한다.

실제 dev 최종 결과, Terraform 무변경과 cleanup 증거는 [Issue #794 최종 통합 인수 기록](eks-day15-final-integration-evidence.md)에 남긴다. 이 gate의 성공은 Backend web runtime 범위이며 Airflow·Spark·Trino bounded E2E 또는 production cutover 승인이 아니다.

```bash
docker run --rm --entrypoint sh \
  -v "$PWD/infra/eks:/workspace" \
  -w /workspace/terraform \
  hashicorp/terraform:1.15.8 \
  -c 'export TF_DATA_DIR=/tmp/tfdata; terraform fmt -check -recursive && terraform init -backend=false -input=false >/dev/null && terraform validate && terraform test'
```

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

RAG Data Plane 배포는 private `opensearch`, `embedding-worker`, `rag-artifact-cleanup` service를 함께 올린다. `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `OPENSEARCH_PASSWORD`, `RAG_WORKER_TOKEN`은 server `deploy/.env`에만 저장하고 host port로 노출하지 않는다. Airflow는 read-only로 mount한 backend RAG script와 Spark REST endpoint를 사용하며, worker는 `AI_GATEWAY_SERVICE_TOKEN`으로 private Gateway에만 접근한다. 모델과 index의 vector dimension은 `RAG_EMBEDDING_DIMENSIONS`에서 동일해야 하고, staging artifact는 `RAG_STAGING_BASE_PATH` 아래 Job별 경로로 격리한다.

Production에서 Trino를 켜기 전에는 TLS/auth/JDBC role, read-only query identity, materializer CTAS/`DESCRIBE`/drop, Warehouse와 Query Result bucket round trip을 아래 readiness로 확인한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-production-readiness
```

Production 배포 템플릿은 `TRINO_ENABLED=true`, `CONTINUOUS_SQL_JOIN_ENABLED=true`, `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false`, `CLICKHOUSE_REALTIME_V2_ENABLED=true`, `KAFKA_CONNECT_SINK_ENABLED=true`, `COMPOSE_PROFILES=trino,clickhouse-realtime-v2`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER=kafka_connect_v2`, `KAFKA_CONNECT_URL=http://kafka-connect-v2:8083`, `DASHBOARD_SYNC_MODE=sse`, `REALTIME_EVENTS_ENABLED=true`를 기본값으로 사용한다. V2 ClickHouse 계정 비밀번호, TLS 파일, connector properties와 immutable Kafka Connect image digest는 server `deploy/.env` 또는 secret storage에만 둔다. ClickHouse와 Kafka Connect port는 host에 publish하지 않는다. `scripts/verify-deploy-env.sh`가 flag/profile/credential/TLS/image/backend-service wiring 불일치를 배포 전에 차단한다.

롤백은 실행 중인 ClickHouse Job을 먼저 pause 또는 stop한 뒤 `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false`로 바꾸고 `COMPOSE_PROFILES`에서 `clickhouse`를 제거해 재배포한다. 이미 같은 consumer group을 소유한 Run을 Spark로 자동 전환하지 않는다. 기존 Iceberg mode Job과 일반 ETL·Catalog·Dashboard 경로는 이 flag와 무관하게 계속 동작한다.

Production은 알려진 legacy demo 계정을 기본적으로 생성하거나 복구하지 않는다. Backend startup은 기존 `auth_users.status`와 session을 보존하므로 재배포 자체가 활성 admin을 비활성화하지 않는다. 공개 demo 배포에서만 `AUTH_LEGACY_DEMO_USERS_ENABLED=true`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true`를 함께 설정해 누락 계정 생성, disabled demo 계정 복구와 frontend 로그인 안내를 함께 활성화한다. `scripts/verify-deploy-env.sh`는 두 값이 lowercase `true|false`가 아니거나 서로 다르면 preflight를 실패시킨다. 일반 운영에서는 두 플래그를 `false`로 유지하고 계정 차단·해제는 명시적인 admin/DB 작업으로 수행한다. bootstrap admin, Secure cookie, public signup 기본 차단, client actor header fallback 차단은 opt-in과 무관하게 유지한다.

dev EKS가 아직 HTTP ALB만 사용하는 동안에는 `asklake-runtime-config` release의 private runtime values에 `AUTH_SESSION_COOKIE_SECURE: "false"`가 필요하다. FastAPI가 참조하는 `asklake-runtime` ConfigMap에 이 값이 렌더되면 로그인 후 새로고침에서도 세션 쿠키를 전송한다. 운영 기본값과 HTTPS 환경은 `true`를 유지하고, 인증서 적용 후 dev 값도 즉시 `true`로 되돌린다. `APP_ENV`를 개발 모드로 낮추는 우회는 header-auth fallback을 열 수 있으므로 사용하지 않는다.

실제 서버에서는 Compose 실행 전에 durable host root와 env를 준비하고 preflight를 통과시킨다. `ASKLAKE_HOST_DATA_DIR` root와 별도 read-only replay 입력인 `ASKLAKE_REPLAY_HOST_INPUT_DIR`는 먼저 존재해야 한다. `spark-runtime-guard`가 root 아래 `spark-ivy`, `spark-output`, `spark-runs`, `samples`, `review-text-models`를 생성하고 UID/GID `185:185`로 정규화하므로 수동 subdirectory `chown`은 필요 없다.

```bash
mkdir -p /var/lib/asklake /var/lib/asklake/replay-input
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

Production backend에는 `/var/run/docker.sock`과 Docker CLI를 넣지 않는다. Batch/Parquet inspect는 내부 전용 `spark-master:6066` REST endpoint에 제출하고 terminal 상태와 timeout을 확인한다. REST/UI/master port는 host에 publish하지 않는다.

로컬에서 전체 stack을 띄울 때는 예시 env와 local E2E override를 함께 사용한다. Override는 frontend build의 API base를 빈 문자열로 만들어 Nginx `/api` proxy를 사용하고, HTTP 전용 backend에만 `AUTH_SESSION_COOKIE_SECURE=false`를 적용한다. Nginx는 realtime event SSE buffering을 끄되 운영 쿠키의 `Secure` 속성은 제거하지 않는다. Override가 요구하는 `AWS_ACCESS_KEY_ID`와 `AWS_SECRET_ACCESS_KEY`에는 local object storage 전용 값을 shell 또는 별도의 gitignored env 파일로 제공해야 한다.

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml -f deploy/docker-compose.local-e2e.yml up -d --build
curl http://localhost:5173/api/health
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml -f deploy/docker-compose.local-e2e.yml down
```

`VITE_API_BASE_URL`을 설정할 때는 `/api`를 붙이지 않은 origin까지만 넣는다. 로컬 override는 같은 출처 기본값을 사용하고, EC2 HTTPS production preflight는 `https://asklake.example.com`처럼 `APP_DOMAIN`과 일치하는 값을 요구한다.
대시보드 Assistant를 prod build에서 켜려면 `VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant`를 `deploy/.env`에 유지한다.
EC2 HTTPS 배포에서는 `deploy/.env`의 `APP_DOMAIN`에 scheme 없는 domain을 넣고, Caddy가 인증서를 받을 수 있도록 `HTTP_PORT=80`, `HTTPS_PORT=443`을 사용한다.
배포 PR 전에는 최신 `origin/dev`를 fetch한 뒤 compose config와 관련 문서 예시를 다시 확인한다.

### EC2 배포 운영

AWS EC2 demo 서버는 `scripts/deploy.sh`로 켜고, 재배포하고, 끈다.
실제 EC2 id, host, SSH key path는 `deploy/ec2.env`처럼 git에 올리지 않는 개인 환경 파일에서 관리한다.

배포 성공은 Compose 기동만으로 판단하지 않는다. public health, Spark REST, Continuous session heartbeat를 분리해 확인하는 현재 기준선과 후속 자동화 범위는 [배포 파이프라인 Phase 0 기준선](./deployment-phase-0-baseline.md)을 따른다. 이 기준선은 관찰 문서이며 배포 스크립트의 현재 동작을 바꾸지 않는다.

```bash
cp deploy/ec2.env.example deploy/ec2.env
source deploy/ec2.env

scripts/deploy.sh status
scripts/deploy.sh start
scripts/deploy.sh deploy
scripts/deploy.sh health
scripts/deploy.sh diagnose
scripts/deploy.sh stop
```

`scripts/deploy.sh diagnose`는 remote state를 바꾸지 않고 local JSON diagnostic을 남긴다. 실패한 health/readiness 단계가 있어도 가능한 관찰을 모두 기록한 뒤 non-zero로 종료하며, 기본 파일은 `${TMPDIR:-/tmp}/asklake-deploy-diagnostic.json`, 변경 경로는 `ASKLAKE_DEPLOY_DIAGNOSTIC_PATH`다. 세부 운영 절차는 `docs/deployment-runbook.md`를 기준으로 한다.
서버 `deploy/.env`와 로컬 `deploy/ec2.env`에는 실제 secret이나 AWS resource 값이 들어갈 수 있으므로 커밋하지 않는다.

`scripts/deploy.sh health`는 public URL의 HTTP-to-HTTPS redirect를 따라 최종 frontend/backend/AI health를 확인한다. backend는 `.ok=true`, `.database.ok=true`, `statusCode=200` JSON을 요구한다. 실패 진단은 frontend reachability/redirect, backend request, backend JSON readiness, AI readiness로 나뉜다. 회귀 검증은 root에서 `bash tests/deploy/deploy-scripts-regression.sh`로 실행한다.

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
- session이 없으면 `/jobs`, `/admin` 직접 접근이 `AuthPage`로 이동한다.
- admin 계정 로그인 후 `/jobs`와 `/admin`의 `AdminConsolePage`가 표시되고 sidebar에는 독립 `AI 활용` 메뉴가 없다.
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

static Dataset JOIN key는 Catalog `uniqueKeySets` 또는 `uniqueKeyColumns`로 명시한다. 기존 `indexColumns`가 실제 unique index임을 보장하는 경우에만 `indexColumnsUnique=true`를 함께 저장한다. SQL 분석 UI에서 key 증적만 없는 경우에는 `POST /api/catalog/datasets/{datasetId}/unique-keys/verify-and-register`가 exact Trino count를 수행하고 성공한 key만 등록하므로 사용자가 SQL이나 metadata를 수동 편집하지 않는다. `CONTINUOUS_SQL_JOIN_ENABLED=false`가 기본이며 실제 Spark/Iceberg end-to-end, fault/restart와 soak는 STACK-04 gate다.

SQL 분석에서 ClickHouse Continuous Job 생성 UI를 변경할 때는 아래 검증을 추가로 실행한다. 이 테스트는 Kafka delta relation 감지, stream 1개 + static N개 조합, 안전한 ClickHouse table identifier와 editor action 계약을 확인한다. 실제 create/start와 Catalog/Dashboard 반영은 backend Continuous SQL 계약 및 operator E2E로 검증한다.

```powershell
cd frontend
npm run test:continuous-sql-ui
npm run verify:ui-regressions
npm run build
```

Continuous SQL latency tuning은 새 request의 5초 기본 trigger와 `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS` 두 경로를 사용한다. cache 한도는 executor memory/disk와 Catalog 통계 신뢰도를 확인하며 조정하고, memory pressure가 있거나 통계가 불안정하면 0으로 cache를 끈다. 새 output table은 `_asklake_run_id`를 partition column으로 생성하지만 기존 table은 자동 변경하지 않는다. 성능 변경 검증은 아래 계약 suite와 Compose render를 포함하고, 실제 지연 수치는 Kafka/MinIO/Spark/Iceberg/Trino 통합 환경에서 별도로 측정한다.

ClickHouse mode의 정적 snapshot 적재 기본 한도는 relation당 15,000,000행이고 insert batch는 20,000행이다. Trino HTTP page는 최대 20MB, ClickHouse query는 60초로 제한한다. 실제 운영 데이터가 한도를 넘으면 값을 무조건 올리지 말고 dimension 크기·참조 열·ClickHouse 메모리와 disk를 먼저 확인한다. 동일 snapshot의 참조 열 table은 resume에서 재사용되며 source count와 local count가 다르면 truncate 후 다시 적재한다.

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
npm run test:route-data-loading
npm run test:jobs-data-boundary
npm run test:snapshot-status-polling
npm run test:deployed-ui-boundary
npm run verify:ui-regressions
npm run build
```

Job command의 optimistic rollback은 `MutationRevisionGate` ownership 검사를 우회하면 안 된다. 기존 `/jobs` route와 `JobsLandingPage`, `JobDetailPage`, `JobRunsPage` export 또는 compatibility façade 파일을 제거하려면 별도 deprecation PR이 필요하다.

`test:jobs-data-boundary`는 `runHistory`가 비어 있어도 현재 `status=failed`인 Kafka Continuous Job을 실패 경고와 `status=failed` 필터가 포함하도록 보호한다. 실패 현황 UI를 최근 Run 결과인 `latestRunOutcomeCounts` 또는 `lastRunOutcome` 기준으로 되돌리지 않는다.

`route-data-loading`은 `/jobs*`가 Catalog 목록을 요청하지 않고, `/catalog*`·`/sql`이 Job 목록을 요청하지 않으며, Dashboard 목록이 workspace Catalog hydrate를 시작하지 않는지 검사한다. `?view=semantic`은 별도 domain hydrate를 만들지 않고 Catalog route의 목록을 재사용한다. `refreshData` 호환 함수도 Job과 Catalog를 동시에 요청하지 않고 현재 route domain만 갱신해야 한다. route를 벗어나면 해당 `LatestRequestGate`를 무효화하고 Job/Catalog 오류 상태를 서로 공유하지 않는다.

## 18) Frontend CSS·Catalog 경계 변경 검증

ETL/Layout 스타일은 `styles/etl/`, `styles/layout/`의 소유 feature 파일에서 변경한다. entrypoint import 순서 변경, 기존 중복 selector 정리, specificity 변경은 시각 회귀 근거가 있는 별도 PR로 다룬다. 인접 중복을 합칠 때도 selector, at-rule parent와 declaration 순서를 유지하고 source hash·정확한 selector inventory·해당 rule declaration 계약을 함께 갱신한다. 비인접 중복은 computed-style와 페이지별 visual baseline 없이 제거하지 않는다. Catalog 조회·선택 state는 `useCatalogExplorerState.ts`, 순수 검색·정렬은 `catalogModel.ts`, 표현은 각 page module이 소유한다.

```bash
cd frontend
npm run test:css-catalog-boundary
npm run test:semantic-layer-ui
npm run verify:ui-regressions
npm run build
```

Catalog module을 더 분리하면 `verify-ui-regressions.mjs`의 `catalogPageFiles`에도 경로를 추가한다. `CatalogPage.tsx` façade, `CatalogWorkspacePage.tsx` view switch, 기존 route/DOM class/접근성 속성, CSS entrypoint hash를 바꾸려면 별도 호환 또는 deprecation 단계가 필요하다. Catalog와 Semantic wrapper의 full-width·font token은 `css-catalog-boundary`로 고정한다. 렌더 검증은 mock/legacy를 production처럼 켜지 않고 live workspace 또는 실제 Vite CSS를 읽는 최소 fixture에서 desktop/mobile computed style, console, screenshot과 target interaction을 비교한다.

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

## 19) EKS MVP workload 검증

EKS workload chart는 foundation chart와 분리된 `infra/eks/helm/asklake-workloads`에 있다. 실제 account, ECR repository, digest, bucket, endpoint는 git에 저장하지 않고 배포 시 values로 주입한다. credential은 values에 넣지 않고 `asklake-backend-runtime`, `asklake-airflow-runtime`, `asklake-spark-runtime`, `asklake-trino-runtime` Secret key/file을 정확히 참조한다. dev에는 네 이름의 source/ExternalSecret/target이 존재하며 Spark 3-key와 Trino 7-key는 staged/decoded hash 검증을 통과했다. 다만 live Backend main ExternalSecret의 Trino key/CA mapping은 아직 적용 전이라 Issue #828 검증은 임시 별도 target을 사용한다. Airflow extra key 정합성과 정식 Backend 단일 target 수렴은 후속 통합 gate다. Namespace, ServiceAccount와 FastAPI/Spark driver Role·RoleBinding은 foundation chart가 단독 소유하며 workload chart는 재생성하지 않는다.

Trino distributed mode는 기본 비활성이다. 활성화할 때는 private values에
`includeCoordinator=false`, 1~5 범위의 `workerReplicas`, worker General node selector, 완전한 CPU/memory
request/limit와 termination grace를 모두 명시한다. 5는 비용·오입력 방지용 MVP 안전 상한이며 기본
worker 수나 성능 보장이 아니다. 첫 live 후보는 Git 제외 private values에서 worker `2`개로
시작하지만 checked-in values와 example에 실제 worker sizing을 추가하지 않는다.
정적 검증은 기본 single render, 완전한 opt-in render, 0·6을 포함한 누락/범위 밖 입력 거부,
coordinator-only Service, 동일 image/Secret/ServiceAccount, Airflow-only 격리와 HPA/PDB/PVC/RBAC/Secret
부재를 확인한다.

분산 discovery는 client용 virtual ClusterIP가 아니라 coordinator만 선택하는 headless
`asklake-trino-discovery`를 사용한다. Trino 482 automatic internal TLS가 DNS 결과의 실제 Pod IP를
IP-encoded hostname으로 변환해야 하므로 headless endpoint는 coordinator Pod IP 하나와 정확히
일치해야 한다. coordinator는 `Recreate`로 교체하며 동시 coordinator 2개를 허용하지 않는다.

```bash
scripts/verify-eks-trino-distributed.sh
scripts/verify-eks-workloads.sh
node scripts/test-eks-trino-distributed-evidence.mjs
```

승인된 격리 live campaign은 `docs/eks-trino-distributed-phase0.md` 순서를 사용한다. 일반 개발/CI에서
Helm apply, worker Pod 삭제 또는 rollback을 실행하지 않는다. receipt는 raw endpoint, ARN, bucket,
node/query/Pod UID를 저장하지 않고 SHA-256 identity와 boolean/count만 남기며
`verify-eks-trino-distributed-evidence.mjs`를 통과해야 한다. worker 삭제는 exact Pod UID precondition을
사용하고 in-flight query는 성공/실패를 사실대로 기록한다. graceful shutdown 또는 fault-tolerant
execution 증거로 해석하지 않는다. 실제 receipt 검증은 배포된 `pair1` full commit을 반드시 묶는다.

```bash
ASKLAKE_TRINO_DEPLOYMENT_COMMIT=<merged-pair1-full-sha> \
  node scripts/verify-eks-trino-distributed-evidence.mjs \
  /path/to/redacted-trino-distributed-receipt.json
```

실제 component release는 Git 제외 mode `0600` private values를 사용해 먼저 server-side dry-run한다.
승인된 적용은 배포 worktree의 `HEAD`와 fetched `origin/pair1`을 동일한 full SHA로 고정하고
`ASKLAKE_TRINO_DEPLOYMENT_COMMIT`에 그 값을 전달해 `deploy-eks-trino-distributed.sh --apply`로
수행하며 현재 immutable Trino image를 보존한다. distributed apply 전에는 같은 chart의 단일 coordinator `Recreate` 상태와 인증된 Iceberg
query를 먼저 검증하고 그 Helm revision을 안전 rollback 기준으로 고정한다. apply 뒤
`verify-eks-trino-distributed-live.sh <worker-count>`가 Deployment Ready뿐 아니라
FastAPI의 materializer identity로 `system.runtime.nodes`를 조회해 coordinator 1개와 active worker
수를 확인하고 기존 non-empty Iceberg table을 실제로 한 행 읽는다. 실패하면 deploy script가 안전 단일 coordinator Helm revision으로 되돌린다. 이
active-node gate는 배포 안전 확인일 뿐 promotion 완료 증거가 아니다. non-empty Iceberg worker task,
exact-UID 장애 복구, `2→1→2` scale-down/복원과 안전 rollback까지 같은 campaign에서 검증해야 한다.

Spark Operator가 `spark.jars.packages`를 submission Pod에서 해결하므로 `spark.jars.ivy=/tmp/.ivy2`를 유지해 비루트 controller의 쓸 수 없는 home 경로를 피한다. Spark driver namespace Role은 executor Pod·Service·ConfigMap lifecycle과 shutdown label cleanup에 필요한 `deletecollection`을 제공하고, PVC는 cleanup-only get/list/delete/deletecollection만 허용한다. Secret, Node와 cluster-wide resource 조회는 허용하지 않는다.

`spark_job_run.py`는 배포 경로 호환 façade이고 Kafka bounded offset·MSK IAM·fixture row-count 구현은 `backend/scripts/runtime/spark_job_runtime.py`에 있다. `scripts/verify-eks-workloads.sh`는 façade의 존재와 실제 runtime 구현을 각각 검사해야 하며, 구현 문자열을 façade에 복제해 검증을 통과시키지 않는다. EKS lease와 Kubernetes identity helper를 변경하면 realtime architecture budget과 `tests.test_eks_execution_contract`, `tests.test_eks_runtime_boundary`, `tests.test_runtime_io_ports`, `npm run test:spark-kubernetes`를 함께 실행한다.

동시 bounded fixture 검증은 A가 승인한 MSK group을 먼저 `asklake-runtime-config` release의 `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`에 exact group/table 쌍으로 추가한다. 기본 `asklake-eks-mvp-spark-v1 → eks_mvp_fixture` slot은 항상 포함하고 scale slot은 최대 4개만 더한다. group과 table 중복, wildcard/prefix, 기본 slot 제거, 5개 초과는 Backend와 Spark runtime이 모두 거부한다. 실제 private values를 만들기 전 A의 IAM group 범위 승인이 없으면 기본 slot을 여러 Job에 복제하지 말고 blocker로 남긴다.

Terraform의 Spark MSK group 권한은 `msk_scale_consumer_groups`에 `49d163cfbaf1`부터 필요한 exact 값만 선택한다. 변수 validation은 `scale17-01..04` 외 값과 wildcard를 거부하고, IAM policy는 기본 group ARN과 선택한 group ARN만 `DescribeGroup`/`AlterGroup` resource로 렌더한다. 3개 실험에는 `01..03`만 사용하며 4번째는 3개로 Pending 증거를 만들 수 없을 때 별도 검토 후 추가한다.

각 scale Job의 `sourceConfig`에는 서로 다른 등록 group을 넣고 table은 요청으로 받지 않는다. FastAPI가 slot mapping에서 target을 정하며 active Run 예약은 PostgreSQL group별 advisory lock으로 직렬화된다. 따라서 동일 slot 두 번째 실행은 Airflow/Spark 호출 전 `409 EKS_MVP_FIXTURE_SLOT_ACTIVE`, 서로 다른 3~4개 slot은 각기 고유 group/table과 Run별 output/checkpoint로 진행된다. 빠른 정적 검증은 다음과 같다.

```bash
cd backend
npm run test:kafka-fixture-boundary
npm run test:spark-kubernetes
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_etl_job_delete.EtlJobDeleteRunConcurrencyTests.test_three_approved_fixture_slots_reserve_unique_groups_and_tables
```

15.5 bounded 물리 조회는 호환상 `scripts/run-eks-catalog-physical-read-smoke.sh` 이름을 유지한다. Git 제외 Phase 6 image receipt와 `datasetId`, `materializationRoot`, `objectUri`만 가진 Git 제외 `*.physical-read-input.json`을 명시한다. 이 실행기는 URI root 경계만 확인하며 Catalog API를 다시 조회하지 않으므로 `datasetId`는 운영자 인수 문맥이고 결과는 Catalog provenance 증거가 아니라 `bounded-s3-parquet-object` 증거다. `--validate-only`는 AWS/Kubernetes mutation 없이 receipt·입력·AMD64 image와 임시 SparkApplication manifest를 검사한다. `--live`는 별도 confirmation과 검증된 EKS context, Established CRD, Ready controller/webhook, `asklake-spark` ServiceAccount, Ready AMD64 Spark NodePool/NodeClass, 단일 Pod Identity association과 server-side dry-run을 모두 통과해야 한다. 그 뒤 최대 100행을 제한 조회하고 실제 row나 URI 대신 column/row count와 폭 일치만 출력한다. 성공·실패·timeout·signal 모두 현재 run label과 exact name prefix의 SparkApplication·Pod·Service·ConfigMap·PVC를 정리한다. cleanup/audit API 오류는 잔여 0으로 간주하지 않고 실패하며 Spark Secret read 거부도 확인한다. timeout은 1~3600초, poll은 0.1~30초로 제한한다.

7/16 Pair A data-plane 작업 전에는 `scripts/capture-eks-day16-a-baseline.sh --expect-phase0`로 현재 Web/Airflow, Secret delivery, ServiceAccount/Pod Identity, Spark Operator, MSK endpoint, ECR/RDS/ALB, Continuous와 외부 EC2 rollback 기준점을 읽기 전용으로 고정한다. capture는 source/target Secret value를 출력하지 않고 canonical hash와 공유 token 동일성만 비교한다. 당시 발견한 Airflow password와 Backend Trino mapping drift는 canonical ExternalSecret/target으로 수렴했다. 이 기준점 문서는 역사적 입력이며 현재 판단은 Phase 4~7 증거와 재사용 verifier를 따른다.

Phase 1의 실제 Spark·Trino 입력은 `scripts/prepare-eks-day16-runtime-secret-input.sh`로 생성한다. 이 helper는 available dev RDS와 `asklake/dev/rds/application-databases`의 기존 `iceberg_catalog` credential을 값 출력 없이 대조하고, Trino TLS/JKS·bcrypt password database·Backend client 인증 patch를 `infra/eks/secrets/*.runtime-secret-input.json`에 `0600`으로 기록한다. 해당 파일은 Git 제외 대상이며 Terraform/Helm values가 아니다. 유효한 입력이 이미 있으면 자동 회전하지 않고 재검증만 한다. `node scripts/verify-eks-day16-runtime-secret-input.mjs <private-input>`은 exact key, 공유 JDBC binding, password 분리, JKS/CA fingerprint와 SAN을 확인한다. Phase 1은 AWS source나 ExternalSecret을 변경하지 않는다. [Phase 1 입력 준비 기록](eks-day16-a-runtime-secret-input.md)을 따른다.

Phase 2는 `ASKLAKE_DAY16_SECRET_APPLY_CONFIRM=apply-spark-trino-runtime-secrets bash scripts/deploy-eks-day16-runtime-secrets.sh`로 적용한다. 실행기는 기존 Backend/Airflow를 보존하고, Spark·Trino AWS source와 staged ExternalSecret의 일반 문자열/binary decode hash가 맞을 때만 최종 target을 만든다. `scripts/verify-eks-day16-runtime-secret-delivery.sh`는 private input/source/target, exact mapping, owner/Ready, 여섯 ServiceAccount의 Secret read deny와 Web/Airflow steady 상태를 값 출력 없이 검사한다. 결과와 Backend patch 보류 이유는 [Phase 2 전달 기록](eks-day16-a-runtime-secret-delivery.md)을 따른다.

Phase 3의 Trino overlay는 `scripts/prepare-eks-day16-trino-values.sh`로 한 번 생성하고 `scripts/verify-eks-day16-trino-values.sh`로 검증한다. 실제 reference가 든 `infra/eks/values/workloads/*.private-values.json`은 `0600`, Git 제외 상태를 유지한다. Trino resource만 server-side dry-run하며 기존 Airflow/Web release ownership은 변경하지 않는다. 실제 data-plane smoke는 exact EKS context와 `ASKLAKE_TRINO_DATA_PLANE_SMOKE_CONFIRM=run-trino-data-plane-smoke`를 설정해 `scripts/run-eks-day16-trino-data-plane-smoke.sh`로 수행한다. 이 Job은 Trino Pod Identity, RDS isolated login, Warehouse/Query Result positive/negative S3 경계와 namespace DNS를 확인하고 모든 versioned object와 Kubernetes 임시 resource를 정리한다. [Phase 3 검증 기록](eks-day16-a-trino-data-plane.md)을 따른다.

Phase 4 fixture producer는 `prepare-eks-day16-fixture-producer-identity.sh`로 Terraform의 exact policy를 전용 외부 role/policy에 반영한다. idempotent producer에는 exact cluster의 `Connect`, `WriteDataIdempotently`와 exact fixture topic의 `DescribeTopic`, `WriteData`만 허용한다. 로컬에서 private MSK에 접근할 수 없으면 confirmation 아래 `run-eks-day16-fixture-producer-ec2.sh`를 사용한다. 실행기는 ingress 없는 임시 security group, 잠금 파일 기반 `npm ci`, IMDSv2 instance-profile credential을 사용하고 정확히 100건과 broker ack를 private `0600` receipt로 검증한다. 종료 시 EC2, host role/profile, security group과 MSK 임시 ingress 잔여물이 없어야 한다. 장기 access key를 만들거나 receipt를 Git에 추가하지 않는다.

Phase 5 private handoff는 `scripts/prepare-eks-day16-a-handoff.sh`로 생성하고 exact EKS context에서 `scripts/verify-eks-day16-a-handoff.sh --audit`로 검사한다. 실제 reference는 `*.handoff.json`, `*.runtime-secret-contract.json`, `*.private-values.json`, `*.fixture-receipt.json` Git 제외 파일에만 둔다. 모든 Day 16 실행기는 `ASKLAKE_IMAGE_RECEIPT`로 현재 private formal receipt를 명시해야 하며 파일이 Git 제외·미추적·`0600`인지 확인하고 과거 revision의 암묵적 기본값을 사용하지 않는다. audit은 현재 blocker를 보고하고 `--ready`는 전체 server dry-run, decision-aware full-service Secret과 live `asklake-runtime` ConfigMap의 승인된 Helm owner/exact image까지 준비돼야 통과한다. owner가 미정인 ConfigMap을 임의 adopt하지 않는다. 모든 blocker가 0인 뒤 confirmation을 준 `scripts/promote-eks-day16-a-handoff.sh`만 private handoff를 `ready-for-deploy`로 올린다. [Phase 5 검증 기록](eks-day16-a-handoff.md)과 [Phase 6 promotion gate 기록](eks-day16-phase6-promotion-gate.md)을 따른다.

현재 `asklake-runtime` owner는 전용 `asklake-runtime-config` release로 확정됐다. `scripts/prepare-eks-runtime-config-values.sh`가 live ConfigMap을 Git 제외 `0600` values로 내보내고, `scripts/deploy-eks-runtime-config-release.sh`가 live/render canonical hash 일치와 Helm server dry-run을 통과한 경우에만 ownership을 인수한다. 이후 `scripts/verify-eks-runtime-config-release.sh`는 단독 release annotation, exact data hash와 workload 무변경을 확인한다. 실제 dev 전환은 data 변경 없이 완료됐다.

EKS의 목표 AI runtime은 `gateway`다. 기존 direct 13-key 전환기는 rollback 호환 경로이며 새 배포의 정상 경로가 아니다. Gateway 전환은 provider-key-free Backend exact 15-key, 별도 Gateway exact 3-key, service/MCP token 동일성, `AI_QUERY_PROVIDER=gateway`, private Service URL과 immutable Gateway image를 모두 만족해야 한다. `deploy-eks-web-workloads.sh --apply`는 이 계약을 fail-closed로 확인하며 live apply 뒤 `/api/health/ai`, Dashboard Assistant, Query AI를 별도 smoke한다. Secret 값은 command output, evidence 또는 Git에 남기지 않는다.

OpenAI Platform key에는 자동 TTL을 설정할 수 없어 dev 키 이름에 운영 폐기일을 표시하고 별도 만료 작업으로 폐기한다. 현재 MVP 키의 폐기일은 2026-07-31이다. 폐기 때는 OpenAI key를 revoke하고 Secrets Manager에서 `OPENAI_API_KEY`를 제거한 뒤 bounded manifest로 rollback하여 FastAPI와 ALB steady를 다시 검증한다.

Phase 5 증거 재검증은 `scripts/verify-eks-day16-bounded-e2e-evidence.sh --verify-only`를 사용한다. 이 실행기는 새 fixture나 SparkApplication을 만들지 않고 private run/fixture receipt와 현재 image receipt를 기준으로 RDS Run, SparkApplication UID/image, Iceberg snapshot/materialization, Trino exact rows/files를 같은 실행으로 대조한 뒤 임시 Job을 제거한다. terminal 성공 Run의 멱등 retry가 꼭 필요할 때만 `--verify-retry`와 별도 확인값을 사용한다. 추적 문서에는 raw identifier를 옮기지 않으며 `scripts/verify-tracked-evidence-redaction.sh`가 identifier·endpoint·credential 형태를 category/file 단위로 차단한다.

기존 완료 SparkApplication이 보이지 않으면 먼저 backend 기본 `timeToLiveSeconds`를 확인한다. 현재 기본값은 3600초이므로 정상 자동 삭제일 수 있다. 새 증거가 필요할 때는 private fixture receipt와 명시적 confirmation으로 `scripts/run-eks-day16-phase6-bounded-e2e.sh`를 한 번 실행한다. 이 runner는 Job 조회 경계를 호출해 Airflow terminal 상태를 RDS에 reconcile한 뒤 성공 receipt만 저장한다. 이어 `scripts/retain-eks-phase6-spark-evidence.sh`가 completed identity와 current image를 검증하고 TTL을 604800초로 연장한다. 마지막으로 `--verify-only`와 확인값을 둔 `--verify-retry`를 실행해 exact 100행, 단일 materialization과 임시 residue 0을 확인한다.

Phase 7 최종 감사는 Backend Spark/Kafka/Iceberg/Airflow 계약, EKS foundation/workload/runtime Secret 실패경로, Terraform Docker test와 Frontend UI/build를 재실행한다. live cleanup에서는 temporary Job/Pod/EC2/IAM host/security group과 promotion candidate가 0인지 확인하되 완료 SparkApplication과 RDS/Iceberg/Catalog durable evidence, 기존 EC2 Continuous rollback 원본은 삭제하지 않는다. tracked 증거에는 actual digest, Run·UID·snapshot·fixture·EC2·SSM command와 public endpoint를 남기지 않는다. [Phase 7 회귀·cleanup 기록](eks-day16-phase7-regression-cleanup.md)을 따른다.

A/B merge 이후에는 [16일차 A/B 통합 계약 감사](eks-day16-integration-contract-audit.md)를 기준으로 static verifier와 live Helm owner를 먼저 대조한다. 현재 component별 Web·Airflow·Trino release는 충돌 없이 Ready지만 A private runtime의 Airflow password binding, canonical Backend Trino Secret/CA, fixture checkpoint prefix와 full-service decision은 별도 drift다. 기존 성공 Run이나 Helm resource를 삭제해 맞추지 않고 source/target hash, server dry-run과 rollback을 갖춘 후속 Phase에서 보완한다.

private input이 없으면 `scripts/prepare-eks-physical-read-input.sh`로 현재 Catalog의 queryable Iceberg Dataset과 root 아래 non-empty Parquet object를 읽기 전용으로 대조해 생성한다. 이 helper도 Dataset ID와 URI를 출력하지 않으며 결과 파일은 `infra/eks/delivery/*.physical-read-input.json`에만 둔다. `kubectl auth can-i`는 deny일 때 `no`와 exit code 1을 반환하므로 runner는 둘을 함께 정상 거부 증거로 요구하고, exit 0 `yes`나 그 밖의 오류 code를 실패 처리한다.

```bash
export ASKLAKE_IMAGE_RECEIPT='<private *.image-receipt.json>'
export ASKLAKE_PHYSICAL_READ_INPUT='<private *.physical-read-input.json>'
bash scripts/run-eks-catalog-physical-read-smoke.sh --validate-only
bash scripts/test-eks-catalog-physical-read-smoke.sh

# private input과 context gate를 검토한 실제 실행에서만 추가한다.
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output>'
export ASKLAKE_PHYSICAL_READ_CONFIRM='run-bounded-physical-read'
bash scripts/run-eks-catalog-physical-read-smoke.sh --live
```

```bash
# Helm 3이 PATH에 있는 경우
scripts/verify-eks-workloads.sh

# workspace 밖에 둔 Helm binary를 사용할 경우
ASKLAKE_HELM_BIN=/path/to/helm scripts/verify-eks-workloads.sh

cd backend
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run test:spark-kubernetes
.venv/bin/python -m unittest \
  tests.test_object_storage_mode \
  tests.test_eks_runtime_boundary \
  tests.test_dashboard_live_results \
  tests.test_etl_job_delete -v
npm run verify:airflow-catalog-wiring
```

FastAPI replica의 scheduler 경쟁을 실제 PostgreSQL row lock으로 검증할 때는 PostgreSQL을 `settings.database_url`에서 접근 가능하게 준비한 뒤 아래 opt-in 테스트를 추가로 실행한다. 테스트는 고유 Job/Run row를 만들고 종료 시 삭제한다.

```bash
cd backend
ASKLAKE_TEST_POSTGRES_CONCURRENCY=1 \
  .venv/bin/python -m unittest \
  tests.test_etl_job_delete.EtlSchedulerPostgresConcurrencyTests -v
```

검증 스크립트는 Helm schema/lint/render, Frontend/FastAPI/Airflow/Trino resource 개수, ClusterIP, health check, digest image, ConfigMap/Secret 경계, foundation-owned RBAC 비생성, Continuous 경계, MSK IAM과 bounded Spark smoke 설정을 확인한다. Role/RoleBinding, Secret, `LoadBalancer`, `StatefulSet`, PVC/EFS, replay producer, static AWS key 또는 mutable image가 workload chart에 들어오면 실패한다. FastAPI의 DB-aware `/api/health`는 startup/readiness에만 사용하고 liveness는 TCP로 분리한다. Frontend/FastAPI는 AMD64 전용 image와 맞게 `kubernetes.io/arch=amd64`에만 스케줄한다. `.github/workflows/eks-b-workload-checks.yml`은 같은 계약 테스트와 Frontend/Backend/Spark/Airflow `linux/amd64` Docker build를 PR에서 실행한다. 수동 image delivery도 Airflow 공식 base mirror가 아니라 `airflow/Dockerfile`을 build하고 네 custom build에 `--provenance=false`를 적용한다. Trino만 upstream mirror/digest를 사용한다.

기존 `asklake-web` release를 유지한 채 Airflow만 배포할 때는 같은 chart를 별도 `asklake-airflow` release로 사용하고 Frontend, Backend, Trino를 명시적으로 끈다. verifier는 이 render가 Airflow Deployment 3개, ClusterIP Service 1개, ConfigMap 1개와 migration hook Job 1개만 포함하고 `frontend`, `fastapi`, Trino resource를 포함하지 않는지 검사한다. 이 경로에서도 실제 Secret 값은 values에 넣지 않는다.

dev의 Backend/Airflow runtime mapping은 값이 없는 다음 manifest로 재현한다. 적용자는 namespaced custom resource 권한이 있어야 하며 target Secret의 key 이름과 shared binding 동일성만 확인하고 base64 value를 출력하지 않는다.

```bash
kubectl apply -f infra/eks/secrets/runtime-externalsecrets.dev.yaml
kubectl wait --for=condition=Ready \
  externalsecret/asklake-backend-runtime \
  externalsecret/asklake-airflow-runtime \
  externalsecret/asklake-spark-runtime \
  externalsecret/asklake-trino-runtime \
  --namespace asklake-dev \
  --timeout=60s
```

```bash
helm upgrade --install asklake-airflow \
  infra/eks/helm/asklake-workloads \
  --namespace asklake-dev \
  --values /secure/path/dev.airflow-values.yaml \
  --set frontend.enabled=false \
  --set backend.enabled=false \
  --set trino.enabled=false
```

chart 적용 전 EKS foundation은 `asklake-dev` namespace, `asklake-frontend`, `asklake-backend`, `asklake-airflow`, `asklake-msk-smoke`, `asklake-spark`, `asklake-trino` ServiceAccount/EKS Pod Identity, FastAPI/Spark driver RBAC, Spark operator, RDS/MSK/S3/ECR과 필요한 runtime Secret을 제공해야 한다. 7월 16일 기준 namespace, ServiceAccount/token, Backend/MSK smoke/Spark/Trino Pod Identity, RBAC, Spark Operator와 data plane이 적용됐고 네 workload 이름의 runtime Secret source/ExternalSecret/target도 `Ready=True`다. Backend main target은 실제 bounded runtime에 필요한 12개 key로 수렴했고 FastAPI는 이 canonical Secret 하나만 참조한다. Trino password database는 Secrets Manager의 plaintext bcrypt file property로, JKS만 Base64 decode 대상으로 전달한다. 임시 Backend Trino target은 canonical rollout, ALB/RDS health와 Trino data-plane smoke 뒤 삭제했다. `asklake-backend`와 `asklake-spark`는 각각 SparkApplication과 executor Pod를 관리하므로 `automountServiceAccountToken: true`다. 나머지 ServiceAccount의 Kubernetes API token은 끈다. 정상 install은 opt-in smoke 두 개를 만들지 않는다.

Web, Airflow, Trino는 각각 `asklake-web`, `asklake-airflow`, `asklake-trino` Helm release가 소유한다. 통합 검증은 전체 chart를 임의의 네 번째 release 이름으로 raw apply하지 않고 각 live release의 현재 values를 `helm upgrade --install --dry-run=server`에 넣는다. Trino private values 검증에서는 Frontend, Backend, Airflow를 명시적으로 끈 `asklake-trino` render만 사용한다. immutable selector 또는 ownership 충돌을 발견해도 Deployment 삭제나 Helm annotation 강제 인수로 해결하지 않는다.

Frontend/FastAPI Service 계약은 `frontend:80`, `fastapi:8080`이다. A의 `asklake-web` application release 하나로 실제 배포했으며 B workload chart를 병행 설치하지 않는다. 이후 변경에서도 두 Helm release가 같은 Deployment/Service를 동시에 소유하게 하지 않는다.

Airflow MVP는 `LocalExecutor`, image-baked DAG와 RDS metadata를 사용한다. RDS CA ConfigMap을 read-only mount하고 DB URL은 `verify-full`이어야 한다. migration hook은 FAB AuthManager를 명시한 뒤 API user create와 password reset을 실행한다. EFS/PVC, shared DAG volume과 shared log volume은 없으며 Pod-local log 비영속 제한을 수용한다. Helm rollback/uninstall은 이미 적용된 RDS migration을 역변환하지 않는다. 실제 dev 배포와 smoke는 [목요일 Pair B Airflow 실환경 검증 기록](eks-day16-b-airflow-live-evidence.md), Secret consumer 범위는 [7월 15일 A foundation / B workload 계약 대조](eks-day15-b-workload-contract-review.md)를 따른다.

병합 전에는 아래 항목을 모두 확인한다.

- 최신 `pair1`과 3-way merge했을 때 conflict가 없어야 한다.
- workload chart render에는 Role/RoleBinding이 없어야 하고, foundation chart가 FastAPI/Spark driver RBAC의 유일한 소유자여야 한다.
- foundation의 `asklake-backend`와 `asklake-spark` ServiceAccount는 모두 `automountServiceAccountToken: true`여야 한다.
- Frontend, Backend, Spark runtime, Airflow의 실제 ECR `repository@sha256:digest`와 `linux/amd64` 증거가 receipt 또는 배포 기록에 있어야 한다. PR의 build-only `push: false` CI는 ECR push 증거로 보지 않는다.
- PR과 API 문서의 Continuous 차단 오류 코드는 `CONTINUOUS_CONTROL_OWNED_BY_EC2`로 일치해야 한다.
- A의 `asklake-web` release가 이미 설치돼 있으면 Frontend/Backend가 활성화된 일반 Helm install을 진행하지 않는다. Airflow-only component release는 비활성 component가 0개 resource로 렌더되는 verifier를 통과한 경우에만 사용한다. 동일 `frontend`/`fastapi` Service의 ownership 전환은 별도 rollback 절차가 합의되기 전까지 금지한다.

AWS 입력이 준비되면 먼저 `mskSmoke.create=true`로 metadata smoke를 실행하고 성공 후 producer receipt의 batch ID/count로 bounded Kafka fixture를 실행한다. 정적 smoke는 `sparkApplication.create=true`와 고유 `runId`/`jobId`를 사용하고, 제품 경로는 exact fixture sourceConfig로 AskLake Job을 실행해 같은 `runId`가 Airflow와 동적 SparkApplication까지 전달되는지 확인한다. 두 경로 모두 실행 시점의 `earliest`~`latest`를 읽되 해당 `raw.fixture_batch_id`만 남겨 전용 `iceberg.asklake.eks_mvp_fixture` table을 replace commit하므로 이전 smoke batch나 Continuous 소유권과 섞이지 않는다. Spark report의 input/output count, commit source boundary와 snapshot ID가 producer expected count와 같아야 한다. 그 다음 Trino에서 `SELECT count(*) FROM iceberg.asklake.eks_mvp_fixture`와 snapshot/file evidence를 조회한다. 이 live 결과는 B 코드만으로 독립 생성할 수 없고 A의 endpoint, fixture topic, Pod Identity, bucket, Secret, ECR digest가 실제로 연결되어야 한다.

금요일 scale 실행에서는 위 단일 smoke와 별도로 승인된 3개 slot부터 시작하고, 현재 Spark 여유 용량을 넘지 못한 경우에만 네 번째 slot을 사용한다. 실행 전 `group → table → fixture batch → expected count` 표를 private receipt 입력에 고정하고, 모든 Run이 terminal인 뒤 group, Run별 output/checkpoint, table, snapshot, Catalog dataset이 pairwise unique인지 교차 검사한다. `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON` 변경은 live ConfigMap을 raw patch하지 않고 전용 runtime-config release의 private values, server dry-run, rollback 절차로 전달한다.

일반 FastAPI batch 실행은 `ASKLAKE_SPARK_RUNNER=kubernetes`에서 deterministic `SparkApplication`을 제출한다. driver와 executor에는 모두 Spark 전용 workload selector, AMD64 selector와 `NoSchedule` toleration을 넣고, package resolution cache는 `spark.jars.ivy=/tmp/.ivy2`로 고정한다. provider unit test는 두 replica가 같은 run identity를 사용하고, create 응답 유실 뒤 한 번의 POST만으로 복구하며, 다른 identity object를 거절하는지 검증한다. driver Pod가 생성되기 전 submission failure에서는 Pod log `404`가 SparkApplication status 원인을 덮지 않아야 한다. 실제 cluster smoke에서는 실행 중 같은 `runId` 요청이 RDS lease로 차단되고 terminal 재요청이 같은 UID object를 복구하며 label 기준 object 수가 하나인지 확인한다.

Spark runtime은 `backend/spark-msk-iam-shaded/pom.xml`에서 MSK IAM `2.3.6`과 그 AWS SDK v2 `2.38.3`/Netty를 `com.asklake.spark.msk.shadow.*`로 relocation한 image-local JAR를 만든다. Hadoop S3A `3.4.1`의 AWS SDK bundle `2.24.6`은 변경하지 않는다. `ASKLAKE_SPARK_MSK_IAM_AUTH_JAR`는 `local:///opt/asklake/jars/*.jar`만 허용하고 Kubernetes Kafka source에만 주입한다. S3-only source에 MSK JAR가 들어가거나 SparkApplication에 `software.amazon.msk:aws-msk-iam-auth` Maven coordinate가 렌더되면 회귀다. Apache Hadoop도 `NoSuchMethodError` 방지를 위해 Hadoop이 빌드된 SDK와 다른 버전 또는 bundle과 개별 SDK module의 혼합을 금지한다: <https://hadoop.apache.org/docs/r3.4.1/hadoop-aws/tools/hadoop-aws/troubleshooting_s3a.html>.

Kubernetes create/recover 응답의 namespace/name/UID는 terminal을 기다리지 않고 Pod-local progress file을 통해 RDS `sparkExecution.kubernetesExecution`에 저장한다. 이 파일은 bridge 전달용이며 종료 때 지워지고, FastAPI 재시작 뒤 복구 기준은 RDS다. 재시도 generation은 기존 UID를 보존해야 한다. terminal result의 run/job/application/image/driver identity가 RDS와 다르거나 성공 result marker가 없으면 API는 `SPARK_EXECUTION_IDENTITY_MISMATCH`로 fail-closed한다. driver Pod phase, termination reason/exit code와 marker 여부도 terminal manifest에 저장하므로 `runId → SparkApplication UID → driver Pod/log/result`를 한 row에서 추적할 수 있다. Node provider와 RDS generation/retry 계약은 `npm run test:spark-kubernetes`와 `tests.test_etl_job_delete.EtlJobDeleteRunConcurrencyTests`로 검증한다. 2026-07-16 dev 결과는 [FastAPI-Spark 연결 실환경 검증 기록](eks-day16-b-spark-link-live-evidence.md)을 따른다.

CP4 retry 회귀에서는 저장된 UID가 있는 경로가 Kubernetes `GET`만 수행하고 `POST`하지 않는지, object 부재/UID drift가 replacement 없이 실패하는지, 성공한 같은 `runId`가 generation을 올리지 않는지 확인한다. fixture target은 `replace`여도 동일 Kafka boundary가 있으면 Iceberg writer를 호출하지 않고 기존 snapshot을 재사용해야 한다. 최소 검증 명령은 다음과 같다.

```bash
cd backend
npm run test:spark-kubernetes
.venv/bin/python -m unittest \
  tests.test_etl_job_delete.EtlJobDeleteRunConcurrencyTests \
  tests.test_spark_source_identity \
  tests.test_kafka_fixture_boundary \
  tests.test_eks_runtime_boundary
npm run verify:airflow-catalog-wiring
```

## 20) pair1과 dev 정기 동기화

다음 EKS 로드맵 날짜를 시작하기 전에는 작업 브랜치에서 `origin/pair1`과 `origin/dev`의 기준선과 예상 충돌을 먼저 계산한다. `pair1`에 직접 병합하거나 한쪽 파일을 통째로 선택하지 않는다. 기본 감사 명령은 `bash scripts/audit-pair1-dev-sync.sh`이며, Issue #857의 최초 기준점과 파일별 해결 원칙은 [pair1-dev 동기화 기준점](pair1-dev-sync-857-baseline.md)에 기록한다.

실제 병합 직전에 `git fetch origin --prune`을 다시 수행한다. 기록된 SHA가 바뀌면 기준점을 갱신하고, 전용 브랜치에서 `origin/dev`를 병합한 뒤 Backend·Frontend·EKS 정적 검증과 SSOT 대조를 통과시켜 `pair1` 대상 PR로 전달한다. 아직 `dev`에 머지되지 않은 열린 PR은 암묵적으로 선반영하지 않는다.
## 21) API·DB 하위 호환과 Legacy 경로 검증

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

production compatibility path를 제거 후보로 바꾸려면 `docs/refactor-2026/legacy-removal-evidence.json`에 최소 30일의 시작·종료일, `observedCalls=0`, log query/dashboard export/release record 참조와 별도 reviewer 승인을 기록한다. validator `status=pass`만으로 제거할 수 없으며 `eligiblePaths`에 해당 ID가 있어야 한다. 현재 10개 경로는 모두 `not_started`/`not_requested`이므로 삭제하거나 비활성화하지 않는다.

```bash
python3 -m unittest scripts.refactor_audit.test_legacy_removal_evidence
python3 scripts/refactor_audit/legacy_removal_evidence.py

cd backend
npm run verify:legacy-removal-evidence
```

DB breaking change는 같은 PR에서 바로 수행하지 않는다. expand schema와 rollback reader, idempotent backfill, 호출 0 관측 기간, contract 제거를 각각 검증 가능한 단계로 나눈다. Job, session, runtime artifact, checkpoint를 테스트 편의를 위해 초기화하지 않는다.
## 22) 관측성·품질 게이트 개발 절차 (2026-07-16)

로컬 구조 ratchet은 아래 명령으로 실행한다.

```bash
cd backend
npm run verify:quality-gates
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:backward-compatibility
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:legacy-paths
PYTHONPATH=. .venv/bin/python -m unittest tests.test_observability_contract tests.test_runtime_io_ports tests.test_backward_compatibility_contracts
```

API/schema 변경은 `docs/03-api-reference.md` 또는 아키텍처 문서를, CI/deploy 변경은 이 문서 또는 `docs/system-guardrails.md`를 같은 PR에서 갱신해야 한다. baseline을 다시 생성해 실패를 덮지 말고 개선된 값은 별도 PR에서 낮춘다. `dev`, `main`, `pair1` 대상 PR은 같은 구조 ratchet을 실행한다. 느린 production Spark·Continuous 검증은 `Refactor Quality Gates` workflow dispatch의 `release_suite=true`로 실행한다.

브랜치 통합으로 기존 구조 부채가 dev baseline에 새로 유입되는 경우에도 baseline 재생성으로 통과시키지 않는다. 즉시 분할하기에 실행 위험이 큰 항목은 `quality-gate-baseline.json`의 예외에 정확한 path/function, 현재 줄 수 상한, owner, reason, expiresAt을 기록한다. 상한 증가와 만료는 다시 실패하며 wildcard나 파일군 단위 면제는 허용하지 않는다. 2026-07-18 pair1·dev 통합의 입력과 판정은 [통합 기록](pair1-dev-integration-2026-07-18.md)을 따른다.

## 23) ETL E2E·복구 프로필 실행

### ETL Job 조회·hydrate 경계 검증

Job 목록·경량 상태·상세의 read-only hydrate, backend Airflow sync, permission projection 또는 facet/filter를 변경할 때는 application 경계 unit과 기존 hydrate/API 계약을 함께 실행한다. GET handler에 runtime 호출이나 write를 다시 넣지 않고 `etl_service.py` façade에 조회 정책을 다시 구현하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_queries -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_snapshot_status_reconciliation -v
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

### Source connector Python·Node gateway 경계 검증

Source 연결 테스트나 asset listing의 request/response, Node transport 또는 connector adapter를 변경할 때는 typed gateway unit과 기존 bridge·auth·schema·object-storage 회귀를 함께 실행한다. Python application/service에서 Node script 이름이나 stdout marker를 직접 조립하지 않는다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_source_connector_gateway -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_runtime_io_ports tests.test_etl_endpoint_auth tests.test_source_connector_raw_preview_schema tests.test_object_storage_mode -v
node --check src/connectors.mjs
node --check scripts/test-source-connector.mjs
node --check scripts/list-source-assets.mjs
```

### EKS·EC2 Continuous control-plane owner 검증

Production workload 역할이나 FastAPI background loop entrypoint를 변경하는 PR은 단일-owner manifest unit과 현재 topology 검증을 함께 실행한다. EKS/EC2 역할 이동은 manifest만 수정하지 말고 양쪽 workload spec, 실제 replica/process 증거와 rollback 승인을 포함해야 한다.

```bash
python3 -m unittest scripts.refactor_audit.test_control_plane_ownership
python3 scripts/refactor_audit/control_plane_ownership.py

cd backend
npm run verify:control-plane-ownership
```

이 검증은 배포를 실행하지 않으며 `backend/app/main.py`의 lifespan이나 Compose environment를 변경하지 않는다. 현재 owner 선언과 repository entrypoint marker가 어긋나거나 required control plane을 둘 이상의 workload가 claim하면 merge 전에 실패한다.

### 10단계 stacked PR 순차 머지 검증

현재 refactor PR은 모두 base `dev`인 누적 branch다. `stacked-pr-merge-plan.json`의 order대로 한 번에 하나만 merge하고, 매 merge 뒤 `dev`를 fetch한 다음 다음 PR의 changed files·conflict·required checks를 다시 확인한다. validator 통과는 GitHub live check나 review 승인을 대신하지 않는다.

```bash
python3 -m unittest scripts.refactor_audit.test_stacked_pr_merge_plan
python3 scripts/refactor_audit/stacked_pr_merge_plan.py

cd backend
npm run verify:stacked-pr-merge-plan
npm run verify:refactor-release-plan
npm run verify:refactor-release-execution  # manual evidence 전 exit 2가 정상
```

merge 중에는 배포·재시작·traffic 전환을 수행하지 않는다. 실패하거나 예상 밖 누적 diff가 보이면 다음 PR을 열지 않고 해당 단계에서 중단한다.

Continuous, publication, Catalog, Dashboard, Spark runtime path를 변경하면 아래 빠른 프로필을 실행한다.

```bash
cd backend
npm run verify:etl-e2e-recovery
```

배포 후보는 `verify:etl-e2e-recovery:release`를 추가한다. 실제 Kafka/브라우저/서비스 fault가 포함된 `nightly`는 `ASKLAKE_E2E_ISOLATED_ENV=true`와 loopback URL이 설정된 `self-hosted + asklake-e2e` runner에서만 실행한다. production URL·credential로 우회 실행하지 않는다. 결과물은 `.artifacts/etl-e2e-recovery/`의 JSON/JUnit/Markdown 세 파일이며, 실패 시 correlation ID와 해당 check의 bounded output을 PR에 첨부한다.

시나리오를 추가할 때는 [하네스 계약](refactor-2026/contracts/etl-e2e-recovery-harness.md)에 따라 initial state, injection, expected state, timeout, automatic/operator recovery, evidence를 모두 정의한다. fixed sleep이나 화면 문구/CSS selector로 완료를 판정하지 않는다.

## 24) EKS Trino Result Collector 배포·복구

EKS SQL Query Run은 FastAPI submit만으로 끝나지 않는다. `asklake-web` release의 `trino-result-collector` Deployment가 RDS에 저장된 `nextUri`를 lease로 선점해 Trino result page를 S3에 저장하고 terminal 상태를 확정한다. 이 worker는 FastAPI와 같은 Backend image, `asklake-runtime`, `asklake-backend-runtime`, `asklake-backend` Pod Identity를 사용하지만 HTTP endpoint와 Kubernetes API token은 사용하지 않는다.

정적 검증과 실제 배포는 기존 web release owner를 유지한다.

```bash
bash scripts/verify-eks-web-workloads.sh
bash scripts/deploy-eks-web-workloads.sh --render /private/web-values.yaml /private/image-receipt.json

export ASKLAKE_EKS_CLUSTER_NAME=<reviewed-cluster>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_WEB_APPLY_CONFIRM=deploy-reviewed-web-workloads
bash scripts/deploy-eks-web-workloads.sh --apply /private/web-values.yaml /private/image-receipt.json

kubectl get deployment,pod -n asklake-dev -l app.kubernetes.io/component=trino-result-collector
kubectl logs -n asklake-dev deployment/trino-result-collector --tail=50
```

배포 전부터 `queued`/`running`인 Run을 정리할 때 DB row나 S3 object를 수동 삭제하지 않는다. 계속 필요하지 않은 Run은 인증된 `POST /api/query/runs/{runId}/cancel`로 generation을 먼저 fence하고 Trino cancel/result cleanup을 수행한다. 이후 bounded `SELECT count(*)`를 새 Query Run으로 제출해 `succeeded`, 기대값 100, actor concurrent slot 반환을 함께 확인한다.

Pod self-healing은 아래처럼 확인한다. 새 Pod가 생겼다는 사실과 새 Query Run이 terminal로 끝났다는 사실을 둘 다 기록해야 하며, Pod 재생성만으로 continuation 복구가 증명됐다고 쓰지 않는다.

```bash
kubectl delete pod -n asklake-dev -l app.kubernetes.io/component=trino-result-collector
kubectl rollout status deployment/trino-result-collector -n asklake-dev --timeout=5m
kubectl logs -n asklake-dev deployment/trino-result-collector --tail=50
```

Collector 중단은 Run을 성공으로 바꾸지 않는다. Pod가 죽으면 lease 만료 뒤 새 worker가 같은 `runId`를 이어받고, stale generation의 page metadata 공개는 거부된다. rollback으로 Collector를 제거한 상태가 길어지면 actor별 `queued`/`running` slot이 다시 찰 수 있으므로 FastAPI나 Trino 재시작으로 숨기지 말고 Collector 복구 또는 cancel API를 사용한다.

## 25) ClickHouse Realtime Serving V2 순차 구현

V2 구현은 [9-PR 실행 매핑](codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md)의 순서를 따른다. 기존 Realtime 2026 STACK-01~04와 refactor 10-PR plan을 대체하거나 다시 실행하지 않는다.

작업 규칙:

1. PR01은 최신 `origin/dev`, PR02~09는 직전 V2 branch에서 시작한다.
2. 모든 PR base는 `dev`다. 선행 PR merge 전 후속 PR은 Ready 상태여도 merge하지 않는다.
3. 선행 PR merge 뒤 다음 branch에 최신 `origin/dev`를 merge하고 실제 GitHub diff와 required check를 다시 확인한다.
4. 이미 공개한 누적 branch는 rebase/force-push하지 않는다. 예외적으로 force가 필요하면 작업을 중단하고 사용자 승인을 받는다.
5. 한 PR은 한 issue outcome만 소유하고 body 끝에 자기 issue의 `Closes #...`만 둔다.
6. 기존 dirty workspace의 변경을 새 issue branch로 가져오지 않는다. 별도 clean worktree에서 구현한다.
7. production deploy, traffic promotion, consumer offset reset, 기존 table/drop은 별도 운영 승인 없이는 실행하지 않는다.

V2 공통 빠른 검증은 기존 suite를 먼저 보존한다.

```bash
cd backend
npm run verify:realtime-stack
npm run verify:continuous-sql-contract

cd ../frontend
npm run build
```

Docker/ClickHouse/Kafka가 필요한 `npm run verify:clickhouse-kafka-join`은 PR02 이후의 integration/operator profile에서 실행한다. 공통 빠른 검증으로 분류하지 않는다. PR별 신규 검증 command는 해당 PR에서 `package.json`, 이 문서, `docs/system-guardrails.md`와 CI workflow를 함께 갱신한다. 실행하지 못한 live/production 항목은 PASS로 쓰지 않고 operator gate로 남긴다.

### ClickHouse V2 기반시설과 migration

V2 Compose service는 모두 `clickhouse-realtime-v2` profile에 있다. Production 기본 profile/flag/owner는 Kafka Connect V2로 맞춰져 있고 local root Compose만 profile을 명시한다. ClickHouse serving mode Job 시작이 토픽별 connector를 자동 등록하며 reconcile이 receipt/checkpoint, JOIN, Catalog revision과 SSE publication을 계속 전진시킨다.

먼저 외부 runtime이 필요 없는 설정과 migration 계약을 검증한다. 가상환경 Python에 `backend/requirements.txt`의 Alembic/SQLAlchemy dependency가 설치돼 있어야 한다.

```bash
cd backend
npm run verify:clickhouse-realtime-v2-foundation
.venv/bin/python -m alembic -c alembic.ini heads
npm run verify:realtime-stack

cd ..
docker compose config --quiet
docker compose --profile clickhouse-realtime-v2 config --quiet
docker compose --env-file deploy/.env.example \
  -f deploy/docker-compose.prod.yml \
  --profile clickhouse-realtime-v2 config --quiet
tests/deploy/deploy-scripts-regression.sh
```

`0016_clickhouse_realtime_v2_foundation`은 `0015_ai_generation_evidence_audit` 다음 단일 head이며 V2 metadata table 10개만 추가한다. production은 `STARTUP_SCHEMA_MANAGEMENT_ENABLED=false`를 유지하고 web/worker rollout 전에 명시적으로 upgrade한다.

```bash
cd backend
.venv/bin/python -m alembic -c alembic.ini upgrade head
.venv/bin/python -m alembic -c alembic.ini current
```

Production image는 `alembic.ini`와 migration directory를 포함한다. 이미 기동한 PostgreSQL에 one-shot으로 적용할 때는 `deploy/`의 실제 server `.env`를 사용한다.

V2 profile을 포함한 production env는 먼저 preflight를 통과해야 한다. Profile-only shadow도 six-account secret, TLS, cert/secret file mode, immutable image digest와 Compose network를 검사한다. Sink/application owner를 enabled로 전환하면 private Connect origin, stable connector name과 단일-owner 조합도 추가로 fail closed한다. 기존 V1 backend ClickHouse credential은 V2 identity로 repurpose하지 않는다.

```bash
cd ..
scripts/verify-deploy-env.sh deploy/.env deploy/docker-compose.prod.yml
```

```bash
cd deploy
docker compose --env-file .env -f docker-compose.prod.yml run --rm --no-deps \
  backend python -m alembic -c alembic.ini upgrade head
```

Local profile smoke를 실행하려면 admin/ingest/materializer/reader/migration/observer의 서로 다른 16자 이상 password를 shell environment에 설정하고, repository 밖의 connector properties file을 read-only mount해야 한다. root `.env`나 tracked example에 실제 secret을 쓰지 않는다. Kafka Connect image는 공식 plugin release checksum을 검증하며 network download가 필요하다.

```bash
docker build -t asklake/kafka-connect-clickhouse:1.4.0 deploy/kafka-connect
docker compose --profile clickhouse-realtime-v2 up -d \
  clickhouse-keeper-v2 clickhouse-v2 kafka-connect-v2
curl --fail http://127.0.0.1:18083/connector-plugins
curl --fail http://127.0.0.1:18123/ping
```

이 smoke는 process와 plugin만 확인한다. 실제 ingest/JOIN은 ClickHouse serving mode Job 또는 V2 container E2E에서 확인한다. production downgrade, offset reset, named volume 삭제는 rollback 절차가 아니며 disabled-mode rollback은 세 V2 owner/flag를 끄고 expand schema를 보존한다. exact image, TLS/local 차이와 미완료 operator evidence는 [V2 기반시설 운영 계약](clickhouse-realtime-v2-foundation.md)에 기록한다.

### PR09 archive/recovery와 최종 release gate

누적 branch의 deterministic backend 계약과 migration lifecycle은 한 번에 실행한다.

```bash
cd backend
npm run verify:clickhouse-realtime-v2-release
npm run verify:clickhouse-realtime-v2-recovery
```

`verify:clickhouse-realtime-v2-release`는 PR02~09의 feature flag, Alembic, ingest, dimension, materializer, Catalog publication, Dashboard/SSE와 archive recovery module을 한 suite로 실행한다. `0018_realtime_archive_recovery`가 새 head이며 disposable DB에서 `0015 → head → 0015 → head`가 가능해야 한다. production에서는 downgrade하지 않는다.

실제 PostgreSQL은 이미 head migration이 적용된 disposable database에서만 검증한다.

```bash
ASKLAKE_VERIFY_REALTIME_POSTGRES=true \
DATABASE_URL=postgresql+psycopg://asklake:asklake_test@127.0.0.1:5432/asklake_test \
npm run verify:realtime-recovery-postgres
```

이 검증은 독립 실행을 위해 disposable DB에 없는 legacy Catalog/freshness/revision/event table만 `checkfirst`로 준비한다. V2 table은 계속 Alembic이 소유한다. 같은 cutover idempotency key를 두 session에서 동시에 실행하고 단일 epoch/revision/event만 생성됐는지 확인한 뒤 자기 fixture를 삭제한다. 공유 production DB에 실행하지 않는다.

ClickHouse live parity smoke는 migration 권한을 가진 disposable instance에 hot/archive fixture table 두 개를 만들고 100개 source position의 partition boundary, count, checksum과 numeric sum을 비교한 뒤 table을 삭제한다.

```bash
ASKLAKE_VERIFY_CLICKHOUSE_RECOVERY=true \
CLICKHOUSE_URL=http://127.0.0.1:18123 \
CLICKHOUSE_USER=asklake_v2_admin \
CLICKHOUSE_PASSWORD='<test-only-secret>' \
CLICKHOUSE_DATABASE=asklake_realtime_v2 \
npm run verify:clickhouse-realtime-v2-recovery-live
```

Docker Desktop가 선언된 loopback port를 publish하지 않는 로컬 환경만 `CLICKHOUSE_DOCKER_CONTAINER=asklake-clickhouse-v2`를 사용할 수 있다. CI/Linux는 HTTP 경로를 사용한다. 이 smoke의 100행은 실제 10만 건 cutover gate를 대체하지 않는다.

독립 evidence JSON은 다음 preflight로 비교한다. mismatch는 exit 1이며 DB를 변경하지 않는다.

```bash
PYTHONPATH=. .venv/bin/python scripts/verify-hot-archive-parity.py \
  --hot /secure/evidence/hot.json \
  --archive /secure/evidence/archive.json
```

PR09 통합 단계에서는 중복되는 PR별 suite 대신 아래 전체 회귀를 한 번만 수행한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m pytest -q

cd ../frontend
npm run verify:ui-regressions
npm run test:dashboard-realtime-v2
npm run build

cd ..
bash tests/deploy/deploy-scripts-regression.sh
docker compose --profile clickhouse-realtime-v2 config --quiet
```

실제 production 10만 건, 72시간 shadow, P95, restart/chaos, security, browser cutover/rollback DOM과 backup/restore evidence는 코드 gate의 boolean을 임의로 true로 채우지 않는다. 모두 operator artifact가 있을 때만 cutover request를 구성한다. 절차와 rollback 금지 사항은 [복구·전환 runbook](realtime-2026/clickhouse-v2-recovery-runbook.md)을 따른다.
