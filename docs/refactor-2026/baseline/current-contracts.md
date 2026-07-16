# 현재 계약 기준선

- 측정 HEAD: `b93ae27370fdfa50ce949bcabb9ff7fe37ca1098`
- 정적 artifact: [artifacts/contracts.json](./artifacts/contracts.json)
- FastAPI OpenAPI: [artifacts/openapi.json](./artifacts/openapi.json)

## API

- FastAPI title/version: `AskLake FastAPI Backend` / `0.1.0`
- OpenAPI paths: 83
- OpenAPI component schemas: 221
- 정적 route decorator: 97 operations
- route request/response의 권위는 OpenAPI artifact와 `docs/03-api-reference.md`, `docs/api-contract.md` 순서로 확인한다.

OpenAPI export는 app을 import하지만 network service를 시작하지 않고 `servers`, timestamp, hostname을 기록하지 않는다.

## DB와 schema

- SQLAlchemy table: 23
- backend schema class: 232
- `Literal` status/type 계약: 37
- 별도 `backend/migrations/` 디렉터리는 없다. 현재 schema bootstrap과 additive initialization 코드를 변경할 때 rollback·구버전 DB 호환을 PR별로 명시해야 한다.

Continuous 핵심 table:

- `etl_jobs`
- `etl_runs`
- `kafka_continuous_runtimes`
- `kafka_continuous_sessions`
- `kafka_continuous_batches`
- `kafka_continuous_maintenance_runs`
- `catalog_datasets`
- `dataset_freshness`
- `dataset_revision_commits`
- `dataset_kafka_partition_cursors`
- `dashboard_widget_results`

## ETL Job과 Continuous runtime

현재 Continuous status canonical set:

```text
starting, running, pausing, paused, stopping, stopped, failed
```

보존해야 할 identity와 evidence:

- Job/Run/session ID
- Kafka topic, partition, `[startOffset, endOffset)`
- checkpoint path와 checkpoint contract fingerprint
- batch/run/publication identity
- manifest path, `_SUCCESS`, source boundary
- Iceberg table/snapshot/source boundary
- Catalog materialization run과 dashboard revision commit

DB desired state, worker/container observed state, report heartbeat, durable manifest/Catalog evidence는 서로 다른 사실이다. PR 03에서 이 값을 하나의 status 문자열로 덮지 않는 상태·오류 계약을 characterization test로 고정한다.

## Spark report/checkpoint

핵심 파일 hash와 LOC는 `contracts.json`의 `critical_contract_files`에 고정한다.

- `spark_job_run.py`: finite batch report/manifest
- `kafka_continuous_stream.py`: worker report, checkpoint contract, batch manifest, publication window
- `etl_service.py`: command, report reconciliation, Catalog/Dashboard publication

기존 checkpoint와 manifest를 삭제하거나 자동 reset하는 변경은 허용하지 않는다. schema/rule/runtime fingerprint가 다르면 새 checkpoint를 사용하는 명시적 경로가 필요하다.

## frontend route와 wizard

정적 route literal은 18개이며 주요 workspace route는 `/jobs`, `/catalog`, `/sql`, `/dashboards`, `/ai`, `/admin`이다.

Wizard flow:

```text
source
recordParsing (raw text일 때 조건부)
schema
repeat 또는 manual
permission
target
review
```

서버 상태와 wizard draft를 분리하더라도 route 유지, backward navigation, completed-step 접근, conditional record parsing 계약은 보존한다.

## production Compose

production Compose service는 20개다. P0와 직접 관련된 service는 `spark-dir-init`, `spark-master`, `spark-worker`, `backend`다.

`spark-dir-init` one-shot 실행과 Docker daemon의 `unless-stopped` 자동 restart가 동일한 path·ownership 결과를 보장하지 않는 것이 PR 02의 해결 대상이다.

