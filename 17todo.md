# 17todo

> Pair B 개인용 2026-07-17 금요일 작업 메모. 실행 기준은 `/Users/sisu/Downloads/eks-roadmap.md`의 **7/17 금요일 담당표와 Merge 통과 조건**이다.
>
> 확인한 roadmap SHA-256: `c712480e5afc670852040e5de5d4a3f56746066889feb94ceeb8b524b0911d2c`
>
> 이 파일은 Git에 add/commit하지 않는다. A의 NodePool·node 용량·label/taint·autoscaling event 업무를 B 할 일로 바꾸지 않는다. A 입력이 없으면 B가 대신 만들지 않고 blocker로 기록한다.

## 17일에 최종적으로 보여야 하는 결과

사용자가 AskLake에 API 부하와 여러 batch Job을 동시에 주면, FastAPI Pod와 Spark용 Node가 자동으로 늘어나고 모든 Job이 서로의 MSK group·Iceberg 결과를 침범하지 않은 채 Catalog까지 성공한 뒤, 부하가 끝나면 Pod와 빈 Node가 다시 줄어야 한다.

```text
FastAPI 2 Pods + General/Spark NodePool 준비
↓
API 부하 + 격리된 bounded Job 3~4개 동시 실행
↓
FastAPI HPA 2 → 6 Pods
+ SparkApplication별 driver/executor 생성
↓
Spark Pod Pending 관찰
↓
A의 Spark NodePool이 새 Node 생성
↓
Pending Pod Running
↓
각 runId가 MSK → Iceberg → Trino → Catalog success
↓
부하와 Job 종료
↓
FastAPI 2 Pods 복귀 + 빈 Spark Node 제거
```

FastAPI Pod 수나 Node 수만 늘었다고 완료가 아니다. **확장·중복 방지·데이터 정합성·축소** 네 가지가 한 실행 기록에서 모두 보여야 7/17 결과물이다.

## 오늘의 시작점과 끝점

### 시작점 — 7/16까지 실제로 확인된 것

- `run-hash-cdf6acf8f096` 한 건이 Airflow → SparkApplication → MSK 100건 → Iceberg snapshot → Trino → Catalog까지 `success`였다.
- 같은 성공 `runId`를 다시 호출해도 SparkApplication, Iceberg snapshot, Catalog materialization이 하나로 유지됐다.
- FastAPI는 2 replica에서 RDS lease로 같은 논리 실행의 중복을 차단했다.
- General/Spark custom NodePool과 Metrics Server는 A의 14일차 실제 환경 증거에서 `Ready`와 scale-out/in을 통과했다.
- 현재 `asklake-web` chart에는 FastAPI resource request/limit 입력은 있지만 HPA resource는 아직 없다. 정적 검증도 HPA를 금지하고 있어 오늘 B 변경이 필요하다.

### 끝점 — 7/17 Merge 통과 상태

- FastAPI HPA가 실제 부하에서 roadmap의 최종 evidence 목표인 `2 → 6 → 2`로 움직인다.
- HPA 전 구간에서 선택한 하나의 논리 `runId`는 한 owner, 한 SparkApplication, 한 결과만 가진다.
- 격리된 bounded Job 3~4개가 동시에 driver/executor를 만든다.
- 기존 Spark Node 용량을 넘은 Pod가 실제 `Pending`이 되고, 새 Spark Node가 생긴 뒤 `Running`이 된다.
- 각 Job은 고유 MSK consumer group, `runId`별 output, 고유 Iceberg target/Catalog materialization을 사용하고 모두 `success`가 된다.
- 부하와 Job이 끝난 뒤 FastAPI는 2개로, Spark Node는 실행 전 기준선으로 돌아간다.
- 위 전 과정을 시간순 receipt 하나로 재구성할 수 있다.

## 오늘 B가 만드는 결과물

| B 결과물 | 완료 증거 |
| --- | --- |
| FastAPI HPA와 검증된 CPU/memory request·limit | `autoscaling/v2` HPA가 FastAPI Deployment만 대상으로 하고 `min=2`, `max=6`이며 Metrics가 정상 표시됨 |
| API 부하 실행 경로 | 부하 시작·종료 시각, 요청 수, 오류 수, HPA current/desired replica 변화 |
| HPA 중 background 중복 방지 | 선택한 동일 `runId`의 실행 경합에서 실제 외부 실행·SparkApplication·결과가 각각 1개 |
| 동시 Spark Job 부하 시나리오 | 3~4개 `runId`와 각 SparkApplication UID, driver/executor resource, terminal 상태 |
| Job별 격리 계약 | 각 Run의 consumer group, output prefix, Iceberg table, snapshot, Catalog dataset이 서로 다름 |
| Node 확장과 축소 연결 증거 | Pending Pod → 새 Node → Running → Job 종료 → 빈 Node 제거의 timestamp 연결 |
| 금요일 통합 receipt | FastAPI/HPA, SparkApplication, Node, MSK, Iceberg/Trino/Catalog 결과를 한 표로 연결 |

## A와 B가 합쳐지는 지점

