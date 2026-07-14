# EKS + MSK MVP Phase 0 환경·인수 계약

이 문서는 Issue #735의 구현을 시작하기 전에 Pair A가 확인한 현재 상태와 Pair A/B 사이의 인수 조건을 기록한다. Phase 0에서는 AWS 유료 리소스를 생성하거나 기존 EC2 runtime을 변경하지 않는다. 확인할 수 없는 값을 추측해서 Terraform, Helm, Kubernetes manifest에 넣지 않는 것이 이 단계의 핵심 완료 조건이다.

## 1. Phase 0 결론

현재 작업 브랜치 `feat-#735`는 2026-07-14 기준 최신 `origin/dev`에 fast-forward되어 있다.

두 사람의 공동 통합 base는 `pair1`이다. Pair A/B는 각자의 issue-linked 작업 브랜치에서 `pair1`을 base로 PR을 올리고, 통합 검증이 끝난 뒤에만 `pair1 -> dev` PR을 만든다. `pair1`에 직접 push하지 않으며 한 사람의 작업 브랜치를 다른 사람의 장기 base로 사용하지 않는다. `pair1`은 PR #749를 통해 2026-07-14의 최신 `dev` 기준으로 동기화했다.

AWS CLI의 기본 region은 `ap-northeast-2`이고 `asklake-deployer` identity의 STS 인증은 정상이다. 실제 account ID, resource ARN, endpoint, public IP는 저장소 문서에 기록하지 않는다. 이런 값은 이후 secret이 아닌 배포 환경 설정 또는 CI environment variable로 전달한다.

현재 IAM으로 확인된 AWS 환경은 다음과 같다.

- 기본 VPC 한 개와 4개 Availability Zone의 기본 public subnet이 있다.
- 인터넷 게이트웨이 기본 경로는 있지만 NAT Gateway는 없다.
- 기존 `asklake-prod` EC2 인스턴스가 실행 중이며 production Compose 경로가 이 인스턴스를 사용한다.
- 현재 IAM에는 EC2와 IAM 관리 권한이 있으나 EKS, ECR, MSK, RDS의 list/describe 권한이 없다.
- 따라서 기존 EKS cluster, ECR repository, MSK cluster, RDS instance의 존재 여부는 아직 확인하지 못했다. 조회 결과가 비어 있는 것이 아니라 `AccessDenied` 상태다.

이 상태만 보고 기본 VPC와 public subnet을 EKS MVP 네트워크로 채택하지 않는다. MSK private 연결, Pod outbound, load balancer, NAT 또는 VPC endpoint 비용과 보안 경계를 검토한 뒤 선택해야 한다.

## 2. 이미 확정된 방향

배포 환경의 Kafka broker는 `Amazon MSK Serverless + IAM`을 사용한다. Kafka 또는 Redpanda broker를 EKS 안에 운영하지 않는다. 로컬 Redpanda는 fixture와 replay 개발 환경으로 유지한다.

MVP에서 EKS로 옮길 workload 후보는 frontend, FastAPI backend, Airflow, 유한 Replay Producer Job, Spark Operator가 제출하는 batch `SparkApplication`이다. Spark driver와 executor는 EKS Pod로 실행한다.

현재 EC2에서 실행 중인 Kafka Continuous control plane과 장기 Spark Structured Streaming worker는 이 MVP에서 유지한다. EKS FastAPI가 같은 Continuous runtime의 start, sync, pause, stop을 실행하지 못하도록 이후 phase에서 feature flag 또는 명시적 routing boundary를 구현해야 한다. EC2 Continuous의 EKS 이전과 EC2 종료는 별도 후속 단계다.

로컬 Docker Compose, Redpanda, Spark Standalone REST 경로는 회귀 검증과 개발용으로 유지한다. EKS 경로가 추가되더라도 기존 local runtime을 덮어쓰지 않는다.

Issue #735의 목표와 범위도 이 계약에 맞춰 갱신했다. 이후 구현은 Kafka/Redpanda broker를 EKS에 직접 배치하지 않고 MSK Serverless + IAM을 사용하는 경계를 따른다.

## 3. 현재 코드와 목표 사이의 차이

현재 production 배포는 `deploy/docker-compose.prod.yml`과 `scripts/deploy.sh`를 기준으로 단일 EC2에서 동작한다. FastAPI는 Spark Standalone REST endpoint에 batch와 Continuous runtime을 제출한다. EKS manifest, Helm/Kustomize base, Spark Operator, Kubernetes provider, EKS용 GitHub deploy/destroy workflow는 아직 없다.

FastAPI는 현재 process startup에서 Continuous runtime sync와 scheduled job tick을 실행한다. replica를 두 개 이상 배포하면 background 작업이 중복 실행될 수 있으므로 EKS HPA를 켜기 전에 singleton Deployment, 분리 worker/CronJob, 또는 DB leader lock 중 하나를 학습하고 선택해야 한다.

