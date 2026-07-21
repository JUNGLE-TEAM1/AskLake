# Continuous SQL V1 계약

## 실행 범위

Continuous SQL은 기존 일회성 SQL API와 별개의 장기 실행 Job이다. SQL AST를 생성 전에 컴파일하고 다음 범위만 허용한다.

- streaming Catalog relation 정확히 1개를 논리적 왼쪽 입력으로 사용한다.
- queryable Iceberg static relation 1개 이상을 `INNER` 또는 `LEFT` equality JOIN한다.
- deterministic scalar projection과 단순 passthrough CTE를 허용한다.
- aggregate, window, subquery, DISTINCT, ORDER BY/LIMIT, RIGHT/FULL/CROSS, stream-stream JOIN과 nondeterministic function은 구조화된 validation error로 거절한다.
- static JOIN key는 `uniqueKeySets`, `uniqueKeyColumns` 또는 `indexColumnsUnique=true`인 index metadata로 유일성이 증명돼야 한다. 단순 `indexColumns`는 유일키 증거가 아니다. 실행 시에도 실제 snapshot에서 중복을 다시 검사한다.

Catalog relation은 `relationMode=streaming|static`, Iceberg `queryEngineTable`, schema와 snapshot identity를 사용한다. 기존 Kafka Continuous Dataset은 연결된 ETL Job으로 streaming mode를 호환 추론할 수 있으나 새 publication은 relationMode를 명시한다.

## plan과 static binding

동일 SQL과 동일 Catalog metadata는 같은 `continuous-sql-v1` plan hash를 만든다. persisted plan에는 normalized/runtime SQL, relation·schema·referenced column, Kafka source identity, JOIN key, output schema, trigger, binding policy와 안전 한도를 기록한다.

- `PINNED_AT_START`: Run 시작 때 static snapshot set을 고정한다. restart/retry는 같은 set을 사용한다.
- `LATEST_PER_BATCH`: `LATEST_STATIC_PER_BATCH_ENABLED=true`일 때만 허용한다. batch 시작 때 최신 snapshot set을 고정하고 같은 batch retry는 durable binding manifest를 재사용한다.
- `STATIC_CHANGE_BACKFILL_ENABLED`은 V1 live 실행을 backfill로 바꾸지 않는다. bounded historical rewrite/upsert API는 STACK-03 범위 밖이며 요청 경로도 열지 않는다.

Catalog row 통계가 있고 `estimatedRowCount <= CONTINUOUS_SQL_STATIC_BROADCAST_MAX_ROWS`인 static relation만 broadcast hint를 받는다. 통계가 없거나 큰 relation은 broadcast하지 않는다. 한 micro-batch의 output이 input의 `CONTINUOUS_SQL_MAX_OUTPUT_ROWS_PER_INPUT` 배수를 넘으면 commit 전에 실패한다.

## low-latency 실행 계약

- 새 validate/create request에서 `triggerIntervalSeconds`를 생략하면 10초다. 허용 범위는 1~3,600초이고 기존 persisted Job은 저장된 값을 유지한다. `baselineDatasetId=output.datasetId`는 최초 Trino JOIN snapshot과 Kafka cursor를 고정하며 이후에는 최대 100행 source range만 처리한다.
- `estimatedRowCount <= CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS`인 static relation은 plan에 `cacheHint=true`를 기록한다. worker는 exact `(datasetId, snapshotId, schemaFingerprint)` identity의 frame을 memory/disk에 재사용하고, 같은 snapshot·JOIN key의 유일성 scan을 한 번만 수행한다.
- snapshot이 바뀌면 이전 frame을 unpersist하고 유일성을 다시 검증한다. 통계가 없거나 한도를 넘는 relation은 frame을 cache하지 않고, 한도 0은 cache 비활성이다.
- 새 Continuous SQL Iceberg output table은 `_asklake_run_id` identity partition을 갖는다. exact publication count와 Dashboard revision delta query는 해당 batch partition을 가지치기할 수 있다. 사용자 projection에는 marker를 노출하지 않는다.
- 기존 output table은 partition spec을 자동 변경하지 않는다. 가지치기 이득은 없을 수 있지만 exact `_asklake_run_id` 행 수 검증은 동일하게 수행한다.

## lifecycle과 fencing

Job은 desired state와 observed state를 분리하고 `start`, `pause`, `resume`, `stop`, `recover` command를 지원한다. `clientRequestId`와 `commandId`는 owner/Job 범위 idempotency key다. 새 Run은 monotonic generation과 비공개 fencing token을 가지며 API에는 token hash만 반환한다.

worker report와 publication은 plan hash, generation, fencing token hash가 모두 현재 Run과 일치할 때만 수용한다. backend 재시작 후 DB desired state와 worker status/report를 reconcile한다. browser 연결은 worker lifecycle에 영향을 주지 않는다.

create validation뿐 아니라 start/resume/recover command에서도 모든 입력 Dataset의 현재 query permission과 governance policy를 다시 검사한다. 권한이 회수되면 새 worker action을 보내지 않는다.

## batch와 publication

batch identity는 `(jobId, runGeneration, batchId)`이고 source topic/partition `[startOffset,endOffset)`, static snapshot set, deterministic publication Run ID, plan/fence identity를 manifest에 남긴다. 같은 batch 재시도는 기존 static binding 및 Iceberg source boundary를 재사용하며 다른 lineage로 identity를 덮어쓰지 않는다.

publication은 다음 단계를 전진만 한다.

1. `output_committed`: exact Iceberg snapshot과 manifest evidence를 저장한다.
2. `catalog_ready`: snapshot에서 `_asklake_run_id` 행 수와 queryability를 Trino로 exact 검증한다. cache나 partition 통계만으로 이 gate를 대체하지 않는다.
3. `dashboard_ready`: Catalog Dataset revision과 durable realtime event를 같은 transaction에 기록한다.

Catalog 또는 Dashboard publication 실패는 Spark input을 다시 처리하게 만들지 않는다. reconciler가 `output_committed` 또는 `catalog_ready`부터 재시도한다. 빈 결과 batch는 잘못된 Dataset revision/event를 만들지 않는다.

## 호환성과 rollback

`CONTINUOUS_SQL_JOIN_ENABLED=false`이면 validate/create/start/resume/recover를 fail closed하고 기존 Kafka Continuous 적재, 일회성 SQL/Trino, Dashboard polling은 그대로 유지한다. additive table은 rollback 시 남겨도 구버전 코드 경로를 방해하지 않는다.

로컬 계약 검증은 `cd backend && npm run verify:continuous-sql-contract`다. 실제 Kafka/MinIO/Spark/Iceberg/Trino fault·restart 검증과 CI rollout gate는 STACK-04에서 수행한다.
