# Airflow Spark 실행·Catalog 발행 Application 경계

이 문서는 배포 중인 Snapshot ETL의 유한 실행과 Catalog reconciliation 순서를 고정한다. endpoint, request/response, DB schema, Spark·Airflow·Iceberg·Trino adapter와 frontend UI는 변경하지 않는다.

## 책임 분리

| 책임 | 권위 모듈 | 비고 |
|---|---|---|
| persisted Job/Run/Airflow identity 검증 | `app.application.airflow_execution` | 요청 body의 실행 결과를 신뢰하지 않는다. |
| Spark execution lease claim·idempotence·finalize | `app.application.airflow_execution` | 외부 runner 호출 전후의 transaction 순서를 소유한다. |
| Spark runner, manifest·오류 projection | `app.services.etl_service` hook | 현재 production adapter와 monkeypatch seam을 유지한다. |
| physical Iceberg/Parquet 검증 | `app.services.etl_service` hook | 기존 Trino/S3 검증 함수를 그대로 사용한다. |
| Catalog dataset와 Run evidence transaction | `app.application.airflow_execution` + `etl_repository` | dataset row와 `taskStates.catalogResult`를 함께 저장한다. |
| 공개 FastAPI service 함수 | `app.services.etl_service` | 기존 signature를 유지하는 compatibility façade다. |

## Spark 실행 순서

1. Job row와 persisted Run의 `jobId`, `runId`, `airflowDagRunId`를 확인한다.
2. 같은 Run의 성공 `sparkResult`가 있으면 runner를 재실행하지 않고 기존 결과를 반환한다.
3. 유효한 `sparkExecution` lease가 있으면 rollback 후 `409 SPARK_RUN_ALREADY_EXECUTING`으로 거절한다.
4. 새 attempt ID와 시작 시각을 `sparkExecution`에 기록하고 먼저 commit한다.
5. claim transaction 밖에서 기존 Spark runner를 호출한다.
6. Job/Run을 다시 읽고 같은 attempt가 lease를 소유하는지 확인한 뒤 manifest와 Run projection을 commit한다.
7. runner 예외는 같은 attempt가 아직 소유자일 때만 `sparkExecution=failed`로 기록하며 `sparkResult`를 만들지 않는다.

## Catalog 발행 순서

1. persisted Job/Run/Airflow identity와 target `datasetId`를 다시 확인한다.
2. 같은 `runId + datasetId`의 성공 `catalogResult`와 Dataset이 있으면 멱등하게 반환한다.
3. persisted 성공 `sparkResult`만 입력으로 사용하고 Run identity mismatch를 `409`로 거절한다.
4. Iceberg target은 exact snapshot/table/data-file evidence를, file target은 저장 경로와 physical Parquet evidence를 기존 adapter로 검증한다.
5. Dataset row를 lock하고 materialization payload와 같은 Run의 성공 `catalogResult`를 한 transaction으로 저장한다.
6. 동시 최초 생성의 `IntegrityError`는 rollback 후 한 번만 다시 읽어 재시도한다.
7. physical 검증 또는 transaction 실패는 rollback 후 성공 `sparkResult`를 보존하고 `catalogResult=failed`, `failedStage=Catalog reconciliation`을 기록한다.

## 하위 호환과 제외 범위

- `execute_airflow_spark_run`, `reconcile_airflow_catalog` 및 인접 service helper의 공개 signature를 유지한다.
- router, OpenAPI, error code/status/message, Job/Run/Catalog JSON과 commit/rollback 의미를 바꾸지 않는다.
- `run_spark_job`, physical verifier와 repository 함수는 service façade가 호출 시점에 hook으로 조립해 기존 test·운영 adapter 교체 지점을 보존한다.
- Continuous, Kafka Snapshot, Trino SQL Job, Airflow DAG, frontend hydrate·UI·CSS와 legacy/fallback 활성 상태는 이 경계에서 변경하지 않는다.

## 필수 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_airflow_execution_commands -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_delete tests.test_spark_iceberg_reconciliation -v
PYTHONPATH=. .venv/bin/python scripts/verify-airflow-catalog-reconciliation.py
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

`verify-airflow-catalog-reconciliation.py`는 PostgreSQL과 physical fixture를 사용하는 integration 검증이다. CI의 deterministic application unit은 외부 Airflow/Spark/S3 없이 claim, lease, failure, idempotence와 transaction 순서를 고정한다.