Replay Producer는 현재 FastAPI가 Node subprocess를 시작하고 process memory에 상태와 log를 보관한다. EKS에서는 유한 Kubernetes Job으로 제출하고 FastAPI 재시작 뒤에도 조회 가능한 durable record를 사용해야 한다. durable record의 source of truth와 보존 기간은 Pair B가 설계안을 만들고 팀이 승인해야 한다.

Spark batch도 현재 Standalone REST 계약을 사용한다. EKS에서는 Spark Operator의 `SparkApplication` 생성, 상태 조회, log reference, cancel/retry를 기존 `runId`와 연결하는 Kubernetes provider가 필요하다. API response shape를 바꾸게 되면 `docs/03-api-reference.md`와 `docs/api-contract.md`를 함께 갱신한다.

## 4. 지금 선택하면 안 되는 항목

다음 항목은 구현자가 임의로 기본값을 넣지 않는다. 학습 또는 외부 환경 확인 뒤 결정 기록을 남긴다.

### 기존 EKS 사용 또는 신규 EKS 생성

현재 IAM으로 EKS inventory를 읽을 수 없다. 먼저 EKS list/describe 권한을 받아 기존 cluster의 owner, Kubernetes version, VPC/subnet, access entry, add-on, node provisioning 방식과 비용 책임을 확인한다. 기존 cluster가 팀 공유 자원이고 필요한 격리·권한을 제공하면 재사용할 수 있다. 그렇지 않으면 MVP 전용 cluster를 생성하되 생성·destroy·TTL 책임을 함께 정한다.

### VPC와 subnet 구성

확인된 기본 VPC는 public subnet만 있고 NAT Gateway가 없다. 이것이 곧 사용 불가라는 뜻은 아니지만, EKS node/Pod, internal MSK endpoint, ALB, ECR/S3/STS 접근을 어떤 경로로 제공할지 먼저 학습하고 선택해야 한다. 새 private subnet, NAT Gateway, VPC endpoint 중 무엇을 쓸지는 비용과 보안 요구를 비교한 뒤 결정한다.

### RDS 위치와 database/user mapping

RDS inventory 조회 권한이 없어 기존 metadata DB가 RDS인지 EC2 Compose PostgreSQL인지 AWS 계정에서 검증하지 못했다. EKS FastAPI와 Airflow가 사용할 DB endpoint, database, user, migration owner, backup owner를 확인하기 전에는 DB를 새로 만들거나 데이터를 이전하지 않는다.

### Trino 위치

Trino를 EKS workload로 옮길지, 기존 EC2 Compose에 유지할지, 별도 runtime으로 둘지 결정되지 않았다. JDBC catalog, S3 warehouse, Query Result storage, TLS/auth, backend/collector network 경계와 운영 비용을 학습한 뒤 선택한다.

### shared resource와 MVP 전용 resource

VPC, subnet, EKS, MSK, RDS, S3 bucket, Route 53 zone 중 어떤 것이 다른 팀과 공유되는지 확인되지 않았다. resource마다 `shared`, `mvp-owned`, `external` 중 하나의 lifecycle 분류를 붙이기 전에는 destroy workflow를 만들지 않는다. `shared`와 `external` resource는 자동 destroy 대상에 포함하지 않는다.

### namespace, repository, service account 이름

이 이름들은 Pair A가 정할 수 있지만 기존 platform naming/tagging 규칙을 확인한 뒤 확정한다. 확정 전 manifest에서는 하드코딩하지 않고 입력 변수로 둔다. 최소한 environment, application, component, owner, lifecycle을 이름 또는 tag/label로 식별할 수 있어야 한다.

## 5. Pair A가 Pair B에게 넘길 계약

Pair A는 AWS inventory와 결정 사항이 채워진 뒤 다음 값을 하나의 handoff로 넘긴다.

- AWS environment 이름과 region. account ID 자체는 repository에 기록하지 않는다.
- EKS cluster 이름, Kubernetes version, namespace, access 방법.
- workload별 service account 이름과 IRSA 또는 EKS Pod Identity 연결 방식.
- ECR repository 이름과 image digest 전달 규칙. mutable tag만으로 배포하지 않는다.
- MSK Serverless bootstrap 연결 방식, IAM authentication, TLS, topic/consumer group naming 경계. 실제 endpoint는 배포 환경에서 전달한다.
- VPC, private/public subnet 역할, security group 연결, ALB ingress, 필요한 VPC endpoint 또는 NAT 경로.
- RDS와 Trino의 위치, endpoint reference, database/user mapping과 migration owner.
- S3 Raw, Output, Warehouse, Query Result, checkpoint/quarantine prefix와 workload별 허용 범위.
- ConfigMap/Secret reference 이름, deploy/rollback/destroy 명령, shared resource 보호 규칙.
- Phase 1에서 사용할 정적 검증 명령과 AWS smoke evidence 저장 위치.

