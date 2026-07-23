Warning: truncated output (original token count: 63601)
Total output lines: 2679

# 04. Development Guide

> Kafka revision 기반 SQL 자동 갱신은 API server가 아니라 `app.continuous_worker`에서 실행된다. 로컬 검증 시 Kafka continuous worker와 Trino collector를 함께 실행하고, CTAS 요청 전에 unfinalized SQL Run reservation이 commit되는지와 terminal SQL payload와 collector finalization 사이에도 `etl_jobs.continuous_config.revisionRefresh.processingRunId`가 유지되는지 확인한다. matching Run의 Catalog 공개·`finalized` marker·`publishedSourceRevision`이 한 transaction으로 확정된 뒤에만 processing claim이 비워지고 다음 worker cycle에서 후속 revision이 시작되어야 한다. Trino 제출 응답을 잃은 reservation은 자동 또는 수동 재실행을 허용하지 않는다.

> RAG/OpenSearch/embedding worker는 2026-07-20에 제품과 Compose runtime에서 제거됐다. 이 문서의 이후 RAG 실행·검증 절은 과거 이력이며 실행하지 않는다.

AI Gateway 로컬 실행과 backend/MCP 검증 명령은 [ai-gateway-mcp-rollout.md](./ai-gateway-mcp-rollout.md)를 참고한다.

이 문서는 AskLake 개발, 실행, 검증, 브랜치 작업 기준을 정리한다.

EKS와 EC2 배포는 모두 `dev`를 source branch로 사용하고 각 release는 실제 배포한 exact SHA를 receipt에 남긴다. 두 환경의 배포 시점이 다르면 SHA는 다를 수 있다. EC2는 Spark/Iceberg 기본값과 opt-in ClickHouse V2/Kafka Connect 프로필을 보존하고, EKS는 Realtime V1-only 프로필만 사용한다. 환경별 차이는 별도 브랜치가 아니라 profile/values로 관리하며, active Continuous owner는 항상 하나만 허용한다.

revision 기반 Trino SQL 직렬화 변경은 `asklake-web`의 `trino-result-collector`와 `asklake-realtime-v1`의 `realtime-v1-worker`가 함께 소유한다. EKS rollout 완료 판정에는 같은 승인된 Backend image receipt의 digest가 두 Deployment에 모두 적용됐다는 증거가 필요하다. Collector만 교체하거나 worker만 교체한 상태에서는 중복 실행 방지 배포가 완료된 것으로 보지 않는다.

Realtime worker rollout은 live Deployment에만 존재하는 script/ConfigMap volume, 외부 MSK IAM JAR URL 또는 수동 env patch를 정상 상태로 인정하지 않는다. Spark runtime image가 shaded IAM JAR와 runtime Python을 자체 포함하고, Helm 값은 exact local JAR를 가리키며, 새 SparkApplication이 `deps.jars`와 IAM option을 함께 렌더하는지 먼저 검증한다. 수동 hotfix를 제거하는 교체는 active SparkApplication과 active Continuous/SQL run이 모두 0일 때만 수행하며 checkpoint와 source revision cursor는 보존한다.

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
npm run test:dashboard-axis-range
npm run test:trino-timeline
npm run test:catalog-lineage-projection
npm run verify:ui-regressions
npm run build
```

현재 package script는 TypeScript build와 Vite build를 함께 실행한다.
`npm run test:dashboard-axis-range`는 값 축의 기본/데이터 강조/수동 모드, 8% padding과 nice step, 단일·음수·누적 series, 수동 범위 검증을 외부 서비스 없이 확인한다.
`npm run test:trino-timeline`은 preview의 `쿼리 실행 -> 첫 결과 준비` 단계, full run에서만 보이는 전체 결과 수집 단계, terminal/만료 상태, 2초 progress 지연, 실제 분자/분모 없는 bar 생략, manifest 마무리와 legacy timing fallback을 순수 상태 모델로 검증한다.
`npm run test:catalog-lineage-projection`은 저장된 API graph를 변경하지 않으면서 Catalog 화면에서 `PROCESS` node를 제거하고 동일 컬럼의 source→target edge만 만드는지 검증한다. UI 수동 확인에서는 `/etl/source`의 connector 카드, 전역 152px sidebar, `/catalog` 목록·lineage, `/dashboards/:dashboardId/edit`의 기본 닫힌 데이터 패널, 패널을 열었을 때 모두 접힌 데이터셋 트리와 오른쪽 설정 패널 toggle을 desktop과 좁은 viewport에서 함께 확인한다.

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

`npm run verify:ui-regressions`는 관리자 콘솔 API의 section별 부분 실패 격리, timeline 상태 테스트와 ETL wizard 순차 이동 테스트를 먼저 실행한 뒤 SQL 분석의 Nessie Popover/Bubble/Collapsible 흐름, SQL editor 불변 높이, 결과 panel의 `차트 보기`/`데이터 미리보기`/`실행 정보` 전환, Trino cursor pagination과 server CSV, Dashboard `WidgetConfigPanel` 재사용, 값 축 범위 모드, 위젯별 동적 필터의 타입·저장·종속 후보값 계약, SQL 내부 Job wizard와 최근 UI 회귀 계약을 정적으로 확인한다. 값 축만 빠르게 확인할 때는 `cd frontend && npm run test:dashboard-axis-range`, 위젯 필터만 확인할 때는 `cd frontend && npm run test:dashboard-widget-filters`, 관리자 콘솔만 확인할 때는 `cd frontend && npm run test:admin-console-load`를 실행한다.

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
`npm run test:dashboard-widget-data-state`는 선택 페이지의 Dataset Widget grouping, 최초 pending 조회, 수동 새로고침의 전체 현재 페이지 강제 조회, signature가 일치하는 응답만 runtime에 병합하는 계약을 확인한다. Dashboard frontend에는 polling timer, EventSource 갱신, background prefetch를 추가하지 않는다.
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

프론트 SQL 상태 경계를 바꾼 뒤에는 `cd frontend && npm run test:sql-job-immediate-run && npm run verify:ui-regressions && npm run build`를 실행한다. 이 조합이 preview/full-result 경계, timeline, cursor pagination, SQL Job wizard, create→run/start 순서, 부분 성공 보존, TypeScript 연결과 production bundle을 함께 확인한다.

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

`npm run verify:snapshot-rule-conformance`는 같은 JSON fixture를 Node Kafka runtime과 실제 Spark 4 DataFrame runtime에 적용해 실행 의미의 동등성을 검증한다. `npm run verify:snapshot-spark-pipeline`은 `spark_job_run.py`를 직접 실행해 drop/quarantine/set-null 결과가 Parquet에 반영되고 portable/SQL 혼합 `Fail Batch` target과 staging 경로가 남지 않는지 확인한다. 또한 `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES=1`인 staging control과 충분한 source byte 한도의 direct-cache candidate에서 실제 JSONL `FileScanRDD` 로그를 세어 정상 raw source read가 각각 정확히 1회인지 회귀 검증한다. direct-cache candidate는 materialization file과 timing이 0이고, staging control은 run-scoped Parquet를 생성·정리해야 한다. process 기본값은 0이며 검증된 dev EKS 활성값은 10GiB다. 활성값은 아래 runtime ConfigMap과 Backend/Spark 동일 revision 승격 절차로만 적용한다.

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

일반 Spark Iceberg writer의 실제 commit/replace/rollback 검증은 로컬 PostgreSQL, MinIO, Docker와 Trino가 실행 중일 때 아래처럼 수행한다. 이 검증은 고유 table을 만들고 종료 시 삭제하며 기존 Trino container를 재시작하지 않는다. 기존 current snapshot이 있는 상태의 Quality `Fail Run`도 실행해 Iceberg commit 부재, current snapshot·snapshot 수·row count 불변과 staging cleanup을 함께 확인한다.

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

배포 Compose에서는 backend와 Airflow scheduler의 execution token이 반드시 같아야 한다. `scripts/deploy.sh start|deploy|restart`는 이 제어-plane 컨테이너를 강제 재생성하고 두 값의 hash만 비교한다. hash가 다르면 배포를 중단하며 실제 token은 출력하지 않는다.

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
SQL과 Dashboard generation의 `rag_context`/`usedEvidenceIds` 필드는 이전 응답 shape 호환을 위해 남아 있지만, 현재 resolver는 `sources=[]`, `mode/status=disabled`, `provenance=rag_removed`만 반환한다. Provider가 근거 ID를 임의로 만들면 기존 allowlist 검증이 이를 거부하며, SQL/widget 본체의 안전 검증은 그대로 적용한다.

Semantic Model 관리 UI는 `/catalog?view=semantic`에서 확인한다. `/semantic-layer`와 기존 `/ai`는 같은 URL로 replace 이동해야 하며, standalone AI 메뉴나 채팅 화면을 다시 추가하지 않는다. Dataset schema와 metric·dimension은 `semanticApi.ts`의 live Semantic Model endpoint를 사용한다. 폐기된 RAG 분류·승인·색인·작업 이력 UI는 노출하지 않는다. 최소 frontend 검증은 다음과 같다.

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

독립 `AI 활용` 메뉴는 없다. SQL 분석의 `Nessie로 SQL 작성`, Dashboard Assistant, 수집/처리 변환 AI와 리뷰 분석이 private AI Gateway를 공유한다.

수동 확인은 다음 순서로 한다.

1. sidebar에 `AI 활용` 메뉴가 없고 `/ai`가 별도 채팅 화면 대신 `/catalog?view=semantic`으로 replace 이동하는지 확인한다.
2. SQL 분석에서 실제 Dataset을 선택하고 SQL 초안을 생성한다. 요청 중 prompt·Dataset·editor context를 바꿨을 때 이전 응답이 적용되지 않는지, 자동 실행되지 않으며 적용 후 read-only/scope 검사를 다시 통과하는지 확인한다.
3. 대시보드 편집기에서 시각화를 요청한다. `create_widget` 또는 `update_widget` action이 실제 draft에 저장되고 그래프가 렌더링되는지 확인한다. 저장 API를 실패시킨 경우 성공 문구를 표시하지 않고 기존 draft와 입력을 유지해야 한다. 요청 중 Dashboard, page, Dataset 또는 선택 widget을 바꾸면 이전 요청이 취소되고 그 응답의 mutation이 새 화면에 적용되지 않아야 한다.
4. 수집/처리에서 field transform과 SQL transform을 생성하고 입력 schema 밖의 컬럼·관계·위험 함수를 거부하는지 확인한다.
5. Semantic Layer에서 Dataset 연결, metric·dimension 편집, validation과 publish가 정상 동작하는지 확인한다. RAG 역할·색인·검색 UI는 노출되지 않아야 한다.
6. SQL과 대시보드의 호환 `RAG 근거` 영역은 source 없이 disabled 상태를 유지하고, 임의 evidence ID를 표시하지 않아야 한다.
7. Gateway가 없을 때 가짜 SQL·차트 대신 명시적인 unavailable/empty 상태가 보이는지 확인한다.
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

### RAG Data Plane 은퇴 확인

RAG/OpenSearch/embedding worker runtime은 현재 제품과 Compose/EKS 배포 범위에서 제거됐다. 전용 GitHub Actions workflow, backend RAG/OpenSearch 검증 script·fixture와 부분 embedding-worker 소스도 제거했으므로 해당 명령을 실행하지 않는다. 기존 Alembic migration, 모델, deletion receipt와 외부 volume/object는 호환·복구 이력으로만 보존하며 별도 운영 승인 없이 물리 삭제하지 않는다. 재활성화는 이 병합 범위가 아니며 별도 제품 결정과 migration/보안 검토가 필요하다.

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

### Kafka revision + S3 JOIN 1-hour demo fixture

Dashboard 수동 새로고침 구조를 한 번 검증할 때는 전용 S3 상품 CSV와 Kafka 이벤트 topic을 준비한다. 이 fixture는 두 소스가 `product_id`를 공유하며 기존 fixture topic과 object를 변경하지 않는다.

```bash
cd backend
npm run verify:kafka-s3-demo
npm run demo:kafka-s3:prepare
npm run demo:kafka-s3:produce
```

기본 producer는 `asklake.revision.events.v1` topic에 100건씩 1초 간격으로 3,600회, 총 360,000건을 전송한다. `Ctrl+C`로 중단하면 현재 1초 batch까지만 전송하고 종료한다. 짧게 확인하려면 `npm run demo:kafka-s3:produce -- --duration-seconds 2 --rate 100`을 사용한다.

파이프라인 생성 화면에는 다음 값을 사용한다.

| 소스 | 입력값 |
| --- | --- |
| Kafka broker | 로컬 backend는 `127.0.0.1:19092`, Compose 내부 worker는 `redpanda:9092` |
| Kafka topic | `asklake.revision.events.v1` |
| Kafka 실행 방식 | `실시간 수집` |
| S3 endpoint | `http://127.0.0.1:9000` |
| S3 bucket | `m3-raw` |
| S3 object | `asklake-fixtures/kafka-s3-refresh-demo/products.csv` |

