# Kafka·Spark Capacity Phase 0 Baseline And Architecture Decision

이 문서는 Issue #694의 대용량 처리 고도화 Phase 0 기준선, 측정 계약, 아키텍처 결정을 기록한다. 특정 장비에서 측정한 처리량을 일반적인 제품 성능으로 과장하지 않고, 같은 조건을 재현하고 비교할 수 있는 근거를 만드는 것이 목적이다.

- 상태: Accepted for Phase 0
- 적용 범위: Kafka Continuous → Spark Structured Streaming → object storage
- API 변경: 없음
- 후속 단계: Spark Runtime 추상화, S3 저장소 계약, EMR Serverless/MSK 연동

## 1. Phase 0의 결론

1. 로컬 개발 경로인 `Redpanda → Docker Spark → MinIO`는 유지한다.
2. 운영 확장은 로컬을 제거하는 방식이 아니라, 백엔드가 Docker와 원격 Spark Runtime을 선택할 수 있게 분리하는 방식으로 진행한다.
3. AWS 운영 후보 경로는 `MSK → EMR Serverless Spark → S3`로 정하되, Phase 0에서는 AWS 자원이나 Runtime을 구현하지 않는다.
4. Kubernetes는 데이터 파이프라인의 필수 조건이 아니며 이번 확장 범위에서 제외한다.
5. 자동 확장은 무한 자원을 뜻하지 않는다. 후속 Runtime에는 Application, Job, 동시 실행 수의 상한과 `run / queue / reject` admission 정책이 필요하다.
6. 처리량, P95 latency, backlog 복구 목표는 Phase 0 리포트와 승인된 비용·자원 조건 없이 확정하거나 홍보하지 않는다.

## 2. 현재 구조와 알려진 자원 경계

현재 prod-like Compose 기준의 단일 호스트 경계는 다음과 같다.

```text
Redpanda (1 broker, 1 SMP, 1 GiB)
    ↓
Spark master (REST submission, maxDrivers 기본 2, defaultCores 기본 2)
    ↓
Spark worker (기본 4 cores, 10 GiB)
    ↓
Object storage
```

근거:

- `deploy/docker-compose.prod.yml`: Redpanda `--smp 1`, `--memory 1G`
- `deploy/docker-compose.prod.yml`: Spark master `spark.deploy.maxDrivers`, `spark.deploy.defaultCores`
- `deploy/docker-compose.prod.yml`: Spark worker `ASKLAKE_SPARK_WORKER_CORES`, `ASKLAKE_SPARK_WORKER_MEMORY`
- `backend/scripts/manage-kafka-continuous.mjs`: Continuous Spark 제출과 trigger/offset 설정 전달
- `backend/scripts/kafka_continuous_stream.py`: Structured Streaming Kafka source와 checkpoint 실행

이 구조에서는 여러 Job이 논리적으로 존재할 수 있어도 물리 계산 자원은 같은 worker 경계 안에서 경쟁한다. Kafka broker만 늘리거나 Spark worker만 늘리는 한쪽 변경으로 전체 처리량을 보장할 수 없다. topic partition, Spark 병렬성, micro-batch 설정, object storage 처리량을 함께 측정해야 한다.

## 3. 측정 용어

| 지표 | 의미 | Phase 0 기록 방법 |
| --- | --- | --- |
| 지속 처리량 | lag가 계속 증가하지 않는 상태에서 완료하는 평균 속도 | 입력 rate, peak/final throughput, elapsed time을 함께 기록 |
| micro-batch 크기 | trigger 한 번에 Kafka에서 읽는 최대 offset 수 | `maxOffsetsPerTrigger` 기록 |
| trigger 주기 | Spark가 다음 micro-batch를 시도하는 주기 | `triggerIntervalSeconds` 기록 |
| end-to-end latency | Kafka 입력부터 성공 output/manifest까지의 시간 | 현재 runtime 근거가 제공하는 batch duration을 기록하고, event timestamp 기반 P95는 후속 계측으로 분리 |
| backlog 복구 | worker 시작 전 누적 메시지를 따라잡는 능력 | worker 시작 전 produce 후 peak/final lag와 elapsed time 기록 |
| 데이터 정합성 | 입력이 stored 또는 quarantine으로 설명되는지 | produced/consumed/stored/quarantine/missing/duplicate reconciliation |
| 복구 시간 | 장애 주입부터 runtime이 다시 처리 가능한 상태가 되기까지 | `recoveryMs` 기록 |

`maxOffsetsPerTrigger=1,000,000`은 초당 100만 건 처리 보장이 아니다. 한 micro-batch의 입력 상한일 뿐이며 실제 완료 속도는 batch duration, partition, executor, 저장소와 함께 판단한다.

