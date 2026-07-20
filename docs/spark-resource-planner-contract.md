# Spark Resource Planner V1 Contract

## 목표와 범위

Resource Planner V1은 batch Run을 제출하기 전에 입력 크기를 확인하고, 고정된
`standard-v1` executor profile에서 사용할 초기 executor 수를 `1`, `2`, `4` 중
하나로 결정한다. 목표는 가장 빠른 구성이 아니라, 현재 확보한 실행 근거 안에서
30분 완료 목표를 만족할 것으로 예상되는 최소 후보를 선택하는 것이다.

이 계약에서 바꾸는 것은 executor **수**뿐이다. executor 한 개의 CPU·memory는
다음 값으로 고정한다.

| field | `standard-v1` |
| --- | ---: |
| Spark executor cores | `2` |
| CPU request | `2` |
| CPU limit | `3` |
| JVM heap | `4g` |
| memory overhead | `1g` |
| Pod memory 합계 | `5Gi` |

Spark Dynamic Allocation처럼 실행 중 executor 수를 변경하는 기능, 여러 동시 Job의
전역 용량 최적화, 실행 결과를 이용한 자동 학습, 사용자별 executor profile 선택은
V1 범위가 아니다. EKS Auto Mode는 Planner가 만든 Pod 요청을 수용하도록 Node를
늘리거나 줄일 뿐, 입력 데이터를 보고 executor 수를 결정하지 않는다.

## 모드와 입력 근거

- `off`: Resource Plan을 새로 계산·저장하지 않고 기존 고정 executor 수를 적용한다.
- `shadow`: 권장값과 근거를 기록하지만 실제 executor 수는 기존 고정값을 유지한다.
- `enforce`: `planned` 결정에만 권장값을 적용한다. fallback에서는 기존 값을 유지한다.

첫 버전의 입력 근거는 File/S3 단일 object의 실행 직전 `HEAD ContentLength`와
Prefix 선택 시 저장된 `__Source Total Bytes` snapshot이다. 근거가 없거나 metadata
조회가 실패하면 `input_size_unavailable` fallback으로 기록한다. Kafka와 Iceberg
입력 추정은 후속 범위다.

실행 시점의 executor profile이 `standard-v1`과 다르면
`executor_profile_unsupported` fallback으로 기록한다. 따라서 `enforce`여도 검증되지
않은 CPU·memory 조합에 Planner 결정을 적용하지 않는다.

## `balanced-v1` 계산 정책

```text
estimatedPartitions = max(1, ceil(inputBytes / 128 MiB))
calculatedExecutors = max(1, ceil(estimatedPartitions / 384))
recommendedExecutors =
  calculatedExecutors 이상인 가장 작은 후보(1, 2, 4)
  단, 4를 넘으면 4로 제한
```

`384 partitions/executor`는 현재 100GB 기준 실행의 724개 partition을 executor 2개로
배치하는 V1 seed 정책이다. 즉 이 수식은 보편적인 Spark 최적값이 아니라, 고정
`standard-v1` profile과 현재 reference workload에 대한 검증 시작점이다.

기본 후보는 `1`, `2`, `4`, 최소값은 `1`, 최대값은 `4`다. 예를 들어 계산값이
`3`이면 후보 `4`로 올림한다. `shadow`의 `appliedExecutors`는 기존
`ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES`와 같고, `enforce`의 정상 결정에서만
`recommendedExecutors`와 같아진다.

Live EKS에서는 `asklake-runtime-config` release가 Planner 정책,
`ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES`와 Spark runtime digest를 소유한다.
Backend/Collector image는 `asklake-web` release가 소유한다. 두 release를 같은 승인
revision의 image receipt에 맞춘 뒤에만 새 Run을 제출한다.

## Run 소유권과 재시도

Resource Plan의 source of truth는 RDS
`etl_runs.taskStates.sparkExecution.resourcePlan`이다. 최초 SparkApplication 제출
전에 저장하고 같은 `runId`의 lease takeover와 terminal attempt generation retry는
저장된 Plan을 재사용한다.

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
실패한다.

Planner 배포 전에 `kubernetesExecution`은 있지만 Resource Plan은 없는 Run은 legacy
identity 그대로 복구하며 새 Plan을 소급 계산하지 않는다. 이미 저장된 policy V1
Plan은 기존 hash와 의미를 유지한 채 복구할 수 있지만, 새 Run은 policy V2만 만든다.

## 상태 예시

실제 100GB reference object의 크기 `97,079,116,733 bytes`를 shadow로 계산한 예다.

```json
{
  "policyVersion": 2,
  "policyName": "balanced-v1",
  "policyTargetCompletionSeconds": 1800,
  "mode": "shadow",
  "decisionStatus": "planned",
  "inputBytes": 97079116733,
  "inputFileCount": 1,
  "inputSizeSource": "s3_head",
  "targetPartitionBytes": 134217728,
  "targetPartitionsPerExecutor": 384,
  "executorCandidates": [1, 2, 4],
  "executorProfileName": "standard-v1",
  "executorCores": 2,
  "executorCpuRequest": "2",
  "executorCpuLimit": "3",
  "executorMemory": "4g",
  "executorMemoryOverhead": "1g",
  "estimatedPartitions": 724,
  "calculatedExecutors": 2,
  "recommendedExecutors": 2,
  "baselineExecutors": 1,
  "appliedExecutors": 1,
  "minExecutors": 1,
  "maxExecutors": 4,
  "reason": "balanced_partition_budget",
  "planHash": "<canonical-sha256>"
}
```

## 불변조건과 검증 순서

- `shadow`는 기존 executor 수를 바꾸지 않는다.
- `enforce`는 `planned + standard-v1`에서만 후보 `1`, `2`, `4` 중 하나를 적용한다.
- 입력 크기를 모르거나 profile이 다르면 기존 executor 수를 유지한다.
- 동일 Run의 Plan과 hash는 retry와 takeover에서 바뀌지 않는다.
- Plan에는 bucket, object key, endpoint, credential을 기록하지 않는다.
- metadata 조회 실패는 기존 source identity 검증을 숨기지 않는다.
- `off → shadow → enforce` 승격은 별도 EKS 실행 승인과 관측 증거가 필요하다.

Phase 1·2의 로컬 완료 조건은 pure planner, 입력 metadata fallback, persistence,
retry/takeover, SparkApplication identity, Helm schema와 회귀 테스트 통과다.
Live 검증은 10/100GB shadow 뒤 10GB executor 1, 100GB executor 2 순서로 별도
진행한다. 후보 4는 2개로 목표를 만족하지 못한다는 근거가 생길 때만 후속 검증한다.
