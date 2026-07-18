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

- 확정 schema projection을 `MEMORY_AND_DISK`로 한 번 materialize하고 Rule, Quality, sample, write가 재사용한다.
- 이 fixture의 `TRIM(CAST(event_id AS STRING))`, `TRIM(CAST(user_id AS STRING))`처럼 total·row-preserving으로 증명되는 SQL transform은 이전 row count를 재사용하고 rule별 `count()`를 실행하지 않는다. 임의 SQL/`SELECT`는 이 fast path에 포함하지 않는다.
- canonical Quality가 이미 계산한 evaluated/drop/quarantine counter로 최종 `outputRows`를 산출하고, counter가 유효할 때만 중복 final `count()`를 생략한다. 이 경로에서는 target publish가 final frame을 모두 materialize할 때까지 source cache를 유지한다.
- legacy Quality rule의 전체 행, rule별 failure, union invalid를 하나의 aggregate action으로 계산한다.
- output frame과 quarantine frame cache를 성공·규칙 실패·예외 경로에서 모두 `unpersist`한다.
- Iceberg exact snapshot summary의 `total-data-files`를 Spark와 Catalog가 교차 검증한다.
- Spark manifest에 단계별 시간과 실제 executor/resource 설정을 보존한다.
- executor instance는 정수 `1..4`만 허용하고 실험은 `1`, `2`, `4`만 사용한다.

로컬 Spark 4 회귀에서 단일 cast JSONL pipeline의 원본 `FileScanRDD` 물리 read는 3회에서 정확히 1회로 줄었다. 이는 production 10GB 시간 개선의 사전 증거일 뿐이며, 실제 향상률은 아래 live 표를 채운 뒤에만 확정한다.

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

아래 표는 live 실험이 끝날 때만 채운다. `pending`을 추정값으로 바꾸지 않는다.

| 지표 | 변경 전 1 | 최적화 1 | 최적화 2 | 최적화 4 |
| --- | ---: | ---: | ---: | ---: |
| Spark duration ms | 370,043 | pending | pending | pending |
| 변경 전 대비 개선율 | - | pending | pending | pending |
| 최적화 1 대비 speedup | - | 1.00x | pending | pending |
| rows/s | 79,840 | pending | pending | pending |
| source physical read | 반복/fixture 3 | 1 목표 | 1 목표 | 1 목표 |
| executor peak | 1 | pending | pending | pending |
| Spark node peak | 1 | pending | pending | pending |
| exact data files | 실제 69 / manifest 0 | pending | pending | pending |
| correctness gate | pass, file metric fail | pending | pending | pending |

최종 결론에는 가장 빠른 설정뿐 아니라 1→2와 2→4의 한계 개선, node 증가, executor-seconds를 함께 적는다. 단일 10GB source object의 split 수, S3 throughput 또는 Iceberg write가 병목이면 executor 4가 선형으로 빨라지지 않는 것이 정상적인 실험 결과다.

## 7. 원본 증거와 공개 범위

observer JSONL, image/runtime values, Kubernetes/RDS/CloudWatch 원본은 저장소 밖 `/private/tmp` 또는 Git-ignored 경로에 mode `0600`으로 보관한다. AWS account, ARN, endpoint, credential, raw Run/Job/SparkApplication/snapshot/dataset 식별자는 Issue/PR/추적 문서에 기록하지 않는다. PR과 Issue에는 pair1 base/head SHA, sanitized 집계, 검증 명령, correctness 결과와 계산식만 남긴다.
