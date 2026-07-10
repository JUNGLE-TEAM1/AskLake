# Frontend Refactor Person A Plan

> 현재 상태 (2026-07-11): 이 문서는 초기 분업 계획입니다. MUI와 `react-arborist` 관련 목표는 이후 구현에서 Kibo/shadcn-compatible Tree 및 AskLake 로컬 Tree composition으로 대체됐습니다. 현재 구현 판단에는 frontend inventory와 페이지 감사 문서를 우선합니다.

## A가 이 문서를 읽기 전에 알아야 할 맥락

이번 프론트엔드 리팩토링은 기존 화면을 새로 만드는 작업이 아니다. Backend API, 데이터 계약, 도메인 로직은 그대로 두고, 프론트의 화면 전환 구조와 UI 표현 계층을 정리하는 작업이다.

현재 AskLake UI는 글로벌 CSS와 화면별 class에 많이 의존한다. 작은 UI 수정이 다른 화면의 layout, overflow, spacing을 깨뜨릴 수 있기 때문에 Tailwind/shadcn-style primitive와 TanStack DataTable 기준으로 점진 전환한다.

A의 핵심 역할은 **화면 전환 골격과 shell, 수집/처리, ETL 생성 flow**를 맡는 것이다.

중요한 운영 원칙:

- A는 초기에 `PR-A00 Router Bootstrap + Shared Dependencies`를 빠르게 merge해 B가 UI primitive/DataTable을 독립적으로 진행할 수 있게 한다.
- 공통 의존성과 lockfile 변경은 A의 bootstrap PR에서 처리한다.
- 이후 A는 Router/Shell/Ingest/ETL에 집중하고, `components/ui` 설계에는 관여하지 않는다.

## A의 담당 범위

A가 책임지는 영역:

- React Router 최소 골격
- App shell
- Sidebar / Topbar / Footer
- 수집/처리 목록, 상세, Run History
- ETL 생성 flow의 겉면 UI 전환
- layout, ingest, etl 관련 CSS 정리

A가 우선 소유하는 파일/폴더:

- `frontend/src/App.tsx`
- `frontend/src/main.tsx`
- `frontend/src/components/layout`
- `frontend/src/pages/ingest`
- `frontend/src/pages/etl`
- `frontend/src/styles/layout.css`
- `frontend/src/styles/ingest.css`
- `frontend/src/styles/ingest-dag.css`
- `frontend/src/styles/etl.css`
- `frontend/src/styles/responsive.css`

## A가 피해야 할 영역

A는 아래 영역을 임의로 바꾸지 않는다.

- `components/ui`의 컴포넌트 설계 변경
- Catalog/SQL/Dashboard 깊은 화면 변경
- Backend API 변경
- 데이터 계약 변경
- React Router loader/action 도입
- React Router Data Router 도입
- Dashboard dataset tree 변경
- Catalog/SQL/Dashboard의 tree UI 변경
- ETL transform 도메인 로직 변경

A 담당 ETL flow 안의 MUI TreeView 사용은 `react-arborist` 기준으로 교체한다. Source asset tree, JSON sample tree, S3 path tree 같은 폴더/트리 구조는 데이터 구조를 바꾸지 않고 UI 구현만 교체한다.

## A의 PR 단위 작업

### PR-A00 Router Bootstrap + Shared Dependencies

목표:

- A/B 병렬 작업을 시작할 수 있도록 공통 의존성과 최소 Router 기반을 먼저 깐다.
- 이 PR은 짧게 유지한다.

해야 할 일:

- `react-router` 추가
- `class-variance-authority`, `clsx`, `tailwind-merge` 추가
- `react-arborist` 추가
- `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-select` 추가
- `@/* -> src/*` alias 추가
- `src/lib/utils.ts`에 `cn()` 추가
- Tailwind 연결 확인
- `BrowserRouter` 연결
- `/`를 `/jobs`로 보내는 최소 route 추가

하지 말 것:

- UI primitive 구현
- 페이지별 UI 전환
- 기존 CSS 삭제
- API 호출 방식 변경
- route loader/action 도입

QA:

```bash
cd frontend
npm run build
```

완료 기준:

- build가 통과한다.
- 앱 동작 변화가 최소다.
- B가 `components/ui`와 `DataTable` 작업을 이어받을 수 있다.

