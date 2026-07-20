# EKS 100 GB Spark Resource Planner Pre-live Evidence — 2026-07-20

## 현재 판정

실제 S3 object metadata는 이미 read-only로 확인했으며, policy V2 `balanced-v1`의
로컬 계산·계약 검증에 그 값을 재사용한다. Live EKS shadow/enforce 실행은 아직
증거가 없으므로 이 문서는 적용 완료를 주장하지 않는다.

Phase 3의 private 후보 생성, read-only preflight, 승인 경계와 sanitized evidence
검증 절차는 [Phase 3 Shadow runbook](eks-spark-resource-planner-phase3-shadow-runbook.md)을
따른다.

| metric | policy V2 expected |
| --- | ---: |
| input bytes | `97,079,116,733` |
| input files | `1` |
| input size source | `s3_head` |
| target partition bytes | `134,217,728` |
| estimated partitions | `724` |
| target partitions per executor | `384` |
| calculated executors | `2` |
| supported candidates | `1, 2, 4` |
| recommended executors | `2` |
| baseline executors | `1` |
| shadow applied executors | `1` |
| executor profile | `standard-v1` |
| reason | `balanced_partition_budget` |

724 partition은 기존 100GB Spark 실행에서 관찰한 task 수와 같다. 과거 policy V1
초안의 `96 partitions/executor`, 계산값 `8`, 최대/권장값 `6`은 사용자와 목표를
재정렬하기 전에 만든 값이며 `balanced-v1`에 의해 대체됐다.

## Live gate

1. 변경 revision과 공식 immutable Backend/Spark image receipt 고정
2. active 실험 Run과 SparkApplication, workload health 및 동시 부하 기록
3. 10GB와 100GB shadow에서 RDS Plan, annotation, 실제 executor 수 대조
4. Gate A 통과 뒤 10GB executor 1 enforce
5. 100GB executor 2 enforce
6. row count, Iceberg/Catalog, runtime, CPU·memory·Pod·Node·비용 지표 대조
7. 목표 미달의 객관적 근거가 있을 때만 executor 4 후보 검토
8. planner `off`, executor `1` 원복

공유 EKS에서 다른 Pod가 존재한다는 사실 자체는 오염이 아니다. 실험 Spark Run과
노드의 CPU throttling, memory pressure, Pending, scale-up 지연, 동시 Spark 부하를
기록하고 비교 가능성을 해칠 정도면 해당 회차만 무효 처리한다.

중단 조건은 Pending 10분 초과, Run 2시간 초과, OOM/반복 실패, row mismatch,
Iceberg/Catalog 실패, workload Ready 저하 또는 rollback 불능이다. Live EKS apply와
10/100GB 실행은 각각 기존 승인 경계를 지킨다.
