# 04 — Continuous 상태 소유권·상태 머신·오류 계약 Codex 프롬프트

## 목표

DB, Spark, Kafka, report, checkpoint, S3, Catalog, Dashboard, frontend polling에 흩어진 사실을 하나의 명시적 상태 모델과 단계별 오류 계약으로 정리한다. API shape는 기본적으로 유지한다.

## Codex에 전달할 프롬프트

characterization test를 보호막으로 사용해 Continuous runtime의 domain contract를 코드와 문서로 만든다.

### 먼저 조사할 것

- Job/runtime/session/batch 관련 SQLAlchemy model, schema, repository
- `etl_service.py`의 command, refresh, materialize 함수
- `kafka_continuous_stream.py`의 checkpoint/offset/report 처리
- Spark report JSON schema와 저장 위치
- Catalog/Dashboard publication status
- frontend가 status/error를 해석하는 위치

### 필수 설계 결정

다음 각각에 대해 canonical owner, writer, reader, recovery source, retention을 결정하고 코드와 문서가 일치하게 한다.

- Job definition
- desired runtime state
- observed runtime state
- active session와 lease/fencing token
- Spark submission identity
- micro-batch identity
- Kafka partition/offset 또는 checkpoint
- output manifest
- Catalog materialization
- Dashboard live publication
- terminal error와 retryability

### 구현 작업

1. 기존 enum/string을 조사해 호환 가능한 domain state model을 만든다.
2. 가능한 한 순수 함수 형태의 transition policy를 만든다.
3. command와 observation을 구분한다.
   - command: 사용자가 원하는 상태
   - observation: Spark/Kafka/report에서 관찰한 상태
   - derived public status: API/frontend에 노출할 상태
4. concurrent command, duplicate request, stale worker를 막는 version/lease/fencing 규칙을 구현하거나 기존 필드를 활용한다.
5. 단계별 error code를 정의한다. 최소 단계:
   - validation
   - runtime_storage
   - submission
   - execution
   - report
   - checkpoint
   - materialization
   - catalog
   - dashboard_publication
   - reconciliation
6. 기존 response field를 깨지 않고 additive field 또는 내부 mapper로 노출한다.
7. 모든 허용/거부 transition을 table-driven test로 작성한다.
8. `docs/refactor-2026/contracts/runtime-state-ownership.md`와 Mermaid state diagram을 작성한다.

### 위험 시나리오

- start 두 번
- pause와 maintenance 경쟁
- DB commit 직후 backend crash
- submission 성공 후 response 유실
- report 없음/손상
- stale worker와 새 worker 동시 checkpoint 사용
- output 성공 후 Catalog 실패
- Dashboard만 실패
- backend reboot 후 복구

### 완료 기준

- 같은 사실을 여러 저장소가 서로 canonical이라고 주장하지 않는다.
- public `failed` 하나로 모든 단계를 뭉개지 않는다.
- 상태 전이가 code path마다 흩어지지 않고 한 정책으로 검증된다.
- 기존 API consumer가 깨지지 않는다.
- frontend가 polling 결과를 source of truth로 만들지 않고 server-derived status를 사용하게 할 계약이 준비된다.
