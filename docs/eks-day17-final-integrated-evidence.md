# EKS Day 17 Pair B 최종 통합 evidence

## 결론

2026-07-17 dev 환경에서 API 부하에 따른 FastAPI HPA `2 → 6 → 2`, 동일 논리
Run의 외부 실행/SparkApplication/Iceberg snapshot/Catalog materialization
`1/1/1/1`, 격리된 Spark Run 3개의 `Pending → 새 Spark Node → Running`, 데이터
`300/300`행과 compute scale-in을 하나의 receipt로 연결했다.

최종 판정은 `PASS`다. 자동 검증 16개가 모두 통과했고 Day 17 임시 Kubernetes
리소스와 로컬 load process는 `0`이다. RDS Run, Iceberg snapshot, Catalog
materialization은 삭제하지 않고 각각 `3/3/3` 보존했다.

sanitized machine receipt는 저장소 밖
`/private/tmp/asklake-day17-final-receipt.json`에 mode `0600`으로 보존한다.
원본 Run, Job, SparkApplication, snapshot, dataset, group, table, output,
checkpoint, Pod, Node 식별자와 Secret, token, URL, account, ARN은 이 문서와
machine receipt에 기록하지 않는다.

## API와 동일 Run 경합 타임라인

| KST | 관찰 | replica/결과 |
| --- | --- | --- |
| `15:06:46` | read-only API load 시작 | HPA `2`, FastAPI Ready `2` |
| `15:16:13` | HPA scale-out 최초 관찰 | HPA `6`, 이 순간 FastAPI Ready `5` |
| `15:58:14` | Ready target 6개에 동일 논리 Run 경합 시작 | HPA `6`, target `6` |
| `16:03:19` | 200 RPS 단계 종료 | `114,494` requests, non-2xx/5xx `0/0` |
| `16:31:56` | 동일 Run exact-one read-only 재검증 | 외부 실행/application/snapshot/materialization `1/1/1/1` |
| `21:00:45` | 최종 scale-in/steady audit | HPA `2`, FastAPI Ready `2`, terminating `0` |

HPA가 처음 `6`에 도달한 순간에는 새 Pod 하나가 아직 Ready 전이었다. 동일 Run
경합은 별도의 gate에서 HPA와 6개 target 준비를 모두 확인한 뒤 시작했으므로,
첫 scale-out 관찰값 `Ready 5`를 경합 시작 상태로 사용하지 않았다.

동일 Run identity chain은 다음 short hash로만 연결한다.

| alias | Run | SparkApplication | snapshot | dataset | fixture |
| --- | --- | --- | --- | --- | --- |
| Same-Run Race | `2a6ab693d3b2` | `0aa39dd226d8` | `53ff50fc27d4` | `a1bec691485b` | `f831113d837d` |

세부 owner/generation과 복구 과정은
[동일 Run 경합 live evidence](eks-day17-b-same-run-race-live-evidence.md)를
참조한다.

## Spark 동시 실행과 Node 타임라인

| KST | 관찰 | Pod/Node/결과 |
| --- | --- | --- |
| `20:29:45` | 격리된 Run A/B/C 제출 | Run `3` |
| `20:30:19` | driver Pending 시작 | Pending `2`, Spark Node `0` |
| `20:30:25` | 첫 Spark Node 증가 | Spark Node `1` |
| `20:30:32` | driver Pending peak | Pending `3`, Spark Node `1` |
| `20:31:01` | driver Running | Running `3`, Spark Node `1` |
| `20:31:08` | executor Pending 시작 | Pending `1`, Spark Node `1` |
| `20:31:15` | executor Pending peak과 두 번째 Node | Pending `3`, Spark Node `2` |
| `20:31:58` | executor Running | Running `3`, Spark Node `2` |
| `20:33:10` | Run A/B/C 데이터 경로 success | active Spark Pod `0`, Trino rows `300`, materialization `3` |
| `20:43:01` | 빈 Spark Node 제거 완료 | Spark Node `0`, removal signal `18` |