S3 파이프라인을 먼저 Snapshot으로 한 번 실행하고 Kafka Continuous 파이프라인을 실행한다. 두 결과 Dataset이 Catalog에 `available`로 보이면 SQL 분석에서 Dataset을 선택하고 다음 형태로 JOIN한다. 실제 Dataset 표시명은 생성할 때 정한 이름으로 바꾼다.

```sql
SELECT
  e.event_time,
  e.event_id,
  e.event_type,
  e.product_id,
  p.product_name,
  p.category,
  p.brand,
  e.quantity,
  e.amount
FROM "Kafka 이벤트 데이터셋" AS e
LEFT JOIN "S3 상품 데이터셋" AS p
  ON e.product_id = p.product_id
```

`demo:kafka-s3:prepare`는 이 테스트 전용 topic만 비우고 다시 만든다. 실행 중인 같은 topic의 Kafka Job이 있으면 먼저 중지해야 하며, topic 내용을 보존하려면 `npm run demo:kafka-s3:prepare -- --keep-topic`을 사용한다. endpoint, bucket, key, broker, topic은 `ASKLAKE_DEMO_S3_*`, `ASKLAKE_DEMO_KAFKA_*` 환경변수로 바꿀 수 있다. 이 도구는 mock source를 준비하고 메시지를 넣는 역할만 하며 ETL Job이나 Dashboard를 자동 생성하지 않는다.

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

Kafka Continuous Ingestion은 Issue #500 Phase 3에서 long-running Spark Structured Streaming worker까지 연결됐다. Snapshot Job은 wizard의 스케줄 단계에서 수동/반복 실행을 고르고, Continuous Job은 해당 단계를 건너뛰어 생성 후 스트림 시작/중지로 제어한다. Continuous S…33601 tokens truncated… 확인한다.

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
execution 증거로 해석하지 않는다. 실제 receipt 검증은 배포된 `dev` full commit을 반드시 묶는다.

```bash
ASKLAKE_TRINO_DEPLOYMENT_COMMIT=<deployed-dev-full-sha> \
  node scripts/verify-eks-trino-distributed-evidence.mjs \
  /path/to/redacted-trino-distributed-receipt.json
```

