# EKS MVP 담당자 B 계약 확정안

> 상태: Phase 1 인수용 계약. 표준 기본값과 B의 확정 사항을 반영했으며, `보류`로 표시한 동시성·Continuous 상태 계약은 후속 합의 전까지 구현 기준으로 사용하지 않는다.

## 1. 목적

이 문서는 AskLake EKS + MSK 연동 MVP에서 담당자 B가 담당자 A에게 전달할 애플리케이션 계약 초안을 정의한다.

이 계약의 목적은 AWS 인프라 구현 방식을 B가 결정하는 것이 아니다. B는 이미지, Kafka 입력, 데이터베이스 사용 방식처럼 애플리케이션이 요구하는 논리 형식을 고정하고, A는 실제 AWS 리소스와 인증·네트워크 구성을 결정한다.

이 문서에는 실제 AWS 계정 ID, endpoint, ARN, 비밀번호, 인증서 또는 token을 기록하지 않는다.

### 1.1 확정된 범위 경계

- Replay Producer는 EKS 밖에서 실행한다.
- EKS에는 Replay Job과 Replay Producer Pod를 배포하지 않는다.
- 외부 AWS principal이 격리된 MSK test topic에 produce한다.
- FastAPI에는 Replay Job을 생성·조회·삭제하는 Kubernetes RBAC를 부여하지 않는다.
- 기존 Kafka Continuous의 control plane과 worker는 EC2가 계속 소유한다.

### 1.2 결정 상태

| 항목 | 책임 | 상태 |
| --- | --- | --- |
| MSK 유형과 인증 방식 | A | A가 결정한다. B는 선택된 방식에 맞는 client/env/Secret 형식만 제공한다. |
| RDS 용도 분리 | B 계약, A 구축 | 단일 RDS PostgreSQL instance에 database와 user를 3개 용도별로 분리한다. |
| Trino 배치 위치와 실제 port | A | A가 결정한다. B는 `TRINO_BASE_URL`과 Secret reference 형식만 제공한다. |
| FastAPI background singleton 구현 방식 | A/B 공동 | 보류. 동시성·장애 복구 검토 후 별도 확정한다. |
| EC2 Continuous 상태 DB와 읽기 endpoint | A/B 공동 | 보류. EKS의 변경 command 차단 원칙만 현재 확정한다. |

MSK 인증과 Trino 위치는 B가 선택할 설계 방향이 아니다. 두 값은 A의 인프라 결과를 B workload에 주입하기 위한 interface 계약으로만 다룬다.

## 2. 책임 경계

| 담당자 B가 정하는 것 | 담당자 A가 정하는 것 |
| --- | --- |
| 이미지 이름, build target, platform, port, health path | AWS account, region, 실제 ECR repository URL |
| Kafka 메시지 형식, topic/group 이름 규칙, producer/consumer 권한 경계 | MSK 유형, 인증 방식, bootstrap endpoint, VPC와 Security Group |
| PostgreSQL 논리 database/user 분리와 환경 변수 mapping | RDS instance/cluster 개수, 크기, subnet, backup 정책 |
| Git SHA tag와 ECR digest 사용 규칙 | 실제 image push, 배포용 digest 기록 |
| FastAPI 중복 실행 방지와 Run 복구 완료 기준 | EKS workload identity와 AWS IAM policy 구현 |

## 3. 이미지 계약

### 3.1 이미지 목록

모든 이미지는 EKS AMD64 Node에서 실행할 수 있도록 `linux/amd64`로 빌드한다.

| 역할 | 권장 repository / target | Command와 args | Port / probe | 초기 resource 기본값 | ServiceAccount |
| --- | --- | --- | --- | --- | --- |
| Frontend | `asklake-frontend`, `frontend/Dockerfile` final | image 기본 Nginx command | `80`, HTTP `GET /` | request `100m/128Mi`, limit `500m/256Mi` | `asklake-frontend` (`automountServiceAccountToken: false`) |
| FastAPI | `asklake-fastapi`, `backend/Dockerfile:backend-runtime` | `uvicorn app.main:app --host 0.0.0.0 --port 8080` | `8080`, HTTP `GET /api/health` | request `500m/1Gi`, limit `1 CPU/2Gi` | `asklake-fastapi` |
| Spark runtime | `asklake-spark`, `backend/Dockerfile:spark-runtime` | `local:///opt/asklake/scripts/spark_job_run.py`, runtime args는 Run contract에서 주입 | Service 없음, SparkApplication/driver 상태 확인 | driver `1 CPU/2Gi`, executor 1개 `2 CPU/4Gi` | `asklake-spark` |

