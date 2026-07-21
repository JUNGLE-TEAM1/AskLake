# Spark Resource Planner V1 Contract

## 목표와 범위

Resource Planner V1은 batch Run을 제출하기 전에 입력 크기와 같은 Job의 성공 이력을
확인하고, 고정된 `standard-v1` executor profile에서 사용할 초기 executor 수를
`1`, `2`, `4` 중 하나로 결정한다. 목표는 가장 빠른 구성이 아니라 30분 완료 목표를
만족할 것으로 예상되는 후보 중 `executor-seconds`가 가장 작은 후보를 선택하는 것이다.

이 계약에서 바꾸는 것은 executor **수**뿐이다.

| field | `standard-v1` |
| --- | ---: |
| Spark executor cores | `2` |
| CPU request | `2` |
| CPU limit | `3` |
| JVM heap | `4g` |
| memory overhead | `1g` |
| Pod memory 합계 | `5Gi` |

Spark Dynamic Allocation처럼 실행 중 executor 수를 변경하는 기능, 여러 동시 Job의
전역 용량 최적화, executor profile 선택과 통계 모델 자동 학습은 V1 범위가 아니다.
EKS Auto Mode는 Planner가 만든 Pod 요청을 수용하도록 Node를 늘리거나 줄일 뿐,
입력 데이터나 실행 이력을 보고 executor 수를 결정하지 않는다.

## 모드와 입력 근거

- `off`: Resource Plan을 새로 계산·저장하지 않고 기존 고정 executor 수를 적용한다.
- `shadow`: 권장값과 근거를 기록하지만 실제 executor 수는 기존 고정값을 유지한다.
- `enforce`: `planned` 결정에만 권장값을 적용한다. fallback에서는 기존 값을 유지한다.

입력 크기는 File/S3 단일 object의 실행 직전 `HEAD ContentLength`와 Prefix 선택 시
저장된 `__Source Total Bytes` snapshot을 사용한다. 근거가 없거나 metadata 조회가
실패하면 `input_size_unavailable` fallback으로 기록한다. Kafka와 Iceberg 입력 추정은
후속 범위다.

AWS native S3의 `HEAD`는 `AWS_REGION`과 workload identity/default credential chain을
사용하며 Source에 custom endpoint를 저장하지 않는다. MinIO 등 Source가 custom
endpoint를 명시한 경우에만 endpoint allowlist를 요구한다. 두 경로 모두 bucket
allowlist를 통과해야 하며 Plan에는 bucket, key, endpoint와 credential을 저장하지 않는다.

실행 시점 executor profile이 `standard-v1`과 다르면
`executor_profile_unsupported` fallback으로 기록한다. 따라서 `enforce`여도 검증되지
않은 CPU·memory 조합에 Planner 결정을 적용하지 않는다.

## 같은 Job의 실행 이력

Planner는 RDS `etl_runs`에서 현재 Run과 같은 `job_id`의 최근 Run을 최대 100개까지
bounded scan하고, 그중 최대 20개의 비교 가능한 관측값만 사용한다. 다음 조건을 모두
만족해야 한다.

- Run과 `sparkResult`가 모두 `success`
- 저장된 Resource Plan hash가 유효하고 executor profile이 `standard-v1`
- `sparkResult.inputBytes`와 Plan `inputBytes`가 일치
- `sparkResources.executorInstances`와 Plan `appliedExecutors`가 일치
- executor cores가 `2`이고 후보 수가 `1`, `2`, `4` 중 하나
- `durationMs`와 입력 바이트가 양수
- 현재 입력 크기가 관측 입력의 `0.5x..2.0x` 범위

다른 Job은 규칙·partition·출력 경로 복잡도가 다를 수 있으므로 V1에서 근거로 섞지
않는다. 실패, 부분 결과, profile drift, executor 수 불일치와 손상된 Plan은 조용히
제외하며 현재 Run의 제출 계약을 약화시키지 않는다.

## `history-sla-cost-v1` 계산 정책

입력 크기 seed는 기존 partition budget을 유지한다.

```text
estimatedPartitions = max(1, ceil(inputBytes / 128 MiB))
calculatedExecutors = max(1, ceil(estimatedPartitions / 384))
sizeSeed = calculatedExecutors 이상인 가장 작은 후보(1, 2, 4), 최대 4
```

비교 가능한 이력이 있으면 후보마다 다음 값을 계산한다.

```text
sizeNormalizedDuration = observedDuration × currentInputBytes / observedInputBytes

같은 executor 수의 관측이 있으면:
  estimatedDuration = 중앙값(sizeNormalizedDuration)

같은 executor 수의 관측이 없으면:
  estimatedDuration = 중앙값(
    sizeNormalizedDuration × (observedExecutors / candidateExecutors)^0.8
  )

estimatedExecutorSeconds = candidateExecutors × estimatedDurationSeconds
```

30분을 만족하는 후보가 있으면 `estimatedExecutorSeconds`가 가장 작고, 동률이면
executor 수가 작은 후보를 선택한다. 모든 후보가 30분을 넘으면 bounded best-effort로
후보 `4`를 선택한다. 비교 가능한 이력이 없으면 `sizeSeed`를 사용한다.

Plan은 판단을 설명할 수 있도록 다음을 함께 저장한다.

- `decisionBasis`: `history_sla_cost`, `size_seed`, `fallback`
- `historyEvidenceCount`, `historyComparableCount`, bounded `historyRunIds`
- 후보별 `estimatedDurationMs`, `estimatedExecutorSeconds`, `meetsTarget`
- `estimateSource`: `measured`, `modeled`, `unavailable`
- `costProxy=executor_seconds`, `slaMetric=spark_duration_ms`
- `modelScalingExponent=0.8`

