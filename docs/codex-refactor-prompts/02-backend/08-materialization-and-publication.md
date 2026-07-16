# 08 — Batch Materialization·Catalog·Dashboard Publication 분리 Codex 프롬프트

## 목표

Spark output 생성, manifest, Catalog 등록, Dashboard live publication을 하나의 성공/실패로 뭉개지 않고 독립적이고 재시도 가능한 단계로 만든다.

## Codex에 전달할 프롬프트

`materialize_continuous_batch`, `materialize_continuous_publication`과 관련 repository/service를 조사해 application workflow를 분해하라.

### 구현 작업

1. 현재 단계와 저장 위치를 정확히 매핑한다.
   - batch output
   - manifest/checkpoint
   - Catalog dataset/materialization
   - Trino/Iceberg registration 또는 refresh
   - Dashboard live publication
2. 각 단계의 idempotency key를 정의한다. 예: job/session/batch/output fingerprint.
3. 외부 side effect 사이에 긴 DB transaction을 두지 않는다.
4. 단계별 상태와 retry count/error code를 기존 schema로 표현하거나 additive schema로 확장한다.
5. output이 이미 존재할 때 전체 Spark job을 다시 돌리지 않고 누락 단계만 재개할 수 있게 한다.
6. Catalog 실패와 Dashboard 실패가 원본 적재 성공을 뒤집지 않도록 public status와 상세 status를 분리한다.
7. 중복 materialization이 같은 dataset/version을 두 번 만들지 않도록 uniqueness/fencing을 적용한다.
8. 필요한 경우 outbox 패턴을 비교하되 새 queue/service를 자동 도입하지 않는다. 현재 DB로 안전하게 해결 가능하면 그쪽을 우선한다.
9. 기존 API와 UI가 기대하는 summary status를 compatibility mapper로 유지한다.
10. 기존 대형 함수는 façade 또는 삭제 대상으로 만든다.

### 필수 테스트

- output 성공, manifest write 실패
- manifest 성공, Catalog deadlock/timeout
- Catalog 성공, Dashboard 실패
- 같은 batch 재시도
- backend crash 후 재개
- 두 reconciler가 같은 batch publication 수행
- 구버전 manifest 읽기

### 완료 기준

- 각 단계의 canonical evidence와 recovery source가 명확하다.
- partial failure가 전체 job을 불필요하게 다시 실행시키지 않는다.
- Dashboard 실패가 data loss로 표시되지 않는다.
- 단계별 재시도와 중복 방지 테스트가 있다.
- frontend가 상세 실패 단계를 표현할 API 토대가 있다.