| 단계 | A가 제공하는 것 | B가 하는 것 | 합쳐졌을 때 보이는 결과 |
| --- | --- | --- | --- |
| 1. 실행 기반 | Metrics Server, General NodePool, Spark Data NodePool | FastAPI request/limit과 HPA를 기존 FastAPI Deployment에 연결 | API 부하가 HPA replica 증가로 바뀜 |
| 2. 배치 경계 | `general`/`spark` label, Spark taint, pool별 최대 CPU/memory | driver/executor selector·toleration·request를 사용해 동시 Job 생성 | 일반 Pod와 Spark Pod가 각 NodePool에 배치됨 |
| 3. 실제 확장 | Spark NodePool scale-out/in 정책과 실제 capacity | 기존 용량보다 크지만 A의 상한보다 작은 총 request를 발생 | Spark Pod Pending 후 새 Node에서 Running |
| 4. 데이터 접근 | 승인된 MSK group 범위와 S3/Iceberg 권한 | 각 Run에 고유 group/output/table을 부여하고 bounded E2E 실행 | 3~4개 Run이 서로 충돌하지 않고 모두 Catalog success |
| 5. 관찰 | NodePool/Node autoscaling event | HPA·Pod·Run·SparkApplication·데이터 결과 시각을 수집 | 한 timeline으로 원인과 결과를 설명 가능 |
| 6. 비용 회수 | consolidation/scale-in 정책 | 부하 중단, Job 종료, 임시 load resource 정리 | FastAPI 2개 복귀와 빈 Node 제거 |

### 역할 경계

A 업무는 B 체크박스에 넣지 않는다.

- A: General/Spark NodePool 생성·수정, label/taint, 최대 CPU/memory, capacity type, consolidation/scale-in 정책, autoscaling event 수집 경로
- B: FastAPI HPA, FastAPI/Spark resource request·limit, API 부하, 동시 Job, Run별 격리, 결과 정합성, B 실행 receipt
- 공동 확인: B가 만든 부하가 A의 NodePool에서 실제 Node 증가/감소로 이어졌고, 그 사이 모든 AskLake 결과가 정확한지 판정

B는 A의 `asklake-auto-mode` chart나 Terraform state를 수정하지 않는다. 현재 FastAPI는 `asklake-web` release가 소유하므로, B는 별도 경쟁 release를 만들지 않고 기존 release에 HPA/resource 변경만 합친다.

## 가장 먼저 닫아야 하는 통합 게이트

목요일의 단일 smoke 설정을 그대로 복제해 동시에 실행하면 안 된다.

- 현재 단일 smoke group `asklake-eks-mvp-spark-v1`을 여러 Job이 공유하면 Kafka partition을 나눠 가져 각 Job의 expected count가 깨질 수 있다.
- 현재 단일 target `iceberg.asklake.eks_mvp_fixture`에 여러 `replace` Job이 동시에 쓰면 snapshot/table 결과가 서로 덮일 수 있다.
- 따라서 동시 Run마다 아래 네 값이 달라야 한다.

```text
consumerGroup: <A가 승인한 scale-test group prefix>-01..04
output:        eks-mvp/output/<runId>
icebergTable:  iceberg.asklake.4450e79248d9..04
catalog:       각 runId의 별도 materialization
```

A가 승인한 MSK consumer group IAM 범위가 위 패턴을 허용하지 않으면 실행을 시작하지 않는다. B가 임의 group을 만들거나 권한 경계를 넓히지 않고 A input blocker로 남긴다.

## 오늘의 순서형 Pair B 체크리스트

### 1. 목요일 성공 기준을 선행 조건으로 고정한다

- [x] `run-hash-cdf6acf8f096`의 FastAPI/Airflow/Spark/Iceberg/Trino/Catalog 최종 `success` 증거를 다시 확인한다.
- [ ] FastAPI 2 replica, Metrics API, General/Spark NodePool `Ready`를 읽기 전용으로 확인한다.
- [ ] 실제 FastAPI와 Spark driver/executor의 CPU/memory request·limit, 현재 Node allocatable/requested, pool 상한을 기록한다.
- [x] 목요일 단일 E2E가 깨졌거나 Metrics가 없으면 HPA/동시 부하를 시작하지 않는다.

완료: 정상 단일 Run과 현재 capacity를 기준선으로 남긴다.

### 2. A의 금요일 입력을 읽기 전용으로 인수한다

- [x] General NodePool 이름·label과 Spark NodePool 이름·label/taint를 확인한다.
- [x] pool별 최대 CPU/memory와 scale-in/consolidation 대기 시간을 확인한다.
- [x] autoscaling event를 볼 수 있는 명령 또는 handoff 위치를 확인한다.
- [x] 3~4개 고유 consumer group 패턴이 Spark IAM과 runtime fail-closed 계약에서 허용되는지 확인한다.
- [x] 누락된 A 입력은 blocker로 기록하고 NodePool·IAM·Terraform을 B가 대신 수정하지 않는다.

완료: B가 만들 총 부하의 하한·상한과 group naming 경계가 확정된다.

#### 1~2번 현재 판정 — 최신 `origin/pair1` `0dd0453a`

2026-07-17 읽기 전용 재확인 결과다. 식별자·ARN·endpoint·digest·Secret 값은 기록하지 않는다.