`executor-seconds`는 executor compute 상대량을 비교하는 V1 proxy다. driver, Pod Pending,
Node scale-out, EBS, S3 요청과 Spot 가격 변동을 포함한 실제 청구액은 아니다. SLA도 현재
persisted `sparkResult.durationMs`를 사용하므로 제출 전 대기와 Node scale-out을 포함한
전체 wall-clock SLA는 후속 관측 확장 대상이다.

## 실행 증거가 쌓일 때의 동작

새 성공 Run이 RDS에 쌓이면 다음 **새 Run**부터 같은 계산이 최신 관측값을 포함한다.
모델 파라미터를 비동기로 학습하거나 기존 Plan을 다시 쓰지 않는다. 즉 V1의 피드백은
새 실행 이력을 입력으로 사용하는 deterministic 재평가이며, 온라인 ML 학습은 아니다.

2026-07-20의 동일 100GB 입력과 `standard-v1` profile을 정규화한 로컬 backtest는 다음과
같다. 이 fixture는 테스트 근거이며 production RDS에 seed로 넣지 않는다.

| executors | Spark duration | executor-seconds | 30분 목표 |
| ---: | ---: | ---: | --- |
| 1 | 2,654.186s | 2,654.186 | 실패 |
| 2 | 1,564.800s | 3,129.600 | 통과 |
| 4 | 1,091.474s | 4,365.896 | 통과 |

따라서 이 근거에서는 가장 빠른 `4`가 아니라 SLA를 만족하는 최소 비용 후보 `2`를
선택한다. 정규화 fixture는
`backend/benchmarks/spark-resource-planner/reference-100gb.v1.json`에 있다.

## Run 소유권과 재시도

Resource Plan의 source of truth는 RDS
`etl_runs.taskStates.sparkExecution.resourcePlan`이다. 최초 SparkApplication 제출 전에
저장하고 같은 `runId`의 lease takeover와 terminal attempt generation retry는 저장된
Plan을 재사용한다. retry 시 최신 이력을 다시 읽어 결정이 바뀌지 않는다.

SparkApplication은 다음 annotation을 기록한다.

- `asklake.io/resource-plan-hash`
- `asklake.io/resource-plan-mode`
- `asklake.io/resource-policy`
- `asklake.io/executor-profile`
- `asklake.io/calculated-executors`
- `asklake.io/recommended-executors`
- `asklake.io/applied-executors`

복구 시 run, job, image, attempt generation과 함께 Plan hash와 실제 executor profile이
일치해야 한다. 불일치는 replacement를 만들지 않고 identity/configuration mismatch로
실패한다. nested 후보 평가까지 canonical SHA-256에 포함한다.

Planner 배포 전에 `kubernetesExecution`은 있지만 Resource Plan은 없는 Run은 legacy
identity 그대로 복구하며 새 Plan을 소급 계산하지 않는다. 저장된 policy V1/V2 Plan은
기존 hash와 의미를 유지한 채 복구하고, 새 Run만 policy V3를 만든다.

## 상태 예시

동일 Job의 100GB executor-1 성공 이력이 한 건 있고 mode가 `shadow`인 예다.

```json
{
  "policyVersion": 3,
  "policyName": "history-sla-cost-v1",
  "policyTargetCompletionSeconds": 1800,
  "mode": "shadow",
  "decisionStatus": "planned",
  "decisionBasis": "history_sla_cost",
  "inputBytes": 97079116733,
  "inputFileCount": 1,
  "inputSizeSource": "s3_head",
  "estimatedPartitions": 724,
  "calculatedExecutors": 2,
  "recommendedExecutors": 2,
  "baselineExecutors": 1,
  "appliedExecutors": 1,
  "executorCandidates": [1, 2, 4],
  "historyEvidenceCount": 1,
  "historyComparableCount": 1,
  "historyRunIds": ["<persisted-run-id>"],
  "costProxy": "executor_seconds",
  "slaMetric": "spark_duration_ms",
  "reason": "history_min_cost_meets_sla",
  "planHash": "<canonical-sha256>"
}
```

## 불변조건과 검증 순서

- `shadow`는 기존 executor 수를 바꾸지 않는다.
- `enforce`는 `planned + standard-v1`에서만 후보 `1`, `2`, `4` 중 하나를 적용한다.
- 입력 크기를 모르거나 profile이 다르면 기존 executor 수를 유지한다.
- 같은 Job의 성공·정합성 통과 이력만 사용하고 다른 Job의 결과는 섞지 않는다.
- 동일 Run의 Plan과 hash는 retry와 takeover에서 바뀌지 않는다.
- Plan에는 bucket, object key, endpoint와 credential을 기록하지 않는다.
- metadata 조회 실패는 기존 source identity 검증을 숨기지 않는다.
- `off → shadow → enforce` 승격은 같은 immutable image의 EKS 실행 승인과 관측 증거가
  필요하다.

로컬 완료 조건은 pure planner, history filter/backtest, 입력 metadata fallback,
persistence, retry/takeover, nested Plan hash, SparkApplication identity, Helm schema와
회귀 테스트 통과다. Live 검증은 10GB Shadow 뒤 동일 image의 100GB Shadow와
executor-2 Enforce canary를 순서대로 수행하고 마지막에 `off/1`로 복구한다.