resource 값은 Phase 1 최초 배포용 tuning 기본값이다. Node 크기와 실제 측정 결과에 따라 변경할 수 있으며, resource 필드의 구조나 책임 경계를 바꾸는 중요한 설계 결정은 아니다.

Frontend는 가능하면 같은 origin의 `/api`를 사용한다. ALB hostname 변경만으로 Frontend image를 다시 빌드하지 않도록 public API hostname을 image에 고정하지 않는다.

### 3.2 이미지 식별 규칙

- Git SHA tag는 사람이 source revision을 확인하는 표시용으로 사용한다.
- 실제 Kubernetes 배포와 rollback은 immutable ECR image digest를 사용한다.
- 배포 기록에는 현재 digest와 직전 검증 성공 digest를 함께 남긴다.
- `latest` tag는 배포 기준으로 사용하지 않는다.

권장 형식:

```text
표시용 tag: git-<7자리 Git SHA>
배포 image: <ECR repository URL>@sha256:<digest>
rollback: 직전 검증 성공 digest
```

예시:

```text
123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake-fastapi:git-a1b2c3d
123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake-fastapi@sha256:<digest>
```

### 3.3 A의 회신 필요 항목

- AWS account와 region
- 세 image의 실제 ECR repository URL
- EKS Node architecture가 AMD64라는 확인
- image push 권한을 가진 AWS principal

## 4. MSK fixture 입력 계약

### 4.1 격리된 리소스 이름

MVP smoke는 기존 EC2 Kafka Continuous와 topic, consumer group, output, checkpoint를 공유하지 않는다.

권장 기본값:

```yaml
topic: asklake.eks-mvp.fixture.v1
consumerGroup: asklake-eks-mvp-spark-v1
outputPrefix: eks-mvp/output/
checkpointPrefix: eks-mvp/checkpoints/
```

팀의 AWS naming convention이 있으면 실제 문자열은 변경할 수 있다. 격리 원칙과 역할별 권한 경계는 변경하지 않는다.

### 4.2 권한 경계

| 주체 | 허용 | 금지 |
| --- | --- | --- |
| EKS 밖 fixture producer | test topic 조회와 produce | 운영 topic, consumer group, checkpoint 변경 |
| EKS Spark workload | test topic 조회·consume, 전용 group 사용, 지정 S3 prefix 쓰기 | 기존 Continuous topic/group/checkpoint/output 변경 |
| EC2 Continuous control plane/worker | 기존 Continuous runtime 제어 | MVP test topic/group/checkpoint 사용 |

MSK Serverless/Provisioned 선택과 IAM/mTLS/SCRAM 인증 방식은 A가 결정한다. 선택한 인증 방식과 무관하게 위 최소 권한 경계를 유지한다.

권장 AWS IAM action 계약:

| Principal / ServiceAccount | AWS service | Action | Resource 범위 | 이유 |
| --- | --- | --- | --- | --- |
| 외부 fixture producer principal | MSK IAM | `kafka-cluster:Connect` | 지정 MSK cluster ARN | broker 연결 |
| 외부 fixture producer principal | MSK IAM | `kafka-cluster:DescribeTopic`, `kafka-cluster:WriteData` | 지정 test topic ARN | fixture 입력 |
| `asklake-msk-smoke` | MSK IAM | `kafka-cluster:Connect` | 지정 MSK cluster ARN | EKS network/IAM smoke 연결 |
| `asklake-msk-smoke` | MSK IAM | `kafka-cluster:DescribeTopic` | 지정 test topic ARN | test topic metadata 조회 |
| `asklake-spark` | MSK IAM | `kafka-cluster:Connect` | 지정 MSK cluster ARN | broker 연결 |
| `asklake-spark` | MSK IAM | `kafka-cluster:DescribeTopic`, `kafka-cluster:ReadData` | 지정 test topic ARN | bounded consume |
| `asklake-spark` | MSK IAM | `kafka-cluster:DescribeGroup`, `kafka-cluster:AlterGroup` | 지정 test consumer group ARN | consumer group offset 사용 |
| `asklake-spark` | S3 | `s3:ListBucket` | 지정 bucket ARN, test input/output/warehouse prefix condition | 대상 object 탐색 |
| `asklake-spark` | S3 | `s3:GetObject` | 지정 input/output/warehouse object ARN | source와 commit 검증 읽기 |
| `asklake-spark` | S3 | `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` | 지정 output/warehouse prefix object ARN | 결과·Iceberg commit과 실패 정리 |
| `asklake-fastapi` | S3 | `s3:ListBucket`, `s3:GetObject` | 지정 output/warehouse/query-result prefix | 결과·evidence 검증 |
| `asklake-fastapi` | S3 | `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` | 지정 query-result/evidence prefix object ARN | query result/evidence 저장과 실패 정리 |

