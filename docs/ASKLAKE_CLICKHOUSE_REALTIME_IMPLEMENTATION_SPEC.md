# AskLake ClickHouse 실시간 JOIN · Catalog · Dashboard 전면 구현 명세서

## 0. 문서 제어

| 항목 | 값 |
| --- | --- |
| 문서 상태 | Approved Implementation Specification / 순차 구현 기준 |
| 작성일 | 2026-07-18 |
| 적용 저장소 | AskLake |
| 적용 범위 | Kafka 수집, ClickHouse 실시간 JOIN, Catalog, Dashboard SSE, Spark/Iceberg archive, 운영·테스트·마이그레이션 |
| 기준 브랜치 | `dev` at `f5322efc`, 계약 PR `docs-#948` |
| 구현 브랜치 원칙 | main 직접 push 금지, Phase별 feature/fix/test/docs/chore 브랜치와 PR 사용 |
| 우선순위 | P0 |
| 최종 목표 | produce → JOIN → Catalog revision → SSE → browser widget render를 하나의 검증 가능한 사용자 흐름으로 제공 |

이 문서는 구현 작업을 시작하기 위한 상세 명세다. 현재 저장소의 source-of-truth 우선순위를 변경하지 않는다. 구현 Phase가 시작될 때 반드시 아래 상위 문서를 먼저 또는 같은 PR에서 동기화해야 한다.

1. docs/01-product-planning.md
2. docs/02-architecture.md
3. docs/03-api-reference.md
4. docs/04-development-guide.md
5. docs/system-guardrails.md
6. README.md
7. docs/api-contract.md
8. docs/backend-integration-readiness.md
9. docs/minio-100gb-spark-harness.md

이 명세와 상위 문서가 충돌하면 상위 문서를 따른다. 구현 PR은 충돌을 남긴 채 병합할 수 없다.

### 0.1 최신 dev 기준선

2026-07-18 `dev`에는 Realtime 2026 STACK-01~04가 이미 병합돼 있다.

- PostgreSQL `realtime_event_log`, NOTIFY wake-up, cursor replay와 Dashboard hybrid/SSE client가 존재한다.
- Continuous SQL V1은 streaming relation 1개와 static Iceberg relation N개의 INNER/LEFT equality JOIN을 지원한다.
- opt-in `servingMode=clickhouse`는 Kafka Engine, RawBLOB ingest, typed raw, pinned static table, JOIN MV, output ReplacingMergeTree와 Dashboard `FINAL` reader를 제공한다.
- `dataset_freshness`, `dataset_revision_commits`, `dataset_kafka_partition_cursors`, `dashboard_widget_results`가 기존 publication source of truth다.
- 운영 기본값은 polling/disabled이고 기존 Iceberg mode가 계속 canonical compatibility path다.

따라서 이 문서는 무(無)에서 ClickHouse를 추가하는 계획이 아니라 위 기준선을 production-grade V2로 확장하는 계획이다. 기존 구현을 삭제하거나 같은 기능을 두 번째 subsystem으로 복제하지 않는다.

### 0.2 V1 → V2 전환 원칙

1. Kafka Engine V1은 Kafka Connect V2의 restart/rebalance/parity gate가 통과할 때까지 compatibility flag 뒤에 유지한다.
2. 한 Job generation의 consumer ownership은 V1 또는 V2 중 하나만 가진다. 같은 consumer group dual-run은 금지한다.
3. 기존 `clickhouseTable`과 신규 `physicalBindings.serving`은 expand migration 동안 함께 읽을 수 있게 한다. 신규 writer는 V2 flag가 켜진 Dataset부터 dual-write하고 기존 field를 즉시 제거하지 않는다.
4. 기존 `realtime_event_log`를 durable event source로 확장한다. 별도 competing outbox를 만들지 않는다.
5. 기존 `dataset_freshness`와 `dataset_revision_commits`를 확장한다. 별도 public revision 체계를 만들지 않는다.
6. 모든 V2 flag가 꺼지면 현재 `dev`의 ClickHouse V1, Iceberg Continuous, polling/SSE 의미가 바뀌지 않아야 한다.
7. 실제 PR 매핑과 merge 순서는 `docs/codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md`가 소유한다.
8. 현재 저장소에는 tenant model이 없으므로 모든 V2 row와 권한 경계는 기존 `scope_id="deployment"`와 resource ACL을 사용한다. tenant 도입은 별도 선행 ADR·migration 없이는 이 작업에 포함하지 않는다.

---

## 1. 결론과 확정 결정

### 1.1 구현 가능성

사용자가 기대하는 다음 흐름은 구현 가능하다.

    Kafka click event
      → ClickHouse hot ingest
      → 등록·검증·버전화된 JOIN 규칙
      → dashboard serving table
      → Catalog serving revision
      → SSE invalidation
      → 영향받은 widget만 재조회

    동일 Kafka topic
      → 별도 Spark consumer group
      → S3/Iceberg durable archive
      → Trino backfill, 감사, 재처리

단, 임의 SQL을 이벤트마다 무제한 실행하는 구조는 허용하지 않는다. SQL은 파싱된 AST 기준으로 실행 모드를 분류하고, 지원 범위에 따라 아래 셋 중 하나로 배포한다.

| 실행 모드 | 대상 | 엔진 | 사용자 표시 |
| --- | --- | --- | --- |
| realtime_incremental | append-only fact + 준비된 N:1 dimension JOIN | ClickHouse incremental materializer | 실시간 |
| near_realtime_refresh | 복잡한 다중 JOIN 또는 변경 가능한 양쪽 테이블 | ClickHouse refreshable job 또는 Trino full refresh | 주기 갱신 |
| streaming_required | stream-stream JOIN, watermark, retraction, 긴 event-time window | Spark Structured Streaming, 후속 필요 시 Flink | 스트리밍 처리 |

이 프로그램에서 `streaming_required`는 classifier 결과만 반환하며 `supported=false`다. 현재 Spark V1이 stream-stream/window/retraction을 자동 배포한다고 해석하지 않고 별도 제품·runtime 계약으로 보낸다.

### 1.2 핵심 아키텍처 결정

1. ClickHouse는 재구축 가능한 hot serving store다.
2. S3/Iceberg는 장기 원본, 감사, backfill의 durable source다.
3. PostgreSQL은 Dataset/Catalog metadata, pipeline version, materializer checkpoint, revision, 기존 durable event log의 source of truth다.
4. Kafka는 hot path와 archive path를 분기하는 fan-out 경계다. 두 경로는 서로 다른 consumer group을 사용한다.
5. Click event를 realtime JOIN의 유일한 driving stream으로 둔다.
6. user, product, meta 데이터는 versioned dimension으로 취급한다.
7. 전달은 at-least-once를 가정하고 출력은 논리적 멱등성을 보장한다.
8. SSE는 데이터 자체가 아니라 revision invalidation만 전달한다.
9. 브라우저는 ClickHouse에 직접 연결하지 않는다. 모든 권한 및 query budget은 FastAPI가 집행한다.
10. live 환경에서 mock/legacy fallback은 성공 응답으로 위장할 수 없다.

### 1.3 Kafka → ClickHouse 수집 결정

운영 canonical 경로는 공식 ClickHouse Kafka Connect Sink를 사용한다. 동일 connector를 local Compose, CI integration, staging, production에서 사용해 환경별 구현 차이를 만들지 않는다.

이 선택의 이유:

- ClickHouse Kafka Engine의 Keeper offset 저장은 공식 문서상 experimental이며 production-ready가 아니다.
- Connector는 Kafka partition별 순서를 유지하고 exactly-once 옵션을 제공한다.
- topic, partition, offset metadata를 표준 Kafka Connect transform으로 row에 포함할 수 있다.
- connector lag, retry, DLQ를 독립적으로 관찰할 수 있다.

기존 Kafka Engine V1은 전환 검증 기간에 compatibility flag 뒤에서만 유지한다. V2 cutover 뒤에는 같은 Job generation의 active consumer나 영구적인 두 번째 canonical 경로로 남기지 않는다. ClickHouse Cloud로 전환하는 별도 ADR이 승인되면 ClickPipes로 교체할 수 있다.

Connector 배포 계약:

- exactlyOnce=true를 활성화하고 connector가 지원하지 않는 조합이면 시작을 거부한다.
- exactly-once 옵션은 전송량과 일반 retry를 줄이는 최적화다. 시스템 정확성의 유일한 근거로 사용하지 않는다.
- 정확성은 고정된 connector identity, 보존된 source position, ClickHouse insert quorum, stable insert token, contiguous receipt ledger와 deterministic retry의 조합으로 보장한다.
- topic별 destination table mapping은 version-controlled 설정으로 관리한다.
- Kafka topic, partition, offset, timestamp를 raw row에 포함한다.
- raw sink는 payload를 opaque bytes/string envelope로 먼저 durable 저장하고 application schema decode/validation은 그 다음 단계에서 수행한다. converter 단계에서 원문을 잃는 설정을 금지한다.
- schema mismatch는 조용히 skip하지 않고 DLQ와 metric에 기록한다.
- errors.tolerance=all을 단독으로 사용해 유실을 숨기는 설정을 금지한다.
- connector 설정 API와 secret은 backend 운영 계정만 접근한다.
- connector upgrade 전 동일 fixture로 restart/rebalance/idempotency 검증을 수행한다.

### 1.4 ClickHouse 버전 기준

- 최소 기능 기준은 26.3 LTS다.
- 이미지 태그 latest 사용을 금지한다.
- staging soak를 통과한 exact patch version과 image digest를 deploy 파일에 고정한다.
- 버전 변경 PR은 Kafka ingest, dependent materialization, restart, dedupe, backup/restore 검증을 포함한다.

---

## 2. 현재 문제와 요구사항 추적

