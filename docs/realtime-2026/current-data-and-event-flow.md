# AskLake 현재 데이터·이벤트 흐름

기준 커밋은 2026-07-16 최신 origin/dev의 b93ae273이며, 이 문서는 STACK-01 조사 결과다. 2026-07-21 Dashboard 수동 모드 전환으로 frontend 자동 polling/SSE 소비 경로는 제거되었고, 아래 backend event 흐름은 호환·운영 기반으로만 남는다.

## 현재 Dashboard 갱신 흐름

1. Kafka Continuous worker가 micro-batch를 Iceberg에 커밋하고 batch report에 publication 정보를 남긴다.
2. backend의 ETL reconcile 경로가 보고서를 읽고 materialize_continuous_publication을 호출한다.
3. DashboardLiveRepository가 dataset_revision_commits와 dataset_kafka_partition_cursors를 잠근 뒤 리비전을 증가시킨다.
4. dashboard_widget_results는 적용한 dataset revision과 결과 payload를 PostgreSQL에 보존한다.
5. Dashboard 보기·편집 화면 진입 시 선택 페이지의 pending Widget을 query한다.
6. 사용자가 새로고침하면 선택 페이지의 Dataset Widget 전체를 query하고 성공 결과만 화면에 병합한다.

durable event log, PostgreSQL NOTIFY, EventSource endpoint는 backend에 존재하지만 Dashboard frontend는 구독하지 않는다. 따라서 UI 표시 시점은 화면 진입 또는 사용자의 수동 새로고침에 의존한다.

## 권위 데이터

| 상태 | canonical owner | 현재 확인 위치 |
|---|---|---|
| Kafka offset/checkpoint | Spark Structured Streaming checkpoint와 worker report | continuous worker/report 경로 |
| Iceberg 데이터 가시성 | 성공한 Iceberg commit과 Catalog 검증 | ETL publication reconcile |
| Dataset revision | PostgreSQL dataset_revision_commits | DashboardLiveRepository |
| Partition 중복 방지 cursor | PostgreSQL dataset_kafka_partition_cursors | DashboardLiveRepository |
| Published widget 결과 | PostgreSQL dashboard_widget_results | Dashboard live API |
| Dashboard 화면 상태 | REST snapshot을 보유한 React runtime state | useDashboardRuntimeResources |
| 정적 SQL 실행 | Trino Query Run 또는 DuckDB compatibility 경로 | SQL router/service |

## STACK-02 구현 흐름

STACK-02는 dataset revision commit과 같은 DB transaction에서 durable event를 기록한다. Dashboard publish도 published revision과 event를 한 transaction에 둔다. PostgreSQL NOTIFY는 프로세스를 깨우는 힌트일 뿐 권위 데이터가 아니며, API 프로세스는 event log cursor로 누락을 복구한다.

이 절은 STACK-02의 과거 설계 기록이다. 현재 브라우저는 Dashboard SSE에 연결하지 않으며, 기존 권한 검사를 거치는 Widget REST endpoint를 화면 진입과 수동 새로고침에서만 호출한다.

## Race-free snapshot 규칙

1. REST snapshot은 응답 데이터와 함께 현재 event cursor를 반환한다.
2. 클라이언트는 snapshot cursor 이후부터 SSE를 구독한다.
3. 연결 준비 중 생성된 event는 durable replay로 받는다.
4. replay 범위를 벗어나면 서버는 resync를 지시하고 클라이언트는 전체 snapshot을 다시 읽는다.

이 규칙은 snapshot 조회와 EventSource 연결 사이의 이벤트 유실 창을 닫는다.

## 현재 인증·격리 기준

현재 저장소는 배포 단위 설정과 ActorContext 기반 resource permission/governance를 사용한다. 별도 tenant 식별자가 없으므로 이번 작업에서 가상의 tenant 모델을 만들지 않는다. event audience는 deployment scope 안에서 resource type/id를 사용하고, replay와 refetch 모두 기존 backend permission 검사를 다시 통과해야 한다.
