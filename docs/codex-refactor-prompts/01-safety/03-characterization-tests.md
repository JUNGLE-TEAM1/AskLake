# 03 — 핵심 동작 Characterization Test 안전망 Codex 프롬프트

## 목표

God File을 분해하기 전에 현재 사용자가 의존하는 동작을 테스트로 고정한다. 테스트는 구현 세부가 아니라 API, 상태 전이, 직렬화, side-effect 순서를 관찰한다.

## Codex에 전달할 프롬프트

baseline과 P0 변경을 읽고, 기존 기능을 보존하는 characterization test를 추가하라. 이번 단계에서는 구조를 대규모로 옮기지 않는다.

### 백엔드 필수 테스트

1. ETL Job create/edit/delete 또는 실제 지원 command
2. Snapshot start/cancel/retry와 Run history
3. Continuous start를 두 번 요청했을 때의 현재 idempotency
4. pause/resume/stop/recover 상태 전이
5. Spark submission 성공·실패·response 유실 모사
6. report 정상/누락/손상/지연 처리
7. checkpoint fingerprint/schema mismatch
8. output 존재 후 Catalog 실패
9. Catalog 성공 후 Dashboard publication 실패
10. backend restart 후 runtime refresh/reconcile
11. 구버전 persisted Job, session, checkpoint hydrate
12. Python→Node bridge 요청/응답/timeout/exit code

### 프런트엔드 필수 테스트

1. ETL wizard URL과 단계 이동
2. source 결과의 `requiresRecordParsing` 분기
3. create와 edit draft serialize/hydrate round trip
4. credential masking과 재편집
5. Job 목록 filter/sort와 상세 route
6. command optimistic state와 실패 rollback
7. active Continuous polling 단일화에 필요한 현재 호출 패턴
8. 늦게 도착한 이전 polling 응답이 최신 상태를 덮는 시나리오
9. runtime/history/DAG 표시 계약
10. Catalog/Dashboard publication 단계 오류 표시의 현재 동작

### 테스트 설계 원칙

- live Kafka/Spark/S3가 필요 없는 단위·계약 테스트에서는 fake/spy adapter를 사용한다.
- 테스트가 `etl_service.py`의 private 함수 호출 순서에 과도하게 결합하지 않게 한다.
- side effect 순서는 event/adapter call 기록으로 검증한다.
- fixture에는 secret과 production data를 넣지 않는다.
- snapshot은 ordering과 dynamic ID를 정규화한다.
- 현재 동작이 명백한 버그여도 먼저 실패 재현 또는 현재 behavior test를 남기고, 변경은 관련 단계에서 명시적으로 한다.

### 산출물

- 테스트 파일과 필요한 fake/fixture builder
- `docs/refactor-2026/testing/characterization-matrix.md`
- 각 테스트가 어느 향후 phase를 보호하는지 mapping
- 현재 테스트로 포착하지 못하는 영역 목록

### 완료 기준

- backend God Service의 주요 use case별 최소 한 개 이상의 계약 테스트가 있다.
- frontend wizard와 Job runtime의 핵심 상태 흐름이 테스트된다.
- 테스트가 현재 branch에서 반복 가능하고 flaky 원인이 없다.
- 다음 단계의 extraction이 실패했을 때 사용자-visible 회귀를 잡을 수 있다.