다음 권한은 허용하지 않는다.

- `kafka-cluster:*`
- `s3:*`
- `Resource: *`
- 외부 fixture producer의 consumer group 접근
- EKS workload의 기존 EC2 Continuous topic/group 접근

위 action 표는 MSK IAM 인증을 선택했을 때의 추천안이다. mTLS 또는 SCRAM을 선택하면 인증 secret과 broker port 계약으로 대체하되 topic/group 최소 권한 원칙은 유지한다.

### 4.3 메시지 형식

fixture producer는 UTF-8 JSON object를 Kafka message value로 전송한다. Kafka message key는 `event_id`를 사용한다.

권장 메시지:

```json
{
  "schema_version": "1.0",
  "event_id": "eks-smoke-batch-001-0001",
  "source": "eks-mvp-fixture",
  "offset": 1,
  "review": "테스트 메시지입니다.",
  "created_at": "2026-07-14T13:00:00Z",
  "raw": {
    "fixture_batch_id": "eks-smoke-batch-001",
    "sequence": 1,
    "expected_count": 100
  }
}
```

필수 필드:

| 필드 | 규칙 |
| --- | --- |
| `schema_version` | 현재 `1.0` |
| `event_id` | message마다 유일한 문자열, Kafka key와 동일 |
| `offset` | fixture 내부의 증가하는 정수 |
| `review` | smoke 처리용 문자열 payload |
| `created_at` | ISO-8601 UTC timestamp |
| `raw.fixture_batch_id` | 같은 smoke batch를 묶는 식별자 |
| `raw.sequence` | batch 내부 순서, `1..expected_count` |
| `raw.expected_count` | 해당 batch의 기대 입력 건수 |

기본 smoke batch는 100건을 권장한다. bounded consume은 실행 시작 시 partition별 종료 offset을 고정하고 해당 범위만 처리한다.

### 4.4 Producer evidence 형식

외부 fixture producer는 다음 receipt를 로그 또는 evidence 파일로 남긴다.

```json
{
  "fixtureBatchId": "eks-smoke-batch-001",
  "topic": "asklake.eks-mvp.fixture.v1",
  "producedCount": 100,
  "producedAt": "2026-07-14T13:00:00Z"
}
```

최종 검증에서는 이 receipt의 batch ID와 입력 건수를 AskLake `runId`, SparkApplication UID, S3/Iceberg 결과, Trino 검증, Catalog materialization과 연결한다.

### 4.5 A의 회신 필요 항목

- MSK 유형과 인증 방식
- cluster ARN과 private bootstrap endpoint
- 승인된 test topic/group naming
- fixture producer 실행 위치와 AWS principal
- 기존 Continuous가 사용하는 topic/group/checkpoint/output prefix
- Spark workload identity와 S3 output bucket/prefix

## 5. RDS 논리 분리 계약

### 5.1 확정 구성

MVP에서는 **단일 RDS PostgreSQL instance**를 사용하고, 그 안의 database와 user를 세 용도로 분리한다. PostgreSQL 용도 분리는 파일 system directory가 아니라 논리 database와 전용 user/role로 구현한다.

| 용도 | 권장 database | 권장 user | 저장 대상 |
| --- | --- | --- | --- |
| AskLake application | `asklake_app` | `asklake_app` | Job, Run, Catalog와 application metadata |
| Airflow metadata | `airflow_metadata` | `airflow_app` | DAG, Task, Airflow 실행 metadata |
| Iceberg JDBC Catalog | `iceberg_catalog` | `iceberg_catalog` | Iceberg table과 namespace metadata |

각 user는 자기 용도의 database에만 필요한 최소 권한을 가진다. 세 용도가 같은 비밀번호나 공용 database owner를 공유하지 않는다.

### 5.2 환경 변수 mapping

| Workload | 환경 변수 또는 Secret | 연결 대상 |
| --- | --- | --- |
| FastAPI | `DATABASE_URL` | `asklake_app` |
| Airflow | `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` | `airflow_metadata` |
| Spark | `ASKLAKE_SPARK_ICEBERG_JDBC_URL`, `ASKLAKE_SPARK_ICEBERG_JDBC_USER`, `ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD` | `iceberg_catalog` |
| Trino | `TRINO_ICEBERG_JDBC_DATABASE`, `TRINO_ICEBERG_JDBC_USER`, `TRINO_ICEBERG_JDBC_PASSWORD` | `iceberg_catalog` |

실제 endpoint, username, password와 connection URL은 Kubernetes Secret으로 공급한다. repository, ConfigMap, Deployment YAML에는 secret value를 기록하지 않는다.