| ID | 현재 문제 | 사용자 증상 | 필수 해결 |
| --- | --- | --- | --- |
| GAP-01 | Kafka Engine V1은 connector DLQ/receipt audit가 없음 | parser poison 또는 offset gap의 완료 의미가 약함 | Kafka Connect V2 + bounded receipt audit |
| GAP-02 | Continuous SQL V1은 pinned static snapshot만 지원 | mutable/versioned dimension과 과거 correction이 없음 | versioned dimension + correction policy |
| GAP-03 | JOIN output dedupe가 `FINAL` reader와 partition/offset에 집중 | late correction/retract 및 stable retry token 계약이 없음 | serving key, row version, canonical current view |
| GAP-04 | Catalog가 `clickhouseTable`과 Iceberg `queryEngineTable`을 별도 단일 field로 노출 | serving/archive 상태와 boundary를 한 응답에서 비교하기 어려움 | additive `physicalBindings` dual binding |
| GAP-05 | revision이 append 중심이며 binding 변경 epoch가 없음 | rollback 뒤 낮은 내부 revision을 client가 stale로 볼 수 있음 | mutation type + bindingEpoch |
| GAP-06 | durable SSE는 구현됐지만 V2 binding/mutation cursor를 모름 | cutover/repair 시 targeted refetch 의미가 불완전 | 기존 event log schema additive 확장 |
| GAP-07 | Dashboard live compatibility fallback이 남아 있음 | live 실패가 이전 값 또는 local 경로로 가려질 수 있음 | stale/degraded 명시와 production mock fail-closed |
| GAP-08 | ClickHouse V1과 Iceberg mode가 archive parity contract를 공유하지 않음 | hot 결과를 같은 JOIN 의미로 복구하기 어려움 | Bronze source + Gold archive projection/parity |
| GAP-09 | 일부 runtime schema 보강이 startup DDL에 의존 | 환경별 metadata drift 가능 | Alembic expand migration 의무화 |
| GAP-10 | 실제 browser rollback과 multi-partition poison/rebalance E2E가 없음 | 부분 suite 통과 후에도 cutover 실패 가능 | isolated full browser/fault hard gate |
| GAP-11 | V1 static snapshot은 future-only 의미 | late dimension repair와 temporal range validation 없음 | INNER hold/LEFT correction, overlap guard |
| GAP-12 | 현재 correlation ID는 있으나 materialization/binding evidence가 전 구간에 동일하지 않음 | hot/archive/cutover 장애 상관관계가 끊김 | materializationId + bindingEpoch + boundary 전파 |

---

## 3. 범위와 비범위

### 3.1 이번 프로그램의 범위

- ClickHouse local/staging/production 배포
- Kafka → ClickHouse hot ingest
- raw event 및 versioned dimension schema
- 등록 SQL 검증, 분류, versioning, deployment
- realtime incremental JOIN materializer
- late dimension pending 및 repair
- near-realtime refreshable mode
- Catalog archive/serving dual physical binding
- Dataset revision과 기존 transactional event log append
- FastAPI ClickHouse widget query adapter
- SSE endpoint와 frontend invalidation
- stale/error/freshness UI
- Spark/Iceberg archive 독립 운영과 parity 검증
- shadow, canary, cutover, rollback
- 전체 integration/browser/chaos/load/security CI gate
- legacy/mock/fallback 정리
- God service 분리와 정식 migration

### 3.2 명시적 비범위

- 브라우저에서 ClickHouse 직접 접속
- arbitrary DDL/DML 실행
- 무제한 CROSS JOIN, FULL OUTER JOIN, 비등가 JOIN
- 무제한 stream-stream state 저장
- ClickHouse를 durable archive의 유일한 source로 승격
- ClickHouse와 Iceberg를 하나의 분산 transaction으로 묶기
- 첫 릴리스에서 다중 region active-active
- ClickHouse Cloud 도입
- 제품 UI에서 사용자가 raw ClickHouse credential 입력

---

## 4. 목표 사용자 흐름

### 4.1 실시간 파이프라인 생성

1. 사용자가 Kafka click Dataset과 Catalog의 user/meta dimension Dataset을 선택한다.
2. SQL 편집기에서 JOIN SQL을 작성하거나 추천 JOIN을 적용한다.
3. frontend가 validate API를 호출한다.
4. backend가 SQLGlot AST로 read-only, scope, key, cardinality, 함수, 시간 의미를 검사한다.
5. backend가 executionMode와 거부 사유 또는 예상 비용을 반환한다.
6. 사용자가 realtime_incremental 또는 near_realtime_refresh를 명시적으로 확인한다.
7. backend가 immutable pipeline version을 만든다.
8. shadow table과 materializer를 배포하고 backfill boundary까지 채운다.
9. source/serving parity와 sample 결과를 검증한다.
10. Catalog pointer를 active version으로 전환한다.
11. published Dashboard widget이 serving Dataset을 선택한다.
12. 새 click event가 들어오면 새 revision이 SSE로 전달되고 widget만 갱신된다.

### 4.2 장애 시 사용자 흐름

1. serving revision이 목표 시간 안에 전진하지 않으면 화면에 지연 상태를 표시한다.
2. 마지막 성공 값은 표시할 수 있으나 반드시 stale badge, appliedRevision, latestKnownRevision, lastSuccessfulAt, errorCode를 함께 표시한다.
3. 권한 오류는 retry하지 않고 즉시 접근 불가로 전환한다.
4. transient 오류는 server hint에 따른 backoff와 jitter를 사용한다.
5. 자동 복구 실패 시 운영자는 materializationId로 replay/reconcile을 실행한다.

---

## 5. 성능·신뢰성 SLO

모든 시간은 정상 부하, warm service, 동일 region 기준이다.

| SLI | 목표 |
| --- | --- |
| Kafka produce → ClickHouse raw durable P50 | 1초 이하 |
| Kafka produce → ClickHouse raw durable P95 | 2초 이하 |
| raw durable → joined serving commit P95 | 2초 이하 |
| serving commit → PostgreSQL revision/event-log P95 | 1초 이하 |
| SSE revision → widget render P95 | 1초 이하 |
| Kafka produce → browser render end-to-end P95 | 5초 이하 |
| end-to-end P99 | 10초 이하 |
| logical data loss | 0 |
| 동일 source position + rule version 논리 중복 | 0 |
| revision 역행 | 0 |
| 권한 철회 후 새 event 수신 허용 시간 | 5초 이하 |
| monthly hot path availability 목표 | 99.9% |
| archive offset 수렴 | 정상 시 5분 이하 |
| SSE heartbeat | 15초 |
| SSE replay retention | 최소 24시간 또는 최근 100,000 event 중 큰 범위 |

초기 capacity 기준은 별도 부하 측정 전 다음으로 고정한다.

- click event 1,000 EPS sustained
- 5,000 EPS 10분 burst
- event 평균 2 KiB
- dimension 합계 5,000,000 row
- published Dashboard 100개
- 동시 SSE 연결 500개
- 한 pipeline의 active JOIN 최대 3개

기준을 넘는 요구는 load test 결과와 capacity ADR을 먼저 갱신한다.

---

## 6. 목표 아키텍처

    Producers
       |
       v
    Kafka / Redpanda topics
       |
       +-------------------------------+
       |                               |
       v                               v
    ClickHouse Kafka Connect        Spark Structured Streaming
    group: asklake-hot-*            group: asklake-archive-*
       |                               |
       v                               v
    ch_raw_events                   S3 / Iceberg archive
       |                               |
       |  realtime-materializer        v
       +-------------------------->  Trino / backfill / audit
       |   JOIN versioned dims
       v
    ch_serving_joined_events
       |
       | commit evidence
       v
    FastAPI reconcile
       |
       +--> PostgreSQL revision + realtime_event_log
       |          |
       |          v
       |       SSE notifier
       |          |
       v          v
    Catalog API  Browser EventSource
       |          |
       +------> widgets/query
                  |
                  v
               ClickHouse bounded query

### 6.1 컴포넌트 소유권

| 컴포넌트 | 책임 | 상태 source of truth |
| --- | --- | --- |
| Kafka | 원본 event fan-out | topic/partition/offset |
| ClickHouse Connect | hot ingest와 DLQ | connector offsets/status |
| ClickHouse raw | hot 원본과 source position | MergeTree rows |
| Dimension publisher | dimension snapshot/version 게시 | PostgreSQL deployment + ClickHouse version |
| Realtime materializer | bounded incremental JOIN | PostgreSQL checkpoint/lease |
| ClickHouse serving | dashboard query 결과 row | deterministic serving key |
| PostgreSQL | pipeline metadata, checkpoint, revision, durable event log | relational transaction |
| SSE notifier | revision 전달과 replay | realtime_event_log sequence |
| FastAPI query adapter | 권한·budget·ClickHouse query | request/response contract |
| Spark/Iceberg | durable 원본·dimension history·동일 JOIN archive projection과 재처리 | Iceberg snapshot |
| Trino | archive query/backfill/parity | query run |
| Frontend cache | server state view와 invalidation | backend response revision |

### 6.2 금지되는 결합

- frontend가 ClickHouse table 이름이나 credential을 구성하지 않는다.
- materializer가 React/Dashboard 상태를 직접 갱신하지 않는다.
- ClickHouse query request 중 PostgreSQL row lock을 유지하지 않는다.
- 외부 ClickHouse/Kafka/S3 I/O를 PostgreSQL transaction 안에서 수행하지 않는다.
- repository 메서드가 상위 service 모르게 commit하지 않는다.
- live 실패를 mock/local 성공으로 바꾸지 않는다.

---

## 7. 데이터 의미와 멱등성

### 7.1 Source position

모든 Kafka event는 다음 identity를 보존한다.

    source_position = {
      topic,
      partition,
      offset
    }

논리 event key:

    event_key = SHA256(scope_id | topic | partition | offset)

serving key:

    serving_key = SHA256(dataset_id | pipeline_version_id | topic | partition | offset)

source boundary fingerprint:

    source_fingerprint = SHA256(pipeline_version_id | sorted(topic, partition, fromExclusive, toInclusive))

같은 serving key의 retry는 새 논리 row를 만들지 않는다.

### 7.2 Timestamp

- eventTime: producer가 생성한 business event time
- kafkaTimestamp: Kafka record timestamp
- ingestedAt: ClickHouse raw insert time
- materializedAt: serving commit time
- publishedAt: PostgreSQL revision/event-log commit time

화면에는 event freshness와 system freshness를 구분해 표시한다.

### 7.3 Delivery semantics

- Kafka → ClickHouse 전달은 connector exactly-once 설정을 활성화한다.
- 시스템 전체는 외부 장애를 고려해 at-least-once로 방어한다.
- connector exactly-once는 correctness 전제조건이 아니라 최적화다. connector 재생성, rebalance, ClickHouse 응답 유실 뒤에도 아래 멱등 계약이 성립해야 한다.
- raw 및 serving row는 deterministic key로 논리 멱등성을 보장한다.
- ReplacingMergeTree background merge만을 correctness 경계로 사용하지 않는다.
- materializer input query는 source position별 최신 row 하나만 선택한다.
- aggregate, parity, checksum과 widget query는 반드시 canonical `serving_current` dedupe view 위에서 계산한다.
- 같은 source boundary retry는 같은 materializationId, sourceFingerprint, ClickHouse query ID와 `insert_deduplication_token`을 재사용한다.
- quorum insert가 성공했으나 응답을 잃은 경우 target의 materializationId/sourceFingerprint를 먼저 확인하고 동일 token으로만 재시도한다.
- 첫 릴리스에서 duplicate-sensitive pre-aggregate table을 correctness source로 사용하지 않는다.