실제 component release는 Git 제외 mode `0600` private values에서
`trino.distributed.workerReplicas=2`를 고정하고 먼저 server-side dry-run한다. SQL 요청·UI와 HPA는
worker 수를 변경하지 않으며 다른 수는 chart schema와 배포 preflight가 거부한다.
General NodePool의 live CPU/memory 상한도 실제 cluster-wide requests와 새 node system overhead를
수용해야 한다. 2026-07-19 검증에서는 기존 8 CPU·32Gi 상한이 이미 사용 중인 6 CPU 때문에 새
x86 node를 만들지 못해 private live 상한을 12 CPU·48Gi로 조정했다. 이 값은 상시 node 수나
worker 성능 sizing이 아니며 다른 workload와 부하가 달라지면 다시 계산한다.
승인된 적용은 배포 worktree의 `HEAD`와 fetched `origin/dev`를 동일한 full SHA로 고정하고
`ASKLAKE_TRINO_DEPLOYMENT_COMMIT`에 그 값을 전달해 `deploy-eks-trino-distributed.sh --apply`로
수행하며 현재 immutable Trino image를 보존한다. 이미 분산 모드인 release를 재적용할 때도 live
values에서 `trino.distributed` 객체 전체를 `{enabled:false}`로 교체한 별도 values를 baseline에
사용하며 기존 distributed 값을 그대로 재사용하지 않는다. distributed apply 전에는 같은 chart의 단일 coordinator `Recreate` 상태와 인증된 Iceberg
query를 먼저 검증하고 그 Helm revision을 안전 rollback 기준으로 고정한다. apply 뒤
`verify-eks-trino-distributed-live.sh 2`가 Deployment Ready뿐 아니라
FastAPI의 materializer identity로 `system.runtime.nodes`를 조회해 coordinator 1개와 active worker
수를 확인하고 기존 non-empty Iceberg table을 실제로 한 행 읽는다. 이 조회 권한은 distributed
mode의 materializer에만 `system_information: read`, system catalog
read-only와 `system.runtime.nodes|tasks` SELECT를 함께 부여하며 일반 query identity에는 주지 않는다.
실패하면 deploy script가 안전 단일 coordinator Helm revision으로 되돌린다. active-node gate는
배포 안전 확인일 뿐 promotion 완료 증거가 아니다. non-empty Iceberg worker task,
exact-UID 장애 복구와 안전 rollback까지 같은 campaign에서 검증해야 한다. 최초 2-worker
campaign의 `2→1→2` 기록은 역사적 scale evidence이며 현재 fixed-2 운영 명령으로 사용하지 않는다.
single baseline 생성 또는 query 검증이 실패하면 fixed-2 후보를 적용하지 않고 배포 전 관찰한
revision을 복구해 기존 worker 수와 Iceberg query가 다시 정상인지 확인한다.
apply 전체에서는 namespace-scoped `asklake-trino-deploy-lock` ConfigMap을 원자적으로 획득하고
lock에는 획득 시각, 병합 commit, 관찰 revision을 기록한다. 비정상 종료로 lock이 남으면 이름 기반
강제 삭제를 하지 않고 [Trino distributed runbook](eks-trino-distributed-phase0.md)의 상태 확인과
UID-precondition break-glass 절차를 따른다. 각 Helm mutation은 command 결과의 revision을 즉시
기록하고 query gate 뒤에도 같은 revision인지 확인하므로 foreign revision을 성공으로 인정하거나
rollback하지 않는다.

Spark Operator가 `spark.jars.packages`를 submission Pod에서 해결하므로 `spark.jars.ivy=/tmp/.ivy2`를 유지해 비루트 controller의 쓸 수 없는 home 경로를 피한다. Spark driver namespace Role은 executor Pod·Service·ConfigMap lifecycle과 shutdown label cleanup에 필요한 `deletecollection`을 제공하고, PVC는 cleanup-only get/list/delete/deletecollection만 허용한다. Secret, Node와 cluster-wide resource 조회는 허용하지 않는다.

`spark_job_run.py`는 배포 경로 호환 façade이고 Kafka bounded offset·MSK IAM·fixture row-count 구현은 `backend/scripts/runtime/spark_job_runtime.py`에 있다. `scripts/verify-eks-workloads.sh`는 façade의 존재와 실제 runtime 구현을 각각 검사해야 하며, 구현 문자열을 façade에 복제해 검증을 통과시키지 않는다. EKS lease와 Kubernetes identity helper를 변경하면 realtime architecture budget과 `tests.test_eks_execution_contract`, `tests.test_eks_runtime_boundary`, `tests.test_runtime_io_ports`, `npm run test:spark-kubernetes`를 함께 실행한다.

Spark Resource Planner를 변경하면 pure planner와 S3 metadata fallback,
같은 Job history filter와 100GB backtest, Kubernetes application/recovery identity,
terminal retry Plan 유지, nested 후보 평가의 canonical hash, Helm의 `off` 기본값,
`history-sla-cost-v1`의 384 partition seed, `standard-v1` executor profile과 최대 4
schema gate를 함께 검증한다. profile drift와 입력 metadata 부재는 `enforce`에서도
baseline을 보존해야 한다. EKS에서는 같은 immutable image의 10GB Shadow와 100GB
Shadow가 통과하기 전 `enforce` 실험을 시작하지 않는다. 상세 계약은
[Spark Resource Planner 계약](spark-resource-planner-contract.md)을 따른다.

focused 검증은 아래 순서로 실행한다.

```bash
cd backend
python -m pytest -q tests/test_spark_resource_plan.py \
  tests/test_airflow_execution_commands.py \
  tests/test_eks_runtime_boundary.py \
  tests/test_eks_execution_contract.py
node --test scripts/spark-kubernetes-client.test.mjs
```

Phase 3 준비는 `prepare-eks-spark-resource-planner-shadow-values.sh`와
`prepare-eks-spark-resource-planner-shadow-web-values.sh`로 각각 Planner-only
runtime 후보와 `runtimeConfigRevision`-only Web 후보를 만든다. 두 입력과 출력은
Git-ignored mode `0600`이어야 한다.
현재 live profile이나 Spark digest가 `standard-v1`과 formal receipt에 맞지 않으면
먼저 `prepare-eks-spark-resource-planner-off-values.sh`와
`prepare-eks-spark-resource-planner-off-web-values.sh`로 Planner를 `off`로 유지한
image/profile 후보를 만든다. 이 후보는 누락되었거나 이미 승인값과 같은 설정만
정렬하며 예상 밖 기존 값을 덮어쓰지 않는다.
`preflight-eks-spark-resource-planner-shadow.sh`는 live/base exact match, image
receipt, workload health, active Spark 0, 두 Helm server dry-run의 mutation 0을
확인한다. `ASKLAKE_SPARK_RESOURCE_PLANNER_TARGET_MODE=off`는 선행 정렬 후보를,
기본 `shadow`는 shadow 후보를 검사한다. 10/100GB 결과는
`verify-eks-spark-resource-planner-shadow-evidence.mjs`로 검증한다. 실제 apply,
image rollout과 각 Spark Run은 별도 승인 경계다. 전체 순서는
[Phase 3 Shadow runbook](eks-spark-resource-planner-phase3-shadow-runbook.md)을
따른다.

Shadow evidence가 통과하면 live shadow runtime/Web 값을 base로 다시 캡처하고
`prepare-eks-spark-resource-planner-enforce-values.sh`와
`prepare-eks-spark-resource-planner-enforce-web-values.sh`를 실행한다.
`ASKLAKE_SPARK_RESOURCE_PLANNER_TARGET_MODE=enforce` preflight는 동일 image/profile에서
mode 한 키만 바뀌는지 확인한다. canary 뒤 off builder로 복구할 때도 active mode의
image와 policy/profile exact match가 필수이며 최종 mode/baseline은 `off/1`이다.

Live FastAPI와 Collector는 `asklake-runtime-config` release가 소유하는
`asklake-runtime` ConfigMap을 소비한다. 따라서 Planner mode·정책값·executor
baseline과 새 Spark runtime digest는 private runtime-config values 한 revision에서
함께 바꾸고, Backend/Collector image는 별도 `asklake-web` atomic rollout을
사용한다. 두 release 중 하나만 갱신된 상태에서는 Run을 제출하지 않는다.

동시 bounded fixture 검증은 A가 승인한 MSK group을 먼저 `asklake-runtime-config` release의 `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`에 exact group/table 쌍으로 추가한다. 기본 `asklake-eks-mvp-spark-v1 → eks_mvp_fixture` slot은 항상 포함하고 scale slot은 최대 4개만 더한다. group과 table 중복, wildcard/prefix, 기본 slot 제거, 5개 초과는 Backend와 Spark runtime이 모두 거부한다. 실제 private values를 만들기 전 A의 IAM group 범위 승인이 없으면 기본 slot을 여러 Job에 복제하지 말고 blocker로 남긴다.

Terraform의 Spark MSK group 권한은 `msk_scale_consumer_groups`에 `49d163cfbaf1`부터 필요한 exact 값만 선택한다. 변수 validation은 `scale17-01..04` 외 값과 wildcard를 거부하고, IAM policy는 기본 group ARN과 선택한 group ARN만 `DescribeGroup`/`AlterGroup` resource로 렌더한다. 3개 실험에는 `01..03`만 사용하며 4번째는 3개로 Pending 증거를 만들 수 없을 때 별도 검토 후 추가한다.

```bash
# 저장소 root
docker compose up -d --wait minio postgres trino

cd backend
CLICKHOUSE_E2E_LIVE_TRINO=true npm run verify:clickhouse-kafka-join
```

