# Spark Resource Planner Contract

## 목적과 범위

Spark Resource Planner 1단계는 batch Run을 제출하기 전에 입력 크기를 추정하고,
그 Run에 사용할 초기 executor 수를 결정한다. 실행 중 executor를 늘리거나 줄이는
Spark Dynamic Allocation은 이 계약의 범위가 아니다.

`shadow`는 권장 executor 수를 계산하고 Run과 SparkApplication identity에
기록하지만 실제 `spec.executor.instances`에는 기존 고정값을 적용한다. `enforce`는
승인된 실험에서만 권장값을 적용한다.

첫 버전의 입력 크기 근거는 File/S3 단일 object의 실행 직전
`HEAD ContentLength`와 Prefix 선택 시 저장된 `__Source Total Bytes` snapshot이다.
근거가 없거나 metadata 조회가 실패하면 `input_size_unavailable`로 기록하고
기존 executor 수를 유지한다. Kafka와 Iceberg 추정은 후속 범위다.

## 계산 정책

```text
estimatedPartitions = ceil(inputBytes / 128 MiB)
calculatedExecutors = ceil(estimatedPartitions / 96)
recommendedExecutors = clamp(calculatedExecutors, minExecutors, maxExecutors)
```

기본값은 `minExecutors=1`, `maxExecutors=6`이다. `shadow`에서는
`appliedExecutors`가 기존 `ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES`와 같고,
`enforce`에서만 `recommendedExecutors`와 같아진다.

## Run 소유권과 재시도

Resource Plan의 source of truth는 RDS
`etl_runs.taskStates.sparkExecution.resourcePlan`이다. 최초 SparkApplication 제출
전에 저장하고 같은 `runId`의 lease takeover와 terminal attempt generation retry는
저장된 Plan을 재사용한다.

SparkApplication은 `asklake.io/resource-plan-hash`,
`asklake.io/resource-plan-mode`, `asklake.io/calculated-executors`,
`asklake.io/applied-executors` annotation을 기록한다. 복구 시 run, job, image,
attempt generation과 함께 Plan hash가 일치해야 한다. 불일치는 replacement를
만들지 않고 identity mismatch로 실패한다.

Planner 배포 전에 `kubernetesExecution`은 있지만 Resource Plan은 없는 Run은
legacy identity 그대로 복구하며 새 Plan을 소급 계산하지 않는다.

## 상태 예시

```json
{
  "policyVersion": 1,
  "mode": "shadow",
  "inputBytes": 97079116733,
  "inputFileCount": 1,
  "inputSizeSource": "s3_head",
  "targetPartitionBytes": 134217728,
  "targetPartitionsPerExecutor": 96,
  "estimatedPartitions": 724,
  "calculatedExecutors": 8,
  "recommendedExecutors": 6,
  "baselineExecutors": 1,
  "appliedExecutors": 1,
  "minExecutors": 1,
  "maxExecutors": 6,
  "reason": "capped_by_max_executors",
  "planHash": "<canonical-sha256>"
}
```

## 불변조건과 검증 순서

- `shadow`는 기존 executor 수를 바꾸지 않는다.
- `enforce`의 적용값은 1~6 범위를 벗어나지 않는다.
- 동일 Run의 Plan과 hash는 retry와 takeover에서 바뀌지 않는다.
- Plan에는 bucket, object key, endpoint, credential을 기록하지 않는다.
- metadata 조회 실패는 기존 source identity 검증을 숨기지 않는다.

검증은 단위·identity·Helm 계약, EKS 10/100 GB shadow, 별도 승인된 100 GB
executor 1/4/6 순서로 진행한다.
