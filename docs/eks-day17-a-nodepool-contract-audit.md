# EKS 7/17 Pair A NodePool 계약 감사

이 문서는 Issue #894 Phase 1의 읽기 전용 결과다. [Phase 0 기준선](eks-day17-a-autoscaling-baseline.md)에서 확인한 live custom NodePool을 저장소의 placement, resource request, taint, limits와 대조한다. Terraform, Helm, AWS와 Kubernetes workload는 변경하지 않았다.

## 감사 결과 요약

General/Spark NodeClass와 NodePool의 live spec은 적용된 비공개 Helm values와 일치했고 모두 `Ready=True`였다. Spark driver/executor의 selector와 toleration도 저장소 schema, template와 완료된 실제 SparkApplication에서 일치했다.

그러나 일반 workload 배치는 모두 같은 수준으로 강제되지 않는다. Frontend, FastAPI와 Trino result collector는 `asklake.io/workload-class=general`을 명시한다. Airflow 세 Deployment는 selector 없이 현재 General node에 배치됐고, Trino coordinator는 selector 없이 built-in `general-purpose` node에 배치됐다. 현재 위치는 scheduler 결과일 뿐 재생성 뒤에도 유지되는 계약이 아니다.

Phase 12 문서는 Frontend, FastAPI, Airflow와 Trino를 General workload로 정의한다. 따라서 Airflow/Trino placement는 실제 부하 전에 workload chart owner와 대조해야 한다. Pair A가 live Deployment를 직접 patch하거나 NodePool taint로 강제하지 않는다. component Helm source에서 selector를 소유하고 server-side dry-run과 rollout 인수를 거쳐야 한다.

## General NodePool

현재 General pool 계약은 다음과 같다.

- On-Demand, `m` category, generation 6 이상, AMD64
- CPU 8, memory 32Gi pool limit
- `WhenEmptyOrUnderutilized`, 5분 consolidation
- disruption budget 25%
- termination grace 30분, expiry 480시간

감사 시점에 General pool은 node 3개와 CPU 6, memory 약 22.8Gi의 provisioned capacity를 보고했다. 이 값은 Pod가 실제로 요청하거나 사용 중인 양이 아니라 NodePool이 생성한 node capacity다. pool limit까지 남은 CPU capacity는 2이므로 현재 instance shape가 유지되면 추가 node 한 대 정도의 여지만 있다.

FastAPI의 live request는 Pod당 CPU 250m, memory 512Mi다. 최소 2에서 최대 6까지 증가하면 추가 request는 CPU 1, memory 2Gi다. 기존 General node의 schedulable 여유에 들어갈 수 있으므로 FastAPI HPA만 올렸다는 이유로 General Node scale-out이 반드시 발생하지 않는다.

금요일 General 검증은 HPA 증가와 Node 증가를 별개 판정으로 남긴다. Node scale-out을 증명하려면 baseline allocatable/request를 먼저 계산하고, 다른 workload를 방해하지 않는 고유 synthetic pressure 또는 승인된 통합 부하로 실제 Pending을 만들어야 한다. Node 수를 수동으로 줄이거나 live workload request를 임의로 키워 결과를 만들지 않는다.

## Spark NodePool

현재 Spark pool 계약은 다음과 같다.

- Spot과 On-Demand, `m` 또는 `r` category, generation 6 이상, AMD64
- CPU 16, memory 64Gi pool limit
- `WhenEmpty`, 10분 consolidation
- disruption budget 25%
- `asklake.io/workload-class=spark:NoSchedule`
- termination grace 2시간, expiry 480시간

완료된 실제 SparkApplication은 driver와 executor 모두 Spark selector, AMD64 selector와 exact toleration을 사용했다. 일반 active Pod에는 Spark toleration이 없었다.

감사 시점에 완료 Spark workload가 정리된 뒤 Spark pool의 provisioned node/cpu/memory는 0이었다. 앞선 관찰 중 node 1개가 존재했다가 0으로 수렴했지만 Issue #894가 통제한 실행이 아니므로 금요일 scale-in evidence로 채택하지 않는다.

현재 Job 하나의 기본 request는 driver CPU 1·memory 약 2.5Gi, executor CPU 2·memory 약 5Gi로 합계 CPU 3·memory 약 7.5Gi다. 같은 계약으로 3개 Job은 CPU 9·memory 약 22.5Gi, 4개 Job은 CPU 12·memory 약 30Gi를 요청한다. pool limit 안이지만 instance 선택, DaemonSet overhead와 bin-packing 때문에 실제 배치 가능 수를 보장하는 계산은 아니다. 3개부터 시작해 4개로 올리고 Pending reason과 생성 node를 관찰한다.

## 정적 검증의 현재 범위

다음 검증은 모두 통과했다.

- `scripts/verify-eks-auto-mode-node-pools.sh`
- `scripts/verify-eks-workloads.sh`
- `scripts/verify-eks-foundation.sh`
- Helm lint와 기존 NodePool/Spark schema failure fixture

현재 검증은 custom NodePool의 생성 계약과 Spark selector/toleration을 확인한다. component-scoped Airflow/Trino release가 General selector를 갖는지, live workload가 의도한 pool에 배치됐는지, HPA/Node 전이 중 release generation이 고정되는지는 하나의 금요일 gate로 검사하지 않는다. 이 부분은 Phase 2 harness 보완 대상이다.

## Phase 1 판정과 다음 진입 조건

Phase 1 계약 감사는 완료했다. NodePool을 다시 생성하거나 limits를 지금 변경할 근거는 없다.

Phase 2에서는 다음을 구현한다.

- source와 live의 NodePool spec equality 검사
- component별 selector/toleration과 실제 scheduled pool 검사
- HPA/Deployment/Helm identity 고정 검사
- baseline node capacity와 workload request를 분리한 evidence
- General/Spark scale-out, scale-in과 cleanup을 같은 run token으로 추적하는 harness
- 식별자와 비용 민감값을 Git evidence에서 제거하는 redaction

실제 부하 단계는 Airflow/Trino placement ownership, Pair B HPA source, 동시 Spark Job 격리 계약과 shared-cluster exclusive window가 모두 준비된 뒤 시작한다.

