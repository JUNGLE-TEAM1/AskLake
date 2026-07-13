# ETL Schedule

## Route

- `/etl/schedule`

## Screen Purpose

- 파이프라인을 자동 예약 없이 저장할지, 정해진 주기로 반복 실행할지 선택한다.
- 반복 실행의 주기·시간대와 공통 재시도 정책을 `DraftPipeline.schedule`에 반영한다.

## #604 Helper Copy Cleanup

2026-07-12 작업은 스케줄 동작과 payload를 변경하지 않고 화면에서 반복되는 설명과 직접 실행 상태 안내를 제거했다.

- Page header의 실행 시간·반복 여부 설명을 제거했다.
- `실행 방식 설정` header의 선택 안내와 `직접 실행` 상태 badge를 제거했다.
- `직접 실행 정책` header의 설명과 `스케줄 없음` badge를 제거했다.
- 직접 실행 정책 하단의 `다음 실행 없음` InfoBox를 제거했다.
- `스케줄링 건너뛰기`/`반복 실행` 선택, validation summary, 재시도 정책, 다음 단계 이동은 유지한다.

## Verification Focus

- 직접 실행 mode에서 제거 대상 문구와 안내 박스가 남지 않는지 확인한다.
- header icon과 제목이 같은 축에 정렬되고 불필요한 빈 공간이 생기지 않는지 확인한다.
- 반복 실행 전환과 재시도 정책 입력, 다음 단계 이동이 기존대로 동작하는지 확인한다.

## #613 Demo Mode Selection

2026-07-13 작업은 데모 중 실행 방식을 빠르게 인지하고 선택할 수 있도록 compact toggle을 큰 선택 카드로 확장했다.

- `직접 실행`과 `반복 실행`을 데스크톱 2열 카드로 표시한다.
- 각 카드는 아이콘과 제목을 같은 수평축에 배치하고 선택 표시와 `aria-pressed` 상태를 제공한다.
- 카드 내부의 작은 보조 설명은 제거해 데모에서 실행 방식 제목에 시선이 집중되도록 한다.
- 작은 화면에서는 카드가 한 열로 쌓이며 기존 schedule draft와 mode 전환 동작은 유지한다.
- 실행 방식 카드 아래의 반복 실행 상세 설정과 공통 재시도 정책은 기존 payload 계약을 그대로 사용한다.

## #604 Verification

- `npm run verify:ui-regressions` 65개 항목을 통과했다.
- `npm run build`를 통과했다.
- mock browser에서 `/etl/schedule` 직접 실행 mode에 제거 대상 설명, 상태 badge, `다음 실행 없음` InfoBox가 표시되지 않는 것을 확인했다.
- `반복 실행`을 선택했을 때 반복 주기, 실행 요일·시간, 시간대, 실행 미리보기, 재시도 정책이 렌더링되는 것을 확인했다.
- browser console warning/error가 없음을 확인했다.
