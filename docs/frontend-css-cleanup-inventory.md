# Frontend CSS Cleanup Inventory

## 목적

이 문서는 AskLake 프론트엔드 UI 전환 중 어떤 CSS를 유지하고, 어떤 CSS를 공통 UI primitive 또는 DataTable로 옮긴 뒤 정리할지 추적하는 작업용 인벤토리다.

현재 `frontend/src/styles.css`는 화면별 CSS를 전역으로 import한다. 그래서 작은 selector 삭제나 수정도 다른 화면에 영향을 줄 수 있다. 이 문서는 CSS를 바로 삭제하기 위한 문서가 아니라, A/B가 병렬로 전환 작업을 하면서 같은 기준으로 정리 후보를 표시하기 위한 문서다.

## 운영 규칙

- 이 문서는 계속 업데이트한다. UI 전환, UI 폴리싱, CSS 삭제 PR마다 관련 행의 상태와 메모를 갱신한다.
- 이 PR에서는 CSS를 삭제하지 않는다. 삭제는 별도 cleanup PR에서 진행한다.
- `rg`에서 사용처가 안 보여도 동적 class 조합, 외부 라이브러리 class, responsive selector 가능성을 확인하기 전에는 삭제하지 않는다.
- `responsive.css`에 남은 selector는 데스크톱과 모바일 route QA가 끝나기 전까지 유지한다.
- `styles.css` import 순서는 전체 영향이 크므로 동시 수정 금지 영역으로 본다.
- Backend API, 데이터 계약, 도메인 로직은 CSS 정리 범위가 아니다.
- B가 Catalog/SQL/Dashboard 작업으로 정리하게 될 CSS도 이 문서에서 함께 추적한다.

## 상태 값

| 상태 | 의미 |
| --- | --- |
| `사용 중` | 현재 화면 렌더링에 필요하다. 삭제 금지. |
| `교체 후보` | 공통 primitive, DataTable, layout component로 옮긴 뒤 줄일 수 있다. |
| `삭제 후보` | 대체 작업과 route QA가 끝난 뒤 삭제 PR에서 제거할 수 있다. |
| `보류` | 외부 라이브러리, 복잡한 화면 상태, 트리/그래프/런타임 동작과 묶여 있어 별도 검증이 필요하다. |

## 현재 스냅샷

기준일: 2026-07-09

기준 브랜치: `feat-#350`, `origin/refactor` 기반

주의: A02 `feat-#341`과 B02 `origin/feat-#340`의 일부 작업은 아직 `refactor`에 모두 정리되어 들어온 상태가 아닐 수 있다. 이 문서는 현재 CSS 상태와 진행 중 A/B 작업으로 생길 cleanup 후보를 함께 추적한다.

| 파일 | 줄 수 | 주 담당 | 현재 판단 | 메모 |
| --- | ---: | --- | --- | --- |
| `frontend/src/styles/base.css` | 717 | A/B 공통 | `교체 후보` | reset, token, `.icon-button` 등 공통 기반. primitive 전환 후 축소 대상. |
| `frontend/src/styles/layout.css` | 713 | A | `교체 후보` | App Shell, Sidebar, Topbar, Page title, legacy button class 포함. |
| `frontend/src/styles/ingest.css` | 1,968 | A | `교체 후보` | Jobs 목록/상세/Run History. A02와 DataTable 적용 후 정리 후보가 생김. |
| `frontend/src/styles/ingest-dag.css` | 537 | A | `보류` | Run DAG modal/graph 전용. 화면 QA 전 삭제 금지. |
| `frontend/src/styles/etl.css` | 9,064 | A | `보류` | Source/Schema/Schedule/Permission/Target/Review가 한 파일에 섞여 있어 A03 이후 단계적 분리 필요. |
| `frontend/src/styles/responsive.css` | 591 | A/B 공통 | `보류` | 여러 화면의 모바일 대응이 섞여 있음. 각 route 모바일 QA 후 정리. |
| `frontend/src/styles/catalog.css` | 1,579 | B | `교체 후보` | Catalog 목록/상세, lineage, schema preview. B03 전환 후 정리. |
| `frontend/src/styles/sql.css` | 2,607 | B | `교체 후보` | SQL panel/editor/preview. B02 DataTable, B03 primitive 전환 후 정리. |
| `frontend/src/styles/dashboard.css` | 1,423 | B | `교체 후보` | Dashboard list가 DataTable과 Button/Input primitive로 일부 전환됨. builder preview 관련 selector는 계속 유지. |
| `frontend/src/styles/dashboard-runtime.css` | 2,175 | B | `보류` | Runtime topbar, widget frame, table widget, config panel, dataset tree가 B04에서 일부 전환됨. grid/runtime 상태 selector는 삭제 금지. |
| `frontend/src/styles/xflow-adapter.css` | 119 | A | `보류` | XFlow adapter 전용. ETL graph QA 후 판단. |
| `frontend/src/styles/xflow-source.css` | 1 | A | `삭제 후보` | 현재 1줄 placeholder 성격. import 필요 여부 확인 후 별도 삭제 가능. |

