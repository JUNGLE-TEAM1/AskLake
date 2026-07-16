# Spark/Kafka Runtime Script·Python/Node 경계

이 문서는 15개 순차 리팩터링 PR 중 PR 08(Stage 11~12)의 하위 호환 및 운영 계약이다.

## Runtime 모듈 경계

기존 실행 경로는 유지한다.

```text
/opt/asklake/scripts/spark_job_run.py
  → runtime.spark_job_runtime
    → runtime.config
    → runtime.contracts
    → runtime.spark_text_analysis

/opt/asklake/scripts/kafka_continuous_stream.py
  → runtime.kafka_continuous_runtime
    → runtime.config
    → runtime.contracts
    → runtime.kafka_state
```

- 기존 두 entrypoint는 20줄 이하의 compatibility façade다.
- Spark text structuring·review analysis·classifier 책임은 `spark_text_analysis.py`로 분리한다.
- 환경 파싱은 Spark 없는 typed dataclass로 검증한다.
- Kafka cursor 정규화는 Spark 없는 순수 모듈이다.
- `spark_job_runtime`과 `kafka_continuous_runtime`은 실제 Spark wiring과 execution lifecycle을 조정한다.
- 과거 `from spark_job_run import ...` 호출은 implementation module alias로 같은 함수와 patch 지점을 유지한다.

## Report·Checkpoint·Manifest 버전

| 문서 | 버전 필드 | 현재 버전 | 이전 문서 읽기 |
|---|---|---:|---|
| Spark/Kafka runtime report | `runtimeReportSchemaVersion` | 1 | 필드 없음 = 0 허용 |
| Continuous checkpoint contract | `contractSchemaVersion` | 1 | 필드 없음 허용 |
| Continuous batch manifest | `manifestSchemaVersion` | 1 | 필드 없음 = 0 허용 |

로컬 runtime report는 같은 디렉터리에 임시 파일을 쓴 뒤 atomic rename한다. 실패 report를 기록하다 추가 오류가 발생하면 원래 실행 오류를 `error`에 유지하고 `secondaryErrors[]`에 report 오류를 기록한다. 미래 버전 reader는 지원 버전을 명시적으로 추가하기 전까지 fail closed한다.

## Kafka 처리 보장 범위

Kafka Continuous는 정확히 한 번의 end-to-end delivery를 주장하지 않는다.

- Structured Streaming checkpoint가 Kafka source progress를 관리한다.
- 한 micro-batch의 output/quarantine을 먼저 commit하고 완료 batch manifest를 게시한다.
- 재시작 시 source range, publication signature, Iceberg commit과 완료 marker를 검증해 같은 durable batch를 재사용한다.
- Catalog와 Dashboard publication은 별도 transaction과 reconciliation 단계이므로 worker output과 동시에 원자적으로 commit되지 않는다.
- 따라서 보장 표현은 `checkpoint 기반 재처리 + idempotent output/publication reconciliation`이며, 외부 side effect 전체를 묶는 exactly-once가 아니다.

## Python·Node 권위 매트릭스

| Use case | 현재 권위 | production evidence | 호환/종료 조건 |
|---|---|---|---|
| FastAPI ETL command, Job/Run/Catalog metadata | Python canonical | production image의 `uvicorn app.main:app` | Node demo persistence와 비교 fixture 제거 전 parity 확인 |
| Source connector probe·asset listing | Node canonical compatibility | FastAPI가 `test-source-connector.mjs`, `list-source-assets.mjs`를 `SubprocessNodeBridge`로 호출 | Python adapter가 모든 connector parity/secret masking 계약을 통과하면 전환 검토 |
| Spark REST submission·legacy launcher | Node canonical compatibility | `sparkRunner.mjs`, `spark-rest-client.mjs`, launcher script가 production command에 사용 | Python gateway가 timeout/recovery/state-file 계약을 대체한 뒤 전환 |
| Kafka Continuous start/maintenance launcher | Node canonical compatibility | `manage-kafka-continuous*.mjs`가 FastAPI bridge에서 호출 | Spark REST lifecycle parity와 운영 soak 완료 후 전환 |
| Review analysis compute | Node canonical behind versioned bridge | `reviewRowAnalysis.mjs` operation을 Python API가 호출 | model/runtime을 Python으로 옮기지 않는 한 Node 유지 |
| `createPipeline.mjs`·Node `server.mjs` API | reference/dev compatibility | production backend CMD는 FastAPI, Node verifier·local reference가 import | 회귀 비교 자산과 finalize helper 대체 후 owner 결정 |
| Rule compiler/runtime parity | dual implementation with shared contract fixture | Python create/review와 Node compatibility verifier가 같은 fixture 사용 | 한 구현으로 전환하기 전 cross-runtime parity gate 유지 |

production evidence가 없는 Node 경로를 이 PR에서 삭제하지 않는다. 각 compatibility 경로의 owner는 Data Platform backend이며 종료 조건이 충족되기 전까지 verifier를 유지한다.

## Versioned Node bridge

`VersionedNodeBridge`와 `node-json-bridge.mjs`의 protocol은 다음 envelope만 stdout으로 교환한다.

```json
{
  "version": "1.0",
  "requestId": "correlation-id",
  "idempotencyKey": "sha256",
  "operation": "reviewAnalysis.suggestSchema",
  "payload": {}
}
```

- Node는 allow-list operation, version, request identity, idempotency key, object payload를 양쪽에서 검증한다.
- stdout은 단일 JSON response 전용이고 진단은 bounded stderr로 분리한다.
- timeout은 Python `subprocess.run`의 terminate/kill-and-wait 경계를 사용한다.
- timeout/start/process/protocol 오류를 서로 다른 code와 `stage`로 분류한다.
- password, secret, token, access key, authorization 진단은 `[REDACTED]`로 치환한다.
- legacy marker bridge는 즉시 제거하지 않고 correlation/idempotency env와 redaction을 추가한 compatibility adapter로 유지한다.

## Rollback

- 기존 entrypoint 경로를 유지하므로 façade를 이전 구현으로 되돌릴 수 있다.
- report/checkpoint/manifest의 새 필드는 additive이며 이전 consumer가 무시할 수 있다.
- `ReviewAnalysisService`는 injected `VersionedNodeBridgePort` 뒤에 있으므로 이전 adapter로 되돌려도 API shape와 persisted data migration이 없다.
- runtime data, checkpoint, manifest를 rollback 과정에서 삭제하지 않는다.

## 검증

```bash
cd backend
PYTHONPATH=. .venv/bin/python -m unittest \
  tests.test_runtime_script_contracts \
  tests.test_runtime_io_ports \
  tests.test_review_analysis_bridge -v
node --test scripts/node-json-bridge.test.mjs
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:production-spark
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:spark-schema-contract
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:kafka-continuous-contract
ASKLAKE_FASTAPI_PYTHON=.venv/bin/python npm run verify:continuous-runtime-contract
```
