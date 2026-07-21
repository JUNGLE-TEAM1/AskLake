# Dashboard 성능·회귀 검증 기록

## 목적

이 문서는 Issue #845 작업 전후의 Dashboard 요청·계산 횟수와 현재 로컬 합성 측정값을 남긴다. 절대 시간은 컴퓨터와 실제 Dataset에 따라 달라지므로 CI 실패 기준으로 사용하지 않는다. CI는 요청 횟수, 물리 조회 횟수, cache hit/miss처럼 환경이 달라도 같은 값만 검사한다.

측정일은 2026-07-18이고, 변경 전 코드 기준은 `ee574ee8`, 변경 후 책임 분리 기준은 `d2d686f4`다.

## 변경 전후 비교

| 항목 | 변경 전 | 변경 후 | 자동 검증 |
| --- | --- | --- | --- |
| page 추가·삭제, Dataset widget 추가, widget 수정 | 저장 요청 1회 뒤 전체 draft runtime 요청 1회 추가 | 저장 요청 1회, 전체 draft runtime 추가 요청 0회 | `frontend/scripts/dashboard-performance-contract.test.mts` |
| 첫 Dashboard 응답 | runtime 응답 1회가 모든 page/widget 계산을 기다림 | shell 응답 1회는 물리 조회 0회, 선택 page 데이터만 후속 요청 | backend `test_runtime_shell_returns_widget_metadata_without_opening_storage` |
| 선택 page의 widget data HTTP 요청 | 첫 runtime 응답 안에 포함 | 선택 page의 서로 다른 Dataset 수만큼 요청하되 동시에 최대 4개만 실행. 테스트 fixture는 widget 3개·Dataset 2개이므로 2회이며 숨은 page는 0회 | `frontend/scripts/dashboard-performance-contract.test.mts`, `dashboard-widget-data-state.test.mts` |
| 같은 batch widget을 연속 2회 조회 | API 요청이 바뀌면 물리 조회 2회 | 첫 요청 1회 계산, 두 번째 요청 물리 조회 0회 | backend `test_batch_widget_result_is_reused_after_permission_is_rechecked` |
| Dashboard 읽기 중 schema DDL | 초기 문제에서는 요청 경로가 schema 준비를 수행 | 0회 | backend `test_dashboard_read_requests_do_not_execute_schema_ddl` |
| Continuous widget | revision 기반 기존 결과 사용 | 기존 `dashboard_widget_results` 계약 유지 | `tests.test_dashboard_live_results` |

Dashboard 열기의 HTTP 요청 수 자체는 `1회`에서 `1 + 선택 page의 서로 다른 Dataset 수`로 늘 수 있다. 대신 첫 shell은 widget 계산을 기다리지 않고, 후속 Dataset 묶음 요청은 최대 4개씩 실행되며 느리거나 실패한 묶음만 해당 widget에 영향을 준다.

## 로컬 합성 측정

아래 명령은 물리 조회에 의도적으로 20ms 지연을 넣고 같은 작업을 10번 실행해 중간값을 출력한다.

```bash
cd backend
npm run measure:dashboard-performance
```

2026-07-18 측정 결과:

```json
{
  "cacheHitMedianMs": 0.256,
  "cacheHitPhysicalReads": 0,
  "runs": 10,
  "shellMedianMs": 0.017,
  "shellPhysicalReads": 0,
  "syntheticPhysicalDelayMs": 20.0,
  "uncachedWidgetMedianMs": 25.144,
  "uncachedWidgetPhysicalReads": 10,
  "warmupPhysicalReads": 1
}
```

이 결과가 뜻하는 것은 다음 두 가지뿐이다.

- shell 10회는 가상 물리 저장소를 한 번도 열지 않았다.
- cache를 한 번 채운 뒤 같은 widget을 10회 읽어도 물리 저장소를 다시 열지 않았다.

## 자동 검증 명령

```bash
cd backend
npm run verify:dashboard-storage
npm run verify:dashboard-performance
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_dashboard_physical_widget_data \
  tests.test_dashboard_live_results -v

cd ../frontend
npm run verify:ui-regressions
npm run build
```

## 아직 운영 환경에서 확인할 것
