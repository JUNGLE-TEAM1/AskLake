# Frontend TreePanel Refactor

> 현재 상태 (2026-07-11): 이 문서는 Issue #401 당시의 중간 단계 기록입니다. 이후 MUI/Emotion과 `react-arborist` 의존성은 제거됐습니다. SQL과 Dashboard는 Kibo/shadcn-compatible Tree를 사용하고, S3/ETL은 `TreePanel`과 로컬 `TreeView`/`TreeRow` 조합을 사용합니다. 대용량 가상화가 필요하면 실제 데이터 규모를 측정한 뒤 별도 엔진 도입을 결정합니다.

## 목적

Issue #401은 S3, ETL, SQL, Dashboard에 흩어진 tree/list shell을 한 번에 지우는 작업이 아니라, 먼저 공통으로 안전하게 묶을 수 있는 wrapper와 상태 shell을 분리하는 작업이다.

## 적용 범위

| 범위 | 변경 파일 | 처리 내용 |
| --- | --- | --- |
| 공통 컴포넌트 | `frontend/src/components/ui/tree-panel.tsx` | header/body/footer와 loading/error/empty state를 받는 `TreePanel` 추가 |
| S3 picker | `frontend/src/components/s3/S3PathField.tsx` | `.s3-tree-panel` wrapper를 `TreePanel`로 전환 |
| ETL source tree | `frontend/src/pages/etl/SourceAssetTree.tsx` | empty state와 `SimpleTreeView` outer shell을 `TreePanel`로 전환 |
| SQL dataset tree | `frontend/src/pages/sql/SqlDatasetRow.tsx` | `.sql-dataset-tree` outer wrapper를 `TreePanel`로 전환 |
| Dashboard dataset sidebar | `frontend/src/pages/dashboard/runtime/DatasetSidebar.tsx` | loading/error/empty/body 분기를 `TreePanel` state/body slot으로 전환 |

## 유지한 범위

- MUI TreeView와 react-arborist 자체는 통합하지 않는다.
- SQL/Dashboard tree hover card는 이번 PR에서 분리하지 않는다.
- tree row renderer, selected/hover/density CSS는 route QA 전까지 유지한다.
- CSS selector 삭제는 하지 않고 기존 className을 `TreePanel`에 전달한다.

## 문서 갱신

- `docs/frontend-component-gap-inventory.md`: `TreePanel`을 현재 공통 UI 목록에 추가하고 tree/list gap을 `부분 해결`로 갱신.
- `docs/frontend-common-component-expansion-candidates.md`: #401 처리 결과와 남은 tree 후보를 기록.
- `docs/frontend-css-cleanup-inventory.md`: #401 CSS 기록을 추가하고 tree selector 유지 기준을 정리.
- `docs/frontend-refactor-ui-shell-followup.md`: #401 적용 결과와 후속 후보를 갱신.
