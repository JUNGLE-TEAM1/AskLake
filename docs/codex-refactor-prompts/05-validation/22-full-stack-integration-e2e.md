# 22 — 백엔드·프런트엔드 통합 E2E Codex 프롬프트

## 목표

프런트 UI에서 시작한 명령이 API, DB, runtime adapter, report/materialization, Catalog/Dashboard 상태를 거쳐 다시 화면에 표시되는 전체 계약을 자동 검증한다.

## Codex에 전달할 프롬프트

현재 사용 가능한 테스트 framework와 local stack을 사용해 deterministic full-stack E2E를 구축하거나 보강하라. production credential이나 외부 shared environment에 의존하지 않는다.

### 필수 vertical slice

1. ETL wizard에서 source 선택
2. 필요한 경우 record parsing
3. schema/transform/quality/schedule/permission/target/review
4. Job create
5. Snapshot 또는 fake/ephemeral Continuous start
6. runtime status observation
7. output/manifest evidence
8. Catalog materialization
9. Dashboard publication 또는 의도된 실패 단계
10. Job detail/runtime/history 화면 반영

### 구현 작업

1. E2E용 ephemeral DB/object storage/Kafka/Spark 또는 contract-faithful fake 조합을 선택하고 차이를 문서화한다.
2. 최소 한 suite는 실제 process/container 경계를 통과한다.
3. UI selector는 안정적인 role/test-id를 사용하고 CSS class에 과도하게 결합하지 않는다.
4. async polling은 고정 sleep이 아니라 조건 대기를 사용한다.
5. correlation ID를 수집해 실패 시 backend/runtime log를 artifact로 남긴다.
6. 생성한 Job/dataset/session을 teardown한다.
7. 중복 submit, 새로고침, edit round trip, command failure를 포함한다.
8. API-only integration과 browser E2E를 구분해 실행 시간을 관리한다.
9. CI에서 실행할 profile과 release 전 전체 profile을 만든다.

### 완료 기준

- 최소 하나의 실제 full-stack happy path가 자동화된다.
- frontend status가 backend derived state와 일치한다.
- API/DB/runtime contract mismatch가 테스트에서 잡힌다.
- 실패 artifact로 원인을 추적할 수 있다.
- flaky fixed sleep과 shared mutable test data에 의존하지 않는다.