## 4. 기준선 시나리오

`verify-kafka-continuous-baseline.mjs`는 보수적인 로컬 기본값을 제공한다. 큰 입력은 같은 시나리오에 count/rate를 명시적으로 덮어써 실행한다.

| 시나리오 | 기본 동작 | 확인할 질문 |
| --- | --- | --- |
| `steady` | worker 실행 중 2,000건을 250 rows/s로 입력 | 일정 입력에서 final lag가 0으로 회복하는가 |
| `burst` | 5,000건을 짧은 고속 구간으로 입력 | peak lag가 얼마이며 입력 종료 후 따라잡는가 |
| `backlog` | worker 시작 전에 10,000건을 적재 | retained backlog를 earliest부터 누락 없이 해소하는가 |
| `worker-recovery` | 5,000건 처리 중간에 worker 장애 주입 | checkpoint 재개 후 누락·중복 없이 복구하는가 |
| Continuous + Batch 경합 | 별도 수동 시나리오에서 같은 worker에 Batch 제출 | Continuous 지연과 Batch 대기/실행이 어떻게 변하는가 |

Continuous + Batch 경합은 현재 soak runner 하나로 자동화하지 않는다. 같은 호스트에 다른 사용자의 실행이 있는 상태를 기준선으로 섞지 않고, 전용 환경에서 Batch Run ID와 Continuous baseline Run ID를 함께 기록해야 한다.

## 5. 실행 게이트

설정 계약만 확인하는 명령은 Docker 서비스를 변경하지 않는다.

```bash
cd backend
npm run verify:kafka-continuous-baseline:config
```

