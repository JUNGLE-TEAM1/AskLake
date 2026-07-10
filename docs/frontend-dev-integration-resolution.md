# PR #525 Frontend/Dev 통합 결정 기록

이 문서는 PR #525(`refactor -> dev`)의 충돌 해결 근거와 검증 결과를 기록합니다. 통합 결과의 기능 기준은 최신 `dev`, UI 구조 기준은 `refactor`입니다. 각 변경은 화면 또는 계약 단위의 작은 커밋으로 분리합니다.

## 시작 지점과 안전장치

- 원본 작업 트리 시작 HEAD: `ad2847ad020976ac825dae1757702817bb4d64dd`
- `origin/dev`: `02f5487e84aad9c289d777d571502266036c4b60`
- `origin/refactor`: `4a8eb892766ce5b984ea0213b9d58be30eb7bb3d`
- merge-base: `fee85a959d638a6b66659fbf7dd187acafbdd8bf`
- 로컬 안전 브랜치: `backup/pre-refactor-dev-integration-20260711`
- 격리 작업 트리: `/private/tmp/asklake-pr525-integration`
- 통합 브랜치: `codex/pr-525-dev-integration` (`origin/dev` 기준)
- Git 자동 병합 계산 트리: `f363c3f3dc04aed02009e55c84f58c3efbbebae5`

원본 작업 트리의 untracked `docs/frontend-page-audit/* 2.md` 파일은 통합 대상에서 제외하며 건드리거나 stage하지 않습니다.

## 통합 원칙

1. 인증, 권한, API 호출, Backend 계약, 실제 데이터 흐름, 상태 관리, 오류·로딩 처리와 도메인 동작은 `dev`를 보존합니다.
2. React Router, shadcn/ReUI primitive, TanStack DataTable, 공통 composition, SUIT typography, spacing과 화면 구조는 `refactor`를 적용합니다.
3. Git이 충돌 없이 합친 결과는 화면 묶음별로 가져오고, 아래 43개 충돌 파일은 merge-base·`dev`·`refactor`를 직접 비교합니다.
4. 삭제는 사용처가 사라진 selector와 legacy 코드만 대상으로 하며, `rg`와 route QA 전에 공유 CSS를 제거하지 않습니다.
5. 문서가 live Backend 기본 정책과 충돌하면 `01`~`04`, API 계약, README 순서의 상위 문서를 따르고 불일치를 이 문서에 기록합니다.

## 충돌 파일별 병합 메모

### A. Backend·API·계약

| 파일 | `dev`에서 반드시 보존 | `refactor`에서 반영 | 병합 기준 |
| --- | --- | --- | --- |
| `backend/app/api/etl.py` | 인증/권한, 최신 ETL endpoint와 request 처리 | Job 목록 filter/facet query | 최신 endpoint에 filter/facet 인자를 결합 |
| `backend/app/schemas/etl.py` | persisted Job edit, Kafka/Airflow/target metadata 계약 | Job list facet, progress, 실행 관측 optional timing | 기존 필드를 삭제하지 않고 additive schema로 통합 |
| `backend/app/services/etl_service.py` | Airflow 실행, Kafka snapshot, persisted edit/materialization/lineage | server-backed Job filter/facet과 목록 상태 집계 | dev service 흐름 안에 조회 전용 집계 로직을 이식 |
| `backend/scripts/spark_job_run.py` | Kafka/CSV/Parquet/Spark 실행과 persisted 결과 | partition/단계 timing 보강 | 실제 실행 흐름을 유지하고 optional metadata만 결합 |
| `backend/scripts/verify-backend.mjs` | dev 전체 Backend 검증 | Job list 검증 연결 | 기존 검증을 제거하지 않고 새 검증을 추가 |
| `backend/src/createPipeline.mjs` | 최신 create/update/Kafka/target metadata | partition 및 Job 목록 호환 metadata | create payload shape를 dev 기준으로 유지 |
| `docs/03-api-reference.md` | 최신 auth, permissions, ETL edit, Kafka/Airflow, SQL/Dashboard API | Job filter/facet 및 실행 timing 문서 | 실제 통합 계약과 일치하도록 병합 |
| `docs/04-development-guide.md` | 최신 live Backend·검증 명령 | frontend UI 회귀 검증 절차 | 명령을 모두 보존하고 중복만 정리 |
| `docs/api-contract.md` | 최신 실제 request/response 계약 | 목록 filter/facet 및 optional timing | 상위 API 문서와 코드 결과를 기준으로 병합 |
| `docs/backend-integration-readiness.md` | 실제 Backend 준비 상태와 live 기본값 | UI가 요구하는 Job list/observability 준비 항목 | 구현/미구현을 과장하지 않고 구분 |

