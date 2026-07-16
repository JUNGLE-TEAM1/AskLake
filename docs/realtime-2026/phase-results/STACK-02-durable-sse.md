# STACK-02 결과: Durable SSE Dashboard sync

- 작업일: 2026-07-16
- 포함 원본 단계: PR-02, PR-03, PR-04
- Issue/branch: #811 / `feat-#811`
- 판정: 구현 및 로컬 검증 완료, Draft PR 생성 전

## 구현 결과

- PostgreSQL `realtime_event_log`와 global monotonic cursor, retention, idempotency, resource replay를 추가했다.
- Dataset revision과 event, Dashboard publish와 event를 각각 같은 transaction에서 기록한다.
- process당 PostgreSQL LISTEN connection 하나, durable cursor catch-up dispatcher, bounded local hub를 추가했다.
- authenticated Dashboard-scoped SSE endpoint가 snapshot replay, Last-Event-ID, heartbeat, ACL 재검사, resync, overflow와 연결 한도를 처리한다.
- published Dashboard REST snapshot에 `eventCursor`를 추가했다.
- React는 typed singleton EventSource owner를 사용해 Dataset별 event를 coalesce하고 affected widget만 기존 REST로 다시 읽는다. Dashboard publish와 resync는 snapshot을 다시 읽는다.
- polling/hybrid/sse 전환, offline·hidden tab·route cleanup, 재조회 실패 복구를 유지했다.
- Caddy와 legacy NGINX의 streaming path, Compose/env 안전 경계, realtime readiness/status를 추가했다.
- published 화면에 `실시간/연결 중/재연결 중/폴링 복구/폴링` 진단 배지를 노출하고 heartbeat 정지 시 bounded fallback polling 후 cursor 재연결한다.

## 권위와 보안

- event payload는 데이터 원본이 아니며 identifier/revision/invalidation hint만 포함한다.
- `asklake_session` cookie를 URL에 노출하지 않고, Dashboard view 및 Dataset query/governance 권한을 재검사한다.
- 현재 tenant model을 발명하지 않고 deployment scope + resource ACL을 사용한다.
- secret-like field와 allowlist 밖 payload는 event insert 전에 거절한다.

## Rollback

`DASHBOARD_SYNC_MODE=polling`, `REALTIME_EVENTS_ENABLED=false`로 재배포한다. additive event table은 남겨 두며 기존 adaptive polling과 REST 계약은 유지된다.

## 검증 결과

- backend Dashboard/Kafka baseline + realtime: PASS, 80 tests
- backend realtime focused: PASS, 13 tests
- frontend UI regression: PASS, 132 checks
- frontend realtime transport: PASS, 5 tests
- frontend production build: PASS, 기존 large chunk warning만 존재
- Python `compileall`: PASS
- realtime proxy/env contract script: PASS
- production Compose config render: PASS
- `git diff --check`: PASS
- Caddy container `validate`, NGINX container `-t`: 미실행. Docker Desktop daemon이 꺼져 있어 image parser를 실행할 수 없었고, 정적 contract script와 Compose render만 통과했다.

## 남은 검증

- production PostgreSQL, 실제 Caddy/ALB 경로, rolling restart를 포함한 통합 검증은 STACK-04에서 수행한다.
- 이 저장소에 ALB IaC가 없어 외부 idle timeout은 운영 환경에서 확인해야 한다.
- 실제 event burst/다중 worker/다중 tab 장시간 soak와 alert threshold 확정은 STACK-04 rollout gate에 포함한다.