실제 기준선은 Kafka topic과 Job을 만들고 worker/fault를 제어하므로 opt-in이 필요하다. 실행 전에 전용 prod-like Compose 환경, `deploy/.env`, backend `:8080`, Redpanda, Spark, object storage를 준비한다.

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_BASELINE=true \
ASKLAKE_CONTINUOUS_BASELINE_SCENARIO=steady \
npm run verify:kafka-continuous-baseline
```

backlog 예시:

```bash
cd backend
ASKLAKE_RUN_KAFKA_CONTINUOUS_BASELINE=true \
ASKLAKE_CONTINUOUS_BASELINE_SCENARIO=backlog \
ASKLAKE_CONTINUOUS_BASELINE_COUNT=100000 \
ASKLAKE_CONTINUOUS_BASELINE_RATE=10000 \
ASKLAKE_CONTINUOUS_BASELINE_TRIGGER_SECONDS=2 \
ASKLAKE_CONTINUOUS_BASELINE_MAX_OFFSETS_PER_TRIGGER=5000 \
npm run verify:kafka-continuous-baseline
```

결과는 기본적으로 ignored directory인 `backend/tmp/kafka-continuous-baseline/<run-id>.json`과 같은 이름의 `.md`에 저장된다. 원본 결과를 PR 근거로 보존하려면 민감 정보가 없는지 확인한 뒤 PR 설명이나 승인된 artifact storage에 첨부한다.

## 6. 설정 계약

| 환경 변수 | 기본값 | 제약 |
| --- | --- | --- |
| `ASKLAKE_CONTINUOUS_BASELINE_SCENARIO` | `steady` | `steady`, `burst`, `backlog`, `worker-recovery` |
| `ASKLAKE_CONTINUOUS_BASELINE_COUNT` | 시나리오별 | 양의 정수 |
| `ASKLAKE_CONTINUOUS_BASELINE_RATE` | 시나리오별 | 양의 rows/s |
| `ASKLAKE_CONTINUOUS_BASELINE_BATCH_SIZE` | 시나리오별 | 양의 producer batch 크기 |
| `ASKLAKE_CONTINUOUS_BASELINE_PARTITIONS` | `1` | 생성할 topic partition 수 |
| `ASKLAKE_CONTINUOUS_BASELINE_TRIGGER_SECONDS` | 시나리오별 | 양의 정수 |
| `ASKLAKE_CONTINUOUS_BASELINE_MAX_OFFSETS_PER_TRIGGER` | 시나리오별 | 양의 정수, 전체 partition 합산 |
| `ASKLAKE_CONTINUOUS_BASELINE_MALFORMED_PERCENT` | `0` | 0~100 |
| `ASKLAKE_CONTINUOUS_BASELINE_SCHEMA_CHANGE` | `false` | `true` 또는 `false` |
| `ASKLAKE_CONTINUOUS_BASELINE_FAULT` | 시나리오별 | `none`, `worker`, `backend`, `kafka`, `minio` |
| `ASKLAKE_CONTINUOUS_BASELINE_COMPACT` | `false` | 측정 종료 후 compaction 포함 여부 |
| `ASKLAKE_CONTINUOUS_BASELINE_RESOURCE_SAMPLING` | `true` | `docker stats` best-effort 표본 수집 |
| `ASKLAKE_CONTINUOUS_BASELINE_OUTPUT_DIR` | `backend/tmp/kafka-continuous-baseline` | 결과 디렉터리 |
| `ASKLAKE_CONTINUOUS_BASELINE_COST_CONTEXT` | `local-unpriced` | 실행 비용 또는 예산 조건을 설명하는 한 줄 |

잘못된 수치, 알 수 없는 시나리오, backlog 준비 중 runtime fault 같은 모순된 조합은 topic과 Job을 만들기 전에 실패한다.

## 7. 리포트 계약

JSON 리포트의 `schemaVersion`은 `asklake.kafka-spark-baseline.v1`이다.

필수 근거:

- 실행 identity: Run ID, 시작/종료 시각, Git revision
- 환경: OS/architecture, CPU 수, memory, Node/Docker/Compose version
- 시나리오: count, byte size, 평균 message size, rate, producer batch, partition, trigger, max offsets, fault
- 정합성: produced, consumed, stored, quarantined, replayed, missing, duplicate
- 처리: peak/final lag, peak/final throughput, 마지막 batch duration/input rows, elapsed
- 복구: fault mode, recovery time
- 자원: 관련 Spark/Redpanda/MinIO/backend container의 best-effort peak CPU/memory 표본
- Catalog/운영: materialization 수, worker log line 수, optional compaction 결과

정합성 hard gate:

```text
consumedCount == producedCount
missingCount == 0
duplicateCount == 0
storedCount + quarantinedCount - replayedCount == producedCount
```

성능은 Phase 0에서 임의 pass/fail 수치를 만들지 않는다. 리포트는 `performanceTarget=not-set-phase0`로 남고, 반복 측정과 비용 근거가 모인 뒤 SLO를 별도 승인한다.

## 8. 측정 절차

1. 다른 사용자 Job이 없는 전용 환경인지 확인한다.
2. Git revision과 Compose/env 구성을 고정한다.
3. `verify:kafka-continuous-baseline:config`를 통과시킨다.
4. `steady`를 3회 실행해 편차를 확인한다.
5. `burst`, `backlog`, `worker-recovery`를 각각 실행한다.
6. 각 실행의 JSON/Markdown과 Docker/Spark/Kafka 로그 위치를 보존한다.
7. Continuous + Batch 경합은 별도 Run ID로 실행한다.
8. count/rate만 바꾼 결과를 비교하지 말고 partition, trigger, max offsets, Spark 자원, message bytes를 함께 비교한다.
9. median과 최악값을 기록하고 anomalous run은 삭제하지 말고 원인을 적는다.

## 9. Phase 0 완료와 후속 진입 조건

Phase 0 코드/문서 완료 조건:

- 설정 계약 검증이 Docker 없이 통과한다.
- 실제 실행은 JSON과 Markdown evidence를 남긴다.
- backlog는 worker 시작 전에 produce한다.
- soak 결과에 tuning, final lag, batch duration, resource sample이 포함된다.
- 기존 Continuous contract 검증이 회귀 없이 통과한다.

Phase 1 진입 조건:

- 전용 prod-like 환경에서 네 시나리오 리포트를 확보한다.
- 정합성 hard gate를 모두 통과한다.
- 현재 병목이 Kafka, Spark, storage, network 중 어디인지 근거와 함께 기록한다.
- 후속 Runtime의 초기 자원 상한과 비용 예산을 결정한다.

Phase 1에서는 공통 `SparkRuntime` 계약과 기존 `DockerSparkRuntime` 분리를 진행한다. EMR/MSK/S3 구현은 Runtime과 저장소 계약이 분리된 이후에 시작한다.

## 10. 롤백과 안전

- 새 기준선 runner는 opt-in이며 제품 API 동작을 변경하지 않는다.
- 기존 `verify:kafka-continuous-soak` 명령은 계속 사용할 수 있다.
- fault 시나리오는 전용 환경에서만 실행하고 Kafka/MinIO pause가 남지 않았는지 종료 후 확인한다.
- 실패한 실행도 실패 JSON/Markdown 근거를 남긴다.
- `deploy/.env`, credential, token, 원본 민감 레코드는 리포트에 기록하지 않는다.
- 기준선 자동화를 제거해야 할 때 package script와 wrapper를 되돌리면 기존 Continuous runtime에는 영향이 없다.
