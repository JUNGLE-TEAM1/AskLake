# Frontend Refactor Overall Plan

## 목적과 배경

이 문서는 AskLake 프론트엔드 UI 전환 작업을 팀원과 팀원 AI가 같은 맥락으로 이해하고 병렬 구현할 수 있도록 정리한 전체 계획이다.

현재 프론트엔드는 화면별 글로벌 CSS와 직접 작성한 class에 강하게 묶여 있다. `styles.css`가 여러 화면별 CSS를 한 번에 import하고, 각 페이지가 `primary-button`, `schema-table`, `field`, `input` 같은 class를 직접 사용한다. 이 구조에서는 버튼, 카드, 테이블, 입력 폼 같은 작은 UI를 고칠 때도 다른 화면의 spacing, overflow, responsive 동작이 같이 깨질 수 있다.

이번 작업의 목표는 다음 세 가지다.

- Tailwind/shadcn-style UI primitive로 버튼, 카드, 입력, 다이얼로그, 배지, 페이지 헤더의 공통 기준을 만든다.
- TanStack Table 로직과 shadcn Table UI primitive를 조합한 AskLake 공통 `DataTable` 기준을 만든다.
- React Router를 최소 골격으로 도입해 URL과 화면 매핑을 정리한다.

첫 실행은 documentation-only 작업이었다. 실제 구현은 아래 PR 단위 작업 패키지와 GitHub Issue를 기준으로 별도 branch/PR에서 진행한다.

## 결정 사항

- Backend API, 데이터 계약, 도메인 로직은 변경하지 않는다.
- React Router는 Declarative Mode 최소 도입만 한다.
- React Router loader/action/Data Router는 이번 범위가 아니다.
- React Router는 URL과 화면 매핑만 담당하고, 데이터 로딩은 기존 `useAskLakeData`와 service layer를 유지한다.
- MUI TreeView는 유지하지 않고, 트리 UI는 `react-arborist` 기준으로 교체한다.
- `react-arborist`는 공통 트리 UI 기준으로 도입한다.
- Table은 TanStack Table 로직 + shadcn Table UI 조합으로 통일한다.
- shadcn Table은 표의 시각 primitive로만 사용한다.
- 기존 CSS 파일은 통째로 삭제하지 않는다.
- UI 컴포넌트로 대체된 selector만 사용처를 확인한 뒤 제거한다.
- 모든 PR은 `cd frontend && npm run build` 통과를 merge gate로 둔다.

## Issue와 PR의 차이

- GitHub Issue는 작은 작업, QA 항목, 버그, 체크리스트 단위다.
- PR은 merge 가능한 구현 단위다.
- 여러 GitHub Issue가 하나의 PR에 묶일 수 있다.
- 이 문서의 `PR-A00`, `PR-A01`, `PR-B01` 같은 번호는 GitHub Issue 번호가 아니라 PR 단위 작업 패키지를 의미한다.

예시:

- Issue: Button primitive 구현
- Issue: Badge tone 정리
- Issue: SQL preview table overflow 수정
- PR: `PR-B01 UI Primitives`

## 병렬 작업 원칙

이번 계획은 A/B가 서로를 오래 기다리지 않는 것을 우선한다.

- A는 Router bootstrap을 먼저 짧게 진행한다.
- B는 Router 세부 구현을 기다리지 않고 UI primitive와 DataTable 작업을 병렬로 진행한다.
- 공통 의존성 추가와 lockfile 변경은 A의 Router bootstrap PR에 태워 package 파일 충돌을 줄인다.
- B가 bootstrap merge 전에 작업을 시작해야 한다면 `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `styles.css`, `App.tsx`는 커밋하지 않는다.
- A/B가 동시에 고쳐도 되는 영역과 안 되는 영역을 명확히 나눈다.

동시 작업 가능 영역:

- A: `App.tsx`, `main.tsx`, `components/layout`, `pages/ingest`, `pages/etl`
- B: `components/ui`, `pages/catalog`, `pages/sql`, `pages/dashboard`

동시 작업 금지 영역:

- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/vite.config.ts`
- `frontend/tsconfig.json`
- `frontend/src/styles.css`
- `frontend/src/App.tsx`

## PR 단위 작업 패키지

### PR-A00 Router Bootstrap + Shared Dependencies

담당: 사람 A

내용:

- `react-router` 추가
- `class-variance-authority`, `clsx`, `tailwind-merge` 추가
- `react-arborist` 추가
- `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-select` 추가
- `src/lib/utils.ts`에 `cn()` 추가
- `@/* -> src/*` alias 추가
- Tailwind 연결 확인
- 기존 CSS import 유지
- `BrowserRouter` 연결
- `/`를 `/jobs`로 보내는 최소 라우팅 골격

완료 기준:

- 앱 동작 변화가 최소여야 한다.
- UI 전환은 하지 않는다.
- 데이터 로딩 방식은 변경하지 않는다.
- `cd frontend && npm run build`가 통과한다.

주의:

- 이 PR은 A/B 병렬 작업을 풀어주는 짧은 bootstrap PR이다.
- 이 PR이 merge되면 B는 package/alias 의존성 걱정 없이 UI primitive와 DataTable PR을 진행할 수 있다.
- B가 이 PR merge 전에 작업을 시작해도 되지만, package/lock/config 파일은 커밋하지 않는다.

### PR-A01 Router Shell

담당: 사람 A

내용:

- `BrowserRouter` 연결
- 주요 route path 정의
- `/`를 `/jobs`로 redirect
- Sidebar active state를 URL 기준으로 변경
- 기존 `useAskLakeData`, API service, selected job/dataset 상태는 유지
- Dashboard의 직접 `window.history.pushState` 처리는 React Router navigation으로 교체 또는 축소

주요 route:

- `/jobs`
- `/jobs/:jobId`
- `/jobs/:jobId/runs`
- `/etl/source`
- `/etl/schema`
- `/etl/schedule`
- `/etl/permission`
- `/etl/target`
- `/etl/review`
- `/catalog`
- `/catalog/:datasetId`
- `/sql`
- `/dashboards`
- `/dashboards/:dashboardId`
- `/dashboards/:dashboardId/edit`

완료 기준:

- URL로 주요 화면에 진입할 수 있다.
- 뒤로가기/앞으로가기가 기본적으로 동작한다.
- Backend API 호출 방식은 변경되지 않는다.
- `cd frontend && npm run build`가 통과한다.

### PR-B01 UI Primitives

담당: 사람 B

내용:

- `components/ui` 아래 공통 primitive 추가
- Button, IconButton, Card, Badge, Input, Select, Dialog, PageHeader, EmptyState 구현
- 기존 화면 적용은 샘플 수준으로만 제한
- 레거시 CSS 제거는 하지 않는다.

의존성:

- `PR-A00` merge 후 바로 PR을 열 수 있다.
- `PR-A00` merge 전에도 `components/ui` 설계와 구현은 시작할 수 있다.
- 단, `PR-A00` merge 전에는 package/lock/config 파일을 커밋하지 않는다.

완료 기준:

- 새 컴포넌트를 import해 사용할 수 있다.
- variant와 size 기준이 문서화되거나 코드에서 명확하다.
- `cd frontend && npm run build`가 통과한다.

### PR-B02 DataTable

담당: 사람 B

내용:

- `components/ui/table.tsx`에 shadcn-style Table primitive 작성
- `components/ui/data-table.tsx`에 TanStack Table wrapper 작성
- sorting, pagination 옵션, empty state, loading state, row action slot 지원
- SQL preview 또는 Dashboard list 중 하나에 우선 적용

완료 기준:

- TanStack Table 동작이 유지된다.
- 렌더링은 shadcn-style Table primitive를 사용한다.
- `cd frontend && npm run build`가 통과한다.

의존성:

- `PR-B01 UI Primitives`의 `table` primitive 또는 최소 `cn()`/Button/EmptyState 기준이 필요하다.
- Router 작업 완료를 기다릴 필요는 없다.

### PR-A02 App Shell + Ingest

담당: 사람 A

내용:

- Sidebar, Topbar, Footer, PageHeader 정리
- 수집/처리 목록, 상세, Run History UI 전환
- Job action button, status badge, empty state 정리
- 대체된 ingest/layout selector 일부 제거

완료 기준:

- `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/runs` QA 통과
- `cd frontend && npm run build` 통과

### PR-B03 Catalog + SQL

담당: 사람 B

내용:

- Catalog 목록/상세 card, badge, schema table 정리
- SQL dataset panel, editor action, preview table 정리
- SQL materialize dialog 정리
- Query 실행/API 흐름 변경 금지