### 7.4 Watermark

materializer checkpoint는 pipeline version과 Kafka partition별로 저장한다.

    {
      pipelineVersionId,
      topic,
      partition,
      lastAppliedOffsetInclusive,
      lastObservedOffsetInclusive,
      updatedAt
    }

처리 batch는 각 partition에서 다음 경계를 사용한다.

    fromOffsetExclusive = lastAppliedOffsetInclusive
    toOffsetInclusive = min(
      lastContiguouslyReceivedOffsetInclusive,
      lastAppliedOffsetInclusive + maxOffsetsPerBatch
    )

서로 다른 partition을 하나의 scalar watermark로 합치지 않는다.

`MAX(kafka_offset)`만으로 수신 완료를 판정하지 않는다. partition별 receipt ledger가 `lastAppliedOffsetInclusive + 1`부터 연속임을 증명한 마지막 offset만 `lastContiguouslyReceivedOffsetInclusive`가 될 수 있다. 중간 gap이 있으면 그 앞까지만 처리하고 checkpoint는 gap을 건너지 않는다.

- schema/transform 실패 record도 receipt ledger에 상태를 남긴다.
- poison record는 quarantine 저장, 원문 hash, 오류 코드와 운영자 승인 audit가 모두 있는 `audited_skip` 전에는 완료 offset으로 간주하지 않는다.
- 자동 skip은 금지한다. replay 성공은 정상 receipt로 바꾸고, audited skip은 데이터 손실 SLI와 별도 보안 audit에 집계한다.
- connector identity 변경과 partition rebalance 후에도 source position receipt를 재사용하며 checkpoint를 추정하거나 reset하지 않는다.

### 7.5 Dimension 의미

dimension은 다음 둘 중 하나다.

1. current lookup dimension
   - key당 최신 상태
   - 현재 user 지역, 현재 product category 같은 as-is 분석
   - Dictionary 또는 versioned ReplacingMergeTree 사용 가능

2. temporal dimension
   - validFrom, validTo로 eventTime 당시 상태 보존
   - ASOF 또는 명시적 range predicate 사용
   - as-was 분석

pipeline version은 어떤 의미를 사용하는지 반드시 기록한다.

temporal dimension version을 배포할 때 같은 deployment scope와 dimension key에 겹치는 `[validFrom, validTo)` 구간이 하나라도 있으면 배포를 거부한다. 사용한 `dimensionVersionId` 집합은 모든 serving row와 materialization evidence에 저장한다.

### 7.6 Late dimension

JOIN에 필요한 dimension이 없으면 event를 버리지 않는다. 각 JOIN은 pipeline version에 `missingPolicy`를 고정한다.

- INNER JOIN 기본값은 `hold_and_repair`다. row를 아직 serving에 게시하지 않고 unmatched queue에 보존한다.
- LEFT JOIN 기본값은 `publish_null_then_correct`다. NULL dimension row를 즉시 게시하고, dimension 도착 시 같은 serving key의 높은 correction generation으로 교정한다.
- 사용자가 위 의미를 바꾸는 암묵적 기본값은 금지하며 validate 응답과 UI에 정책을 표시한다.
- realtime_unmatched_events에 event key, source position, missing dimension Dataset/key index, raw payload hash, archive locator, firstSeenAt, retryCount, nextRetryAt를 저장한다.
- 기본 repair window: 24시간
- exponential backoff 상한: 10분
- dimension version이 게시되면 영향받은 key를 즉시 재시도
- repair 성공 시 동일 serving key, 증가한 correction generation, 실제 사용한 dimensionVersionId로 insert하고 `upsert` revision을 생성
- repair window 만료 시 terminal quarantine으로 이동하되 운영자 replay 가능
- ClickHouse raw TTL이 지난 replay는 archive locator와 source position으로 Iceberg 원본을 복구한다. archive에도 없으면 자동 성공 처리하지 않고 `source_expired` terminal 상태와 운영 alert를 남긴다.

### 7.7 Dimension correction

오른쪽 dimension 변경은 과거 incremental result를 자동으로 고치지 않는다. 다음 정책 중 하나를 pipeline에 고정한다.

- future_only: 변경 이후 새 event에만 적용
- bounded_repair: 최근 N시간 event 재계산
- full_rebuild: 전체 serving version을 shadow table로 재구축

정책 기본값은 bounded_repair 24시간이다. 비용 estimate가 guardrail을 넘으면 사용자 확인이 필요하다.

`row_version`은 `(pipeline_generation << 32) | correction_generation`으로 생성한다. pipeline_generation은 pipeline version 생성 시 PostgreSQL sequence로 단조 할당하고 correction_generation은 serving key별 0부터 단조 증가한다. 같은 materialization retry는 두 값을 바꾸지 않는다.

---

## 8. 지원 SQL 계약

### 8.1 Parser와 compiler

- 기존 SQLGlot dependency를 사용한다.
- 공통 AST validation과 ClickHouse dialect compiler를 분리한다.
- 문자열 regex만으로 SQL 안전성을 판정하지 않는다.
- validation 결과에는 normalizedSql, fingerprint, executionMode, referencedDatasetIds, joinKeys, warnings, estimatedCost를 포함한다.

### 8.2 realtime_incremental 허용 범위

- 단일 SELECT
- click fact를 left-most driving relation으로 사용
- INNER JOIN 또는 LEFT JOIN
- 등가 JOIN key
- 승인된 Catalog dimension만 참조
- fact 1개와 dimension 최대 3개
- projection, rename, cast, CASE, 승인된 deterministic scalar function
- WHERE predicate
- eventTime 기준 승인된 fixed bucket
- 제한된 GROUP BY는 serving fact 다음 query 단계에서 수행

### 8.3 거부 범위

- INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE
- CROSS JOIN
- FULL OUTER JOIN
- arbitrary non-equi JOIN
- unbounded subquery
- system database 접근
- URL, file, s3, remote, jdbc 같은 외부 table function
- sleep, benchmark 및 resource abuse 함수
- nondeterministic function을 identity 또는 JOIN key에 사용
- deployment/resource scope를 우회하는 predicate
- schema에 없는 identifier
- 선택되지 않은 Dataset 참조

### 8.4 실행 모드 분류

| 조건 | 모드 |
| --- | --- |
| fact insert가 유일 trigger이고 dimension이 준비된 N:1 lookup | realtime_incremental |
| right side 변화가 과거 결과에 즉시 반영돼야 함 | near_realtime_refresh 또는 bounded repair |
| 양쪽이 독립적으로 빠르게 변함 | streaming_required |
| event-time window/retraction 필요 | streaming_required |
| 비용 guardrail 초과 | rejected 또는 승인 후 near_realtime |

### 8.5 Pipeline version lifecycle

    draft
      → validating
      → shadow_building
      → shadow_ready
      → active
      → draining
      → retired

실패 상태:

    validation_failed
    deployment_failed
    degraded
    rollback_required

active version은 Dataset당 정확히 하나다. 이전 version은 rollback retention 동안 보존한다.

---

## 9. ClickHouse 물리 schema

아래 DDL은 의미 계약 예시다. 실제 migration은 exact type과 partition cardinality를 부하 테스트로 확정한다.

### 9.1 Raw click envelope와 decoded projection

connector의 첫 durable insert는 원문 envelope와 Kafka metadata만 요구한다. decode worker는 안전한 parser로 같은 source position에 더 높은 ingest_version row를 넣고 typed column과 decode_status를 채운다. 원문이 decode되지 않아도 raw receipt는 남으며, materializer는 `decode_status=decoded` 또는 승인된 audited skip까지만 처리한다.

    CREATE TABLE asklake_hot.raw_click_events
    (
      scope_id LowCardinality(String),
      dataset_id String,
      event_id Nullable(String),
      event_time Nullable(DateTime64(3, 'UTC')),
      user_id Nullable(String),
      product_id Nullable(String),
      event_type LowCardinality(Nullable(String)),
      amount Nullable(Decimal(18, 2)),
      payload_raw String,
      kafka_topic LowCardinality(String),
      kafka_partition UInt32,
      kafka_offset UInt64,
      kafka_timestamp DateTime64(3, 'UTC'),
      schema_version Nullable(UInt32),
      decode_status LowCardinality(String),
      decode_error_code Nullable(String),
      ingested_at DateTime64(3, 'UTC'),
      ingest_version UInt64
    )
    ENGINE = ReplicatedReplacingMergeTree(ingest_version)
    PARTITION BY toYYYYMM(coalesce(event_time, kafka_timestamp))
    ORDER BY
      (scope_id, dataset_id, kafka_topic, kafka_partition, kafka_offset);

### 9.2 Versioned dimension

    CREATE TABLE asklake_hot.dim_users_versioned
    (
      scope_id LowCardinality(String),
      dimension_dataset_id String,
      dimension_version_id String,
      user_id String,
      region LowCardinality(String),
      valid_from DateTime64(3, 'UTC'),
      valid_to Nullable(DateTime64(3, 'UTC')),
      published_at DateTime64(3, 'UTC'),
      row_version UInt64
    )
    ENGINE = ReplicatedReplacingMergeTree(row_version)
    PARTITION BY tuple()
    ORDER BY
      (scope_id, dimension_dataset_id, user_id, valid_from);

### 9.3 Joined serving fact

    CREATE TABLE asklake_serving.joined_click_events_v1
    (
      scope_id LowCardinality(String),
      serving_dataset_id String,
      pipeline_version_id String,
      serving_key FixedString(64),
      event_time DateTime64(3, 'UTC'),
      user_id String,
      region LowCardinality(String),
      product_id String,
      category LowCardinality(String),
      event_type LowCardinality(String),
      amount Nullable(Decimal(18, 2)),
      kafka_topic LowCardinality(String),
      kafka_partition UInt32,
      kafka_offset UInt64,
      materialization_id String,
      source_fingerprint FixedString(64),
      dimension_version_ids Map(String, String),
      correction_generation UInt32,
      is_deleted UInt8 DEFAULT 0,
      materialized_at DateTime64(3, 'UTC'),
      row_version UInt64
    )
    ENGINE = ReplicatedReplacingMergeTree(row_version)
    PARTITION BY toYYYYMM(event_time)
    ORDER BY
      (scope_id, serving_dataset_id, pipeline_version_id, serving_key);

ReplacingMergeTree merge 전에도 query 결과가 정확해야 하므로 다음 canonical view를 함께 만든다.

    CREATE VIEW asklake_serving.joined_click_events_v1_current AS
    SELECT * EXCEPT(is_deleted)
    FROM
    (
      SELECT *
      FROM asklake_serving.joined_click_events_v1 FINAL
    )
    WHERE is_deleted = 0;

