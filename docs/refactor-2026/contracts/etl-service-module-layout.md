# ETL Service 모듈 경계

## 목적

최신 `dev`의 `backend/app/services/etl_service.py` 8,389줄을 공개 API와 저장 계약 변경 없이 작은 책임 모듈로 분리한다. 현재 façade는 2,198줄이며 Router와 기존 test/script가 import하는 `app.services.etl_service` 경로를 유지한다.

## 책임 분리

| 모듈 | 책임 | 외부 side effect |
| --- | --- | --- |
| `app.application.etl_schedule` | ETL·SQL Job schedule label, cron, timezone, next-run policy | 없음 |
| `app.application.etl_job_projection` | Job/Run 상태 projection, ID·문자열 정규화, 초기 통계·DAG·Continuous 기본 runtime 생성 | 환경 기본값 조회 외 repository write 없음 |
| `app.application.etl_record_parsing` | whitespace record preview, field-count·type·column 추론 | 없음 |
| `app.application.etl_runtime_support` | Kafka 판별, writer mode, 로그 축약, DAG step 생성 공통 helper | 없음 |
| `app.application.etl_source_window` | 증분 S3 object identity·timestamp·ETag·size 정규화와 client 구성 | S3 client 구성만 수행, repository write 없음 |
| `app.application.etl_run_projection` | Airflow·Spark·Kafka Run 상태, task state, DAG projection | repository write 없음 |
| `app.application.etl_catalog_projection` | materialization, Catalog payload, lineage, schema·quality projection | 파일 크기 조회 외 repository write 없음 |
| `app.application.etl_pipeline_policy` | Rule compile, create/update validation, target·schedule·actor 정책 | 일부 façade transaction이 호출, 직접 외부 runtime 실행 없음 |
| `app.services.etl.api_job_operations` / `api_review_operations` | 권한·Pipeline·Job 목록·상태·상세 query, command·connector·review orchestration | repository와 connector 호출 |
| `app.services.etl.snapshot_operations` / `airflow_operations` | Kafka snapshot, Spark·Airflow 실행과 active Snapshot Run 상태 동기화 조립 | Node bridge, Airflow, S3, Catalog 호출 |
| `app.services.etl.source_runtime` | 증분 source window와 runtime document 조립 | S3와 runtime document 조회·저장 |
| `app.services.etl.continuous_maintenance` / `continuous_session` / `continuous_publication` | Continuous worker·maintenance·session·publication 조립 | worker, repository, Catalog, Dashboard 호출 |
| `app.services.etl.replay_schedule` | replay 경로, SQL run identity, schedule 후처리 | repository 저장 |
| `app.services.etl_service` | 기존 공개 함수 façade, repository transaction, runtime adapter 조립 | 기존 계약 유지 |

추출 모듈은 `app.services.etl_service`를 역으로 import하지 않는다. 순수 application 함수는 동일 객체로 re-export하고, side-effect orchestration 함수는 signature와 공개 이름을 보존하는 runtime binding wrapper로 노출한다. wrapper는 호출 시 façade의 현재 dependency만 주입하므로 기존 테스트의 monkeypatch 지점은 유지하면서 역방향 import cycle은 만들지 않는다.

## 구조 ratchet

- `etl_service.py`: 최대 2,500줄
- `etl_schedule.py`: 최대 320줄
- `etl_job_projection.py`: 최대 480줄
- `etl_record_parsing.py`: 최대 170줄
- `etl_runtime_support.py`: 최대 120줄
- `etl_source_window.py`: 최대 270줄
- `etl_run_projection.py`: 최대 620줄
- `etl_catalog_projection.py`: 최대 800줄
- `etl_pipeline_policy.py`: 최대 460줄
- `app/services/etl/*.py`: 파일별 최대 1,000줄, 함수별 최대 100줄
- 추출한 함수는 `etl_service.py`에 다시 정의하지 않는다.
- 추출한 application 함수와 runtime-bound 함수 167개의 AST digest·export 목록을 모듈별 reviewed contract로 고정한다.
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

application 모듈과 `app.services.etl` runtime fragment의 함수 본문을 façade로 되돌리고 binding·구조 ratchet 테스트를 함께 제거한다. 데이터 migration과 배포 설정 변경은 없으므로 DB rollback은 필요하지 않다.
