# Transform/Quality 공통 실행 통합 계획

## 1. 목적

Issue #567은 일반 Snapshot, Kafka Snapshot, Kafka Continuous에서 분산된 스키마 추론과 Transform/Quality 실행 의미를 하나의 계약으로 정리한다.

이 작업은 하나의 기능 브랜치와 Draft PR에서 진행하되, Phase별 독립 커밋과 검증 게이트를 유지한다. 구현이 끝나기 전까지 현재 Continuous V1의 규칙 차단 동작을 임의로 해제하지 않는다.

## 2. 현재 기준

현재 처리 경로는 다음과 같이 나뉜다.

| 실행 경로 | 입력 경계 | Transform/Quality 실행 | 진행 상태 |
| --- | --- | --- | --- |
| 일반 Snapshot | Run 단위 source read | `backend/scripts/spark_job_run.py` | 지원 |
| Kafka Snapshot | 고정 partition offset 범위 | `backend/scripts/ingest-kafka-reviews.mjs` | 지원 |
| Kafka Continuous | Spark checkpoint와 micro-batch | `backend/scripts/kafka_continuous_stream.py` | schema projection과 quarantine만 지원 |

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

### Phase 1. 스키마 타입 정상화

- JSON native type을 보존하도록 source profile을 보완한다.
- `Float`/`Double` UI와 payload 불일치를 제거한다.
- 중첩 source path와 target alias를 안전하게 처리한다.

### Phase 2. 공통 Rule 모델과 compiler

- Frontend draft와 backend schema가 canonical Rule을 교환한다.
- legacy Rule payload를 canonical 형태로 읽는 호환 adapter를 유지한다.
- 지원 여부와 출력 스키마를 실행 전에 검증한다.

### Phase 3. Snapshot 실행 정합화

- 일반 Snapshot과 Kafka Snapshot이 같은 fixture에서 동일한 출력과 오류 분기를 만든다.
- Kafka offset snapshot과 commit 순서는 변경하지 않는다.
- 구현 공유가 어려운 경계는 공통 conformance suite로 동등성을 강제한다.

### Phase 4. UI와 Preview 정합화

- Transform 편집기의 타입과 operation 선택지를 backend 지원 목록과 맞춘다.
- rename, cast, default, null guard를 명시적인 Rule로 직렬화한다.
- Preview 결과를 실제 Spark fixture 결과와 비교한다.
- 모든 Job에서 Target layer 선택을 같은 방식으로 제공한다.

### Phase 5. Kafka Continuous 실행

- canonical Rule을 `foreachBatch` target publication 전에 적용한다.
- rule/schema fingerprint를 worker report와 checkpoint metadata에 기록한다.
- Fail/Quarantine/Warn 카운터와 재시작 동작을 검증한다.
- 활성 worker의 불변 설정 변경은 명시적인 중지/복사 정책으로 제한한다.

### Phase 6. Streaming DAG와 실행 근거

- 세션과 micro-batch에 단계별 status, input/output rows, duration, error를 저장한다.
- Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 단계를 Streaming DAG로 표시한다.
- Transform/Quality 규칙이 없을 때 해당 단계는 `pass-through`로 표시한다.
- Continuous worker 자체는 장기 Airflow task로 만들지 않는다.

### Phase 7. 통합 검증

- 일반 Snapshot, Kafka Snapshot, Kafka Continuous의 pass-through와 지원 Rule을 검증한다.
- malformed JSON, incompatible cast, required null, unknown field, target write 실패를 검증한다.
- worker/backend 재시작, checkpoint 재개, Catalog reconciliation과 중복 방지를 확인한다.
- 최신 `dev` 통합 후 production-like Compose 수동 테스트를 수행한다.

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

## 9. 결정이 필요한 항목

- Continuous 초기 지원 operation의 최종 목록
- rule/schema fingerprint가 바뀔 때 Job copy와 checkpoint 정책
- Target layer 기본값과 사용자 선택 노출 방식
- 기존 Run DAG와 Streaming DAG의 공통 UI 범위
