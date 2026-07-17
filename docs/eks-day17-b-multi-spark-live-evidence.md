# EKS Day 17 Pair B multi-Spark live evidence

## 결론

2026-07-17 dev 환경에서 FastAPI를 baseline `2`로 유지한 채 서로 격리된 Run A/B/C
3개를 거의 동시에 제출했다. 세 Run은 모두 RDS, Airflow, Spark, Catalog `success`로
끝났고, 각 Run의 SparkApplication, 외부 실행, Iceberg snapshot, Catalog
materialization은 정확히 하나였다.

driver 3개와 executor 3개의 `Pending`을 관찰한 뒤 Spark Node가 baseline `0`에서
`1`, 다시 `2`까지 늘었고, 같은 Pod들이 `Running`으로 전환됐다. 따라서 이번
receipt는 `격리된 Run 3개 → Pending → 새 Spark Node → Running → 데이터 처리
성공`을 하나의 timeline으로 연결한다.

원본 Run, Job, SparkApplication, snapshot, dataset, group, table, output,
checkpoint, Pod, Node 식별자는 이 문서에 기록하지 않는다. 원본 대조용 campaign
receipt와 sanitized observer 기록은 저장소 밖 mode `0600` 파일로만 보존한다.

## 안전 경계

- 새 campaign receipt를 한 번만 사용했고, 이전 campaign receipt 3개는 덮어쓰거나
  재사용하지 않았다.
- 요구된 동시성은 Run A/B/C 3개로 충족돼 4번째 Run은 시작하지 않았다.
- IAM, NodePool, RBAC, Secret, ConfigMap은 생성하거나 변경하지 않았다.
- FastAPI HPA 부하는 다시 실행하지 않았고 FastAPI baseline `2`에서 Spark
  campaign만 실행했다.
- Spark runtime 의존성은 immutable AMD64 image에 고정했다. 실행 중 원격 Maven
  package 다운로드는 `0`이었다.
- 기존 EC2 Continuous topic, group, checkpoint, output은 참조하거나 변경하지
  않았고 새 Continuous session/process는 `0`이었다.
- 로컬 운영자 identity의 SparkApplication list는 RBAC `forbidden` 상태를
  유지했다. 권한을 확장하지 않고, 기존 읽기 권한이 있는 FastAPI ServiceAccount로
  application UID와 실제 spec을 직접 대조했다.

## 식별자를 가린 타임라인

| KST | 관찰 |
| --- | --- |
| `20:29:50` | Run A/B/C와 Run별 고유 격리 경계 `3/3` 관찰 |
| `20:30:19` | driver `Pending` 시작, 2개 관찰 |
| `20:30:25` | Spark Node가 baseline `0`보다 증가해 node scale observable |
| `20:30:32` | driver `Pending` peak 3개 관찰 |
| `20:31:01` | driver 3개 `Running` |
| `20:31:08` | executor `Pending` 시작, 1개 관찰 |
| `20:31:15` | executor `Pending` peak 3개와 Spark Node `2` 관찰 |
| `20:31:58` | executor `Running` 관찰 |
| `20:33:10` | Run A/B/C의 RDS/Airflow/Spark/Catalog 모두 `success`, generation `2` |

Spark Node는 관찰 구간에 `0 → 1 → 2`로 증가했다. 부하 종료 뒤에는 다시 `0`으로
회수됐다.

## 7번: 동시 실행과 격리

| 성공 기준 | 직접 관찰값 | 판정 |
| --- | ---: | --- |
| 실제 동시 Run | Run A/B/C `3`개 | PASS |
| source boundary | 각 Run expected/input/output `100/100/100`, fixture marker 일치 | PASS |
| consumer group | `3/3 unique` | PASS |
| Iceberg table | `3/3 unique` | PASS |
| output prefix | `3/3 unique` | PASS |
| checkpoint | `3/3 unique` | PASS |
| dataset | `3/3 unique` | PASS |
| 외부 Airflow 실행 | Run별 `1`, 전체 `3/3 unique` | PASS |
| SparkApplication | Run별 `1`, UID `3/3 unique`, persisted UID와 Kubernetes UID 일치 | PASS |
| driver/executor placement | Spark selector와 exact `spark:NoSchedule` toleration 일치 | PASS |
| driver resource | core/request/limit `1`, memory `2g`, overhead `512m` | PASS |
| executor resource | instance `1`, core/request/limit `2`, memory `4g`, overhead `1g` | PASS |
| 원격 runtime package | `0` | PASS |
| Continuous 경계 | 새 session/process `0` | PASS |

## 8번: Pending에서 새 Node의 Running까지

| 성공 기준 | 직접 관찰값 | 판정 |
| --- | ---: | --- |
| driver Pending | `3`개 | PASS |
| executor Pending | `3`개 | PASS |
| scheduling 신호 | resource shortage `6`, non-Spark Node의 selector/taint 제외 신호 각각 `3` | PASS, 아래 해석 참조 |
| Node autoscaling | NodeClaim initialized/ready와 Node ready 신호 관찰 | PASS |
| Spark Node 증가 | baseline `0 → 1 → 2` | PASS |
| driver Running | Pending 뒤 `3`개 Running | PASS |
| executor Running | Pending 뒤 Running 관찰 | PASS |
| Spark placement | 실제 SparkApplication spec의 selector/toleration/resource 전부 일치 | PASS |
| General 경계 | FastAPI baseline `2` Ready 유지, General/Spark placement 정책 변경 없음 | PASS, historical join 한계 명시 |
| pool/capacity 실패 | campaign을 막은 pool 상한 또는 AWS capacity 실패 없음 | PASS |

