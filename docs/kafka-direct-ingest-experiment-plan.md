# Kafka Direct Ingest Experiment Plan

## 1. 목적

이 문서는 AskLake의 Kafka snapshot direct target 경로를 반복 검증하기 위한 실험 계획과 실행 기록 양식을 정의한다. 목표는 화면에 sample row가 보이는지 확인하는 것이 아니라, Kafka 원본부터 MinIO 물리 객체와 Catalog 등록까지의 정확성, 지연, 처리량, 장애 복구 특성을 숫자로 남기는 것이다.

현재 검증 대상 경로는 아래와 같다.

```text
Kafka topic
  -> partition offset snapshot 고정
  -> snapshot 범위 consume
  -> review event 정규화 및 transform/quality 적용
  -> MinIO direct target JSONL 저장
  -> Catalog materialization 등록
  -> Kafka consumer group offset commit
```

이 경로는 항상 실행되는 streaming consumer가 아니라 manual/scheduler-triggered micro-batch다. 기본 경로는 중간 `kafka-landing/...` RAW 객체를 만들지 않는다.

## 2. 실행 전 조건

1. Kafka snapshot direct target 구현이 포함된 최신 `dev` 또는 해당 기능 브랜치에서 실행한다.
2. 수정 중인 작업 브랜치를 강제로 전환하지 않는다. 필요하면 clean clone 또는 Git worktree를 사용한다.
3. Redpanda, MinIO, Postgres와 FastAPI backend가 실행 중이어야 한다.
4. 기본 local endpoint는 Kafka `127.0.0.1:19092`, MinIO `127.0.0.1:19000`, FastAPI `127.0.0.1:8080`이다.
5. Mac의 `fileproviderd`, Docker 또는 빌드 부하가 높은 동안에는 성능 실험을 하지 않는다. 정확성 실험도 온도가 안정된 뒤 실행한다.
6. 각 실행은 고유 suffix를 사용해 topic, consumer group, dataset, MinIO prefix가 이전 실행과 섞이지 않게 한다.

Frontend는 필요하지 않다. Catalog/SQL 화면의 sample row는 전체 물리 데이터 검증 수단이 아니므로 최종 판정은 Kafka offset, ingest 응답, MinIO `data.jsonl`, Catalog API를 함께 사용한다.

## 3. 공통 판정 기준

각 실험은 다음 식별자와 결과를 남긴다.

| 구분 | 기록값 |
| --- | --- |
| 구현 기준 | branch와 commit SHA |
| 입력 | topic, partition 수, producer 전송 건수 |
| 소비 | consumer group, snapshot ID, partition별 start/end offset |
| 결과 | consumed/stored/failed/quarantined count |
| 저장 | MinIO bucket/key, object byte size, JSONL row count |
| Catalog | dataset ID, layer, storage location, materialization run |
| 정확성 | 고유 event ID, 누락, 중복, transform 불일치 |
| 시간 | producer, ingest, 검증, 전체 시간 |
| 환경 | Mac 모델, Docker resource 설정, 특이 부하 |

정확성 실험은 누락 0건, 중복 0건, 변환 불일치 0건이어야 PASS다. 성능 실험은 첫 실행을 warm-up으로 제외하고 같은 조건을 최소 3회 반복한다.

## 4. 실험 목록

### 실험 1. 100건 정확성 및 중복 방지

고유 event ID를 가진 100건을 1 partition topic에 넣는다. `Trim / Lowercase` transform을 적용해 SILVER direct target에 저장한다. Kafka 입력 건수, snapshot 범위, MinIO JSONL 100줄, event ID 고유 개수, payload offset, 변환 결과, consumer group commit을 검증한다. 같은 group으로 즉시 다시 실행했을 때 0건이어야 한다.

### 실험 2. MinIO 장애와 offset 복구

100건 전송 후 MinIO를 중단하고 ingest를 실행한다. 실패 실행에서 consumer group offset이 커밋되지 않는지 확인한다. MinIO 복구 후 같은 snapshot/group을 재실행해 최종 100건, 중복 0건, Catalog materialization 중복 0건인지 확인한다.

### 실험 3. 단계별 지연

아래 시각을 metadata에 추가한 뒤 단계별 시간을 측정한다.

```text
producerAckAt
snapshotCapturedAt
consumeEndedAt
transformEndedAt
minioWriteEndedAt
catalogPublishedAt
offsetCommittedAt
```

