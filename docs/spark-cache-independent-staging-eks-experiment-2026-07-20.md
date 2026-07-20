# Spark Cache-Independent Staging EKS Experiment

작성일: 2026-07-20
관련 이슈: #931
상태: executor cache OOM 수정, 격리 EKS scale, bounded publication 안전성 검증 완료

## 1. 목적과 범위

#926의 10GB 최적화는 projected DataFrame을 `MEMORY_AND_DISK`로 유지해 raw S3
source 재스캔을 줄였다. 같은 구조를 약 97GB JSONL에 적용하자 4GiB executor JVM
heap에 deserialized cache block이 누적됐고 replacement executor 네 개가 같은
`Java heap space` 오류로 종료됐다.

이번 변경은 전체 transformed frame을 executor cache에 유지하지 않는다. raw
source와 지원되는 row-preserving transform을 run 전용 Parquet staging에 한 번
기록하고, schema·Rule·Quality·sample·target write는 새 staged DataFrame을
기준으로 실행한다.

```text
raw S3 source
→ schema projection + 지원 transform
→ run-scoped Parquet staging
→ staged schema/quality/sample
→ target publish
→ materialization staging cleanup
```

이 보고서의 EKS scale 실험은 공유 Iceberg/Catalog를 변경하지 않는 고유 S3
Parquet output을 사용했다. 100GB Iceberg/Trino 분포와 Catalog publication
identity의 live 검증은 후속 범위다.

## 2. Provenance와 고정 조건

- 장애 기준 revision: `f77c0cad`
- 수정 revision: `a7793a29`
- 수정 branch: `fix/931-spark-cache-independent-staging`
- candidate image는 private receipt의 Git revision 및 immutable digest와 대조했다.
- 실제 registry, account, bucket, object key, digest와 Run/Pod identity는 Git에
  기록하지 않는다.
- 10GB와 100GB 모두 다른 active Spark workload가 없는 dev EKS에서 실행했다.
- driver: 1 core, 2GiB heap, 512MiB overhead
- executor: 1 instance, 2 cores, 4GiB heap, 1GiB overhead
- `spark.sql.shuffle.partitions=32`

## 3. Before/After 결과

| 지표 | 10GB cache 기준 | 10GB staging | 100GB cache 장애 | 100GB staging |
| --- | ---: | ---: | ---: | ---: |
| 실제 input bytes | 9,235,015,833 | 동일 | 97,079,116,733 | 동일 |
| terminal status | success | success | failed | success |
| Spark duration | 159,100 ms | 225,440 ms | 1,441,263 ms 뒤 실패 | 2,420,238 ms |
| input/output rows | 29,544,766 / 29,544,766 | 동일 | 0 / 0 | 310,578,707 / 310,578,707 |
| raw physical full-read stage | 1 | 1 | 약 1회 상당 network | 1 |
| executor cache | `MEMORY_AND_DISK` | `NONE` | `MEMORY_AND_DISK` | `NONE` |
| materialization files | 해당 없음 | 69 | 해당 없음 | 724 |
| final Parquet files | 69 | 9 | 0 | 91 |
| JVM OOM marker / pod OOMKilled | 0 / 0 | 0 / 0 | 4 / 0 | 0 / 0 |
| failed task / executor replacement | 0 / 0 | 0 / 0 | replacement 4 | 0 / 0 |
| peak executor memory evidence | 약 0.883GB 관찰 | JVM heap 2.99GiB | 약 3.65~3.67GiB working set에서 JVM OOM | JVM heap 3.31GiB |
| executor GC | 기존 기록 | 6.314초 | event log 미수집 | 90.952초 |
| memory/disk spill | 0 / 0 | 0 / 0 | 0 / 0 관찰 | 0 / 0 |
| staging residue | 해당 없음 | 0 | 해당 없음 | 0 |

10GB staging은 cache 기준보다 66.34초, 41.7% 느렸다. 그러나 #926 변경 전
370,043ms보다는 39.1% 짧다. 100GB는 cache 방식이 약 24분 뒤 실패한 것과 달리
staging 방식이 약 40분 20초에 전체 행을 정확히 완료했다. 이 변경은 10GB의 최저
latency보다 bounded memory와 100GB 완주를 우선하는 trade-off다.

## 4. Lifecycle와 정리 결과

각 EKS 실험은 고유 output prefix와 SparkApplication identity를 사용했다. 성공
보고서를 수집한 뒤 application과 pod를 삭제하고, versioning이 활성화된 S3
prefix의 current object, version, delete marker를 모두 제거했다.

