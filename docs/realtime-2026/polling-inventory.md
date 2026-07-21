# Polling inventory

2026-07-16 코드 기준 조사 결과에 2026-07-21 수동 Dashboard 전환 상태를 반영했다.

| 화면/소유자 | 구현 위치 | 대상 | 주기/종료 조건 | SSE 전환 |
|---|---|---|---|---|
| Dashboard 보기·편집 Widget query | frontend/src/pages/dashboard/runtime/useDashboardWidgetData.ts | 선택 페이지 widget result | 화면·페이지 진입 또는 사용자 새로고침에서만 실행; timer 없음 | Dashboard frontend는 SSE를 소비하지 않음 |
| Job continuous runtime | frontend/src/hooks/useAskLakeData.ts | ETL Job/runtime | active 상태가 안정화될 때까지 재조회 | 범위 밖. Job event 도입 전 유지 |
| Snapshot Job run | frontend/src/hooks/useAskLakeData.ts | ETL Run | terminal 상태까지 재조회 | 범위 밖. 유지 |
| Job 상세 continuous 운영 | frontend/src/pages/ingest/JobsPages.tsx | continuous logs/runtime | active 동안 setTimeout | 범위 밖. 유지 |
| Trino Query Run | SQL 서비스/화면의 run refresh 경로 | Query Run/결과 준비 | terminal 또는 결과 준비까지 | 범위 밖. 유지 |

## Dashboard 수동 조회 소유권

- Dashboard frontend에는 live refresh timer와 EventSource 구독이 없다.
- `useDashboardRuntimeResources`가 보기·편집 runtime에 같은 `useDashboardWidgetData` 경로를 연결한다.
- 현재 페이지의 같은 Dataset을 쓰는 여러 Widget은 한 query 요청으로 묶는다.
- 요청 실패 시 마지막 성공 Widget 결과를 유지한다.

## 현재 운영 조건

backend event/SSE 계약 검증은 다른 consumer와 향후 재도입 호환을 위해 유지한다. Dashboard 사용자 가시성 검증은 보기·편집 화면 진입, 현재 페이지 새로고침, 실패 시 마지막 성공 결과 유지로 수행한다.
