# ETL Review

## Route

- `/etl/review`

## Screen Purpose

- ETL 생성 wizard에서 소스, 출력 스키마, 저장 위치, 권한 및 검증 결과를 최종 확인한다.
- `DraftPipeline`을 create request로 변환해 주요 설정과 생성 가능 상태를 요약한다.
- 미완료 항목은 하단 validation list와 비활성화된 생성 버튼 상태로 확인한다.

## Current Shared Components

- `CreationFlowLayout`, `CreationTopActions`: wizard shell과 이전/생성 action을 담당한다.
- `PageHeader`: 화면 아이콘과 제목을 공통 형식으로 표시한다.
- `Button`: 각 section의 수정 action에 shadcn 기반 버튼을 사용한다.
- `KeyValueList`: 기본 정보, 저장 위치, 권한을 공통 key/value 형식으로 표시한다.
- `ValidationList`: 생성 전 필수 항목의 ready/warning 상태를 표시한다.
- `useReactTable`: 출력 스키마의 column/row model을 구성한다.

## Current Composition

- 네 개의 review section은 `etl-review-card`, `etl-review-card-header`, `etl-review-icon` 조합으로 구성된다.
- `ReviewSchemaTable`은 TanStack Table model과 semantic table markup을 사용한다.
- `ReviewEditButton`은 화면 내부 공통 컴포넌트이며 section마다 고유한 접근성 이름을 받는다.
- Review 화면은 사용자의 요청에 따라 PageHeader와 section의 보조 설명, 상단 blocking Alert, 하단 InfoBox를 표시하지 않는다.
- 생성 불가 이유는 별도의 요약 Alert 없이 기존 validation list에서 확인한다.

## shadcn Review

- 유지: `Button`은 기존 shadcn primitive를 그대로 사용한다.
- 미적용: `Alert`는 화면의 정보 밀도를 낮추기 위해 추가하지 않는다.
- 보류: `DataTable`, `Panel`, `Badge`, `Separator` 전환은 공통 컴포넌트와 다른 ETL route에 미치는 범위가 커서 이번 작업에서 제외한다.
- 접근성: 동일했던 `수정` 버튼 이름을 `기본 정보 수정`, `출력 스키마 수정`, `저장 위치 수정`, `권한 및 검증 수정`으로 구분한다.

## Applied Improvements

- PageHeader 아래의 반복 안내 문구를 제거했다.
- Basic Information, Destination Settings, Permission & Validation 아래의 보조 설명을 제거했다.
- `생성 전 확인이 필요합니다` 영역과 `추가 확인 항목` 문구를 제거했다.
- 하단 `안내사항` InfoBox를 제거했다.
- 비어 있는 `Job ID`와 `Source`는 공백이나 구분 기호 대신 `미설정`으로 표시한다.
- 출력 스키마 table에 가로 scroll viewport와 focus outline을 추가해 좁은 화면에서도 page 전체가 밀리지 않게 했다.
- 빈 스키마 안내 cell은 말줄임 없이 줄바꿈한다.

## Related CSS

- Review 전용: `.etl-review-stack`, `.etl-review-card`, `.etl-review-card-header`, `.etl-review-icon`, `.etl-review-edit`.
- 데이터 표현: `.etl-review-kv`, `.etl-review-validation`, `.review-schema-table`, 공통 `.schema-table`.
- 이번 추가: `.review-schema-table-viewport`와 해당 focus-visible 스타일.
- `.etl-review-card` 일부 selector는 다른 ETL 화면에서도 공유하므로 rename/delete는 별도 CSS 정리 작업으로 남긴다.

## QA Notes

- mock 서버에서 `/etl/review`가 Vite overlay 없이 렌더링되는지 확인한다.
- 화면에 제거 대상 설명, Alert, InfoBox가 다시 나타나지 않는지 확인한다.
- `Job ID`, `Source`의 빈 값 표시와 네 개 수정 버튼의 접근성 이름을 확인한다.
- 좁은 viewport에서 문서 전체 horizontal overflow 없이 스키마 table 영역만 가로 스크롤되는지 확인한다.

## Deferred Items

- create enabled/submitting, create 실패와 rollback은 실제 wizard 조건을 완성한 통합 테스트에서 검증한다.
- 비활성화된 생성 버튼 근처의 blocking reason summary는 사용자 요청으로 적용하지 않는다.
- #422와 겹칠 수 있는 공통 `DataTable` 전환은 이 작업에서 구현하지 않는다.

## Conflict Risk

- API contract, router, create request 형식은 변경하지 않는다.
- `etl.css` 공유 selector는 삭제하거나 이름을 바꾸지 않는다.
- 변경 범위는 Review 화면의 정보 밀도, 빈 값 표시, 접근성 이름, table overflow에 한정한다.
