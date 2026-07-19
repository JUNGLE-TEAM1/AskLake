# Realtime Kafka Job engine routing

Issue #1073은 사용자에게 내부 V1/V2 선택을 노출하지 않고 Kafka Job의 실행 방식으로 engine을 결정한다.

## 생성 계약

| 사용자 선택 | API 입력 | 서버가 저장하는 계약 | 실행 경로 |
| --- | --- | --- | --- |
| `실시간 · ClickHouse` | `executionMode=continuous` | `continuousConfig.runtimeEngine=kafka_connect_clickhouse_v2`, `runtimeGeneration=1` | Kafka Connect → ClickHouse V2 |
| `배치 · Spark` | `executionMode=snapshot` | Continuous engine marker 없음 | 기존 Spark batch |

`runtimeEngine`과 `runtimeGeneration`은 서버 소유 값이다. Browser가 V1/V2를 선택하지 않는다. marker가 없는 기존 Continuous Job은 legacy Spark Structured Streaming V1으로 해석하며 자동 마이그레이션하지 않는다.

## Fail-closed와 exact-one owner

- V2 marker Job은 `CLICKHOUSE_REALTIME_V2_ENABLED=true`, `KAFKA_CONNECT_SINK_ENABLED=true`, `CLICKHOUSE_REALTIME_CONSUMER_OWNER=kafka_connect_v2`가 모두 충족될 때만 시작·재개한다.
- 위 조건이 없으면 `CLICKHOUSE_KAFKA_INGEST_V2_UNAVAILABLE`로 실패한다. 같은 Job을 Spark V1으로 자동 실행하지 않는다.
- 시작·재개는 `(broker, topic, consumerGroup)`의 active Continuous/Snapshot 충돌을 먼저 검사한다.
- connector identity와 Keeper state path는 Job에 대해 결정적이며 persisted `runtimeGeneration`을 connector 등록과 owner 검증에 사용한다.
- command revision과 worker-attempt fencing이 이전 observation을 거부한다. 기존 V1 checkpoint는 삭제하거나 V2 state로 재사용하지 않는다.

## Lifecycle과 rollback

V2는 기존 `startContinuous`, `pauseContinuous`, `resumeContinuous`, `stopContinuous` API를 재사용한다. durable command intent를 먼저 저장한 뒤 connector를 등록·재개하거나 pause한다. Catalog는 첫 offset 전 `preparing`, 첫 ClickHouse publication 뒤 `available`이다.

V2가 실패하면 connector/offset/Keeper/ClickHouse state를 보존하고 Job을 실패 상태로 남긴다. rollback은 V2 owner가 0임을 확인한 뒤 별도 승인 generation으로 수행하며, V1 자동 fallback, offset reset, checkpoint/PVC 삭제를 포함하지 않는다.

## 검증 경계

로컬 완료는 engine marker, legacy V1 보존, disabled fail-closed, connector idempotency, lifecycle와 frontend label/build 회귀를 뜻한다. EKS 완료는 신규 공개 Job 생성 API로 만든 격리 identity가 실제 MSK → Kafka Connect → ClickHouse row publication, restart recovery, pause/resume/stop, rollback을 통과하고 비밀 없는 receipt가 남았을 때만 주장한다.

## 변경 범위 감사

2026-07-20 image build 전 `origin/feat-#1073` (`8d565f0483b73b1036f14c75a77ceffc009706df`)을 다시 fetch해 전체 diff를 검사했다.

- Backend 변경은 engine admission, external EKS control-plane routing, durable owner claim, lifecycle, 정적 검증기와 관련 테스트로만 구성된다.
- Frontend 변경은 기존 Kafka 실행 방식 선택과 Job 상세의 ClickHouse/Spark 표기 및 additive response type으로만 구성된다.
- 문서 변경은 공식 SSOT의 engine/fail-closed/owner/rollback 계약 동기화와 이 문서 1개뿐이다.
- `git diff --check` 오류 0건, credential pattern 0건, #1073 범위 밖 변경 0건, 중복 산출물 0건이다.

EKS canary와 최종 receipt가 추가된 뒤 커밋 전 같은 감사를 다시 수행한다.