완료 기준:

- `/catalog`, `/catalog/:datasetId`, `/sql` QA 통과
- `cd frontend && npm run build` 통과

### PR-B04 Dashboard

담당: 사람 B

내용:

- Dashboard list를 DataTable 기준으로 정리
- runtime topbar, widget frame, table widget, config panel 폴리싱
- Dashboard dataset tree는 `react-arborist` 기준으로 교체
- chart 로직 변경 금지

완료 기준:

- `/dashboards`, `/dashboards/:dashboardId`, `/dashboards/:dashboardId/edit` QA 통과
- `cd frontend && npm run build` 통과

### PR-A03 ETL Flow

담당: 사람 A

내용:

- `/etl/source`부터 `/etl/review`까지 생성 flow 겉면 UI 정리
- Button/Card/Input/Select/Badge 적용
- Source tree, JSON tree, S3 path tree의 MUI TreeView 사용은 `react-arborist` 기준으로 교체
- 복잡한 transform 도메인 로직 변경 금지

완료 기준:

- 생성 flow의 각 단계가 route와 UI 양쪽에서 정상 동작한다.
- `cd frontend && npm run build` 통과

### PR-99 Final Cleanup + Polish

담당: A/B 공동

내용:

- 사용처가 사라진 CSS selector 제거
- table overflow, 긴 텍스트, button height, badge color, card spacing 정리
- responsive 깨짐 확인
- 전체 화면 QA

완료 기준:

- 전체 주요 화면의 UI 톤이 통일된다.
- `cd frontend && npm run build` 통과

## 충돌 방지 규칙

- `PR-A00 Router Bootstrap + Shared Dependencies`는 가장 먼저 merge한다.
- B는 `PR-A00` merge 전에도 구현을 시작할 수 있지만, package/lock/config 파일은 커밋하지 않는다.
- `PR-A00` 이후 A/B가 병렬 branch를 딴다.
- 다음 파일은 동시 수정 금지:
  - `frontend/src/App.tsx`
  - `frontend/src/styles.css`
  - `frontend/package.json`
  - `frontend/package-lock.json`
  - `frontend/vite.config.ts`
  - `frontend/tsconfig.json`
- CSS 삭제는 반드시 `rg`로 사용처를 확인한 뒤 진행한다.
- 같은 화면을 동시에 고치지 않는다.
- A는 Router/Shell/Ingest/ETL 쪽, B는 UI primitives/DataTable/Catalog/SQL/Dashboard 쪽을 우선 소유한다.

## 권장 병렬 타임라인

1. A가 `PR-A00 Router Bootstrap + Shared Dependencies`를 바로 생성한다.
2. B는 동시에 `components/ui` 설계와 `DataTable` 초안을 별도 branch에서 시작한다.
3. `PR-A00`이 merge되면 B는 rebase 후 `PR-B01 UI Primitives`를 연다.
4. A는 `PR-A01 Router Shell`로 route 매핑을 확장한다.
5. B는 `PR-B02 DataTable`을 진행한다.
6. 이후 A는 Ingest/ETL, B는 Catalog/SQL/Dashboard를 병렬로 진행한다.

## QA 체크리스트

모든 PR 공통:

```bash
cd frontend
npm run build
```

최종 QA URL:

- `/jobs`
- `/jobs/:jobId`
- `/jobs/:jobId/runs`
- `/etl/source`
- `/etl/schema`
- `/etl/schedule`
- `/etl/permission`
- `/etl/target`
- `/etl/review`
- `/catalog`
- `/catalog/:datasetId`
- `/sql`
- `/dashboards`
- `/dashboards/:dashboardId`
- `/dashboards/:dashboardId/edit`

## Assumptions

- 오늘 작업은 프론트엔드만 다룬다.
- Backend API와 데이터 계약은 변경하지 않는다.
- React Router는 Declarative Mode만 사용한다.
- MUI TreeView는 제거 대상이다.
- `react-arborist`는 도입한다.
- Table은 TanStack Table을 엔진으로 유지한다.
- shadcn Table은 UI primitive로 사용한다.
- GitHub Issue는 PR보다 더 잘게 쪼개도 된다.
- A/B가 서로를 기다리는 시간은 `PR-A00` bootstrap merge 시간으로만 제한한다.
