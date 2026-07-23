# EKS Day 18 Phase 5 EC2 rollback 경로 검증

## 목적과 범위

Issue #917 Phase 5는 EKS 장애 시 보존된 EC2 Compose를 rollback 원본으로 사용할 수
있는지 확인한다. 이 단계는 EC2를 중지·재시작하거나 EKS 트래픽을 EC2로 전환하지 않는
읽기 전용 audit이다. 실제 failover와 production cutover 승인은 별도다.

기존 instance가 `running`이고 AWS status check가 정상이라는 사실만으로 완료 처리하지
않는다. 정확한 Compose project, remote Git 상태, 장기 서비스와 healthcheck, 공개
Frontend·Backend·AI health, Spark Continuous script, EC2/EKS control-plane 경계를 함께
확인한다.

## 운영 명령

private `deploy/ec2.env`에는 instance, host, SSH key와 함께 기존 stack의
`com.docker.compose.project` label과 정확히 같은 `ASKLAKE_COMPOSE_PROJECT_NAME`을 둔다.
기본값이나 host의 유일한 project를 자동 채택하지 않는다.

```bash
source deploy/ec2.env
export ASKLAKE_EKS_CLUSTER_NAME=<cluster-name>

bash scripts/verify-eks-day18-ec2-rollback.sh \
  <ignored-private-evidence.json>

scripts/deploy.sh status
scripts/deploy.sh start
scripts/deploy.sh health
ASKLAKE_LOG_SERVICE=backend scripts/deploy.sh logs
```

`start`는 EC2가 이미 실행 중인 이번 audit에서는 호출하지 않았다. 대신 exact instance,
SSH, remote branch/worktree, deploy preflight, Compose project ownership, 현재 service
health와 start가 소비하는 모든 private 입력을 검증했다. 실제 장애 때 `start`를 실행한
뒤에는 반드시 `health`를 다시 실행한다.

## 2026-07-18 실제 결과

- exact EC2 instance는 Running이고 instance/system status check와 SSH가 정상이다.
- private application URL은 해당 EC2로 해석되고 Frontend, Backend database-aware health,
  AI gateway health가 통과했다.
- 기존 rollback stack과 운영 스크립트의 기본 Compose project가 달랐다. 운영 스크립트에
  명시적 `ASKLAKE_COMPOSE_PROJECT_NAME` 지원을 추가하고 실제 project 일치를 검증했다.
  private 환경 파일에도 exact project를 추가하고 권한을 mode `0600`으로 강화했다.
- remote deploy branch가 기대 branch와 같고 tracked worktree는 clean이다.
- Compose 정의 service 20개, container 21개가 확인됐다. 장기 service 17개는 모두
  Running이고 unhealthy, restarting, non-zero one-shot은 각각 0개다.
- healthcheck가 정의된 장기 service 17개 중 15개는 Healthy다. 기존에 생성된 Trino
  collector/cleanup 두 container는 현재 정의의 healthcheck가 아직 적용되지 않았지만
  Running이다. rollback 원본을 바꾸지 않기 위해 이번 audit에서 재생성하지 않았다.
- EC2 Backend는 현재 image 세대상 explicit setting field가 없는
  `legacy-local-default` Continuous control plane이다. Spark master/worker 양쪽에서 worker와
  maintenance script를 읽을 수 있고 현재 active process는 각각 0개다.
- EKS는 `external_ec2`이며 Continuous worker/maintenance process가 0개다.
- private receipt는 mode `0600`이고 endpoint, instance/container/project 이름, ARN,
  image digest와 Secret을 포함하지 않는다.

## 판정과 남은 위험

Phase 5의 비중단 rollback 원본·명령 입력 검증은 `PASS`다. 다만 다음 두 항목은 실제
failover 전에 해소하거나 명시적으로 수용해야 한다.

1. EC2를 현재 Compose 정의로 계획된 maintenance window에 재생성해 Trino
   collector/cleanup healthcheck 2개가 실제 container에 적용되는지 확인한다.
2. EC2 Backend를 explicit `ASKLAKE_CONTINUOUS_CONTROL_PLANE=local` 계약을 포함한 image로
   갱신하거나, legacy-local 기본 동작을 rollback 기간 동안 수용한다.

두 보완은 현재 정상인 rollback 원본을 변경하므로 이번 읽기 전용 Phase에서 임의로
수행하지 않았다. 또한 이 결과는 실제 EKS 중단, DNS/traffic 전환, EC2 start 명령 실행
시간과 데이터 delta 복구를 증명하지 않는다.
