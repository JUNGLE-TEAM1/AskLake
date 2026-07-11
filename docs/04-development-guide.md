# 04. Development Guide

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
Dashboard runtime widget contract는 `metric`, `table`, ApexCharts 차트 8종을 기준으로 둔다. 색상은 문자열이나 팔레트 이름이 아니라 차트 config의 `color: { colors: string[] }` 배열을 사용한다. `metric`과 `table`에는 색상 config를 보내지 않으며, 향후 AI widget 생성 기능도 같은 type/config 계약을 사용한다.
SQL 결과 차트 빌더도 별도 renderer를 만들지 않고 Dashboard runtime `WidgetRenderer`와 `DashboardDatasetOption` adapter를 재사용한다. SQL 화면에서는 막대·선·영역·도넛과 X/분류, Y/값, 집계 설정만 노출하고 Dashboard 저장 상태는 만들지 않는다.
Dashboard table widget은 chart renderer 전환 범위에 포함하지 않으며, 후속 작업에서 TanStack Table 기반으로 별도 전환한다.

## 2) 빌드

```bash
cd frontend
npm run verify:ui-regressions
npm run build
```

현재 package script는 TypeScript build와 Vite build를 함께 실행한다.
`npm run verify:ui-regressions`는 SQL 분석의 Nessie SQL 작성 모달, 왼쪽 차트 설정, 오른쪽 차트/데이터 전환, SQL 내부 Job wizard, Preview `limit` 전달, Catalog -> SQL wide button, Dashboard 목록의 `Alert`/`Skeleton`/`Empty`, edit의 radial range `Slider`와 Kibo dataset Tree, ApexCharts CSS 텍스트 누수 방지처럼 최근 UI 회귀가 있었던 핵심 UI 계약을 정적으로 확인한다.

## 3) Backend Live Mode

프론트는 기본적으로 live backend API를 호출한다. local backend는 Postgres metadata DB를 필요로 하므로 먼저 `docker-compose.yml`의 Postgres를 올린다.
프론트 dev server는 같은 출처의 `/api` 요청을 FastAPI `http://127.0.0.1:8080`으로 proxy한다.

```bash
docker compose up -d postgres

cd backend
npm install
npm run dev
```

`frontend/.env` 또는 로컬 env에는 API base URL만 둔다.

```bash
VITE_API_BASE_URL=http://localhost:8080
```

Backend `DATABASE_URL`은 미설정 시 `postgres://asklake:asklake_dev@127.0.0.1:54328/asklake`를 사용한다. `npm run verify`와 `npm run verify:spark-run`은 검증 시작 시 metadata를 초기화하지만, 일반 `npm run dev`는 생성한 Job과 Dataset을 Postgres에 유지한다.

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
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ENDPOINT_IN_DOCKER=http://m3-minio:9000
MINIO_ACCESS_KEY=m3admin
MINIO_SECRET_KEY=wishuponastar
MINIO_BUCKET=asklake-output
```

Local Compose의 Airflow task에는 backend URL과 `AIRFLOW_EXECUTION_API_TOKEN` 기반 bearer token이 주입된다. `AIRFLOW_INTERNAL_TOKEN`은 기존 단일 호출 endpoint 호환용으로 함께 유지한다. 그 다음 `수집/처리` 화면에서 Job 실행 버튼을 누르면 `spark_process_write`가 실제 Spark runner를 호출하고, `publish_run_result`가 물리 Parquet를 검증해 Catalog를 확정한다. Run History와 DAG modal은 `GET /api/etl/jobs/{jobId}` polling으로 DAG Run/Task Instance 상태를 반영한다.

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

현재 `asklake_etl_job`은 `receive_asklake_run -> validate_spark_request -> spark_process_write -> publish_run_result`로 실행된다. 실제 source read/transform/quality/Parquet write는 PySpark가 담당한다. 실제 Spark mode의 `publish_run_result`는 저장된 성공 manifest를 `POST /api/internal/airflow/spark-runs/{runId}/catalog`로 멱등 반영하고, 그 commit 뒤에만 DAG Run을 성공시킨다. 독립 Airflow runtime 확인용 `executionMode=smoke`는 실제 Job/Run/Parquet가 없으므로 Catalog 호출을 건너뛴다.

Live frontend는 같은 Run id를 `queued` 또는 `running`으로 관찰한 뒤 `success`가 된 경우에만 `GET /api/catalog/datasets`를 한 번 다시 호출한다. 실행 버튼 직후의 optimistic 상태에서 서버의 이전 성공 Run을 읽더라도 조기 refresh하지 않는다. Catalog 재조회만 실패한 경우에는 이미 확정된 Job/Run 성공을 되돌리지 않고 기존 목록과 수동 새로고침 안내를 유지한다. 정적 연결과 production build는 `cd frontend && npm run verify:ui-regressions && npm run build`로 확인한다.

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

Job 목록의 query/facet/legacy 상태 정규화는 외부 인프라 없이 `cd backend && npm run verify:job-list`로 먼저 확인한다. 전체 `npm run verify`는 PostgreSQL, MinIO, REST fixture를 포함한다.

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
python3 scripts/verify-etl-job-hydrate-contract.py
```

