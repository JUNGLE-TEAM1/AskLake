# Catalog

## Route

- `/catalog`

## Screen Purpose

- mock/catalog API의 데이터셋을 검색하고 tag, 상태, RAG 여부, 정렬 기준으로 좁혀 목록과 preview를 확인한다.
- 데이터셋별 materialization run을 펼쳐 SQL 분석 대상으로 선택하고 schema 또는 lineage dialog를 연다.
- 현재 페이지 크기는 5이며 mock 데이터셋이 있어 검색, pagination, preview, empty state를 확인할 수 있다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`, `DropdownMenu`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`.
- AskLake composition: `PageHeader`, `Panel`, `PanelHeader`, `FilterToolbar`, `FilterToolbarSearch`, `FilterToolbarInput`, `FilterToolbarCheckbox`, `PaginationBar`.
- `DataTable`: preview 및 상세 schema table에 사용한다.
- `DialogShell`: 전체 schema와 lineage overlay shell에 사용한다.
- `DatasetStatusBadge`: dataset status와 RAG 상태를 `Badge` variant로 조합한다.
- `CatalogMaterializationRuns`, `CatalogSchemaTable`, `CatalogLineage`: run 목록, schema, lineage의 도메인 조합 컴포넌트다.
- `ReactFlow`: lineage graph의 layout, edge, control을 담당한다.

## Weakly Componentized Areas

- 검색 결과는 `article[role="button"]`과 `catalog-result-*` CSS로 만든 custom selectable card다. focus/selected/expanded 상태를 직접 관리한다.
- result tag와 preview metric은 raw `<span>`, `<div>`로 구성되어 `Chip`, `TagList`, metric composition을 재사용하지 않는다.
- materialization run 목록은 custom row와 status span, delete button을 직접 조합한다.
- preview schema card, lineage teaser, SQL 이동 hint, empty state가 각각 전용 CSS block으로 구현되어 있다.
- 목록과 preview가 하나의 `CatalogPage.tsx`에 함께 있어 검색, 선택, modal, run pagination 책임이 크다.
- `CatalogLineage`는 ReactFlow를 쓰지만 node 내부 table, type pill, footer는 전용 markup과 CSS에 강하게 결합되어 있다.

## shadcn/ReUI Replacement Candidates

- `Collapsible`: materialization run의 펼침/접힘 상태와 trigger/content 접근성 구조에 사용한다.
- `ToggleGroup` 또는 `Badge` + `Button`: 상단 tag quick filter를 일관된 pressed state로 정리한다.
- `Card`보다 기존 `Panel` variant: result card와 preview section의 surface 규칙을 통일한다.
- `TagList` + `Chip`: result tag와 선택 tag 표시를 공통화한다.
- `DataTable`: materialization run row를 정렬된 table 정보로 바꾸는 경우 사용한다.
- `AlertDialog`: run 삭제가 비가역 작업이라면 현재 inline delete action 앞에 확인 단계를 둔다.
- `Empty`, `Skeleton`, `Alert`: 검색 결과 없음, loading, API error를 각각 공통 feedback 상태로 표현한다.
- `ScrollArea`: preview panel과 modal의 긴 schema/lineage 내용을 viewport 안에서 안정적으로 스크롤한다.

## Design Options For Existing Components

