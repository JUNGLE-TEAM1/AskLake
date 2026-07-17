# Realtime 2026 final audit

- 감사일: 2026-07-16
- 코드 기준: STACK-04 branch `feat-#823`
- 범위: STACK-01~04, 원본 PR-00~PR-08
- 구현 merge 판정: **GO, 순서 조건부**
- production realtime 활성화 판정: **NO-GO, 실제 통합·canary 증거 필요**

## 판정 용어

| 상태 | 의미 |
|---|---|
| VERIFIED_LOCAL | 현재 branch에서 결정적인 local test/script가 통과 |
| CI_PENDING | workflow를 추가했으나 현재 PR run 결과가 아직 없음 |
| OPERATOR_REQUIRED | 실제 proxy/host/production-like runtime에서만 증명 가능 |
| DEFERRED | V1 의도적 제외 |

## 계약 감사

| 영역 | 상태 | 증거 | 남은 조건 |
|---|---|---|---|
| durable cursor/idempotent event log | VERIFIED_LOCAL | realtime repository/transaction tests, quality gate | disposable PostgreSQL job 결과 확인 |
| reconnect replay/resync/overflow | VERIFIED_LOCAL | cursor, replay limit, expired cursor, queue overflow tests | 실제 browser/proxy reconnect |
| resource/session isolation | VERIFIED_LOCAL | resource-scoped replay, connection limit, heartbeat auth recheck, production auth/CORS tests | production multi-actor negative test |
| ticket replay | VERIFIED_LOCAL | 별도 SSE bearer/ticket을 발급하지 않고 httpOnly session cookie를 heartbeat마다 재검증 | production session revoke test |
| SSE-open polling 중단 | VERIFIED_LOCAL | `dashboardLivePollingStrategy`와 frontend mode test | 실제 browser network 0 request 증거 |
| duplicate/out-of-order coalescing | VERIFIED_LOCAL | highest revision/event cursor frontend test, backend cursor dedupe | event storm load sample |
| multi-worker NOTIFY/catch-up | CI_PENDING | disposable PostgreSQL NOTIFY script와 dispatcher catch-up test | CI 성공 및 rolling restart |
| Caddy/NGINX streaming config | CI_PENDING | static contract + container parser workflow | 실제 ALB/CDN heartbeat flush |
| Continuous SQL AST와 거부 matrix | VERIFIED_LOCAL | SQLGlot planner tests | 없음 |
| PINNED/LATEST binding과 fencing | VERIFIED_LOCAL | plan/binding manifest, generation/fence tests | 실제 static update between batches |
| exact output/Catalog/Dashboard publication | VERIFIED_LOCAL | fake Iceberg exact snapshot, idempotent revision/event tests | 실제 Iceberg/Trino fault path |
| Kafka/Spark/Iceberg fault harness | CI_PENDING | scheduled/manual `realtime-live-e2e` | 새 workflow 성공 run |
| 실제 stream-static INNER/LEFT JOIN | OPERATOR_REQUIRED | contract/runtime adapter만 local 검증 | production-like Spark live evidence |
| BACKFILL_ON_CHANGE | DEFERRED | flag 기본 false, V1 계약 제외 | 별도 bounded rewrite 설계/PR |

## CI와 구조 감사

- `.github/workflows/realtime-quality-gates.yml`은 PR smoke, disposable PostgreSQL, proxy parser, production Compose render를 실행한다.
- scheduled/manual tier는 기존 Kafka/Spark/Iceberg fault·restart harness를 분리한다.
- `verify-realtime-quality-gates.py`는 Dashboard `refetchInterval`/`setInterval`, direct in-memory publish, SQL validation matrix 유실과 기존 God file의 line budget 초과·신규 결합을 차단한다.
- realtime/SSE/Continuous SQL symbol은 `etl_service.py`, `App.tsx`, `useAskLakeData.ts`에 다시 집중시키지 않았다.
- timing test는 fake timer, explicit queue, cursor/barrier를 사용하며 retry로 flaky failure를 숨기지 않는다.

## code·API·UI·문서 의미 일치

| 계약 | code/API/UI/docs 판정 |
|---|---|
| Dashboard mode | polling/hybrid/sse와 fail-closed 기본값 일치 |
| event payload | change notification만 전송하고 canonical data는 REST refetch |
| static binding | PINNED_AT_START 기본, LATEST_PER_BATCH opt-in, backfill disabled |
| lifecycle | start/pause/resume/stop/recover와 commandId/generation/fence 일치 |
| publication | output_committed → catalog_ready → dashboard_ready 순서 일치 |
| rollback | polling/disabled, additive table/checkpoint/output 보존 일치 |

## before/after 운영 지표

구현 전 production baseline과 실제 canary 수치가 제공되지 않았으므로 latency·memory·FD 개선률은 계산하지 않는다. 다음 항목은 canary에서 동일 부하로 before/after를 기록해야 한다.

- Dashboard freshness polling request/분
- event delivery/replay/resync/fallback 수와 p50/p95 lag
- connection 수, FD, memory, max subscriber queue depth
- Continuous batch latency, input/output row, Kafka lag, checkpoint age
- Iceberg commit 빈도, file 수와 compaction 전후 logical row count

측정값이 없는 상태에서 정적 test 통과를 capacity 증거로 사용하지 않는다.

## production enablement No-Go 항목

| 우선순위 | 항목 | Owner | 완료 시점 |
|---|---|---|---|
| P0 | 실제 Continuous SQL INNER/LEFT JOIN, static update, worker restart, duplicate batch 검증 | data runtime owner | production flag enable 전 |
| P0 | 실제 ALB/CDN heartbeat와 browser reconnect/fallback/request-count 검증 | platform + frontend owner | production flag enable 전 |
| P0 | rolling backend restart 또는 multi-worker listener catch-up 검증 | backend + platform owner | production flag enable 전 |
| P0 | canary와 polling/disabled rollback drill | release owner | production flag enable 전 |
| P0 | tenant-scoped canary 부재를 격리 deployment로 수용할지 결정 | product/security/platform | production canary 전 |
| P1 | connection/event storm, slow client, FD/memory capacity baseline | platform owner | 전면 활성화 전 |
| P1 | retention, snapshot expiration, compaction schedule과 alert threshold 확정 | data runtime owner | 전면 활성화 전 |

## 최종 결론

4개 stacked PR의 코드·계약·회귀 방지·rollback 문서는 merge 가능한 상태로 준비한다. 다만 로컬 Docker daemon 부재와 실제 production-like evidence 미확보 때문에 production에서 SSE 또는 Continuous SQL flag를 켜는 것은 No-Go다. PR merge 후 CI 성공, 격리 canary, fault/restart와 rollback drill이 모두 확인된 뒤에만 [runbooks/canary-rollout.md](runbooks/canary-rollout.md)의 다음 단계로 승격한다.