브라우저에서는 생성된 Kafka Job의 `수정`을 열어 broker, topic, consumer group 값이 저장된 값으로 표시되고 편집할 수 없는지 확인한다. 목록에서 다른 Job의 `수정`을 직접 선택한 경우에도 해당 Job이 상세 기준으로 선택되고, 성공 Run 유무에 맞춰 target identity 잠금이 적용돼야 한다. Review 단계의 `변경사항 저장`은 기존 Job을 update하며 새 Job을 만들지 않아야 한다.

수정 저장은 같은 Job ID에 반영되는지 확인한다. target identity를 바꾸지 않은 상태에서 transform, schedule 또는 permission을 수정하고 `변경사항 저장`을 누른 뒤 작업 상세로 돌아가 Job ID와 Kafka source 값이 유지되는지 확인한다. 실행 중인 Job과 성공 Run이 있는 Job의 target identity 변경은 각각 오류로 차단돼야 한다.

성공 Run이 있는 Job을 수정할 때는 Target 화면의 데이터셋명, DB, 포맷, 저장 경로가 읽기 전용으로 보이는지 확인한다. 설명, 태그, 파티션은 수정할 수 있어야 하며 Source 단계의 `이전`은 변경을 버리고 작업 상세로 돌아가야 한다.

```bash
cd backend
.venv/bin/python scripts/verify-etl-job-update-contract.py
```

이 검증은 source field 요청 거부, source config 보존, 성공 Run 이후 target identity 변경 차단, 실행 중 update 차단을 함께 확인한다.
MongoDB Source connector는 Node MongoDB driver로 컬렉션 목록과 제한 문서 샘플을 조회한다. backend live mode 환경에는 `backend/package.json`의 `mongodb` dependency가 설치되어 있어야 하며, MongoDB Shell(`mongosh`)은 connector 실행 조건이 아니다.
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

Kafka Continuous Ingestion은 Issue #500 Phase 3에서 long-running Spark Structured Streaming worker까지 연결됐다. Snapshot Job은 wizard의 스케줄 단계에서 수동/반복 실행을 고르고, Continuous Job은 해당 단계를 건너뛰어 생성 후 스트림 시작/중지로 제어한다. Continuous Source 고급 설정은 시작 위치, trigger 간격, micro-batch 최대 메시지를 제공한다. production-like smoke에서는 continuous Job 시작, retained backlog 처리, 새 이벤트 자동 append, pause/resume API 호환, checkpoint restart, lag/heartbeat, conflicting consumer identity `409`을 검증한다. Snapshot smoke는 계속 유지하며 Continuous 검증으로 대체하지 않는다.

계약 검증은 Spark worker를 시작하지 않으며, Continuous Job의 기본 config/runtime identity, start request 상태, 중복 start `409`을 확인한다. Worker 실동작은 Docker, Redpanda, MinIO가 모두 떠 있는 production-like smoke에서 별도로 확인한다.

```bash
cd backend
.venv/bin/python scripts/verify-kafka-continuous-contract.py
```

Phase 2부터 prod-like Compose는 내부 broker `redpanda:9092`를 제공한다. 이 broker는 Snapshot fixture와 이후 Continuous Spark worker가 같은 Docker network에서 사용할 endpoint이며, 외부 Kafka endpoint를 쓰려면 배포 env에서 `ASKLAKE_KAFKA_BROKER`를 바꾼다.

Continuous worker는 Spark 4.0.1/Scala 2.13 Kafka connector를 사용한다. `ASKLAKE_SPARK_KAFKA_PACKAGE=org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1`과 `ASKLAKE_SPARK_HADOOP_AWS_PACKAGE`을 함께 설정하고, backend Docker socket 및 `ASKLAKE_SPARK_REPORT_DIR` 공유 mount를 유지해야 한다.

Production-like Continuous E2E는 Compose를 먼저 올린 뒤 opt-in으로 실행한다. retained backlog, malformed JSON quarantine, 신규 이벤트, pause/resume, worker kill 후 checkpoint restart, UI polling 없이 Catalog materialization, duplicate-free counter를 검증한다. worker 시작 시 target `s3a://` bucket은 MinIO에 없으면 자동 생성된다. 사용자 요청으로 인한 pause/stop의 SIGTERM 종료는 각각 `paused`/`stopped`로 처리하고, 요청 없이 종료된 worker만 `failed`가 된다.

