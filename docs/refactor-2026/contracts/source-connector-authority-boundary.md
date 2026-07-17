# Source Connector Python·Node 권위 경계

이 문서는 배포 중인 Source 연결 테스트와 asset listing의 dependency direction을 고정한다. connector 구현, endpoint, response/error, credential 처리와 frontend UI는 변경하지 않는다.

## 단일 책임

| 책임 | 권위 | 구현 |
|---|---|---|
| endpoint auth·request parsing | Python/FastAPI canonical | `app.api.etl` |
| connector use case와 response schema validation | Python application canonical | `app.application.source_connectors` |
| runtime 호출 계약 | typed port | `app.ports.source_connectors.SourceConnectorGateway` |
| script·marker·timeout transport | Node compatibility adapter | `app.infrastructure.source_connectors.NodeSourceConnectorGateway` |
| S3/File, PostgreSQL, MongoDB, Kafka, Data Lake probe 구현 | Node canonical compatibility | 기존 `src/connectors.mjs`와 façade scripts |

의존성 방향은 `etl_service façade -> application -> port <- infrastructure adapter -> existing Node script`다. Python application은 script 이름, stdout marker 또는 subprocess를 알지 못하고 Node adapter는 Pydantic/API response를 알지 못한다.

## 고정된 operation mapping

| Use case | Script | Success marker | Error marker | Timeout | Payload |
|---|---|---|---|---:|---|
| connector test | `test-source-connector.mjs` | `ASKLAKE_SOURCE_CONNECTOR_RESULT` | `ASKLAKE_SOURCE_CONNECTOR_ERROR` | 120초 | `sourceType`, `sourceConfig` |
| asset listing | `list-source-assets.mjs` | `ASKLAKE_SOURCE_ASSETS_RESULT` | `ASKLAKE_SOURCE_ASSETS_ERROR` | 120초 | `sourceType`, `sourceConfig`, `prefix` |

`SubprocessNodeBridge`의 correlation/idempotency env, credential redaction, timeout/process/marker 오류 변환을 그대로 재사용한다. application은 성공 payload를 각각 `SourceConnectorAnalysis`, `SourceAssetsResponse`로 검증하고 malformed result를 API 경계 밖으로 통과시키지 않는다.

## 하위 호환과 제외 범위

- `etl_service.test_source_connector/list_source_assets`의 signature와 router import 경로를 유지한다.
- 기존 script, marker, payload key/casing, 120초 timeout과 Node connector 구현을 바꾸지 않는다.
- Node dev server, `createPipeline.mjs`, mock/legacy UI 또는 production Node backend를 활성화하지 않는다.
- Python connector 재구현, `connectors.mjs` 기능 분해·삭제와 versioned bridge 전환은 live connector parity·secret masking·오류 status evidence를 갖춘 별도 PR에서만 진행한다.
- DB schema, persisted data, API/OpenAPI와 UI/CSS 변경은 없다.

## 필수 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest tests.test_source_connector_gateway -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_runtime_io_ports tests.test_etl_endpoint_auth tests.test_source_connector_raw_preview_schema tests.test_object_storage_mode -v
node --check src/connectors.mjs
node --check scripts/test-source-connector.mjs
node --check scripts/list-source-assets.mjs
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

실제 S3/PostgreSQL/MongoDB/Kafka 연결은 fixture 또는 live 환경이 있는 connector verifier에서 확인하며 이 구조 PR이 credential이나 외부 service를 새로 요구하지 않는다.