### B. App Shell·상태·타입

| 파일 | `dev`에서 반드시 보존 | `refactor`에서 반영 | 병합 기준 |
| --- | --- | --- | --- |
| `frontend/src/App.tsx` | auth gate, profile/admin/AI route, SQL Run hydration, Job edit, permissions, live data props | React Router location/navigate, 공통 loading/error UI, 새 Jobs/Catalog/SQL/Dashboard composition | dev 기능 callback을 Router 기반 shell과 refactor JSX에 다시 연결 |
| `frontend/src/hooks/useAskLakeData.ts` | current user 기반 요청, Job edit hydrate/update, materialization delete, live API state | server-backed Job filters/facets, action 후 행 단위 갱신 | 전체 재조회 없이 dev API 기능과 filter 상태를 함께 유지 |
| `frontend/src/services/draftPipelineContract.ts` | persisted edit, Kafka/target/review 최신 payload | partition/표시 호환 필드 | dev payload를 기준으로 additive 변환만 반영 |
| `frontend/src/services/mockApi.ts` | live 계약을 흉내 내는 최신 mock, edit/auth 관련 shape | UI QA용 facets/progress/timing fixture | mock이 실제 API shape에서 벗어나지 않도록 통합 |
| `frontend/src/types/etl.ts` | 최신 Job edit/Kafka/target/review 타입 | list facets, progress, operational metrics, step timing | 기존 union/필드를 삭제하지 않는 additive 통합 |
| `frontend/src/types/navigation.ts` | login/profile/admin/AI flow | Router 기반 jobs/catalog/sql/dashboard flow | 모든 실제 route ID를 포함하도록 통합 |
| `frontend/scripts/verify-ui-regressions.mjs` | dev 기능 회귀 검사 | refactor primitive/route/UI 정책 검사 | 양쪽 검사를 유지하고 오래된 selector 기대만 수정 |

### C. 화면·공통 UI 혼합

