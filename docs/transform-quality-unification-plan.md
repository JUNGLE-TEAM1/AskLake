# Transform/Quality 공통 실행 통합 계획

## 1. 목적

Issue #567은 일반 Snapshot, Kafka Snapshot, Kafka Continuous에서 분산된 스키마 추론과 Transform/Quality 실행 의미를 하나의 계약으로 정리한다.

이 작업은 하나의 기능 브랜치와 Draft PR에서 진행하되, Phase별 독립 커밋과 검증 게이트를 유지한다. Continuous 규칙은 Snapshot conformance와 전용 Spark 검증을 통과한 operation만 단계적으로 활성화한다.

## 2. 현재 기준

현재 처리 경로는 다음과 같이 나뉜다.

| 실행 경로 | 입력 경계 | Transform/Quality 실행 | 진행 상태 |
| --- | --- | --- | --- |
| 일반 Snapshot | Run 단위 source read | `backend/scripts/spark_job_run.py` | 지원 |
| Kafka Snapshot | 고정 partition offset 범위 | `backend/scripts/ingest-kafka-reviews.mjs` | 지원 |
| Kafka Continuous | Spark checkpoint와 micro-batch | `backend/scripts/kafka_continuous_stream.py` | streaming-safe canonical Rule 지원 |

같은 이름의 규칙이라도 실행 언어와 구현이 달라 null, cast, 오류 분기, 출력 타입이 어긋날 수 있다. Frontend Preview 역시 별도 변환 모델을 사용하므로 실제 Spark 결과와의 동등성을 별도로 증명해야 한다.

## 3. 불변 조건

- Transform/Quality 규칙은 선택 사항이며, 규칙이 없는 Job은 pass-through로 실행된다.
- Target layer는 Transform/Quality 적용 여부와 독립된 사용자 설정이다.
- Kafka Snapshot의 offset capture와 성공 후 commit 책임은 Kafka 전용 경로에 유지한다.
- Kafka Continuous 재시작은 기존 checkpoint에서 중복이나 누락 없이 이어진다.
- 기존 Job payload와 편집 hydrate는 migration 없이 호환돼야 한다.
- 지원하지 않는 규칙은 저장 후 무시하지 않고 생성 또는 실행 전에 명확히 거절한다.
- Catalog 등록은 물리 적재와 완료 근거가 확인된 뒤에만 수행한다.

## 4. Canonical Rule 계약

공통 Rule은 최소한 다음 정보를 가진다.

```text
id
kind
operation
input columns
output columns
parameters
output type
enabled
onError
contract version
```

오류 정책의 canonical 값은 다음과 같다.

- `Fail Batch`: 해당 입력 경계를 실패시키고 target publication과 offset/checkpoint 전진을 막는다.
- `Quarantine`: 실패 행과 source identity를 별도 저장하고 정상 행만 target에 게시한다.
- `Warn`: 계약상 허용된 fallback을 적용하고 경고 근거와 건수를 남긴다.

초기 streaming-safe 후보는 projection, rename, cast, default, null guard, row filter, 문자열 정규화다. join, 전체 집계, stream-stream stateful 연산과 의미가 제한되지 않은 임의 SQL은 초기 Continuous 지원 범위에서 제외한다.

## 5. 타입 계약

- JSON string은 숫자 형태여도 `String`으로 유지한다.
- JSON integer는 `Long`, 실수형 number는 `Double`을 canonical 타입으로 사용한다.
- 기존 `Float` 입력은 호환 수용하되 새 draft와 UI에서는 `Double`로 정규화한다.
- Boolean, Timestamp, Date의 자동 추론은 원본 token과 명시된 format 근거를 보존한다.
- 중첩 JSON path와 물리 target column name을 분리해 저장한다.
- Preview, create payload, Spark schema와 Catalog schema는 같은 canonical 타입을 사용한다.

## 6. Phase 계획

### Phase 0. 계약과 회귀 기준

- 현재 세 실행 경로와 Rule 지원 차이를 fixture로 고정한다.
- canonical Rule, 타입, 오류 정책, 단계 결과 계약을 문서화한다.
- Phase별 검증 명령과 수동 검증 시나리오를 확정한다.

### Phase 1. 스키마 타입 정상화 (완료)

