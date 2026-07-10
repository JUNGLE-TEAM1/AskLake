# Catalog Detail

## Route

- `/catalog/:datasetId`

## Screen Purpose

- 선택한 데이터셋의 개요, schema, sample data, lineage를 탭으로 탐색한다.
- SQL 분석 이동, lineage 열기, refresh action을 제공하고 dataset status, owner, layer, tag를 표시한다.
- schema와 sample은 데이터 구조를, ReactFlow lineage는 upstream/downstream 관계를 보여준다.

## Current Shared Components

- shadcn primitive: `Button`, `Badge`.
- AskLake composition: `DataTable`, `DialogShell` 및 catalog route와 공유하는 `DatasetStatusBadge`.
- `CatalogOverview`, `CatalogSchema`, `CatalogSample`, `CatalogLineage`: 각 detail tab의 도메인 컴포넌트다.
- `CatalogSchemaTable`: TanStack 기반 공통 `DataTable`로 schema를 표시한다.
- `ReactFlow`, `Controls`, `Background`: lineage graph engine과 navigation control을 담당한다.

## Weakly Componentized Areas

- detail header는 `catalog-detail-header`와 `job-detail-*` CSS를 섞어 직접 구성하며 `PageHeader` 또는 breadcrumb composition을 사용하지 않는다.
- 탭은 raw `<nav>`와 `<button>`으로 구현되어 shadcn `Tabs`의 keyboard navigation과 state contract를 사용하지 않는다.
- owner/layer/tag는 raw chip span이며 `TagList`, `Chip`, `Badge` 사용 방식이 목록 화면과 다르다.
- overview metric/card와 sample table은 전용 section/table markup이다. sample table은 공통 `DataTable`을 사용하지 않는다.
- lineage node, column row, type pill은 ReactFlow 안에서 custom CSS로 완전히 스타일링되어 있다.
- refresh action은 audit event만 발생시키므로 loading/success/error feedback가 화면에서 충분히 드러나지 않는다.

## shadcn/ReUI Replacement Candidates

- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`: overview/schema/sample/lineage 전환을 표준 keyboard tab pattern으로 교체한다.
- `Breadcrumb`: `검색/카탈로그 > dataset` 경로를 link/button class 재사용 없이 표현한다.
- `PageHeader`: title, metadata, actions를 detail용 variant로 구성한다.
- `TagList`, `Chip`, `StatusBadge`: owner/layer/tag/status 표시를 semantic하게 통일한다.
- `DataTable`: raw sample table을 schema table과 동일한 overflow, empty, sorting shell로 정리한다.
- `ScrollArea`: schema/sample의 긴 content와 lineage panel을 안정적으로 스크롤한다.
- `Skeleton`, `Alert`: dataset refresh/loading/error 상태를 header와 content 영역에 표시한다.

## Design Options For Existing Components

- `CatalogOverview`, `CatalogSchema`, `CatalogSample`: tab content의 도메인 경계로 유지하되 outer section을 `Panel` composition으로 맞춘다.
- `CatalogSchemaTable`: 이미 `DataTable`을 사용하므로 유지하고 preview/full variant만 정리한다.
- `CatalogLineage`: ReactFlow를 유지하며 node renderer를 별도 파일로 분리하고 token/spacing만 정리한다.
- `DatasetStatusBadge`: catalog list/detail 공통이므로 유지하되 `StatusBadge`와 중복되는 visual mapping을 줄인다.
- detail header는 jobs의 CSS를 빌려 쓰지 않도록 공통 `DetailPageHeader`가 실제 중복을 줄이는지 먼저 비교한다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/catalog.css`의 `.catalog-detail-page`, `.catalog-detail-header`, `.catalog-detail-title-row`, `.catalog-detail-grid`.
- 현재 사용 중: `.catalog-overview-card`, `.catalog-table-card`, `.catalog-section-header`, `.catalog-schema-table-wrap`, `.catalog-schema-type-pill`, `.catalog-sample-scroll`.
- 현재 사용 중: `.catalog-lineage-card`, `.catalog-lineage-flow`, `.lineage-schema-*`, `.lineage-column-*`, `.lineage-type-pill`.
- 외부 공유: `job-detail-breadcrumb`, `job-detail-meta`, `job-detail-actions`, `job-detail-tabs`, `owner-chip`, `tag-chip` selector를 사용한다.
- cleanup 전 확인: jobs detail과 catalog detail의 shared selector를 먼저 분리하지 않으면 한쪽 변경이 다른 route를 깨뜨릴 수 있다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 `/catalog/ds_customer_orders_gold`를 열었을 때 detail route가 오류 없이 렌더링된다.
- mock dataset에는 schema와 lineage 정보가 있어 네 탭의 구조를 감사할 수 있다.
- raw tab의 Arrow key 동작, active focus, URL/history 보존 여부는 현재 보장되지 않으므로 후속 `Tabs` 전환 시 확인한다.
- ReactFlow는 desktop뿐 아니라 좁은 viewport에서 node clipping, controls overlap, horizontal scroll을 확인해야 한다.

## Conflict Risk

- catalog list와 같은 `CatalogPage.tsx`, `catalog.css`를 공유한다.
- #422가 공통 table 또는 search style을 변경하면 schema/sample selector를 다시 확인해야 한다.
- ReactFlow node/edge data contract와 API 응답은 이번 문서 범위에서 변경하지 않는다.

