# EKS 100GB Spark Resource Planner Live Evidence — 2026-07-21

## 현재 판정

Resource Planner V3 `history-sla-cost-v1`의 dev EKS 기술 MVP는 통과했다. 같은
immutable Backend/Spark image와 `standard-v1` executor profile에서 10GB Shadow,
100GB Shadow, 100GB Enforce를 순서대로 실행했다. 모든 Run은 RDS Plan,
SparkApplication annotation/spec, Kubernetes execution hash, Spark 결과와 Catalog가
일치했다.

100GB에서 Planner는 과거 성공 이력과 30분 SLA를 사용해 후보 `1, 2, 4` 중
executor `2`를 선택했다. Shadow에서는 실제 executor를 `1`로 유지했고, Enforce에서는
같은 결정을 실제 executor `2`로 적용했다. EKS Auto Mode는 두 번째 executor가
Pending이 된 뒤 46초 안에 Spark node를 추가해 두 executor를 모두 Running으로
전환했다.

실험 종료 뒤 Planner는 `off`, baseline executor는 `1`로 복구했다. FastAPI `2/2`,
Collector `1/1`, ALB target `4/4` healthy, draining `0`, Backend/RDS health, active
SparkApplication/Pod/Pending `0`을 확인했다.

## 실행 결과

식별 가능한 Job/Run/Application/bucket/image 원문은 tracked 문서에 기록하지 않는다.
원본 RDS/Kubernetes/CloudWatch 증거와 공식 shadow evidence는 저장소 밖 mode `0600`
파일로 보존했고, `verify-eks-spark-resource-planner-shadow-evidence.mjs` 검증을
통과했다.

| Run | 입력 | mode | 계산/권장/적용 | 실제 peak executor | Spark duration | 전체 wall-clock | Pending·node | 결과 | NAT bytes (각 방향) |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | ---: |
| 10GB Shadow | `9,235,015,833 bytes`, 1 file | `shadow` | `1 / 1 / 1` | 1 | `194.347s` | `258.434s` | cold start 약 `61s` | `29,544,766`행 일치, Catalog 성공 | `7,282,752` |
| 100GB Shadow | `97,079,116,733 bytes`, 1 file | `shadow` | `2 / 2 / 1` | 1 | `2,291.179s` | `2,312.993s` | Pending 0, Spark node 1 | `310,578,707`행 일치, Catalog 성공 | `33,811,407` |
| 100GB Enforce | `97,079,116,733 bytes`, 1 file | `enforce` | `2 / 2 / 2` | 2 | `1,502.374s` | `1,572.509s` | second executor `46s`, node `1→2` | `310,578,707`행 일치, Catalog 성공 | `26,531,388` |

세 Run 모두 `inputSizeSource=s3_head`, result marker, query-engine verification,
run-scoped staging cleanup과 새 Iceberg snapshot을 확인했다. 100GB 두 회차는 같은
schema, output file `91`개, 입력/출력 `310,578,707`행을 유지했다. 다른 사용자의
active Spark 작업은 모든 관찰 표본에서 `0`이었다.

S3 Gateway Endpoint는 전체 실험 전후 `available`이었고 EKS private route table
2개에 S3 prefix-list route가 유지됐다. 두 route table의 기존 NAT default route와
single NAT Gateway도 유지됐다. 97GB S3 read/write가 NAT를 통과했다면 나타나야 할
대용량 바이트와 달리, 실행 창의 NAT `BytesInFromDestination`과
`BytesOutToSource` 합은 각 약 26.5~33.8MB였다. 따라서 대용량 S3 경로는 Gateway
Endpoint를 사용했다고 판정한다.

## 시간·비용 판정

| 지표 | executor 1 Shadow | executor 2 Enforce | 변화 |
| --- | ---: | ---: | ---: |
| Spark duration | `2,291.179s` | `1,502.374s` | `-34.4%` |
| 전체 wall-clock | `2,312.993s` | `1,572.509s` | `-32.0%` |
| 30분 SLA | 실패 | 통과 | `297.626s` 여유 |
| executor-seconds | `2,291.179` | `3,004.748` | `+31.1%` |
| 정규화 compute cost proxy | `1.000` | `1.311` | `+31.1%` |

executor `2`는 절대 compute 사용량이 가장 작은 선택은 아니다. executor `1`보다
compute proxy가 31.1% 늘지만 30분 SLA를 충족한다. Enforce Plan은 같은 이력으로
executor `1`은 SLA 실패, `2`와 `4`는 SLA 통과로 추정했고, SLA 통과 후보 중
executor-seconds가 더 작은 `2`를 선택했다. 이것이 "가장 빠른 executor 수"가
아니라 "SLA를 만족하는 후보 중 비용 효율적인 executor 수"라는 MVP 목표와
일치한다.

기존 executor `4` 실험은 100GB 입력과 resource shape은 같지만 현재 공식 image와
revision이 달라 공식 1↔2 비교에는 재사용하지 않았다. executor `2`가 이미 SLA를
통과했으므로 MVP 판정을 위해 새 4-executor 100GB Run을 추가하지 않았다.

## 관측 범위와 한계

100GB 두 회차의 driver log에는 완료 task log `1,007`개, task-set `14`개가 동일하게
남았고 OOM, severity error, spill log marker는 `0`이었다. 실제 분할은
`materializationFileCount=724`, `sqlShufflePartitions=32`로 확인했다.

다만 dev cluster에는 Kubernetes Pod Metrics API가 없고 CloudWatch
`ContainerInsights` Pod metric도 발행되지 않았다. Spark event log도 활성화되어 있지
않아 다음 값은 이번 MVP의 객관적 수치로 주장하지 않는다.

- executor CPU·memory 사용률과 throttling
- shuffle read/write byte
- memory/disk spill byte
- 같은 조건 반복 실행의 분산과 p50/p95
- AWS Cost Explorer에 반영된 회차별 실제 달러 비용

driver log의 spill marker `0`은 보조 증거일 뿐 spill byte `0`을 뜻하지 않는다.

## MVP 완료 조건 판정

1. **Resource Planner 기술 MVP:** 완료. 실제 S3 metadata와 성공 이력을 읽어
   RDS Plan을 만들고, canonical hash를 SparkApplication과 실행 결과까지 전달했다.
2. **동적 적용:** 완료. 100GB에서 `recommended=2`, `applied=2`, spec/실제 executor
   `2`가 일치했고 Auto Mode node scale-out도 완료됐다.
3. **비용·시간 타당성:** 30분 SLA가 목표라면 executor `2`가 타당하다. 시간은
   34.4% 줄고 compute proxy는 31.1% 늘었다. SLA가 없다면 executor `1`이 더 싸다.
4. **현재 정책:** 후보 `1,2,4`, 목표 `1,800s`, `standard-v1`, mode 기본 `off`를
   유지한다. 운영 Enforce 상시 활성화는 별도 운영 승인 범위다.
5. **후속 범위:** Pod CPU/memory와 Spark event log 계측, 같은 조건 반복 통계,
   실제 비용 귀속, 동시 Job admission 정책, 사용자 SLA/비용 preference, workload
   profile별 history 분리를 추가한다.

현재 V3은 매 Run마다 bounded 성공 이력을 다시 평가하는 피드백 기반 planner지만,
별도 ML 모델을 학습하는 자동 학습 시스템은 아니다. 반복 통계와 모델 calibration은
다음 단계다.