| 확인 항목 | 현재 확인 결과 | 판정 |
| --- | --- | --- |
| 목요일 bounded E2E | 현재 RDS에서 `run-hash-cdf6acf8f096`가 Run/Airflow/Spark/Catalog 모두 `success`, `100 → 100`행, SparkApplication UID와 Iceberg snapshot 유지, 같은 `runId`의 Catalog materialization 1개, execution owner 반환으로 재확인됨 | 통과 |
| 현재 web baseline | FastAPI `2/2`, Frontend `2/2`, Collector `1/1`. 최신 Pair A collector evidence도 count scalar `100`, active slot `0`, Collector 교체 후 같은 Run 복구와 result page 1개를 확인함 | 통과 |
| Metrics Server | EKS add-on `v0.9.0-eksbuild.1`이 `ACTIVE`, health issue 0. 현재 사용자 RBAC에는 Pod Metrics 직접 조회 권한이 없음 | add-on 통과, 현재 사용자 관측 권한 blocker |
| FastAPI resource | Pod당 request `250m / 512Mi`, limit `1 CPU / 1Gi` | HPA 계산 기준 확정 |
| Spark resource | Run당 driver `1 CPU / 2.5Gi`, executor 1개 `2 CPU / 5Gi`, 합계 `3 CPU / 7.5Gi` | 동시 부하 계산 기준 확정 |
| General NodePool | `asklake-general`, label `general`, taint 없음, AMD64, On-Demand, `m`, generation `>5`, 상한 `8 CPU / 32Gi`, `WhenEmptyOrUnderutilized`, `5m`, budget `25%` | 확정 |
| Spark NodePool | `asklake-spark`, label `spark`, `asklake.io/workload-class=spark:NoSchedule`, AMD64, Spot/On-Demand, `m/r`, generation `>5`, 상한 `16 CPU / 64Gi`, `WhenEmpty`, `10m`, budget `25%` | 확정 |
| 현재 compute | General 관리형 Node 2대, 합계 원시 `4 CPU / 16Gi`. Spark Node 0대. 최근 단일 Spark 실행에서는 4 CPU/16Gi 타입과 2 CPU/16Gi 타입이 생성 후 제거됨 | 0→scale-out 기준선 확보 |
| 현재 app request | pair1 rollout의 이전 FastAPI 2개가 310초 drain 중일 때 `3.55 CPU / 7Gi`; 종료 후 안정 상태는 `3.05 CPU / 6Gi` | drain 종료 후 baseline 재캡처 필요 |
| autoscaling event | Kubernetes Event에서 `DisruptionTerminating → Drained → RemovingNode`를 식별자 없이 볼 수 있음. 같은 구간에 `FailedDraining`과 `TerminationGracePeriodExpiring`도 있어 최종 receipt에서 성공/실패 reason을 함께 기록해야 함 | 수집 경로 확정 |
| Spark Pod Identity | `asklake-spark` ServiceAccount association 정확히 1개 | 통과 |
| MSK group IAM | 실제 Spark 역할은 `DescribeGroup`/`AlterGroup`을 기본 group `asklake-eks-mvp-spark-v1` 하나에만 exact 허용함. wildcard/prefix 허용 없음 | 추가 3~4 group blocker |
| runtime slot | 현재 live `asklake-runtime`에는 `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`이 없음. 코드 fallback은 기본 group/table 1개뿐임 | 동시 Job blocker |
| Node allocatable/requested | 현재 사용자는 Node/NodePool/Pod Metrics 조회 RBAC가 없음. AWS 관리형 instance 규격과 Pod request 합계는 확인했지만 Kubernetes 실제 allocatable/requested 값은 직접 조회하지 못함 | 관측 권한 blocker |

현재 결론:

- 1번의 단일 E2E·web·resource 선행 조건은 통과했다.
- 2번의 NodePool 이름·placement·상한·scale-in·event 경로는 A에게 묻지 않고 실제 적용값으로 확정했다.
- 3번 시나리오의 용량 초안은 Spark 3개 `9 CPU / 22.5Gi`로 Spark pool 상한 `16 CPU / 64Gi` 안에 둔다. 4개는 `12 CPU / 30Gi`지만 3개로 Pending/scale-out이 보이지 않을 때만 추가한다.
- HPA `2 → 6`은 안정 상태 대비 `+1 CPU / +2Gi`이며 General 상한 안이지만 새 General Node를 유도할 수 있다.
- 추가 consumer group IAM과 live runtime slot이 열리기 전에는 동시 Spark Job을 실행하지 않는다. 같은 기본 group/table로 강행하지 않는다.

### 3. 하나의 재현 가능한 scale 시나리오를 잠근다

- [x] API 부하 대상은 데이터 변경이 없는 endpoint로 정하고, 별도 test `runId`로 background 중복 방지를 검증한다.
- [x] FastAPI 부하 시간·동시성·종료 조건을 고정한다.
- [x] Spark Job은 3개로 시작하고 Pending이 생기지 않을 때만 4개로 늘린다.
- [x] driver/executor 총 request가 현재 Spark 여유 용량은 넘지만 A의 pool 상한은 넘지 않게 계산한다.
- [x] 실험 전부터 HPA·FastAPI·Spark·관리형 NodePool·최근 scheduling event를 한 화면에서 보는 read-only observer를 준비한다.
- [ ] 각 Job의 fixture batch, group, output, Iceberg table과 예상 행 수를 실행 전에 표로 고정한다.
- [ ] 테스트 시작 전 FastAPI Pod 수, Node 수, active SparkApplication 수를 baseline으로 저장한다.

계획용 고정 예시는 `scale-17-01`부터 `scale-17-04`까지 사용한다. 실제 receipt에는 시스템이 발급한 `jobId`, `runId`, SparkApplication UID로 교체하되 번호 대응은 바꾸지 않는다.

