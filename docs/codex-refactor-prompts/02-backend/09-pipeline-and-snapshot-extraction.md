# 09 — Pipeline·Snapshot Use Case 추출 Codex 프롬프트

## 목표

`etl_service.py`에 남은 pipeline create/edit/delete, validation, Snapshot command/run orchestration을 use case와 policy로 분리한다. Continuous와 Snapshot의 수명주기를 섞지 않는다.

## Codex에 전달할 프롬프트

현재 코드와 제품/API 문서를 읽고 pipeline 및 Snapshot 책임을 추출하라.

### 구현 작업

1. pipeline definition 생성·수정·복제·삭제의 현재 invariants를 정리한다.
2. connector config, record parsing, schema, transform, quality, schedule, permission, target, review draft 변환을 구분한다.
3. validation을 다음으로 분리한다.
   - 순수 domain validation
   - connector/runtime capability validation
   - 권한/tenant validation
4. create/edit의 DB transaction과 외부 validation을 분리한다.
5. Snapshot start/cancel/retry/status를 Continuous handler와 다른 use case로 유지한다.
6. Airflow는 유한 orchestration adapter로만 사용한다. 장기 worker 책임을 넘기지 않는다.
7. 기존 Job row와 draft JSON을 새 domain model로 hydrate하는 mapper를 만든다.
8. 구버전 필드와 default가 있는 경우 compatibility normalization을 명시한다.
9. router/API response는 기존 schema와 호환한다.
10. `create_trino_sql_job` 같은 별도 책임은 다음 SQL 단계로 넘길 수 있도록 boundary를 만든다.
11. extraction 후 `etl_service.py`에 남은 책임 목록과 제거 계획을 갱신한다.

### 필수 테스트

- 새 pipeline create round trip
- 기존 pipeline edit 후 미변경 credential 보존
- `requiresRecordParsing` draft 보존
- invalid target/schedule/permission
- old Job hydrate
- Snapshot duplicate start/cancel/retry
- Airflow trigger response loss

### 완료 기준

- pipeline과 Snapshot orchestration이 독립 module과 테스트를 가진다.
- Continuous command와 상태 정책을 공유할 부분과 공유하지 않을 부분이 명확하다.
- 기존 draft/API/DB row가 깨지지 않는다.
- `etl_service.py`는 더 이상 pipeline validation 세부를 직접 소유하지 않는다.