## A 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| App Shell / Topbar / Sidebar | `layout.css`, `base.css`, `responsive.css` | `교체 후보` | Router Shell과 layout component 기준으로 active/navigation 스타일을 정리한다. |
| Page title | `layout.css`, `ingest.css`, `catalog.css`, `dashboard.css`, `styles.css` | `교체 후보` | `PageHeader` primitive 적용 화면이 늘어난 뒤 중복 title selector를 줄인다. |
| Legacy button class | `layout.css`, `ingest.css`, `etl.css`, `catalog.css`, `sql.css`, `dashboard.css` | `교체 후보` | `.primary-button`, `.secondary-button`, `.ghost-button`, `.icon-button` 사용처를 `Button`/`IconButton`으로 옮긴 뒤 제거한다. |
| Jobs 목록 shell | `ingest.css`, `responsive.css` | `교체 후보` | A02에서 Card/PageHeader/DataTable이 적용된 범위부터 selector를 축소한다. |
| Jobs table legacy footer/empty | `ingest.css`, `responsive.css` | `삭제 후보` | DataTable empty/pagination으로 완전히 대체되고 `/jobs` QA가 끝나면 삭제한다. |
| Jobs status/owner/tag chip | `ingest.css` | `교체 후보` | `Badge` primitive로 톤이 안정되면 `.status-pill`, `.run-status-pill`, `.owner-chip`, `.tag-chip`을 줄인다. |
| Run History table | `ingest.css`, `ingest-dag.css` | `교체 후보` | DataTable 적용 후 `.runs-table*`, `.runs-pagination*`을 정리한다. DAG modal은 별도 QA 전 유지한다. |
| ETL Source/Schema flow | `etl.css`, `xflow-adapter.css`, `xflow-source.css` | `보류` | A03에서 화면 외곽을 전환한 뒤 selector 그룹을 Source, Schema, Schedule, Permission, Target 단위로 분리 검토한다. |
| Tree UI | `etl.css`, `xflow-adapter.css` | `보류` | MUI TreeView 유지가 아니라 `react-arborist` 기준 교체가 목표다. 단, 실제 교체 전 tree 관련 CSS는 삭제하지 않는다. |

## B 작업으로 정리될 CSS

