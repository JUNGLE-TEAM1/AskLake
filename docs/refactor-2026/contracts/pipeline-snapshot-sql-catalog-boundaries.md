# Pipeline·Snapshot·SQL·Catalog Application 경계

이 문서는 15개 순차 리팩터링 PR 중 PR 07(Stage 09~10)의 하위 호환 경계다.

## 책임 분리

| 책임 | 권위 모듈 | 허용되는 의존성 |
|---|---|---|
| Pipeline create/update 필수값·target·permission 규칙 | `app/domain/pipeline_contract.py` | 요청 객체의 값만 읽는 순수 정책 |
| API draft ↔ persisted `ETLJobModel` 매핑 | `app/application/pipeline_mapping.py` | schema/model, 계산 완료된 mapping context |
| Snapshot command 유효성·실행 경로 선택 | `app/application/snapshot_commands.py` | Job 상태의 immutable evidence |
| Catalog payload 읽기/쓰기 | `app/ports/catalog.py` | payload 수준 port |
| Dataset version/location/table identity | `app/domain/dataset_identity.py` | Catalog payload |
| 멱등 Catalog publication | `app/application/catalog_publication.py` | `CatalogWriterPort` |
| 외부 실행과 DB transaction | 기존 service/repository adapter | 위 application/domain 계약 |

`etl_service.py`의 공개 함수는 기존 router와 검증 스크립트를 위한 compatibility facade다. facade는 HTTP 오류 변환, 권한 검사, repository transaction, Airflow/Kafka/Trino adapter 호출을 담당하되 순수 정책과 draft 매핑을 다시 구현하지 않는다.

## Snapshot과 Continuous

- Snapshot은 종료되는 한 번의 Run이며 `run`, `retry`, `pause`, `cancelRun`, schedule control만 받는다.
- Continuous는 기존 `continuous_commands.py`의 별도 상태 머신만 사용한다.
- `SnapshotCommandPlan`은 외부 runner 호출 전에 중복 start, 잘못된 cancel/pause, schedule 상태를 거절한다.
- Airflow/Kafka 응답 유실과 실제 worker 결과 reconcile은 기존 runtime adapter에서 처리하며 공개 response shape를 바꾸지 않는다.

## Catalog publication identity

Catalog write의 identity는 최소 `datasetId + name`이고, materialization 멱등성은 다음 evidence를 사용한다.

- version: `icebergSnapshotId`, 최신 `materializationRuns[].runId`, 또는 `sourceRunId`
- physical location: `storageLocation`
- query engine mapping: `catalog/schema/table/format`

같은 dataset/version/location/table 재시도는 기존 payload를 반환하고 중복 save를 만들지 않는다. version이 필요한 terminal publication에 version evidence가 없으면 fail closed한다.

## 하위 호환

- endpoint, status code, 공개 request/response field를 제거하지 않는다.
- DB schema와 기존 Job/Run/Catalog JSON을 migration하지 않는다.
- `etl_service.apply_update_request`는 기존 스크립트를 위한 facade로 유지한다.
- `recordParsing`, source identity, credential placeholder와 legacy permission 요약을 mapper가 그대로 보존한다.
- DuckDB compatibility와 Trino mode 선택 정책은 변경하지 않는다.
- DuckDB compatibility 실행은 `sql.compatibility_engine.selected` 구조화 warning을 남겨 운영에서 engine 선택을 식별할 수 있게 한다.

## 필수 검증

```bash
cd backend
.venv/bin/python -m unittest tests.test_pipeline_snapshot_catalog_boundaries -v
.venv/bin/python scripts/verify-etl-job-update-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-dataset-identity-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-rule-persistence-contract.py
.venv/bin/python scripts/verify-permission-create-flow-contract.py
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

PostgreSQL concurrency와 live Kafka/S3/Trino fault injection은 opt-in 검증으로 남긴다.