- JSON/JSONL preview 문자열과 별도로 native 값을 보존해 string, integer, real, boolean, object/array를 canonical 타입으로 추론한다.
- 기존 `Float`는 읽기 호환하고 backend profile, 신규 draft, Transform UI는 `Double`을 사용한다.
- dotted source path는 Transform input과 Continuous projection에 그대로 유지하고, 물리 target alias만 underscore 이름으로 생성한다.
- Continuous는 nested Spark schema와 root/nested unknown-field 검사를 사용하며 scalar/object path 충돌을 거절한다.

Phase 1 검증:

```bash
cd backend
npm run verify:schema-type-contract
PYTHONPATH=. .venv/bin/python scripts/verify-kafka-continuous-contract.py

cd ../frontend
npm run verify:ui-regressions
npm run build
```

### Phase 2. 공통 Rule 모델과 compiler (완료)

- Frontend create/update adapter와 FastAPI/Node backend가 `ruleContractVersion: "1.0"`, `rules[]`를 canonical 계약으로 교환한다.
- 새 create/append/update는 canonical version과 Rule JSON을 nullable DB 컬럼에 저장하고, canonical 컬럼이 없는 기존 행만 legacy adapter로 읽는다.
- 기존 `transformSteps`, `qualityRules`는 실행 호환 adapter 출력으로 유지하며 `canonicalParameters`로 falsy/null 값을 손실 없이 보존한다.
- 규칙이 없으면 source schema를 그대로 반환하는 pass-through compilation으로 처리한다.
- operation, input/output arity, column 존재 여부, parameter와 실행 mode 지원 여부를 create/update/review 전에 검증한다.
- `Drop Row`와 `Set Null`은 core `onError`와 별도인 `failureDisposition`으로 보존한다.
- 저장된 legacy Job은 조회 시 canonical Rule과 compilation 결과를 결정적으로 재구성하고, `1.0 + []`는 legacy 필드와 무관한 pass-through로 유지한다.
- `fail_batch`/`quarantine`과 row mutation disposition의 충돌, 버전·kind·severity·parameter 오류를 세 compiler가 같은 구조화 issue로 거절한다.
- Phase 2에서는 Continuous 활성 규칙 차단을 유지했고, Phase 5에서 Snapshot conformance를 통과한 stateless operation만 해제했다.

Phase 2 검증:

```bash
cd backend
npm run verify:rule-compiler
PYTHONPATH=. .venv/bin/python scripts/verify-kafka-continuous-contract.py

cd ../frontend
npm run verify:rule-compiler
npm run verify:schema-transform-rules
npm run verify:ui-regressions
npm run build
```

### Phase 3. Snapshot 실행 정합화 (완료)

- 일반 Snapshot과 Kafka Snapshot은 versioned `rules[]`를 실행 직전에 다시 compile하고 같은 canonical 의미로 실행한다.
- 공통 지원 Transform은 `cast`, `copy`, `default_value`, `json_extract`, `lowercase_trim`, `mask`, `null_guard`, `parse_timestamp`, `rename`이다.
- 공통 지원 Quality는 `accepted_values`, `not_null`, `range`, `regex`이며 `Fail Batch`, `Quarantine`, `Warn + keep/drop_row/set_null`을 동일하게 적용한다.
- 일반 Snapshot은 canonical Transform/Quality와 row disposition을 Parquet write 전에 적용한다. `Fail Batch`는 target을 만들지 않고, quarantine은 sibling Parquet evidence로 저장한다.
- Kafka Snapshot은 같은 canonical runtime을 JSON event에 적용하되 기존 `offset snapshot -> fixed-range consume -> target/Catalog -> offset commit` 경계를 유지한다. 실패 시 offset을 commit하지 않는다.
- canonical 범위를 벗어난 일반 Spark 전용 `sql_expression`, text analysis/classifier는 기존 Spark 경로를 유지한다. Kafka Snapshot은 지원하지 않는 operation을 실행 전에 거절한다.
- legacy Rule adapter는 빈 Regex/Accepted Values/Range 설정의 기존 기본값과 JSON root 아래 dotted path를 보존한다.

Phase 3 검증:

```bash
cd backend
npm run verify:rule-compiler
npm run verify:snapshot-rule-conformance
npm run verify:snapshot-spark-pipeline
npm run verify:kafka-review-scheduled-ingest
```

