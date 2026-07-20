# EKS 100 GB Spark Resource Planner Shadow Evidence — 2026-07-20

## 현재 판정

로컬 계약과 실제 S3 metadata 기반 Shadow 계산은 통과했다. Live EKS Gate A와
executor 1/4/6 Gate B 결과는 실행 receipt에서 후속 갱신한다.

| metric | observed |
| --- | ---: |
| input bytes | `97,079,116,733` |
| input files | `1` |
| input size source | `s3_head` |
| target partition bytes | `134,217,728` |
| estimated partitions | `724` |
| calculated executors | `8` |
| policy maximum | `6` |
| recommended executors | `6` |
| baseline executors | `1` |
| shadow applied executors | `1` |
| reason | `capped_by_max_executors` |

이 계산은 기존 Spark UI가 같은 입력에서 기록한 724개 task와 일치한다. Shadow
mode에서는 실제 executor 수를 1개로 유지한다.

## Live gate

1. 변경 revision과 공식 immutable Backend image receipt 고정
2. active SparkApplication `0`, FastAPI·Collector Ready 확인
3. 10 GB와 100 GB shadow에서 RDS Plan, annotation, actual executor 수 대조
4. Gate A 통과 뒤 100 GB executor 1/4/6 순차 실험
5. row count, Iceberg/Catalog, runtime, CPU·memory·Pod·Node 지표 대조
6. planner `off`, executor `1` 원복

중단 조건은 Pending 10분 초과, Run 2시간 초과, OOM/반복 실패, row mismatch,
Iceberg/Catalog 실패, workload Ready 저하 또는 rollback 불능이다.
