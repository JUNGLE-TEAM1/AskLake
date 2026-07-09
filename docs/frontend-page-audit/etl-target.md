# ETL Target

## Route

- `/etl/target`

## Screen Purpose

- 사용자가 생성 flow의 후반부에서 최종 데이터셋 이름, owner/manager, 설명, 저장 DB, 파일 포맷, S3 저장경로, 태그, 파티션 컬럼을 설정한다.
- `다음`을 누르면 Target 설정을 `window.localStorage["asklake.targetConfigDraft"]`에 저장하고, `DraftPipeline.target`과 create payload 호환 필드에 반영한 뒤 `/etl/review`로 이동한다.
- 현재 화면은 target layer 선택과 RAG 설정을 노출하지 않고, 기존 draft/default 값을 사용한다.

## Current Shared Components

- `CreationFlowLayout`, `CreationTopActions`: wizard shell과 상단 이전/다음 action을 담당한다.
- `PageHeader`: route title, description, icon을 공통 header로 표시한다.
- `FormFieldGroup`: Basic Information과 Destination Settings의 label/control wrapper로 사용된다.
- `Input`: 데이터셋명, 오너, 담당자, 설명, 직접 태그 추가 입력에 사용된다.
- `Button`: 태그 추가, DB/S3 picker 열기, S3 경로 복사, picker footer action에 사용된다.
- `DatabaseField`: Target DB 선택 picker composition이다.
- `S3PathField`: S3 bucket/prefix tree picker composition이다.
- `PickerDialog`: DB/S3 picker의 backdrop/header/body/footer shell로 사용된다.
- `Field`, `FieldLabel`, `InputGroup`, `InputGroupInput`, `InputGroupAddon`, `NativeSelect`: DB/S3 picker toolbar와 검색 입력에 사용된다.
- `TreePanel`, `TreeView`, `TreeGroup`, `TreeRow`: S3 prefix tree row shell에 사용된다.
- `TagList`, `Chip`: tag row와 interactive tag chip에 사용된다.
- `CheckableOption`: 파티션 radio option card shell에 사용된다.

## Weakly Componentized Areas

- Basic/Destination/Partition section은 아직 `etl-review-card`, `target-config-card`, `target-config-form-grid`, `target-config-split` 같은 ETL 전용 CSS shell에 의존한다.
- 파일 포맷 선택은 raw `<button>` + custom absolute menu(`target-format-trigger`, `target-format-menu`, `target-format-option`)로 구현되어 있어 shadcn `Select` 또는 `DropdownMenu`와 아직 다르다.
- `DatabaseField`와 `S3PathField`는 `PickerDialog`를 쓰지만 내부 list/body density, error row, display row는 `database-*`, `s3-*` 전용 CSS가 많다.
- tag 선택은 `TagList`/`Chip`을 쓰지만 선택 상태와 rounded pill styling은 `target-chip*` 전용 class에 남아 있다.
- partition option은 `CheckableOption`을 쓰지만 grid, active/disabled, type label density는 `target-partition-*` selector가 담당한다.
- validation alert는 raw `<div role="alert">`와 `target-validation-summary` CSS로만 구성되어 있다.
- `target-rule-table`, `target-preview-table`, `target-test-*`, `target-lineage`, `target-debug-panel` 등 현재 Target 화면 markup에서 보이지 않는 legacy/확장 selector가 `etl.css`에 남아 있어 삭제 전 사용처 재확인이 필요하다.

## shadcn/ReUI Replacement Candidates

- `Select` 또는 `DropdownMenu`: 파일 포맷 custom menu를 Radix/shadcn primitive로 대체한다. 단순 값 선택이면 `Select`, 메뉴형 radio 상태를 유지하려면 `DropdownMenuRadioGroup`이 맞다.
- `Field` + `Label`: `FormFieldGroup` compatibility wrapper를 점진적으로 흡수한다.
- `InputGroup`: tag 직접 추가 입력과 add action을 하나의 compact 입력 그룹으로 정리할 수 있다.
- `RadioGroup`: partition column 선택을 native radio card에서 shadcn radio group 기반으로 정렬할 수 있다.
- `Badge` 또는 `ToggleGroup`: interactive tag chip을 `Chip` 유지, `Badge` variant, `ToggleGroup` 중 하나로 재분류한다.
- `Alert`: `target-validation-summary`를 semantic alert component로 대체한다.
- `Dialog` + `ScrollArea`: `PickerDialog` 내부 body overflow와 footer preview를 shadcn dialog composition으로 더 정리할 수 있다.
- ReUI File Explorer Tree style: S3 prefix tree는 이미 `TreeView`/`TreeRow` shell을 쓰므로, 시각 density만 ReUI tree 패턴에 맞춰 조정하는 후보로 둔다.

