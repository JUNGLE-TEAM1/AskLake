# Frontend Detail Preview Section Refactor

## 목적

Issue #405는 ETL final preview와 SchemaTransformEditor sample preview에 남아 있던 작은 table section shell을 `DetailTableSection` 기준으로 정리하는 작업이다.

## 적용 범위

| 범위 | 변경 파일 | 처리 내용 |
| --- | --- | --- |
| DetailTableSection 확장 | `frontend/src/components/ui/detail-table-section.tsx` | `summary`, `titleClassName`, `titleIcon` slot 추가 |
| ETL final preview | `frontend/src/pages/etl/EtlPages.tsx` | summary cards, table scroll, footer shell을 `DetailTableSection`으로 전환 |
| SchemaTransformEditor preview | `frontend/src/components/etl/SchemaTransformEditor.jsx` | source/transformed sample preview shell을 `DetailTableSection`으로 전환 |
| ETL CSS | `frontend/src/styles/etl.css` | final preview title icon/class 스타일 보강 |

## 유지한 범위

- table row/cell density CSS는 삭제하지 않는다.
- SchemaTransformEditor의 column move, SQL transform, test API 로직은 변경하지 않는다.
- DataTable 전환은 이번 PR에서 제외한다.
- schema transform adapter scroll selector는 route QA 전까지 유지한다.

## 문서 갱신

- `docs/frontend-component-gap-inventory.md`: DetailTableSection 적용 범위를 ETL/SchemaTransformEditor까지 갱신.
- `docs/frontend-common-component-expansion-candidates.md`: #405 처리 결과와 후속 row/density cleanup 범위를 기록.
- `docs/frontend-css-cleanup-inventory.md`: #405 CSS 기록을 추가하고 유지 selector를 정리.
- `docs/frontend-refactor-ui-shell-followup.md`: #405 적용 결과와 후속 후보를 갱신.
