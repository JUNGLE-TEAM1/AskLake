# Frontend Page UI Audit Handoff

## Purpose

이 문서는 AskLake 프론트엔드 UI 리팩토링/폴리싱 작업을 팀원과 나누기 위한 공유 문서입니다.

현재 목표는 바로 UI를 고치는 것이 아니라, 페이지별로 현재 UI 상태를 점검하고 문서화하는 것입니다. 이후 이 문서를 기준으로 shadcn/ReUI 기반 공통 컴포넌트 전환, 화면별 폴리싱, CSS cleanup 작업을 순서대로 진행합니다.

## Current Direction

- 가능한 많은 UI를 shadcn/ReUI 기반 공통 컴포넌트로 정리합니다.
- 기존 AI가 임시로 만든 custom CSS/UI는 점진적으로 제거합니다.
- 이미 공통 컴포넌트화된 부분도 shadcn primitive, shadcn variant, ReUI 패턴으로 더 깔끔하게 바꿀 수 있는지 검토합니다.
- 페이지별로 다음을 문서화합니다.
  - 무엇이 이미 공통 컴포넌트로 되어 있는지
  - 무엇이 아직 custom CSS/raw UI에 의존하는지
  - 어떤 shadcn/ReUI 컴포넌트로 대체할 수 있는지
  - 현재 컴포넌트화된 부분도 다른 shadcn 디자인 선택지를 적용할 수 있는지
- 코드 수정은 최소화하고, 먼저 페이지별 UI 감사 문서를 만듭니다.

## Excluded Pages

아래 페이지는 이번 페이지별 UI 감사 대상에서 제외합니다.

- `/ai`
- `/admin`
- `/jobs-table-demo`

## Target Pages

이번 감사 대상은 총 16개 페이지입니다.

### Person A

Person A는 수집/처리와 ETL 앞부분을 담당합니다.

1. `/jobs`
2. `/jobs/:jobId`
3. `/jobs/:jobId/runs`
4. `/etl/source`
5. `/etl/schema`
6. `/etl/rules`
7. `/etl/schedule`
8. `/etl/permission`

### Person B

Person B는 ETL 후반, 카탈로그, SQL, 대시보드를 담당합니다.

1. `/etl/target`
2. `/etl/review`
3. `/catalog`
4. `/catalog/:datasetId`
5. `/sql`
6. `/dashboards`
7. `/dashboards/:dashboardId`
8. `/dashboards/:dashboardId/edit`

## Suggested Document Structure

페이지별 감사 문서는 아래 폴더에 1 page : 1 document 방식으로 생성합니다.

```text
docs/frontend-page-audit/
  README.md
  jobs.md
  jobs-detail.md
  jobs-runs.md
  etl-source.md
  etl-schema.md
  etl-rules.md
  etl-schedule.md
  etl-permission.md
  etl-target.md
  etl-review.md
  catalog.md
  catalog-detail.md
  sql.md
  dashboards.md
  dashboard-view.md
  dashboard-edit.md
```

## Page Audit Template

각 페이지 문서는 아래 형식을 기준으로 작성합니다.

```md
# Page Name

## Route

- `/...`

## Screen Purpose

- 이 페이지에서 사용자가 하는 일을 적습니다.

## Current Shared Components

- 현재 사용 중인 공통 컴포넌트를 적습니다.
- 예: Button, Input, Dialog, DataTable, FilterToolbar, Panel, PageHeader

## Weakly Componentized Areas

- 아직 공통 컴포넌트화가 약하거나 custom CSS/raw UI에 의존하는 영역을 적습니다.
- 예:
  - raw input/select/textarea
  - custom toolbar
  - custom modal
  - custom tab
  - custom card
  - custom tree
  - custom pagination
  - CSS로만 구성된 레이아웃

## shadcn/ReUI Replacement Candidates

- 대체 또는 정렬 가능한 shadcn/ReUI 후보를 적습니다.
- 예:
  - Field
  - Input Group
  - Select
  - Checkbox
  - Radio Group
  - Switch
  - Tabs
  - Toggle Group
  - Dropdown Menu
  - Dialog
  - Alert Dialog
  - Sheet
  - Tooltip
  - Skeleton
  - Scroll Area
  - Pagination
  - ReUI Tree
  - react-arborist + shadcn style

## Design Options For Existing Components

- 이미 컴포넌트화된 부분도 아래 선택지를 검토합니다.
- 현재 컴포넌트 유지
- shadcn variant 적용
- shadcn primitive로 교체
- AskLake composition으로 유지
- ReUI 컴포넌트 검토

## Related CSS

- 현재 의존 중인 CSS selector를 적습니다.
- 삭제 가능 selector를 적습니다.
- 아직 보류해야 할 selector를 적습니다.
- 건드리면 위험한 selector를 적습니다.

## QA Notes

- 텍스트 밀림
- 버튼 크기
- spacing 문제
- hover/focus 상태
- empty/loading/error 상태
- 모바일/좁은 화면 문제

## Conflict Risk

- 현재 진행 중인 PR/이슈와 겹치는지 적습니다.
- 예: #422와 겹치는 list/search/table/pagination 영역은 코드 수정하지 않고 문서화만 진행합니다.
```

