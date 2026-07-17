# API·DB·Persisted State 하위 호환 계약

기준 baseline: `b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
검증 artifact: `docs/refactor-2026/baseline/artifacts/openapi.json`, `contracts.json`

## 판정

- baseline API: 83 paths, 95 operations
- 현재 API: 83 paths, 95 operations
- 제거된 path/method/response/schema/property/enum: 0
- 현재 schema: 222개, baseline 대비 additive schema 1개
- additive response field: `KafkaContinuousRuntime.desiredState`, `observedState`
- baseline persisted SQLAlchemy table: 23개, 제거 0
- destructive migration: 없음
- 기존 frontend route 18개와 ETL wizard flow 8개: 모두 유지

`ContinuousRuntimeErrorDetail`과 Continuous runtime의 desired/observed field는 응답 측 additive 계약이다. 기존 client는 해당 필드를 무시할 수 있고 기존 DB row는 `metrics.runtimeContract`가 없을 때 public `status`와 legacy `lastError`로 투영된다.

## 자동 차단 규칙

`backend/scripts/verify-backward-compatibility.py`는 다음 변경을 실패로 처리한다.

- baseline path/method 또는 기존 response status 제거
- 기존 parameter 제거, optional parameter의 required 전환, 새 required parameter 추가
- baseline component schema/property/enum value/type 제거 또는 변경
- request-reachable schema에 required field 추가
- baseline SQLAlchemy table, Pydantic schema class, Literal value, migration file 제거
- baseline frontend route literal 또는 wizard flow 제거

응답 전용 schema의 새 required field, 새 operation, 새 schema는 additive 보고 항목으로 남기되 실패로 처리하지 않는다. Request/response 의미를 동시에 쓰는 schema는 request-reachable 판정을 우선한다.

```bash
cd backend
npm run verify:backward-compatibility
```

## 기존 데이터 fixture

`tests.test_backward_compatibility_contracts`는 다음 이전 shape를 직접 hydrate한다.

- 새 rule/runtime/permission field가 없는 최소 `JobRowData`
- worker attempt와 counter field가 없는 `KafkaContinuousSession`
- `runtimeContract`가 없고 문자열 `lastError`만 있는 Continuous runtime
- schema version field가 없는 runtime report/checkpoint JSON

미래 runtime/draft version은 fail closed 하며, 이전 version reader가 작동하면 `compatibility.path.used` warning과 path별 counter가 증가한다.

## DB 변경 정책

현재 저장 모델은 additive initialization을 사용하며 `backend/migrations/` migration head는 없다. 이후 DB shape 변경은 다음 순서를 지킨다.

1. **Expand**: nullable/default column 또는 새 table을 먼저 추가하고 구버전 reader/writer를 유지한다.
2. **Migrate**: idempotent backfill과 row-count/evidence 검증을 수행한다.
3. **Contract**: 구버전 path 호출이 30일간 0이고 rollback release가 만료된 뒤 별도 PR로 제거한다.

Drop/rename/type rewrite와 checkpoint·Job·session 초기화는 이 리팩토링 PR에서 금지한다. rollback은 코드 reader를 되돌리되 운영 데이터와 checkpoint를 삭제하지 않는다.

## Legacy 경로 관리

[Legacy·Fallback 경로 등록부](../legacy-path-register.md)가 운영 도달 가능성, owner, activation, telemetry, 제거 조건과 목표 release를 소유한다. 운영 경로는 구조화 warning과 counter 없이는 추가할 수 없다. 브라우저 mock API와 관련 build switch는 제거되었으며 development와 production 모두 live API만 사용한다.

```bash
cd backend
npm run verify:legacy-paths
```

## Rollback

- API와 DB shape를 바꾸지 않았으므로 migration rollback은 없다.
- 표준 telemetry 모듈과 호출부, 프런트 production mock guard를 함께 되돌린다.
- versionless runtime reader와 legacy Job/session/draft reader는 제거하지 않는다.
- registry를 되돌릴 때도 기존 runtime data, browser draft, Kafka checkpoint를 삭제하지 않는다.