Dashboard, parity, target row count, checksum, repair 검증은 base table을 직접 읽지 않고 반드시 `_current` view를 사용한다. `FINAL` 비용은 Phase 2 부하 시험에서 검증하고, 기준을 넘으면 동일 결과의 `argMax(..., row_version)` view 또는 compaction된 current table로 교체하되 공개 query 계약은 `serving_current`로 유지한다.

- 최초 정상 publish는 correction_generation=0이다.
- LEFT JOIN NULL 교정과 dimension correction은 같은 serving key에 더 높은 correction_generation을 사용한다.
- retract는 같은 serving key에 `is_deleted=1`과 더 높은 correction_generation을 기록한다. canonical current view만 이 tombstone을 제거한다.
- retry는 기존 materializationId, sourceFingerprint, row_version과 `insert_deduplication_token`을 그대로 사용한다.

### 9.4 Physical naming

- 사용자가 입력한 이름을 physical identifier로 직접 사용하지 않는다.
- table name은 deployment scope hash, dataset stable ID, pipeline version short ID로 생성한다.
- table comment에 logical Dataset ID와 pipeline version ID를 기록한다.
- Catalog가 logical → physical mapping의 유일한 공개 경계다.

### 9.5 TTL과 storage

- raw hot retention 기본값: 7일
- serving retention 기본값: 30일 또는 Dataset 정책
- archive는 Iceberg retention 정책을 따른다.
- TTL 삭제 전에 archive parity와 rebuild 가능성을 확인한다.
- Dataset별 retention은 governance와 cost estimate를 통과해야 한다.

---

## 10. PostgreSQL metadata와 migration

모든 table은 Alembic migration으로 생성한다. runtime startup의 CREATE/ALTER 보강 코드는 migration 완료 후 제거한다. 기존 `dataset_freshness`와 `dataset_revision_commits`가 공개 revision의 source of truth이므로, 별도 `dataset_serving_revisions`를 만들지 않고 두 table을 확장한다.

### 10.1 realtime_pipelines

주요 필드:

- id
- scope_id (`deployment` 고정, tenant foundation 도입 전까지 변경 금지)
- logical_dataset_id
- name
- execution_mode
- desired_state
- active_version_id
- owner_user_id
- created_at
- updated_at

### 10.2 realtime_pipeline_versions

- id
- pipeline_id
- version
- normalized_sql
- sql_fingerprint
- compiled_clickhouse_sql
- source_dataset_id
- reference_dataset_ids JSONB
- join_semantics JSONB
- correction_policy
- schema_fingerprint
- status
- created_by
- created_at
- activated_at

immutable row다. 수정은 새 version 생성으로만 수행한다.

### 10.3 realtime_pipeline_deployments

- id
- pipeline_version_id
- environment
- physical_database
- physical_table
- shadow_table
- deployed_sql_hash
- status
- deployed_at
- last_health_at
- last_error_code
- last_error_detail_safe

### 10.4 realtime_partition_checkpoints

- pipeline_version_id
- topic
- partition
- last_observed_offset
- last_applied_offset
- lease_owner
- lease_generation
- lease_expires_at
- updated_at

unique key는 pipeline_version_id, topic, partition이다.

### 10.5 realtime_materializations

- id
- pipeline_version_id
- source_boundary JSONB
- source_fingerprint
- clickhouse_query_id
- target_row_count
- target_checksum
- status
- started_at
- committed_at
- published_revision
- retry_count
- last_error_code

unique key는 `(pipeline_version_id, source_fingerprint)`다. 같은 fingerprint를 다른 pipeline version이 재사용할 수는 있지만 같은 version에서 두 materialization으로 발행할 수는 없다.

### 10.6 realtime_partition_receipt_ranges

- pipeline_version_id
- topic
- partition
- from_offset_inclusive
- to_offset_inclusive
- expected_position_count
- raw_position_count
- expected_positions_hash
- raw_or_resolved_positions_hash
- status: verifying | contiguous | blocked
- verified_at nullable

unique key는 `(pipeline_version_id, topic, partition, from_offset_inclusive, to_offset_inclusive)`다. receipt auditor가 Kafka를 `read_committed`로 bounded fetch해 실제 consumable source position 집합을 만들고 ClickHouse raw position과 quarantine/audited-skip position의 합집합을 비교한다. aborted transaction/control record 같은 숫자 offset hole은 기대 position 집합에 없으므로 정상 gap으로 오인하지 않는다. 최대 range는 maxOffsetsPerBatch로 제한하며 연속된 `contiguous` range만 compact summary의 `last_contiguously_received_offset`을 전진시킨다.

poison record 상세는 `realtime_ingest_exceptions`에 topic/partition/offset, payload hash, quarantine locator, error code, 상태, audit actor/reason을 저장한다. `audited_skip`은 API 권한, 사유, 감사 log 없이는 설정할 수 없고 해당 position을 포함한 range hash를 다시 검증해야 한다.

### 10.7 realtime_unmatched_events

- serving_key
- pipeline_version_id
- source_position JSONB
- missing_policy
- missing_dimension_dataset_id
- missing_dimension_keys JSONB
- raw_payload_hash
- archive_locator
- dimension_version_ids JSONB
- correction_generation
- first_seen_at
- next_retry_at
- retry_count
- status
- resolved_materialization_id

### 10.8 기존 dataset_freshness 확장

기존 row와 API를 migration으로 유지하며 다음 field를 추가한다.

- binding_epoch BIGINT NOT NULL DEFAULT 0
- active_serving_engine
- active_serving_version_id
- active_archive_snapshot_id
- latest_source_boundary JSONB
- latest_checksum
- latest_mutation_type

`latest_revision`은 Dataset 전체에서 계속 단조 증가한다. serving pointer switch와 rollback은 `binding_epoch`도 1 증가시키고 새 global revision을 할당한다.

### 10.9 기존 dataset_revision_commits 확장

- dataset_id
- revision
- run_id: realtime에서는 `rt:{materializationId}`
- materialization_id nullable
- source_boundary JSONB
- serving_engine
- serving_version_id
- binding_epoch
- dimension_version_ids JSONB
- mutation_type: append | upsert | replace | retract
- row_count
- checksum
- committed_at

기존 commit field와 호환성을 유지한다. `(dataset_id, revision)`은 unique이고 materialization_id가 있으면 partial unique다. count/checksum은 항상 `serving_current` 또는 같은 source boundary의 deduplicated archive projection에서 계산한다.

### 10.10 기존 realtime_event_log schema v2 확장

기존 column과 cursor 의미를 유지한다.

- id BIGSERIAL: 기존 SSE sequence
- scope_id: 현재 `deployment`
- event_type: 기존 `dataset.revision.committed` 유지
- schema_version: V2 payload는 `2`
- resource_type / resource_id
- aggregate_revision
- correlation_id
- idempotency_key unique
- invalidations JSONB
- payload JSONB: additive `bindingEpoch`, `materializationId`, `mutationType`, `sourceBoundary`, `servingVersionId`, `pipelineVersionId`
- occurred_at
- expires_at

`realtime_event_log`는 한 worker가 소비하고 지우는 work queue가 아니라 모든 SSE replica가 cursor로 읽는 append-only durable log다. schema v2도 기존 `(scope_id, id)` replay, retention과 idempotency 의미를 바꾸지 않는다. LISTEN/NOTIFY는 commit 뒤 wake-up 최적화일 뿐 delivery/correctness marker가 아니다.

revision event의 durable insert는 SSE delivery flag와 분리한다. `REALTIME_EVENTS_ENABLED=false`는 stream 전송을 중지할 수 있지만 committed revision evidence 자체를 생략하는 조건이 될 수 없다.

revision publish transaction은 다음 순서를 단일 transaction으로 수행한다.

1. `dataset_freshness` row를 `FOR UPDATE`로 잠근다.
2. active binding epoch와 materialization lease generation을 검증하고 다음 global revision을 할당한다.
3. 모든 partition checkpoint를 offset 오름차순 CAS로 전진시킨다. receipt gap이나 stale expected offset이면 전체 rollback한다.
4. realtime_materializations를 committed로 바꾸고 기존 `dataset_revision_commits`에 한 row를 insert한다.
5. `dataset_freshness`를 같은 revision, binding epoch, boundary로 갱신한다.
6. dataset 단위 `dataset.revision.committed` schema v2 event를 기존 `realtime_event_log`에 insert한다.

외부 ClickHouse/Kafka/S3 호출은 이 transaction에 포함하지 않는다.

---

## 11. Materializer 실행 계약

### 11.1 모듈 경계

신규 backend 경계:

    backend/app/realtime/
      application/
        pipeline_commands.py
        raw_decode_worker.py
        receipt_auditor.py
        materialization_worker.py
        dimension_publish_worker.py
        repair_worker.py
        publication_reconciler.py
      domain/
        models.py
        state_machine.py
        source_boundary.py
      infrastructure/
        clickhouse_gateway.py
        kafka_connect_gateway.py
        catalog_gateway.py
      repositories/
        pipeline_repository.py
        checkpoint_repository.py
        realtime_event_log_adapter.py
      sql/
        validator.py
        classifier.py
        clickhouse_compiler.py

etl_service.py에 신규 ClickHouse 기능을 직접 추가하지 않는다.

### 11.2 Batch 처리 순서

1. worker가 pipeline version lease를 획득한다.
2. partition checkpoint, receipt ledger와 connector 상태를 읽는다.
3. 각 partition의 contiguous receipt high-water까지만 bounded source boundary를 계산한다. raw `MAX(offset)`은 증거로 사용하지 않는다.
4. materialization row를 reserved로 저장하고 commit한다.
5. PostgreSQL transaction을 종료한다.
6. ClickHouse에서 source position별 deduplicated raw row를 선택한다.
7. versioned dimension과 JOIN한다.
8. 같은 materializationId/sourceFingerprint/insert token과 deterministic serving key로 quorum target insert를 수행한다.
9. `serving_current`에서 target row count, checksum, source boundary와 dimension version을 검증한다.
10. PostgreSQL 새 transaction에서 `dataset_freshness`를 잠그고 active binding/lease를 재검증한다.
11. partition checkpoint CAS, materialization committed, `dataset_revision_commits`, `dataset_freshness`, `realtime_event_log` insert를 10.10의 순서로 한 번에 commit한다.
12. commit 뒤 LISTEN/NOTIFY wake-up을 보내며, 실패해도 SSE replica의 주기적 event-log catch-up이 전달을 복구한다.