| 파일 | `dev`에서 반드시 보존 | `refactor`에서 반영 | 참고 문서 |
| --- | --- | --- | --- |
| `frontend/src/components/etl/TransformFunctionModal.jsx` | 최신 transform method/model 기능 | `DialogShell`, shadcn form/control | component/shadcn inventory |
| `frontend/src/components/layout/Topbar.tsx` | current user, login/logout/account 동작 | Avatar/IconButton/Tooltip과 shell styling | UI shell follow-up |
| `frontend/src/components/s3/S3PathField.tsx` | 실제 S3 loading/error/lazy selection | `PickerDialog`, Field/InputGroup, Tree shell | ETL target audit |
| `frontend/src/components/target/DatabaseField.tsx` | 실제 DB 목록/error/select | `PickerDialog`, Field/InputGroup/Button | ETL target audit |
| `frontend/src/pages/catalog/CatalogPage.tsx` | current user 권한, materialization delete, live loading/error/API | shadcn result/preview, Tabs/Sheet/Accordion, ReactFlow UI | catalog, catalog-detail audit |
| `frontend/src/pages/dashboard/components/DashboardTable.tsx` | 권한과 최신 row action/data | Jobs식 DataTable stacked cell, Avatar, StatusBadge | dashboards audit |
| `frontend/src/pages/dashboard/runtime/DashboardAssistantPanel.tsx` | 실제 AI assistant contract/state | Bubble, Textarea, Button feedback UI | dashboard-edit audit |
| `frontend/src/pages/dashboard/runtime/DashboardPageTabs.tsx` | page rename/delete/draft state | shadcn button/input/tab interaction | dashboard view/edit audit |
| `frontend/src/pages/dashboard/runtime/DashboardRuntimeShell.tsx` | runtime layout state와 edit 기능 | responsive shell/ScrollArea/common controls | dashboard view/edit audit |
| `frontend/src/pages/dashboard/runtime/DashboardRuntimeView.tsx` | revision/widget persistence, published/draft 기능, SQL context | Empty/Alert/Skeleton, share/copy, polished layout | dashboard view/edit audit |
| `frontend/src/pages/dashboard/runtime/DashboardTopBar.tsx` | auth/permissions/runtime actions | Button/Toggle/Tooltip/share Sheet UI | dashboard view/edit audit |
| `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx` | dataset 선택과 widget config callback | Kibo/shadcn Tree, ScrollArea, states | dashboard-edit audit |
| `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx` | widget schema, chart/config/permission logic | Field/Select/Combobox/ToggleGroup/Popover UI | dashboard-edit audit |
| `frontend/src/pages/etl/EtlPages.tsx` | edit lock, persisted draft, Kafka/review/create 기능 | PageHeader, shadcn fields, Target/Review polish | ETL target/review audits |
| `frontend/src/pages/etl/SchemaTransformWorkbench.tsx` | 최신 transform data/model behavior | renamed AskLake workbench shell과 common controls | component/CSS inventory |
| `frontend/src/pages/etl/SourceAssetTree.tsx` | live source loading/select behavior | common TreeView/TreeRow UI | tree refactor inventory |
| `frontend/src/pages/ingest/JobsPages.tsx` | edit command, live data, command semantics | #440~#442 Jobs/detail/runs UI, DataTable, Timeline | jobs, jobs-detail, jobs-runs audits |
| `frontend/src/pages/sql/SqlAnalysisPage.tsx` | current user, Query AI, SQL run persistence/dashboard context | Tabs, Kibo Tree, DataTable, ScrollArea, dialog polish | SQL audit |
| `frontend/src/pages/sql/SqlDatasetRow.tsx` | live dataset selection semantics | Kibo Tree row and selected state UI | SQL audit |

### D. 스타일

| 파일 | 보존/반영 기준 |
| --- | --- |
| `frontend/src/styles/base.css` | dev auth/admin/AI base 스타일을 보존하고 SUIT/token 기준을 결합 |
| `frontend/src/styles/catalog.css` | refactor의 축소된 shadcn layout을 기준으로 하되 dev 기능 class 사용처를 먼저 대조 |
| `frontend/src/styles/dashboard.css` | 목록 기능 selector를 보존하고 refactor DataTable/feedback 스타일을 적용 |
| `frontend/src/styles/etl.css` | dev Kafka/review/edit selector를 보존하고 교체 완료된 legacy selector만 제거 |
| `frontend/src/styles/ingest.css` | #440~#442 UI 기준을 우선하되 dev edit/command selector 사용처를 보존 |
| `frontend/src/styles/responsive.css` | dev 신규 화면과 refactor route 모두 유지하고 최종 breakpoint QA 후 축소 |
| `frontend/src/styles/schema-transform-adapter.css` | 최신 workbench class와 rename된 AskLake selector를 함께 지원 |
| `frontend/src/styles/sql.css` | refactor의 401줄 shadcn/Kibo 구조를 기준으로 dev Query AI/권한 기능 selector만 복원 |

## 문서 불일치 기록

- `docs/frontend-page-audit-handoff.md`와 `docs/frontend-page-audit/etl-target.md` 일부는 mock mode 기본값을 `true`로 설명하지만, 상위 문서와 현재 README는 live Backend 기본, mock은 명시적 opt-in으로 정의합니다. 통합 결과는 live 기본을 유지합니다.
- `docs/frontend-tree-panel-refactor.md`의 초기 TreePanel 설명은 이후 #421/#468/#487 문서보다 오래됐습니다. SQL/Dashboard는 Kibo/shadcn Tree, S3/ETL은 현재 공통 Tree 계약을 따릅니다.
- ETL Source/Schema/Rules/Schedule/Permission의 개별 감사 문서는 현재 브랜치에 존재하지 않습니다. 관련 화면은 전체 inventory와 실제 dev 기능을 우선해 병합하고 수동 QA 항목으로 남깁니다.

## 커밋 및 검증 기록

구현을 진행하면서 커밋 SHA, 포함 파일, 실행한 검증을 아래에 추가합니다.
