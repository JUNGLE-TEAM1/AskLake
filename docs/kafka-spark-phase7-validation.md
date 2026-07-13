# Kafka·Spark Phase 7 부하·장애·비용 검증

이 문서는 Issue #704의 성능 검증 계약과 실행 절차를 설명한다. 목표는 “대용량 가능”이라는 표현을 만드는 것이 아니라, 같은 입력·설정·자원 조건에서 결과를 반복하고 통과하지 못한 기준도 그대로 남기는 것이다.

- 상태: 저장소 하네스 및 계약 구현 완료
- 로컬 기본 경로: Redpanda → Docker Spark → MinIO
- AWS 검증 경로: Amazon MSK → EMR Serverless Continuous → S3
- 제품 API 변경: `continuousRuntime.endToEndLatency` 선택 필드 추가
- AWS staging 실측: 과금·인프라 권한이 필요한 별도 opt-in 실행
- 운영 Runtime 전환: Phase 8 전까지 금지

## 1. 한눈에 보는 판정 흐름

```text
versioned test plan
  └─ 부하 8종 + 장애 8종 + 전용 환경 안전 게이트
       ↓
local soak 또는 AWS staging 실행
       ↓
asklake.streaming-performance-evidence.v1
  ├─ 입력/소비/적재/quarantine/중복/누락
  ├─ 처리량, P50/P95/P99, lag, 복구 시간
  ├─ executor/CPU/memory, output file
  └─ EMR billed resource + 단가 snapshot + 실제 비용(optional)
       ↓
asklake.streaming-slo-profile.v1
       ↓
passed | failed | insufficient-evidence
       ↓
JSON + Markdown report
```

`insufficient-evidence`는 성공이 아니다. 다음 중 하나라도 해당하면 이 상태다.

- SLO profile이 `draft`다.
- 합의한 최소 반복 횟수를 채우지 않았다.
- 같은 시나리오의 반복 실행 설정 fingerprint가 다르다.
- profile의 environment/region과 evidence가 다르다.
- 필수 latency, 실제 CloudWatch executor/CPU/memory 표본, output file 또는 완전한 EMR billed resource 증적이 없다.
- 장애 시나리오에 실제 주입 여부나 기대 결과 관측값이 없고, terminal fault에 분류된 failure code가 없다.
- 처리량·P95·복구·비용 기준이 아직 `null`이다.

정합성 실패는 증적 부족보다 강한 `failed`다. 입력 누락 또는 설명되지 않은 중복을 비용·처리량 통과로 덮을 수 없다.

## 2. 저장소 구성

| 파일 | 역할 |
|---|---|
| `backend/fixtures/performance/streaming-phase7-plan.json` | 부하 8종, 장애 8종, 실행 환경과 안전 규칙 |
| `backend/fixtures/performance/streaming-slo-profile.draft.json` | 아직 승인되지 않은 staging SLO 초안 |
| `backend/fixtures/performance/streaming-evidence.example.json` | parser/report 계약 검증 전용 예시. 실제 성능 또는 AWS 단가가 아님 |
| `backend/src/streamingPerformance.mjs` | evidence 정규화, 정합성·SLO·비용 판정, Markdown 렌더링 |
| `backend/scripts/run-streaming-load-fault.mjs` | 로컬 opt-in 실행과 AWS evidence template 생성 |
| `backend/scripts/verify-streaming-performance-contract.mjs` | config-only 계약 검증과 실제 report 생성 |
| `backend/scripts/verify-kafka-continuous-soak.mjs` | 고유 topic/Job을 사용하는 로컬 producer·fault·자원 표본 실행기 |

기본 결과 디렉터리인 `backend/tmp/streaming-performance/`는 원본 측정 파일용이다. credential, bootstrap broker 원문, Authorization header, 사용자 원본 데이터는 evidence에 넣지 않는다.

## 3. 부하 시나리오

