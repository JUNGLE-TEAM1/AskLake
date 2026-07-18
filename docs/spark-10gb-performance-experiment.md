# Spark 10GB 성능·executor 실험

이 문서는 Issue #926의 두 실험을 같은 입력과 동일한 correctness gate로 재현하기 위한 실행 기록이다. 코드와 PR의 기준 브랜치는 `main`이 아니라 `origin/pair1`이다. 최초 작업 기준 SHA는 `a45b2ced42b5683c55d9b96cdabe46a9175f6b68`이며, 실제 배포에는 이 SHA에서 분기한 PR head의 immutable Backend/Spark image receipt만 사용한다.

## 1. 질문과 판정 기준

실험 1은 확정 schema projection cache, row-preserving SQL transform의 action 제거와 단일 Quality aggregate가 반복 source/cache scan을 제거했을 때 1 executor의 Spark 시간이 얼마나 줄어드는지 측정한다. 기존 Spark `durationMs=370043` 대비 최소 30% 감소를 목표로 한다.

실험 2는 최적화된 같은 revision에서 executor를 `1`, `2`, `4`로 바꿨을 때 Spark 전체/단계별 시간, Pod·Node 증가, CPU·memory·network와 비용 대용값이 어떻게 변하는지 비교한다. executor 수가 많다는 이유만으로 성공으로 판정하지 않으며, 1 executor 대비 실제 시간이 줄지 않거나 자원 증가 대비 이득이 작으면 그 결과를 그대로 기록한다.

모든 성능 표본은 아래 correctness 조건을 먼저 통과해야 한다.

- source object와 `inputBytes=9235015833`, `inputRows=29544766`이 기준과 같다.
- `outputRows=29544766`, schema/rule fingerprint, Quality pass/failure 수가 기준과 같다.
- 새 Run의 Iceberg snapshot이 current `main`이고 Spark `outputFileCount`, `icebergCommit.dataFileCount`, Trino exact snapshot `total-data-files`가 같다.
- retry는 성공한 같은 `runId`를 재사용하고 새 SparkApplication, snapshot, materialization을 만들지 않는다.
- Quality 실패 또는 snapshot/file identity drift에서는 Catalog 성공이나 부분 materialization이 생기지 않는다.

## 2. 변경 전 기준점

2026-07-18 dev에서 동일 S3 JSONL 단일 object를 1 executor, executor core 2로 실행한 관찰값이다. 식별자 원문과 credential은 저장하지 않고 private observer receipt에만 둔다.

| 지표 | 변경 전 1 executor |
| --- | ---: |
| 입력 크기 | 9,235,015,833 bytes |
| 입력/출력 행 | 29,544,766 / 29,544,766 |
| UI command-to-terminal | 6분 10초 |
| Spark `durationMs` | 370,043 ms |
| executor / executor core | 1 / 2 |
| task partition | 69 |
| 실제 Iceberg Parquet | 69 files / 414,382,459 bytes |
| manifest `outputFileCount` | 0 (오류) |
| source 물리 read | 반복 실행; action-budget 회귀 fixture 기준 3회 |
| Spark node peak | 1 |
| Spark node pending→running | 6.7초 |
| 실행 종료 후 scale-in | 약 11분 6초 |
| CPU 평균/최대 | 2.056 / 4.346 cores |
| memory 평균/최대 | 12.517 / 16.622 GB |
| network RX 평균/최대 | 87.631 / 195.354 MB/s |
| network TX 평균/최대 | 0.908 / 9.822 MB/s |

CloudWatch 자원 값은 30초 간격 17개 표본의 합계다. Spark UI에서는 69-task source read Job이 반복됐고 첫 두 source read는 각각 약 52.5초, 57.5초였다. failed task, spill, Major GC는 관찰되지 않았다.

## 3. 후보 구현

