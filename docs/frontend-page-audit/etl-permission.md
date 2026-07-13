# ETL Permission

## Route

- `/etl/permission`

## Screen Purpose

- 생성할 데이터셋의 공유 범위, 접근 정책, 역할 및 사용자 권한을 설정한다.
- 선택 결과는 기존 `DraftPipeline.permissionRoles`와 permission grant 계약을 유지한다.

## #613 Demo Copy Cleanup

- `Governance Check`, `Access Policy`, `Role Grants` 섹션 제목을 각각 `거버넌스 확인`, `접근 정책`, `역할 및 사용자 권한`으로 한글화했다.
- 역할·사용자 섹션 헤더의 `0개 선택` 및 `0명 선택` 인원 배지를 제거했다.
- 역할과 사용자 탭, 검색, 추가·제거 및 체크박스 선택 동작은 변경하지 않았다.

## Verification Focus

- 세 섹션 제목이 한글로 표시되는지 확인한다.
- 역할·사용자 탭을 전환해도 선택 인원 배지가 표시되지 않는지 확인한다.
- 기존 권한 선택과 다음 단계 이동이 정상 동작하는지 확인한다.
