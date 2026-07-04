# 02. Architecture

이 문서는 AskLake의 현재 frontend baseline과 목표 backend architecture를 함께 기록한다.

## 1) 현재 구조

현재 repository는 frontend-only app이다.

```text
AskLake/
├─ frontend/
│  ├─ src/
│  │  ├─ components/
│  │  ├─ data/
│  │  ├─ hooks/
│  │  ├─ pages/
│  │  ├─ services/
│  │  ├─ styles/
│  │  └─ types/
│  ├─ package.json
│  └─ vite.config.ts
├─ docs/
│  ├─ api-contract.md
│  └─ backend-integration-readiness.md
└─ README.md
```

## 2) 기술 스택

| 영역 | 현재 선택 | 상태 | 메모 |
| --- | --- | --- | --- |
| Frontend | React + Vite + TypeScript | implemented | `frontend/` |
| UI icons | lucide-react | implemented | package dependency |
| Dashboard grid | react-grid-layout + react-resizable | implemented | draft editor drag/resize canvas |
| State | React hooks/local state | implemented | `useAskLakeData`, `useAuditLogs` |
| API client | fetch wrapper | partial | `frontend/src/services/apiClient.ts` |
| Backend | Node HTTP demo API | partial | `frontend/server/`, production backend remains TBD |
| Database | PostgreSQL demo metadata DB | partial | `docker-compose.yml`, JSONB tables plus dashboard revision tables |

## 3) 목표 시스템 구성

```mermaid
flowchart LR
    U[User] --> FE[React/Vite Frontend]
    FE --> API[AskLake Backend API]
    API --> DB[(Metadata DB)]
    API --> JOB[Job Runtime / Scheduler]
    API --> SQL[Query Runtime]
    API --> AUDIT[(Audit Log)]
```

현재는 `FE`만 구현되어 있고, backend/API/DB/runtime은 planned 상태다.

## 4) Frontend Layer

주요 책임:

- navigation과 화면 composition: `frontend/src/App.tsx`
- layout: `frontend/src/components/layout/`
- ingest/job 화면: `frontend/src/pages/ingest/`
- ETL creation flow: `frontend/src/pages/etl/`
- catalog 화면: `frontend/src/pages/catalog/`
- SQL 화면: `frontend/src/pages/sql/`
- dashboard 화면: `frontend/src/pages/dashboard/`
- dashboard runtime shell: `frontend/src/pages/dashboard/runtime/`
- mock data: `frontend/src/data/mockData.ts`
- domain state: `frontend/src/hooks/useAskLakeData.ts`
- audit/toast state: `frontend/src/hooks/useAuditLogs.ts`
- API boundary: `frontend/src/services/mockApi.ts`, `frontend/src/services/apiClient.ts`
- dashboard list/runtime API adapters: `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts`

라우팅은 아직 React Router가 아니라 `frontend/src/App.tsx`의 상태 기반 navigation이 중심이다.
Dashboard redesign Phase 01부터 `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit`는 `App.tsx`의 browser history/path parser가 처리한다.

## 5) Backend Target Boundary

백엔드가 소유할 책임:

- ETL job 생성과 상태 전이
- dataset catalog hydrate
- SQL query run 생성과 결과 반환
- dashboard 저장/게시/삭제
- audit log 저장
- 인증/권한이 도입될 경우 actor와 access policy 판정

프론트가 계속 소유할 책임:

- 화면 상태와 사용자 interaction
- loading/error 표시
- optimistic update 또는 rollback UX
- mock/live 전환 adapter

## 6) 데이터 모델 초안

상세 타입은 `docs/api-contract.md`와 `frontend/src/types/`를 기준으로 한다.

핵심 리소스:

| Resource | 현재 위치 | 백엔드 목표 |
| --- | --- | --- |
| ETL Job | `JobRowData` mock | persisted job resource |
| Dataset | `CatalogDataset` mock | catalog dataset resource |
| SQL Run | `SqlResultDraft` runtime state | query run resource |
| Dashboard | `DashboardEntry`, list adapter, draft/published runtime response | dashboard resource with revision/page/widget snapshots |
| Audit Log | `useAuditLogs` local/localStorage state | audit log resource |

