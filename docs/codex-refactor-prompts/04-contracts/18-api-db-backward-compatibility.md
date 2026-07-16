# 18 — API·DB·Persisted Job·Checkpoint 하위 호환 Codex 프롬프트

## 목표

리팩토링 전체 결과가 기존 API consumer, DB row, Job draft, Run history, session, report/checkpoint와 호환되는지 검증하고 필요한 migration을 expand/migrate/contract로 구현한다.

## Codex에 전달할 프롬프트

baseline contract snapshot과 현재 코드 diff를 비교해 모든 의도된/의도하지 않은 계약 변화를 분류하라. 필요한 compatibility adapter와 migration을 구현한다.

### 필수 대상

- ETL Job create/edit/command
- Snapshot Run history
- Continuous runtime/session/batch
- source preview와 record parsing
- Catalog dataset/materialization
- Dashboard live publication
- SQL/Trino derived dataset
- Airflow internal execution contract
- Spark report/checkpoint/manifest
- frontend route와 draft schema

### 구현 작업

1. OpenAPI/schema diff를 자동 생성하고 breaking/additive/semantic change로 분류한다.
2. DB model과 migration head를 비교한다.
3. 새 field가 필요하면 nullable/default/backfill 전략을 만든다.
4. 구버전 row/draft/checkpoint reader를 유지하고 새 writer version을 명시한다.
5. dual-read/dual-write가 필요하면 일관성 검사, metric, 최대 유지 기간, 제거 issue를 만든다.
6. destructive contract migration은 모든 old process가 제거된 뒤 별도 단계로 둔다.
7. rollback 시 구버전 backend가 새 row를 읽을 수 있는지 검증한다.
8. compatibility mapper가 scattered conditional로 퍼지지 않게 한 boundary에 둔다.
9. contract test에 감사 기준 또는 실제 old fixture를 포함하되 secret/data는 정제한다.
10. 문서 `docs/03-api-reference.md`, `docs/api-contract.md`, architecture 문서를 실제 구현 상태에 맞게 갱신한다.

### 완료 기준

- 의도하지 않은 breaking API diff가 없다.
- old Job/session/checkpoint hydrate test가 통과한다.
- DB migration과 rollback이 반복 가능한 명령으로 검증된다.
- compatibility path의 종료 조건이 있다.
- 문서가 구현보다 앞서 target 상태를 current처럼 쓰지 않는다.