| 대상 | 10GB 종료 후 | 100GB 종료 후 |
| --- | ---: | ---: |
| SparkApplication | 0 | 0 |
| driver/executor pod | 0 | 0 |
| current S3 object | 0 | 0 |
| S3 version/delete marker | 0 | 0 |

두 source object의 size, ETag와 version identity는 실행 전후 동일했다.

Runtime manifest는 다음 증거를 남긴다.

- `sparkResources.cacheStorageLevel=NONE`
- `sparkResources.materializationMode=run_scoped_parquet_staging`
- `sparkResources.outputFrameCacheMode=staged_parquet_reuse`
- `sparkResources.materializationFileCount`
- `sparkResources.materializationCleanupStatus`
- `phaseTimings.materializationStaging`

## 5. 자동 회귀 범위

- `verify:spark-schema-contract`: required-null/cast aggregate action budget
- `verify:snapshot-rule-conformance`: Node/Spark Rule 의미 동등성
- `verify:snapshot-spark-pipeline`: raw JSONL physical read 1회, staging 생성,
  success·quality failure·schema exception cleanup
- `verify:spark-s3-staging`: opt-in 실제 AWS S3A read/materialize/publish와
  current object/version cleanup
- `verify:spark-iceberg-batch`: Iceberg snapshot/file identity와 commit 뒤 실패
  rollback. 기존 current snapshot이 있는 table에 Quality `Fail Run`을 주입하고
  current snapshot, snapshot 수, row count가 모두 그대로이며 Iceberg commit이
  생성되지 않는 것도 확인한다.
- `verify-airflow-catalog-reconciliation.py`: 실제 PostgreSQL에서 같은 Run
  reconciliation의 materialization 1개 유지, Catalog transaction rollback,
  Spark failure evidence 보존을 확인한다. fixture는 Iceberg physical 검증을
  명시적으로 대체하고 Catalog transaction 경계만 검사한다.
- `test:spark-kubernetes`: deterministic SparkApplication create/recover/cleanup
  계약

Unique canonical rule은 현재 compiler에서 `RULE_OPERATION_UNSUPPORTED`로 실행 전에
거부하며 silent pass하지 않는다. 같은 persisted Run의 성공 Spark result 재호출은
저장된 manifest를 반환하고 새 SparkApplication을 만들지 않는 기존 control-plane
계약을 유지한다.

## 6. Publication 안전성 후속 실험

수정 revision `a7793a29`의 immutable Spark runtime을 dev EKS의 격리 bounded
fixture Job에 적용했다. FastAPI runtime의 Spark image 설정만 실험 중 임시
교체하고 실제 Airflow 제품 경로로 실행한 뒤 원래 digest로 복구했다. registry,
cluster, Run, application, snapshot 식별자는 private mode-0600 evidence에만
보관했다.

| 검증 | 결과 |
| --- | --- |
| Spark / Iceberg / Trino / Catalog identity | 17/17 pass |
| Spark input/output / Trino exact rows | 100 / 100 / 100 |
| exact Iceberg data file | 1 |
| 해당 Run의 Catalog materialization | 1 |
| 같은 성공 Run retry | success |
| retry generation / application UID / snapshot | 모두 변화 없음 |
| retry Catalog materialization | 1개 유지 |
| 임시 SparkApplication/Pod residue | 0 |
| dev FastAPI runtime | 원래 image와 Ready 상태로 복구 |

이 실험 준비 중 Catalog failure 뒤 Airflow 동기화 경로가 정의되지 않은
`spark_result`를 참조하는 오류를 발견했다. polling lock 뒤 보존한
`taskStates.sparkResult`를 사용하도록 수정하고, Quality 실패 단계와 오류가
유지되는 회귀 test를 추가했다.

## 7. 후속 범위

다음 항목은 scale 및 bounded publication 검증의 완료 주장에 포함하지 않는다.

1. 100GB staging과 최종 Iceberg/Trino의 event type 분포 대조
2. Spark commit, Iceberg current snapshot과 Catalog snapshot/data-file identity의
   100GB end-to-end 대조
3. concurrent commit conflict의 EKS live fault 주입
4. Spark event log 및 S3 request metric의 장기 보존
5. workload profile별 executor/resource 선택 정책과 NodePool scale-in receipt

이 항목들은 staging으로 JVM OOM을 제거한 현재 변경과 분리해 후속 검증 및 운영
hardening으로 진행한다.