### 5.3 이전 순서

일정과 의존 관계를 기준으로 다음 순서를 권장한다.

1. 기존 PostgreSQL backup과 rollback 기준을 기록한다.
2. RDS에 database/user와 schema를 준비한다.
3. AskLake Job/Run/Catalog를 이전하고 FastAPI 연결을 검증한다.
4. Airflow metadata를 이전하고 Airflow health를 검증한다.
5. Iceberg JDBC Catalog를 이전하고 Spark commit과 Trino 조회를 검증한다.
6. bounded E2E를 실행해 `runId` 기준 정합성을 확인한다.

### 5.4 Rollback 규칙

- 이전 검증이 끝날 때까지 기존 EC2 PostgreSQL과 backup을 삭제하지 않는다.
- RDS와 기존 EC2 PostgreSQL에 동시에 쓰는 dual-write를 사용하지 않는다.
- 실패 시 Kubernetes Secret의 DB endpoint와 배포 image를 직전 검증 성공 값으로 되돌린다.
- migration 시작 시각, source/target, 검증 결과, rollback 여부를 migration receipt로 기록한다.
- rollback 이후 신규 RDS write가 있었다면 데이터 손실 또는 재이관 필요 여부를 명시한다.

### 5.5 A의 회신 필요 항목

- RDS endpoint, port, SSL 요구사항
- 단일 RDS PostgreSQL instance의 instance class와 storage 설정
- backup, snapshot, retention 정책
- database/user 생성 책임자와 Secret 생성 방식
- 기존 EC2 PostgreSQL을 rollback 경로로 유지할 기간

## 6. Kubernetes 실행·RBAC 계약

### 6.1 Workload 범위

| Workload | Kubernetes 형태 | Namespace | ServiceAccount |
| --- | --- | --- | --- |
| Frontend | Deployment/Service | `asklake` | `asklake-frontend` |
| FastAPI | Deployment/Service | `asklake` | `asklake-fastapi` |
| MSK IAM smoke | 수동 적용하는 일회성 Job/Pod | `asklake` | `asklake-msk-smoke` |
| Spark batch | SparkApplication과 driver/executor Pod | `asklake` | `asklake-spark` |
| Replay Producer | EKS에 배포하지 않음 | 해당 없음 | 해당 없음 |

모든 application RBAC는 `asklake` namespace의 Role/RoleBinding으로 제한한다. Spark Operator 설치·운영용 ClusterRole은 A의 platform 범위이며 application ServiceAccount에 재사용하지 않는다.

### 6.2 FastAPI RBAC 추천안

| API group | Resource | Verb | 범위 | 이유 |
| --- | --- | --- | --- | --- |
| `sparkoperator.k8s.io` | `sparkapplications` | `create`, `get`, `list`, `watch`, `delete` | `asklake` namespace | Spark batch 제출, 상태 추적, 취소 |
| core | `pods` | `get`, `list`, `watch` | `asklake` namespace | driver/executor 상태와 종료 사유 확인 |
| core | `pods/log` | `get` | `asklake` namespace | Run log 조회 |
| core | `events` | `get`, `list`, `watch` | `asklake` namespace | scheduling/image pull/runtime 실패 진단 |

FastAPI에는 다음 권한을 주지 않는다.

- `batch/jobs` create/delete 권한
- 다른 namespace 접근
- Secret 읽기·목록 조회
- Node, Namespace, ClusterRole 조작
- SparkApplication status 직접 변경

취소는 SparkApplication 삭제로 처리하므로 기본 계약에는 `patch`를 포함하지 않는다. 구현 중 patch가 반드시 필요해지면 대상 subresource와 이유를 별도 계약으로 추가한다.

### 6.3 Spark driver RBAC 추천안

| API group | Resource | Verb | 범위 | 이유 |
| --- | --- | --- | --- | --- |
| core | `pods` | `create`, `get`, `list`, `watch`, `delete` | `asklake` namespace | executor lifecycle 관리 |
| core | `services` | `create`, `get`, `delete` | `asklake` namespace | driver/executor 통신 |
| core | `configmaps` | `create`, `get`, `delete` | `asklake` namespace | Spark runtime configuration |

## 7. 환경변수·Secret 계약

아래 표는 Phase 1에 필요한 최소 계약이다. 실제 secret value는 A가 생성하고 B 문서에는 key만 기록한다.

