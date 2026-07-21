# ADR-002: Continuous SQL stream-static JOIN

- 상태: Accepted
- 결정일: 2026-07-16
- 범위: Continuous SQL V1

> [ADR-003](003-sql-job-execution-tree-ownership.md)이 execution ownership과 producer 재사용 경계를 후속 정의한다. 이 ADR의 SQL shape, static snapshot, cardinality 안전 계약은 유지하지만 direct Kafka consumer ownership은 legacy 구현으로만 남는다.

## 결정

V1은 streaming relation 정확히 1개와 static relation 1개 이상을 지원한다. JOIN은 INNER와 LEFT만 허용하며 명시적인 equality key가 필요하다. SELECT projection, alias, deterministic scalar expression을 허용하고 aggregate, window, subquery, UNION, CROSS/FULL/RIGHT JOIN, stream-stream JOIN은 거절한다.

기본 static binding은 PINNED_AT_START다. Job 시작 시 static dataset의 검증된 Iceberg snapshot/table metadata를 manifest에 고정하고, 모든 micro-batch가 그 binding을 사용한다.

LATEST_PER_BATCH는 별도 flag가 켜진 경우에만 batch 시작 시 최신 static snapshot을 다시 resolve한다. STATIC_CHANGE_BACKFILL은 별도 flag와 명시적 운영 승인 없이는 실행하지 않는다.

지연을 줄이기 위해 현재 SQL 분석 frontend는 새 Continuous SQL Job에 5초 trigger를 명시적으로 제출한다. API에서 생략했을 때의 기본값은 10초다. Catalog row 통계가 설정 한도 이하인 exact static snapshot만 Spark memory/disk에 cache한다. 실제 snapshot 유일키 검증은 같은 snapshot·JOIN key에서 한 번만 수행하고, snapshot 변경 시 cache와 검증 identity를 폐기한다. 통계가 없으면 cache하지 않는 fail-safe를 선택한다. ADR-003 목표 구조에서는 SQL Job의 trigger 설정을 제거하고 producer Job 설정과 Dataset revision을 따른다.

새 Continuous SQL output table의 Iceberg partition spec에 내부 `_asklake_run_id`를 추가한다. 그러면 Trino가 publication exact-count와 Dashboard delta query에서 해당 batch file만 가지치기할 수 있다. 기존 table은 partition evolution을 자동 수행하지 않고 기존 spec을 유지한다.

이 최적화는 exact Iceberg snapshot의 `_asklake_run_id` 행 수를 Trino로 확인한 후에만 Catalog revision을 게시하는 안전 계약을 바꾸지 않는다. 현재 frontend가 제출하는 5초는 trigger interval이지 end-to-end 반영 SLA가 아니다. Dashboard는 해당 Dataset을 수동 새로고침으로 조회한다.

## 결과 의미

- PINNED_AT_START: static dataset이 바뀌어도 실행 중인 Job의 이후 batch와 과거 output은 바뀌지 않는다. 새 binding은 restart/new run에서 적용한다.
- LATEST_PER_BATCH: static 변경 이후 시작한 batch만 새 snapshot을 사용한다. 이미 publish한 batch는 재작성하지 않는다.
- BACKFILL_ON_CHANGE: V1의 기본 실행 경로가 아니다. replay 가능한 source boundary, stable output key, 별도 generation/fencing이 준비된 승인 작업에서만 과거 범위를 재계산한다.

## Cardinality와 null

- planner는 static JOIN key 존재와 타입 호환성을 검증한다.
- static key uniqueness는 기본 요구다. 검증할 수 없거나 중복이면 create/start를 거절한다.
- NULL equality key는 SQL 표준대로 match하지 않는다.
- LEFT JOIN의 불일치 stream row는 static projection을 NULL로 둔다.
- many-to-many 결과 증폭은 V1에서 허용하지 않는다.
- SCD2/as-of temporal JOIN은 V1 범위 밖이다.

## Idempotency

Job/run/batch identity, source boundary, plan fingerprint, static binding fingerprint, output target을 batch manifest에 기록한다. 같은 identity 재시도는 같은 결과를 재사용하거나 안전하게 거절하며, 다른 plan/binding으로 같은 batch identity를 덮어쓰지 않는다. Catalog publication 성공 후에만 dataset revision과 Dashboard event를 노출한다.

## Rollback

CONTINUOUS_SQL_JOIN_ENABLED=false이면 create/start를 명확히 거절하되 기존 Kafka Continuous ingestion과 정적 SQL/Trino Job은 그대로 동작한다. advanced flags를 꺼도 PINNED_AT_START 기본 경로는 유지된다.
