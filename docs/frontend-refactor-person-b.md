# Frontend Refactor Person B Plan

## B가 이 문서를 읽기 전에 알아야 할 맥락

이번 작업은 기존 AskLake 프론트의 UI를 안정적으로 고치기 위한 전환 작업이다. 기존에는 화면별 CSS와 직접 작성한 class가 많아 UI를 조금만 고쳐도 다른 화면이 깨질 위험이 컸다.

B의 핵심 역할은 **공통 UI primitive, DataTable, Catalog, SQL, Dashboard 화면**을 맡는 것이다.

Backend API, 데이터 계약, 도메인 로직은 변경하지 않는다. React Router의 큰 구조는 A가 담당한다.

중요한 운영 원칙:

- B는 A의 Router 세부 구현을 기다리지 않는다.
- B는 `components/ui`, `DataTable`, Catalog/SQL/Dashboard를 독립적으로 진행한다.
- `PR-A00 Router Bootstrap + Shared Dependencies`가 merge되기 전에도 구현을 시작할 수 있지만, package/lock/config 파일은 커밋하지 않는다.
- 공통 의존성 추가와 alias 설정은 A의 bootstrap PR에 맡긴다.

## B의 담당 범위

B가 책임지는 영역:

- shadcn-style UI primitive
- TanStack Table + shadcn Table UI 기반 `DataTable`
- Catalog 화면
- SQL 화면
- Dashboard 화면
- catalog, sql, dashboard 관련 CSS 정리

B가 우선 소유하는 파일/폴더:

- `frontend/src/components/ui`
- `frontend/src/pages/catalog`
- `frontend/src/pages/sql`
- `frontend/src/pages/dashboard`
- `frontend/src/styles/catalog.css`
- `frontend/src/styles/sql.css`
- `frontend/src/styles/dashboard.css`
- `frontend/src/styles/dashboard-runtime.css`

## B가 피해야 할 영역

B는 아래 영역을 임의로 바꾸지 않는다.

- `App.tsx` routing 구조
- Sidebar/Topbar navigation 구조
- ETL 도메인 로직
- Backend API 변경
- 데이터 계약 변경
- React Router loader/action 도입
- ETL Source/Schema tree 변경

Dashboard dataset tree의 MUI TreeView 사용은 `react-arborist` 기준으로 교체한다. 데이터 구조와 chart/widget runtime 로직은 바꾸지 않고 UI 구현만 교체한다.

## B의 PR 단위 작업

### PR-B01 UI Primitives

목표:

- AskLake에서 공통으로 쓸 shadcn-style UI primitive를 만든다.

시작 조건:

- 이상적으로는 `PR-A00 Router Bootstrap + Shared Dependencies` merge 후 시작한다.
- 급하면 merge 전에도 별도 branch에서 구현을 시작해도 된다.
- 단, merge 전 작업에서는 `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `styles.css`, `App.tsx`를 커밋하지 않는다.

해야 할 일:

- `components/ui/button.tsx`
- `components/ui/icon-button.tsx`
- `components/ui/card.tsx`
- `components/ui/badge.tsx`
- `components/ui/input.tsx`
- `components/ui/select.tsx`
- `components/ui/dialog.tsx`
- `components/ui/page-header.tsx`
- `components/ui/empty-state.tsx`

설계 원칙:

- Tailwind class 중심으로 작성한다.
- `cn()` 유틸을 사용한다.
- variant와 size를 명확히 둔다.
- B2B SaaS 톤을 유지한다.
- 과한 색상, 과한 radius, 장식적 gradient를 피한다.
- 기존 화면 적용은 샘플 1~2개 수준으로 제한한다.
- 레거시 CSS 삭제는 하지 않는다.

QA:

- 각 컴포넌트가 import 가능한지 확인
- TypeScript build 확인

### PR-B02 DataTable

목표:

- Table을 TanStack Table 로직 + shadcn Table UI 조합으로 통일할 수 있는 기반을 만든다.

시작 조건:

- Router 작업 완료를 기다릴 필요는 없다.
- `PR-B01`의 Table primitive 또는 최소 `cn()`/EmptyState 기준만 있으면 진행할 수 있다.

해야 할 일:

- `components/ui/table.tsx` 작성
  - Table
  - TableHeader
  - TableBody
  - TableFooter
  - TableRow
  - TableHead
  - TableCell
  - TableCaption
- `components/ui/data-table.tsx` 작성
  - TanStack Table wrapper
  - sorting 지원
  - pagination 옵션
  - empty state
  - loading state
  - row action slot
  - column alignment/width class 지원
- SQL preview 또는 Dashboard list 중 하나에 먼저 적용

중요 정책:

- TanStack Table은 버리지 않는다.
- shadcn Table은 시각 primitive로만 쓴다.
- `DataTable`은 AskLake 공통 table entrypoint가 된다.

QA:

- 적용한 첫 화면에서 정렬/빈 상태/overflow 확인
- `cd frontend && npm run build`

### PR-B03 Catalog + SQL

목표:

- Catalog와 SQL 화면을 새 UI primitive와 DataTable 기준으로 정리한다.

해야 할 일:

- Catalog 목록 card/surface 정리
- Catalog 상세 header, badge, schema table 정리
- lineage modal 주변 UI 정리
- SQL dataset panel 정리
- SQL editor action button 정리
- SQL preview table을 DataTable 기준으로 정리
- SQL materialize dialog를 새 Dialog/Button/Input 기준으로 정리

하지 말 것:

- Query 실행/API 흐름 변경
- SQL validation logic 변경
- Catalog dataset contract 변경
- Backend endpoint 변경

QA:

- `/catalog`
- `/catalog/:datasetId`
- `/sql`
- dataset 선택
- query 실행
- SQL preview table
- SQL 결과 dataset 생성 dialog

### PR-B04 Dashboard

목표:

- Dashboard 목록과 runtime 화면을 새 UI 기준으로 정리한다.

해야 할 일:

- Dashboard list를 DataTable 기준으로 정리
- Dashboard toolbar/action button 정리
- runtime topbar 정리
- widget frame 정리
- table widget을 DataTable 또는 shadcn-style Table UI 기준으로 정리
- widget config panel input/select/button 정리
- Dashboard dataset tree를 `react-arborist` 기준으로 전환하고 주변 UI 정리

하지 말 것:

- chart rendering logic 변경
- Dashboard API contract 변경
- Dashboard dataset tree 데이터 구조 변경
- dashboard runtime data model 변경

QA:

- `/dashboards`
- `/dashboards/:dashboardId`
- `/dashboards/:dashboardId/edit`
- table widget
- chart widget
- widget config panel
- Dashboard dataset tree

## GitHub Issue 운영

B의 PR 하나는 여러 GitHub Issue를 포함할 수 있다.

예시:

- Issue: Button primitive 구현
- Issue: Dialog primitive 구현
- Issue: DataTable empty state 구현
- Issue: Catalog schema table 전환
- Issue: SQL preview table overflow 수정
- Issue: Dashboard list DataTable 전환

Issue는 작게, PR은 merge 가능한 단위로 묶는다.

## 충돌 방지 규칙

- `PR-A00 Router Bootstrap + Shared Dependencies` merge 후 PR을 여는 것이 가장 안전하다.
- 단, 구현 자체는 bootstrap merge 전에도 시작할 수 있다.
- A와 동시에 `frontend/src/App.tsx`를 수정하지 않는다.
- A와 동시에 `frontend/src/styles.css`를 수정하지 않는다.
- CSS 삭제 전 `rg`로 사용처를 확인한다.
- `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`는 B PR에서 가급적 건드리지 않는다.
- bootstrap merge 전에는 package/lock/config 변경을 커밋하지 않는다.
- `components/ui` public API를 바꿀 때는 A에게 먼저 알린다.

## B의 완료 기준

모든 B PR은 다음을 통과해야 한다.

```bash
cd frontend
npm run build
```

최종적으로 B 담당 화면은 다음을 만족해야 한다.

- UI primitive import와 사용이 안정적임
- DataTable이 TanStack Table 동작을 유지함
- Catalog/SQL/Dashboard 주요 화면의 table, card, button, dialog 톤이 통일됨
- Backend API 호출 방식 변경 없음
- Dashboard dataset tree의 MUI TreeView 사용이 `react-arborist` 기준으로 교체됨
