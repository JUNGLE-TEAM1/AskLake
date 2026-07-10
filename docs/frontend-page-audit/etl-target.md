# ETL Target

## Route

- `/etl/target`

## Screen Purpose

- 사용자가 생성 flow의 후반부에서 최종 데이터셋 이름, owner/manager, 설명, 저장 DB, 파일 포맷, S3 저장경로, 태그, 파티션 컬럼을 설정한다.
- `다음`을 누르면 Target 설정을 `window.localStorage["asklake.targetConfigDraft"]`에 저장하고, `DraftPipeline.target`과 create payload 호환 필드에 반영한 뒤 `/etl/review`로 이동한다.
- 현재 화면은 target layer 선택과 RAG 설정을 노출하지 않고, 기존 draft/default 값을 사용한다.

## Current Shared Components

- `CreationFlowLayout`, `CreationTopActions`: wizard shell과 상단 이전/다음 action을 담당한다.
- `PageHeader`: route title과 icon을 공통 header로 표시한다. Target 화면에서는 요청된 compact 구성을 위해 description을 노출하지 않는다.
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
- `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`: 파일 포맷 선택에 사용된다. Radix 기반 keyboard navigation, `Escape` 닫기, outside click, focus restore를 제공한다.

## Weakly Componentized Areas

- Basic/Destination/Partition section은 아직 `etl-review-card`, `target-config-card`, `target-config-form-grid`, `target-config-split` 같은 ETL 전용 CSS shell에 의존한다.
- 파일 포맷 선택의 raw `<button>` + custom absolute menu는 shadcn `Select`로 교체됐다.
- `DatabaseField`와 `S3PathField`는 `PickerDialog`를 쓰지만 내부 list/body density, error row, display row는 `database-*`, `s3-*` 전용 CSS가 많다.
- tag 선택은 `TagList`/`Chip`을 쓰지만 선택 상태와 rounded pill styling은 `target-chip*` 전용 class에 남아 있다.
- partition option은 `CheckableOption`을 쓰지만 grid, active/disabled, type label density는 `target-partition-*` selector가 담당한다.
- validation alert는 raw `<div role="alert">`와 `target-validation-summary` CSS로만 구성되어 있다.
- `target-rule-table`, `target-preview-table`, `target-test-*`, `target-lineage`, `target-debug-panel` 등 현재 Target 화면 markup에서 보이지 않는 legacy/확장 selector가 `etl.css`에 남아 있어 삭제 전 사용처 재확인이 필요하다.

## shadcn/ReUI Replacement Candidates

- `Select`: 파일 포맷 custom menu를 Radix/shadcn primitive로 대체했다. 현재는 단일 값 선택이므로 `DropdownMenuRadioGroup`보다 `Select`가 적합하다.
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
  - `frontend/src/styles/etl.css`: `.target-format-select`
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
  - 파일 포맷은 shadcn `Select`로 전환되어 keyboard focus, outside click close, escape close를 Radix primitive에 위임한다.
  - validation summary는 alert role은 있으나 `Alert` component 기준의 title/description 구조는 아니다.
  - S3/DB picker API 실패 시 fallback/error row가 보이지만, loading skeleton은 아직 없다.

## Rendered Audit Findings

### Desktop Findings

- [HIGH] mock mode에서도 DB picker를 열면 `Internal Server Error`가 먼저 노출되고 fallback DB 4개가 함께 표시된다. 사용자는 fallback을 선택할 수 있지만 mock 성공 상태와 backend 실패 상태가 한 dialog에 섞여 신뢰하기 어렵다.
- [RESOLVED] custom format menu를 shadcn `Select`로 교체해 `Escape`, outside click, keyboard navigation, focus restore를 primitive에 위임했다.
- [MEDIUM] DB picker는 dialog title, close label, search focus, retry action을 갖추고 있어 overlay 기본 접근성은 양호하다. 문제는 dialog shell보다 mock/backend 상태 분리다.
- [PASS] 데이터셋명, 오너, 담당자, 설명 input과 partition radio는 실제 `<label>` association이 확인됐다. desktop 1280px에서는 page-level horizontal overflow가 없었다.

### Narrow Viewport Findings

- [HIGH] 360px에서 app sidebar가 접히지 않고 첫 viewport 대부분을 차지한다. wizard stepper도 별도 horizontal scrollbar를 만들기 때문에 핵심 Target form이 화면 아래로 크게 밀린다.
- [RESOLVED] 820px 이하에서 partition grid를 1열로 전환해 `order_date`, `order_count`, `gross_sales` label이 option card 안에서 잘리지 않도록 했다.
- [LOW] 긴 S3 path는 ellipsis로 제한되어 page 폭을 늘리지는 않는다. tooltip 또는 copy affordance로 전체 값을 확인할 수 있어야 한다.

### Verification Coverage

- 확인함: desktop 1280x900, narrow 360x800, format menu open/Escape, DB picker open, dialog semantics, input label association, console warning/error.
- 이번 구현 후 확인함: `npm run build`, 설명 문구 제거, shadcn `Select` open/`Escape` close, 좁은 viewport의 partition 1열·label clipping·page overflow.
- 확인하지 못함: S3 picker tree interaction, copy 완료 feedback, tag 추가/삭제, partition 변경 후 draft persistence, validation failure 후 복구.

### shadcn Review

- Structure: partial pass - format menu는 shadcn `Select`로 전환했고 validation feedback은 아직 custom UI에 남아 있다.
- Tokens: pass - 주요 surface와 control은 현재 theme 안에서 일관된다.
- Composition: partial pass - 설치된 `Select`를 재사용했다. validation feedback은 후속 `Alert` 전환 후보로 남는다.
- Responsive/a11y: partial pass - format `Escape` close와 partition text clipping은 해결했다. mobile sidebar/stepper는 app shell 공통 범위라 남아 있다.
- Install/search notes: `Select`, `DropdownMenu`, `Tooltip`은 설치돼 있다. `Alert`를 선택하면 추가 설치가 필요하며 기존 `InfoBox`/status composition 확장과 비교한다.

### Recommended Order

1. mock mode의 DB/S3 request를 backend error와 분리하고 fallback 사용 시 error banner를 숨기거나 명확한 fallback 상태로 바꾼다.
2. 완료: format custom menu를 shadcn `Select`로 교체해 Escape, outside click, focus restore를 보장한다.
3. 부분 완료: partition option은 좁은 화면에서 1열로 전환했다. mobile shell/stepper는 공통 layout 작업으로 분리한다.

## Conflict Risk

- 이번 구현은 Target 화면의 표시 구조와 파일 포맷 control만 변경한다. backend/API 계약, mock fixture, Router 구조, draft payload는 변경하지 않는다.
- #422와 겹칠 수 있는 list/search/table/pagination 구현 영역은 건드리지 않는다.
- `etl.css`에서는 Target 전용 custom format selector만 제거하고, 공유 selector rename이나 legacy selector 정리는 진행하지 않는다.
- 후속 구현은 #418, #421, #422에서 이미 추가된 shadcn primitive와 Tree row 표준화 상태를 기준으로 해야 한다.

## Applied Changes

- `타겟 설정` 아래 description과 Basic/Destination/Partition section header의 보조 설명을 제거해 화면 밀도를 낮췄다.
- 파일 포맷 값과 저장 payload는 기존 `parquet | csv | json`을 유지하고, 표시 control만 shadcn `Select`로 바꿨다.
- 820px 이하에서 partition option을 1열로 배치해 좁은 viewport의 label clipping을 보완했다.
