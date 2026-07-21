# EKS 7/17 Pair A autoscaling 기준선

이 문서는 Issue #894의 Phase 0 읽기 전용 기준선이다. 7/17 로드맵의 Pair A 범위인 General/Spark NodePool 자동확장 검증을 시작하기 전에 Git, 저장소 계약, live EKS 상태와 공유 환경 경합을 고정한다. 이 단계에서는 Terraform, Helm, AWS, Kubernetes workload를 변경하지 않았다.

실제 account ID, endpoint, ARN, node/Pod UID, IP, 전체 image digest와 Secret 값은 기록하지 않는다. 아래 수치는 dev 환경의 관찰값이며 다른 환경의 권장값이 아니다.

## Git 기준

- 작업 branch: `feat-#894`
- 기준 branch: `origin/pair1`
- 시작 commit: `0dd0453a`
- 시작 시점에 작업 branch와 `origin/pair1`은 정확히 일치했고 working tree는 깨끗했다.
- Issue #894는 `feature` label과 Pair A assignee로 열려 있다.

이전 pair1 실환경 검증 branch `docs-#860`에는 현재 `pair1`에 없는 rollout/runtime ConfigMap 순서, HPA-aware Backend replica 판정, bounded E2E identity guard와 최종 evidence 변경이 존재한다. 해당 branch에는 아직 PR이 없다. 따라서 Issue #894에서 같은 보완을 다시 작성하지 않고, 실제 autoscaling harness를 구현하기 전에 필요한 변경의 pair1 반영 경로를 먼저 확정한다.

## 저장소와 live workload의 차이

최신 `pair1`의 `asklake-web` chart는 `0.2.3`이며 HPA template을 소유하지 않는다. 현재 정적 web verifier도 HPA가 함께 렌더되면 실패하도록 되어 있다.

반면 live `asklake-web` release는 chart `0.3.0`이고 FastAPI HPA를 소유한다. 관찰 시점의 non-secret 계약은 다음과 같다.

- 최소 replica: 2
- 최대 replica: 6
- CPU target: 60%
- scale-up: 30초당 최대 2 Pod, stabilization 0초
- scale-down: 60초당 최대 1 Pod, stabilization 300초
- Backend request/limit: CPU `250m/1`, memory `512Mi/1Gi`

이 값들은 live에서 동작하지만 7/17 로드맵의 확정 운영 계약은 아니다. Pair B가 source branch/PR과 background 중복 방지 evidence를 전달하고 실제 부하 결과가 나오기 전에는 최대 replica 6과 CPU 60%를 최종값으로 승인하지 않는다. Pair A는 live manifest를 역으로 복사해 `pair1` 계약으로 만들지 않는다.

## EKS compute 기준

custom NodeClass와 NodePool은 모두 `Ready=True`다. built-in `system`, `general-purpose` pool도 유지된다.

### General pool

- label: `asklake.io/workload-class=general`
- taint: 없음
- capacity: On-Demand
- instance category/min generation: `m`, 6세대 이상
- pool limit: CPU 8, memory 32Gi
- consolidation: `WhenEmptyOrUnderutilized`, 5분
- disruption budget: 25%
- 관찰된 Ready AMD64 node: 3

### Spark pool

- label: `asklake.io/workload-class=spark`
- taint: `asklake.io/workload-class=spark:NoSchedule`
- capacity: Spot, On-Demand
- instance category/min generation: `m` 또는 `r`, 6세대 이상
- pool limit: CPU 16, memory 64Gi
- consolidation: `WhenEmpty`, 10분
- disruption budget: 25%
- 관찰된 Ready AMD64 node: 1

built-in `general-purpose` Ready AMD64 node도 1개 존재했다. custom pool 값은 이미 live에 적용된 환경값이지만, 금요일 실제 FastAPI·동시 Spark 부하와 scale-in 비용 증거가 없으므로 그대로 최종 승인하지 않는다.

## workload와 Metrics 기준

- Frontend, FastAPI, Trino result collector는 General selector를 사용하고 Ready/updated 상태였다.
- Airflow와 Trino coordinator는 Ready였지만 workload template에 General selector가 명시되지 않은 상태다. 금요일 배치 격리 감사에서 의도된 built-in/custom placement인지 별도로 확인한다.
- FastAPI HPA는 Metrics API에서 유효한 CPU metric을 읽고 최소 2 replica로 scale-down된 상태였다.
- `v1beta1.metrics.k8s.io` APIService는 Available이고 node 5개, namespace Pod 11개의 metrics row를 조회했다.
- Day 14에는 synthetic General workload의 node scale-out과 scale-in이 이미 검증됐다. 금요일에는 실제 FastAPI HPA와 동시 Spark driver/executor workload로 이 증거를 확장해야 한다.

## 공유 환경 경합

기준선 수집 시 `asklake-day17-hpa-race` label의 장시간 임시 Job 1개가 active였고 FastAPI 이전 Pod 1개가 terminating 중이었다. 해당 Job의 active deadline은 160분이며 Issue #894 소유 리소스가 아니므로 중지·삭제하지 않았다.

이 상태에서는 HPA/Node 변화의 원인을 Issue #894 부하로 귀속할 수 없다. 다음 조건을 모두 충족하기 전에는 실제 scale-out/scale-in 부하를 시작하지 않는다.

- 다른 active temporary Job 0
- active SparkApplication 0
- terminating/Pending workload 0
- ALB draining target 0
- Helm release와 Deployment generation이 관찰 구간 동안 고정
- Pair B HPA source와 실제 FastAPI/Spark 부하 계약 전달
- Issue #894 고유 run token과 cleanup owner 확정

읽기 전용 계약 감사와 검증 harness 구현은 이 exclusive window를 기다리지 않고 진행할 수 있다.

## Phase 0 판정

Phase 0의 기준선 수집은 완료했다. 유료 resource 생성이나 live mutation은 없었다.

다음 단계는 NodePool을 새로 만드는 일이 아니다. Phase 1에서 저장소와 live placement/limits/disruption 계약을 세부 대조하고, Phase 2에서 다른 작업과 구분되는 HPA/Node/Spark 관찰·cleanup harness를 만든다. 실제 부하를 가하는 Phase 3 이후는 공유 환경 경합 해소와 B source 계약을 진입 조건으로 둔다.