| Key | 종류 | 필수 | Workload | 변경 반영 |
| --- | --- | --- | --- | --- |
| `APP_ENV=production` | ConfigMap | 필수 | FastAPI | Deployment rollout |
| `AWS_REGION` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `ASKLAKE_OBJECT_STORAGE_PROVIDER=aws` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `ASKLAKE_KAFKA_BROKER` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `ASKLAKE_KAFKA_AUTH_MODE` | ConfigMap | 필수 | Spark | 새 SparkApplication. EKS adapter 구현 필요 |
| `ASKLAKE_SPARK_RUNNER=kubernetes` | ConfigMap | 필수 | FastAPI | Deployment rollout. Kubernetes provider 구현 필요 |
| `ASKLAKE_SPARK_OUTPUT_BUCKET` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `ASKLAKE_SPARK_OUTPUT_PREFIX` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `DATABASE_URL` | Secret | 필수 | FastAPI | Deployment rollout |
| `AIRFLOW_API_BASE_URL` | ConfigMap | 필수 | FastAPI | Deployment rollout |
| `AIRFLOW_EXECUTION_API_TOKEN` | Secret | 필수 | FastAPI, Airflow | 두 workload rollout |
| `AIRFLOW_INTERNAL_TOKEN` | Secret | 필수 | FastAPI, Airflow | 두 workload rollout |
| `TRINO_ENABLED` | ConfigMap | 필수 | FastAPI | Deployment rollout |
| `TRINO_BASE_URL` | ConfigMap | `TRINO_ENABLED=true`일 때 필수 | FastAPI | Deployment rollout |
| `TRINO_AUTH_USERNAME`, `TRINO_AUTH_PASSWORD` | Secret | 인증 사용 시 필수 | FastAPI | Deployment rollout |
| `TRINO_ICEBERG_WAREHOUSE_BUCKET` | ConfigMap | 필수 | FastAPI, Spark | Deployment rollout / 새 SparkApplication |
| `ASKLAKE_SPARK_ICEBERG_JDBC_URL` | Secret | 필수 | Spark | 새 SparkApplication |
| `ASKLAKE_SPARK_ICEBERG_JDBC_USER`, `ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD` | Secret | 필수 | Spark | 새 SparkApplication |
| `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2` | ConfigMap | 필수 | EKS FastAPI | Deployment rollout. fail-closed guard 구현 필요 |

장기 AWS access key/secret은 Kubernetes Secret에도 저장하지 않는다. FastAPI와 Spark는 EKS workload identity를 사용하고 외부 fixture producer는 A가 지정한 외부 AWS principal을 사용한다.

## 8. Network 계약

| Source | Destination | 방향 | Protocol / port | 목적 |
| --- | --- | --- | --- | --- |
| ALB/Ingress | Frontend Service | ingress | TCP `80` | 웹 화면 |
| ALB/Ingress | FastAPI Service | ingress | TCP `8080` | `/api`와 `/api/health` |
| Airflow | FastAPI Service | egress → ingress | TCP `8080` | internal execution API |
| FastAPI | Kubernetes API | egress | HTTPS `443` | SparkApplication 제출·조회·취소 |
| FastAPI | RDS | egress | PostgreSQL `5432` | Job/Run/Catalog 상태 |
| FastAPI | Trino | egress | A가 확정한 HTTPS port | 물리 검증과 query |
| FastAPI, Spark | S3와 STS | egress | HTTPS `443` | object I/O와 workload identity |
| EKS Node | ECR API/DKR와 S3 | egress | HTTPS `443` | image pull. Node/platform 책임 |
| MSK IAM smoke Pod | MSK broker | egress | A가 인증 방식에 맞춰 확정한 broker port | bootstrap 연결과 topic metadata 조회 |
| Spark | MSK broker | egress | A가 인증 방식에 맞춰 확정한 broker port | bounded consume |
| Spark | RDS Iceberg JDBC Catalog | egress | PostgreSQL `5432` | Iceberg metadata commit |
| 외부 fixture producer | MSK broker | 외부 egress → MSK ingress | A가 인증 방식에 맞춰 확정한 broker port | fixture produce |

기본 원칙:

- RDS와 MSK는 public ingress를 열지 않는다.
- Security Group source는 workload가 사용하는 Node/Pod security group 또는 승인된 외부 producer network로 제한한다.
- MSK broker port와 Trino port는 A의 인증·배치 결정 전까지 숫자를 임의로 고정하지 않는다.
- NetworkPolicy를 사용하는 경우 Frontend, FastAPI, Spark별 egress를 위 표에 맞춰 allowlist한다.

## 9. SparkApplication 계약

### 9.1 Manifest 기본값