### 11.3 Split failure 복구

| 실패 지점 | 복구 |
| --- | --- |
| reservation 후 ClickHouse 실패 | 같은 materializationId 재시도 |
| ClickHouse 성공 후 PostgreSQL 실패 | target의 materializationId 조회 후 reconciler가 publish |
| revision 성공 후 NOTIFY/SSE 실패 | durable event-log cursor catch-up과 Last-Event-ID replay |
| SSE 성공 후 client disconnect | Last-Event-ID replay |
| checkpoint 전진 전 worker crash | 같은 boundary 재실행, serving key로 멱등 |
| dimension 누락 | unmatched queue와 repair |

### 11.4 Lock 규칙

- reservation transaction lock 순서는 pipeline → version → checkpoint partition 오름차순이다.
- publication transaction은 dataset_freshness → checkpoint partition 오름차순 → materialization 순서다.
- 외부 I/O 전 DB transaction과 row lock을 해제한다.
- lease generation을 매 획득마다 증가시킨다.
- 오래된 worker는 현재 generation과 다르면 publish할 수 없다.
- advisory lock은 pipeline 단위 command serialization에만 사용한다.

---

## 12. Catalog dual physical binding

기존 queryEngineTable 하나에 hot serving과 archive를 억지로 넣지 않는다.

### 12.1 신규 응답 개념

    physicalBindings: [
      {
        role: "serving",
        engine: "clickhouse",
        status: "available",
        database: "asklake_serving",
        table: "joined_click_events_v1",
        pipelineVersionId: "rtpv_...",
        bindingEpoch: 4,
        latestRevision: 1532,
        lastCommittedAt: "2026-07-18T10:00:00Z"
      },
      {
        role: "archive",
        engine: "iceberg",
        status: "available",
        catalog: "iceberg",
        namespace: "gold",
        table: "joined_click_events",
        snapshotId: "...",
        pipelineVersionId: "rtpv_...",
        dimensionVersionIds: {"users":"dimv_7","products":"dimv_12"},
        archivedThrough: {
          topic: "clicks",
          partitions: {"0": 1001}
        }
      }
    ]

기존 queryEngineTable은 archive/Trino 호환을 위해 migration 기간 동안 유지한다. ClickHouse serving binding을 queryEngineTable에 덮어쓰지 않는다. Trino compiler와 legacy client가 새 ClickHouse physical identifier를 Iceberg table로 오인하지 않도록 physicalBindings를 별도 필드로 추가하고, 모든 consumer 전환 뒤에만 queryEngineTable 제거 여부를 결정한다.

archive binding은 단순 raw topic table이 아니다. 별도 archive consumer가 click 원본과 immutable dimension history를 Bronze Iceberg에 보존하고, 같은 normalized pipeline AST와 고정된 dimensionVersionIds로 Gold JOIN projection을 비동기 materialize한다. 위 `role=archive`와 legacy queryEngineTable은 이 Gold table을 가리킨다. Gold projection이 없거나 pipeline/dimension version이 다르면 동일 결과 fallback으로 표시하지 않는다.

### 12.2 Dataset status

- servingStatus: pending | shadow | available | degraded | unavailable
- archiveStatus: pending | available | lagging | failed
- overall status가 available이어도 serving/archive 세부 상태를 숨기지 않는다.
- Dashboard는 serving binding을 우선 사용한다.
- SQL ad-hoc 및 long-range query는 archive binding을 사용할 수 있다.
- 어떤 binding을 사용했는지 API 응답에 engine과 revision을 포함한다.

### 12.3 Lineage

Lineage graph에 다음 node/edge를 추가한다.

- Kafka source topic
- ClickHouse raw Dataset
- realtime pipeline version
- dimension Dataset version
- ClickHouse serving Dataset
- Iceberg archive Dataset
- Dashboard widget

edge metadata:

- pipelineVersionId
- sqlFingerprint
- sourceBoundary
- executionMode
- activeFrom/activeTo

---

## 13. API 명세

모든 endpoint는 기존 session/ActorContext, permission, governance lock, audit 규칙을 사용한다.

V2는 현재 Realtime 2026의 `/api/query/continuous-jobs*`, `/api/realtime/events`, Dashboard widget endpoint를 additive 확장한다. 동일 목적의 `/api/realtime/pipelines*` API를 별도로 만들지 않는다.

### 13.1 Pipeline validate

    POST /api/query/continuous-jobs/validate

요청:

    {
      "sourceDatasetId": "ds_clicks",
      "relationDatasetIds": ["ds_clicks", "ds_users", "ds_products"],
      "sql": "SELECT ...",
      "requestedMode": "auto",
      "runtimeVersion": 2
    }

응답:

    {
      "valid": true,
      "normalizedSql": "SELECT ...",
      "fingerprint": "...",
      "executionMode": "realtime_incremental",
      "joinKeys": [...],
      "warnings": [],
      "estimatedCost": {
        "sourceRowsPerSecond": 1000,
        "dimensionRows": 5000000,
        "estimatedP95Ms": 800
      }
    }

### 13.2 Pipeline CRUD/command

    POST   /api/query/continuous-jobs
    GET    /api/query/continuous-jobs
    GET    /api/query/continuous-jobs/{jobId}
    POST   /api/query/continuous-jobs/{jobId}/commands

기존 command:

- start
- pause
- resume
- stop
- recover

V2 additive 운영 command:

- deployShadow
- activate
- rebuild
- rollback
- retire

현재 `clientRequestId`, `commandId`, generation/fencing 계약을 그대로 사용한다. V2 pipeline version은 Continuous SQL Job/Run plan version metadata로 저장하며 별도 mutable pipeline API를 만들지 않는다.

### 13.3 Pipeline status

    GET /api/query/continuous-jobs/{jobId}

필수 필드:

- desiredState
- observedState
- activeVersionId
- rawLagByPartition
- materializerLagByPartition
- archiveLagByPartition
- latestServingRevision
- lastMaterialization
- unmatchedCount
- lastError
- health

### 13.4 Dataset serving status

    GET /api/catalog/datasets/{datasetId}/serving

### 13.5 Repair/reconcile

    POST /api/query/continuous-jobs/{jobId}/repairs
    POST /api/query/continuous-materializations/{materializationId}/reconcile

운영 권한과 audit reason을 필수로 받는다.

### 13.6 Dashboard SSE

    GET /api/realtime/events?dashboardId={dashboardId}&datasetIds={datasetIds}&cursor={eventCursor}

headers:

- Accept: text/event-stream
- Last-Event-ID: optional
- Cache-Control: no-cache

`realtime_event_log`에는 Dataset revision만 저장한다. SSE 전달 시 현재 published Dashboard의 Dataset→widget mapping과 actor 권한을 동적으로 해석해 event를 만든다. Dashboard 수정이나 권한 변경 때문에 저장 당시 widget 목록을 payload에 고정하지 않는다.

event 예시:

    id: 981233
    event: dataset.revision.committed
    data: {"dashboardId":"dash_1","datasetId":"ds_joined","bindingEpoch":4,"revision":1532,"affectedWidgetIds":["w1","w2"],"committedAt":"..."}

기타 event:

- stream.ready
- dataset.revision.committed
- dashboard.published
- system.authorization_changed
- system.resync_required
- system.heartbeat

### 13.7 Widget query

기존 endpoint를 유지한다.

    POST /api/dashboards/{dashboardId}/widgets/query

요청에 Dataset별 client cursor를 선택적으로 추가한다.

    {
      "clientKnownRevisions": {
        "ds_joined": {"bindingEpoch": 4, "revision": 1532}
      }
    }

응답 widget 필수 metadata:

- engine
- bindingEpoch
- appliedRevision
- latestKnownRevision
- calculatedAt
- sourceBoundary
- freshnessState: current | catching_up | stale | degraded
- error: nullable structured error

stale fallback을 반환할 때 HTTP 200을 사용할 수 있으나 freshnessState와 error를 반드시 포함한다. 권한 오류는 stale cache를 반환하지 않고 401/403이다.

### 13.8 Error envelope

    {
      "error": {
        "code": "REALTIME_MATERIALIZATION_LAGGING",
        "message": "Serving data is behind the latest source position.",
        "retryable": true,
        "traceId": "...",
        "pipelineId": "...",
        "materializationId": "...",
        "details": {
          "bindingEpoch": 4,
          "latestRevision": 1532,
          "appliedRevision": 1530
        }
      }
    }

필수 오류 code:

- REALTIME_SQL_UNSUPPORTED
- REALTIME_SQL_SCOPE_VIOLATION
- REALTIME_PIPELINE_CONFLICT
- REALTIME_DEPLOYMENT_FAILED
- REALTIME_DIMENSION_NOT_READY
- REALTIME_MATERIALIZATION_LAGGING
- REALTIME_MATERIALIZATION_FAILED
- REALTIME_SERVING_UNAVAILABLE
- REALTIME_REVISION_GAP
- REALTIME_SSE_REPLAY_EXPIRED
- CLICKHOUSE_QUERY_TIMEOUT
- CLICKHOUSE_QUERY_BUDGET_EXCEEDED
- ARCHIVE_LAGGING

---

## 14. SSE와 frontend 상태 계약

### 14.1 Server

- sse-starlette를 사용한다.
- native EventSource와 same-origin HttpOnly cookie session만 사용한다. query string token과 localStorage bearer token을 금지한다.
- 기존 `realtime_event_log.id` sequence를 SSE id로 사용한다.
- Last-Event-ID 이후 event를 permission-filtered replay한다.
- `stream.ready`에 현재 event-log high-water sequence와 Dataset별 `(bindingEpoch, revision)` cursor를 additive payload로 포함한다.
- retention보다 오래된 ID면 기존 `system.resync_required`를 보낸다.
- 15초마다 기존 `system.heartbeat`를 보낸다.
- Nginx/proxy buffering을 비활성화한다.
- PostgreSQL `realtime_event_log`를 append-only durable log로 유지하고 각 SSE connection이 자기 last sequence cursor로 직접 catch-up한다.
- LISTEN/NOTIFY는 replica wake-up에만 사용한다. 알림 유실과 replica restart는 1초 이하 주기의 DB high-water catch-up으로 복구한다.
- Dataset event를 읽을 때 현재 published Dashboard의 widget mapping을 조회해 affectedWidgetIds를 계산한다.
- connection open, replay와 최대 5초 주기의 permission revision 재검사 시 dashboard view 권한을 검사한다.
- 권한 변경 transaction은 `permission.revision` wake-up event도 기록해 5초를 기다리지 않고 즉시 재검사하게 한다.
- 권한 철회 event 후 connection을 종료한다.
- 한 사용자/조직별 connection limit을 둔다.