## Design Options For Existing Components

- `CreationFlowLayout`, `CreationTopActions`, `PageHeader`: 현재 AskLake composition 유지가 적절하다.
- `FormFieldGroup`: 신규 사용을 늘리기보다 shadcn `Field` 기준으로 내부를 축소하거나 deprecated 후보로 둔다.
- `DatabaseField`: AskLake composition으로 유지하되 picker body를 `Command`/`ScrollArea` 또는 `Select` 계열로 정리할 수 있다.
- `S3PathField`: S3 bucket/prefix lazy loading 상태가 있어 AskLake composition으로 유지한다. 내부 row shell은 `TreeView`/`TreeRow` 기준을 계속 사용한다.
- `TagList`/`Chip`: read-only tag와 interactive tag를 분리한다. Target 화면은 interactive toggle 성격이므로 `Chip` 유지 또는 `ToggleGroup` 검토가 필요하다.
- `CheckableOption`: partition 선택처럼 form 의미가 있는 option card에는 유지한다. 단, 내부 input은 shadcn `RadioGroup`으로 흡수 가능한지 후속 검토한다.
- `target-config-card`: 단순 Card로 바꾸기보다 `Panel` 또는 ETL 전용 section shell을 먼저 설계하는 편이 안전하다.

## Related CSS

- 현재 사용 중:
  - `frontend/src/styles/etl.css`: `.target-config-stack`, `.target-config-card .field`, `.target-config-form-grid`, `.target-config-split`, `.target-config-subsection`, `.target-config-subheader`
  - `frontend/src/styles/etl.css`: `.target-chip-grid`, `.target-chip`, `.target-inline-controls`
  - `frontend/src/styles/etl.css`: `.target-format-toggle`, `.target-format-trigger`, `.target-format-menu`, `.target-format-option`
  - `frontend/src/styles/etl.css`: `.target-validation-summary`
  - `frontend/src/styles/etl.css`: `.s3-path-field`, `.s3-path-display`, `.s3-path-action`, `.s3-picker-*`, `.s3-tree-*`
  - `frontend/src/styles/etl.css`: `.database-field`, `.database-display`, `.database-picker-*`
  - `frontend/src/styles/etl.css`: `.target-partition-settings`, `.target-partition-grid`, `.target-partition-option`, `.target-partition-name`, `.target-partition-type`
  - `frontend/src/styles/responsive.css`: `.target-config-form-grid`, `.target-config-split`
- 삭제 후보로 보이지만 재확인 필요:
  - `.target-config-schema`, `.target-rule-table`, `.target-preview-table`, `.target-test-row`, `.target-test-status`, `.target-log-list`, `.target-lineage`, `.target-save-message`, `.target-debug-panel`
  - 위 selector는 현재 `TargetPage`의 visible markup에는 직접 등장하지 않지만 ETL 확장/legacy flow와 충돌할 수 있으므로 `rg`와 route QA 후 별도 cleanup PR에서만 삭제한다.
- 보류:
  - `.field`, `.input.control-input`, `.etl-review-card`, `.etl-review-card-header`, `.etl-review-icon`은 Target 외 ETL/Review/Permission에서도 공유되므로 이 문서 범위에서 정리하지 않는다.

## QA Notes

- 최소 확인: mock mode 기본값(`VITE_USE_MOCK_API` 미설정 시 true), Job fixture 4개, Catalog dataset 11개, Dashboard card 15개가 존재한다.
- 최소 route 확인: 감사 대상 16개 route가 Vite dev server `http://127.0.0.1:5175`에서 200으로 응답했다.
- Target 화면 확인 포인트:
  - 좁은 화면에서는 `.target-config-form-grid`와 `.target-config-split`이 `responsive.css`에서 1열로 내려간다.
  - S3 경로가 길면 `.s3-path-text` ellipsis 처리에 의존한다.
  - 파일 포맷 custom menu는 keyboard focus, outside click close, escape close가 shadcn menu 수준으로 정리되어 있지 않다.
  - validation summary는 alert role은 있으나 `Alert` component 기준의 title/description 구조는 아니다.
  - S3/DB picker API 실패 시 fallback/error row가 보이지만, loading skeleton은 아직 없다.

## Conflict Risk

- 이번 작업은 문서 추가만 하며 frontend/backend 코드, API 계약, mock fixture, Router 구조는 변경하지 않는다.
- #422와 겹칠 수 있는 list/search/table/pagination 구현 영역은 건드리지 않는다.
- `etl.css`는 ETL 여러 route가 공유하므로 Target 문서화 단계에서 CSS 삭제나 selector rename을 진행하지 않는다.
- 후속 구현은 #418, #421, #422에서 이미 추가된 shadcn primitive와 Tree row 표준화 상태를 기준으로 해야 한다.