| 필드 | 추천안 |
| --- | --- |
| `type` | `Python` |
| `mode` | `cluster` |
| image | `asklake-spark@sha256:<digest>` |
| main file | `local:///opt/asklake/scripts/spark_job_run.py` |
| namespace | `asklake` |
| service account | `asklake-spark` |
| restart policy | operator 자동 재시작 없음. API retry가 새 실행을 제출 |
| driver | `1 CPU`, `2Gi` |
| executor | 1개, 각 `2 CPU`, `4Gi` |
| timeout | 기본 2시간, Run 계약의 제한값으로 override 가능 |

Spark dependency 기본값은 현재 runtime과 맞춘다.

- Spark `4.0.1`
- `org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1`
- `org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.11.0`
- `org.postgresql:postgresql:42.7.7`
- `org.apache.hadoop:hadoop-aws:3.4.1`

### 9.2 실행 identity

권장 metadata:

```yaml
metadata:
  name: asklake-run-<normalized-run-id>
  labels:
    app.kubernetes.io/name: asklake-spark
    asklake.io/run-id: <runId>
    asklake.io/job-id: <jobId>
  annotations:
    asklake.io/run-id: <full-runId>
    asklake.io/job-id: <full-jobId>
    asklake.io/image-digest: <sha256:digest>
```

RDS Run record는 최소한 다음 값을 저장한다.

- `runId`
- `jobId`
- SparkApplication name과 UID
- driver Pod name
- image digest
- submitted/started/ended timestamp
- normalized 상태와 failure reason
- log reference와 마지막 heartbeat/관찰 시각

### 9.3 상태 mapping

| SparkApplication/driver 관찰 상태 | AskLake Run 상태 |
| --- | --- |
| 제출 직후, pending | `queued` |
| `SUBMITTED`, `RUNNING` | `running` |
| `COMPLETED`와 physical verification 성공 | `success` |
| `FAILED`, submission failure, deadline 초과 | `failed` |
| 사용자가 삭제 요청하고 종료 확인 | `canceled` |
| 일시적인 API 조회 실패 | 이전 상태 유지, 즉시 terminal로 바꾸지 않음 |

Spark 성공만으로 AskLake Run을 `success`로 확정하지 않는다. Iceberg commit, Trino physical verification, Catalog materialization까지 성공해야 한다.

### 9.4 취소·재시도·복구

- cancel은 SparkApplication 삭제를 요청하고 실제 종료를 확인한 뒤 Run을 `canceled`로 확정한다.
- retry는 기존 API 계약대로 새 Run을 만들고 새 SparkApplication을 제출하며 이전 `runId`를 덮어쓰지 않는다.
- FastAPI 재시작 후 RDS의 non-terminal Run을 조회하고, 저장된 SparkApplication name/UID로 Kubernetes 상태를 재조정한다.
- 같은 `runId`로 SparkApplication을 두 개 생성하지 않는다. 생성 전 RDS reservation과 Kubernetes의 deterministic name을 함께 확인한다.
- Kubernetes API timeout은 실패와 동일시하지 않고 같은 name으로 조회해 생성 성공 여부를 확인한다.

## 10. FastAPI background 계약

### 10.1 불변조건

- FastAPI replica 수와 무관하게 같은 `runId`의 submission/reconciliation은 한 owner만 수행한다.
- background 상태의 source of truth는 Pod memory가 아니라 RDS Run record다.
- lease를 잃은 replica는 외부 상태 변경과 Run terminal 확정을 중단한다.
- 같은 `runId`의 Iceberg/Catalog 결과는 한 번만 materialize된다.

### 10.2 중요한 결정: singleton 방식

이 항목은 단순 표준 형식이 아니라 동시성·복구 방식에 영향을 주므로 A/B 승인이 필요하다.

추천안은 기존 PostgreSQL 운영 패턴을 재사용한 **RDS lease + generation fencing**이다.

```text
RDS Run row claim
→ owner ID와 lease 만료 시각 저장
→ 작업 중 lease 갱신
→ generation이 같은 owner만 상태 저장
→ Pod 종료 후 lease 만료
→ 다른 replica가 claim하고 복구
```

Kubernetes leader election으로 FastAPI 전체를 한 replica에 묶는 방식은 서로 독립적인 여러 Run의 병렬 처리까지 제한할 수 있으므로 기본안으로 사용하지 않는다.

### 10.3 검증 계약

- FastAPI replica 2개에서 같은 실행 요청을 동시에 보내도 SparkApplication은 1개만 생성된다.
- Kubernetes create 응답이 유실돼도 deterministic name 재조회 후 중복 생성하지 않는다.
- owner Pod를 종료하면 lease 만료 후 다른 replica가 같은 `runId`를 이어서 조회한다.
- lease generation이 바뀐 이전 owner의 늦은 응답은 RDS 상태를 덮어쓰지 못한다.
- Spark success 뒤 Catalog 실패 시 Spark를 다시 실행하지 않고 저장된 commit evidence로 Catalog reconciliation만 재시도한다.