#### 고정한 실행 초안

FastAPI:

- 대상: 외부 Backend ALB의 `GET /api/health`
- 이유: 데이터 변경이 없고 실제 RDS health 경로와 FastAPI CPU를 함께 통과한다.
- 부하: `50 RPS 60초 → 100 RPS 120초 → 200 RPS`, 전체 최대 10분, 동시 요청 상한 64, 요청 timeout 5초
- scale-out 종료: HPA desired/ready가 `6/6`으로 60초 유지
- 안전 중단: DB health false, 연속 transport 오류 5회, 5xx 1건, non-200 비율 0.1% 초과 중 하나
- scale-down 관찰: 부하 종료 후 HPA `2/2`와 종료 중 FastAPI Pod 0개까지 최대 15분. HPA stabilization 300초와 pair1의 `preStop` 310초를 모두 포함한다.
- 중복 방지: HPA 증가 구간에 하나의 전용 test `runId`를 같은 internal execute identity로 경합시키고, RDS owner/generation 1개, SparkApplication UID 1개, snapshot/materialization 1개인지 판정한다. 성공한 목요일 Run을 단순 조회한 것만으로 새 실행 경합 증거를 대신하지 않는다.

Spark:

| slot | consumer group 후보 | Iceberg table | output | 예상 행 수 | 현재 실행 가능 |
| --- | --- | --- | --- | ---: | --- |
| `scale-17-01` | `49d163cfbaf1` | `iceberg.asklake.4450e79248d9` | `eks-mvp/output/<runId>` | 100 | IAM/runtime 등록 전 불가 |
| `scale-17-02` | `8ac7d4ad290f` | `iceberg.asklake.616bac666250` | `eks-mvp/output/<runId>` | 100 | IAM/runtime 등록 전 불가 |
| `scale-17-03` | `8dec767cb777` | `iceberg.asklake.9e61b93e9feb` | `eks-mvp/output/<runId>` | 100 | IAM/runtime 등록 전 불가 |
| `scale-17-04` | `asklake-eks-mvp-spark-scale17-04` | `iceberg.asklake.eks_mvp_scale_17_04` | `eks-mvp/output/<runId>` | 100 | 3개로 Pending이 없을 때만 검토 |

- 3개 동시 request: `9 CPU / 22.5Gi`, 현재 Spark Node 0대, pool 상한 `16 CPU / 64Gi`
- 4개 동시 request: `12 CPU / 30Gi`, pool 상한 안이지만 3개로 Pending이 없을 때만 추가
- 실제 실행 직전에는 새 100건 fixture batch marker 하나를 네 slot 표에 고정하고, IAM policy의 group resource와 live runtime slot JSON이 exact 일치하는지 다시 확인한다.
- Spark 종료 후 empty consolidation 대기 `10m`을 존중하고 Node baseline 복귀를 최대 30분 관찰한다.
- 관찰 명령: `node scripts/watch-eks-day17-scale.mjs --interval 5 --record /private/tmp/asklake-day17-scale-observer.jsonl`
- 현재 사용자에게 Pod Metrics 직접 조회 RBAC가 없어 화면은 HPA aggregate CPU를 우선 사용한다. 권한이 생기면 같은 화면에 FastAPI/Spark aggregate CPU·memory가 자동으로 나타난다.

완료: 누가 다시 실행해도 같은 부하와 종료 조건을 재현할 수 있다.

### 4. FastAPI HPA와 resource 계약을 구현한다

- [x] 기존 `asklake-web` chart에 FastAPI 전용 `autoscaling/v2` HPA를 추가한다.
- [x] HPA는 FastAPI Deployment만 target으로 하고 `minReplicas=2`, `maxReplicas=6`을 유지한다. Frontend는 이번 HPA 대상이 아니다.
- [ ] FastAPI CPU/memory request·limit은 실제 baseline과 부하 목표를 근거로 정한다. test fixture 숫자를 production 권장값처럼 복사하지 않는다.
- [x] HPA metric threshold와 scale behavior는 선택 근거를 values/evidence에 남긴다. CPU·memory request/limit을 모두 두되 어떤 metric을 scaling 기준으로 썼는지 구분한다.
- [x] disabled 기본값은 HPA를 렌더하지 않고, enabled test values는 HPA 하나를 렌더하도록 schema와 verifier를 갱신한다.
- [x] Helm lint/template과 server-side dry-run을 통과한 뒤 기존 `asklake-web` release를 atomic upgrade한다.
- [x] Deployment selector, Service, ALB route, image digest, Secret reference가 HPA 추가 전과 같음을 확인한다.

2026-07-17 live 적용 결과:

- `asklake-web` revision `46 → 47`, HPA `2..6`, CPU target `60%`. 이후 live Backend image를 Helm 저장값과 다시 일치시키는 무롤아웃 reconciliation으로 revision `48`을 만들었다.
- 첫 HPA sample: current/desired `2/2`, CPU `1%`, `AbleToScale=True`, `ScalingActive=True`
- 첫 적용 직후 확인에서는 FastAPI Pod UID와 template revision이 같았지만 수초 뒤 Helm 저장 image가 실제 live Deployment보다 오래된 사실 때문에 FastAPI와 Collector rollout이 발생했다. 즉시 부하를 보류했고 Ready floor는 유지됐으며 drain 종료까지 기다렸다.
- live revision 46의 `asklake.io/runtime-config-revision` annotation을 FastAPI와 Collector 모두에 보존했다. 안정화된 현재 immutable Backend image를 private HPA values와 Helm revision 48에 다시 고정했으며, reconciliation 15초 뒤 Pod UID와 template revision이 모두 동일함을 확인했다.
- 후속 Helm preflight는 저장된 Helm manifest 비교만으로 완료하지 않고 candidate image와 실제 live FastAPI/Collector Deployment image의 exact 일치도 함께 확인해야 한다.
- 직접 Pod Metrics는 현재 사용자 RBAC로 계속 막혀 있지만 HPA controller의 aggregate CPU 수집은 통과했다.

관련 코드 경계:

- `infra/eks/helm/asklake-web/`
- `infra/eks/values/workloads/`
- `scripts/verify-eks-web-workloads.sh`
- 실제 부하·autoscaling 검증 runner와 evidence 문서

완료: FastAPI HPA가 실제 Deployment의 Metrics를 읽고 초기 desired replica 2를 유지한다.

### 5. API 부하로 FastAPI를 2개에서 6개로 늘린다

- [x] 부하 전 `/api/health`, HPA target, FastAPI ready replica `2/2`를 확인한다.
- [x] 정한 API 부하를 시작하고 HPA current/desired metric과 Pod 생성 시각을 연속 수집한다.
- [x] FastAPI ready replica가 중간에 4개 이상으로 증가하고 최종 6개까지 도달하는 것을 확인한다.
- [ ] 증가 중 ALB `/`와 `/api/health` 성공률, 5xx, readiness failure를 기록한다.
- [x] 새 Pod도 같은 image digest, ServiceAccount, runtime boundary와 RDS health를 가지는지 확인한다.

2026-07-17 live 결과:

- 50 RPS 60초는 2,997건, non-2xx/5xx/DB/transport failure `0`, p95 `272ms`였고 HPA CPU 최대 `23%`, replica `2 → 2`였다.
- 안정 기준선 복귀 후 100 RPS는 건너뛰고 목표 200 RPS를 120초 실행했다. 동시 요청 상한 64 때문에 955건을 발행하지 못해 실제 완료는 23,029건, 평균 약 192 RPS였다. non-2xx/5xx/DB/transport failure는 `0`, p95는 `282ms`였다.
- HPA CPU 최대 표본은 `190%`였고 `2 → 4 → 6`, FastAPI desired/ready/available `6/6/6`, General 관리형 Node `2 → 4`를 관찰했다.
- 부하 종료 후 HPA는 300초 안정화 뒤 60초마다 1개씩 `6 → 5 → 4 → 3 → 2`로 복귀했고 Deployment desired/ready/available `2/2/2`를 확인했다.
- 부하 중 `/api/health` 표본은 모두 정상이고 확장 직후 ALB rollout gate에서 `/`와 `/api/health` HTTP 200, RDS health `true`였다. 다만 Frontend `/`를 부하 전 구간에 연속 측정하지는 않았으므로 해당 체크박스는 아직 닫지 않는다.
- 상세 sanitized timeline은 `docs/eks-day17-b-fastapi-hpa-live-evidence.md`를 따른다.

완료: API 부하가 실제 FastAPI replica 증가로 이어지고 외부 서비스가 계속 응답한다.

### 6. HPA 전 구간에서 background 중복이 없는지 증명한다

- [x] FastAPI가 증가해 6개에 도달하는 동안 선택한 하나의 test `runId`에 실행 경합을 만든다.
- [x] RDS lease owner/generation과 경쟁 요청의 성공·`409` 또는 기존 결과 반환을 기록한다.
- [x] 해당 `runId`의 RDS Run row, SparkApplication UID, Iceberg snapshot, Catalog materialization이 각각 하나인지 확인한다.
- [x] HPA로 새로 생긴 Pod에서 EC2 소유 Continuous worker/sync가 시작되지 않았는지 확인한다.
- [x] replica 수가 많다는 이유로 scheduler tick이나 같은 논리 외부 실행이 중복되지 않았음을 receipt에 남긴다.

완료: `FastAPI replica 증가 ≠ 논리 작업 수 증가`임을 실제 `runId`로 증명한다.

2026-07-17 live 결과:

- HPA current/desired와 FastAPI Ready `6/6/6`에서 서로 다른 Pod 6개에 전용 test `runId`의 동일 실행 요청을 동시에 보냈다.
- 최종 직접 조회는 RDS Run `1`, Spark owner/attempt `1`, Spark generation `1`, 외부 실행 `1`, SparkApplication UID `1`, 새 Iceberg snapshot `1`, Catalog materialization `1`이었다.
- 최종 RDS generation은 `2`다. Spark lease generation `1`과, HPA scale-in으로 끊긴 Catalog 단계를 같은 DAG run에서 재개한 Catalog lease generation `2`이며 Spark 재실행은 아니다.
- 살아남은 access log에서 동일 Run의 HTTP `409 SPARK_RUN_ALREADY_EXECUTING` 3건을 복구했다. 경합은 6개 target에 발행했지만 scale-in으로 사라진 Pod 로그와 승자 연결 응답까지 모두 보존됐다고 주장하지 않는다.
- input/output/Trino rows는 `100/100/100`, data file `1`, 새 Continuous session/process `0`이었다. 최종 RDS/Airflow/Spark/Catalog 상태는 모두 `success`다.
- 현재 운영자 identity가 전용 fixture producer role을 assume할 권한은 없어 IAM을 넓히지 않고 새 producer 실행을 중단했다. exact 100-record marker가 고정된 기존 성공 fixture만 재사용했으며 전용 Run과 모든 output identity는 새로 생성했다.
- 식별자를 가린 timeline, 복구 과정과 성공 기준 표는 `docs/eks-day17-b-same-run-race-live-evidence.md`를 따른다. 원본 receipt는 저장소 밖 mode `0600` 파일에만 있다.