현재 `capturedAt`, `startedAt`, `endedAt`, `committedAt`만으로는 consume, transform, MinIO, Catalog 시간을 분리할 수 없다. 특히 기존 `endedAt`은 전체 pipeline 완료 시각으로 해석하면 안 된다.

### 실험 3 실행 절차와 사용자 검증

실험 3은 warm-up 1회와 측정 3회를 각각 새로운 topic/group/dataset으로 실행한다. `PASS`는 **성능이 충분히 빠르다**는 판정이 아니라, 세 측정 실행이 100건을 빠짐없이 저장하고 모든 stage timestamp가 순서대로 기록됐다는 판정이다. 허용 지연 목표는 기준선이 쌓인 뒤 별도로 정한다.

```bash
cd backend
ASKLAKE_IMPLEMENTATION_COMMIT="$(git rev-parse HEAD)" \
npm run experiment:kafka-stage-latency
```

runner JSON의 `runs`에서 `warmup: false`인 세 행이 측정값이며, `summaryMs`의 `min`, `median`, `p95`, `max`, `mean`은 그 세 실행의 분포다. 현재 p95는 표본 3개이므로 가장 큰 값과 같다.

| 직접 확인할 곳 | PASS일 때 보여야 하는 값 |
| --- | --- |
| 터미널 runner JSON | `status: "PASS"`, `measuredRuns: 3`, 세 measured run의 `storedCount: 100`, 모든 `durationsMs`가 0 이상 |
| 각 run의 metadata | runner `metadataLocation`의 JSON 안 `timing` 7개 시각이 `producerAckAt <= snapshotCapturedAt <= consumeEndedAt <= transformEndedAt <= minioWriteEndedAt <= catalogPublishedAt <= offsetCommittedAt` 순서 |
| MinIO Console | [http://127.0.0.1:19001](http://127.0.0.1:19001)에서 각 `storageLocation` `data.jsonl`이 100줄이고, 같은 directory의 `metadata.json` timing이 runner 출력과 동일 |
| Catalog API | `GET /api/catalog/datasets/<datasetId>`의 `rows: "100"`, `storageLocation`이 같은 run의 runner 출력과 일치 |

구간의 의미는 인접한 경계 시각의 차이다. `snapshotToConsumeEndMs`에는 durable snapshot을 API에서 Node bridge로 전달하고 consumer를 준비하는 시간도 들어간다. 따라서 이 값은 Kafka poll 함수만의 순수 시간으로 해석하지 않는다.

### 실험 4. 메시지 수 증가에 따른 처리량

100건 3회, 1,000건 3회, 10,000건 2회를 실행한다. warm-up 1회는 별도로 제외한다. 각 실행에서 rows/s, bytes/s, 단계별 시간, MinIO object 크기, CPU와 메모리를 기록한다. 정확성 검사는 모든 규모에서 유지한다.

### 실험 4 실행 절차와 사용자 검증

FastAPI, Redpanda, MinIO, Postgres를 실행한 상태에서 아래 명령을 실행한다. 각 run은 고유 topic, consumer group, dataset과 MinIO prefix를 사용한다.

```bash
cd backend
ASKLAKE_IMPLEMENTATION_COMMIT="$(git rev-parse HEAD)" \
ASKLAKE_KAFKA_EXPERIMENT_SUFFIX="manual-$(date +%Y%m%d%H%M%S)" \
npm run experiment:kafka-throughput
```

기본 profile은 warm-up 100건 1회, 측정 100건 3회, 1,000건 3회, 10,000건 2회다. 필요하면 `ASKLAKE_KAFKA_THROUGHPUT_PROFILE=100:5,1000:5,10000:5`처럼 `건수:반복` 목록을 바꾼다.

`PASS`는 모든 측정 run에서 입력 수와 저장 수가 같고, 누락·중복·transform 불일치가 0이며, Kafka committed offset이 snapshot end와 같고 최종 lag가 0이라는 뜻이다. 처리 속도가 운영 요구를 만족한다는 의미는 아니며 성능값은 local baseline이다.

| 직접 확인할 곳 | PASS일 때 보여야 하는 값 |
| --- | --- |
| 터미널 runner JSON | 최상위 `status: "PASS"`; 각 measured run의 `missingCount`, `duplicateCount`, `transformMismatchCount`, `finalLag`가 모두 0 |
| Kafka | `docker exec asklake-redpanda-source rpk group describe <consumerGroupId>`의 `CURRENT-OFFSET`과 `LOG-END-OFFSET`이 입력 수와 같고 `LAG`가 0 |
| MinIO Console | [http://127.0.0.1:19001](http://127.0.0.1:19001)에서 각 `storageLocation`의 `data.jsonl` 크기와 줄 수 확인 |
| Catalog API | `GET /api/catalog/datasets/<datasetId>`의 `rows`가 입력 수이고 `storageLocation`이 runner 출력과 동일 |

`processCpuMs`는 해당 ingest 요청 동안 FastAPI process가 사용한 CPU 시간이다. `processMaxRssBytes`는 요청별 증가량이 아니라 그 시점까지 FastAPI process가 기록한 최대 RSS이므로, 실행 간 메모리 증가 여부를 보는 보조 지표로만 사용한다.

### 실험 5. micro-batch 가시성 지연

10분 동안 1초에 1건을 produce하고 ingest 주기를 5초와 30초로 나누어 실행한다. `catalogPublishedAt - producerAckAt`의 p50, p95, max를 비교한다. 이 결과로 현재 구조가 continuous streaming인지, 짧은 주기의 micro-batch인지 설명한다.

### 실험 5 실행 절차와 사용자 검증

러너는 동일한 10분 동안 5초용 topic과 30초용 topic에 각각 초당 1건을 전송한다. 각 메시지의 실제 producer acknowledgement를 러너가 보관하고, 해당 메시지가 포함된 batch의 `catalogPublishedAt`을 빼서 가시성 지연을 계산한다. 두 조건을 동시에 실행하므로 기본 실행 시간은 약 10분이다.

```bash
cd backend
ASKLAKE_IMPLEMENTATION_COMMIT="$(git rev-parse HEAD)" \
ASKLAKE_KAFKA_EXPERIMENT_SUFFIX="manual-$(date +%Y%m%d%H%M%S)" \
npm run experiment:kafka-visibility-latency
```

축소 smoke는 `ASKLAKE_KAFKA_VISIBILITY_DURATION_SECONDS=35`로 실행한다. 기본값은 duration 600초, produce interval 1,000ms, ingest interval `5,30`초이며 각각 `ASKLAKE_KAFKA_VISIBILITY_DURATION_SECONDS`, `ASKLAKE_KAFKA_VISIBILITY_PRODUCE_INTERVAL_MS`, `ASKLAKE_KAFKA_VISIBILITY_INTERVALS_SECONDS`로 바꿀 수 있다.

이 러너가 정해진 시각마다 direct ingest API를 호출하므로 측정값은 micro-batch 주기와 Kafka→MinIO→Catalog 경로의 합이다. 운영 scheduler 자체의 tick 지연을 측정하는 실험은 아니다.

| 직접 확인할 곳 | PASS일 때 보여야 하는 값 |
| --- | --- |
| 터미널 runner JSON | 각 조건에서 `producedCount`, `storedCount`, `visibilitySampleCount`, `uniqueCount`가 600이고 누락·중복·transform 불일치가 0 |
| Kafka | 각 `consumerGroupId`의 current offset과 log end offset이 600, lag 0 |
| MinIO Console | `experiments/kafka-visibility/<suffix>/interval-5s`와 `interval-30s`의 모든 snapshot JSONL을 합쳐 각각 600줄 |
| Catalog API | 각 dataset의 `rows`가 600이고 retained materialization history와 무관하게 누적 count가 유지됨 |

짧은 ingest 주기는 가시성 지연을 줄이는 대신 더 많은 작은 object와 Catalog materialization을 만든다. 따라서 latency뿐 아니라 정확성, object 수, Catalog 누적 통계도 함께 PASS해야 한다.

## 5. 실험 1 실행 절차

### 5.1 환경 시작

```bash
docker compose up -d postgres
ASKLAKE_WITH_KAFKA=true ASKLAKE_RECREATE_KAFKA=true npm --prefix backend run sources:fixtures
```

MinIO와 Redpanda가 이미 실행 중이면 기존 container를 재사용할 수 있다. FastAPI는 direct ingest 구현이 있는 checkout의 `backend/`에서 실행한다.

```bash
DATABASE_URL=postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake \
MINIO_ENDPOINT=http://127.0.0.1:19000 \
MINIO_ACCESS_KEY=m3admin \
MINIO_SECRET_KEY=wishuponastar \
PYTHONPATH=backend \
backend/.venv/bin/uvicorn app.main:app --port 8080
```

### 5.2 실험 실행

```bash
cd backend
ASKLAKE_IMPLEMENTATION_COMMIT="$(git rev-parse HEAD)" \
npm run experiment:kafka-correctness
```

기본값은 100건이며 다음 환경변수로 실행을 분리할 수 있다.

```bash
ASKLAKE_KAFKA_EXPERIMENT_SUFFIX=manual-001
ASKLAKE_KAFKA_EXPERIMENT_COUNT=100
ASKLAKE_API_BASE_URL=http://127.0.0.1:8080
ASKLAKE_KAFKA_BROKER=127.0.0.1:19092
MINIO_ENDPOINT=http://127.0.0.1:19000
```

같은 suffix의 topic이 이미 있으면 러너는 기존 데이터를 삭제하지 않고 실패한다. 새 suffix로 다시 실행한다.

### 5.3 PASS 조건

| 검증 항목 | 기대값 |
| --- | ---: |
| Kafka producer 전송 | 100 |
| snapshot partition | 1 |
| snapshot range | `0 <= offset < 100` |
| consumed/stored/failed | `100 / 100 / 0` |
| MinIO JSONL row | 100 |
| 고유 event ID | 100 |
| 고유 payload offset | 100 |
| 변환 불일치 | 0 |
| committed group offset | 100 |
| 같은 group의 두 번째 실행 | 0건 |
| 빈 두 번째 실행 후 Catalog | 마지막 non-empty object location 유지 |
| 저장 경로 | `kafka-landing` 미포함 |
| Catalog | SILVER, MinIO location 일치 |

Kafka broker offset은 0부터 99까지이며 snapshot `endOffset=100`은 exclusive다. 메시지 payload의 업무용 `offset`은 1부터 100까지다. 두 값을 혼동하지 않는다.

## 6. 실험 2 실행 절차와 사용자 검증

이 실험은 local MinIO container를 잠시 중단한다. 실행 중인 다른 MinIO 작업은 잠시 실패할 수 있으므로, 로컬 검증 환경에서만 실행한다. 러너는 어떤 실패 경로에서도 MinIO를 다시 시작한다.

```bash
cd backend
ASKLAKE_ALLOW_MINIO_OUTAGE=true \
ASKLAKE_IMPLEMENTATION_COMMIT="$(git rev-parse HEAD)" \
npm run experiment:kafka-minio-recovery
```

러너가 PASS를 출력한 뒤 사용자가 직접 확인할 값은 출력 JSON의 `topic`, `consumerGroupId`, `datasetId`, `snapshotId`, `storageLocation`이다.

| 직접 확인할 곳 | PASS일 때 보여야 하는 값 |
| --- | --- |
| 터미널 runner JSON | `status: "PASS"`, `offsetAfterFailure: "-1"`, `offsetAfterRetry: "100"`, `recoveredStoredCount: 100` |
| Kafka | `docker exec asklake-redpanda-source rpk group describe <consumerGroupId> --brokers 127.0.0.1:9092` 결과의 current offset 100, lag 0 |
| MinIO Console | [http://127.0.0.1:19001](http://127.0.0.1:19001)에서 runner가 출력한 `storageLocation`의 `data.jsonl`을 열어 100줄 확인 |
| Catalog API | `GET /api/catalog/datasets/<datasetId>`의 rows 100, storageLocation이 runner 출력과 동일 |
| Docker | `docker ps`에서 `asklake-source-minio`가 다시 Up 상태 |

실패 단계에서 offset이 `-1`인 이유는 Kafka가 “아직 이 100건을 성공 처리하지 않았다”고 기억한다는 뜻이다. 복구 후 offset 100은 같은 100건이 한 번만 성공 처리됐다는 뜻이다.

## 7. 실행 기록

### 2026-07-10 / 실험 1

| 항목 | 결과 |
| --- | --- |
| 상태 | **FAIL - 빈 snapshot 이후 Catalog 물리 포인터 불일치** |
| 구현 commit | `dev@2403adc3eab185f3126953d1b3d729bb691672cc` |
| topic/group/dataset | `reviews.raw.correctness.20260710exp1a` / `asklake-correctness-20260710exp1a` / `ds_reviews_correctness_20260710exp1a` |
| 첫 snapshot | `kafka_snapshot_2b3d50b5f058c659`, range `0..100` exclusive |
| 첫 MinIO object | `s3://asklake-output/experiments/kafka-correctness/20260710exp1a/silver/snapshots/kafka_snapshot_2b3d50b5f058c659/data.jsonl`, 35,184 bytes |
| produced/consumed/stored | `100 / 100 / 100`, failed 0 |
| 고유 ID/중복/누락 | `100 / 0 / 0` |
| transform | 첫 row `review 001 works`, 마지막 row `review 100 works`, 불일치 0 |
| Kafka commit | partition 0 current offset 100, log end offset 100, lag 0 |
| 두 번째 실행 | consumed 0, stored 0으로 중복 방지는 통과 |
| Catalog 회귀 | 두 번째 0건 materialization 뒤 `storageLocation`이 0-byte 새 snapshot `kafka_snapshot_6a96334d75877659/data.jsonl`로 변경됐지만 dataset `rows`는 100으로 남음 |
| 시간 | producer 19ms, 첫 ingest 15,899ms, 전체 자동 검증 22,180ms |
| 비고 | iCloud 삭제 후 `fileproviderd`가 약 98% CPU를 사용했으므로 시간은 성능 기준으로 사용하지 않는다. 첫 100건 direct target의 정확성은 통과했지만 최종 Catalog 물리 참조 일관성이 깨져 전체 판정은 FAIL이다. |

판정 보강 후 `20260710exp1b` suffix로 100건을 다시 실행했으며, 러너가 `empty snapshot must not replace the last non-empty Catalog storageLocation` 오류와 exit code 1로 같은 회귀를 자동 검출했다.

실패 재현 시 기대 수정 방향은 0건 snapshot이 새 materialization run을 남기더라도 dataset의 대표 `storageLocation`을 존재하는 마지막 non-empty object에서 바꾸지 않거나, dataset location을 여러 snapshot을 포함하는 prefix/table contract로 전환하는 것이다.

### 2026-07-10 / 실험 1 수정 후 재실행

| 항목 | 결과 |
| --- | --- |
| 상태 | **PASS** |
| 구현 branch | `codex/fix-kafka-empty-snapshot-catalog`, base `dev@2403adc3eab185f3126953d1b3d729bb691672cc` |
| topic/group/dataset | `reviews.raw.correctness.20260710exp1fixed` / `asklake-correctness-20260710exp1fixed` / `ds_reviews_correctness_20260710exp1fixed` |
| 첫 snapshot | `kafka_snapshot_d2f139f6dd86a24f`, range `0..100` exclusive |
| 첫 MinIO object | `s3://asklake-output/experiments/kafka-correctness/20260710exp1fixed/silver/snapshots/kafka_snapshot_d2f139f6dd86a24f/data.jsonl`, 35,584 bytes |
| produced/consumed/stored | `100 / 100 / 100`, 고유 ID 100 |
| Kafka commit | partition 0 committed offset 100, 두 번째 실행 consumed 0 |
| 최종 Catalog | rows 100, sample rows 10, 대표 location이 첫 100건 object와 동일 |
| 0건 snapshot | `kafka_snapshot_9a8c5331b10624ac` materialization 이력은 rowCount 0으로 유지, `data.jsonl` HEAD는 404로 물리 객체 미생성 확인 |
| 시간 | producer 17ms, 첫 ingest 15,978ms, 전체 자동 검증 22,331ms |
| 전체 smoke | `npm run verify:kafka-review-scheduled-ingest` 통과 |

수정 후에는 0건 실행이 새 materialization 이력과 offset range는 남기지만, 실제 target data object를 만들지 않고 부모 Catalog dataset의 마지막 non-empty location과 호환 가능한 sample rows를 유지한다.

### 2026-07-10 / 실험 2 MinIO 장애 복구

| 항목 | 결과 |
| --- | --- |
| 상태 | **PASS** |
| 구현 branch | `codex/fix-kafka-empty-snapshot-catalog` |
| topic/group/dataset | `reviews.raw.minio-recovery.20260710exp2d` / `asklake-minio-recovery-20260710exp2d` / `ds_reviews_minio_recovery_20260710exp2d` |
| snapshot | `kafka_snapshot_8c94b31c1e490b82`, range `0..100` exclusive |
| 장애 | `asklake-source-minio`를 중단한 상태에서 502, bridge message `connect ECONNREFUSED 127.0.0.1:19000` |
| 장애 직후 Kafka | committed offset `-1`: 100건이 성공 처리되지 않았음을 확인 |
| 복구 후 재시도 | 같은 snapshot ID 재사용, consumed/stored `100 / 100`, 실패 0 |
| Kafka 최종 | current offset 100, log end 100, lag 0 |
| MinIO 최종 | 35,984 bytes, JSONL 100줄, 고유 event ID 100개 |
| Catalog 최종 | rows 100, 첫 100건 object와 같은 storageLocation, materialization run 1개 |
| Docker 최종 | `asklake-source-minio` Up 상태로 자동 복구 |
| 시간 | 전체 27,258ms. 의도적으로 MinIO stop/start를 포함하므로 성능 지표로 사용하지 않는다. |

### 2026-07-10 / 실험 3 단계별 지연

| 항목 | 결과 |
| --- | --- |
| 상태 | **PASS - warm-up 1회, 측정 3회 모두 100건 저장·MinIO metadata/Catalog 교차 검증** |
| 구현 branch | `codex/fix-kafka-empty-snapshot-catalog` |
| 실행 suffix | `20260710exp3a` |
| 측정 dataset | `ds_reviews_stage_latency_20260710exp3a_measure-2`, `measure-3`, `measure-4` |
| 각 측정 run | stored 100, JSONL 100줄, 고유 event ID 100개, Catalog rows 100 |
| producer → snapshot capture | median 500ms, p95 529ms |
| snapshot → consume end | median 5,261ms, p95 5,270ms |
| consume → transform end | median 3ms, p95 3ms |
| transform → MinIO write end | median 44ms, p95 47ms |
| MinIO → Catalog published | median 20ms, p95 21ms |
| Catalog → offset commit | median 5,022ms, p95 5,026ms |
| producer → Catalog published | median 5,812ms, p95 5,866ms |
| producer → offset commit | median 10,834ms, p95 10,884ms |
| 해석 | MinIO object write와 Catalog publication 자체는 수십 ms였고, 두 약 5초 구간에는 Kafka bridge의 snapshot handoff/consumer 준비 및 admin offset commit 연결 준비 시간이 포함된다. 이 결과만으로 Kafka poll 또는 commit RPC가 정확히 5초라고 단정하지 않는다. |

측정 3개뿐이므로 p95는 관측값 중 최댓값이다. 이 PASS는 데이터와 timestamp의 정합성 판정이며 아직 성능 SLO 판정은 아니다. SLO는 같은 환경에서 더 많은 반복 측정과 메시지 수 증가 실험 뒤에 설정한다.

### 2026-07-10 / 실험 3b 5초 고정 지연 원인 분해

`20260710exp3detailb` suffix로 1건, 100건, 1,000건을 각각 fresh topic/group/dataset에 넣고 FastAPI bridge, Kafka admin, consumer instrumentation event를 세분화했다.

| 구간 | 1건 | 100건 | 1,000건 | 판정 |
| --- | ---: | ---: | ---: | --- |
| producer ack → FastAPI | 4ms | 3ms | 3ms | HTTP local 비용 |
| FastAPI bridge 시작 → Node 시작 | 148ms | 176ms | 171ms | subprocess/static import 고정비 |
| snapshot topic offset 조회 | 7.26ms | 8.47ms | 10.00ms | 정상 범위 |
| snapshot group offset 조회 | 283.71ms | 302.57ms | 341.86ms | snapshot 0.5초의 가장 큰 Kafka 조회 비용 |
| snapshot 범위 계산 | 0.09ms | 0.09ms | 0.08ms | 계산 자체는 사실상 0ms |
| reader `admin.setOffsets` | 5,036.02ms | 5,047.65ms | 5,036.95ms | 첫 5초의 원인 |
| consumer group join | 3ms | 2ms | 3ms | 정상 범위 |
| snapshot consume 전체 | 14.85ms | 13.94ms | 27.42ms | 실제 연결 후 읽기 |
| 첫 메시지 → 마지막 메시지 | 0ms | 1ms | 5ms | 데이터량 증가에 따른 실제 read/parse |
| commit `admin.setOffsets` | 5,009.30ms | 5,008.94ms | 5,009.79ms | 두 번째 5초의 원인 |

세 규모에서 `setOffsets`가 모두 약 5초이고 실제 1,000건 읽기는 5ms였으므로, 기존 약 10.8초는 처리량 문제가 아니라 KafkaJS `admin.setOffsets()`가 내부 임시 consumer/fetch를 사용하는 방식의 고정 오버헤드로 판정한다. 현재 설치된 KafkaJS consumer의 기본 `maxWaitTimeInMs`는 5,000ms다.

Python 전환 전 기준선은 다음과 같다.

- 정확성: 각 규모에서 stored count와 MinIO JSONL line count가 입력과 동일하고 event ID 중복 0건
- Kafka: 최종 group offset이 각 입력 건수와 같고 lag 0
- 지연: Python 구현은 임시 consumer 기반 offset reset 두 번을 제거하고, 실제 consumer의 explicit assign/seek/commit을 사용해 두 5초 고정비가 사라져야 한다.

### 2026-07-10 / 실험 3c Python Kafka runtime 전환

FastAPI `run`/`retry`와 direct ingest endpoint에서 Node subprocess를 제거하고 `app/services/kafka_review_ingest_service.py`의 Python `confluent-kafka` consumer와 `boto3` target write를 사용했다. `20260710exp3python2` suffix로 동일 1건, 100건, 1,000건 정확성·지연 실험을 실행했다.

| 구간 | 1건 | 100건 | 1,000건 |
| --- | ---: | ---: | ---: |
| producer → snapshot capture | 17ms | 16ms | 12ms |
| snapshot → consume end | 119ms | 117ms | 133ms |
| 첫 메시지 → 마지막 메시지 | 0ms | 1ms | 14ms |
| transform | 0ms | 2ms | 13ms |
| MinIO target write | 40ms | 40ms | 26ms |
| Catalog publish | 10ms | 7ms | 3ms |
| consumer offset commit | 2ms | 2ms | 1ms |
| producer → Catalog | 186ms | 182ms | 187ms |
| producer → offset commit | 188ms | 184ms | 188ms |

각 규모에서 입력 건수, stored count, MinIO JSONL line count, 고유 event ID와 Catalog rows가 일치했다. Python consumer의 partition assign은 `0.05/0.09/0.06ms`, synchronous commit은 `1.54/1.33/0.51ms`였고, 기존 두 번의 약 5초 고정비가 제거됐다.

추가 회귀 결과:

- `npm run verify:kafka-review-scheduled-ingest`: snapshot, empty run, malformed quarantine, transform/quality, 실패 retry, multi-partition, Catalog retry idempotency 전체 PASS
- `20260710exp2python` MinIO 장애 복구: 장애 직후 offset `-1`, 복구 후 offset `100`, stored 100, 고유 ID 100, materialization run 1로 PASS
- Python 전환 후 Node Kafka ingest script는 production FastAPI 실행 경로가 아니라 이전 동작 비교/fixture 자산이다.

### 2026-07-10 / 실험 4 메시지 수 증가에 따른 처리량

Python Kafka runtime을 대상으로 `20260710exp4a` suffix를 사용했다. local Mac 한 대에서 Redpanda, MinIO, Postgres, FastAPI를 함께 실행했고 모든 topic은 1 partition이다. warm-up 100건 1회는 집계에서 제외했다.

| 입력/반복 | pipeline rows/s | 처리량 | end-to-end | consume 준비·읽기 | transform | MinIO write | Catalog | commit | CPU time | FastAPI peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100건 × 3 | median 694.44, p95 775.19 | median 0.24MB/s | median 159ms, p95 165ms | 111ms / 114ms | 3ms / 3ms | 23ms / 27ms | 4ms / 5ms | 1ms / 1ms | median 18.02ms | median 173.6MB, max 174.8MB |
| 1,000건 × 3 | median 6,134.97, p95 6,250.00 | median 2.13MB/s | median 171ms, p95 201ms | 121ms / 159ms | 8ms / 10ms | 26ms / 29ms | 4ms / 4ms | 1ms / 1ms | median 35.26ms | median 177.8MB, max 178.3MB |
| 10,000건 × 2 | 35,842.29~40,160.64 | 12.61~14.12MB/s | 256~287ms | 79~82ms | 97~135ms | 58~65ms | 3~6ms | 1~2ms | 171.63~212.05ms | 210.9~222.7MB |

표의 단계별 100건·1,000건 값은 `median / p95`다. 표본이 3개이므로 p95는 최댓값이고, 10,000건은 표본이 2개라 범위만 표시했다.

정확성 판정은 모든 8개 measured run에서 PASS였다. 각 run의 입력, consumed/stored, MinIO JSONL row, Catalog rows가 일치했고 누락·중복·transform 불일치는 모두 0이었다. 마지막 10,000건 group을 별도 확인한 결과 current offset 10,000, log end offset 10,000, lag 0이었다.

이번 범위에서는 메시지가 커질수록 고정 연결·consume 준비 비용이 분산되어 rows/s가 증가했으므로 10,000건까지 처리량 포화는 관측되지 않았다. 작은 batch에서는 약 80~159ms의 consume 준비·읽기 구간이 가장 크고, 10,000건에서는 transform 97~135ms가 가장 큰 가변 비용이 됐다. MinIO write는 3.69MB object에서 58~65ms였다. 이는 local MinIO 기준이며 외부 S3의 네트워크 RTT, bandwidth, TLS, multipart 설정이 추가되면 별도 측정이 필요하다.

FastAPI peak RSS는 warm-up 후 약 172MB에서 마지막 실행 223MB로 증가했다. 이 값은 process lifetime peak라 해제되지 않은 실제 누수량을 뜻하지 않는다. 반복 횟수를 늘린 steady-state RSS와 현재 RSS를 별도 수집하기 전에는 memory leak으로 판정하지 않는다.

### 2026-07-10 / 실험 5 micro-batch 가시성 지연

`20260710exp5full` suffix로 10분 동안 두 topic에 각각 1초당 1건, 총 600건을 전송했다. 5초 조건은 120회, 30초 조건은 20회 direct ingest를 실행했다. 35초 축소 smoke `20260710exp5smoke2`는 두 조건 모두 PASS했지만, 본 실행은 5초 조건의 Catalog 누적 통계 오류로 전체 **FAIL**이다.

| 조건 | p50 | p95 | max | mean | Kafka/MinIO 정확성 | Catalog rows |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| 5초 micro-batch | 2.17초 | 4.18초 | 5.15초 | 2.18초 | 600건, 누락·중복·변환 오류 0, offset 600, lag 0 | **249 / 기대 600** |
| 30초 micro-batch | 15.15초 | 28.17초 | 30.14초 | 14.73초 | 600건, 누락·중복·변환 오류 0, offset 600, lag 0 | 600 |

가시성 지연 측정 자체는 1,200개 메시지 모두 producer acknowledgement와 실제 batch `catalogPublishedAt`을 연결해 계산했으므로 유효하다. 결과는 현재 구조가 continuous streaming이 아니라 trigger 주기에 의해 대기 시간이 결정되는 micro-batch임을 보여준다. local 처리 자체의 최솟값은 약 0.13~0.15초였지만, 주기 대기로 인해 5초 조건의 p95는 4.18초, 30초 조건의 p95는 28.17초가 됐다.

전체 FAIL 원인은 물리 데이터 손실이 아니다. 5초 조건의 120개 MinIO snapshot에는 총 600건이 있고 Kafka current/log-end offset도 모두 600이다. `register_catalog_dataset()`이 materialization history를 최근 50개로 자른 뒤 그 50개의 `rowCount`와 `storageSizeBytes`만 다시 합산한다. 마지막 50개 batch가 49개의 5건 batch와 마지막 4건 batch이므로 Catalog가 `249`를 표시한다. 30초 조건은 20회라 history 한도에 도달하지 않아 600을 유지했다.

수정 시에는 누적 rows/bytes를 retained history 50개와 분리하고, 같은 snapshot retry는 증가시키지 않으며, 51회 이상 materialization 회귀 테스트를 추가해야 한다. 수정 전에는 짧은 주기로 오래 실행한 Kafka dataset의 Catalog rows와 size를 전체 물리 데이터 수로 신뢰하면 안 된다.

## 8. 결과 보존 원칙

실험 결과에는 secret을 기록하지 않는다. topic, group, dataset, snapshot, MinIO `s3://` location, count, duration과 구현 commit만 남긴다. 실제 `data.jsonl` 전체는 저장소에 commit하지 않고 MinIO에 유지한다. 실패 결과도 원인을 포함해 남기되 access key, password, token은 제거한다.