Backend는 `CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS`(기본 5초)마다 active Continuous worker report를 동기화한다. 이 control-plane sync가 Catalog materialization을 수행하므로 Job 목록/상세 조회가 없어도 적재 batch가 Catalog에 등록된다. Worker는 target의 `_batch-manifests/batch_id=*`에 valid/quarantine count를 함께 기록하고, 재시작 때 이 manifest를 읽어 runtime counter를 복구한다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_E2E=true \
ASKLAKE_CONTINUOUS_E2E_BASE_URL=http://127.0.0.1:8080 \
ASKLAKE_CONTINUOUS_ENV_FILE=../deploy/.env \
ASKLAKE_CONTINUOUS_COMPOSE_FILE=../deploy/docker-compose.prod.yml \
npm run verify:kafka-continuous-e2e
```

설정 가능한 장시간 harness는 기본 1,000건 synthetic smoke로 시작한다. `ASKLAKE_CONTINUOUS_SOAK_INPUT`에 `.jsonl` 또는 `.jsonl.gz`를 주면 파일을 메모리에 모두 올리지 않고 line 단위로 Kafka에 replay한다. `ASKLAKE_CONTINUOUS_SOAK_COUNT`, `ASKLAKE_CONTINUOUS_SOAK_RATE`, `ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE`, `ASKLAKE_CONTINUOUS_SOAK_MALFORMED_PERCENT`, `ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE_AT`, `ASKLAKE_CONTINUOUS_SOAK_COMPACT`로 범위와 maintenance 검증을 조절한다. `ASKLAKE_CONTINUOUS_SOAK_FAULT=worker|backend|kafka|minio`는 한 번의 장애를 주입하며 `FAULT_AFTER`, `FAULT_DURATION_MS`로 시점과 지속 시간을 정한다. 기존 `ASKLAKE_CONTINUOUS_SOAK_KILL_WORKER=true`도 `worker` alias로 유지한다. 6.47GB 전체 replay와 compaction은 CI가 아니라 수동 soak로 실행한다.

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

Job 상세의 Continuous Runtime은 partition lag, 처리량, schema drift, bounded/redacted worker log를 표시한다. Quarantine inspection/replay와 compaction은 worker를 일시정지하거나 중지한 상태에서 실행한다. Replay는 Lake의 격리 Parquet를 읽어 `partition:offset` anti-join 후 정상 target과 Catalog materialization에 기록한다. Compaction은 `_compactions/run_id=*`에 staged output을 만들며 V1에서는 원본 batch를 삭제하거나 active Catalog path를 교체하지 않는다.

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

로컬 환경 변수는 `backend/.env.example`을 기준으로 둔다. 실제 OpenAI 키는 git에 올리지 않는 `backend/.env.local`의 `OPENAI_API_KEY`에 둔다. Query AI live mode는 backend가 이 값을 읽어 `POST /api/query/ai-suggestions`에서만 사용하며, frontend env에는 OpenAI 키를 두지 않는다.

SQL UI를 변경할 때는 desktop에서 좌측 SQL 도구와 우측 editor/result workspace의 하단이 SQL 실행 전후 모두 일치하는지 확인한다. Catalog 미리보기의 `SQL 분석에서 열기`가 선택 Dataset을 유지한 채 `/sql`로 이동하는지 확인하고, editor 상단 Nessie 모달에서 자연어 요청 → 초안 생성 → 편집기 적용이 동작하되 자동 실행되지 않는지 확인한다. SQL 실행 후에는 왼쪽 차트 설정의 소스·유형·축·집계 변경과 오른쪽 `차트 보기`/`데이터 미리보기` 전환, 상단 CSV/Job/전체 보기 액션, 처리 Job 모달의 기본 정보 → 스케줄 → 거버넌스 → 저장 및 검토 흐름이 `/etl/review` 이동 없이 동작하는지 확인한다.
FastAPI 폴더 구조와 설계 결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

## 4) Prod-Like Docker Compose

AWS 배포 전에는 로컬에서 prod-like compose 구성이 유효한지 먼저 확인한다.
실제 secret은 `deploy/.env`에만 두고, repo에는 `deploy/.env.example`만 커밋한다.

```bash
docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config
```

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
- `dev` -> `main`

`main`으로 직접 여는 feature PR이나, `dev`로 직접 여는 임의 작업 브랜치 PR은 branch policy check에서 실패한다.

권장 브랜치 타입:

- `feature/<name>`
- `fix/<name>`
- `docs/<name>`
- `test/<name>`
- `chore/<name>`

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
- SQL Result를 처리 Job으로 저장할 때 Review draft에 `sourceRunId`, `query`, `referenceDatasetIds`, target dataset metadata가 유지되는가?
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
- SQL 실행 결과에서 차트 보기와 데이터 미리보기를 전환하고 CSV 다운로드 또는 처리 Job 생성을 실행할 수 있다.
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