### 7. 격리된 Spark Job 3~4개를 동시에 시작한다

- [x] 각 Run에 고유 consumer group, output prefix, Iceberg table을 주입한다.
- [x] 각 Run의 expected count와 fixture batch marker를 RDS source boundary에 고정한다.
- [x] 거의 같은 시각에 3개 Job을 시작하고 필요할 때 4번째를 시작한다.
- [x] 각 Run이 서로 다른 SparkApplication name/UID와 driver/executor를 가지는지 확인한다.
- [x] driver/executor가 Spark selector/toleration과 정한 resource request·limit을 사용하는지 확인한다.
- [x] 기존 EC2 Continuous topic/group/checkpoint/output을 참조하거나 변경하지 않았는지 확인한다.

완료: 서로 침범하지 않는 3~4개의 실제 AskLake batch 실행이 동시에 존재한다.

2026-07-17 live 결과:

- `scripts/watch-eks-day17-multi-spark.mjs`가 Run A/B/C의 RDS/Airflow/Spark/Catalog, SparkApplication UID hash, driver/executor phase, isolation `3/3 unique`, Node와 event를 5초마다 표시한다.
- sanitized JSONL은 `/private/tmp/asklake-day17-multi-spark-observer.jsonl` mode `0600`에만 기록한다.
- Run A/B/C 3개를 거의 동시에 한 번 제출했고 RDS/Airflow/Spark/Catalog가 모두 `success`로 끝났다. 요구 동시성을 3개로 충족해 4번째 Run은 시작하지 않았다.
- consumer group, Iceberg table, output, checkpoint, dataset은 모두 `3/3 unique`, 외부 실행과 SparkApplication UID도 `3/3 unique`였다.
- Run별 expected/input/output은 `100/100/100`, SparkApplication은 각각 정확히 하나였고 persisted UID와 Kubernetes UID가 일치했다.
- 실제 driver/executor spec의 Spark selector, exact toleration, resource request·limit을 대조했다. 원격 Maven package 실행은 `0`, 새 Continuous session/process는 `0`이었다.
- 식별자를 가린 timeline과 성공 기준은 `docs/eks-day17-b-multi-spark-live-evidence.md`를 따른다. 원본 campaign receipt는 저장소 밖 mode `0600` 파일로만 보존한다.

### 8. Pending Pod가 새 Spark Node에서 Running이 되는 흐름을 잡는다

- [x] 동시 Job 중 최소 한 driver/executor Pod의 `Pending`과 scheduling reason을 기록한다.
- [x] 그 Pending이 selector/taint 오류가 아니라 현재 Node 자원 부족 때문인지 확인한다.
- [x] A의 autoscaling event와 새 Spark Node 생성 시각을 기록한다.
- [x] 새 Node가 `Ready`가 되고 Pending Pod가 그 Node에서 `Running`이 되는 것을 확인한다.
- [x] General workload가 Spark tainted Node에 잘못 배치되지 않았는지 확인한다.
- [x] pool 상한 또는 AWS capacity 부족으로 Pending이면 결과를 성공으로 포장하지 않고 원인을 분리한다.

완료: `Spark 부하 → Pending → 새 Node → Running`이 같은 timeline에 연결된다.

2026-07-17 live 결과:

- driver 3개 `Pending → Running`, executor 3개 `Pending → Running`을 같은 observer timeline에서 기록했다.
- Spark Node는 baseline `0 → 1 → 2`로 증가했고 NodeClaim initialized/ready와 Node ready 뒤 Pending Pod가 Running으로 전환됐다.
- FailedScheduling에는 resource shortage 6건과, Spark selector 때문에 non-Spark Node가 제외된 selector/taint 신호가 각각 3건 있었다. 실제 SparkApplication spec이 의도한 selector/toleration과 일치하고 새 Spark Node에서 Running이 됐으므로 selector/taint 오설정으로 판정하지 않았다.
- FastAPI baseline `2` Ready와 General/Spark placement 정책은 유지됐다. observer가 과거 Pod-to-Node 원본 join을 보존하지 않는 한계는 evidence에 명시했다.
- campaign을 실패시킨 pool 상한 또는 AWS capacity 부족은 없었고 부하 종료 뒤 Spark Node는 다시 `0`으로 회수됐다.
- 상세 timeline과 해석은 `docs/eks-day17-b-multi-spark-live-evidence.md`를 따른다.

### 9. 모든 동시 Run의 데이터 결과를 끝까지 검증한다

