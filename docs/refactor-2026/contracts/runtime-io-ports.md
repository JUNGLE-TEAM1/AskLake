# Runtime 외부 I/O Port·Adapter 계약

## 목적

Continuous 명령과 조정 로직이 subprocess, 로컬 JSON 파일, boto3 응답 구조를 직접 소유하지 않도록 최소 경계를 고정한다. 공개 API, DB schema, Job/checkpoint/report/manifest 형식은 변경하지 않는다.

## 호출 목록과 소유권

| 호출자 | 필요한 기능 | Port | Production adapter | 호환 facade |
|---|---|---|---|---|
| Spark/Kafka Snapshot·Continuous·maintenance | Node ESM 실행, timeout recovery, marker 응답 | `NodeBridgePort` | `SubprocessNodeBridge` | `run_node_bridge` |
| Continuous reconciliation·maintenance | report/result/state JSON 읽기 | `RuntimeDocumentStore` | `JsonFileRuntimeDocumentStore` | `read_runtime_json` |
| Catalog ACK | JSON atomic write | `RuntimeDocumentStore` | `JsonFileRuntimeDocumentStore` | `write_runtime_json_atomic` |
| replay/stream publication recovery | marker 확인, prefix 목록, text object 읽기 | `ObjectManifestPort` | `Boto3ObjectManifestAdapter` | `object_manifest_port` |
| Snapshot scheduling/reconciliation | DAG trigger/status/task 조회 | `AirflowGateway` | 기존 `AirflowClient`의 structural implementation | `build_airflow_client` |

Port는 application이 실제로 사용하는 동작만 노출한다. boto3 pagination, byte decoding, subprocess stdout/stderr, JSON parse 예외는 adapter가 소유한다. 새 DI framework나 global mutable singleton은 만들지 않고, 기존 facade가 기본 production adapter를 생성하며 unit test는 선택 인자로 fake/spy를 전달한다.

## 오류 계약

- Node timeout은 `BACKEND_BRIDGE_TIMEOUT`과 recovery 시도 결과를 유지한다.
- Node non-zero exit는 marker의 code/message/status와 잘린 stdout/stderr 근거를 유지한다.
- success marker가 없거나 유효한 JSON object가 아니면 `BACKEND_BRIDGE_BAD_RESPONSE`다.
- runtime JSON은 `found`, `missing`, `unreadable`, `invalid`를 구분한다. reconciliation이 기존 단계별 오류 code로 변환한다.
- object storage SDK 오류는 adapter 밖으로 원인과 함께 전달한다. replay의 확정 404만 기존처럼 `missing`, 접근·파싱 오류는 `unavailable`이다.

## 직접 접근 측정

측정 대상은 `backend/app/services/etl_service.py`의 `subprocess.run`, `Path.read_text`, `Path.write_text`, Continuous manifest의 boto3 `head/list/get` 호출이다.

| 종류 | 변경 전 | 변경 후 |
|---|---:|---:|
| 직접 subprocess 실행 | 2 | 0 |
| runtime JSON 직접 read/write | 5 | 0 |
| Continuous manifest boto3 직접 호출 구간 | 4 | 0 |

`build_catalog_s3_client`는 source connection compatibility와 production object adapter 조립점에 남는다. Airflow raw HTTP는 이미 `AirflowClient` 내부에 격리되어 있으며 `etl_service.py`에는 존재하지 않는다.

## 검증과 rollback

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_runtime_io_ports \
  tests.test_kafka_continuous_dashboard_sync \
  tests.test_kafka_snapshot_iceberg \
  tests.test_continuous_maintenance_fencing -v
```

Rollback은 facade 내부 wiring을 이전 구현으로 되돌리는 범위다. Port는 public API가 아니며 저장된 데이터나 runtime artifact를 마이그레이션하지 않는다.