| ID | 실행 위치 | 확인할 내용 |
|---|---|---|
| `small-steady` | local + AWS | 낮은 지속 입력에서 lag 증가와 과도한 확장이 없는가 |
| `ramp` | AWS | 단계적 입력 증가에 executor가 Application 상한 안에서 증가하는가 |
| `burst` | local + AWS | 순간 burst의 peak lag가 입력 종료 뒤 정상 회복하는가 |
| `backlog` | local + AWS | worker 시작 전 backlog를 목표 시간과 예산 안에 해소하는가 |
| `capacity-cap` | AWS | 최대 자원 상한에서 무한 확장·비용 폭주 없이 안정적으로 처리하는가 |
| `scale-down` | AWS | 입력 감소 후 worker와 비용이 축소되는가 |
| `multi-continuous` | AWS | 여러 Continuous가 admission/FIFO queue 정책대로 동작하는가 |
| `continuous-with-batch` | AWS | Batch와 Continuous Application·quota 격리가 실제 부하에서 유지되는가 |

로컬은 Spark autoscaling과 EMR billed resource를 증명할 수 없다. 따라서 local 실행은 정합성, checkpoint, fault recovery, 기본 tuning 회귀에 사용하고 AWS-only 항목을 통과로 판정하지 않는다.

## 4. 장애 시나리오

| ID | 실행 위치 | 기대 결과 |
|---|---|---|
| `kafka-disconnect` | local + AWS | 연결 복구 후 같은 checkpoint에서 진행하고 누락·중복이 없다 |
| `s3-write-failure` | local + AWS | target/manifest 실패를 성공으로 표시하지 않고 같은 offset을 재시도한다 |
| `schema-quarantine-surge` | local + AWS | quarantine 비율과 schema 근거가 입력 수와 일치한다 |
| `emr-job-failure` | AWS | 원격 state, retry attempt, 복구 시간, 실패 비용이 남는다 |
| `backend-restart` | local + AWS | 같은 Runtime Job ID를 다시 찾고 두 번째 원격 Job을 제출하지 않는다 |
| `checkpoint-permission` | AWS | 명확한 권한 오류로 실패하고 새 checkpoint로 조용히 우회하지 않는다 |
| `invalid-authentication` | AWS | MSK 인증 실패를 분류하고 credential을 기록하지 않는다 |
| `poison-records` | local + AWS | 처리 불가능 레코드는 quarantine으로 설명되고 정상 레코드는 계속 진행한다 |

local fault는 전용 Compose에서만 service pause/restart를 사용한다. 공유 개발 환경이나 운영에서는 실행하지 않는다. AWS 장애 주입은 전용 staging topic/group/prefix와 사전 승인된 IAM 변경 범위에서만 수행한다.

모든 장애 evidence는 `fault.injection`이 `scenarioId`와 같아야 하고 `injected`, `expectedOutcomeObserved`를 명시한다. `emr-job-failure`, `checkpoint-permission`, `invalid-authentication`은 관측한 정규화 failure code도 필요하다. 값이 없으면 `insufficient-evidence`, 주입하지 않았거나 기대 결과를 관측하지 못했으면 `failed`다. `schema-quarantine-surge`와 `poison-records`는 운영 상한인 `maxQuarantineRatio`뿐 아니라 장애가 실제로 발생했음을 보이는 `minQuarantineRatio`도 승인한다.

## 5. P50/P95/P99 지연의 정의

Continuous worker는 각 Kafka 레코드의 broker timestamp를 유지한다. micro-batch의 첫 Spark action에서 timestamp age의 approximate percentile을 `percentile_approx(..., accuracy=10000)`로 count와 함께 계산하고, target data commit까지 걸린 batch duration을 더한다.

```text
end-to-end latency
= target commit 시각 - Kafka record timestamp
```

개별 batch manifest의 `endToEndLatency`는 다음 값을 가진다.

```json
{
  "method": "kafka-record-timestamp-to-target-commit",
  "sampleCount": 1000,
  "timestampMissingCount": 0,
  "p50Ms": 720,
  "p95Ms": 1480,
  "p99Ms": 2050,
  "measuredAt": "2026-07-14T00:00:02Z"
}
```

Runtime은 checkpoint에서 복구한 모든 성공 batch를 중복 없이 합산하고 다음 보수적 summary를 제공한다.