- `FilterToolbar`, `Panel`, `PaginationBar`, `DialogShell`: 이미 shadcn primitive를 조합한 AskLake 공통 컴포넌트이므로 유지한다.
- `DatasetStatusBadge`: `StatusBadge`와 역할이 겹치는지 확인한 뒤 dataset 전용 mapping만 남기고 공통 status primitive로 합칠 수 있다.
- `CatalogMaterializationRuns`: 도메인 동작이 있으므로 유지하되 내부 row, empty, pagination을 공통 컴포넌트로 교체한다.
- `CatalogLineage`: ReactFlow를 유지한다. ReUI tree나 shadcn table로 graph engine을 교체할 대상은 아니다.
- result card는 별도 범용 Card를 새로 만들기보다 `CatalogResultItem` 도메인 컴포넌트로 분리하는 편이 명확하다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/catalog.css`의 `.catalog-page`, `.catalog-content-grid`, `.catalog-main`, `.catalog-search-panel`, `.catalog-results-section`.
- 현재 사용 중: `.catalog-result-list`, `.catalog-result-item`, `.catalog-result-card`, `.catalog-result-summary`, `.catalog-result-tags`, `.catalog-empty-state`, `.catalog-pagination`.
- 현재 사용 중: `.catalog-preview-panel`, `.catalog-preview-card`, `.catalog-overview-metrics`, `.catalog-lineage-teaser`, `.catalog-sql-target-hint`.
- 현재 사용 중: `.catalog-materialization-*`, `.catalog-run-status`, `.catalog-sort-*`, `.catalog-favorite-button`.
- 주의: lineage selector는 catalog detail과 modal에서도 공유하므로 목록 화면만 보고 삭제하면 안 된다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 실행했을 때 `/catalog`가 mock 데이터와 함께 렌더링되고 API 오류가 없다.
- mock dataset 수가 page size보다 많아 result pagination, tag filter, preview 선택 상태를 확인할 수 있다.
- keyboard QA는 result card Enter/Space, dropdown menu, lineage teaser, run 선택을 포함해야 한다.
- loading/error는 현재 목록 영역의 표현이 약하므로 후속 구현에서 layout shift와 focus 복귀를 확인한다.

## Rendered Audit Findings

### Desktop Findings

- [PASS] mock dataset 13건이 5개 단위로 pagination되고, 검색 결과와 우측 preview가 같은 선택 상태를 사용한다. desktop 1280px에서 page overflow와 console error는 없었다.
- [PASS] 존재하지 않는 검색어를 입력했을 때 결과 목록과 preview가 각각 `검색 결과가 없습니다`, `선택할 데이터셋이 없습니다`로 함께 전환된다.
- [MEDIUM] preview title `commerce_orders_daily`가 좁은 우측 panel에서 여러 줄로 크게 꺾인다. 긴 dataset name에 대한 `min-width: 0`, wrapping, tooltip 정책을 통일해야 한다.
- [MEDIUM] result card 전체 accessible name이 status, metrics, tags를 모두 합친 긴 문자열이다. card 진입 name과 보조 metadata를 분리하면 screen reader 탐색이 짧아진다.
- [PASS] 검색, checkbox filter, sort menu, pagination, pin icon button은 accessible name을 제공한다.

### Narrow Viewport Findings

- [HIGH] 360px에서 global app sidebar가 접히지 않아 catalog content가 첫 viewport 아래로 밀린다.
- [PASS] catalog 자체는 360px에서 page-level horizontal overflow를 만들지 않았다. 목록과 preview stack 전략은 유지할 수 있다.
- [MEDIUM] mobile에서 tag quick filter 수가 많아 검색 form이 길어진다. horizontal scroll보다 `Collapsible` 또는 상위 빈도 제한+전체 보기 방식이 적합하다.

### Verification Coverage

- 확인함: desktop mock 13건, 첫 page 5건, materialization success/running/failed 상태, 삭제 `AlertDialog`, append 목록 shadcn `ScrollArea`, no-result search, preview empty synchronization, console warning/error.
- 확인하지 못함: checkbox 전체 조합, sort 각 option, schema/lineage dialog keyboard loop, pin persistence.

### shadcn Review

- Structure: mostly pass - `Panel`, `FilterToolbar`, `DropdownMenu`, `PaginationBar`, `DataTable`, `DialogShell` composition이 잘 적용돼 있다.
- Tokens: pass - surface와 status 색상이 theme 안에서 일관된다.
- Composition: improved - result card는 shadcn `Button`, tag/metric/status/type 표시는 shadcn `Badge`, 빈 결과는 `Empty`, append 결과 삭제 확인은 `AlertDialog`를 사용한다.
- Responsive/a11y: follow-up - global mobile shell과 긴 accessible name/title wrapping을 보완해야 한다.
- Install/search notes: `Panel`, `Badge`, `TagList`, `Chip`, `ScrollArea`는 현재 사용 가능하다. `Collapsible`은 설치돼 있지 않아 도입 이점이 분명할 때만 추가한다.

### Recommended Order

1. global mobile sidebar 문제를 해결한다.
2. result card accessible name과 long-title policy를 정리한다.
3. materialization run과 tag quick filter를 공통 primitive로 축소한다.

## Implementation Update - Issue #466

- PageHeader의 보조 설명과 검색 조건/검색 결과 section의 설명을 제거했다.
- 검색 조건의 `전체 검색`/선택 태그 수 meta와 검색 결과의 결과 수 meta를 제거했다.
- 검색 결과 카드의 dataset 이름 아래에 있던 row 수, 파일 크기, run 수 지표 줄을 모든 카드에서 제거했다.
- preview header의 `${layer} 데이터셋 · ${owner}` 설명과 SQL 이동 하단 안내 문구를 제거했다.
- 검색 tag action, 정렬 action, 결과 선택 card, pin action, lineage action, SQL 이동 action을 shadcn `Button` variant로 정리했다.
- dataset status, RAG, row/size/run metric, dataset tag, schema type, materialization status를 shadcn `Badge`로 통일했다.
- 카탈로그의 badge와 action은 기본 pill 대신 `compact` shape를 사용해 작은 반경의 사각형으로 표시한다.
- 검색 결과 없음과 preview 없음은 shadcn `Empty`, append 결과 삭제 확인은 shadcn `AlertDialog`를 사용한다.
- append 결과 목록, sample table, schema modal의 내부 스크롤을 shadcn `ScrollArea`로 전환했다. ReactFlow lineage viewport는 graph engine 소유이므로 유지한다.
- 공통 `Button`/`Badge`의 기본 variant와 shape는 유지하고, 선택형 `compact` shape만 추가해 다른 화면의 기본 UI는 변경하지 않는다.

- 검색 조건의 빠른 태그 버튼 영역을 제거하고 텍스트 검색만 유지했다. 결과 카드 안의 데이터셋 태그는 식별 정보이므로 유지한다.
- 결과 카드 본문 클릭은 우측 미리보기 선택만 수행하고, append 결과는 별도 화살표 버튼으로만 열고 닫는다.
- 샘플 데이터의 가로 이동 컨트롤을 실제 스크롤 위치와 동기화된 shadcn `Slider`로 교체했다.
- 우측 지표의 긴 날짜/담당자 값은 카드 내부에서 줄바꿈하고, append 삭제는 작은 shadcn 휴지통 아이콘 버튼으로 교체했다.
- 우측 스키마 미리보기 헤더의 컬럼 수 메타를 제거했다.
- shadcn 재점검으로 append 선택 행을 `Panel`과 `Button`으로 분리하고, preview/card surface와 상세 탭·표·리니지 컨트롤을 `Card`, `Panel`, `Tabs`, `Table`, `Button`, `Badge`로 교체했다.
- 리니지 노드·연결선·확대/축소/화면 맞춤은 `@xyflow/react`가 담당하고, 그래프 응답의 `datasets`와 `edges`를 자동 깊이별 좌표로 변환한다.
- 리니지 데이터셋 노드는 shadcn `Card`, `CardHeader`, `CardContent`, `Badge`로 구성하고 노드/컬럼/핸들/edge 장식용 전용 CSS를 제거했다.
- 데이터셋 노드를 선택하면 shadcn `Sheet`, `ScrollArea`, `Separator`로 컬럼과 상위/하위 연결 정보를 표시한다.
- 결과 카드 태그는 제거하고 우측 미리보기의 `SQL 분석에서 열기` 아래 마지막 영역으로 이동해 shadcn `Badge`와 `TagList`로 표시한다.
- 상세 리니지의 고정 그래프 높이를 viewport 대응 높이로 바꾸고 node surface와 footer status를 shadcn `Card`, `Badge`로 교체했다.
- 우측 미리보기는 shadcn `Accordion`을 사용해 기본 정보, 스키마 미리보기, 리니지가 연결된 세로 목록으로 펼쳐지도록 구성했다.
- 여러 항목을 동시에 열 수 있다. `SQL 분석에서 열기`와 태그는 접힘 상태와 관계없이 보이도록 Accordion 아래 고정 action 영역에 유지한다.
- lineage 확대·축소·화면 맞춤은 React Flow `Controls`와 `fitView`를 사용해 그래프 엔진에 위임한다.
- 페이지당 5개인 결과 목록의 고정 높이와 내부 ScrollArea를 제거해 카드 바로 아래에 페이지네이션이 붙도록 했다.
- 데스크톱 우측 미리보기는 `sticky top-6 self-start` 보조 패널로 동작하고, 긴 내용은 shadcn `ScrollArea` 내부에서만 스크롤한다.
- 1180px 이하에서는 데스크톱 패널을 숨기고 shadcn `Sheet side="right"`에서 동일한 미리보기 콘텐츠를 제공한다.
- 전체 스키마 모달 상단의 레이어 데이터셋 문구와 스키마 헤더의 컬럼 수 표시는 제거한다.
- 생성/append 결과 헤더의 결과 수, 행 수, 용량 요약은 제거하고 제목만 표시한다.
- 리니지 edge는 끊겨 보이는 점선을 제거하고 연속 `smoothstep` 실선과 작은 방향 화살표로 표시한다.
- 검색 입력은 기존 shadcn `InputGroup` 구성을 유지하고 상태 필터를 `FieldSet`으로 묶었다.
- 정렬은 `DropdownMenu` 대신 shadcn `Select`, 결과 펼치기는 조건부 DOM 대신 화살표 전용 shadcn `Collapsible`로 교체했다.
- 우측 상세 프레임은 shadcn `Card`로 교체하고 즐겨찾기 아이콘과 긴 데이터셋 이름에 shadcn `Tooltip`을 적용했다.
- 공통 헤더의 raw 아이콘 버튼과 CSS 원형 계정 표시는 shadcn `IconButton`, `Tooltip`, `Avatar`로 교체했다.
- 실제 `dataLoading`과 `dataError`를 카탈로그의 shadcn `Skeleton`, `Alert` 상태에 연결했다.
- 전체 리니지 하단의 상위 데이터셋 수, 레이어, 상태 요약 배지 줄은 제거했다.

## Conflict Risk

- #422의 list/search/table/pagination 영향 범위와 직접 겹치는 화면이므로 list/search/pagination 데이터 흐름은 유지한다.
- catalog list와 detail이 `CatalogPage.tsx` 및 `catalog.css`를 공유하므로 분리 작업 전에 두 route를 함께 회귀 확인한다.
- API, React Router, ReactFlow graph contract는 이번 범위에서 변경하지 않는다. mock fixture는 materialization 상태 UI 확인을 위한 success/running/failed 예시만 추가한다.