- [x] 각 Run의 MSK input count와 Spark input/output count가 일치한다.
- [x] 각 Iceberg table에 비어 있지 않은 고유 snapshot과 data file이 생긴다.
- [x] Trino가 각 exact snapshot의 `_asklake_run_id` 행 수를 expected count와 같다고 확인한다.
- [x] Catalog에 각 Run의 materialization이 정확히 하나씩 생긴다.
- [x] 모든 Airflow DAG와 AskLake Run이 `success`이고 실패한 Run을 다른 Run 결과로 보완하지 않는다.
- [x] group, output, table, snapshot, datasetId가 Run 사이에 겹치지 않는지 교차 검사한다.

완료: Node가 늘어난 것뿐 아니라 3~4개 데이터 결과가 모두 정확하다.

2026-07-17 live 결과:

- `scripts/verify-eks-day17-multi-spark-results.sh --verify`를 기존 성공 receipt에 한 번 실행했다. 기존 FastAPI Pod 안에서 RDS read-only transaction과 Trino `SELECT`/`DESCRIBE`만 사용했고 새 Run, Job, Pod, SparkApplication이나 Kubernetes resource를 만들지 않았다.
- Run A/B/C 각각 fixture expected, Spark input/output, exact snapshot의 Trino `_asklake_run_id` 행 수가 `100/100/100/100`이었다. 합계는 `300/300/300/300`이다.
- Run별 exact snapshot에 data file `1`개와 양수 storage size가 있었고 전체 data file은 `3`개였다.
- RDS/Airflow/Spark/Catalog는 Run A/B/C 모두 `success`, generation `2`였으며 Catalog materialization은 Run별 정확히 `1`, 전체 `3`이었다.
- persisted Run → Job → dataset → source boundary → Spark execution/commit → Catalog → materialization identity chain을 Run별로 대조해 다른 Run의 결과로 보완되지 않았음을 확인했다.
- consumer group, Iceberg table, output, checkpoint, snapshot, dataset, Airflow DAG run은 각각 모두 `3/3 unique`였다.
- sanitized 결과는 `/private/tmp/asklake-day17-multi-spark-results.json` mode `0600`에 보존한다. 원본 private receipt의 식별자가 결과 파일에 포함되지 않았음을 자동 대조했다.
- 상세 성공 기준은 `docs/eks-day17-b-multi-spark-live-evidence.md`를 따른다.

### 10. 부하 종료 뒤 Pod와 Node가 줄어드는 것을 확인한다

- [x] API 부하를 중단하고 임시 load generator를 제거한다.
- [x] FastAPI HPA가 안정화 시간 뒤 desired/ready replica 2로 돌아오는 것을 확인한다.
- [x] 모든 driver/executor가 terminal이고 실행 Pod가 남지 않는지 확인한다.
- [x] A가 정한 consolidation 시간 안에 빈 Spark Node가 제거되고 Node 수가 baseline으로 돌아오는지 확인한다.
- [x] scale-in을 빨리 보려고 A의 NodePool 정책을 임의로 바꾸지 않는다.
- [x] 임시 Job/Pod/ConfigMap과 test object를 정리하되 최종 receipt에 필요한 Run/Catalog 결과는 보존한다.

FastAPI 축소 결과:

- HPA는 `6 → 5 → 4 → 3 → 2`, Deployment desired/ready/available `2/2/2`로 돌아왔다.
- `preStop 310초` 뒤 FastAPI active/ready `2/2`, terminating `0`을 확인했다.
- 최종 ALB steady gate는 healthy target `4`, draining target `0`, 외부 `/`와 `/api/health` HTTP 200, RDS health `true`였다.
- load runner는 로컬 process로 종료됐고 cluster에 임시 load Job/Pod/ConfigMap을 만들지 않았다. status/observer JSONL은 저장소 밖 evidence로 보존한다.
- multi-Spark Run A/B/C가 모두 success가 된 시점에 active driver/executor는 `0`이었고, observer에서 Spark Node peak `2`가 `0`으로 돌아온 최초 시각은 `20:43:01 KST`였다. 그 전에 NodeClaim `Drained`와 Node/NodeClaim `DisruptionTerminating`, Node `RemovingNode` 신호를 기록했다.
- 최종 cleanup audit는 HPA current/desired `2/2`, FastAPI Deployment replicas/updated/ready/available/unavailable `2/2/2/2/0`, FastAPI Pod `2` Ready·terminating `0`을 확인했다.
- Day 17 임시 Kubernetes Job/Pod/ConfigMap/Secret과 로컬 load generator process는 모두 `0`이었다. 삭제할 대상이 없어 삭제 명령은 실행하지 않았다.
- durable Run/snapshot/materialization `3/3/3`과 sanitized observer/result receipt는 보존했다. cleanup audit는 `/private/tmp/asklake-day17-cleanup-audit.json` mode `0600`에 있다.
- campaign이 이미 Spark Node `0`으로 복귀한 뒤 시작된 별도 Spark workload는 이번 cleanup 대상이 아니므로 건드리지 않았다.

완료: 부하가 사라지면 FastAPI와 Spark compute 비용 자원이 실제로 회수된다.

### 11. 금요일 통합 receipt와 PR 인계를 끝낸다

- [x] 아래 두 timeline을 하나의 evidence에 기록한다.

```text
API load start
→ HPA 2 → 6
→ 동일 runId 외부 실행 1개
→ API load stop
→ HPA 2

동시 runId 3~4개
→ SparkApplication/driver/executor
→ Pending reason
→ 새 Spark Node
→ Running
→ MSK/Iceberg/Trino/Catalog success
→ driver/executor 종료
→ 빈 Node 제거
```