### Phase 4. UI와 Preview 정합화 (완료)

- Transform 편집기는 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON` 타입과 Snapshot portable operation을 사용한다. Kafka/Continuous에서 임의 SQL 탭은 노출하지 않는다.
- 원본 `sourceType`과 target `type`을 분리해 보존하고 rename, cast, default, null guard를 순서가 있는 명시적 Rule로 모두 직렬화한다. Visual 편집 결과가 자동 생성 SQL 한 건으로 덮이지 않는다.
- `POST /api/etl/rules/preview`는 최대 100개 샘플을 compiler로 검증한 뒤 실제 Node Snapshot runtime에 적용한다. 같은 conformance fixture를 실제 Spark 4 runtime과 비교해 Preview 의미를 고정한다.
- 모든 Source의 Target 화면에서 RAW, BRONZE, SILVER, GOLD를 같은 Select로 고르며 layer 변경 시 자동 생성 storage path도 함께 갱신한다. Layer와 Rule 유무는 독립적이다.

Phase 4 검증:

```bash
cd backend
npm run verify:rule-compiler
npm run verify:rule-preview
npm run verify:snapshot-rule-conformance
npm run verify:target-metadata

cd ../frontend
npm run verify:rule-compiler
npm run verify:schema-transform-rules
npm run verify:ui-regressions
npm run build
```

### Phase 5. Kafka Continuous 실행 (완료)

- `cast`, `copy`, `default_value`, `json_extract`, `lowercase_trim`, `mask`, `null_guard`, `parse_timestamp`, `rename`과 네 가지 Quality operation을 `foreachBatch` target publication 전에 공통 Spark runtime으로 적용한다. 임의 SQL과 stateful/engine-specific operation은 계속 거절한다.
- Kafka JSON은 `sourceType`으로 파싱하고 canonical Rule 뒤 compiler output schema만 target에 게시한다. `Fail Batch`는 checkpoint 전진을 막고, `Quarantine`은 Kafka 위치와 Rule identity를 보존하며, Warn/drop/set-null 카운터는 manifest와 runtime에 누적한다.
- canonical Rule, configured schema, target/source identity를 합친 fingerprint를 checkpoint의 `_asklake_contract` metadata에 고정한다. worker report, publication signature, batch manifest와 Catalog materialization에도 rule/schema/runtime fingerprint를 남긴다.
- 초기화된 checkpoint의 스키마·Rule·물리 target 변경은 Job 복사와 새 checkpoint를 요구한다. 실행 중 변경은 `409 CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`, 초기화 후 변경은 `409 CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`로 거절한다.
- 격리 replay도 현재 schema policy와 canonical Rule을 다시 적용하므로 Rule 격리 행이 maintenance 경로를 통해 우회 적재되지 않는다.
- Schema Transform UI는 Continuous에서도 streaming-safe Visual Transform과 bounded Preview를 제공하고 임의 SQL은 노출하지 않는다.

Phase 5 검증:

```bash
cd backend
npm run verify
npm run verify:rule-compiler
npm run verify:snapshot-rule-conformance
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules

cd ../frontend
npm run verify:ui-regressions
npm run build
```

### Phase 6. Streaming DAG와 실행 근거 (완료)

- 세션과 micro-batch에 단계별 status, input/output rows, duration, error를 JSON 증적으로 저장한다. `Fail Batch`처럼 manifest 전에 종료된 시도도 failed batch 이력으로 남기고 재시도 성공 시 같은 session/batch key를 갱신한다.
- Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 7단계를 실행 이력의 Streaming DAG로 표시한다. 세션은 누적 처리량과 최신 batch 근거를, micro-batch는 해당 offset 범위와 물리 경로를 보여준다.
- Transform/Quality 규칙이 없을 때 해당 단계는 성공한 `pass-through`로 표시한다. Catalog 단계는 물리 manifest만으로 성공 처리하지 않고 control plane의 `catalogBatchCursor`가 해당 batch를 확인한 뒤에만 성공으로 전환한다.
- Continuous worker 자체는 장기 Airflow task로 만들지 않는다.

Phase 6 검증:

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/verify-kafka-continuous-contract.py
npm run verify:kafka-continuous-rules

cd ../frontend
npm run verify:ui-regressions
npm run build
```

