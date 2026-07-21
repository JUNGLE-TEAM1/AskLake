# EKS + MSK MVP Phase 1 인수 계약

이 문서는 Pair A의 EKS foundation 결과를 Pair B가 runtime 구현 입력으로 사용하는 방법을 정의한다. 실제 AWS endpoint나 secret을 복사하는 문서가 아니라 Terraform output, Helm value와 workload별 미확정 입력의 이름을 고정하는 계약이다.

## 1. Pair A가 제공한 기반

`infra/eks/terraform`은 기존 EKS cluster 재사용과 MVP-owned 신규 EKS Auto Mode cluster 생성 경로를 분리한다. 실제 적용 전 선택은 `cluster_mode`에 기록한다. 신규 cluster는 검토된 control-plane subnet을 입력받아 Auto Mode compute, load balancing, block storage를 함께 활성화하며 표준 Managed Node Group은 만들지 않는다. 기존 cluster는 Terraform이 변경하거나 import하지 않고, 실제 환경에서 Auto Mode와 node role을 확인했다는 명시적 입력이 있어야 handoff를 연다.

Terraform은 `cluster_name`, `cluster_vpc_id`, `cluster_security_group_id`, `cluster_subnet_ids`, `auto_mode_handoff`, `phase11_network_handoff`, `phase12_node_pool_handoff`, `phase13_alb_handoff`, `namespace`, `service_account_names`, `ecr_repository_urls`, `trino_handoff`, `phase1_handoff`를 안정적인 output 이름으로 제공한다. `auto_mode_handoff`는 신규 cluster의 Terraform 소유 또는 기존 cluster의 외부 확인 소유권, API 인증, node role, built-in NodePool과 세 Auto Mode capability를 전달한다. `phase11_network_handoff`는 external/terraform VPC 소유권, private/public subnet, NAT/endpoint egress, MSK/RDS security group reference와 후속 smoke gate를 전달한다. `phase12_node_pool_handoff`는 custom node role 이름, access entry 소유권과 General/Spark selector·toleration을 전달하되 용량·Spot·disruption 값은 대신 선택하지 않는다. `phase13_alb_handoff`는 EKS-managed ALB class, namespace selector, subnet, DNS/ACM과 안전한 삭제 순서를 전달한다. `trino_handoff`는 image mirror/digest, `asklake-trino` IRSA, in-cluster HTTPS Service, RDS `iceberg_catalog`, S3 warehouse, TLS/auth/JDBC Secret reference와 network port를 묶는다. 실제 output 값은 배포 environment에서 전달하며 문서나 PR 본문에 복사하지 않는다.

ECR repository는 frontend, backend, Airflow, Trino와 Spark runtime을 분리한다. EKS 밖 fixture producer는 이 foundation의 workload image와 service account 대상에 포함하지 않는다. repository는 immutable tag와 push scan을 사용하며 배포 workflow는 최종적으로 repository URL과 image digest를 함께 전달해야 한다.

`infra/eks/helm/asklake-foundation`은 다음 service account 이름을 제공한다.

- frontend: `asklake-frontend`
- FastAPI backend: `asklake-backend`
- Airflow: `asklake-airflow`
- Trino coordinator: `asklake-trino`
- MSK IAM 연결 smoke: `asklake-msk-smoke`
- Spark driver/executor: `asklake-spark`
- Replay Producer compatibility input: `asklake-replay-producer` (`create: false`)

이 이름은 기본값이며 Terraform output과 Helm value를 통해 같은 값으로 전달한다. B는 workload manifest에서 별도 service account를 임의로 만들지 않는다.

`asklake-backend`는 SparkApplication API 호출을 위해, `asklake-spark`는 driver가 executor Pod·Service·ConfigMap lifecycle과 shutdown collection cleanup을 관리하기 위해 Kubernetes API token 자동 mount를 `true`로 사용한다. Foundation은 `asklake-dev` namespace에서 Backend에는 SparkApplication `create/get/list/watch/delete`, Pod `get/list/watch`, Pod log `get`, Event `get/list/watch`만 허용한다. Spark에는 Pod·Service·ConfigMap lifecycle과 `deletecollection`, PVC cleanup-only `get/list/delete/deletecollection`만 허용하며 PVC 생성·수정은 허용하지 않는다. Frontend, Airflow, Trino와 MSK smoke의 token 자동 mount는 `false`로 고정한다. 어느 application Role에도 Secret, Node, Namespace, ClusterRole 또는 다른 namespace 권한은 부여하지 않는다.

## 2. B가 바로 사용할 수 있는 고정 경계