첫 Node 증가는 driver Pending `2`가 관찰된 뒤 발생했다. 세 번째 driver도
Pending에 합류한 뒤 세 driver가 같은 campaign에서 Running으로 바뀌었다.
executor도 `Pending 1 → 3`, Spark Node `1 → 2`, `Running 3` 순서로 이어졌다.
따라서 Node 증가는 selector, IAM, Secret 오류가 아니라 Spark compute 부족을
해소한 scale-out으로 판정한다.

## 가린 identity 연결

| alias | Run | Job | application UID | snapshot | dataset |
| --- | --- | --- | --- | --- | --- |
| Run A | `39deb4fbf2c3` | `0510537d21cb` | `a778d9e1b892` | `98953d5819f4` | `65bfbe90dfe2` |
| Run B | `146d00a2580a` | `eba03f3f88ea` | `c755415cd150` | `f7b27d87a8c7` | `5e0a7769292f` |
| Run C | `200be6a1cacb` | `eecb5c3b54de` | `65d0bae3f0b6` | `860280b05e9b` | `852ea25c2eb3` |

| alias | consumer group | Iceberg table | output | checkpoint |
| --- | --- | --- | --- | --- |
| Run A | `49d163cfbaf1` | `4450e79248d9` | `2a636432bf9d` | `73af93d54dbb` |
| Run B | `8ac7d4ad290f` | `616bac666250` | `14357642f355` | `aa68f1c0cde2` |
| Run C | `8dec767cb777` | `9e61b93e9feb` | `173af0ade47c` | `81d75c49e411` |

각 열은 `3/3 unique`다. Run별 expected/Spark input/Spark output/Trino exact
snapshot 행은 `100/100/100/100`, 전체는 `300/300/300/300`이다. data file과
Catalog materialization은 각각 `3`이다. 상세 Run/data 판정은
[multi-Spark live evidence](eks-day17-b-multi-spark-live-evidence.md)를
참조한다.

## 실패, 재시도, cleanup

- 첫 제출 receipt는 기존 Job 상태 충돌 때문에 `1`개 제출, `2`개 미제출이었다.
  두 번째 receipt는 `2/1`, 세 번째는 `3/0` 제출로 끝났다. partial receipt를
  덮어쓰거나 자동 보충하지 않았다.
- 동적 Maven 의존성을 사용한 3-Run campaign에서는 Run B만 성공하고 A/C가
  의존성 resolution 단계에서 실패했다. 이는 격리 충돌이나 권한 문제가 아니라
  새 Node에서의 비결정적 runtime 다운로드로 판정했다.
- 필요한 JAR을 immutable image에 포함한 뒤 새 receipt로 clean campaign을 한 번
  실행했고, 최종 Run A/B/C 모두 성공했다. 실패 Run의 결과를 최종 성공 결과로
  대체하거나 합산하지 않았다.
- 동일 Run 경합의 Catalog 복구는 같은 DAG Run과 저장된 Spark result를 사용했다.
  새 외부 실행, SparkApplication, snapshot을 만들지 않았다.
- cleanup audit 시 임시 Job/Pod/ConfigMap/Secret과 로컬 load process가 이미
  `0`이어서 삭제 명령이나 강제 Pod 삭제는 실행하지 않았다. campaign이 Node
  baseline `0`으로 복귀한 뒤 시작된 별도 workload도 건드리지 않았다.

## 최종 성공 기준

| 판정 항목 | 실제 결과 | 판정 |
| --- | --- | --- |
| FastAPI scale-out | HPA `2 → 6` | PASS |
| FastAPI 동일 Run 안전성 | 외부 실행/application/snapshot/materialization `1/1/1/1` | PASS |
| Spark 동시성 | 격리 Run `3`, driver/executor 각 `3` | PASS |
| Node scale-out | Pending 뒤 Spark Node `0 → 1 → 2`, 같은 Pod Running | PASS |
| 데이터 정합성 | expected/Spark/Trino `300/300/300/300`, materialization `3` | PASS |
| Run 격리 | group/table/output/checkpoint/snapshot/dataset 모두 `3/3 unique` | PASS |
| scale-in | HPA `2`, Spark Node `0`, active Spark Pod `0` | PASS |
| 서비스 연속성 | `114,494` requests, non-2xx/5xx `0/0` | PASS |
| Continuous 경계 | 새 session/process `0` | PASS |
| 통합 evidence | timestamp와 alias/short hash가 하나의 fail-closed receipt에 연결 | PASS |