## Mock Data Needed For Audit

현재 일부 목록과 상세 화면은 데이터가 비어 있어 UI 확인이 어렵습니다. 페이지별 UI 감사를 제대로 하려면 QA용 mock/dev fixture 데이터가 필요합니다.

필요한 최소 데이터는 아래와 같습니다.

- 수집/처리 Job 3~5개
- Job 상세 정보
- Job 실행 이력
- Catalog dataset 5~10개
- SQL에서 선택 가능한 dataset/schema
- Dashboard list 데이터
- Dashboard view/edit 확인용 dashboard 1~2개

주의할 점은 실제 서비스 코드에 임시 데이터를 무작정 박아넣지 않는 것입니다. 가능하면 dev fixture, mock data, local seed 방식으로 분리합니다.

이번 handoff PR에서는 프론트엔드 mock mode 기준으로 아래를 먼저 보강합니다.

- `VITE_USE_MOCK_API` 미설정 시 frontend mock mode로 동작하도록 기존 문서/README 설명과 코드 기본값을 맞춥니다.
- `frontend/src/data/mockData.ts`의 Job fixture에 상세 정보, 실행 이력, DAG 단계, 통계 필드를 추가합니다.
- 따라서 `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs`를 backend 없이도 페이지별 UI 감사용으로 확인할 수 있습니다.
- live backend 검증이 필요하면 `VITE_USE_MOCK_API=false`를 명시해서 실행합니다.

## Conflict Rules

- #422와 겹치는 list/search/table/pagination 영역은 코드 수정하지 않고 문서화만 진행합니다.
- `/jobs`, `/catalog`, `/sql`, `/dashboards` 목록 화면은 #422 영향권일 수 있으므로 특히 주의합니다.
- 페이지별 감사 문서는 작성해도 괜찮지만, 겹치는 컴포넌트 구현 변경은 #422 merge 이후 진행합니다.
- Backend API, 데이터 계약, 도메인 로직은 변경하지 않습니다.
- React Router 구조는 이번 문서화 작업에서 변경하지 않습니다.

## Recommended Work Order

1. QA용 mock/dev fixture 데이터 준비 범위를 정합니다.
2. `docs/frontend-page-audit/README.md`와 페이지별 문서 템플릿을 만듭니다.
3. Person A와 Person B가 각자 담당 페이지 8개씩 확인합니다.
4. 각 페이지에서 현재 공통 컴포넌트 사용 여부와 custom CSS 의존 영역을 기록합니다.
5. shadcn/ReUI 대체 후보를 페이지별로 기록합니다.
6. #422 merge 이후 list/search/table/pagination 관련 문서를 다시 확인합니다.
7. 문서 내용을 기준으로 후속 구현 이슈를 생성합니다.
8. shadcn/ReUI 대체 작업과 CSS cleanup을 순차적으로 진행합니다.

## Short Summary For Teammate

지금은 화면을 바로 고치는 단계가 아니라, 페이지별로 UI 상태를 지도처럼 그리는 단계입니다.

각자 8개 페이지씩 맡아서 다음을 기록합니다.

- 어떤 부분이 이미 공통 컴포넌트인지
- 어떤 부분이 아직 custom CSS/raw UI인지
- 어떤 부분을 shadcn/ReUI로 바꿀 수 있는지
- 이미 공통 컴포넌트인 부분도 shadcn 디자인 선택지를 적용할 수 있는지
- #422와 겹쳐서 지금 코드 수정하면 안 되는 부분이 있는지

이 문서화가 끝나면, 그 결과를 기준으로 실제 shadcn/ReUI 전환과 UI 폴리싱 이슈를 나눠서 진행합니다.