| 범위 | 관련 파일 | 상태 | 정리 기준 |
| --- | --- | --- | --- |
| UI primitive 적용 | `catalog.css`, `sql.css`, `dashboard.css`, `dashboard-runtime.css` | `교체 후보` | B01의 `Button`, `Card`, `Badge`, `Input`, `Select`, `Dialog`, `EmptyState` 적용 후 화면별 중복 selector를 줄인다. |
| DataTable 적용 | `sql.css`, `dashboard.css`, `catalog.css` | `교체 후보` | B02의 `DataTable`이 들어간 표부터 table wrapper, empty, pagination, loading selector를 공통화한다. |
| SQL preview table | `sql.css` | `삭제 후보` | `SqlPreviewTable`이 공통 `DataTable`로 완전히 전환되고 `/sql` QA가 끝나면 legacy preview table selector를 삭제한다. |
| SQL editor/action buttons | `sql.css` | `교체 후보` | B03에서 editor action button을 `Button` primitive로 옮긴 뒤 `.sql-editor-actions .primary-button` 계열을 축소한다. |
| Catalog result/list cards | `catalog.css` | `교체 후보` | Catalog 목록/상세 card, badge, schema preview를 primitive 기준으로 바꾼 뒤 중복 카드/칩 selector를 줄인다. |
| Catalog lineage/XFlow | `catalog.css` | `보류` | React Flow node/edge class와 연결되어 있어 lineage QA 전 삭제 금지. |
| Dashboard list/table | `dashboard.css` | `삭제 후보` | B04에서 Dashboard 목록 table이 DataTable 기준으로 전환됨. `.dashboard-list-data-table`, toolbar/action layout selector는 `/dashboards` overflow/empty/sort QA 후 별도 cleanup PR에서 축소한다. |
| Dashboard builder preview | `dashboard.css` | `보류` | builder canvas, widget preview, draft widget 상태가 많아 B04 QA 후 판단한다. |
| Dashboard runtime canvas/widget | `dashboard-runtime.css` | `보류` | `react-grid-layout`, `react-resizable`, widget selected/editing/AI state와 묶여 있어 runtime route QA 전 삭제 금지. Table widget은 DataTable 기준으로 전환되어 `.asklake-table-widget*` selector가 새 기준이 됨. |
| Dashboard dataset tree | `dashboard-runtime.css` | `삭제 후보` | B04에서 runtime dataset tree가 `react-arborist` 기준으로 전환됨. 기존 `.MuiTreeItem-*` selector는 visual QA 후 삭제 후보로 둔다. |
| Dashboard widget form/buttons | `dashboard-runtime.css` | `교체 후보` | Config panel의 text/number input, select, action/color/type button은 primitive 또는 shadcn-style wrapper로 옮김. checkbox, textarea, color picker, layout selector는 계속 유지한다. |

## 우선 정리 순서

1. CSS 파일 삭제 없이 이 문서부터 최신화한다.
2. A02, B02, B03, B04, A03 PR이 merge될 때마다 관련 행을 `사용 중`, `교체 후보`, `삭제 후보`, `보류`로 업데이트한다.
3. 작은 삭제 후보부터 별도 cleanup PR로 제거한다.
4. 전역 button/page title selector는 여러 화면이 같이 쓰므로 마지막에 정리한다.
5. `etl.css`와 `dashboard-runtime.css`는 가장 늦게 건드린다.

## 삭제 전 확인 명령

```bash
rg "selector-name" frontend/src
rg "selector-name" frontend/src/styles
cd frontend
npm run build
```

권장 route QA:

| 영역 | route |
| --- | --- |
| Ingest | `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs` |
| ETL | `/etl/source`, `/etl/schema`, `/etl/schedule`, `/etl/permission`, `/etl/target`, `/etl/review` |
| Catalog | `/catalog`, `/catalog/:datasetId` |
| SQL | `/sql` |
| Dashboard | `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit` |

## 업데이트 로그

| 날짜 | 변경 |
| --- | --- |
| 2026-07-09 | Issue #350 B04에서 Dashboard list/table, runtime topbar/widget frame/table widget/config panel/dataset tree 전환 범위를 반영. `dashboard.css`, `dashboard-runtime.css` 줄 수와 cleanup 후보를 갱신하고 MUI TreeItem selector 삭제 후보를 기록. |
| 2026-07-09 | Issue #347에서 초기 인벤토리 생성. A 작업 CSS와 B 작업 CSS를 한 문서에서 함께 추적하도록 정리. |