Phase 2부터 prod-like Compose는 내부 broker `redpanda:9092`를 제공한다. 이 broker는 Snapshot fixture와 이후 Continuous Spark worker가 같은 Docker network에서 사용할 endpoint이며, 외부 Kafka endpoint를 쓰려면 배포 env에서 `ASKLAKE_KAFKA_BROKER`를 바꾼다.
ETL 생성 화면은 `GET /api/etl/sources/defaults`에서 backend의 비밀이 아닌 Kafka broker/topic과 S3 bucket/prefix 기본값을 읽는다. Kafka와 로컬 MinIO의 새 빈 Source draft에는 이 값을 한 번 채운다. AWS S3의 bucket/prefix는 비워 두고, `s3Bucket`은 버킷 입력창을 포커스했을 때 사용자가 선택할 수 있는 워크스페이스 기본 버킷 제안으로 표시한다. 저장된 draft나 사용자가 편집한 값은 덮어쓰지 않는다. 로컬 Kafka broker 기본값은 `127.0.0.1:19092`, prod-like Compose 기본값은 `redpanda:9092`이며 frontend build 변수로 같은 값을 중복 관리하지 않는다.
Kafka 소스 연결 테스트는 새 샘플 consumer group이 첫 메시지를 받을 때까지 `ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS`(기본 8초)를 기다린다. 첫 메시지 이후 `ASKLAKE_KAFKA_SAMPLE_MIN_MESSAGES`(기본 3건)에 도달하면 `ASKLAKE_KAFKA_SAMPLE_IDLE_MS`(기본 0.5초) idle window로 종료한다. 최소 건수에 도달하지 못한 희소 topic은 `ASKLAKE_KAFKA_SAMPLE_SETTLE_MS`(기본 1.5초)까지만 추가 메시지를 기다린 뒤 현재 샘플을 반환한다.

Continuous worker는 Spark 4.0.1/Scala 2.13 Kafka connector를 사용한다. Production은 `ASKLAKE_SPARK_RUNNER=rest`로 내부 Spark Standalone REST submission을 사용하고 backend에 Docker socket/CLI를 요구하지 않는다. 로컬 개발에서만 `ASKLAKE_SPARK_RUNNER=docker`를 명시해 격리 worker/maintenance container를 실행할 수 있다. 두 경로 모두 같은 Iceberg/JDBC/warehouse package와 runtime environment 계약을 사용한다.

host에서 실행하는 local FastAPI와 Docker Continuous worker가 같은 Redpanda를 사용할 때는 `ASKLAKE_KAFKA_BROKER_IN_DOCKER=asklake-redpanda:9092`를 함께 설정한다. `scripts/start-local-query-runtime.sh` 또한 이 값을 로컬 기본값으로 사용한다. Source 연결 테스트와 저장값은 host용 `127.0.0.1:19092`를 유지하고, Docker worker를 시작할 때만 loopback broker를 내부 endpoint로 바꾼다. 외부 Kafka hostname은 변경하지 않는다.

Production-like Continuous E2E는 Compose를 먼저 올린 뒤 opt-in으로 실행한다. retained backlog, schema/Rule quarantine, Transform/Quality 카운터, Rule-aware replay, 신규 이벤트, pause/resume, worker kill 후 checkpoint restart, Catalog fingerprint materialization, duplicate-free counter를 검증한다. worker 시작 시 target `s3a://` bucket은 MinIO에 없으면 자동 생성된다. 사용자 요청으로 인한 pause/stop의 SIGTERM 종료는 각각 `paused`/`stopped`로 처리하고, 요청 없이 종료된 worker만 `failed`가 된다.

Iceberg writer 자체의 격리 검증은 기존 서비스 전체를 올리지 않고 고유 Redpanda/Trino/Spark를 시작한다. 정상 append, Iceberg commit 뒤 manifest 전 fault, 같은 boundary 재사용, checkpoint restart, append 중 Trino snapshot read, maintenance 전후 현재 row count와 과거 snapshot time-travel을 검증하고 종료 시 table/container/metadata를 정리한다.

각 scale Job의 `sourceConfig`에는 서로 다른 등록 group을 넣고 table은 요청으로 받지 않는다. FastAPI가 slot mapping에서 target을 정하며 active Run 예약은 PostgreSQL group별 advisory lock으로 직렬화된다. 따라서 동일 slot 두 번째 실행은 Airflow/Spark 호출 전 `409 EKS_MVP_FIXTURE_SLOT_ACTIVE`, 서로 다른 3~4개 slot은 각기 고유 group/table과 Run별 output/checkpoint로 진행된다. 빠른 정적 검증은 다음과 같다.

```bash
cd backend
npm run test:kafka-fixture-boundary
npm run test:spark-kubernetes
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_etl_job_delete.EtlJobDeleteRunConcurrencyTests.test_three_approved_fixture_slots_reserve_unique_groups_and_tables
```

Continuous control-plane worker는 `CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS`(기본 1초, 허용 범위 1~60초)마다 active Continuous worker report를 동기화한다. 이 control-plane sync가 Catalog materialization을 수행하므로 Job 목록/상세 조회가 없어도 적재 batch가 Catalog에 등록된다. Production web/API는 `CONTINUOUS_CONTROL_PLANE=disabled`, 전용 worker는 `worker`로 실행한다. worker는 PostgreSQL lease를 보유한 경우에만 Spark 명령과 reconciliation을 수행한다. Start/resume intent의 committed fencing token은 Spark runner의 worker attempt ID로 전달한다. 이전 attempt의 report가 stale이고 runner가 `exited`/`missing`이거나 control-plane 재배포로 state가 `unknown`이면 worker는 그 report만 무시하고 같은 fence로 start를 재제출하므로 `starting`에 고착되지 않는다. Dashboard frontend는 수동 새로고침만 수행하며 `DASHBOARD_AUTO_REFRESH_ENABLED`나 Realtime event 설정이 있어도 EventSource 또는 polling을 시작하지 않는다. Worker는 target의 `_batch-manifests/batch_id=*`에 valid/quarantine count를 함께 기록하고, 재시작 때 이 manifest를 읽어 runtime counter를 복구한다.
15.5 bounded 물리 조회는 호환상 `scripts/run-eks-catalog-physical-read-smoke.sh` 이름을 유지한다. Git 제외 Phase 6 image receipt와 `datasetId`, `materializationRoot`, `objectUri`만 가진 Git 제외 `*.physical-read-input.json`을 명시한다. 이 실행기는 URI root 경계만 확인하며 Catalog API를 다시 조회하지 않으므로 `datasetId`는 운영자 인수 문맥이고 결과는 Catalog provenance 증거가 아니라 `bounded-s3-parquet-object` 증거다. `--validate-only`는 AWS/Kubernetes mutation 없이 receipt·입력·AMD64 image와 임시 SparkApplication manifest를 검사한다. `--live`는 별도 confirmation과 검증된 EKS context, Established CRD, Ready controller/webhook, `asklake-spark` ServiceAccount, Ready AMD64 Spark NodePool/NodeClass, 단일 Pod Identity association과 server-side dry-run을 모두 통과해야 한다. 그 뒤 최대 100행을 제한 조회하고 실제 row나 URI 대신 column/row count와 폭 일치만 출력한다. 성공·실패·timeout·signal 모두 현재 run label과 exact name prefix의 SparkApplication·Pod·Service·ConfigMap·PVC를 정리한다. cleanup/audit API 오류는 잔여 0으로 간주하지 않고 실패하며 Spark Secret read 거부도 확인한다. timeout은 1~3600초, poll은 0.1~30초로 제한한다.

7/16 Pair A data-plane 작업 전에는 `scripts/capture-eks-day16-a-baseline.sh --expect-phase0`로 현재 Web/Airflow, Secret delivery, ServiceAccount/Pod Identity, Spark Operator, MSK endpoint, ECR/RDS/ALB, Continuous와 외부 EC2 rollback 기준점을 읽기 전용으로 고정한다. capture는 source/target Secret value를 출력하지 않고 canonical hash와 공유 token 동일성만 비교한다. 당시 발견한 Airflow password와 Backend Trino mapping drift는 canonical ExternalSecret/target으로 수렴했다. 이 기준점 문서는 역사적 입력이며 현재 판단은 Phase 4~7 증거와 재사용 verifier를 따른다.