### 14.2 Browser

1. published Dashboard 진입 시 runtime을 한 번 로드한다.
2. SSE 연결을 연다.
3. `dataset.revision.committed`를 받으면 영향받은 widget ID를 debounce해 한 번에 query한다.
4. 새 응답 cursor `(bindingEpoch, appliedRevision)`을 lexicographic 비교하고 기존 cursor보다 낮을 때만 폐기한다. epoch가 증가한 rollback/cutover 응답은 내부 table revision이 낮아도 수용한다.
5. SSE 단절 시 exponential backoff + jitter로 재연결한다.
6. reconnect 중에는 polling fallback을 bounded interval로 사용한다.
7. hidden tab에서는 widget query를 멈추되 SSE 재연결 semantics를 보존한다.
8. `system.resync_required`를 받으면 published runtime 전체를 다시 조회한다.

### 14.3 Frontend 단일 상태 소유권

- TanStack Query 기반 server-state cache를 도입한다.
- Catalog list/detail/Dashboard dataset selector가 같은 Dataset cache key를 사용한다.
- SSE는 cache invalidation만 수행한다.
- route change request는 AbortController 또는 query cancellation을 사용한다.
- optimistic update rollback은 전체 배열 snapshot을 되돌리지 않는다.
- server state와 builder draft state를 분리한다.

### 14.4 사용자 표시

모든 live widget은 다음을 표시할 수 있어야 한다.

- Live / Catching up / Stale / Degraded
- latest revision
- applied revision
- 마지막 성공 시각
- 현재 지연 시간
- 안전한 오류 요약
- 재시도 버튼
- Job/Pipeline 상태로 이동

오류를 단순히 빈 chart나 위젯 데이터를 불러오지 못했습니다로만 표시하지 않는다.

---

## 15. ClickHouse Dashboard query adapter

### 15.1 Routing

- serving binding available이면 ClickHouse adapter 사용
- serving unavailable이고 같은 pipelineVersionId와 dimensionVersionIds의 Gold archive binding이 available일 때만 명시적 archive fallback 가능
- fallback 사용 시 engine=trino, freshnessState=degraded 표시
- raw Bronze table을 Gold JOIN 결과인 것처럼 직접 fallback하지 않는다. archive projection이 아직 경계에 도달하지 않았으면 마지막 검증 boundary를 응답하고 catching_up/degraded로 표시한다.
- mock/sampleRows fallback은 live mode에서 금지
- revision mutationType이 append일 때만 증분 merge 최적화를 사용할 수 있다.
- upsert, replace, retract revision은 ClickHouse serving 현재 상태를 다시 조회한다.
- late dimension repair revision을 단순 count delta로 더하지 않는다.

### 15.2 Query budget

요청별:

- max_execution_time
- max_rows_to_read
- max_bytes_to_read
- max_memory_usage
- max_result_rows
- read_overflow_mode

서버가 widget type별 allowlist SQL을 생성한다. client가 raw SQL을 widget query endpoint에 전달하지 않는다.

### 15.3 Widget 지원

초기 필수:

- metric: count, sum, avg, min, max, uniqExact
- table: bounded sort/limit
- bar
- line
- donut

모든 query는 `scope_id="deployment"`, `serving_dataset_id`와 현재 actor의 Dataset `query` permission을 강제한다.

### 15.4 Cache

- cache key: scope, actor permission revision, dashboard, widget, calculationVersion, bindingEpoch, datasetRevision, filter hash
- 오류 결과는 성공 cache를 덮지 않는다.
- stale 성공 cache를 반환하면 stale metadata를 함께 반환한다.
- cache invalidation은 revision 기반이다.

---

## 16. 보안과 거버넌스

### 16.1 Network

- ClickHouse HTTP/native port는 public internet에 노출하지 않는다.
- backend, connector, worker 전용 private network만 허용한다.
- TLS를 staging/production에서 강제한다.
- security group은 service-to-service 최소 범위다.

### 16.2 Account

별도 계정:

- asklake_ingest: raw insert만
- asklake_materializer: 승인 database read + version target insert
- asklake_query: serving SELECT만
- asklake_migration: DDL, 운영 시 비활성
- asklake_observer: system metric read

credential은 repo, compose yaml, log, API 응답에 저장하지 않는다.

### 16.3 Deployment scope와 resource isolation

- 모든 raw/dimension/serving row에 현재 `scope_id="deployment"`를 저장한다.
- backend는 Dataset/Dashboard resource permission을 물리 query 전에 재검사한다.
- 선택하지 않았거나 `query` 권한이 없는 Dataset reference는 validation에서 거부한다.
- SSE payload도 현재 Dashboard/Dataset permission으로 필터한다.
- audit event에는 actor, scope, resource, traceId를 기록한다.
- 실제 tenant model과 cross-tenant isolation은 별도 foundation ADR·migration·권한 계약이 승인된 뒤에만 추가한다.

### 16.4 SQL security

- AST allowlist
- selected Dataset scope
- physical identifier server resolution
- external table function 거부
- query setting server 강제
- DDL은 migration/deployment service만 실행
- validation과 execution 사이 fingerprint 재검증

---

## 17. 관측성

### 17.1 Correlation

다음 ID를 전 구간에 전파한다.

- traceId
- pipelineId
- pipelineVersionId
- materializationId
- datasetId
- revision
- Kafka source boundary
- ClickHouse query_id

### 17.2 Metrics

필수:

- kafka_hot_consumer_lag
- kafka_archive_consumer_lag
- clickhouse_raw_ingest_latency_seconds
- realtime_materializer_lag_seconds
- realtime_materialization_duration_seconds
- realtime_materialization_failures_total
- realtime_unmatched_events
- realtime_receipt_gap_ranges
- dataset_serving_revision
- dataset_binding_epoch
- realtime_event_log_high_water_sequence
- sse_event_log_cursor_lag
- sse_connections
- sse_replay_events_total
- sse_disconnects_total
- dashboard_widget_query_duration_seconds
- dashboard_widget_stale_total
- clickhouse_query_failures_total
- archive_parity_gap

### 17.3 Alert

P0:

- logical data loss 또는 checksum mismatch
- revision 역행/중복
- deployment/resource isolation violation
- 모든 replica unavailable

P1:

- E2E P95 10초 초과 10분
- materializer lag 30초 초과
- SSE replica event-log cursor lag 30초 초과
- unmatched terminal 증가
- archive lag 15분 초과

P2:

- merge backlog
- part count 증가
- disk 70/80/90% threshold
- SSE reconnect rate 증가

### 17.4 Log

- structured JSON
- safe error detail
- SQL 전체와 credential log 금지
- normalized fingerprint와 query_id만 기본 기록
- raw payload는 quarantine object에 제한적으로 저장

---

## 18. 배포와 운영

### 18.1 Local Compose

추가 service:

- clickhouse
- clickhouse-keeper
- kafka-connect-clickhouse
- realtime-materializer
- realtime-event-notifier

local에서도 production과 동일 migration과 connector를 사용한다.

### 18.2 Production topology

HA를 주장하려면 최소:

- 1 shard, 2 ClickHouse replicas
- 3 Keeper nodes, 서로 다른 failure domain
- Kafka Connect worker 2개 이상
- materializer active/standby lease
- backend replica 2개 이상

단일 EC2 topology는 demo/staging 용도로만 허용하고 HA로 표시하지 않는다.

### 18.3 Startup

- volume directory 생성과 UID/GID 설정을 idempotent entrypoint로 수행
- one-shot init container에만 의존하지 않음
- healthcheck는 TCP open이 아니라 query, write permission, connector status, volume write를 확인
- restart 후 checkpoint와 event-log replay 자동 검증

### 18.4 Backup/restore

- PostgreSQL metadata backup
- ClickHouse schema와 serving/raw snapshot
- Iceberg archive는 기존 policy
- ClickHouse 전체 유실 시 Iceberg/Kafka retention에서 rebuild 가능해야 함
- 분기별 restore drill

---

## 19. Archive와 parity

hot path 성공은 archive 완료를 기다리지 않는다. 두 상태는 별도로 노출한다.

archive 경로는 두 계층을 만든다.

1. Bronze: Kafka click 원본과 재구성에 필요한 source position, payload, schema fingerprint를 append-only 보존한다. dimension publisher는 immutable dimension snapshot/history도 Iceberg에 보존한다.
2. Gold: 동일 normalized pipeline AST, pipelineVersionId와 dimensionVersionIds로 JOIN 결과를 materialize한다. Catalog archive binding과 legacy queryEngineTable은 이 table만 가리킨다.

따라서 Trino fallback, shadow parity와 rebuild는 ClickHouse serving과 같은 JOIN 의미를 비교할 수 있다. Gold가 없으면 raw에서 즉석으로 의미를 추정하지 않고 fallback unavailable을 반환한다.

### 19.1 Consumer groups

- hot: asklake-hot-{datasetStableId}
- archive: asklake-archive-{jobStableId}
- group 재사용 및 수동 offset reset은 운영 command/audit 없이 금지

### 19.2 Parity

동일 source boundary에 대해 비교:

- distinct source position count
- min/max offset per partition
- schema fingerprint
- null/error count
- 중요 numeric sum
- sample hash

불일치는 Dashboard hot serving을 즉시 삭제하지 않는다. degraded 상태와 alert를 만들고, 정책에 따라 rebuild/rollback한다.

### 19.3 Rebuild

1. archive snapshot과 source boundary 선택
2. 새 pipeline version shadow table 생성
3. pipeline version과 dimension version set을 고정한다.
4. partition별 contiguous boundary vector B를 고정한다.
5. Iceberg Bronze의 deduplicated source `offset <= B[p]`를 읽어 같은 rule/dimension version으로 ClickHouse shadow에 backfill한다.
6. shadow checkpoint를 B로 CAS한 뒤 raw hot tail을 partition별 `B[p] + 1`부터 처리한다.
7. gap/overlap 0, 같은 dimension version, canonical current count/checksum과 boundary parity를 검증한다.
8. 20.4의 pointer switch transaction을 수행한다.

---

## 20. Migration, shadow, canary, cutover

### 20.1 Feature flags와 routing

- ASKLAKE_CLICKHOUSE_SERVING_ENABLED
- ASKLAKE_REALTIME_PIPELINE_WRITE_SHADOW
- ASKLAKE_REALTIME_SSE_ENABLED
- ASKLAKE_DASHBOARD_SERVING_ENGINE

