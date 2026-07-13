# Frontend Page UI Audit

이 폴더는 AskLake 프론트엔드 UI 폴리싱을 위한 페이지별 감사 기록을 모읍니다.

목표는 전체 페이지를 먼저 훑으면서 반복되는 UI 문제와 공통 컴포넌트 교체 후보를 찾고, 그 기록을 기준으로 페이지별 리팩토링과 폴리싱을 순차적으로 완료하는 것입니다. 페이지별 PR은 작게 유지하되, 구현 중 반복 패턴이 확인되면 해당 시점에 공통 컴포넌트로 승격하고 관련 페이지 문서를 함께 갱신합니다.

## 진행 전략

1. 담당 페이지 전체의 현재 UI 상태를 먼저 문서화합니다.
2. 뒤 페이지를 감사하면서 앞 페이지와 반복되는 패턴을 발견하면 양쪽 문서에 공통 후보를 반영합니다.
3. 문서 감사가 끝나면 route 순서대로 한 페이지씩 리팩토링, shadcn/ReUI 교체, UI 폴리싱을 진행합니다.
4. 두 페이지 이상에서 역할과 동작이 같은 패턴은 처음 구현하는 페이지 작업에서 공통 컴포넌트로 승격합니다.
5. 모양만 비슷하고 동작이 다른 복합 UI는 shadcn/ReUI primitive를 조합한 페이지 또는 도메인 composition으로 유지합니다.
6. 페이지 작업이 끝날 때 실제 변경 사항, 남은 보류 항목, CSS selector 상태를 해당 문서에 갱신합니다.
7. 브라우저 route QA와 frontend build를 통과한 뒤 PR을 merge하고, 다음 페이지 브랜치는 최신 `refactor`를 기준으로 갱신합니다.

## 페이지별 구현 순서

각 페이지 이슈에서는 아래 순서를 따릅니다.

1. 감사 문서와 현재 코드를 다시 대조합니다.
2. raw UI와 화면 전용 wrapper 중 shadcn/ReUI primitive로 교체할 범위를 확정합니다.
3. 기존 공통 컴포넌트로 흡수할 수 있는 반복 패턴과 CSS를 확인합니다.
4. 기능과 데이터 계약을 바꾸지 않는 범위에서 컴포넌트 교체와 UI 폴리싱을 진행합니다.
5. 기본, 검색, 빈 화면, 로딩, 오류, modal, dropdown 등 페이지의 interaction state를 확인합니다.
6. 대체가 끝난 selector만 삭제하고, 다른 route가 공유하는 selector는 보류합니다.
7. 감사 문서를 구현 결과에 맞게 갱신하고 검증 결과를 남깁니다.

## 공통 컴포넌트 판단 기준

- `Button`, `Input`, `Tabs`, `Dialog`, `DropdownMenu`, `Tooltip`, `ScrollArea` 같은 기본 UI는 shadcn primitive를 우선합니다.
- 모든 계층 탐색은 행 가상화, 키보드 탐색, 선택, 펼침 상태를 `react-arborist` 동작 엔진으로 통일합니다. 화면은 공통 `ExplorerTree` composition을 사용해 Kibo/shadcn 계열의 행, 아이콘, hover, focus, selected 스타일을 공유하고, 페이지는 노드 데이터와 동작 callback만 제공합니다.
- 표는 TanStack Table의 상태/행 모델과 shadcn Table UI 조합을 유지합니다.
- 두 페이지 이상에서 역할, 상태, interaction이 같을 때 공통 AskLake composition으로 승격합니다.
- 공통 컴포넌트 수정이 다른 route에 영향을 주면 해당 route도 같은 PR에서 회귀 QA하되, unrelated 화면 폴리싱까지 확장하지 않습니다.

## 문서 작성 기준

각 페이지 문서는 아래 질문에 답해야 합니다.

- 이 페이지가 사용자에게 제공하는 핵심 작업은 무엇인가요?
- 현재 이미 쓰고 있는 AskLake 공통 컴포넌트는 무엇인가요?
- 아직 화면별 CSS나 raw UI에 강하게 묶인 영역은 무엇인가요?
- shadcn/ReUI로 대체하거나 내부를 재정렬할 수 있는 후보는 무엇인가요?
- URL은 바뀌지 않지만 사용자가 실제로 보는 modal, dropdown, tab, empty/search/loading/error 상태가 있나요?
- 다음 공통 교체 PR에서 같이 처리할 수 있는 반복 문제가 있나요?
- 마지막 페이지별 폴리싱에서 따로 봐야 할 visual QA 항목은 무엇인가요?

## 근거 자료

- `docs/frontend-page-audit-handoff.md`
- `docs/frontend-shadcn-replacement-inventory.md`
- `docs/frontend-component-gap-inventory.md`
- `docs/frontend-css-cleanup-inventory.md`
- `frontend/src/pages`
- `frontend/src/components/ui`
- `frontend/src/styles`

## Person A 범위

| Route | 문서 | Issue |
| --- | --- | --- |
| `/jobs` | `jobs.md` | #440 |
| `/jobs/:jobId` | `jobs-detail.md` | #441 |
| `/jobs/:jobId/runs` | `jobs-runs.md` | #442 |
| `/etl/source` | `etl-source.md` | #443 |
| `/etl/schema` | `etl-schema.md` | #444 |
| `/etl/rules` | `etl-rules.md` | #445 |
| `/etl/schedule` | `etl-schedule.md` | #446 |
| `/etl/permission` | `etl-permission.md` | #447 |

## Person B 범위

Person B 담당 페이지는 이 폴더에 같은 형식으로 추가할 수 있습니다.

- `/etl/target`
- `/etl/review`
- `/catalog`
- `/catalog/:datasetId`
- `/sql`
- `/dashboards`
- `/dashboards/:dashboardId`
- `/dashboards/:dashboardId/edit`

## 문서 상태 값

| 상태 | 의미 |
| --- | --- |
| `초안` | 코드와 화면을 보고 1차 메모를 남긴 상태입니다. |
| `검토 필요` | 실제 브라우저 QA나 팀원 확인이 더 필요합니다. |
| `구현 후보 확정` | 후속 공통 교체/폴리싱 이슈로 바로 옮길 수 있습니다. |
| `완료` | 문서 기준 후속 작업이 생성되었거나 처리되었습니다. |
