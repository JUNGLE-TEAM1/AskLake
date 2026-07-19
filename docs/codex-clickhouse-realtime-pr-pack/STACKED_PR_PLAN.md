# ClickHouse Realtime Serving V2 9-PR 실행 매핑

이 문서는 `docs/ASKLAKE_CLICKHOUSE_REALTIME_IMPLEMENTATION_SPEC.md`를 최신 `dev`의 Realtime 2026 구현 위에 순차 적용하는 merge 계획이다.

기존 `docs/codex-realtime-pr-pack/STACKED_PR_PLAN.md`의 STACK-01~04는 이미 구현된 기준선이다. durable SSE, Continuous SQL V1, Kafka Engine 기반 opt-in ClickHouse JOIN을 다시 구현하지 않는다. 아래 PR은 그 기준선을 보존하면서 Kafka Connect canonical ingest, 데이터 정합성, versioned dimension, dual binding, archive parity를 추가한다.

## PR 순서

| 순서 | 이슈/브랜치 유형 | 제목 | 핵심 산출물 | merge 전 필수 조건 |
| ---: | --- | --- | --- | --- |
| 01 | `documentation` / `docs-#<issue>` | 실시간 ClickHouse 구현 계약 확정 | Source of Truth 동기화, V1→V2 transition, gap baseline | 문서 drift와 현재 회귀 기준 확인 |
| 02 | `feature` / `feat-#<issue>` | ClickHouse·Kafka Connect 기반시설과 migration | pinned ClickHouse 26.3 LTS, Kafka Connect, Alembic expand migration, flags/health | PR01 merge, disabled-mode 회귀 통과 |
| 03 | `feature` / `feat-#<issue>` | raw ingest·receipt audit·멱등성 | opaque envelope, source position, receipt ranges, DLQ/quarantine, stable retry | PR02 merge, restart/rebalance/gap fixture 통과 |
| 04 | `feature` / `feat-#<issue>` | versioned dimension·late repair | current/temporal dimension, INNER hold, LEFT correction, repair/quarantine | PR03 merge, temporal overlap/late arrival 검증 |
| 05 | `feature` / `feat-#<issue>` | SQL compiler·realtime materializer | execution mode classifier, ClickHouse compiler, serving_current, batch/checkpoint transaction | PR04 merge, 3-way JOIN·split failure 검증 |
| 06 | `feature` / `feat-#<issue>` | Catalog dual binding·revision event log | physicalBindings, 기존 freshness/revision 확장, bindingEpoch, durable log schema v2 | PR05 merge, idempotent publication 검증 |
| 07 | `feature` / `feat-#<issue>` | Dashboard ClickHouse query·SSE | bounded query adapter, mutation-aware refetch, replica cursor, permission recheck | PR06 merge, multi-replica replay·ACL 검증 |
| 08 | `feature` / `feat-#<issue>` | frontend live cache·오류 UX·legacy 제거 | Dataset cursor cache, freshness UX, route race 방지, live mock 차단 | PR07 merge, browser targeted refetch 검증 |
| 09 | `feature` / `feat-#<issue>` | archive parity·rebuild·cutover·전체 E2E/CI | Bronze/Gold parity, boundary-safe rebuild, canary/rollback, required gates | PR08 merge, full-stack/rollback evidence |

## 2026-07-18 생성 상태

아래 PR은 모두 직전 branch HEAD에서 만든 누적 stack이며 base는 `dev`, 상태는 Ready, merge는 수행하지 않았다.

| 순서 | Issue | Branch | PR |
| ---: | ---: | --- | ---: |
| 01 | #948 | `docs-#948` | #951 |
| 02 | #952 | `feat-#952` | #959 |
| 03 | #960 | `feat-#960` | #963 |
| 04 | #964 | `feat-#964` | #965 |
| 05 | #966 | `feat-#966` | #968 |
| 06 | #969 | `feat-#969` | #970 |
| 07 | #971 | `feat-#971` | #973 |
| 08 | #974 | `feat-#974` | #976 |
| 09 | #977 | `feat-#977` | 이 branch의 Ready PR |

PR09 local integration은 54개 V2 release contract, PostgreSQL concurrent switch, ClickHouse 100-position parity, backend 831 tests, frontend 144 checks와 deploy 58 checks를 통과했다. 실제 production 10만 건, 72시간 shadow, browser cutover/rollback DOM, chaos/HA/backup은 미실행 operator gate이며 merge 조건을 자동 충족한 것으로 표시하지 않는다.

## 브랜치와 GitHub PR 규칙

1. PR01은 최신 `origin/dev`에서 시작한다.
2. PR02~09는 직전 PR branch의 HEAD에서 만든 누적 branch다.
3. 모든 GitHub PR base는 사용자 요청과 보호 브랜치 정책에 따라 `dev`다.
4. 모든 PR은 Ready로 생성하되 제목과 본문 첫 부분에 `Depends on PR #<previous>`를 명시한다.
5. 선행 PR이 merge되기 전 후속 PR을 merge하지 않는다.
6. 선행 PR merge 뒤 다음 branch에 최신 `origin/dev`를 merge해 GitHub diff를 축소한다. 이미 공개한 누적 branch를 rebase/force-push하지 않는다.
7. 동기화 merge 뒤 changed files, conflict, required checks와 실제 PR diff를 다시 확인한다.
8. 각 PR은 자기 이슈만 `Closes #<issue>`로 닫는다.

## 호환성과 rollback 원칙

- 기존 Kafka Engine ClickHouse V1은 PR02~08 동안 compatibility flag 뒤에 유지한다.
- Kafka Connect V2를 켜더라도 같은 Job generation에서 Kafka Engine과 동시에 consumer ownership을 갖지 않는다.
- 신규 DB는 expand-only migration으로 추가하며 구버전 코드는 새 table/column을 무시할 수 있어야 한다.
- `CLICKHOUSE_REALTIME_V2_ENABLED=false`이면 기존 Realtime 2026 동작이 그대로 유지돼야 한다.
- production deploy, traffic promotion, 기존 table/drop, consumer group offset reset은 이 9개 PR의 자동 실행 범위가 아니다.
- rollback은 pointer/feature flag 전환으로 수행하고 ClickHouse raw/serving evidence를 자동 삭제하지 않는다.

## 검증 프로필

| 단계 | 필수 검증 |
| --- | --- |
| 모든 PR | conflict marker, docs/API drift, backend unit/compile, 영향받은 frontend build/test |
| PR02~03 | Compose render, connector health, Kafka position/restart/rebalance/idempotency |
| PR04~05 | dimension/SQL classifier/materializer unit과 ClickHouse integration |
| PR06~07 | PostgreSQL concurrency, event-log replay, permission, Dashboard API/SSE |
| PR08 | frontend component/browser contract와 production mock fail-closed |
| PR09 | isolated full-stack E2E, chaos, hot/archive parity, cutover/rollback drill |

검증을 실행하지 못한 항목은 통과로 기록하지 않는다. 이 원칙은 9개 PR 작성 당시 플래그를 `false`로 유지한 기준이며, 누적 PR09 병합 뒤 production Compose 기본값은 별도 V2 전환 변경에서 활성화됐다.