## 실행 범위와 인계

실제로 수행한 것은 단계별 50/200 RPS read-only API 부하, HPA 6개 target의 동일
Run 경합, baked runtime을 사용한 격리 Spark Run 3개, exact snapshot/Catalog
read-only 검증, scale-in/cleanup read-only audit다.

4번째 Spark Run, IAM/NodePool/RBAC 확장, NodePool 정책 변경, 강제 Pod 삭제,
CloudWatch 통합, EC2 rollback 전환은 수행하지 않았다. NodePool contract와
platform event는 [Phase 12 NodePool 문서](eks-phase-12-auto-mode-node-pools.md)와
[Day 14 runtime evidence](eks-day14-runtime-evidence.md)를 링크하며 이 문서에
중복 복사하지 않는다.

Pair B PR 범위는 HPA/resource 설정, load/concurrency 검증기, sanitizer 테스트,
Pair B evidence로 제한한다. Pair A 소유 NodePool/Terraform 변경과 broad
IAM/RBAC 확장은 포함하지 않는다. 이 브랜치에 이미 포함된 IAM 변경은 Day 17
전용 scale consumer group 4개를 exact allowlist로 추가한 계약뿐이며 wildcard
확장이나 실험 중 권한 변경은 없었다.

## Pair B PR 운영 인계

### FastAPI HPA와 부하 시작·종료

FastAPI HPA는 `autoscaling/v2`, `minReplicas=2`, `maxReplicas=6`, CPU target
`60%`다. scale-up stabilization은 `0초`, 최대 증가는 `30초마다 2개`이고
scale-down stabilization은 `300초`, 최대 감소는 `60초마다 1개`다. HPA가
활성화되면 Deployment의 고정 `replicas` 필드는 렌더링하지 않는다.

```bash
bash scripts/verify-eks-web-workloads.sh

export ASKLAKE_EKS_CLUSTER_NAME='<reviewed-cluster>'
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY17_LOAD_CONFIRM=run-read-only-api-load

export ASKLAKE_DAY17_LOAD_RATE=50
export ASKLAKE_DAY17_LOAD_DURATION_SECONDS=60
bash scripts/run-eks-day17-api-load.sh

export ASKLAKE_DAY17_LOAD_RATE=200
export ASKLAKE_DAY17_LOAD_DURATION_SECONDS=600
bash scripts/run-eks-day17-api-load.sh
```

정상 종료는 bounded duration 만료이며 조기 종료는 같은 터미널에서 `Ctrl-C`다.
종료를 위해 HPA나 Pod를 삭제하지 않는다. `pgrep -f
'[r]un-eks-day17-api-load'`가 비어 있고 아래 cleanup audit의 local load process
수가 `0`이면 background 부하가 남지 않은 것으로 판정한다.

### background 중복 없음 판정

동일 logical Run을 Ready FastAPI target 6개에 동시에 보낸 뒤 RDS
owner/generation, Airflow DAG run, 외부 실행, SparkApplication UID, Iceberg
snapshot, Catalog materialization의 cardinality를 비교한다.

```bash
bash scripts/run-eks-day17-hpa-race.sh --preflight
export ASKLAKE_DAY17_REUSE_CONFIRM=reuse-persisted-bounded-fixture
bash scripts/run-eks-day17-hpa-race.sh --prepare-reuse
export ASKLAKE_DAY17_RACE_CONFIRM=run-one-day17-hpa-race
bash scripts/run-eks-day17-hpa-race.sh --run
```

성공 기준은 generation이 단조 증가하되 owner가 하나이고 외부 실행,
SparkApplication UID, snapshot, materialization이 각각 정확히 `1`인 것이다.
이번 결과는 `1/1/1/1`, Continuous 신규 session/process `0`이었다.