Phase 1의 실제 Spark·Trino 입력은 `scripts/prepare-eks-day16-runtime-secret-input.sh`로 생성한다. 이 helper는 available dev RDS와 `asklake/dev/rds/application-databases`의 기존 `iceberg_catalog` credential을 값 출력 없이 대조하고, Trino TLS/JKS·bcrypt password database·Backend client 인증 patch를 `infra/eks/secrets/*.runtime-secret-input.json`에 `0600`으로 기록한다. 해당 파일은 Git 제외 대상이며 Terraform/Helm values가 아니다. 유효한 입력이 이미 있으면 자동 회전하지 않고 재검증만 한다. `node scripts/verify-eks-day16-runtime-secret-input.mjs <private-input>`은 exact key, 공유 JDBC binding, password 분리, JKS/CA fingerprint와 SAN을 확인한다. Phase 1은 AWS source나 ExternalSecret을 변경하지 않는다. [Phase 1 입력 준비 기록](eks-day16-a-runtime-secret-input.md)을 따른다.

Phase 2는 `ASKLAKE_DAY16_SECRET_APPLY_CONFIRM=apply-spark-trino-runtime-secrets bash scripts/deploy-eks-day16-runtime-secrets.sh`로 적용한다. 실행기는 기존 Backend/Airflow를 보존하고, Spark·Trino AWS source와 staged ExternalSecret의 일반 문자열/binary decode hash가 맞을 때만 최종 target을 만든다. `scripts/verify-eks-day16-runtime-secret-delivery.sh`는 private input/source/target, exact mapping, owner/Ready, 여섯 ServiceAccount의 Secret read deny와 Web/Airflow steady 상태를 값 출력 없이 검사한다. 결과와 Backend patch 보류 이유는 [Phase 2 전달 기록](eks-day16-a-runtime-secret-delivery.md)을 따른다.

Phase 3의 Trino overlay는 `scripts/prepare-eks-day16-trino-values.sh`로 한 번 생성하고 `scripts/verify-eks-day16-trino-values.sh`로 검증한다. 실제 reference가 든 `infra/eks/values/workloads/*.private-values.json`은 `0600`, Git 제외 상태를 유지한다. Trino resource만 server-side dry-run하며 기존 Airflow/Web release ownership은 변경하지 않는다. 실제 data-plane smoke는 exact EKS context와 `ASKLAKE_TRINO_DATA_PLANE_SMOKE_CONFIRM=run-trino-data-plane-smoke`를 설정해 `scripts/run-eks-day16-trino-data-plane-smoke.sh`로 수행한다. 이 Job은 Trino Pod Identity, RDS isolated login, Warehouse/Query Result positive/negative S3 경계와 namespace DNS를 확인하고 모든 versioned object와 Kubernetes 임시 resource를 정리한다. [Phase 3 검증 기록](eks-day16-a-trino-data-plane.md)을 따른다.

Phase 4 fixture producer는 `prepare-eks-day16-fixture-producer-identity.sh`로 Terraform의 exact policy를 전용 외부 role/policy에 반영한다. idempotent producer에는 exact cluster의 `Connect`, `WriteDataIdempotently`와 exact fixture topic의 `DescribeTopic`, `WriteData`만 허용한다. 로컬에서 private MSK에 접근할 수 없으면 confirmation 아래 `run-eks-day16-fixture-producer-ec2.sh`를 사용한다. 실행기는 ingress 없는 임시 security group, 잠금 파일 기반 `npm ci`, IMDSv2 instance-profile credential을 사용하고 정확히 100건과 broker ack를 private `0600` receipt로 검증한다. 종료 시 EC2, host role/profile, security group과 MSK 임시 ingress 잔여물이 없어야 한다. 장기 access key를 만들거나 receipt를 Git에 추가하지 않는다.

Phase 5 private handoff는 `scripts/prepare-eks-day16-a-handoff.sh`로 생성하고 exact EKS context에서 `scripts/verify-eks-day16-a-handoff.sh --audit`로 검사한다. 실제 reference는 `*.handoff.json`, `*.runtime-secret-contract.json`, `*.private-values.json`, `*.fixture-receipt.json` Git 제외 파일에만 둔다. 모든 Day 16 실행기는 `ASKLAKE_IMAGE_RECEIPT`로 현재 private formal receipt를 명시해야 하며 파일이 Git 제외·미추적·`0600`인지 확인하고 과거 revision의 암묵적 기본값을 사용하지 않는다. audit은 현재 blocker를 보고하고 `--ready`는 전체 server dry-run, decision-aware full-service Secret과 live `asklake-runtime` ConfigMap의 승인된 Helm owner/exact image까지 준비돼야 통과한다. owner가 미정인 ConfigMap을 임의 adopt하지 않는다. 모든 blocker가 0인 뒤 confirmation을 준 `scripts/promote-eks-day16-a-handoff.sh`만 private handoff를 `ready-for-deploy`로 올린다. [Phase 5 검증 기록](eks-day16-a-handoff.md)과 [Phase 6 promotion gate 기록](eks-day16-phase6-promotion-gate.md)을 따른다.

현재 `asklake-runtime` owner는 전용 `asklake-runtime-config` release로 확정됐다. `scripts/prepare-eks-runtime-config-values.sh`가 live ConfigMap을 Git 제외 `0600` values로 내보내고, `scripts/deploy-eks-runtime-config-release.sh`가 live/render canonical hash 일치와 Helm server dry-run을 통과한 경우에만 ownership을 인수한다. 이후 `scripts/verify-eks-runtime-config-release.sh`는 단독 release annotation, exact data hash와 workload 무변경을 확인한다. 실제 dev 전환은 data 변경 없이 완료됐다.

10GiB Spark hybrid를 dev EKS 공용 경로에 활성화할 때는 PR revision의 formal image
receipt를 먼저 만든다. `prepare-eks-spark-hybrid-activation-values.sh --capture-live`는
현재 ConfigMap과 `asklake-web` values를 Git 제외 mode `0600` base로 캡처하고, receipt의
Backend/Spark immutable image와 `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES=10737418240`
만 후보에 반영한다. Web 후보는 Backend image와 runtime data hash에서 만든
`spark-hybrid-<hash>` revision만 바꾼다. active SparkApplication이 0일 때만 preflight와
apply를 허용하며 server dry-run은 cluster mutation 0이어야 한다.

```bash
export ASKLAKE_IMAGE_RECEIPT='<private current-revision image receipt>'
export KUBECONFIG='<validated dev kubeconfig>'
bash scripts/prepare-eks-spark-hybrid-activation-values.sh --capture-live
bash scripts/deploy-eks-spark-hybrid-activation.sh --preflight
ASKLAKE_SPARK_HYBRID_ACTIVATION_CONFIRM=activate-10gib-spark-hybrid \
  bash scripts/deploy-eks-spark-hybrid-activation.sh --apply
```

apply는 runtime ConfigMap을 먼저 올린 뒤 FastAPI 2개와 Collector 1개를 같은 revision으로
rollout한다. 중간 또는 사후 검증이 실패하면 두 Helm release를 이전 revision으로
복구한다. 성공 판정은 새 Pod의
실제 env가 10GiB인지, Backend/Spark image가 같은 receipt인지, ALB가 steady인지,
새 SparkApplication driver env에 같은 값이 전달되는지를 모두 확인한 뒤 내린다.
롤아웃 직후 정상적인 target draining, Ready EndpointSlice 수렴, healthy floor 수렴은
최대 10분 동안 15초 간격으로 기다리고, steady가 3회 연속 관찰되어야 성공한다.
그 밖의 ALB 오류는 즉시 실패하며,
제한 시간 안에 steady가 되지 않아도 두 Helm release를 직전 revision으로 되돌린다.

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

`dev` 배포 전에는 아래 항목을 모두 확인한다.

- 배포 receipt와 image가 최신 승인 `origin/dev`의 exact SHA를 가리켜야 한다.
- workload chart render에는 Role/RoleBinding이 없어야 하고, foundation chart가 FastAPI/Spark driver RBAC의 유일한 소유자여야 한다.
- foundation의 `asklake-backend`와 `asklake-spark` ServiceAccount는 모두 `automountServiceAccountToken: true`여야 한다.
- Frontend, Backend, Spark runtime, Airflow의 실제 ECR `repository@sha256:digest`와 `linux/amd64` 증거가 receipt 또는 배포 기록에 있어야 한다. PR의 build-only `push: false` CI는 ECR push 증거로 보지 않는다.
- PR과 API 문서의 Continuous 차단 오류 코드는 `CONTINUOUS_CONTROL_OWNED_BY_EC2`로 일치해야 한다.
- A의 `asklake-web` release가 이미 설치돼 있으면 Frontend/Backend가 활성화된 일반 Helm install을 진행하지 않는다. Airflow-only component release는 비활성 component가 0개 resource로 렌더되는 verifier를 통과한 경우에만 사용한다. 동일 `frontend`/`fastapi` Service의 ownership 전환은 별도 rollback 절차가 합의되기 전까지 금지한다.