- 확정 schema projection에 같은 Spark type의 identity rename과 승인된 row-preserving SQL transform 선두 prefix를 먼저 적용한 뒤 `MEMORY_AND_DISK`로 한 번 materialize해 Rule, Quality, sample, write가 완성된 변환 결과를 재사용한다. 실제 사용 수는 `transform.preMaterializedTransformCount`로 판정한다.
- 이 fixture의 `TRIM(CAST(event_id AS STRING))`, `TRIM(CAST(user_id AS STRING))`처럼 total·row-preserving으로 증명되는 SQL transform은 이전 row count를 재사용하고 rule별 `count()`를 실행하지 않는다. 임의 SQL/`SELECT`는 이 fast path에 포함하지 않는다.
- canonical Quality가 이미 계산한 evaluated/drop/quarantine counter로 최종 `outputRows`를 산출하고, counter가 유효할 때만 중복 final `count()`를 생략한다. 이 경로에서는 target publish가 final frame을 모두 materialize할 때까지 source cache를 유지한다.
- canonical counter 경로는 publish와 동시에 재사용하지 않을 두 번째 output cache를 만들지 않고 `source_cache_direct_publish`로 source cache에서 바로 Iceberg를 쓴다. fallback/legacy만 `materialized_output_cache`를 유지한다.
- legacy Quality rule의 전체 행, rule별 failure, union invalid를 하나의 aggregate action으로 계산한다.
- output frame과 quarantine frame cache를 성공·규칙 실패·예외 경로에서 모두 `unpersist`한다.
- Iceberg exact snapshot summary의 `total-data-files`를 Spark와 Catalog가 교차 검증한다.
- Spark manifest에 단계별 시간과 실제 executor/resource 설정을 보존한다.
- executor instance는 정수 `1..4`만 허용하고 실험은 `1`, `2`, `4`만 사용한다.

로컬 Spark 4 회귀에서 단일 cast JSONL pipeline의 원본 `FileScanRDD` 물리 read는 3회에서 정확히 1회로 줄었다. 이 사전 증거와 production 10GB live 결과가 같은 방향임을 아래 표에서 확인했다.

## 4. 실행 절차

1. `origin/pair1`과 PR merge-base가 같고 worktree에 다른 branch merge가 없는지 확인한다.
2. Backend/Spark image workflow를 PR head로 실행하고 formal receipt의 Git revision, AMD64 immutable digest를 검증한다.
3. 현재 runtime ConfigMap 전체를 Git-ignored mode `0600` values로 캡처한다. Spark image 외 key가 바뀌지 않는 candidate를 server dry-run하고 전용 Helm release로 적용한다.
4. Backend image를 receipt digest로 rollout하고 FastAPI 2개, Collector 1개, ALB/RDS health와 zero external HTTP failure를 확인한다. runtime ConfigMap을 바꿀 때는 `runtimeConfigRevision`을 함께 갱신한다.
5. unrelated active Job/SparkApplication, Pending/terminating Pod가 0이고 Spark NodePool이 0인지 확인한다. observer를 먼저 시작한 뒤 새로운 Run을 한 번만 제출한다.
6. Run terminal 뒤 RDS manifest, SparkApplication, Spark event/log, Iceberg/Trino snapshot, Kubernetes metrics와 CloudWatch 표본을 하나의 run alias로 결합한다. 원본 ID는 private receipt에만 두고 추적 문서에는 짧은 hash 또는 A/B/C/D alias만 사용한다.
7. 최적화 1 executor 결과가 correctness gate를 통과하면 변경 전 기준과 비교해 실험 1을 판정한다.
8. 같은 revision/source/config로 executor `2`, `4`를 각각 적용·rollout하고 새 Run을 한 번씩 제출한다. 가능하면 각 표본 전 Spark NodePool `0`을 기다리며, 그렇지 못한 표본은 warm으로 표시해 cold wall time과 섞지 않는다.
9. executor를 `1`로 복구하고 FastAPI/Collector health, active SparkApplication/Pod `0`, Spark NodePool scale-in을 확인한다. 완료 SparkApplication과 Iceberg/Catalog 실행 증거는 삭제하지 않는다.

## 5. 수집 지표

