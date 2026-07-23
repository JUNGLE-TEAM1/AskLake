# EKS Day 18 Pair A Phase 0 기준점

## 결론

Issue #917의 Phase 0은 최신 `pair1`을 포함하는 작업 브랜치에서 dev 운영 상태를
읽기 전용으로 고정한다. 이 단계에서는 CloudWatch agent/add-on, IAM, Kubernetes
workload, Terraform, Helm release와 EC2를 생성·수정·삭제하지 않는다.

기준선은 `scripts/capture-eks-day18-a-baseline.sh`가 저장소 밖
`/private/tmp/asklake-day18-a-phase0-baseline.json`에 mode `0600`으로 기록한다.
AWS account, ARN, endpoint, repository, image digest, Pod·Node·EC2 식별자와 Secret은
receipt와 문서에 남기지 않는다. Git SHA만 배포 기준을 연결하기 위해 보존한다.

## 고정하는 상태

기준선은 다음을 한 번에 확인한다.

- 현재 source가 캡처 시점의 `origin/pair1`을 포함한다.
- EKS cluster와 전체 Node가 Ready이고 대상 namespace에 Pending, NotReady,
  terminating Pod와 active Job/SparkApplication이 없다.
- HPA의 현재·목표 replica, General/Spark Node 수를 집계한다.
- 모든 Deployment/StatefulSet container가 immutable digest를 사용한다.
- ALB가 active이고 draining target이 없으며 Backend의 RDS health가 정상이다.
- 최근 1시간 Kubernetes Warning event의 개수와 reason만 수집한다.
- EKS control-plane log 유형, 관련 CloudWatch log group의 개수·retention 설정 수·
  저장 byte 합계, 설치된 log collector 후보 개수만 수집한다.
- 직전 `asklake-web` Helm revision이 남아 있고 보존 EC2 한 대의 system/instance
  status가 정상이다.
- EKS의 Continuous control plane은 `external_ec2`이며 EKS 내부 Continuous
  worker/maintenance process가 0이다.

## Phase 0에서 결정하지 않는 것

Application log 전달 방식은 아직 선택하지 않는다. CloudWatch Observability add-on,
Fluent Bit, ADOT을 EKS Auto Mode 지원 범위, Pod Identity/IAM, 수집 범위, 보존기간,
예상 비용과 장애 시 운영 난이도로 비교한 뒤 Phase 1에서 명시적으로 선택한다.
현재 RDS log export나 EKS control-plane log가 존재하더라도 Application log 수집이
완료됐다고 판정하지 않는다.

## 2026-07-18 실측 결과

최신 `pair1` merge SHA를 그대로 기준으로 수집기가 통과했다. EKS cluster와 Node
3개는 모두 Ready이고 workload Deployment `7/7`이 steady다. HPA는 현재/목표
`2/2`, Pending·NotReady·terminating Pod와 active Job/SparkApplication은 모두
`0`이다. ALB healthy target은 4개이고 draining target은 0개이며 RDS health도
정상이다. 모든 workload container `7/7`은 immutable digest를 사용한다.

최근 1시간 Warning event는 0개다. EKS control-plane log는 API, audit,
authenticator가 활성화돼 있지만 application log collector add-on/DaemonSet 후보는
0개다. cluster 관련 CloudWatch log group은 2개이고 둘 다 retention 기간이 설정되지
않았다. 따라서 application log 수집 방식과 retention/cost limit은 완료가 아니라
Phase 1의 결정·구현 대상으로 남는다. 기존 log group의 저장량은 약 464MiB이며
정확한 이름이나 ARN은 기록하지 않았다.

`asklake-web`에는 superseded revision 9개가 남아 있다. 보존 EC2는 정확히 한 대이고
system/instance status가 정상이며, EKS Continuous process는 0이고 control plane은
계속 외부 EC2다. Phase 0은 rollback을 실제 수행하지 않고 경로가 존재하는지만
확인했다.

## 실행

```bash
export ASKLAKE_EKS_CLUSTER_NAME='<terraform output을 검토한 cluster>'
export ASKLAKE_EKS_NAMESPACE=asklake-dev
export ASKLAKE_DAY18_BASELINE_OUTPUT=/private/tmp/asklake-day18-a-phase0-baseline.json
bash scripts/capture-eks-day18-a-baseline.sh --capture
```

기존 출력은 덮어쓰지 않는다. 다시 수집하려면 이전 evidence를 보존하고 새로운
저장소 밖 경로를 지정한다. 실패 시 private receipt에서 aggregate 판정을 확인하되,
Phase 0 runner가 자원을 고치거나 cleanup하지 않는다.
