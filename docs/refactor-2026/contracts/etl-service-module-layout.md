# ETL Service 모듈 경계

## 목적

최신 `dev`의 `backend/app/services/etl_service.py` 8,389줄을 공개 API와 저장 계약 변경 없이 작은 책임 모듈로 분리한다. Router와 기존 test/script가 import하는 `app.services.etl_service`는 compatibility façade로 유지한다.

## 책임 분리

| 모듈 | 책임 | 외부 side effect |
| --- | --- | --- |
| `app.application.etl_schedule` | ETL·SQL Job schedule label, cron, timezone, next-run policy | 없음 |
| `app.application.etl_job_projection` | Job/Run 상태 projection, ID·문자열 정규화, 초기 통계·DAG·Continuous 기본 runtime 생성 | 환경 기본값 조회 외 repository write 없음 |
| `app.application.etl_record_parsing` | whitespace record preview, field-count·type·column 추론 | 없음 |
| `app.services.etl_service` | 기존 공개 함수 façade, repository transaction, runtime adapter 조립 | 기존 계약 유지 |

추출 모듈은 `app.services.etl_service`를 역으로 import하지 않는다. façade는 옮긴 함수 객체를 같은 이름으로 다시 export하므로 API router, verification script와 테스트 import 경로는 바뀌지 않는다.

## 구조 ratchet

- `etl_service.py`: 최대 7,600줄
- `etl_schedule.py`: 최대 320줄
- `etl_job_projection.py`: 최대 480줄
- `etl_record_parsing.py`: 최대 170줄
- 추출한 함수는 `etl_service.py`에 다시 정의하지 않는다.
- 추출 시 `origin/dev`와 동일했던 54개 함수 AST digest를 모듈별 reviewed contract로 고정한다.
- API path, request/response schema, DB schema, persisted Job/Run/Dataset payload를 변경하지 않는다.
- legacy/mock 경로를 활성화하거나 새 fallback을 추가하지 않는다.

## 검증

```powershell
cd backend
$env:PYTHONPATH = "."
.venv\Scripts\python.exe -m unittest tests.test_etl_service_module_boundaries tests.test_scheduling -v
.venv\Scripts\python.exe scripts/verify-record-parsing-contract.py
.venv\Scripts\python.exe -m unittest tests.test_etl_job_write_commands tests.test_etl_job_commands tests.test_etl_job_queries -v
.venv\Scripts\python.exe -m unittest tests.test_continuous_runtime_contract tests.test_kafka_snapshot_iceberg tests.test_materialization_contract -v
.venv\Scripts\python.exe -m unittest tests.test_spark_iceberg_reconciliation tests.test_airflow_execution_commands -v
```

## Rollback

세 application 모듈의 함수 본문을 façade로 되돌리고 import·구조 ratchet 테스트를 함께 제거한다. 데이터 migration과 배포 설정 변경은 없으므로 DB rollback은 필요하지 않다.