## 11. EC2 Continuous 분리 계약

EKS FastAPI는 다음 command를 fail-closed로 차단한다.

- `startContinuous`
- `pauseContinuous`
- `resumeContinuous`
- `stopContinuous`
- Continuous quarantine replay와 maintenance command
- Continuous worker liveness를 근거로 한 lifecycle 변경 sync loop

권장 오류 계약:

```json
{
  "error": {
    "code": "CONTINUOUS_CONTROL_OWNED_BY_EC2",
    "message": "Kafka Continuous control remains owned by the EC2 environment for the EKS MVP."
  }
}
```

EKS는 Continuous 상태를 표시하기 위해 읽기 API를 사용할 수 있지만, worker lifecycle, checkpoint, topic/group offset, maintenance 상태를 변경하지 않는다.

다음 항목은 중요한 결정이므로 A/B 확인 후 확정한다.

- EC2 Continuous가 계속 사용할 API endpoint
- EC2 Continuous state가 기존 EC2 PostgreSQL에 남는지, 공용 RDS를 사용하는지
- EKS의 Continuous 읽기 API가 EC2 endpoint를 조회할지, MVP에서 비활성화할지

분리 증거:

- EKS ServiceAccount/IAM에 Continuous topic/group 권한이 없다.
- EKS FastAPI에서 위 command가 `CONTINUOUS_CONTROL_OWNED_BY_EC2`로 거절된다.
- EKS 배포 전후 EC2 worker ID, checkpoint, consumer group owner가 유지된다.
- EKS test topic/group/output prefix와 EC2 Continuous 값이 다르다.

## 12. 표준 기본값과 중요 결정 분류

### 추천안으로 확정 가능한 표준 형식

- image component, build target, command, port, probe 형식
- ServiceAccount 이름과 namespace-scoped RBAC
- IAM 요청표의 `principal/action/resource/reason` 형식과 wildcard 금지
- ConfigMap/Secret key 분류와 rollout 규칙
- workload별 network source/destination/protocol/direction 표
- SparkApplication label/annotation, 상태 mapping, log reference 형식
- `runId`와 SparkApplication UID를 RDS에 저장하는 형식
- 외부 fixture JSON, batch receipt, topic/group 격리 형식

### A가 결정해야 하는 중요 항목

- MSK Serverless/Provisioned와 IAM/mTLS/SCRAM 인증 방식
- 인증 방식에 따른 실제 broker port와 certificate/secret 전달 방식
- 실제 ECR/MSK/S3/RDS/Trino resource ARN과 endpoint
- 단일 RDS PostgreSQL instance의 크기, storage, backup/retention 정책
- Trino 배치 위치와 port

위 항목은 B에게 결정을 요청하는 목록이 아니다. A의 결정 결과를 B의 ConfigMap, Secret, NetworkPolicy와 client option에 채우기 위한 입력 목록이다.

### A/B가 함께 승인해야 하는 중요 항목

- FastAPI singleton을 RDS lease + generation fencing으로 구현할지 — **보류**
- EC2 Continuous 상태 DB와 읽기 endpoint를 어디에 유지할지 — **보류**
- 최초 resource 값이 NodePool과 비용 한도에 맞는지

### 12.1 표준 계약 검증

manifest와 adapter 구현은 다음 검증을 통과해야 한다.

- manifest schema/dry-run: Kubernetes server-side dry-run에서 Deployment, Role, RoleBinding, SparkApplication이 유효하다.
- RBAC positive: `asklake-fastapi`가 `asklake` namespace의 SparkApplication을 create/get/list/watch/delete할 수 있다.
- RBAC negative: `asklake-fastapi`가 Secret, Node, 다른 namespace, `batch/jobs`를 조회·변경할 수 없다.
- IAM positive: 외부 producer는 test topic produce, Spark는 test topic consume과 지정 S3 prefix write가 가능하다.
- IAM negative: 두 principal 모두 기존 Continuous topic/group과 허용 prefix 밖 S3 object에 접근할 수 없다.
- fake Kubernetes client: create 응답이 timeout이어도 deterministic name 재조회로 같은 `runId`의 CR을 중복 생성하지 않는다.
- fake Kubernetes client: watch 연결이 끊기면 RDS 상태를 유지하고 get/list 재조회로 복구한다.
- fake Kubernetes client: Pod log/Event 접근이 `403`이면 권한 오류를 기록하고 Run 성공으로 처리하지 않는다.
- restart test: owner FastAPI Pod 종료 후 다른 replica가 같은 `runId`와 SparkApplication UID로 상태를 이어받는다.
- Continuous guard test: EKS FastAPI의 모든 Continuous 변경 command가 `CONTINUOUS_CONTROL_OWNED_BY_EC2`로 거절된다.