`FailedScheduling`의 selector/taint 문구는 숨기지 않는다. Spark Pod가 Spark
selector를 갖기 때문에 General/other Node가 후보에서 제외됐다는 신호이며, 실제
SparkApplication spec도 의도한 selector와 toleration에 정확히 일치했다. 그 뒤
새 Spark Node가 Ready 되고 같은 driver/executor가 Running이 됐으므로 이를
selector/taint 오설정으로 판정하지 않는다. 동시에 resource shortage 신호도
기록됐고, 이것이 Spark Node scale-out으로 해소됐다.

observer는 Node 이름과 IP를 기록하지 않으며 과거 시점의 General Pod-to-Node
원본 join도 보존하지 않는다. 따라서 “모든 과거 Pod 배치를 이름 단위로 다시
대조했다”고 주장하지 않는다. 대신 campaign 동안 FastAPI baseline `2`가
Ready를 유지한 사실, Spark 전용 Node 증가, SparkApplication의 실제 placement
contract, General/Spark 정책 무변경을 함께 근거로 격리 경계를 판정했다.

## Run별 최종 상태

| 기준 | Run A | Run B | Run C |
| --- | ---: | ---: | ---: |
| RDS/Airflow/Spark/Catalog | success | success | success |
| generation | `2` | `2` | `2` |
| 외부 실행 | `1` | `1` | `1` |
| SparkApplication | `1` | `1` | `1` |
| persisted UID 일치 | PASS | PASS | PASS |
| Iceberg snapshot | `1` | `1` | `1` |
| Catalog materialization | `1` | `1` | `1` |
| input/output | `100/100` | `100/100` | `100/100` |

## 9번: 데이터 결과 read-only 검증

`scripts/verify-eks-day17-multi-spark-results.sh --verify`는 기존 FastAPI Pod 안에서
RDS 트랜잭션을 read-only로 열고 Trino의 `SELECT`/`DESCRIBE`만 수행했다. 새 Run,
Job, Pod, SparkApplication이나 Kubernetes resource를 만들지 않았다.

| 성공 기준 | Run A | Run B | Run C | 판정 |
| --- | ---: | ---: | ---: | --- |
| fixture expected / Spark input / Spark output | `100/100/100` | `100/100/100` | `100/100/100` | PASS |
| exact snapshot의 `_asklake_run_id` 행 | `100` | `100` | `100` | PASS |
| exact snapshot data file | `1` | `1` | `1` | PASS |
| exact snapshot storage size | 양수 | 양수 | 양수 | PASS |
| Catalog materialization | `1` | `1` | `1` | PASS |
| RDS/Airflow/Spark/Catalog | success | success | success | PASS |
| identity chain | 일치 | 일치 | 일치 | PASS |

전체 expected/Spark input/Spark output/Trino verified rows는
`300/300/300/300`, data file은 `3`, materialization은 `3`이었다.

| cross-Run 격리 기준 | 직접 관찰값 | 판정 |
| --- | ---: | --- |
| consumer group | `3/3 unique` | PASS |
| Iceberg table | `3/3 unique` | PASS |
| output | `3/3 unique` | PASS |
| checkpoint | `3/3 unique` | PASS |
| Iceberg snapshot | `3/3 unique` | PASS |
| dataset | `3/3 unique` | PASS |
| Airflow DAG run | `3/3 unique` | PASS |
| 다른 Run 결과로 보완 없음 | Run별 전체 identity chain 일치 | PASS |

sanitized 결과는 저장소 밖
`/private/tmp/asklake-day17-multi-spark-results.json`에 mode `0600`으로 보존한다.
검증기는 원본 private receipt의 Run, Job, dataset, group, table, output,
checkpoint, fixture marker를 결과에 쓰지 않으며, 실행 뒤 실제 원본 값이 결과
문자열에 하나도 포함되지 않았음을 자동 대조했다.

이 문서로 7번의 격리된 동시 실행, 8번의 Pending에서 Node scale과 Running 전환,
9번의 exact 데이터 결과 검증을 함께 닫는다.

## 10번: terminal과 scale-in cleanup

observer에서 Run A/B/C가 모두 success가 된 최초 시각은 `20:33:10 KST`였고 이
시점의 active driver/executor는 `0`이었다. Spark Node는 peak `2`에서
`20:43:01 KST`에 baseline `0`으로 돌아왔다. 그 사이 NodeClaim `Drained`,
Node/NodeClaim `DisruptionTerminating`, Node `RemovingNode` 신호가 기록됐다.

최종 `scripts/audit-eks-day17-cleanup.sh --audit` 결과는 다음과 같다.

| 성공 기준 | 직접 관찰값 | 판정 |
| --- | ---: | --- |
| HPA current/desired | `2/2` | PASS |
| FastAPI Deployment | replicas/updated/ready/available/unavailable `2/2/2/2/0` | PASS |
| FastAPI Pod | total/ready/terminating `2/2/0` | PASS |
| campaign active driver/executor | `0` | PASS |
| Spark Node | peak `2 → 0` | PASS |
| Node removal signal | `Drained`, `DisruptionTerminating`, `RemovingNode` 관찰 | PASS |
| Day 17 임시 Job/Pod/ConfigMap/Secret | `0/0/0/0` | PASS |
| 로컬 load generator | process `0` | PASS |
| durable evidence | Run/snapshot/materialization `3/3/3` | PASS |

이미 임시 자원이 `0`이었으므로 삭제 명령은 실행하지 않았다. RDS Run, Catalog,
Iceberg snapshot과 저장소 밖 receipt는 보존했다. campaign이 이미 Spark Node
`0`으로 복귀한 뒤 시작된 별도 Spark workload는 이번 campaign cleanup 대상이
아니므로 건드리지 않았다.

sanitized cleanup receipt는
`/private/tmp/asklake-day17-cleanup-audit.json`에 mode `0600`으로 보존한다.