- [x] 각 timestamp, HPA replica, Pod/Node 수, runId, SparkApplication UID, group, table, snapshot, datasetId를 연결한다.
- [x] A의 NodePool event와 B의 Run/data evidence를 복사해 중복 문서를 만들지 말고 상호 링크한다.
- [x] 실제 실행한 항목과 미실행 항목을 구분하고 실패/재시도/cleanup을 기록한다.
- [x] Secret, token, DB URL, AWS account/ARN, private endpoint, static credential은 문서·로그·PR에 넣지 않는다.
- [x] B PR에는 HPA·resource·load/concurrency 검증과 B evidence만 넣고 A의 Terraform/NodePool 변경을 섞지 않는다.

통합 결과:

- fail-closed generator가 API와 Spark timeline, exact-one/격리/data/scale-in
  판정 16개를 하나의 sanitized receipt로 만들었고 모두 통과했다.
- 원본 식별자는 receipt와 문서에 넣지 않고 Same-Run Race와 Run A/B/C alias,
  12자리 short hash만 연결했다.
- 최종 machine receipt는
  `/private/tmp/asklake-day17-final-receipt.json` mode `0600`, 리뷰용 문서는
  `docs/eks-day17-final-integrated-evidence.md`다.
- 이전 partial 제출 `1/3`, `2/3`, clean 제출 `3/3`, 동적 Maven campaign의
  A/C 실패와 baked runtime clean campaign `3/3` 성공을 구분했다. 실패 결과를
  최종 성공으로 대체하지 않았다.
- Pair A NodePool 계약과 runtime event는 기존 문서에 링크했고 Terraform,
  NodePool, IAM, RBAC 변경은 Pair B 범위에 포함하지 않았다.

완료: 리뷰어가 receipt 하나로 “왜 Pod/Node가 늘었고, 어떤 Run들이 정확히 끝났으며, 언제 다시 줄었는지” 설명할 수 있다.

## 금요일 최종 판정표

| 판정 항목 | 실제 결과 | 판정 |
| --- | --- | --- |
| FastAPI scale-out | HPA `2 → 6` 실제 관찰 | PASS |
| FastAPI 안전성 | 같은 논리 Run의 외부 실행/application/snapshot/materialization `1/1/1/1` | PASS |
| Spark 동시성 | 격리된 Run `3`, driver/executor 각 `3` | PASS |
| Node scale-out | 자원 부족 Pending → Spark Node `0 → 1 → 2` → Running | PASS |
| 데이터 정합성 | expected/Spark/Trino `300/300/300/300`, materialization `3` | PASS |
| 격리 | group/output/table/snapshot/dataset/checkpoint 모두 `3/3 unique` | PASS |
| scale-in | FastAPI `2`, active Spark Pod `0`, Spark Node `0` | PASS |
| 서비스 연속성 | `114,494` requests, non-2xx/5xx `0/0` | PASS |
| Continuous 경계 | 새 session/process `0` | PASS |
| evidence | alias/short hash와 timestamp가 하나의 sanitized receipt에 연결 | PASS |

하나라도 빠지면 7/17 완료가 아니다. 특히 Pod/Node 증가만 있고 데이터 검증이 없거나, Job은 성공했지만 Pending→새 Node 증거가 없으면 금요일 Merge 조건을 통과하지 않는다.

## 오늘 하지 않는 것

- A의 General/Spark NodePool, label/taint, pool 상한, capacity type, consolidation 정책 생성·수정
- A의 autoscaling event 수집 기반을 B가 새로 소유하는 일
- image digest 기준 Rolling Update/rollback 시연 — 7/18 범위
- FastAPI/Spark Pod 강제 삭제와 장애 복구 반복 — 7/18 범위
- CloudWatch 통합 — 7/18 범위
- 기존 EC2 rollback 실제 전환 — 7/18 이후 범위
- 기존 Kafka Continuous worker의 EKS 이전 — 후속 Phase
- FastAPI 외 Frontend/Airflow/Trino HPA 추가
- scale-in을 빨리 보이기 위한 A 소유 운영값 임의 축소

## 즉시 중단하고 blocker로 기록할 조건

- 목요일 단일 bounded E2E가 더 이상 재현되지 않음
- Metrics API 또는 HPA target이 `unknown`
- FastAPI request가 없어 HPA 계산 기준이 성립하지 않음
- A의 Spark NodePool 상한이 3개 Job request보다 작거나 AWS capacity가 없음
- 고유 MSK consumer group IAM 범위가 승인되지 않음
- Run별 output/Iceberg target을 분리할 수 없음
- Pending 원인이 자원 부족이 아니라 selector, taint, image pull, IAM, Secret 오류임
- 하나의 Run에서 SparkApplication, Iceberg snapshot 또는 Catalog materialization이 중복됨
- 테스트가 기존 EC2 Continuous topic/group/checkpoint/output과 겹침

## 오늘을 다른 엔지니어에게 설명하는 한 문장

“B가 FastAPI와 동시 Spark Job 부하를 만들고 결과 격리를 증명하면, A의 NodePool 기반이 그 부하를 받아 Pod와 Node를 실제로 늘렸다가 줄이며, 최종적으로 모든 `runId`가 충돌 없이 Catalog까지 성공하는 날입니다.”
