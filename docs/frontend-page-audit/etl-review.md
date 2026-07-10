# ETL Review

## Route

- `/etl/review`

## Screen Purpose

- ETL 생성 wizard에서 소스, 스키마, 처리 규칙, 스케줄, 권한, 타겟 설정을 최종 검토하고 파이프라인 생성을 요청한다.
- `DraftPipeline`을 create request로 변환해 기본 정보, 출력 스키마, 저장 위치, 권한과 생성 전 검증 상태를 요약한다.
- 필수 조건이 부족하면 생성 버튼을 비활성화하고 각 설정 단계로 돌아가는 수정 동선을 제공한다.

## Current Shared Components

- `CreationFlowLayout`, `CreationTopActions`: wizard shell과 이전/생성 action을 담당하는 AskLake 조합 컴포넌트다.
- `PageHeader`: 화면 제목, 설명, 아이콘을 공통 형식으로 표시한다.
- `Button`: 각 카드의 수정 action에 shadcn 기반 버튼을 사용한다.
- `KeyValueList`: 기본 정보, 저장 위치, 권한 요약을 공통 key/value 형식으로 표시한다.
- `ValidationList`: 생성 전 검사 항목과 ready/warning 상태를 표시한다.
- `InfoBox`: 생성 이후 카탈로그 및 SQL 사용 안내를 표시한다.
- `useReactTable`: 출력 스키마의 column model과 row model을 구성한다.

## Weakly Componentized Areas

- 네 개의 검토 section은 `etl-review-card`, `etl-review-card-header`, `etl-review-icon` 전용 CSS로 직접 조립되어 있다.
- `ReviewSchemaTable`은 TanStack Table을 사용하지만 `<table>`, `<thead>`, `<tbody>`를 직접 렌더링한다. 공통 `DataTable`의 empty state, scroll, column meta를 재사용하지 않는다.
- `ReviewEditButton`은 작은 로컬 컴포넌트로 분리되어 있으나 route 이동 의미와 label이 Review 화면에 고정되어 있다.
- 생성 가능 여부와 상태 문구가 화면 함수 안에 함께 있어 UI 상태 모델과 검증 규칙의 경계가 약하다.
- ready/warning 상태는 `ValidationList`가 처리하지만 전체 검증 결과를 요약하는 `Alert` 또는 status header는 없다.

## shadcn/ReUI Replacement Candidates

- `DataTable`: `ReviewSchemaTable`의 수동 table markup을 공통 table composition으로 교체한다.
- `Panel` + `PanelHeader`: `etl-review-card` section shell을 AskLake 공통 panel로 통일한다.
- `Alert`: 생성 불가 사유와 전체 검증 결과를 한 번에 전달하는 summary에 사용한다.
- `StatusBadge` 또는 `Badge`: key/value 상태와 validation 결과를 텍스트만으로 표시하지 않도록 정리한다.
- `Separator`: 카드 내부의 권한 요약과 validation 목록 경계를 전용 border CSS 대신 표현한다.
- `Tooltip`: 비활성화된 생성 버튼의 사유를 보조 설명으로 제공할 때 사용할 수 있다.

## Design Options For Existing Components

- `CreationFlowLayout`, `CreationTopActions`, `PageHeader`: ETL 전 단계가 공유하므로 AskLake composition으로 유지한다.
- `KeyValueList`, `ValidationList`: Review뿐 아니라 job detail에서도 쓸 수 있는 구조이므로 유지하되 status renderer와 density variant를 추가하는 편이 낫다.
- `InfoBox`: 단순 안내는 유지할 수 있지만 warning/error까지 확장한다면 shadcn `Alert` primitive를 내부에서 사용한다.
- `ReviewSchemaTable`: 별도 컴포넌트는 유지하되 내부 렌더러를 `DataTable`로 바꾸는 선택이 가장 작다.
- `etl-review-card`: 새 범용 Card를 추가하기보다 기존 `Panel` variant 또는 ETL review 전용 composition으로 축소한다.

## Related CSS

- 현재 사용 중: `frontend/src/styles/etl.css`의 `.etl-review-stack`, `.etl-review-card`, `.etl-review-card-header`, `.etl-review-icon`, `.etl-review-edit`.
- 현재 사용 중: `.etl-review-kv`, `.etl-review-validation`, `.review-schema-table`, 공통 `.schema-table`.
- 주의: `.etl-review-card`와 header/icon selector는 Target, Schedule 등 다른 ETL 화면에서도 공유될 수 있어 단독 삭제하면 안 된다.
- cleanup 후보: `ReviewSchemaTable`을 `DataTable`로 전환한 뒤 Review 전용 table cell/empty selector의 실제 사용처를 `rg`로 재확인한다.

## QA Notes

- process 환경에서 `VITE_USE_MOCK_API=true`로 실행했을 때 `/etl/review`가 API 오류와 Vite overlay 없이 렌더링된다.
- Review 데이터는 독립 fixture가 아니라 이전 wizard 단계의 `DraftPipeline` 상태에 의존한다.
- 스키마가 비어 있을 때 table empty row, 검증 미완료 상태, 생성 버튼 disabled 사유를 후속 구현 QA에서 함께 확인해야 한다.
- 좁은 화면에서 key/value grid와 스키마 table의 horizontal overflow가 겹치지 않는지 확인이 필요하다.

## Conflict Risk

- 이번 문서는 UI/API/router를 변경하지 않는다.
- #422와 겹칠 수 있는 table 영역은 구현하지 않고 현재 상태와 전환 후보만 기록한다.
- `etl.css`는 여러 ETL route가 공유하므로 selector rename/delete는 별도 CSS cleanup PR에서 진행한다.

