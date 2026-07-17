# EKS Day 17 A/B 최종 통합 placement 적용

## 결론

Issue #909 Phase 2에서 `asklake-airflow`와 `asklake-trino` Helm release를 현재
repository chart와 동기화했다. server-side dry-run, 현재 manifest와 desired
render의 구조 비교, 실제 upgrade와 rollout 후 read-only baseline을 순서대로
실행했고 최종 `poolReady`, `placementReady`, `exclusiveWindowReady`는 모두
`true`다.

Phase 0의 Airflow·Trino placement blocker는 해제됐다. canonical Day 17 image
receipt 부재는 Phase 3 blocker로 유지하므로 API load와 multi-Spark campaign은
아직 시작하지 않는다.

## 적용 전 검증

각 release의 실제 values는 mode `0600` 임시 디렉터리에 저장하고 command 종료
시 삭제했다. 실제 값이나 image URI·digest는 출력하거나 Git에 기록하지 않았다.

`helm upgrade --install --dry-run=server`는 두 release 모두 통과했고 dry-run
전후 Kubernetes resource UID와 resourceVersion 집합은 동일했다. 현재 Helm
manifest와 새 chart render를 구조적으로 비교한 결과 다음 selector 추가만
존재했다.

- Airflow API server, scheduler, DAG processor Deployment
- Airflow DB migration pre-upgrade hook Job
- Trino coordinator Deployment

image, environment, Secret reference, Service, ConfigMap, resource request와 probe
delta는 없었다. `helm get manifest`가 hook manifest를 반환하지 않아 desired 쪽에만
보이는 migration Job은 exact kind/name, `pre-install,pre-upgrade` hook annotation과
General selector를 별도로 검사했다.

## 적용

Airflow는 release revision `17 → 18`, Trino는 `15 → 16`으로 upgrade했다. 각
release가 기존 resource ownership을 유지하도록 현재 live values와 원래 release
이름을 사용했다. 별도 raw apply, Deployment patch, annotation 강제 인수는 하지
않았다.

Airflow upgrade는 placement-only 변경이므로 `--no-hooks`를 사용해 RDS migration과
API user password reset을 불필요하게 재실행하지 않았다. 두 upgrade는 atomic
rollback과 wait를 사용했으며 모든 Deployment rollout이 성공했다.

실패 시 rollback 기준 revision은 Airflow `17`, Trino `15`다. rollback이 필요하면
다른 변경을 섞지 않고 component release별로 이전 revision을 복구한 뒤 endpoint와
ALB/RDS steady 검증을 다시 실행한다.

## 적용 후 상태

Airflow의 세 Deployment와 Trino Deployment 모두
`asklake.io/workload-class=general` selector를 가지며 실제 Pod도 전부
`asklake-general` NodePool에 배치됐다. Frontend, FastAPI, Collector까지 포함한
관찰 대상 7개 Deployment가 모두 selector와 scheduled pool 계약을 만족했다.

Airflow와 Trino Service는 각각 Ready EndpointSlice endpoint `1`개를 유지했다.
FastAPI HPA는 min/max `2/6`, current/desired `2/2`, CPU target `60%`로 steady
상태였다. ALB는 shared active 상태, 2개 AZ, healthy target `4`, draining target
`0`이었고 `/`와 `/api/health`는 HTTP 200, Backend database health는 정상이었다.

rollout 과정에서 custom General node는 `1 → 3`으로 증가했고 Spark node는 계속
`0`이었다. 적용 직후 cluster-wide Pending Pod, active Job, active
SparkApplication, terminating Pod와 endpoint drain candidate는 모두 `0`이었다.
General node의 후속 consolidation은 Phase 6의 scale-in/steady gate에서 다시
관찰한다.

## private evidence

적용 후 기준점은
`infra/eks/delivery/issue-909-phase2.post-placement.day17-autoscaling-evidence.json`
에 저장했다. 파일은 `.gitignore` 대상이며 mode `0600`이다. 이 문서는 cluster,
account, endpoint, ARN, image digest와 Kubernetes 원본 identity를 포함하지 않는다.

## 다음 gate

Phase 3에서 최종 Frontend, Backend, Airflow, Spark runtime, Trino image를 하나의
canonical receipt로 고정하고 live Deployment 및 runtime ConfigMap과 대조한다.
receipt, observer, runner의 입력과 cleanup ownership이 모두 일치한 뒤에만 Phase
4 live HPA campaign을 시작한다.