## 7) API Boundary

현재 live mode 진입점:

- `VITE_USE_MOCK_API=false`
- `VITE_API_BASE_URL=http://localhost:8080`
- `frontend/src/services/mockApi.ts`
- `frontend/src/services/apiClient.ts`

P0 API:

- `POST /api/etl/jobs`
- `POST /api/etl/jobs/{jobId}/commands`
- `POST /api/query/runs`

P1 hydrate API:

- `GET /api/etl/jobs`
- `GET /api/etl/jobs/{jobId}`
- `GET /api/catalog/datasets`
- `GET /api/catalog/datasets/{datasetId}`

Dashboard runtime API:

- `GET /api/dashboards`
- `POST /api/dashboards`
- `POST /api/dashboards/query`
- `GET /api/dashboards/{dashboardId}/published`
- `POST /api/dashboards/{dashboardId}/draft/ensure`
- `POST /api/dashboards/{dashboardId}/draft/pages`
- `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
- `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
- `PATCH /api/dashboards/{dashboardId}/draft/layouts`
- `POST /api/dashboards/{dashboardId}/publish`

랜딩 페이지의 새 대시보드 생성은 `POST /api/dashboards`로 dashboard card를 `draft` 상태로 먼저 저장하고, 프론트는 응답받은 id로 `/dashboards/{dashboardId}` 조회 화면에 진입한다. Draft editor는 DB-backed draft revision을 편집하고, page 추가/삭제와 widget layout 저장을 API로 반영한다. Published viewer는 published revision만 읽으며, draft 변경사항은 `POST /api/dashboards/{dashboardId}/publish` 이후 새 published revision으로 보인다.
Phase 06 runtime UX는 별도 share API 없이 프론트에서 공유 링크를 복사한다. Published revision이 있으면 `/dashboards/{dashboardId}`를, draft만 있으면 `/dashboards/{dashboardId}/edit`를 복사하며, publish 성공 후 목록 상태도 다시 갱신한다.
Dashboard draft editor shell은 화면 높이 안에서 상단 바, 페이지 탭, 필터 행, 왼쪽 dataset sidebar, 오른쪽 inspector를 고정 흐름으로 유지하고, 위젯이 많아질 때 중앙 canvas 영역 안에서만 스크롤한다.
Dataset 기반 위젯 생성 준비 단계에서는 draft editor가 transient `selectedDatasetId`를 소유하며, Gold dataset 목록은 `useDashboardDatasets` mock hook을 통해 공급한다. 이 hook은 이후 `GET /api/catalog/datasets` hydrate로 교체할 경계다.
Dataset 기반 widget 생성 폼은 선택 dataset의 `string`/`date` 컬럼을 x축 후보로, `number` 컬럼을 y축 후보로 사용하며, `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`에 `datasetId`와 `config`를 함께 전송한다.
Draft grid는 위젯 카드 전체에서 drag를 시작할 수 있게 유지하되, no-reflow collision guard로 다른 위젯이 과하게 아래로 밀리는 layout을 막는다. 새 위젯은 현재 page layout에서 충돌하지 않는 첫 빈 위치에 배치하고, drag/resize stop 시 충돌 layout은 draft state와 `PATCH /api/dashboards/{dashboardId}/draft/layouts`에 저장하지 않고 되돌린다.

## 8) 설계 원칙

- Mock data는 demo baseline이며, 최종 persistence model로 간주하지 않는다.
- API response shape는 프론트 타입과 문서가 함께 바뀌어야 한다.
- API, mock fixture, frontend internal state의 status 값은 영어 canonical value로 유지하고 UI label mapper에서 한국어 표시로 변환한다.
- Backend 연결은 생성/명령/SQL 실행 같은 P0 vertical slice부터 시작한다.
- SQL runtime은 read-only guard를 가져야 한다.
- 감사 로그는 사용자에게 보이는 제품 기능이면서 backend integration evidence로도 쓰일 수 있다.

## 9) 운영/배포 메모

- 현재 실행은 frontend dev server 기준이다.
- backend dev server, DB, migration, container strategy는 아직 정하지 않았다.
- CI가 생기면 최소 required check 후보는 frontend build다.