- 배포 Kafka runtime: `msk-serverless`
- Kafka authentication: `iam`
- EKS 내부 Kafka/Redpanda broker: 없음
- Trino runtime: EKS의 단일 coordinator
- Continuous control plane owner: `ec2-mvp`
- image delivery: immutable ECR digest
- Kubernetes namespace와 service account: Terraform output/Helm value가 source of truth
- secret value: Git에 저장하지 않고 Kubernetes Secret 또는 외부 secret reference로만 전달
- Replay Producer: EKS 밖 fixture producer이며 compatibility value도 `create=false`
- EKS compute: Auto Mode. `system`/`general-purpose` built-in NodePool을 유지하고 Phase 12의 `asklake-general`/`asklake-spark` custom pool은 승인된 값이 있을 때만 별도 적용

B는 실제 AWS resource가 없어도 Helm render 결과와 fake Kubernetes client로 SparkApplication과 FastAPI provider contract를 개발할 수 있다.

```bash
bash scripts/verify-eks-foundation.sh

helm template asklake-foundation \
  infra/eks/helm/asklake-foundation \
  -f infra/eks/values/dev.example.yaml
```

## 3. B가 A에게 돌려줄 최소 계약

B는 workload 구현 PR에 다음 내용을 machine-readable value와 문서로 남긴다.

- 각 workload의 image component, container port, command/args, health/readiness probe.
- 필요한 environment key와 Secret key 이름. 실제 값은 포함하지 않는다.
- service account별 필요한 AWS service, action, resource ARN pattern과 사용 목적.
- MSK topic/consumer group action, S3 bucket/prefix action, RDS/Trino network destination.
- EKS 밖 fixture producer의 메시지 형식, batch receipt, test topic 권한과 AskLake `runId` 연결 방식.
- SparkApplication의 driver/executor service account, resource request/limit, dependency, `runId` label/annotation, 상태·cancel·retry mapping.
- EKS FastAPI에서 비활성화할 EC2 Continuous command와 background sync 목록.
- FastAPI background singleton 후보와 재시작/다중 replica test 결과.

`Action: kafka-cluster:*`, `s3:*`, 모든 resource에 대한 wildcard처럼 넓은 임시 권한은 인수 계약으로 인정하지 않는다. 필요한 action을 아직 모르면 `확인 필요`로 남기고 A가 권한을 추측해 채우지 않는다.

## 4. dev에서 확정된 값과 남은 gate

dev는 신규 EKS Auto Mode, 전용 VPC, EKS Pod Identity, MSK Serverless + IAM, 격리 RDS, 관리 인수 S3, `internet-facing` HTTP ALB foundation을 적용했다. Backend·MSK smoke·Spark·Trino Pod Identity association과 Backend/Spark namespace RBAC도 존재한다. 실제 identifier는 Terraform output과 저장소 밖 environment values로만 전달한다.

다음 값과 runtime 결과는 여전히 채워야 한다.

- B의 immutable ECR image digest와 실제 workload values
- 네 runtime Secret의 실제 source/key mapping과 ExternalSecret
- Spark Operator 설치·CRD와 controller readiness
- 최종 Frontend/FastAPI Service 이후 Ingress route와 ALB HTTP smoke
- MSK IAM metadata positive smoke와 기존 Continuous topic/group negative smoke
- RDS/S3/Trino application read와 FastAPI 다중 replica·재시작 evidence
- 사용자 도메인·ACM·HTTPS 전환은 첫 HTTP E2E 이후 별도 선택

이 값이 비어 있어도 B의 manifest builder와 fake client test는 진행할 수 있다. A foundation 정렬 결과는 [B workload foundation handoff 기록](eks-day15-b-workload-foundation-handoff.md)을 따른다.

## 5. PR 인수 방법

Pair A의 Phase 1 PR이 `pair1`에 병합된 뒤 B는 최신 `pair1`에서 자신의 issue-linked 작업 브랜치를 만든다. B의 PR base도 `pair1`이다.

```text
feat-#735 -> pair1
B work branch -> pair1
pair1 -> dev
```

B는 PR에서 다음 evidence를 제공한다.

- `bash scripts/verify-eks-foundation.sh`
- Helm/Kubernetes manifest render 결과
- fake Kubernetes client contract test
- 필요한 IAM/network/secret key 목록
- unresolved decision과 그 결정이 막는 실제 smoke 단계

## 6. Pair A Phase 1 완료 기준

- Terraform이 credential 없이 format/init/validate되고 mock provider contract test가 통과한다.
- Helm chart가 lint/render되고 namespace, 생성되는 6개 service account, `create=false` Replay input, backend/Spark namespace RBAC와 runtime boundary가 확인된다.
- 실제 account ID, ARN, endpoint, credential과 secret이 저장소에 없다.
- existing Auto Mode 외부 확인과 신규 Auto Mode 생성 경로가 입력으로 분리되고 표준 Managed Node Group resource가 존재하지 않는다.
- ECR repository와 immutable digest 전달 계약, Trino IRSA/Service/RDS/S3/Secret reference를 묶은 `trino_handoff`가 출력된다.
- B가 필요한 값과 B가 반환할 값을 코드와 문서에서 찾을 수 있다.
- AWS apply는 Phase 0의 resource 생성 gate가 채워지기 전까지 실행하지 않는다.