Pair A는 B가 요구하는 IAM action과 network destination을 받기 전에 EKS/ECR의 독립적인 skeleton을 설계할 수 있다. 하지만 최종 IAM policy, security group rule, MSK 연결, Spark S3 prefix는 B의 workload 계약을 받은 뒤에만 닫는다.

## 6. Pair B가 Pair A에게 넘길 계약

Pair B는 Kubernetes resource를 실제로 만들기 전에 다음 요구사항을 명시한다.

- FastAPI, Airflow, Replay Job, Spark driver/executor가 각각 사용하는 image, port, health/readiness probe와 resource profile.
- workload별 필요한 environment key와 Secret key 이름. 실제 secret 값은 넘기지 않는다.
- workload별 MSK, S3, RDS, Trino 접근 목적과 최소 IAM action.
- Replay Kubernetes Job의 manifest schema, 종료 상태, retry, timeout, durable record 필드와 log reference.
- SparkApplication의 driver/executor 설정, service account, package/config dependency, runId label/annotation, 상태·cancel·retry mapping.
- FastAPI background singleton 후보와 선택 근거.
- EKS FastAPI에서 차단할 Continuous command/sync 목록과 EC2 Continuous endpoint/DB ownership.
- fake Kubernetes client와 manifest render/contract test 결과.

Pair A는 이 목록이 오기 전에 cluster와 delivery skeleton을 준비할 수 있지만, 추정 권한을 넓게 부여하거나 임의의 ingress/egress를 열어 의존성을 우회하지 않는다.

## 7. Phase 0 종료 조건

현재 완료된 항목은 다음과 같다.

- 작업 브랜치를 최신 `origin/dev` 기준으로 맞췄다.
- 현재 production이 EC2 Compose와 Spark Standalone REST라는 코드 기준선을 확인했다.
- AWS identity와 region을 확인했다.
- 확인 가능한 VPC, subnet, route, EC2 inventory를 읽기 전용으로 점검했다.
- EKS/ECR/MSK/RDS inventory가 `AccessDenied`로 막혀 있음을 증거로 남겼다.
- MSK Serverless + IAM, EKS MVP workload, EC2 Continuous 유지, local runtime 유지 경계를 기록했다.
- A/B handoff 필드와 임의 결정 금지 항목을 분리했다.

아직 완료되지 않아 Phase 1 resource 생성 gate를 막는 항목은 다음과 같다.

- EKS, ECR, MSK, RDS read-only inventory 권한 확보와 실제 inventory 확인.
- 기존 EKS 재사용 또는 신규 생성 결정.
- VPC/subnet/NAT/VPC endpoint 설계와 비용·보안 선택.
- RDS와 Trino 위치 및 owner 확인.
- shared/MVP-owned/external lifecycle 분류.
- Pair B의 workload별 service account, IAM, network, manifest 요구사항 수령.

위 항목을 채우기 전에는 EKS cluster, MSK Serverless, RDS, NAT Gateway 같은 과금 resource를 생성하지 않는다.

AWS 관리자에게 요청할 최소 inventory 권한은 생성·수정 권한이 아니라 다음 read-only 범위다.

- EKS: cluster, node group, add-on, access entry의 list/describe.
- ECR: repository와 lifecycle policy의 list/describe/get.
- MSK: cluster list/describe, bootstrap broker 조회, VPC connection 조회.
- RDS: DB instance/cluster, subnet group의 describe.
- 연동 확인: ELB/Target Group, Route 53, ACM, Secrets Manager의 관련 resource list/describe. Secret value 조회 권한은 Phase 0에 필요하지 않다.

## 8. 재현 가능한 확인 명령

아래 명령은 값을 문서에 복사하기 위한 것이 아니라 현재 계정의 실제 상태를 확인하기 위한 read-only evidence다.

```bash
aws sts get-caller-identity
aws configure get region
aws eks list-clusters --region ap-northeast-2
aws ecr describe-repositories --region ap-northeast-2
aws kafka list-clusters-v2 --region ap-northeast-2
aws rds describe-db-instances --region ap-northeast-2
aws ec2 describe-vpcs --region ap-northeast-2
aws ec2 describe-subnets --region ap-northeast-2
aws ec2 describe-route-tables --region ap-northeast-2
aws ec2 describe-nat-gateways --region ap-northeast-2
```

Phase 0 evidence에는 명령, 실행 시각, 성공/AccessDenied 여부만 남긴다. account ID, ARN, endpoint, credential, public IP를 Git history에 복사하지 않는다.
