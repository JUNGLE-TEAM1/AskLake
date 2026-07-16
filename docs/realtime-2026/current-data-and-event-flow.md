# AskLake 현재 데이터·이벤트 흐름

기준 커밋은 2026-07-16 최신 origin/dev의 b93ae273이며, 이 문서는 STACK-01 조사 결과다.

## 현재 Dashboard 갱신 흐름

1. Kafka Continuous worker가 micro-batch를 Iceberg에 커밋하고 batch report에 publication 정보를 남긴다.
2. backend의 ETL reconcile 경로가 보고서를 읽고 materialize_continuous_publication을 호출한다.
3. DashboardLiveRepository가 dataset_revision_commits와 dataset_kafka_partition_cursors를 잠근 뒤 리비전을 증가시킨다.
4. dashboard_widget_results는 적용한 dataset revision과 결과 payload를 PostgreSQL에 보존한다.
5. published Dashboard 화면의 usePublishedDashboardLiveRefresh가 freshness API를 adaptive polling한다.
6. 새 revision이 확인된 경우에만 widget result bundle을 다시 조회하고 화면을 교체한다.

현재 경로에는 Dashboard용 durable event log, PostgreSQL NOTIFY, EventSource 연결이 없다. 따라서 UI 표시 시점은 polling 주기에 의존한다.

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

## 목표 흐름

STACK-02부터 dataset revision commit과 같은 DB transaction에서 durable event를 기록한다. PostgreSQL NOTIFY는 프로세스를 깨우는 힌트일 뿐 권위 데이터가 아니며, API 프로세스는 event log cursor로 누락을 복구한다.

브라우저는 SSE payload를 데이터 본문으로 사용하지 않는다. 알림에 포함된 resource identity와 revision을 기준으로 기존 권한 검사를 거치는 REST endpoint를 targeted refetch한다. 연결 실패, cursor 만료, resync 지시는 기존 polling으로 복귀한다.

## Race-free snapshot 규칙

1. REST snapshot은 응답 데이터와 함께 현재 event cursor를 반환한다.
2. 클라이언트는 snapshot cursor 이후부터 SSE를 구독한다.
3. 연결 준비 중 생성된 event는 durable replay로 받는다.
4. replay 범위를 벗어나면 서버는 resync를 지시하고 클라이언트는 전체 snapshot을 다시 읽는다.

이 규칙은 snapshot 조회와 EventSource 연결 사이의 이벤트 유실 창을 닫는다.

## 현재 인증·격리 기준

현재 저장소는 배포 단위 설정과 ActorContext 기반 resource permission/governance를 사용한다. 별도 tenant 식별자가 없으므로 이번 작업에서 가상의 tenant 모델을 만들지 않는다. event audience는 deployment scope 안에서 resource type/id를 사용하고, replay와 refetch 모두 기존 backend permission 검사를 다시 통과해야 한다.