### Phase 7. 통합 검증 (완료)

- 일반 Snapshot, Kafka Snapshot, Kafka Continuous의 pass-through와 지원 Rule을 검증한다.
- malformed JSON, incompatible cast, required null, unknown field, target write 실패를 검증한다.
- worker/backend 재시작, checkpoint 재개, Catalog reconciliation과 중복 방지를 확인한다.
- 최신 `dev` 통합 후 production-like Compose 수동 테스트를 수행한다.

Phase 7 결과:

- 최신 `origin/dev`의 Schema Workbench/field rule UI와 기존 canonical Rule 계약을 통합했다. 일반 Snapshot은 SQL 변환을 유지하고 Kafka Snapshot/Continuous는 portable Transform만 표시하되 schema rename/cast, Quality, 실패 정책을 같은 field rule modal에서 설정한다.
- Snapshot Spark conformance, Kafka fixed-range ingest, malformed quarantine, Fail Batch offset 미커밋, 다중 partition, post-write retry 멱등성, Snappy-compressed source/snapshot을 자동 검증했다.
- Continuous production-like E2E는 정상 실행과 post-data-write/pre-manifest fault 주입을 각각 통과했다. worker 강제 종료와 backend 재시작 뒤 같은 checkpoint에서 `consumed=6`, `stored=3`, `quarantined=3` 및 Rule counter를 중복 없이 복원했고 Catalog cursor, replay 멱등성, compaction을 확인했다.
- production build의 Kafka 기본 broker를 `redpanda:9092`로 정합화하고 backend fallback은 `ASKLAKE_KAFKA_BROKER`를 사용한다. Source sampler는 첫 메시지 이후 bounded idle window를 사용하며 decode/run 오류를 metadata-only 성공으로 숨기지 않는다.

Phase 7 검증:

```bash
cd backend
npm run verify
npm run verify:rule-compiler
npm run verify:snapshot-rule-conformance
npm run verify:snapshot-spark-pipeline
npm run verify:rule-preview
npm run verify:target-metadata
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-review-scheduled-ingest
ASKLAKE_VERIFY_KAFKA=true npm run verify:fastapi-sources
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
ASKLAKE_RUN_KAFKA_CONTINUOUS_E2E=true npm run verify:kafka-continuous-e2e

cd ../frontend
npm run verify:rule-compiler
npm run verify:schema-transform-rules
npm run verify:ui-regressions
npm run build
```

## 7. 검증 게이트

각 Phase는 다음 원칙을 따른다.

1. Phase 시작 전에 최신 `origin/dev`를 통합한다.
2. 동작 또는 계약 변경은 같은 Phase에서 문서와 검증을 함께 갱신한다.
3. Phase 종료 커밋은 다음 Phase 없이도 build와 관련 회귀 검증을 통과해야 한다.
4. Continuous 규칙 지원은 Snapshot conformance가 통과한 operation만 활성화한다.
5. PR은 전체 통합 수동 검증 전까지 Draft 상태를 유지한다.

최소 자동 검증 범위:

```bash
cd backend
npm run verify
npm run verify:kafka-review-scheduled-ingest
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
npm run verify:kafka-continuous-e2e

cd ../frontend
npm run verify:ui-regressions
npm run build
```

환경 의존 검증은 프로젝트 Python virtual environment와 production-like Compose에서 실행하고 결과를 PR에 기록한다.

## 8. 제외 범위

- GOLD streaming join/aggregation
- stream-stream stateful join
- 외부 Schema Registry와 Kafka Connect/Flink 도입
- 다중 worker autoscaling과 SLA alerting
- 기존 적재 데이터의 일괄 migration 또는 삭제

## 9. 결정 사항과 잔여 항목

- Continuous 초기 지원 operation은 Phase 3 공통 Spark runtime의 stateless Transform 9개와 Quality 4개로 확정했다.
- 초기화된 checkpoint의 rule/schema/runtime fingerprint 변경은 in-place 재사용하지 않고 Job copy와 새 checkpoint를 요구한다.
- Target layer 기본값 변경 정책. 현재는 기존 source별 기본값을 유지하고 모든 Job에서 선택을 노출한다.
- 기존 Run DAG와 Streaming DAG의 공통 UI 범위
