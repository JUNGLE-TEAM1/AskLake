# EKS Spark Resource Planner Phase 7 관측 계약

## 목표와 현재 상태

Phase 7의 목표는 executor 선택을 바꾸는 것이 아니라, 같은 실행에서 다음 근거를
객관적으로 수집하는 것이다.

- executor/driver Pod CPU·memory 현재값과 최대값
- task 수, executor runtime과 task CPU time
- input/output, shuffle read/write byte와 record
- memory/disk spill byte
- executor peak 수와 event log에 기록된 peak memory metric

2026-07-21 read-only 진단에서 dev의 Metrics Server와 CloudWatch Observability add-on은
모두 `ACTIVE`이고 관련 Pod도 Ready였다. Metrics API discovery도 성공했다. 기존
관찰자에게 `pods.metrics.k8s.io` list가 거부됐고 CloudWatch Container Insights
namespace에는 최근 metric이 없었다. 따라서 이번 변경은 CloudWatch가 나중에
회복되기를 기다리지 않고 Metrics Server current sample과 Spark event log를 권위 있는
실험 증거로 사용한다. CloudWatch 발행 0건 원인은 별도 운영 진단으로 남긴다.

dev Terraform state에는 기존 100GB 실험에서 적용한 `benchmark-observer` IAM role,
EKS access entry와 exact-prefix S3 request metric이 이미 있다. 이번 변경은 이 리소스를
새 이름으로 중복 생성하지 않고 기존 Terraform 계약을 보존·재사용한다. namespace RBAC,
event log runtime flag는 dev에 아직 적용하지 않았고 10GB smoke도 실행하지 않았다.

2026-07-21 server dry-run은 Foundation에 Role/RoleBinding 각 1개만 추가되고 삭제가
없음을 확인했다. 실제 upgrade는 현재 운영자에게 RBAC 재위임 권한이 없어 API server가
거부했다. Helm 4의 server-side rollback도 변경 없는 Namespace patch 권한에서 실패해
release revision이 잠시 `failed`가 됐지만, observer를 `false`로 고정한 client-side
upgrade로 revision 9 `deployed`를 복구했다. observer 객체는 0개이고 기존 Deployment는
13/13 Ready, active Spark workload는 0이다. 임시 cluster-admin 승격은 하지 않았다.

기존 endpoint/observer/S3 metric filter만 지정한 Terraform targeted plan은 `No changes`다.
전체 plan에는 Phase 7과 무관한 ECR/Realtime source-state drift가 있어 apply하지 않는다.
따라서 다음 live gate는 기존 cluster-admin principal이 Foundation RBAC 두 객체를 적용한
뒤 `benchmark-observer`로 Metrics API positive/negative 권한을 검증하는 것이다.

## 입력과 출력

입력은 Planner `off`, baseline executor `1`, 공식 Backend/Spark image, 기존 AWS Output
bucket/prefix를 사용하는 10GB bounded Run이다. 출력은 다음 세 private artifact다.

1. `watch-eks-day17-scale.mjs --record`의 mode `0600` aggregate JSONL
2. Output 경로의 uncompressed Spark event log
3. `summarize-spark-event-log.mjs`가 만든 mode `0600` summary JSON

tracked 문서에는 aggregate 판정만 남기고 Run/Job/Application/bucket/role ARN과 원본
event는 넣지 않는다.

## 권한과 상태 소유권

Terraform의 기존 `benchmark_observability_reader_enabled` 계약은 CloudWatch add-on용
쓰기 role과 별개인 `asklake-<env>-benchmark-observer` role을 소유한다. 이 role은
CloudWatch metric, EKS/EC2 inventory와 exact S3 metric configuration read만 허용한다.
EKS access entry는 role을 `asklake:observability-readers` group에 연결한다. operator
identity와 실험 prefix는 Git 제외 private override var file에만 둔다.

Foundation chart의 namespace Role은 `asklake-dev`에서 Pod/log/Event/Deployment/HPA/
SparkApplication read와 `pods.metrics.k8s.io` read만 허용한다. Secret, mutation verb,
cluster-wide Node/Event와 다른 namespace는 허용하지 않는다. 권위 있는 current
utilization source는 Metrics Server이고, JSONL은 해당 실행의 보존 증거다.

## Spark event log 경계

기본 runtime은 다음과 같다.

```text
ASKLAKE_SPARK_EVENT_LOG_ENABLED=false
ASKLAKE_SPARK_EVENT_LOG_PREFIX=spark-events
```

enable 시 SparkApplication에는 다음 conf가 추가된다.

```text
spark.eventLog.enabled=true
spark.eventLog.compress=false
spark.eventLog.logStageExecutorMetrics=true
spark.executor.processTreeMetrics.enabled=true
spark.eventLog.dir=s3a://<output-bucket>/<output-prefix>/spark-events/<sha256(runId)>/
```

Output bucket/prefix의 기존 Spark write boundary 아래에 있으므로 새 bucket이나 Gateway
Endpoint를 만들지 않는다. 원본 runId를 key에 사용하지 않는다. 압축을 끄는 이유는
bounded MVP에서 별도 codec 없이 line-delimited event를 검증하기 위해서다. 10GB 크기의
실제 event log 용량을 확인한 뒤 100GB 또는 반복 실험 전 압축·retention을 재검토한다.

## 성공·실패와 복구

성공 조건은 다음과 같다.

- observer role로 Pod Metrics API 조회 성공
- 10GB Run 동안 Spark Pod sample이 한 건 이상이고 CPU·memory 값이 null이 아님
- event log에 ApplicationStart/End, TaskEnd가 있으며 invalid line이 없음
- summary task 수가 driver log/실행 결과와 설명 가능한 범위로 일치
- shuffle/spill은 측정값을 그대로 기록하고 관찰되지 않은 값을 추정하지 않음
- Spark 결과/Catalog/S3/NAT 우회와 기존 서비스 health가 유지됨

event log 경로/권한 오류로 Spark가 시작하지 못하거나 Metrics sample이 계속 forbidden이면
10GB 이후 유료 실험을 중단한다. runtime flag를 `false`로 복구하고 우리 실행이 만든
SparkApplication/Pod만 정리한다. 다른 사용자의 resource와 기존 evidence는 변경하지
않는다. 동일 logical Run의 재시도는 같은 hash prefix에 복수 event log를 남길 수 있으므로
서로 다른 attempt 파일을 합산하지 않고 성공 application의 파일을 별도로 판정한다.

## 검증 명령

```bash
node --test backend/scripts/spark-kubernetes-client.test.mjs \
  scripts/test-eks-spark-event-log-values.mjs \
  scripts/test-spark-event-log-summary.mjs \
  scripts/test-eks-day17-scale-observer.mjs

bash scripts/verify-eks-foundation.sh
bash scripts/verify-eks-workloads.sh
```

실환경에서는 Terraform plan과 Foundation/runtime Helm server dry-run에서 예상한 reader
resource와 RBAC/event-log key 외 mutation이 없음을 먼저 확인한다. apply 뒤 observer
role kubeconfig로 Metrics API를 한 번 조회하고, 그 뒤에만 10GB bounded smoke를 실행한다.

## 아직 남은 범위

- cluster-admin principal에 의한 namespace observer Role/RoleBinding 적용
- 공식 Backend image 전달과 10GB bounded event-log smoke
- CloudWatch Container Insights metric 미발행 원인과 장기 history
- event log 자동 lifecycle/retention과 Spark History Server
- 같은 조건 반복 실행의 p50/p95
- Cost Explorer 실제 금액 귀속
- 동시 Job별 metric attribution
