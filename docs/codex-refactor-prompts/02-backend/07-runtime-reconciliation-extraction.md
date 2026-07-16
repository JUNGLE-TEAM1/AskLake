# 07 — Runtime Reconciliation 추출 Codex 프롬프트

## 목표

`refresh_kafka_continuous_runtime` 같은 거대 함수를 순수 판정 로직과 side-effect 실행으로 나누고, reboot/report loss/partial failure 뒤에도 반복 실행 가능한 reconciliation을 만든다.

## Codex에 전달할 프롬프트

기존 상태 계약과 adapter를 사용해 runtime refresh/reconcile 경로를 독립 use case로 추출하라.

### 구현 작업

1. 현재 reconciliation이 읽는 모든 evidence를 나열한다.
   - DB desired/observed/session/lease
   - Spark submission/driver/worker 상태
   - Kafka group/lag
   - report와 timestamp
   - checkpoint와 manifest
   - output/Catalog/Dashboard 상태
2. evidence를 immutable input model로 정규화한다.
3. `evidence + current state -> decision/actions` 형태의 순수 decision function을 만든다.
4. side-effect executor는 decision의 action만 수행한다.
5. evidence precedence를 명시한다. 보고서가 없다는 이유만으로 실행 성공/실패를 단정하지 않는다.
6. uncertain/unknown 상태를 terminal failed와 구분한다.
7. repeated reconciliation이 안전하도록 모든 action에 idempotency를 둔다.
8. backend startup과 주기 실행에서 동일 use case를 사용한다. 중복 scheduler가 있으면 한 소유자로 정리한다.
9. 오래된 report와 stale worker를 시간만으로 판단하지 말고 session/lease/submission identity와 연결한다.
10. reconciliation 결과와 근거 evidence를 구조화된 log/event로 남긴다.
11. 기존 refresh API 또는 polling endpoint의 response contract를 유지한다.

### 필수 테스트

- reboot 뒤 desired=running, observed unknown
- Spark running, report 없음
- Spark terminal success, output 없음
- output 있음, manifest 없음
- manifest 있음, Catalog 실패
- Dashboard만 실패
- old report가 새 session 뒤늦게 도착
- stale worker가 heartbeat를 보냄
- Kafka partition 증가
- 반복 reconcile 두 번의 결과 동일

### 완료 기준

- reconciliation 정책이 거대 service 함수 밖에 있고 순수 테스트가 가능하다.
- report file은 유일한 truth가 아니라 evidence 중 하나다.
- unknown과 failed가 구분된다.
- backend restart 뒤 자동 복구 흐름이 있다.
- `etl_service.py`의 refresh 함수가 façade 수준으로 축소된다.