AWS 입력이 준비되면 먼저 `mskSmoke.create=true`로 metadata smoke를 실행하고 성공 후 producer receipt의 batch ID/count로 bounded Kafka fixture를 실행한다. 정적 smoke는 `sparkApplication.create=true`와 고유 `runId`/`jobId`를 사용하고, 제품 경로는 exact fixture sourceConfig로 AskLake Job을 실행해 같은 `runId`가 Airflow와 동적 SparkApplication까지 전달되는지 확인한다. 두 경로 모두 실행 시점의 `earliest`~`latest`를 읽되 해당 `raw.fixture_batch_id`만 남겨 전용 `iceberg.asklake.eks_mvp_fixture` table을 replace commit하므로 이전 smoke batch나 Continuous 소유권과 섞이지 않는다. Spark report의 input/output count, commit source boundary와 snapshot ID가 producer expected count와 같아야 한다. 그 다음 Trino에서 `SELECT count(*) FROM iceberg.asklake.eks_mvp_fixture`와 snapshot/file evidence를 조회한다. 이 live 결과는 B 코드만으로 독립 생성할 수 없고 A의 endpoint, fixture topic, Pod Identity, bucket, Secret, ECR digest가 실제로 연결되어야 한다.

금요일 scale 실행에서는 위 단일 smoke와 별도로 승인된 3개 slot부터 시작하고, 현재 Spark 여유 용량을 넘지 못한 경우에만 네 번째 slot을 사용한다. 실행 전 `group → table → fixture batch → expected count` 표를 private receipt 입력에 고정하고, 모든 Run이 terminal인 뒤 group, Run별 output/checkpoint, table, snapshot, Catalog dataset이 pairwise unique인지 교차 검사한다. `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON` 변경은 live ConfigMap을 raw patch하지 않고 전용 runtime-config release의 private values, server dry-run, rollback 절차로 전달한다.

일반 FastAPI batch 실행은 `ASKLAKE_SPARK_RUNNER=kubernetes`에서 deterministic `SparkApplication`을 제출한다. driver와 executor에는 모두 Spark 전용 workload selector, AMD64 selector와 `NoSchedule` toleration을 넣고, package resolution cache는 `spark.jars.ivy=/tmp/.ivy2`로 고정한다. provider unit test는 두 replica가 같은 run identity를 사용하고, create 응답 유실 뒤 한 번의 POST만으로 복구하며, 다른 identity object를 거절하는지 검증한다. driver Pod가 생성되기 전 submission failure에서는 Pod log `404`가 SparkApplication status 원인을 덮지 않아야 한다. 실제 cluster smoke에서는 실행 중 같은 `runId` 요청이 RDS lease로 차단되고 terminal 재요청이 같은 UID object를 복구하며 label 기준 object 수가 하나인지 확인한다.

동적 batch 회귀 검증은 `npm run verify:spark-kubernetes-client`, `python -m unittest tests.test_runtime_script_contracts`, `npm run verify:production-spark-contract`를 함께 실행한다. render된 Driver env에는 inline manifest가 있어야 하고 Iceberg JDBC 세 항목은 각각 하나의 `secretKeyRef`만 가져야 한다. Spark runtime image 안에서 UID 185가 `/work/reports`에 atomic report를 작성할 수 있어야 하며, Helm `asklake-web` render에는 Backend가 `asklake-spark-runtime`의 JDBC user/password key를 `TRINO_ICEBERG_JDBC_*` alias로 소비하는 선언이 포함돼야 한다.

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

## 20) pair1과 dev 정기 동기화 (역사적 절차)

다음 EKS 로드맵 날짜를 시작하기 전에는 작업 브랜치에서 `origin/pair1`과 `origin/dev`의 기준선과 예상 충돌을 먼저 계산한다. `pair1`에 직접 병합하거나 한쪽 파일을 통째로 선택하지 않는다. 기본 감사 명령은 `bash scripts/audit-pair1-dev-sync.sh`이며, Issue #857의 최초 기준점과 파일별 해결 원칙은 [pair1-dev 동기화 기준점](pair1-dev-sync-857-baseline.md)에 기록한다.

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

로컬 환경 변수는 `backend/.env.example`과 `ai-server/.env.example`을 기준으로 둔다. `AI_PROVIDER_API_KEY`는 `ai-server`에만 두고, FastAPI는 service token과 signed context secret만 사용한다. Query AI, Dashboard Assistant, ETL transform, 리뷰 분석은 같은 Gateway를 사용하며 direct/mock provider fallback은 지원하지 않는다.

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

RAG Data Plane은 은퇴했으므로 production Compose/EKS에서 `opensearch`, `embedding-worker`, `rag-artifact-cleanup`을 기동하지 않는다. 기존 RAG secret과 volume은 새 runtime dependency가 아니며 삭제는 별도 승인과 복구 계획을 요구한다.

Production에서 Trino를 켜기 전에는 TLS/auth/JDBC role, read-only query identity, materializer CTAS/`DESCRIBE`/drop, Warehouse와 Query Result bucket round trip을 아래 readiness로 확인한다.

```bash
cd backend
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:trino-production-readiness
```

