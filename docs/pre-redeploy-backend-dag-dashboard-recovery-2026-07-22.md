# 재배포 전 백엔드·DAG 복구 및 대시보드 단독 변경 실행 기준

> 작성일: 2026-07-22 (KST)
> 관련 이슈: #1145
> 작업 브랜치: `fix-#1145`

## 적용 결론

- 백엔드와 전체 프런트엔드의 복구 기준은 `e6f86eb8f02a16772d945c405af80d75eff96db2`로 고정한다.
- `deploy/docker-compose.prod.yml`도 같은 기준으로 복구해 `continuous-worker`의 자동 갱신 설정을 보존한다.
- 실행 이력/DAG UI는 복구 기준을 그대로 사용한다.
- 유일한 수동 UI 예외는 현재 배포본 `e6d6b7f868d2bb2b1f376aa6a5174608fefe6249`에서 확인한 가로 막대 축 `NaN` 수정이다.
- `1de451350b830593bd7fc1abce0a7ffcba2d9d4d` 또는 `e6d6b7f868d2bb2b1f376aa6a5174608fefe6249` 전체를 병합하지 않는다.

## 복구 증적

| 항목 | 기준 |
| --- | --- |
| 전체 복구 기준 | `e6f86eb8f02a16772d945c405af80d75eff96db2` |
| 자동 조인 최종 커밋 | `03d71fc32b3ec2cf83c9f09a83a3bbb59fd322a9` |
| 기준 backend tree | `375f427a0c6ff7034edd07cdfdebc6415d9725f3` |
| 기준 실행 이력 UI tree | `e28a35c6b1d4475c269565d8626965de1eb42378` |
| 가로 막대 기능 커밋 | `5c8aee3af88aef3f2fb04963a345802ac5da26cd` |
| 가로 막대 구조 게이트 | `13447359c9ce0be8c9663db941650e4652da454d` |

이 복구 PR은 최신 `dev`에서 기준 상태로 되돌리는 작업이므로 `backend/**`, `frontend/**`, `deploy/docker-compose.prod.yml`에 복구 diff가 생긴다. 이후의 대시보드 단독 변경에서는 아래 허용 목록 외의 런타임 파일을 변경하면 안 된다.

## 가로 막대 수동 이식 허용 목록

- `frontend/src/pages/dashboard/runtime/WidgetConfigPanel.tsx`
- `frontend/src/pages/dashboard/runtime/WidgetRenderer.tsx`
- `frontend/src/pages/dashboard/runtime/barChartAxes.ts`
- `frontend/src/pages/dashboard/runtime/widgetConfigValidation.ts`
- `frontend/src/pages/dashboard/runtime/widgetDefinitions.ts`
- `frontend/scripts/dashboard-bar-orientation.test.mts`
- 위 테스트를 등록하는 `frontend/package.json`과 `frontend/scripts/verify-ui-regressions.mjs`

가로 막대의 저장 필드 역할은 바꾸지 않는다. `xKey`는 분류, `yKey`는 값으로 유지하고, 방향에 따라 물리 축 formatter만 바꾼다.

- 가로 막대: X축 숫자 formatter, Y축 분류 문자열 formatter
- 세로 막대: X축 분류 문자열 formatter, Y축 숫자 formatter
- 숫자가 아닌 값이 숫자 formatter에 들어와도 `NaN`을 반환하지 않음

## S3 + Kafka 자동 반복 조인 보존 계약

1. 정적 S3 상품 Dataset과 실시간 Kafka 클릭 Dataset을 입력으로 사용한다.
2. Kafka Dataset revision이 증가하면 `continuous-worker`가 새 revision을 감지한다.
3. 활성 Trino run이 없을 때 새 조인 run을 한 번 제출한다.
4. 성공한 Gold Dataset revision만 발행하고 `publishedSourceRevision`을 올린다.
5. 실패 시 마지막 정상 Gold 결과를 유지하고 같은 revision을 재시도한다.
6. worker 재시작 뒤에도 저장된 revision 상태에서 이어서 실행한다.
7. 동일 revision을 중복 실행하거나 중복 발행하지 않는다.

핵심 구현과 배포 설정은 복구 기준의 다음 경로를 사용한다.

- `backend/app/continuous_worker.py`
- `backend/app/services/continuous_sql_publication.py`
- `backend/app/services/continuous_sql_revision_runner.py`
- `backend/app/services/continuous_sql_service.py`
- `backend/app/services/trino_sql_auto_refresh.py`
- `backend/app/services/trino_sql_job_service.py`
- `deploy/docker-compose.prod.yml`

## 머지 전 게이트

- 작업 트리의 `backend/`가 복구 기준과 동일해야 한다.
- 실행 이력 UI와 `frontend/src/state/asklake/useJobController.ts`가 복구 기준과 동일해야 한다.
- `deploy/docker-compose.prod.yml`이 복구 기준과 동일해야 한다.
- `airflow/**`에는 이 브랜치에서 만든 변경이 없어야 한다.
- 가로 막대 회귀 테스트와 프런트엔드 빌드가 통과해야 한다.
- 자동 조인 revision 상태·재실행·발행 관련 백엔드 테스트가 통과해야 한다.
