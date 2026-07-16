# 06 — Continuous 명령 Use Case 추출 Codex 프롬프트

## 목표

`command_job`, `command_kafka_continuous_job` 등에 섞인 start/pause/resume/stop/recover/maintenance 명령을 application use case로 분리하고, transaction과 외부 side effect 경계를 명확히 한다.

## Codex에 전달할 프롬프트

공통 규칙, state contract, infrastructure adapter를 사용해 Continuous command 경로를 실제 코드에서 추출하라.

### 구현 작업

1. 현재 router→service→repository→Spark/Kafka 호출 sequence를 각 command별로 그린다.
2. command DTO와 결과 DTO를 정의하되 기존 API schema와 mapper로 연결한다.
3. 최소한 다음 handler 또는 동등한 use case를 분리한다.
   - start
   - pause
   - resume
   - stop
   - recover/retry
   - maintenance/replay가 command path에 있다면 별도 분리
4. 각 handler에서 다음 순서를 명시한다.
   - 권한/입력 검증
   - idempotency/concurrency 검사
   - desired state 또는 command record DB commit
   - 외부 side effect
   - observation/결과 기록
   - 실패 보상 또는 reconciliation 예약
5. 외부 호출을 긴 DB transaction 안에서 수행하지 않는다.
6. submission 성공 후 response 유실을 재시도로 중복 실행하지 않도록 submission identity와 lookup/reconcile 경로를 둔다.
7. stale worker fencing을 실제 DB/version/checkpoint 계약에 연결한다.
8. 기존 router와 response는 façade를 통해 유지한다.
9. command별 table-driven unit test와 repository/adapter integration test를 추가한다.
10. `etl_service.py`의 기존 함수를 deprecated wrapper로 남길 경우 제거 조건과 사용처를 기록한다.

### 필수 시나리오

- 동일 idempotency key로 start 2회
- 다른 idempotency key로 동시 start
- pause 중 stop
- stopped 상태에서 resume
- DB commit 직후 crash
- Spark submission response 유실
- 권한 거부
- stale version command

### 완료 기준

- Continuous command의 상태 변경 규칙이 한 application boundary에 있다.
- router가 orchestration을 하지 않는다.
- `etl_service.py`의 command 함수는 얇은 façade이거나 사용처가 제거된다.
- 모든 command가 idempotent 또는 명시적으로 non-idempotent이며 그 이유가 테스트된다.
- rollback 시 기존 façade로 되돌릴 수 있다.