| 범주 | 지표 |
| --- | --- |
| correctness | input bytes/files/rows, output rows, schema/rule fingerprint, Quality rule별 failure, snapshot ID hash, exact data files/bytes |
| 처리 시간 | command accepted→terminal wall time, Spark `durationMs`, Source/Rule/Quality/source-post/Target phase `durationMs` |
| Spark | executor instances/cores, default parallelism, shuffle partitions, task 수, failed/retried task, spill, GC |
| Kubernetes | driver/executor Pod 생성·Ready·종료 시각, executor peak, Spark node peak, NodeClaim pending→ready, 완료→scale-in |
| 자원 | CPU core 평균/최대, memory 평균/최대, network RX/TX 평균/최대, 가능하면 executor별 분포 |
| 효율 | rows/s, input MB/s, executor-seconds, Spark-node-seconds, 1 executor 대비 speedup와 parallel efficiency |

계산식은 다음과 같다.

```text
개선율(%) = (변경 전 durationMs - 후보 durationMs) / 변경 전 durationMs * 100
speedup(N) = 최적화 1-executor durationMs / N-executor durationMs
parallel efficiency(N) = speedup(N) / N
rows/s = outputRows / (durationMs / 1000)
```

## 6. 결과

2026-07-18에 `origin/pair1` 기반 PR head `86ed3dfcd5f211575babdef1d4051829e1b2f5c6`의 immutable image를 dev에 배포해 측정했다. 세 후보 표본은 모두 실행 직전 active Run/Job/Spark Pod와 Spark NodePool이 `0`인 cold-start 조건에서 한 번씩 제출했다.

| 지표 | 변경 전 1 | 최적화 1 | 최적화 2 | 최적화 4 |
| --- | ---: | ---: | ---: | ---: |
| Spark duration ms | 370,043 | 159,100 | 145,324 | 122,793 |
| 변경 전 대비 개선율 | - | 57.0% | 60.7% | 66.8% |
| 최적화 1 대비 speedup | - | 1.00x | 1.09x | 1.30x |
| parallel efficiency | - | 100.0% | 54.7% | 32.4% |
| rows/s | 79,841 | 185,699 | 203,303 | 240,606 |
| command→terminal | 370초 | 242초 | 220초 | 200초 |
| executor-seconds | 370.0 | 159.1 | 290.6 | 491.2 |
| source physical read | 반복/fixture 3 | 1회 | 1회 | 1회 |
| executor / core peak | 1 / 2 | 1 / 2 | 2 / 4 | 4 / 8 |
| Spark node peak | 1 | 1 | 2 | 2 |
| exact data files | 실제 69 / manifest 0 | 69 / 69 / 69 | 69 / 69 / 69 | 69 / 69 / 69 |
| failed task / spill | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| correctness gate | file metric fail | pass | pass | pass |

`exact data files`의 후보 값은 순서대로 runtime output, Spark Iceberg commit, Catalog current snapshot이다. 세 후보 모두 입력 `9,235,015,833 bytes`, 입력/출력 `29,544,766 rows`, Quality `pass`, current snapshot 일치 조건을 통과했다. source 물리 read stage도 각각 정확히 1개였고 읽은 bytes는 Spark 기준 약 9.236GB였다.

### 6.1 단계별 시간

| Spark phase | 최적화 1 | 최적화 2 | 최적화 4 |
| --- | ---: | ---: | ---: |
| Source validation | 96,137 ms | 73,483 ms | 56,643 ms |
| Rule evaluation | 6 ms | 11 ms | 10 ms |
| Quality aggregation | 187 ms | 229 ms | 185 ms |
| Source post validation | 0 ms | 0 ms | 0 ms |
| Target publish | 52,461 ms | 35,793 ms | 29,248 ms |

Rule과 Quality는 더 이상 병목이 아니다. executor 증가로 Source와 Target은 모두 줄었지만 1→2의 전체 Spark 한계 개선은 8.7%, 2→4는 15.5%였다. source split 수, S3 처리량과 Iceberg write가 포함되므로 executor 수에 비례한 선형 단축은 나타나지 않았다.

### 6.2 Pod·Node와 Spark 자원