Production 배포 템플릿은 `TRINO_ENABLED=true`, `CONTINUOUS_SQL_JOIN_ENABLED=true`, `CONTINUOUS_SQL_SERVING_MODE=iceberg`, `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false`, `CLICKHOUSE_REALTIME_V2_ENABLED=false`, `KAFKA_CONNECT_SINK_ENABLED=false`, `COMPOSE_PROFILES=trino`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER=disabled`, `DASHBOARD_SYNC_MODE=sse`, `REALTIME_EVENTS_ENABLED=true`를 기본값으로 사용한다. 이 모드에서 SQL Continuous JOIN은 Spark/Iceberg를 사용하며 ClickHouse v1/v2 profile을 기동하지 않는다. `scripts/verify-deploy-env.sh`가 flag/profile/backend-service wiring 불일치를 배포 전에 차단한다.

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

### Dashboard Job Binding 제거 순서

Dashboard Widget의 `dataset_id`를 유일한 연결 source로 사용한다. Job binding 제거와 수동 갱신의 경계는 [Dashboard 수동 갱신 전환과 Job Binding 제거 계획](dashboard-manual-refresh-binding-removal-plan.md)을 따른다. 현재 frontend에는 자동 갱신 layer가 없다.

1. Phase 1에서 보기·편집 모드의 진입 및 상단 새로고침을 현재 페이지 `widgets/query`로 통일한다. 자동 갱신, polling, EventSource와 background prefetch는 추가하지 않는다.
2. Phase 2에서 ETL review, SQL 분석 batch/Trino Job wizard, Continuous SQL 생성의 Dashboard 연동 옵션과 자동 Dashboard 생성을 제거한다. Dashboard runtime은 binding을 조회하지 않고 Dataset selector와 Assistant의 managed lock을 제거한다.
3. Phase 2 frontend gate는 `npm run test:dashboard-job-binding-removal`, Dashboard 관련 회귀 테스트와 production build다.
4. Phase 3에서 binding router/schema/service/repository/model, managed Widget `409`, Assistant 제한과 delivery worker 호출을 제거한다. `npm run verify:dashboard-job-binding-removal`로 OpenAPI와 runtime 참조가 다시 생기지 않는지 검증한다.
5. Phase 4 migration `0022_remove_dashboard_job_bindings`가 delivery table, binding table 순서로 제거한다. 기존 row가 있으면 모든 backend/worker replica의 Phase 3 교체와 backup을 확인한 뒤 migration process에만 `ASKLAKE_CONFIRM_DROP_DASHBOARD_JOB_BINDINGS=true`를 설정한다. DB table을 code cutover보다 먼저 삭제하지 않는다.
6. 기존 Dashboard/revision/page/widget ID와 Widget `dataset_id`가 보존되고 수동 새로고침이 성공하는지 확인한다.
7. `npm run verify:dashboard-job-binding-schema-removal`로 fresh upgrade, populated schema 차단, 명시적 upgrade, empty-schema downgrade와 재-upgrade를 검증한다.

### SQL Job 실행 트리 구현 순서

Issue #1117의 목표 계약은 [SQL Job 실행 트리 V1 계약](realtime-2026/contracts/sql-job-execution-tree-v1.md)과 [ADR-003](realtime-2026/adr/003-sql-job-execution-tree-ownership.md)을 따른다. SQL JOIN Job이 실행 트리의 parent/root이고, 선택된 Dataset을 생산하는 기존 Kafka/Batch Job이 child다. 데이터 흐름은 child Job → input Dataset revision → SQL transform → output Dataset revision이며, frontend가 Dataset 이름·tag로 producer를 추정하거나 `childJobId`를 제출하지 않는다.

1. Phase 0에서 현재 direct-consumer 구현을 characterization하고 execution ownership, dependency, lock, revision, manual Dashboard 경계를 문서와 정적 verifier로 고정한다.
2. Phase 1에서 Catalog Dataset의 authoritative producer metadata와 SQL dependency binding을 additive persistence로 도입한다. 완료 기준은 migration upgrade/downgrade, 새 DB session 재조회, Catalog 정규화 column 우선순위와 빈 `dependencyBindings` 호환성이다.
3. Phase 2에서 backend가 Dataset ID와 정규화 Catalog metadata로 정확한 producer를 resolve하고 V1의 realtime 1개 + batch/static N개 조합을 검증한다. frontend 이름/tag 추정은 제거하고 create는 dependency를 Job과 같은 transaction에 저장한다. 완료 기준은 producer 불일치/누락 오류, validate binding, 새 session create 재조회와 UI authoritative 분류 테스트다.
4. Phase 3에서 tree run/node run과 atomic parent-child lock/lease/fencing을 구현한다. 완료 기준은 정렬된 전체 lock set, active standalone 충돌, 부분 lock rollback, 만료 takeover generation, fencing hash 응답, ETL command/update/delete 차단과 migration downgrade다.
5. Phase 4 안전 보정은 parent worker start 실패 시 이번 tree run에서 시작한 realtime child만 보상 stop한 뒤 tree/node/lock을 terminal failure로 끝낸다. legacy direct-Kafka Job에는 이 보정 경로를 유지한다.
6. Revision runner는 tree run의 input Dataset revision, parent Run의 static snapshot, output target과 private fence를 typed request로 직렬화한다. revision commit에는 exact Iceberg `snapshotId`를 저장하고 pinning은 snapshot이 있는 input만 tree/node에 고정한다. runner는 Kafka broker/topic/consumer group/offset/trigger 없이 `FOR VERSION AS OF` transform과 verified output publication을 수행한다. 첫 snapshot 전에는 `starting`으로 남아 sync loop가 재시도한다.
7. Phase 4에서 SQL parent start/recover가 lock commit 뒤 실행 가능한 batch child `run`, realtime child `startContinuous`를 먼저 요청하고 node Run/session identity를 저장한다. child failure는 parent worker 시작 전 tree failure로 처리한다. Dataset revision 대기와 transform은 Phase 5 범위다.
8. Phase 5에서 SQL-owned Kafka consumer group, broker/topic/offset, trigger/max-message 고급 설정을 제거하고 producer revision/manifest cursor 기반 transform으로 전환한다.
9. Phase 6에서 stop/restart/recovery와 parent-owned child command 차단을 완성한다. parent pause/stop/resume은 active tree의 realtime child에만 각각 `pauseContinuous`/`stopContinuous`/`resumeContinuous`를 전파하며, batch child를 다시 실행하거나 tree 밖 standalone Job을 제어하지 않는다. child lifecycle control 실패는 node에 durable `failed` evidence로 남기되, 이미 수락된 parent stop을 되돌려 "실행 중"으로 만들지 않는다.
10. Phase 7에서 SQL 분석 UI를 backend producer metadata와 tree status만 표시하도록 바꾼다. Continuous SQL dialog는 streaming producer Dataset, static Dataset, output engine과 생성 후 `activeTreeRun.nodes`를 읽기 전용으로 표시한다. SQL-owned Kafka trigger/offset 설정 UI는 노출하지 않으며 수집 크기·주기는 producer Job 설정을 따른다.
11. Phase 8에서 output Dataset revision과 Dashboard 수동 새로고침 회귀를 검증한다. Dashboard가 upstream Job을 실행하거나 revision watcher를 시작하지 않는다. Continuous control worker도 Dashboard precompute를 수행하지 않으며, 최초 pending Widget 계산과 사용자가 누른 새로고침만 `/widgets/query`를 호출한다.
12. Phase 9에서 legacy direct-consumer Continuous SQL Job의 명시적 운영 처리와 live E2E/rollout gate를 완료한다. 기존 Job은 자동 마이그레이션하지 않는다.

Phase 0 정적 계약 검증은 다음 명령으로 실행한다.

```bash
cd backend
npm run verify:continuous-sql-execution-tree-contract
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python python -m unittest tests.test_sql_execution_tree_persistence -v
```

Phase 2까지 확인할 때는 producer resolution/create durability와 frontend 분류를 추가로 실행한다.

```bash
cd backend
PYTHONPATH=. ${ASKLAKE_FASTAPI_PYTHON:-.venv/bin/python} -m unittest \
  tests.test_continuous_sql_dependency_resolution \
  tests.test_continuous_sql_catalog \
  tests.test_continuous_sql_planner \
  tests.test_sql_execution_tree_persistence -v

cd ../frontend
npm run test:continuous-sql-ui
npm run build
```

Phase 3 lock 검증은 다음을 추가한다. SQLite 선택-table fixture는 lock table이 없는 경우에만 legacy test compatibility로 우회하며 배포 PostgreSQL은 Alembic `0024_sql_execution_tree_locking`이 필수다.

```bash
cd backend
PYTHONPATH=. ${ASKLAKE_FASTAPI_PYTHON:-.venv/bin/python} -m unittest \
  tests.test_sql_execution_tree_locking \
  tests.test_etl_job_commands \
  tests.test_etl_job_delete \
  tests.test_etl_job_write_commands \
  tests.test_continuous_sql_runtime_contract -v
```

Phase 4는 같은 `tests.test_sql_execution_tree_locking`에서 batch → realtime child dispatch 순서, matching fence internal command context, child failure 시 parent worker 미시작과 tree lock 해제를 검증한다. Phase 5 전에는 legacy SQL direct-consumer transform이 유지된다.

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

### File / S3 Prefix Preview 검증

Prefix Preview는 모든 데이터 파일의 schema 호환성 검사를 유지하되 대표 파일을 먼저 처리하고 나머지 파일을 bounded worker pool로 병렬 처리한다. 파일별 샘플은 64KiB에서 시작해 완전한 레코드가 부족할 때만 비중복 Range로 확장한다. 로컬 튜닝은 `ASKLAKE_PREFIX_VALIDATION_CONCURRENCY`(기본 8, 1~32)와 `ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES`(기본 65,536)로 하며 기존 scope별 최대 샘플 byte가 최종 상한이다.

코드 변경 뒤에는 외부 MinIO 없이 다음 회귀를 먼저 실행한다.

```bash
cd backend
npm run verify:prefix-source
```

이 명령은 worker 동시성·입력 순서, CSV/JSONL의 완전한 레코드 처리, UTF-8 경계, EOF와 최대 byte, 대표 파일 및 schema 불일치 계약을 검증한다. 실제 저장소와 Spark까지의 경로는 아래 `npm run verify:prefix-spark-e2e`로 별도 확인한다.

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

Issue #1050의 발표용 데이터는 S3 과거 30일 synthetic v3 기준선과 Kafka 격리 5분 realtime profile v1을 분리한다. 카테고리 high/mid/low 구매 의향, 날짜별 독립 퍼널 변화, 기준선 대비 상승·유사·하락과 결정적 run identity가 생성기·분석기·고정 fixture에 구현되어 있다. 전체 계약, 고정 결과와 one-shot replay 명령은 `backend/scripts/synthetic-commerce/README.md`의 `Issue #1050 데모 데이터`를 따른다. 실제 sliding 5분 Dashboard 집계는 포함하지 않으므로 화면에는 `최근 5분 데모 run`으로 표시한다.

```bash
cd backend
npm run verify:synthetic-commerce

python3 scripts/synthetic-commerce/generate_realtime.py \
  --baseline-dir fixtures/synthetic-commerce/commerce-fixed-3000-v3-seed-20260711 \
  --validate-dir fixtures/synthetic-commerce/commerce-realtime-5m-v1-seed-20260711
```

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
npm run test:dashboard-widget-data-state
npm run build