flag는 한 schema에서 검증하고 시작 시 잘못된 조합을 거부한다. 환경 변수 flag는 전체 시스템 emergency disable/force-archive override로만 사용한다. tenant model이 없으므로 canary 선택은 PostgreSQL의 Dataset/Dashboard sticky routing assignment로 관리하고 actor 요청이나 backend replica마다 다시 무작위 추첨하지 않는다.

### 20.2 Shadow

- 기존 Trino/dashboard 결과와 ClickHouse 결과를 사용자 응답과 무관하게 비교
- 최소 72시간
- 정상/재시작/late dimension/권한 변경 포함
- mismatch는 field-level diff와 source boundary 기록

### 20.3 Canary

1. 내부 demo Dashboard 1개
2. 비핵심 Dataset/Dashboard allowlist 5%
3. Dataset/Dashboard assignment 25%
4. Dataset/Dashboard assignment 50%
5. 승인된 Dataset/Dashboard 100%

각 단계 최소 24시간 또는 승인된 관찰 시간을 유지한다.

### 20.4 Boundary-safe cutover

모든 boundary는 partition별 vector다. scalar max offset으로 축약하지 않는다.

1. immutable pipelineVersionId와 dimensionVersionIds를 고정한다.
2. archive와 hot receipt가 모두 연속임을 증명하는 boundary B를 partition별로 고정한다.
3. shadow에 `offset <= B[p]`를 backfill하고 canonical view count/checksum을 검증한다.
4. shadow checkpoint를 정확히 B로 설정한 뒤 `B[p] + 1`부터 hot tail을 연결한다.
5. 선택한 catch-up boundary C까지 gap/overlap 0과 Gold archive parity를 검증한다.
6. `dataset_freshness`를 잠근 한 transaction에서 active binding pointer를 교체하고 bindingEpoch와 global revision을 각각 1 증가시키며 `mutationType="replace"`인 `dataset.revision.committed` schema v2 event를 기록한다.
7. browser가 새 `(bindingEpoch, revision)`을 적용한 사실과 DOM 결과를 확인한 뒤 이전 binding을 retention 상태로 전환한다.

### 20.5 Cutover gate

- 10만 건 deterministic fixture 유실/논리 중복 0
- 72시간 shadow count/checksum 기준 충족
- P95 SLO 충족
- restart/chaos 통과
- security test 통과
- rollback drill 통과
- 운영 dashboard와 runbook 준비

### 20.6 Rollback

- Catalog serving pointer를 이전 검증 binding으로 되돌리되 cutover와 같은 transaction으로 새 bindingEpoch와 새 global revision을 할당
- Dashboard routing flag를 iceberg/trino로 전환
- ClickHouse ingest는 forensic 보존을 위해 자동 삭제하지 않음
- SSE는 `(bindingEpoch, revision)`과 `mutationType="replace"`를 포함한 기존 `dataset.revision.committed` schema v2 event를 전송
- rollback 중 source offsets를 reset하지 않음
- 이전 binding의 내부 마지막 revision이 낮아도 public cursor는 새 epoch이므로 frontend가 결과를 폐기하지 않는다.
- Dataset/Dashboard canary rollback은 sticky assignment row를 새 desired engine/epoch으로 갱신한다. 환경 변수는 deployment 전체 emergency override일 때만 사용한다.

---

## 21. Legacy/mock/fallback 제거

### 21.1 Frontend

- DashboardPage의 legacy builder/detail을 live route에서 제거
- saveDashboardCard mock 저장을 live에서 호출하지 않음
- Dashboard runtime/list adapter를 FastAPI 단일 source로 통합
- API 실패 optimistic success 금지
- Catalog refresh callback 실제 연결
- Dashboard Dataset selector가 전역 Catalog cache 재사용
- route별 request race 방지
- empty와 error를 구분

### 21.2 Backend

- Node demo API는 /api/demo 아래 reference로만 유지하거나 제거 일정 명시
- FastAPI 실행 경로에 Node compatibility fallback 금지
- demo gold join Dataset을 production seed에서 제거
- runtime startup schema 보강 제거
- etl_service.py에서 continuous reconciliation/publication 분리
- repository 내부 commit 제거

### 21.3 완료 기준

- live bundle에서 mock 저장 import 0
- live API 실패가 성공 card를 만들지 않음
- demo Dataset이 production Catalog에 나타나지 않음
- fallback 실행 시 structured warning/metric
- fallback owner와 제거일이 없는 코드 0

---

## 22. 파일별 변경 명세

### 22.1 Backend 신규