### PR-A01 Router Shell

목표:

- React Router를 최소 골격으로 도입한다.
- URL과 화면 매핑을 정리한다.
- 기존 데이터 로딩 방식은 유지한다.

해야 할 일:

- `BrowserRouter` 연결
- `/`를 `/jobs`로 redirect
- route path 정의
- Sidebar active state를 URL 기준으로 변경
- `jobId`, `datasetId`, `dashboardId` 같은 route param을 기존 selected state와 연결
- Dashboard의 직접 `window.history.pushState` 처리 축소 또는 React Router navigation으로 교체

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

하지 말 것:

- loader/action 도입
- API 호출을 route loader로 이전
- Backend endpoint 변경
- 도메인 상태 모델 전면 교체

QA:

- `/jobs`
- `/jobs/:jobId`
- `/jobs/:jobId/runs`
- `/etl/source`
- `/etl/schema`
- `/etl/schedule`
- `/etl/permission`
- `/etl/target`
- `/etl/review`
- 브라우저 뒤로가기/앞으로가기

### PR-A02 App Shell + Ingest

목표:

- App shell과 수집/처리 화면을 새 UI 기준으로 정리한다.

해야 할 일:

- Sidebar, Topbar, Footer UI 정리
- PageHeader 적용
- 수집/처리 목록의 card, action button, status badge, empty state 정리
- Job 상세 화면 card/table/button 정리
- Run History table과 action 정리
- 대체 완료된 layout/ingest selector 제거

의존성:

- `PR-B01 UI Primitives`
- `PR-B02 DataTable`

QA:

- `/jobs`
- `/jobs/:jobId`
- `/jobs/:jobId/runs`
- Job 실행/재실행/취소 버튼이 기존 흐름대로 동작하는지 확인
- 빈 목록 상태 확인

### PR-A03 ETL Flow

목표:

- ETL 생성 flow의 겉면 UI를 새 컴포넌트 기준으로 정리한다.
- Source, Schema, Schedule, Permission, Target, Review 단계가 같은 톤으로 보이게 한다.

해야 할 일:

- 단계별 PageHeader/Card/Button/Input/Select/Badge 적용
- source connection panel 정리
- schema inference surface 정리
- schedule form 정리
- permission/target/review surface 정리
- ETL 생성 flow 내 table은 가능한 범위에서 DataTable 또는 shadcn-style Table UI로 교체
- 대체 완료된 etl selector 제거

하지 말 것:

- Source connector API 변경
- Schema inference request/response 변경
- Transform rule 도메인 로직 변경
- Source/Schema tree 데이터 구조 변경

QA:

- `/etl/source`
- `/etl/schema`
- `/etl/schedule`
- `/etl/permission`
- `/etl/target`
- `/etl/review`
- Source tree, JSON tree, S3 path tree가 `react-arborist` 전환 후에도 그대로 동작하는지 확인

## GitHub Issue 운영

A의 PR 하나는 여러 GitHub Issue를 포함할 수 있다.

예시:

- Issue: Router path map 정의
- Issue: Sidebar active state URL 기반 전환
- Issue: Jobs list empty state 정리
- Issue: Run History table overflow 수정
- Issue: ETL Source card 정리

Issue는 작게, PR은 merge 가능한 단위로 묶는다.

## 충돌 방지 규칙

- `PR-A00 Router Bootstrap + Shared Dependencies`를 가장 먼저 merge한다.
- B와 동시에 `frontend/src/App.tsx`를 수정하지 않는다.
- B와 동시에 `frontend/src/styles.css`를 수정하지 않는다.
- CSS 삭제 전 `rg`로 사용처를 확인한다.
- `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`는 `PR-A00` 이후 가급적 건드리지 않는다.
- B가 bootstrap merge 전에 작업을 시작할 수 있으므로, package/lock/config 변경은 A가 책임지고 먼저 정리한다.

## A의 완료 기준

모든 A PR은 다음을 통과해야 한다.

```bash
cd frontend
npm run build
```

최종적으로 A 담당 화면은 다음을 만족해야 한다.

- URL 직접 진입 가능
- 주요 버튼 동작 유지
- Backend API 호출 방식 변경 없음
- A 담당 영역의 MUI TreeView 사용이 `react-arborist` 기준으로 교체됨
- 화면이 새 UI 톤에 맞게 정리됨