cd ..
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet
```

STACK-02 focused validation:

Dashboard 회귀 검증은 보기·편집 모드 진입과 상단 수동 새로고침이 현재 페이지 Widget만 조회하는지 확인한다. `DASHBOARD_AUTO_REFRESH_ENABLED`, `REALTIME_EVENTS_ENABLED`, `DASHBOARD_SYNC_MODE` 값과 관계없이 frontend에 자동 갱신 토글, EventSource, polling 또는 background prefetch가 생기지 않아야 한다.

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest tests.test_realtime_events tests.test_realtime_feature_flags tests.test_dashboard_live_repository
.\.venv\Scripts\python.exe scripts\verify-realtime-proxy-contract.py
.\.venv\Scripts\python.exe -m compileall -q app tests

cd ..\frontend
npm run test:realtime-events
npm run test:dashboard-widget-data-state
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

`verify:continuous-sql-contract`에는 일반 Trino SQL Job의 revision 직렬화 회귀가 포함된다. 같은 source revision의 terminal-but-unfinalized payload가 남은 상태에서 sync를 두 번 호출해도 submit은 한 번뿐이어야 한다. CTAS client 호출 시점에는 다른 DB session에서도 pending reservation이 보여야 하고, 제출 결과가 불명확하면 claim과 unfinalized reservation이 모두 남아야 한다. 자동 claim 중 수동 실행과 수동 Run finalization 중 자동 실행도 거절해야 한다. matching finalization은 Catalog payload, Run `finalized` marker와 claim 해제를 단일 commit으로 저장해야 하며, 이전 claim의 늦은 완료는 새 Job 상태나 Catalog mapping을 바꾸지 않아야 한다.

STACK-04 PR smoke:

```powershell
cd backend
npm run verify:realtime-stack

cd ..\frontend
npm run test:realtime-events
npm run test:dashboard-widget-data-state
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

현재 legacy Continuous SQL latency tuning은 API에서 trigger를 생략하면 10초를 사용하고 SQL 분석 frontend가 5초를 명시적으로 제출하며, `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS`를 함께 사용한다. Issue #1117 목표 구조에서는 SQL Job이 trigger/max-message를 소유하지 않고 연결된 producer Job의 수집 설정과 Dataset revision을 따른다. 전환 전 cache 한도는 executor memory/disk와 Catalog 통계 신뢰도를 확인하며 조정하고, memory pressure가 있거나 통계가 불안정하면 0으로 cache를 끈다. 새 output table은 `_asklake_run_id`를 partition column으로 생성하지만 기존 table은 자동 변경하지 않는다. 성능 변경 검증은 아래 계약 suite와 Compose render를 포함하고, 실제 지연 수치는 Kafka/MinIO/Spark/Iceberg/Trino 통합 환경에서 별도로 측정한다.

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

서비스 전역 글자 굵기는 마지막 import인 `styles/typography.css`가 소유한다. 본문·설명·메타데이터는 400, 탐색·필드 label·표 header·보조 조작은 500, 선택 상태·상태 badge·주요 action·section title은 600, page title과 핵심 metric 값만 700을 사용한다. 강조가 필요한 공용 컴포넌트는 임의의 800 이상 weight 대신 `data-slot` 의미를 추가하며, 변경 후 `npm run test:typography-hierarchy`로 import 순서와 강조 경계를 확인한다.

```bash
cd frontend
npm run test:css-catalog-boundary
npm run test:semantic-layer-ui
npm run test:typography-hierarchy
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

실제 병합 직전에 `git fetch origin --prune`을 다시 수행한다. 기록된 SHA가 바뀌면 기준점을 갱신하고, 전용 브랜치에서 `origin/dev`를 병합한 뒤 Backend·Frontend·EKS 정적 검증과 SSOT 대조를 통과시켜 `dev` 대상 PR로 전달한다. 아직 `dev`에 머지되지 않은 열린 PR은 암묵적으로 선반영하지 않는다.
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

API/schema 변경은 `docs/03-api-reference.md` 또는 아키텍처 문서를, CI/deploy 변경은 이 문서 또는 `docs/system-guardrails.md`를 같은 PR에서 갱신해야 한다. baseline을 다시 생성해 실패를 덮지 말고 개선된 값은 별도 PR에서 낮춘다. `dev`, `main`, 기존 `pair1` 대상 PR은 같은 구조 ratchet을 실행한다. 여기서 `pair1`은 기존 branch의 품질 gate coverage이며 배포 source 허용을 뜻하지 않는다. 느린 production Spark·Continuous 검증은 `Refactor Quality Gates` workflow dispatch의 `release_suite=true`로 실행한다.

브랜치 통합으로 기존 구조 부채가 dev baseline에 새로 유입되는 경우에도 baseline 재생성으로 통과시키지 않는다. 즉시 분할하기에 실행 위험이 큰 항목은 `quality-gate-baseline.json`의 예외에 정확한 path/function, 현재 줄 수 상한, owner, reason, expiresAt을 기록한다. 상한 증가와 만료는 다시 실패하며 wildcard나 파일군 단위 면제는 허용하지 않는다. 2026-07-18 pair1·dev 통합의 입력과 판정은 [통합 기록](pair1-dev-integration-2026-07-18.md)을 따른다. Issue #1139의 2026-07-22 `dev`/`pair1` 배포 소스 통합은 `origin/dev`에서 그대로 상속되거나 줄어든 target과 결합 트리에서만 커진 target을 분리해 확인하고, 필요한 정확한 현재 줄 수만 2026-08-31 만료 예외로 이동했다. `origin/pair1`의 기존 예외는 그대로 유지하며 전체 baseline 재수집이나 wildcard 예외는 사용하지 않았다.

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

Kafka Continuous terminal 전이 또는 목록·상세 상태 projection을 변경하면 빠른 프로필 전에 아래 unit/프론트 계약을 실행한다. `stopping + unknown + stale report`, 동일 fence stop 재요청, `not_running` terminal commit, 중복 stop idempotency와 `중지 중` UI를 함께 보호한다.

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_continuous_application_use_cases tests.test_continuous_runtime_contract tests.test_continuous_maintenance_fencing tests.test_kafka_continuous_dashboard_sync -v

cd ../frontend
npm run test:continuous-runtime-contract
npm run build
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

## 신규 Kafka Job engine routing 검증 (#1073)

```bash
bash scripts/verify-eks-realtime-v1-only-profile.sh

cd backend
npm run verify:eks-realtime-v1-only-profile

cd ../frontend
npm run test:realtime-v1-only-profile
npm run build
```

이 프로파일의 realtime worker는 `CONTINUOUS_WORKER_SCOPE=all`로 Kafka Continuous와
Continuous SQL reconciliation을 한 process가 소유한다. workload 활성화에는 이전 owner
fence, 명시적 승인, 새 generation이 모두 필요하다. 배포 뒤에는 worker 1개, 같은
identity의 active claim 1개, SparkApplication checkpoint 재개, Iceberg snapshot과 Catalog
publication을 함께 확인한다. Backend 검증은 V2-era Catalog payload의 retired
`serving/clickhouse` binding을 read path에서 격리하고 유효한 `archive/trino` binding을
보존하는 호환성 회귀도 함께 실행한다.

## EKS 로그인 DB lock 회귀 검증

Job 상세 화면은 `(flow, jobId)` 변경에만 상세 API를 호출해야 한다. Job 응답으로 상태
객체가 교체되어도 상세 요청이 반복되면 안 되며 route 이탈 시 요청을 abort한다.

```bash
cd frontend
npm run test:jobs-data-boundary
npm run build

cd ../backend
.venv/bin/python -m unittest \
  tests.test_metadata_schema_bootstrap \
  tests.test_database_session_lifecycle

cd ..
bash scripts/verify-eks-web-workloads.sh
```

EKS Web upgrade는 `asklake-backend-migration` Helm hook이 먼저 완료된 뒤 FastAPI와
collector를 rollout한다. 두 장기 실행 workload의
`STARTUP_SCHEMA_MANAGEMENT_ENABLED`는 반드시 `false`여야 한다. migration Job 실패나
lock timeout은 기존 workload를 유지한 채 upgrade를 실패시켜야 하며, 이를 우회하려고
API Pod에서 schema DDL을 다시 켜지 않는다. 배포 후 로그인 성공/실패 응답, FastAPI
rollout/ALB health와 함께 `pg_stat_activity`의 idle-in-transaction 및 relation-lock wait가
0인지 확인한다.
