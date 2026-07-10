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
3. Git이 충돌 없이 합친 결과는 화면 묶음별로 가져오고, 아래 충돌·고위험 파일은 merge-base·`dev`·`refactor`를 직접 비교합니다.
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
| `frontend/src/services/draftPipelineContract.ts` | persisted edit, Kafka/target/review 최신 payload, target tags/partition/index와 edit hydrate/update | 별도 반영 없음 | 세 버전 대조 결과 `dev`가 `refactor`의 요구를 포함한 strict superset이므로 의도적으로 `dev` 버전을 그대로 유지 |
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

- `docs/frontend-page-audit-handoff.md`와 `docs/frontend-page-audit/etl-target.md`의 과거 mock 기본값 설명에는 현재 상태 안내를 추가했습니다. 통합 결과는 live Backend 기본, mock 명시적 opt-in입니다.
- `docs/frontend-tree-panel-refactor.md`, 초기 전체 계획과 Person A/B 분업 문서에는 현재 Tree 상태 안내를 추가했습니다. SQL/Dashboard는 Kibo/shadcn-compatible Tree, S3/ETL은 `TreePanel`과 로컬 Tree composition을 따릅니다.
- ETL Source/Schema/Rules/Schedule/Permission의 개별 감사 문서는 현재 브랜치에 존재하지 않습니다. 관련 화면은 전체 inventory와 실제 dev 기능을 우선해 병합하고 수동 QA 항목으로 남깁니다.

## 의도적으로 변경하지 않은 파일

- `frontend/src/services/draftPipelineContract.ts`는 `dev` 버전을 그대로 유지했습니다. `dev`에는 `refactor`가 기대한 partition 호환성뿐 아니라 target database/description, trim, tags, partition/index columns, edit hydrate/update까지 포함되어 있습니다. UI를 맞춘다는 이유로 이 계약을 이전 상태로 되돌리면 persisted edit와 최신 Target 기능이 손실되므로 변경하지 않는 것이 올바른 통합입니다.

## 커밋 및 검증 기록

각 커밋은 해당 묶음만 `git revert <sha>`로 되돌릴 수 있도록 분리했습니다.

| SHA | 목적 |
| --- | --- |
| `59e7fc9` | 통합 결정 기록과 파일별 병합 근거 추가 |
| `041fc07` | shadcn/ReUI 공통 primitive와 의존성 통합 |
| `a40e6de` | Router, App Shell, 인증과 live 상태 계약 통합 |
| `aa27a8c` | ETL API와 Job 상태/filter/facet 계약 통합 |
| `98ee4df` | Spark 다중 partition과 실행 timing 계약 통합 |
| `e0b958c` | 수집/처리 목록, 상세, 실행 관측 UI와 dev 기능 통합 |
| `81caf60` | ETL connector와 공통 생성 보조 UI 통합 |
| `c439936` | persisted ETL 생성 기능과 shadcn 화면 통합 |
| `e929b16` | ETL legacy xflow selector와 CSS 정리 |
| `ad0a4bc` | Catalog 권한/삭제/materialization 기능과 shadcn 화면 통합 |
| `1f8ff01` | Catalog legacy CSS 정리 |
| `f8c8d11` | SQL query/permission 기능과 shadcn/Kibo 화면 통합 |
| `3f40253` | SQL legacy CSS와 회귀 검사 기준 정리 |
| `e2c041e` | Dashboard 목록 권한/액션과 DataTable UI 통합 |
| `1b1d883` | Dashboard runtime 권한과 shadcn chrome 통합 |
| `8e91e23` | Dashboard dataset tree와 widget 설정 통합 |
| `1fcdffb` | Dashboard legacy CSS와 회귀 기준 정리 |
| `c9572d7` | MUI/Emotion 잔여 의존성과 frontend 환경 기준 정리 |
| `ded30cc` | 화면 QA fixture와 Job 상태 라벨 정책 통합 |
| `0a703b1` | SQL 결과 DataTable과 legacy 보조 화면 정리 |
| `c24311d` | Dashboard 목록 보조 UI와 Assistant 설정 통합 |
| `7425c5e` | Dashboard 편집 기능과 공통 UI composition 통합 |
| `9582341` | Dashboard widget UI와 MUI 잔여 스타일 정리 |
| `4e38b35` | 반응형 규칙과 legacy Jobs CSS 충돌 해결 |
| `5230cd1` | frontend inventory와 페이지 감사 문서 통합 |
| `5e59985` | live frontend Router와 Spark 통합 기준 동기화 |
| `fc3cc83` | dev 기능과 refactor UI의 API 계약 문서 통합 |
| `e14b878` | Airflow와 frontend UI 검증 절차 통합 |
| `1d6fdb2` | 통합 파일 EOF whitespace 정리 |
| `6cac969` | Dashboard/ETL 좁은 화면 scroll containment 보강 |
| `e115a6f` | 통합 결과, 과거 문서 상태와 검증 기록 확정 |
| `c038fe2` | dev 신규 인증/프로필/관리 화면의 legacy xflow class 이름 제거와 회귀 검사 추가 |

