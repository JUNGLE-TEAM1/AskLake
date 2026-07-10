# Dashboards

## Route

- `/dashboards`

## Screen Purpose

- dashboard 목록을 검색하고 owner, tag, sort 기준으로 필터링한다.
- dashboard 생성, 상세 진입, 삭제를 제공하며 loading/error/empty/pagination 상태를 표시한다.
- mock card 15개가 있어 list, filter, sort, pagination UI를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`, `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`.
- AskLake composition: `PageHeader`, `Panel`, `PanelHeader`, `FilterToolbar`, `FilterToolbarSearch`, `FilterToolbarMenu`, `PaginationBar`.
- `DashboardTable`: `DataTable`, `TagList`, `Chip`, `StatusBadge`를 조합한다.
- `DashboardDeleteConfirmDialog`: `DialogShell`과 destructive `Button`을 조합한다.
- `DashboardLandingPage`: toolbar, table, pagination, delete dialog를 묶는 route composition이다.
- `useDashboardLandingList`: 검색, filter, sort, page state를 UI에서 분리한다.

## Weakly Componentized Areas

- loading, API error, create error는 모두 `dashboard-list-count` raw div로 표시되어 상태별 semantic과 visual hierarchy가 약하다.
- `DashboardPagination`은 공통 `PaginationBar`의 얇은 wrapper라 별도 컴포넌트 가치가 작다.
- delete error는 `dashboard-delete-error` 전용 paragraph이며 dialog feedback primitive를 사용하지 않는다.
- `dashboard.css`에는 현재 목록뿐 아니라 이전 dashboard builder/chart/card selector가 함께 있어 ownership 경계가 크다.
- row tag는 `Chip`, status는 `StatusBadge`를 쓰지만 둘 다 `dashboard-row-tag` class를 공유해 역할 구분이 CSS에 묻힌다.

## shadcn/ReUI Replacement Candidates

- `Alert`: list/create/delete API error를 route 또는 dialog 문맥에 맞게 표시한다.
- `Skeleton`: loading 중 table row 높이를 유지하고 layout shift를 줄인다.
- `Empty`: 검색 결과 없음과 dashboard 자체가 없음 상태를 구분한다.
- `AlertDialog`: dashboard 삭제 확인을 비가역 action 표준에 맞게 교체한다.
- `Pagination`: 현재 `PaginationBar`가 이미 shadcn composition이므로 새로 설치하기보다 variant를 보완한다.
- `DropdownMenu`: owner/tag/sort control은 이미 적절하게 사용 중이며 custom menu로 되돌릴 이유가 없다.

## Design Options For Existing Components

- `DashboardLandingPage`, `DashboardListToolbar`, `DashboardTable`: 책임이 분리되어 있으므로 유지한다.
- `DashboardPagination`: wrapper를 제거하고 route에서 `PaginationBar`를 직접 쓰거나 공통 label policy를 가진 경우만 유지한다.
- `DashboardDeleteConfirmDialog`: 도메인 component는 유지하고 내부를 `AlertDialog`로 바꿀 수 있다.
- `DashboardTable`: `DataTable`을 유지하며 row action, empty state, status renderer를 공통 variant로 정리한다.
- `DashboardListToolbar`: shadcn `DropdownMenu` composition이 잘 적용되어 있으므로 CSS density만 정리한다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/dashboard.css`의 `.dashboard-page`, `.dashboard-list-page`, `.dashboard-page-header`, `.dashboard-panel-stack`.
- 현재 사용 중: `.dashboard-list-toolbar`, `.dashboard-filter-button`, `.dashboard-sort-button`, `.dashboard-list-menu`, `.dashboard-menu-option`.
- 현재 사용 중: `.dashboard-table-list`, `.dashboard-table-list-body`, `.dashboard-table-scroll`, `.dashboard-list-data-table`, `.dashboard-row-*`, `.dashboard-pagination`.
- 현재 사용 중: `.dashboard-delete-error`와 `DialogShell` 내부 utility class.
- cleanup 후보: `.dashboard-filter-bar`, `.dashboard-metric-*`, `.dashboard-chart-*`, `.dashboard-builder-*` 등 목록 route에서 직접 쓰지 않는 selector는 dashboard runtime/legacy 사용처를 먼저 확인한다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/dashboards`를 열었을 때 mock card 목록이 오류 없이 렌더링된다.
- mock card가 page size보다 많아 pagination과 owner/tag/sort control을 감사할 수 있다.
- 이번 문서 PR에서는 생성, 삭제, filter interaction을 실행하지 않고 route rendering만 최소 확인했다.
- 좁은 화면에서 toolbar menu trigger text, table horizontal scroll, destructive icon button hit area를 확인해야 한다.

## Conflict Risk

- #422의 list/search/table/pagination과 직접 겹치는 화면이므로 이 PR은 문서만 추가한다.
- `dashboard.css`가 list, legacy builder, runtime 일부를 함께 다루므로 selector cleanup은 route ownership 분리 후 진행한다.
- dashboard API, mock card fixture, create/delete behavior는 변경하지 않는다.