| 지표 | 최적화 1 | 최적화 2 | 최적화 4 |
| --- | ---: | ---: | ---: |
| driver peak | 1 | 1 | 1 |
| executor Pod peak | 1 | 2 | 4 |
| Spark node 유형 | `m8i.xlarge` | `m7i.xlarge`, `m7i-flex.xlarge` | `m6i.2xlarge`, `m7i-flex.xlarge` |
| submit→driver | 22.88초 | 18.33초 | 15.89초 |
| submit→첫 executor | 76.19초 | 71.01초 | 70.26초 |
| submit→첫 running node | 28.57초 | 25.05초 | 27.88초 |
| Spark 종료→idle | 6.43초 | 6.32초 | 8.82초 |
| Spark 종료→node 0 | 694.43초 | 692.75초 | 장기 대기 생략 |
| executor CPU time | 216.83초 | 253.76초 | 380.84초 |
| JVM GC time | 6.73초 | 5.96초 | 9.25초 |
| executor memory peak/capacity | 0.883/2.388GB | 0.883/4.776GB | 0.883/9.553GB |

EKS Auto Mode가 workload 크기에 맞춰 node 유형을 선택했기 때문에 executor가 2개에서 4개로 늘어도 node peak는 2개로 같고, 대신 8 vCPU `m6i.2xlarge`가 포함됐다. executor memory peak는 거의 늘지 않았고 모든 표본에서 memory/disk spill이 `0`이어서, 이 workload는 메모리 부족보다 S3 read와 Iceberg publish의 병렬 처리량 영향을 더 크게 받았다.

Pod Metrics API는 실험 계정의 read RBAC로 조회할 수 없어 `RBAC forbidden`으로 기록했다. executor CPU, memory, GC, task, spill은 Spark UI를 기준으로 사용했다. 표준 EC2 CloudWatch는 5분 집계 지연과 적은 표본 수 때문에 보조 지표로만 사용했다. 최적화 1은 Spark node 1개·1개 표본에서 CPU 평균/최대 `1.302/1.964 cores`, RX `158.009MB/s`, TX `7.411MB/s`였다. 최적화 2는 node 2개·2개 표본에서 CPU 평균/최대 `1.024/3.484 cores`, RX 평균/최대 `91.935/176.166MB/s`, TX 평균/최대 `4.006/4.820MB/s`였고, 최적화 4는 node 2개·1개 표본에서 CPU 평균/최대 `1.829/5.928 cores`, RX `159.463MB/s`, TX `8.113MB/s`였다.

### 6.3 판정과 운영 선택

- Issue #926의 1-executor 목표인 기존 `370,043ms` 대비 30% 이상 단축은 `159,100ms`, **57.0% 단축**으로 통과했다.
- 가장 짧은 latency는 executor 4개의 `122,793ms`지만, executor 1개보다 22.8% 빠른 대신 executor-seconds는 약 3.09배다.
- 이 10GB workload에서는 최적화 1개가 성능 acceptance와 자원 효율을 함께 만족한다. latency 우선 실행에서만 4개를 선택하고, 2개는 1개 대비 8.7% 단축에 그쳐 기본값으로 올릴 근거가 약하다.
- 실험 종료 후 runtime executor 설정은 `1`로 복구한다. 완료 Spark/Iceberg/Catalog 증거는 유지하고 credential과 원본 식별자는 공개 문서에 남기지 않는다.

### 6.4 실제 실행 기록

각 후보는 CLI에서 같은 순서로 수행했다: immutable revision/설정 확인 → global/target active Run `0`, active Spark Pod `0`, Spark node `0` 확인 → observer와 Spark UI collector 시작 → Run 정확히 한 번 제출 → terminal success와 Iceberg/Catalog exact reconciliation 확인 → private mode-`0600` 증거 저장. executor `1→2→4` 사이에는 executor key만 변경하고 Backend 2개와 Collector 1개의 live env, image receipt, 외부 health를 다시 검증했다. 최종 복구도 같은 절차로 executor `1`과 active workload `0`을 확인한다.

## 7. 원본 증거와 공개 범위

observer JSONL, image/runtime values, Kubernetes/RDS/CloudWatch 원본은 저장소 밖 `/private/tmp` 또는 Git-ignored 경로에 mode `0600`으로 보관한다. AWS account, ARN, endpoint, credential, raw Run/Job/SparkApplication/snapshot/dataset 식별자는 Issue/PR/추적 문서에 기록하지 않는다. PR과 Issue에는 pair1 base/head SHA, sanitized 집계, 검증 명령, correctness 결과와 계산식만 남긴다.