이 표를 갱신하는 마지막 문서 커밋은 자기 자신의 SHA를 문서 안에 안정적으로 기록할 수 없으므로 최종 `git log`와 작업 보고에서 확인합니다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `git diff --check origin/dev..HEAD` | 통과 |
| 충돌 marker 및 runtime MUI/xflow 잔여 검색 | runtime 코드에 충돌 marker와 `xflow-` class 없음. MUI/Emotion 직접 dependency 제거 확인. `package-lock.json`에는 Motion의 선택적 Emotion peer 선언이 남고, 기존 worktree `node_modules`의 Emotion 설치본은 extraneous로 확인됨 |
| `cd frontend && npm run build` | 통과. Vite가 약 2.57 MB JS chunk에 대한 500 kB 초과 경고를 출력함 |
| `cd frontend && npm run verify:ui-regressions` | 20개 검사 통과 |
| `cd backend && npm run verify:job-list` | 통과 |
| `cd backend && python3 -m compileall -q app scripts` | 통과 |
| `cd backend && npm run verify` | 통과. sandbox listen 제한 때문에 권한이 있는 환경에서 재실행함 |
| `cd backend && npm run verify:spark-run` | 종료 코드 0. 검증 직후 생성 Job이 live metadata에서 `running`으로 관찰되어 실제 Spark 완료까지는 준비된 인프라에서 후속 확인 필요 |
| `cd backend && npm run verify:fastapi-etl-catalog` | 현재 Python에 `duckdb`가 없어 시작 전 중단. 준비된 interpreter 또는 backend requirements 설치 환경에서 재검증 필요 |

## 브라우저 QA

- live Backend 기본 모드에서 admin 로그인과 `/profile`의 role/group/permission 정보를 확인했습니다.
- `/jobs`, 실제 Job 상세와 실행 이력, `/catalog`, `/sql`, Dashboard 목록/보기/편집, ETL Source/Schema/Rules/Schedule/Permission/Target/Review를 확인했습니다.
- live Catalog DB가 비어 있는 환경에서는 올바른 empty state를 확인했고, populated Catalog/SQL/Dashboard UI는 명시적 mock adapter에서 별도로 확인했습니다.
- Jobs 상태 filter가 4건에서 실행 중 1건으로 좁혀지는 것, 실행 이력 이동, 실행 단계 Dialog와 8단계 timing/diagnostics를 확인했습니다.
- 1280px, 768px, 390px 폭에서 document root 가로 overflow가 없음을 확인했습니다. Dashboard table과 ETL stepper/schema table은 필요한 경우 내부 scroll만 유지합니다.
- 브라우저 console error는 0건이었습니다.

## 남은 위험과 후속 확인

1. 실제 대용량 Catalog/Tree/Table 데이터에서 성능과 가상화 필요성을 측정해야 합니다.
2. Vite bundle 분할과 lazy loading은 별도 성능 작업으로 남습니다.
3. FastAPI ETL/Catalog smoke는 `duckdb`가 준비된 Backend 환경에서 다시 실행해야 합니다.
4. Spark verifier가 만든 Job의 terminal 상태와 materialization 결과는 실제 Spark/Airflow 인프라에서 확인해야 합니다.
5. 실제 권한 조합, Backend 오류 응답, 15인치 화면과 발표용 대형 디스플레이에서 최종 시각 QA와 반응형 폴리싱이 필요합니다.

이 브랜치는 로컬 통합 결과만 보유합니다. 원격 push, PR merge, force push는 수행하지 않습니다.
