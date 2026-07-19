# Polling inventory

2026-07-16 코드 기준 조사 결과다. 새 SSE 경로를 추가해도 이 목록은 rollback 경로로 유지한다.

| 화면/소유자 | 구현 위치 | 대상 | 주기/종료 조건 | SSE 전환 |
|---|---|---|---|---|
| Published Dashboard live refresh | frontend/src/pages/dashboard/runtime/usePublishedDashboardLiveRefresh.ts | dataset freshness, widget result bundle | dataset별 권장 delay를 적용하는 adaptive setTimeout; hidden/offline/terminal 조건 반영 | STACK-02에서 hybrid/sse mode일 때 notification 기반 targeted refetch, polling fallback 유지 |
| Job continuous runtime | frontend/src/hooks/useAskLakeData.ts | ETL Job/runtime | active 상태가 안정화될 때까지 재조회 | 범위 밖. Job event 도입 전 유지 |
| Snapshot Job run | frontend/src/hooks/useAskLakeData.ts | ETL Run | terminal 상태까지 재조회 | 범위 밖. 유지 |
| Job 상세 continuous 운영 | frontend/src/pages/ingest/JobsPages.tsx | continuous logs/runtime | active 동안 setTimeout | 범위 밖. 유지 |
| Trino Query Run | SQL 서비스/화면의 run refresh 경로 | Query Run/결과 준비 | terminal 또는 결과 준비까지 | 범위 밖. 유지 |

## Dashboard polling 소유권

- Dashboard live refresh timer는 usePublishedDashboardLiveRefresh 한 곳이 소유한다.
- useDashboardRuntimeResources가 published runtime과 live refresh를 결합한다.
- refresh 결정 로직은 dashboardLiveRefresh.ts의 revision/visibility 규칙을 재사용한다.
- 같은 dataset을 쓰는 여러 widget은 bundle refetch로 합쳐 중복 요청을 줄인다.

## 제거 조건

polling은 SSE 장애 시 자동 fallback과 운영 rollback 경로로 제거하지 않는다. Production Compose는 SSE를 기본 선택하며 다음 조건은 배포 환경에서 계속 확인한다.

- durable replay와 cursor 만료 resync 검증
- proxy buffering 비활성 및 heartbeat 확인
- 권한 변경/로그아웃 시 연결 종료 검증
- disconnect 시 polling 자동 복귀
- event lag와 reconnect 지표 관측 가능
