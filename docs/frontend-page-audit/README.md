# Frontend Page UI Audit

이 폴더는 AskLake 프론트엔드 UI 폴리싱을 위한 페이지별 감사 기록을 모읍니다.

목표는 바로 코드를 고치는 것이 아니라, 먼저 전체 페이지를 빠르게 훑으면서 반복되는 UI 문제와 공통 컴포넌트 교체 후보를 찾는 것입니다. 이후 공통 문제를 한 번에 교체하고, 마지막에 페이지별 폴리싱과 CSS cleanup을 진행합니다.

## 진행 전략

1. 페이지별 현재 UI 상태를 먼저 문서화합니다.
2. 반복되는 문제를 모아 공통 컴포넌트 교체 후보로 분류합니다.
3. shadcn/ReUI primitive로 바로 대체 가능한 영역을 구분합니다.
4. 화면별 custom CSS가 꼭 필요한지, 공통 컴포넌트로 흡수 가능한지 기록합니다.
5. 공통 교체가 끝난 뒤 페이지별 폴리싱과 selector cleanup을 진행합니다.

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
