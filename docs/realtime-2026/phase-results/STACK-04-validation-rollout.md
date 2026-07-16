# STACK-04 결과: validation, recovery, security, CI, rollout

- 작업일: 2026-07-16
- 포함 원본 단계: PR-07, PR-08
- Issue/branch/PR: #823 / `feat-#823` / 생성 예정
- 구현 판정: DONE
- production realtime 활성화 판정: NO-GO, 실제 통합·canary 증거 필요

## 구현 결과

- SSE request guard에 Dataset scope 상한·dedupe, non-negative reconnect cursor, replay page limit, payload allowlist/size, 권한 변경 heartbeat 종료 회귀 테스트를 추가했다.
- frontend polling 전략을 순수 함수로 분리해 open SSE는 polling을 중단하고 hybrid만 safety polling을 유지하도록 직접 검증한다.
- dashboard/actor 전환 시 이전 EventSource를 닫고 stale callback을 무시하며, invalid event injection이 reconnect cursor를 전진시키지 않는 테스트를 추가했다.
- `verify-realtime-quality-gates.py`가 무허용 `refetchInterval`/`setInterval`, direct in-memory event publish, SQL validation matrix 유실, 기존 God file의 line budget 초과와 신규 realtime 결합을 차단한다.
- `verify-realtime-stack.py`가 proxy 계약, realtime/auth/Continuous SQL/fencing focused suite를 하나의 cross-platform 명령으로 실행한다.
- disposable PostgreSQL에서 transaction idempotency, resource-scoped replay, LISTEN/NOTIFY와 retention cleanup을 검증하는 opt-in script를 추가했다.
- GitHub Actions PR gate가 deterministic backend, PostgreSQL publication concurrency, frontend transport/request strategy, production Compose render와 Caddy/NGINX parser를 실행한다.
- 무거운 Kafka/Spark/Iceberg fault·restart harness는 daily schedule/manual opt-in job으로 분리했다.
- canary, rollback, production incident/retention, handover와 항목별 final audit를 작성했다.

## local 검증 결과

- `npm run verify:realtime-stack`: PASS, 63 tests + proxy/architecture gate
- frontend `npm run verify:ui-regressions`: PASS, 132 checks
- frontend realtime transport: PASS, 7 tests
- frontend Dashboard live refresh: PASS, 6 tests
- frontend production build: PASS, 기존 large chunk warning만 존재
- `npm run verify:continuous-sql-contract`: PASS, 17 tests
- `npm run verify:kafka-continuous-contract`: PASS
- `node scripts/verify-kafka-continuous-rest.mjs`: PASS
- production Docker Compose config render: PASS
- Python compile와 workflow YAML parse: PASS
- `git diff --check`: PASS, Windows line-ending 안내만 존재

전체 backend discovery는 398 tests 중 394 PASS, 1 SKIP, 기존 3 FAIL을 재현했다. STACK-03과 동일하며 이번 branch가 새 실패를 만들지 않았다.

- `test_etl_data_lake_source` 2개: 현재 구현의 Review label `소스 데이터`와 테스트 기대 `소스 연결` drift
- `test_spark_source_identity` 1개: 변경하지 않은 `spark_job_run.py`의 post-read identity call 기대 drift

## 실행하지 못한 검증

로컬 Docker client는 설치되어 있지만 Docker Desktop daemon이 꺼져 다음 항목은 실행하지 못했다.

- disposable PostgreSQL `verify:realtime-postgres`
- Caddy container `validate`, NGINX container `-t`
- Kafka/Spark/Iceberg/Trino live fault·restart harness
- 실제 Continuous SQL stream-static INNER/LEFT JOIN과 pinned/latest static update
- multi-worker rolling backend restart, 외부 ALB heartbeat, EC2/Docker reboot
- connection/event storm, slow client와 장시간 memory/FD/CPU soak

앞의 세 항목은 새 PR/scheduled workflow가 실행하도록 연결했다. 뒤의 production-like 항목은 operator evidence가 필요하며 정적 test로 대체하지 않는다.

## rollout과 rollback

- 현재 flag는 deployment scope라 tenant canary를 지원하지 않는다. 격리 staging/canary deployment만 허용한다.
- 배포는 DB expand → disabled backend → event producer 관찰 → hybrid → sse → Continuous SQL 순서다.
- 즉시 rollback은 `DASHBOARD_SYNC_MODE=polling`, `REALTIME_EVENTS_ENABLED=false`, `CONTINUOUS_SQL_JOIN_ENABLED=false`다.
- stop은 Continuous SQL flag가 꺼진 뒤에도 허용하며 event table, checkpoint, manifest, Iceberg snapshot과 additive table을 삭제하지 않는다.

## 최종 위험과 인계

- code/contract/CI/runbook은 merge 준비가 됐지만 production flag enable은 No-Go다.
- production enable 전 실제 Spark JOIN, ALB/browser, rolling restart, canary와 rollback drill P0를 완료해야 한다.
- 상세 owner·승격·중단 기준은 `docs/realtime-2026/final-audit.md`, `docs/realtime-2026/handover.md`, `docs/realtime-2026/runbooks/`에 있다.
- merge 순서는 #808 → #815 → #822 → STACK-04 PR이다.
