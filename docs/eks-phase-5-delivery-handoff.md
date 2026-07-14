# EKS MVP Phase 5 배포 Handoff와 사전 검증

이 단계는 EKS에 애플리케이션을 실제 배포한 단계가 아니다. Pair A가 지금까지 만든 foundation, data plane, workload identity 출력을 Pair B의 workload manifest가 소비할 수 있는 한 개의 배포 handoff 형식으로 고정하고, 중요한 결정이나 실제 AWS 값이 비어 있으면 배포를 실패시키는 사전 검증을 추가한 단계다.

## 이번 단계에서 만든 것

`infra/eks/delivery/dev.handoff.example.json`은 다음 경계를 한곳에 기록한다.

- EKS namespace와 여섯 ServiceAccount의 정확한 이름
- Frontend, Backend, Airflow, Spark runtime, Trino의 immutable image 입력 위치
- 실제 값이 아닌 ConfigMap과 Secret reference 이름
- MSK Serverless + IAM, EKS 단일 Trino coordinator, 외부 EC2 Continuous 소유권
- 격리된 fixture topic/group/output/checkpoint 이름
- B workload가 필요로 하는 16개 network flow
- 아직 학습과 선택이 필요한 인프라 결정의 상태

JSON을 사용한 이유는 배포 도구가 파싱하기 쉽고 검증 시 YAML parser 의존성을 추가하지 않기 위해서다. JSON은 YAML 1.2의 유효한 입력이므로 이후 Helm values 생성기의 source로도 사용할 수 있다.

`scripts/verify-eks-delivery-handoff.mjs`는 planning 검증과 `--ready` 검증을 분리한다. planning 검증은 AWS 값 없이도 책임 경계, ServiceAccount, network allowlist, digest 정책, credential 유출을 확인한다. `--ready`는 실제 배포 직전에만 사용하며 다음 값이 모두 있어야 통과한다.

- 실제 cluster 이름
- IRSA 또는 Pod Identity 선택
- 다섯 workload의 ECR immutable digest
- MSK ARN과 private IAM bootstrap endpoint
- RDS endpoint와 S3 bucket reference
- 배포 전에 필요한 모든 결정의 `selected` 상태와 선택값

기본 example은 의도적으로 `planning` 상태다. 따라서 다음 명령은 planning 검증에 성공한 뒤 deploy-ready 검증이 닫혀 있음을 확인해야 성공한다.

```bash
bash scripts/verify-eks-delivery-handoff.sh
```

실제 환경 파일은 example을 복사해 승인된 비밀 저장·배포 경로에서 관리하고 다음과 같이 검사한다. 실제 endpoint와 ARN이 들어간 파일은 Git에 커밋하지 않는다.

```bash
node scripts/verify-eks-delivery-handoff.mjs \
  --ready <approved-dev-handoff.json>
```

## 아직 학습하고 선택해야 하는 사항

다음 항목은 이번 구현이 임의로 고르지 않았다.

- 기존 EKS 재사용 또는 신규 cluster 생성
- IRSA 또는 EKS Pod Identity
- Kubernetes Secret 직접 공급 또는 Secrets Manager 연동 방식
- public/internal ingress와 접근 주체
- domain, Route 53, ACM certificate 소유권
- private subnet의 NAT Gateway 또는 VPC endpoint 구성

각 항목은 실제 account/VPC inventory, shared resource owner, 운영·비용 기준을 학습한 뒤 `decisions.<name>.status`를 `selected`로 바꾸고 `selected`에 선택값을 기록한다. `continuousReadPath`는 현재 구현을 막지 않는 후속 결정이라 `deferred`를 허용하지만, EKS FastAPI가 Continuous 변경 command를 차단하는 경계는 바꿀 수 없다.

## A와 B의 인수 방식

A는 Terraform의 실제 출력과 승인된 platform 결정을 handoff에 채우되 secret value는 넣지 않고 Secret 이름만 전달한다. B는 이 파일의 namespace, ServiceAccount, image digest, endpoint reference와 network flow를 workload manifest에 사용한다. B가 새 권한·통신 경로·환경변수를 요구하면 manifest를 먼저 임의 변경하지 않고 이 handoff와 공식 아키텍처 계약을 함께 갱신한다.

현재 완료 기준은 planning 검증 통과다. 실제 Phase 5 운영 완료는 `--ready` 검증, Kubernetes server-side dry-run, EKS workload rollout, health probe, IAM/network positive·negative smoke가 모두 성공해야 선언할 수 있다.
