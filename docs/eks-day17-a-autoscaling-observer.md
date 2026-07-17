# EKS 7/17 Pair A autoscaling 관찰 하네스

이 문서는 Issue #894 Phase 2의 결과다. 실제 부하를 만들기 전에 General/Spark NodePool, workload placement, FastAPI HPA와 release identity를 같은 실행 단위로 관찰하고, 다른 작업의 변경이나 cleanup 누락을 검출하는 읽기 전용 하네스를 정의한다.

## 구현 결과

`scripts/capture-eks-day17-autoscaling-evidence.sh`는 `baseline`, `sample`, `final` 세 시점의 스냅샷을 하나의 evidence에 누적한다. 실행 토큰 원문은 저장하지 않고 16자리 fingerprint로만 연결한다. Kubernetes와 Helm에는 조회 명령만 사용하며 apply, patch, scale, install, upgrade, uninstall을 수행하지 않는다.

각 스냅샷은 다음을 분리해 기록한다.

- Helm에 적용된 `asklake-auto-mode` pool 값과 live NodePool spec의 일치 여부
- NodePool Ready, architecture, capacity type, instance category/generation, limits, disruption, expiry와 Spark taint
- pool별 node allocatable capacity와 현재 non-terminal Pod request 합계
- Frontend, FastAPI, Collector, Airflow, Trino의 selector와 실제 scheduled pool
- SparkApplication driver/executor의 Spark selector와 toleration
- HPA generation/replica/CPU target, Deployment generation과 Helm release revision으로 만든 identity fingerprint
- unrelated active Job/SparkApplication, Pending/terminating Pod와 EndpointSlice drain candidate
- run fingerprint를 가진 임시 Job/SparkApplication/Pod의 cleanup 상태

node 이름, Pod 이름·UID, IP, endpoint, ARN, image reference/digest, Secret과 실행 토큰 원문은 evidence에 넣지 않는다. component와 release의 공개된 canonical 이름, 개수, resource 합계와 짧은 비교 fingerprint만 남긴다.

## 실행과 보관

evidence는 저장소 밖 경로 또는 `.gitignore`로 제외된 경로만 허용한다. 저장소 안에서는 다음 이름 규칙을 사용한다.

```bash
export ASKLAKE_EKS_CLUSTER_NAME=<cluster-name>
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY17_RUN_TOKEN=<one-run-random-token>

bash scripts/capture-eks-day17-autoscaling-evidence.sh \
  baseline infra/eks/delivery/<run>.day17-autoscaling-evidence.json
bash scripts/capture-eks-day17-autoscaling-evidence.sh \
  sample infra/eks/delivery/<run>.day17-autoscaling-evidence.json
bash scripts/capture-eks-day17-autoscaling-evidence.sh \
  final infra/eks/delivery/<run>.day17-autoscaling-evidence.json
```

파일은 원자적으로 교체하고 항상 mode `0600`으로 고정한다. `sample`은 baseline 이후 Deployment/HPA/Helm identity가 변하면 evidence를 쓴 뒤 실패한다. `final`은 identity 고정, source/live pool 일치, placement 일치, unrelated blocker 0, run 소유 임시 resource 0을 모두 만족해야 성공한다.

실제 부하 resource에는 `asklake.io/day17-run=<run-fingerprint>` label을 붙여야 한다. fingerprint는 baseline evidence의 `runFingerprint`에서 확인하되 Git, PR, Issue나 일반 로그에는 복사하지 않는다.

## Phase 2 live 읽기 전용 판정

Phase 2 baseline 수집은 live resource를 변경하지 않고 실행했다.

- General/Spark source와 live spec은 일치했고 두 NodePool은 Ready였다.
- General은 node 3개, Spark는 node 0개였다. 이 값은 관찰 시점 수치이며 권장값이 아니다.
- General workload request와 node allocatable은 별도 필드로 기록됐다.
- Airflow 세 Deployment는 General selector가 없고, Trino는 selector 없이 built-in pool에 있어 placement gate가 실패했다.
- 첫 baseline에는 unrelated terminating Pod 1개가 있었지만 재관찰에서 0으로 수렴해 exclusive-window gate는 열렸다.
- 실제 run resource를 만들지 않았으므로 cleanup은 아직 검증 대상이 아니다.

따라서 Phase 2 하네스 구현과 읽기 전용 검증은 완료했지만 Phase 3 부하 진입은 허용하지 않는다. 현재 직접 차단 조건은 placement ownership이며, 실제 시작 직전 exclusive window도 다시 확인해야 한다. 두 조건을 만족한 뒤 새 run token과 새 baseline으로 시작한다. 현재 private evidence는 Git에서 제외한다.

## 정적 회귀

다음 명령은 정상 baseline, generation drift, 정상 cleanup과 cleanup 잔존 실패를 fixture로 검사한다. 또한 관찰 스크립트에 Kubernetes/Helm mutation command가 들어오면 실패한다.

```bash
bash scripts/test-eks-day17-autoscaling-evidence.sh
bash scripts/verify-eks-metrics-scale.sh
```