- backend/app/realtime/ 전체 모듈
- backend/app/api/realtime_pipelines.py
- backend/app/api/realtime_events.py
- backend/app/schemas/realtime.py
- backend/app/models/realtime.py
- backend/app/services/clickhouse_dashboard_query.py
- backend/alembic/versions/* realtime metadata migration
- backend/scripts/verify-clickhouse-realtime-e2e.mjs
- backend/scripts/verify-clickhouse-restart-recovery.mjs
- backend/scripts/verify-hot-archive-parity.py
- backend/tests/test_realtime_sql_classifier.py
- backend/tests/test_realtime_state_machine.py
- backend/tests/test_realtime_materializer.py
- backend/tests/test_realtime_event_log_v2.py

### 22.2 Backend 수정

- backend/app/main.py: routers/workers/health wiring
- backend/app/services/dashboard_runtime_service.py: serving adapter 분리
- backend/app/services/dashboard_physical_data.py: ClickHouse bounded session
- backend/app/services/catalog_service.py: dual binding
- backend/app/services/etl_service.py: 신규 책임 제거 및 event 발행
- backend/app/repositories/dashboard_live_repository.py: formal migration 이후 schema DDL 제거
- backend/requirements.txt: official ClickHouse client 추가
- backend/package.json: verify scripts

### 22.3 Frontend 신규

- frontend/src/services/realtimePipelineApi.ts
- frontend/src/services/dashboardEvents.ts
- frontend/src/pages/realtime/*
- frontend/src/pages/dashboard/runtime/useDashboardEventStream.ts
- frontend/src/pages/dashboard/runtime/LiveFreshnessBadge.tsx
- frontend/scripts/realtime-dashboard-e2e/*

### 22.4 Frontend 수정

- frontend/src/pages/dashboard/DashboardPage.tsx
- frontend/src/pages/dashboard/runtime/useDashboardDatasets.ts
- frontend/src/pages/dashboard/runtime/useDashboardRuntimeResources.ts
- frontend/src/pages/dashboard/runtime/usePublishedDashboardLiveRefresh.ts
- frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx
- frontend/src/hooks/useAskLakeData.ts
- frontend/src/App.tsx
- frontend/src/services/apiClient.ts

### 22.5 Infra

- deploy/docker-compose.prod.yml
- deploy/.env.example
- 신규 deploy/clickhouse/config/*
- 신규 deploy/clickhouse/users/*
- 신규 deploy/kafka-connect/*
- scripts/start-local-query-runtime.sh
- .github/workflows/realtime-e2e.yml

### 22.6 문서

- docs/01-product-planning.md
- docs/02-architecture.md
- docs/03-api-reference.md
- docs/04-development-guide.md
- docs/system-guardrails.md
- docs/api-contract.md
- docs/backend-integration-readiness.md
- README.md

---

## 23. 단계별 구현 계획과 PR 경계

이 절의 Phase 0~9는 작업 논리 순서다. GitHub에서는 이미 병합된 Realtime 2026 기준선을 고려해 `docs/codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md`의 9개 PR로 묶는다. 각 Phase를 별도 subsystem으로 다시 만드는 것이 아니라 기존 모듈에 expand-only로 적용한다.

### Phase 0 — 계약과 안전망

목표:

- ADR 승인
- 지원 SQL과 SLO 확정
- 현재 behavior characterization test
- OpenAPI/SSE schema 초안

완료 기준:

- 상위 문서 동기화
- 기존 배포 flow characterization
- 신규 code path는 아직 off

권장 PR:

- docs/clickhouse-realtime-contract
- test/realtime-characterization

### Phase 1 — ClickHouse 기반시설

목표:

- ClickHouse 26.3 LTS exact pin
- Keeper, Kafka Connect, account, TLS, volume, health
- Alembic metadata migration

완료 기준:

- clean host start
- reboot recovery
- credential 비노출
- backup/restore smoke

권장 PR:

- chore/clickhouse-runtime
- feature/realtime-metadata-migrations

### Phase 2 — Raw hot ingest

목표:

- topic mapping
- metadata field 보존
- DLQ
- bounded Kafka receipt audit와 contiguous range ledger
- dedupe contract
- connector lag/status API

완료 기준:

- 10만 건 ingest
- multi-partition gap/poison/kill/restart/rebalance 후 checkpoint 월경, 유실·논리 중복 0
- P95 2초 이하

권장 PR:

- feature/clickhouse-kafka-ingest

### Phase 3 — Dimension publisher

목표:

- Catalog snapshot → ClickHouse dimension
- version/pointer
- current/temporal semantics
- update event

완료 기준:

- user/meta version atomic publish
- old version rollback
- deployment/resource scope 격리

권장 PR:

- feature/clickhouse-dimensions

### Phase 4 — SQL compiler와 materializer

목표:

- validate/classify/compile
- pipeline lifecycle
- partition checkpoint
- serving idempotency
- late repair

완료 기준:

- 3-way JOIN 정확성
- unsupported SQL 명확한 거부
- split failure reconcile
- source boundary 재실행 멱등

권장 PR:

- feature/realtime-sql-compiler
- feature/realtime-materializer
- feature/realtime-late-repair

### Phase 5 — Catalog revision/event log

목표:

- dual binding
- 기존 dataset_freshness/dataset_revision_commits 확장
- 기존 `realtime_event_log` schema v2 transactional append
- lineage

완료 기준:

- ClickHouse commit당 revision 정확히 1회
- 다중 backend replica cursor replay와 NOTIFY 유실 catch-up
- Catalog pointer rollback

권장 PR:

- feature/catalog-serving-bindings
- feature/realtime-event-log-v2

### Phase 6 — Dashboard query와 SSE

목표:

- ClickHouse bounded widget query
- EventSource
- Last-Event-ID
- auth/permission

완료 기준:

- 새로고침 없이 5초 내 반영
- disconnect/replay
- 권한 철회
- stale/error 표시

권장 PR:

- feature/clickhouse-dashboard-query
- feature/dashboard-sse

### Phase 7 — Frontend 상태 통합

목표:

- 단일 Catalog/Dashboard cache
- route cancellation
- freshness UI
- legacy/mock live 제거

완료 기준:

- 새 Dataset 즉시 선택 가능
- 늦은 응답이 새 route를 덮지 않음
- silent success/error 0

권장 PR:

- refactor/frontend-server-state
- fix/dashboard-live-errors
- chore/remove-live-legacy-dashboard

### Phase 8 — Archive parity와 운영 복구

목표:

- hot/archive offset 비교
- backfill/rebuild
- startup permission
- runbook

완료 기준:

- clean reboot
- ClickHouse 전체 유실 rebuild
- parity alert

권장 PR:

- feature/hot-archive-parity
- fix/spark-restart-provisioning

### Phase 9 — E2E/CI와 cutover

목표:

- full browser E2E
- chaos/load/security
- shadow/canary
- rollback

완료 기준:

- 모든 cutover gate 통과
- main/dev PR required check 등록

권장 PR:

- test/realtime-full-stack-e2e
- chore/realtime-ci-gates
- feature/realtime-cutover

---

## 24. 테스트 매트릭스

| 계층 | 필수 시나리오 |
| --- | --- |
| Unit | AST 허용/거부, fingerprint, event key, source boundary, state transition |
| Contract | OpenAPI, SSE event, error envelope, Catalog dual binding |
| Repository | lease generation, revision uniqueness, freshness row lock/checkpoint CAS, event-log append same transaction |
| ClickHouse | DDL, dedupe query, JOIN result, timeout/budget |
| Kafka integration | produce→raw, multi-partition gap, poison quarantine/audited skip, duplicate delivery, rebalance, DLQ |
| Dimension | current/temporal lookup, overlapping valid range 거부, INNER hold, LEFT NULL publish/correction, archive replay |
| Materializer | 3-way JOIN, contiguous receipt boundary, stable insert token, retry, split failure, repair |
| Catalog | commit→revision→event log exactly once |
| Dashboard API | ClickHouse routing, stale, permission, cache |
| SSE | replica별 cursor, NOTIFY 유실 catch-up, heartbeat, replay, expired ID, disconnect, 5초 내 permission revoked |
| Browser E2E | produce→JOIN→Catalog→SSE→DOM render |
| Archive | same boundary count/checksum, lag, rebuild |
| Chaos | Kafka, Connect, ClickHouse, Postgres, worker, backend 순차 종료 |
| Security | injection, deployment/resource scope bypass, credential/log, resource abuse |
| Load | 1,000 EPS, 5,000 EPS burst, 500 SSE, P95/P99 |
| Migration | backfill, shadow, canary, rollback, old version retention |
| Reboot | clean host와 existing volume restart |

### 24.1 필수 full-stack E2E

단일 테스트가 다음을 모두 실제로 수행해야 한다.

1. 세 source Dataset과 pipeline version 생성
2. user/meta dimension 게시
3. published Dashboard와 3-way JOIN widget 생성
4. browser를 열고 EventSource 연결 확인
5. Kafka click event produce
6. ClickHouse raw row 확인
7. serving JOIN row 확인
8. Catalog revision 확인
9. SSE event 수신
10. browser DOM 값이 5초 안에 변경
11. browser reload 없이 완료
12. source position과 appliedRevision 증적 저장
13. LEFT JOIN 대상 dimension이 없는 event를 넣어 NULL 결과를 확인
14. dimension을 늦게 게시해 같은 serving key correction, revision 증가와 aggregate/DOM 교정을 확인

API를 직접 호출해 widget query만 확인하는 테스트는 browser E2E로 인정하지 않는다.

별도 rollback E2E는 실제 ClickHouse binding으로 cutover한 뒤 이전 archive/serving binding으로 rollback한다. 새 bindingEpoch/global revision, EventSource 재연결, frontend cache 교체, rollback 뒤 DOM 값, hot/archive 동일 boundary와 gap/overlap 0을 모두 검증한다. routing API 응답만 확인하는 테스트는 rollback E2E로 인정하지 않는다.

### 24.2 Failure injection

- ClickHouse insert 직후 worker kill
- PostgreSQL revision commit 직전 kill
- revision commit 직후 notifier kill
- SSE 연결 중 backend restart
- dimension을 click보다 늦게 publish
- multi-partition 중간 offset gap과 뒤 offset 선도착
- poison record quarantine, 승인 없는 skip 거부, audited skip/replay
- Kafka duplicate/rebalance 중 checkpoint CAS 경합
- ClickHouse replica failover
- Spark archive 10분 지연
- PostgreSQL NOTIFY 유실과 SSE replica 한 대 restart
- cutover 직후 rollback, 이전 binding 내부 revision이 더 낮은 상황

각 테스트는 최종 데이터, revision, UI 상태, audit를 검증한다.

---

## 25. CI required checks

main/dev PR required:

- frontend build
- frontend unit/component
- backend full unittest
- OpenAPI drift
- migration upgrade/downgrade
- ClickHouse integration
- realtime contract
- browser E2E
- security/static secret scan

nightly:

- chaos
- restart
- 100k fixture
- hot/archive parity
- performance regression

release:

- staging shadow
- canary checklist
- rollback drill
- image digest/SBOM

환경 부족으로 검증을 skip하면 green으로 처리하지 않는다. required environment unavailable 상태로 명확히 실패하거나 승인된 manual gate를 요구한다.

---

## 26. Acceptance criteria

### 26.1 기능

- 실제 ClickHouse hot path가 존재한다.
- 등록 SQL이 execution mode로 분류된다.
- 3-way JOIN 결과가 serving Dataset으로 Catalog에 등록된다.
- published Dashboard가 새로고침 없이 갱신된다.
- late dimension이 보존·재처리된다.
- archive가 독립적으로 계속 수렴한다.

### 26.2 정확성

- 10만 event 유실 0
- serving key 논리 중복 0
- revision 중복/역행 0, pointer 변경 시 bindingEpoch 단조 증가
- 동일 boundary retry 결과 동일
- checkpoint가 미분류 gap을 절대 건너지 않음
- base table 물리 중복이 있어도 serving_current widget/parity 결과가 동일
- shadow parity 기준 충족

### 26.3 UX

- stale/error/current 구분
- generic 빈 widget만 표시하는 오류 0
- 새 Dataset이 열린 Dashboard selector에 반영
- API 저장 실패가 성공처럼 표시되지 않음
- pipeline 상태로 이동 가능

### 26.4 운영

- clean reboot
- restore/rebuild
- traceId로 전 구간 추적
- alert/runbook
- 권한/credential 검증
- rollback 15분 이내

---

## 27. Definition of Done

모든 항목이 충족돼야 프로그램 완료다.

- 구현 코드와 migration 병합
- 관련 상위 문서 동기화
- API/interface drift 0
- production exact image pin
- full-stack browser E2E required
- chaos/restart/load/security 통과
- 72시간 shadow parity
- canary와 rollback drill
- live mock/legacy silent fallback 제거
- etl_service 신규 책임 추가 0
- ClickHouse/Archive 각각의 상태를 UI와 운영 지표로 확인 가능
- known limitation 문서화
- 운영자 handoff 완료

---

## 28. 리스크와 완화

| 리스크 | 영향 | 완화 |
| --- | --- | --- |
| dimension 변경이 incremental JOIN을 trigger하지 않음 | 과거 값 stale | versioned dimension + bounded repair/full rebuild |
| duplicate delivery | metric 과대 | source position, deterministic serving key, dedupe input |
| ReplacingMergeTree merge 지연 | query duplicate | canonical serving_current에서 FINAL 또는 검증된 argMax dedupe; base table query 금지 |
| ClickHouse/Postgres 부분 성공 | revision 누락 | materializationId + reconciler |
| SSE proxy buffering | 화면 지연 | buffering off, heartbeat, staging network test |
| SQL dialect drift | 실행 실패 | common AST + ClickHouse compiler + contract tests |
| Kafka consumer group lag 차이 | hot/archive 불일치 | partition metrics와 parity |
| view/pipeline 증가 | ingest 저하 | pipeline quota, cost estimate, load gate |
| legacy fallback 잔존 | 장애 은폐 | live import/behavior CI scan |
| 단일 EC2 장애 | 전체 중단 | demo 표시, HA topology 전환 gate |

---

## 29. 대략적 작업 순서와 인력

권장 최소 팀:

- backend/data 2명
- frontend 1명
- infra/QA 1명

병렬화 가능한 예상:

| 구간 | 예상 |
| --- | --- |
| Phase 0–1 | 1주 |
| Phase 2–4 | 2–3주 |
| Phase 5–7 | 2주 |
| Phase 8–9 | 1–2주 |
| 합계 | 6–8주 |

이는 확정 일정이 아니다. 첫 capacity test와 현재 배포 환경 자원 확인 후 갱신한다. cutover gate를 줄여 일정에 맞추지 않는다.

---

## 30. 구현 시작 체크리스트

- [ ] Product owner가 실시간/near-real-time/streaming-required 구분 승인
- [ ] ClickHouse deployment topology 승인
- [ ] Kafka Connect canonical 경로 승인
- [ ] SLO/capacity 승인
- [ ] SQL allowlist 승인
- [ ] dimension correction 정책 승인
- [ ] retention/cost 승인
- [ ] Catalog dual binding contract 승인
- [ ] SSE security/replay 승인
- [ ] Phase 0 문서 PR 생성
- [ ] characterization test baseline 저장

---

## 31. 공식 기술 근거

- [ClickHouse Kafka table engine](https://clickhouse.com/docs/engines/table-engines/integrations/kafka)
- [Incremental Materialized View와 JOIN trigger 제약](https://clickhouse.com/docs/materialized-view/incremental-materialized-view)
- [Refreshable Materialized View와 dependency](https://clickhouse.com/docs/materialized-view/refreshable-materialized-view)
- [ClickHouse Dictionary와 refresh](https://clickhouse.com/docs/dictionary)
- [ClickHouse 26.1 dependent MV deduplication](https://clickhouse.com/blog/clickhouse-release-26-01)
- [ClickHouse 26.3 LTS async insert 기본화](https://clickhouse.com/blog/clickhouse-release-26-03)
- [ClickHouse 공식 Kafka Connect Sink 활용 사례](https://clickhouse.com/blog/clickhouse-postgresql-change-data-capture-cdc-part-2)

공식 문서의 핵심 제약은 다음과 같다.

- Incremental MV는 left-most source insert에만 반응한다.
- right-side dimension 변경은 과거 result를 자동 수정하지 않는다.
- 복잡한 JOIN은 refreshable 또는 별도 streaming processor가 필요하다.
- Kafka Engine의 Keeper offset storage는 experimental이다.
- Materialized View 수와 JOIN 비용은 insert latency를 증가시킬 수 있다.

따라서 본 명세는 단일 MV에 모든 책임을 몰지 않고, versioned SQL compiler, incremental materializer, late repair, Catalog revision, durable event log, SSE를 독립 계약으로 둔다.
