# STACK-01 결과 — 계약·기준선·기능 플래그

## 범위

원본 PR-00과 PR-01을 하나의 Stack PR로 합쳤다. 현재 흐름·polling inventory·gap을 코드에서 확인하고 SSE 및 Continuous SQL ADR을 확정했다. 제품 코어 SSE와 JOIN runtime은 포함하지 않는다.

## 구현

- deployment scope realtime feature flag 5개 추가
- invalid mode와 dependency 불일치를 polling/disabled로 fail closed
- 인증된 GET /api/realtime/config 진단 endpoint 추가
- frontend runtime config adapter/type 추가
- backend/deploy example env와 production Compose 전달 추가
- baseline/flag characterization test 추가
- 원본 9-PR 팩을 docs/codex-realtime-pr-pack에 보존하고 4-PR mapping 추가

## 기준선

- backend Dashboard/Kafka characterization: 58 tests PASS
- frontend Dashboard live refresh: 5 tests PASS
- frontend production build: PASS, 기존 chunk-size warning만 존재

## 변경 후 검증

- backend feature flag + existing continuous/Dashboard suite: 67 tests PASS
- backend Python compileall: PASS
- frontend Dashboard live refresh: 5 tests PASS
- frontend production build: PASS, 기존 chunk-size warning만 존재
- production Docker Compose config: PASS
- git diff --check: PASS, Windows line-ending 안내만 존재

## Rollback

DASHBOARD_SYNC_MODE=polling, REALTIME_EVENTS_ENABLED=false, CONTINUOUS_SQL_JOIN_ENABLED=false로 설정하면 기존 polling, 정적 SQL, Kafka Continuous ingestion만 유지한다. schema 변경 없이 적용할 수 있다.

## 다음 단계

STACK-02에서 durable event log, replay 가능한 SSE, Dashboard targeted refetch, proxy/observability를 구현한다. tenant 식별자를 새로 만들지 않고 deployment scope와 기존 resource ACL을 사용한다.