## 13. 현재 구현과의 차이

이 문서는 인수 계약이며 다음 항목의 구현 완료를 의미하지 않는다.

- Kubernetes Deployment/Service/Role/RoleBinding/SparkApplication manifest는 아직 이 계약에 맞춰 생성·검증해야 한다.
- 현재 FastAPI의 Spark REST 실행 경로를 EKS SparkApplication provider로 연결해야 한다.
- `ASKLAKE_KAFKA_AUTH_MODE`를 Spark Kafka option으로 변환하는 EKS adapter가 필요하다.
- `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`를 검사하는 fail-closed API guard가 필요하다.
- Spark submission/reconciliation의 RDS lease + generation fencing은 A/B 승인 후 구현해야 한다.
- 실제 AWS IAM policy의 ARN과 Network port는 A의 리소스 결정 뒤 채워야 한다.

각 구현 PR은 이 문서의 표준 계약과 fake client/negative permission 검증을 함께 제출해야 한다.

## 14. 공통 안전성 완료 기준

- FastAPI replica가 2개 이상이어도 하나의 논리 background 작업은 한 번만 시작된다.
- FastAPI Pod가 재시작되거나 교체돼도 Job/Run 상태는 RDS에 유지된다.
- 재시작 전후 같은 `runId`로 상태, 로그, 결과를 조회할 수 있다.
- EKS workload는 기존 EC2 Continuous runtime의 lifecycle, topic, group, checkpoint, output을 변경하지 않는다.
- 실제 배포 image와 rollback image는 tag가 아니라 ECR digest로 식별한다.

## 15. A 승인·회신 체크리스트

- [ ] ECR repository URL과 AWS region이 확정됐다.
- [ ] Node architecture가 AMD64임을 확인했다.
- [ ] MSK 유형과 인증 방식이 확정됐다.
- [ ] MSK 유형과 인증 방식은 A가 결정하고 B는 연결 형식만 반영한다는 책임 경계를 확인했다.
- [ ] test topic/group과 fixture producer principal이 확정됐다.
- [ ] 기존 Continuous와 격리할 이름과 권한 경계를 확인했다.
- [ ] 단일 RDS PostgreSQL instance와 세 database/user mapping을 확인했다.
- [ ] RDS, MSK, S3용 Kubernetes Secret/workload identity 생성 책임을 확인했다.
- [ ] Git SHA tag와 ECR digest 기록 방식을 승인했다.
- [ ] FastAPI 중복 방지와 `runId` 복구 완료 기준을 승인했다.
- [ ] FastAPI와 Spark의 namespace-scoped RBAC를 승인했다.
- [ ] workload별 IAM action과 resource ARN에 wildcard가 없음을 확인했다.
- [ ] ConfigMap/Secret key와 network destination 표를 승인했다.
- [ ] 외부 fixture producer 방식이며 EKS Replay Job이 없음을 확인했다.
- [ ] singleton 구현 방식과 EC2 Continuous state 위치가 현재 보류임을 확인했다.
- [ ] Trino 배치 위치와 실제 port는 A가 결정하고 B는 endpoint 형식만 반영한다는 책임 경계를 확인했다.

## 16. 전달용 요약

```text
B 계약 초안입니다.

1. 이미지는 asklake-frontend, asklake-fastapi, asklake-spark 3종이며
   linux/amd64로 빌드합니다. Frontend는 80, FastAPI는 8080과
   /api/health를 사용하고 Spark는 SparkApplication으로 실행합니다.
   Git SHA tag는 표시용이고 실제 배포와 rollback은 ECR digest를 사용합니다.

2. 외부 fixture producer는 격리된 asklake.eks-mvp.fixture.v1 topic에
   JSON을 produce하고, EKS Spark는 asklake-eks-mvp-spark-v1 group으로
   bounded consume합니다. 기존 EC2 Continuous의 topic, group, checkpoint,
   output과 공유하지 않습니다.

3. RDS는 MVP 기준 단일 PostgreSQL instance 안에서 asklake_app,
   airflow_metadata, iceberg_catalog database와 전용 user를 분리합니다.
   MSK 인증 방식과 Trino 배치 위치는 A가 결정하고, B는 선택된 값을
   ConfigMap, Secret, network와 client 형식에 반영합니다.

4. FastAPI singleton 구현 방식과 EC2 Continuous 상태 DB/읽기 endpoint는
   이번 계약에서 보류합니다. EKS가 Continuous 변경 command를 차단하는
   범위만 현재 확정합니다.
```