```json
{
  "aggregation": "worst-successful-batch-percentile",
  "method": "kafka-record-timestamp-to-target-commit",
  "batchCount": 24,
  "sampleCount": 100000,
  "timestampMissingCount": 0,
  "p50Ms": 810,
  "p95Ms": 1520,
  "p99Ms": 2140,
  "lastIncludedBatchId": 23,
  "latest": { "p50Ms": 720, "p95Ms": 1480, "p99Ms": 2050 }
}
```

runtime의 각 percentile은 성공 batch별 같은 percentile 중 최댓값이다. 따라서 UI의 `E2E P95 (최악 Batch)`와 evidence의 P95는 전체 레코드를 다시 합쳐 계산한 global P95가 아니라 작은 batch의 급격한 지연도 놓치지 않는 보수적 SLO 지표다.

이 값은 payload 안의 임의 `event_time`이 아니라 Kafka record timestamp를 기준으로 한다. producer가 과거 timestamp를 의도적으로 넣으면 backlog age가 포함된다. timestamp가 미래인 clock-skew 레코드는 0ms로 clamp하고, timestamp가 없는 레코드는 `timestampMissingCount`로 분리한다. `sampleCount + timestampMissingCount`는 consumed count와 같아야 하고 다르면 `failed`다. profile이 latency를 요구할 때 표본, 세 percentile, positive batch count 또는 명시적 aggregation이 없으면 `insufficient-evidence`다.

## 6. 비용 계산

EMR Serverless `GetJobRun`은 다음 값을 제공한다.

- `billedResourceUtilization.vCPUHour`
- `billedResourceUtilization.memoryGBHour`
- `billedResourceUtilization.storageGBHour`
- `totalResourceUtilization`
- `totalExecutionDurationSeconds`

하네스의 비교용 추정 비용은 billed resource와 실행 당시 고정한 region/architecture 단가 snapshot으로 계산한다.

```text
estimated USD
= vCPUHour × vCPU 단가
 + memoryGBHour × memory 단가
 + storageGBHour × storage 단가
 + 명시한 S3/MSK/CloudWatch 등 추가 비용
```

단가는 코드 기본값으로 두지 않는다. evidence의 `priceSnapshot`에 region, architecture, currency, effectiveAt, source URL과 단가를 함께 넣는다. price snapshot region은 evidence와 SLO profile region에 모두 일치해야 한다. billed resource 세 필드는 생략한 값을 0으로 간주하지 않고 모두 명시해야 한다. `streaming-evidence.example.json`의 숫자는 parser 검증용 예시이며 운영 단가가 아니다.

EMR Serverless는 worker 사용량을 vCPU, memory, storage 차원으로 과금하며 worker가 준비된 시점부터 종료까지 초 단위 집계와 1분 최소가 적용된다. S3, MSK, CloudWatch, data transfer는 별도 비용이므로 필요하면 `additionalCostUsd` 또는 Cost Explorer의 `actualCostUsd`로 보완한다.

공식 근거:

- [GetJobRun API](https://docs.aws.amazon.com/emr-serverless/latest/APIReference/API_GetJobRun.html)
- [EMR Serverless CloudWatch metrics](https://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/app-job-metrics.html)
- [Amazon EMR pricing](https://aws.amazon.com/emr/pricing/)

## 7. CloudWatch와 executor 증적

AWS evidence는 1분 period의 `AWS/EMRServerless` Job Worker Metrics를 사용한다. release 7.10 이상에서는 `ApplicationName`과 `JobName` dimension 변경도 함께 확인한다.

필수 수집 후보:

- `WorkerCpuAllocated`, `WorkerCpuUsed`
- `WorkerMemoryAllocated`, `WorkerMemoryUsed`
- `WorkerEphemeralStorageAllocated`, `WorkerEphemeralStorageUsed`
- `RunningWorkerCount`, `TotalWorkerCount`, `IdleWorkerCount`
- application `CPUAllocated`, `MemoryAllocated`, `StorageAllocated`

Evidence에는 원본 전체 CloudWatch 응답 대신 period, executor 표본과 min/max/average, peak CPU/memory, 원본 artifact 위치/checksum을 보존할 수 있다. period 숫자만 입력한 문서는 증적으로 인정하지 않는다. 합계 CPU/memory를 볼 때 AWS 지침대로 statistic `Sum`, period 1분을 사용한다.

## 8. SLO profile 승인 규칙

초안 profile의 threshold `null`은 “제한 없음”이 아니라 “미결정”이다. AWS staging에서 같은 설정으로 최소 3회 실행한 뒤 median과 worst run을 비교해 숫자를 채운다.

반복 실행에서 고정해야 하는 값:

- source revision과 artifact checksum
- 평균 message bytes와 입력 pattern/count/rate
- topic partition 수와 key 분포
- trigger와 `maxOffsetsPerTrigger`
- driver/executor core·memory·disk와 min/initial/max executor
- EMR Application maximum capacity와 scheduler 설정
- target format, partition, small-file threshold
- region, price snapshot, MSK/S3/CloudWatch 조건

하네스는 environment, runtime, scenario, fault injection, workload, tuning을 canonical JSON으로 만든 SHA-256 fingerprint를 비교한다. fingerprint가 다른 실행은 같은 반복군으로 합치지 않고 `failed`로 판정한다.

## 9. Docker/AWS 없이 계약만 검증

```bash
cd backend
npm run verify:streaming-load-plan
npm run verify:streaming-performance-contract
```

첫 명령은 8개 부하·8개 장애 시나리오, local runner mapping, opt-in과 전용 환경 규칙을 검증한다. 두 번째 명령은 정합성 hard gate, 장애 주입/결과, environment/region, 실제 CloudWatch 표본, draft/approved profile, 증적 누락, 비용 계산, configuration drift, redaction, JSON/Markdown 렌더링을 검증한다.

## 10. 로컬 전용 시나리오 실행

먼저 다른 사용자의 Job이 없는 전용 prod-like Compose와 backend, Redpanda, Spark, MinIO가 준비되어 있어야 한다.

```bash
cd backend
ASKLAKE_RUN_STREAMING_LOAD_FAULT=true \
ASKLAKE_STREAMING_TEST_DEDICATED_ENVIRONMENT=true \
npm run streaming:load-fault -- --scenario small-steady
```

backlog 예시:

```bash
ASKLAKE_RUN_STREAMING_LOAD_FAULT=true \
ASKLAKE_STREAMING_TEST_DEDICATED_ENVIRONMENT=true \
ASKLAKE_STREAMING_TEST_COUNT=100000 \
ASKLAKE_STREAMING_TEST_RATE=10000 \
ASKLAKE_STREAMING_TEST_PARTITIONS=12 \
ASKLAKE_STREAMING_TEST_TRIGGER_SECONDS=2 \
ASKLAKE_STREAMING_TEST_MAX_OFFSETS_PER_TRIGGER=5000 \
npm run streaming:load-fault -- --scenario backlog
```

지원 local scenario:

- `small-steady`, `burst`, `backlog`
- `kafka-disconnect`, `s3-write-failure`, `schema-quarantine-surge`, `backend-restart`, `poison-records`

runner는 plan의 `namespacePrefix` 아래 고유 topic과 고유 Job/checkpoint를 만들고 result에 input bytes, tuning, peak/final lag, batch duration, P50/P95/P99, recovery, Docker resource peak, fault 주입·기대 결과를 기록한다. 실패해도 `.failure.json`에 redacted tail을 남긴다. shared topic, checkpoint, target prefix는 자동 삭제하지 않는다.

## 11. AWS staging evidence 준비

AWS-only 시나리오는 이 스크립트가 resource를 만들거나 장애를 주입하지 않는다. 먼저 placeholder template만 생성한다.

```bash
cd backend
npm run streaming:load-fault -- --prepare-aws ramp --run-id ramp-staging-001
```

실행 절차:

1. 전용 staging topic, consumer group, output/checkpoint prefix, Application과 예산을 승인한다.
2. `npm run kafka:msk-probe`로 backend principal의 network/IAM 왕복을 먼저 확인한다.
3. Phase 6 admission 상한과 실제 EMR maximum capacity/scheduler/auto-stop을 확인한다.
4. 입력 fixture와 producer 설정, source revision, artifact checksum을 고정한다.
5. scenario를 실행하고 AskLake runtime/session/batch, EMR `GetJobRun`, CloudWatch, S3 output file 목록을 export한다.
6. template placeholder를 실제 값으로 교체하고 장애 scenario는 주입 여부·기대 결과·필요한 failure code를 채운다. bootstrap broker, role credential, Authorization header는 넣지 않는다.
7. 같은 설정으로 최소 3회 반복한다. 실패 실행도 삭제하지 않고 원인을 남긴다.
8. actual price snapshot과 필요 시 Cost Explorer 값을 기록한다.

## 12. 리포트 생성

```bash
cd backend
npm run streaming:performance-report -- \
  --profile fixtures/performance/streaming-slo-profile.draft.json \
  --evidence tmp/streaming-performance/backlog-staging-001.evidence.json \
  --evidence tmp/streaming-performance/backlog-staging-002.evidence.json \
  --evidence tmp/streaming-performance/backlog-staging-003.evidence.json \
  --run-id backlog-staging-review
```

결과:

- `status=passed`: 모든 정합성·증적·반복·SLO·비용 gate 통과
- `status=failed`: 정합성, threshold 또는 comparable configuration gate 실패. process exit 1
- `status=insufficient-evidence`: 초안/누락/반복 부족. process exit 2

JSON과 Markdown은 기본 `backend/tmp/streaming-performance/`에 함께 생성된다.

## 13. 운영 권장값 확정 방법

운영 권장값은 한 번의 최고 처리량이 아니라 세 조건을 함께 만족하는 안정 구간으로 정한다.

1. steady에서 lag가 장시간 단조 증가하지 않는다.
2. burst/backlog 뒤 final lag 0과 합의한 복구 시간을 만족한다.
3. 최악 micro-batch P95, 정합성, 비용과 Application 상한을 동시에 만족한다.

문서화할 최종 설정:

- topic partition과 key ordering 전제
- min/initial/max executor와 Application maximum capacity
- trigger와 `maxOffsetsPerTrigger`
- 평균/최대 message bytes와 target file size
- 동시 Continuous/Batch slot과 queue timeout
- 최악 micro-batch P95 latency, backlog recovery, quarantine, small-file, 비용 기준
- 세 번 이상 반복한 median/worst evidence 경로와 승인자/승인 시각

partition보다 executor가 많아도 Kafka read 병렬성이 증가하지 않을 수 있다. 반대로 partition만 늘리면 Spark, S3, network 병목을 해결하지 못한다. 변경은 한 축씩 하고 같은 evidence 계약으로 전후를 비교한다.

## 14. 현재 완료와 남은 외부 승인

저장소 기준 완료:

- 시나리오·안전 게이트·evidence·SLO profile versioning
- 정합성 hard gate와 `insufficient-evidence` 판정
- environment/region, 장애 주입/기대 결과/failure code gate
- P50/P95/P99 runtime 계측과 Job 상세 표시
- 완전한 billed resource와 같은 region 단가 기반 비용 산정, 실제 비용 선택 입력
- local opt-in runner, AWS template, JSON/Markdown report
- config-only 회귀 테스트와 관련 계약 문서

배포 환경에서 남은 항목:

- 실제 VPC/MSK/EMR/S3 부하·장애 실행
- CloudWatch/Cost Explorer export
- 같은 설정 최소 3회 evidence
- SLO 숫자, 운영 권장 tuning, 테스트 예산 승인

이 외부 항목이 끝나기 전에는 “100만 건/초 보장”, “P95 1초 보장” 또는 “운영 Runtime 전환 완료”라고 표현하지 않는다. 목표 미달이면 runtime 기본값을 바꾸지 않고 Kafka, Spark, storage, network 병목으로 나눠 후속 이슈를 만든다.