### 동시 Spark Job `3 → 4` 계약과 격리

runner는 사전 승인된 세 slot을 먼저 제출한다. 각 slot은
`runId → jobId → MSK group → Iceberg table` exact mapping을 가지며 동일 slot
advisory lock 경합은 Airflow 호출 전에 거절된다. output과 checkpoint도
run-specific prefix를 사용하고 RDS에 동일 identity chain을 저장한다.

```bash
bash scripts/run-eks-day17-multi-spark.sh --preflight
export ASKLAKE_DAY17_MULTI_SPARK_CONFIRM=submit-three-isolated-spark-runs
bash scripts/run-eks-day17-multi-spark.sh --run
```

설정 계약은 기본 3개, 최대 4개 scale slot을 허용하지만 네 번째 Run은 자동
추가하지 않는다. 세 Run으로 Pending과 Spark Node 증가가 관찰되지 않을 때만
새 exact identity를 가진 네 번째 slot, private receipt, 재실행 preflight,
별도 confirmation을 준비한 뒤 후속 runner에서 제출한다. 이번 실험은 세
Run으로 Pending과 Node scale을 확인했으므로 네 번째 Run은 만들거나 실행하지
않았다.

### 결과 검증과 cleanup

```bash
export ASKLAKE_DAY17_MULTI_SPARK_RECEIPT=/private/tmp/asklake-day17-multi-spark-baked-receipt.json
export ASKLAKE_DAY17_MULTI_SPARK_RESULTS=/private/tmp/asklake-day17-multi-spark-results.json
bash scripts/verify-eks-day17-multi-spark-results.sh --verify

export ASKLAKE_DAY17_MULTI_SPARK_OBSERVER=/private/tmp/asklake-day17-multi-spark-observer.jsonl
export ASKLAKE_DAY17_CLEANUP_AUDIT=/private/tmp/asklake-day17-cleanup-audit.json
bash scripts/audit-eks-day17-cleanup.sh --audit

node --test scripts/test-eks-day17-final-receipt.mjs
node scripts/build-eks-day17-final-receipt.mjs
```

검증과 audit는 read-only/fail-closed다. cleanup audit가 임시
Job/Pod/ConfigMap/Secret, active SparkApplication, local load process를 모두
`0`으로 확인한 경우 삭제 명령을 실행하지 않는다. durable Run, snapshot,
materialization은 evidence이므로 보존한다.

### Airflow·Trino General selector 처리

desired workload contract에서 Airflow API server, scheduler, DAG processor,
migration Job과 Trino coordinator는 모두
`asklake.io/workload-class=general`, `kubernetes.io/arch=amd64`를 요구한다.
values schema는 Spark workload class나 ARM64 override를 거절하고
`scripts/verify-eks-workloads.sh`는 Airflow 4개 Pod template과 Trino 1개
template의 selector를 렌더링 검증한다.

PR 머지 과정에서는 live Helm upgrade를 실행하지 않는다. 다음 배포자는 먼저
server-side dry-run을 수행하고 적용 후 Airflow·Trino Pod가 General Node에만
배치되었는지 확인해야 한다.

### 최종 image receipt와 커밋

- private receipt:
  `infra/eks/delivery/dev-day17-multi-spark.image-receipt.json`
  (`.gitignore` 대상, mode `0600`)
- image source commit:
  `125c0d3396b5369372c42f371a5f24a79743ea1b`
- receipt SHA-256 short hash: `35ed8b7e13e5`
- platform: `linux/amd64`
- image roles: Frontend, Backend, Airflow, Spark runtime, Trino
- formal verifier: `node scripts/verify-eks-image-receipt.mjs ...` PASS

위 커밋 이후 변경은 chart, 검증기, 실험 runner와 evidence이며 image runtime
내용은 바꾸지 않았다. 최종 Pair B PR head와 pair1 merge commit은 PR 본문과
GitHub merge 기록에 남긴다.
