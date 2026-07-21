# EKS MVP 14일차 실제 환경 검증 기록

이 문서는 2026-07-15 `dev` 환경에서 Pair A가 수행한 비용 발생형 검증의 저장소용 요약이다. 계정 ID, ARN, endpoint, public IP, subnet·security group·instance ID, image digest 같은 실제 값은 저장소에 남기지 않는다. 운영에 필요한 원본 Terraform state, image receipt와 smoke evidence는 Git 밖의 제한된 경로에서 관리한다.

## 적용된 기반

- 서울 리전에 EKS Auto Mode Kubernetes 1.36 cluster를 신규 생성했다.
- 전용 VPC에 두 AZ의 public/private subnet과 단일 NAT Gateway를 구성했다.
- Kubernetes API private endpoint를 유지하고, 작업 시점의 운영자 public IP `/32`만 public endpoint에 임시 허용했다.
- namespace와 서비스별 ServiceAccount를 foundation Helm release로 적용했다.
- General과 Spark용 custom NodeClass·NodePool을 적용했고 모두 `Ready=True`를 확인했다.
- Metrics Server community add-on `v0.9.0-eksbuild.1`이 AWS에서 `ACTIVE`이고 Metrics API, `kubectl top nodes`, `kubectl top pods`가 동작함을 확인했다.
- node scale smoke 당시 A 작업 revision 기준 AMD64 frontend, backend, Airflow, Spark runtime, Trino image 5개를 임시로 ECR에 전달해 receipt와 실행을 검증했다. 이후 실행 로드맵의 이미지 책임 경계에 맞추기 위해 A가 올린 다섯 image와 관련 manifest를 ECR에서 삭제하고 해당 receipt를 폐기했다. B가 준비한 frontend, backend, Airflow, Spark runtime image는 유지하며, Trino mirror/digest는 정식 배포 handoff에서 A가 다시 제공한다.
- MSK Serverless cluster를 IAM 인증 전용으로 생성하고, EKS cluster security group에서 MSK IAM listener `9098/tcp`로만 들어가는 private network 규칙을 적용했다.

## 실제 노드 확장 검증

비용 확인 문자열이 필요한 전용 smoke runner로 General NodePool을 검증했다. 실행 전 node 수는 1대였고, 명시적인 CPU·memory request를 가진 backend smoke Pod 2개를 배포하자 2대로 증가했다. 두 Pod가 새 General node에 배치됐고 rollout과 Metrics API 수집이 성공했다. 검증 직후 임시 Helm release는 자동 제거했다.

Auto Mode가 빈 General node를 제거해 2대에서 다시 1대로 돌아오는 것까지 별도 scale-in runner로 확인했고, 성공 결과를 저장소 밖 evidence JSON에 기록했다. 이 검증은 node가 추가되는지만 보는 것이 아니라 임시 workload 제거 후 비용 자원이 회수되는 것까지 완료 기준으로 삼는다.

## 14일차 완료 경계

Pair A의 EKS/VPC/NAT, ECR repository·권한 기반, namespace·ServiceAccount, Auto Mode NodePool, Metrics Server, 실제 node scale-out/in, MSK Serverless·private listener 기반은 14일차 결과물이다. node scale evidence가 참조한 임시 backend digest는 삭제됐으므로 autoscaling 동작 증거로만 사용하고 정식 배포 image evidence로 사용하지 않는다. 이것으로 AWS 기반 자리가 만들어졌다는 뜻이며 AskLake 전체 서비스가 이미 운영 배포됐다는 뜻은 아니다.

다음 단계에는 B가 확정·구현하는 workload identity와 Kafka 권한을 적용한 EKS test client로 MSK IAM authentication, fixture topic/group 접근의 positive·negative smoke를 수행해야 한다. RDS 생성·논리 database bootstrap, S3 bucket/prefix 권한, Trino·FastAPI·Airflow 실제 workload, ALB/Ingress와 외부 URL 검증도 후속 단계다.

## 운영상 남긴 조치

- 실제 Terraform state는 현재 로컬에 있으므로 원격 backend와 state lock을 구성하기 전 다른 작업자가 같은 resource를 별도 state로 변경하지 않는다.
- public Kubernetes API `/32`는 임시 운영 경로다. CI/VPN/SSM 등 private 실행 경로가 준비되면 public endpoint를 끈다.
- 단일 NAT Gateway는 MVP 비용 우선 선택이다. AZ 장애 허용이 필요하면 per-AZ NAT 또는 endpoint 조합을 다시 결정한다.
- 실제 배포를 위해 현재 IAM 사용자에 광범위한 관리 권한과 임시 EKS 배포 정책이 연결돼 있다. 최소 권한 deploy role로 전환한 뒤 이 사용자 권한을 회수한다.
- EKS control plane, NAT Gateway, Auto Mode system node, MSK Serverless와 ECR 저장 용량은 workload가 없어도 비용이 발생할 수 있다. destroy는 공유 리소스와 ECR image 보존 경계를 확인한 뒤 저장소의 순서대로 수행한다.
