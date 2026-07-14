# AskLake EKS + MSK 연동 MVP 전환 로드맵

아래 로드맵은 매일 Merge가 끝났을 때 전체 프로젝트에서 무엇이 완료되고, 무엇이 아직 안 됐으며, 다음 단계가 무엇에 의존하는지를 기준으로 합니다.

> 범위 경계: Kafka broker는 EKS에 설치하지 않고 Amazon MSK를 사용한다. 이번 MVP에는 EKS 밖의 fixture producer가 별도 test topic에 넣은 데이터를 EKS Spark가 bounded consume하는 smoke를 포함한다. 기존 Kafka Continuous의 제어권과 worker 운영 책임은 EC2 환경에 유지하며, EKS가 같은 Continuous runtime을 동시에 제어하지 않는다. Continuous의 EKS 전환은 후속 Phase로 남긴다.

> 완료 선언: 이 6일 계획은 **EKS + MSK 연동 MVP 시연 및 기술 검증**이다. 운영 전환 완료나 기존 EC2 종료를 의미하지 않는다.

## 표시 기준

- ✅ 완료하고 실제 검증함
- 🟡 일부 완료 또는 아직 통합 검증 전
- ⬜ 아직 미완성

## EKS MVP 결과: AS-IS → TO-BE

이번 EKS MVP의 목적은 AskLake의 기능을 새로 만드는 것이 아니라, **현재 EC2 한 대에 묶여 있는 웹·batch 실행·배포·확장 방식을 Kubernetes가 관리하는 구조로 바꾸고, MSK 입력이 EKS Spark와 S3/Iceberg·Trino·Catalog까지 이어지는지 검증하는 것**입니다. Kafka broker 자체와 기존 Continuous worker의 EKS 전환은 완료 조건이 아닙니다.

| 영역 | AS-IS: 현재 | TO-BE: EKS 전환 후 | 최종적으로 확인할 증거 |
| --- | --- | --- | --- |
| 실행 위치 | EC2 한 대의 Docker Compose에서 모든 서비스 실행 | Frontend, FastAPI, Airflow, Spark Operator와 driver/executor를 EKS에서 실행. 테스트 입력 producer는 EKS 밖에서 MSK test topic에 데이터를 넣고, broker는 Amazon MSK를 사용 | `kubectl get pods`와 MSK cluster 정보 |
| 서비스 분리 | 컨테이너가 한 서버와 Compose network에 의존 | 서비스별 Deployment/Service와 Kubernetes DNS로 통신 | 서비스별 Pod/Service 목록 |
| 장애 복구 | 컨테이너 또는 서버 장애 시 수동 복구 가능성 | 죽은 Pod를 EKS가 자동으로 재생성 | Pod 삭제 후 새 Pod가 `Running/Ready` |
| API 확장 | FastAPI 컨테이너 수가 고정됨 | 부하에 따라 FastAPI Pod 수가 HPA로 증가·감소하되 background 작업은 중복 실행되지 않음 | HPA `2 → 6 → 2`와 중복 실행 없음 |
| Background 실행 안전성 | FastAPI process 안의 background 실행이 단일 container 수에 의존 | FastAPI replica 수가 바뀌어도 하나의 논리 작업은 한 번만 실행 | 동일 작업의 중복 Run 없음 |
| Spark 처리 실행 | Spark master/worker가 EC2에서 고정 실행 | Job마다 `SparkApplication`과 driver/executor Pod를 생성하고 `runId`와 SparkApplication UID를 연결 | 동시 Job → driver/executor Pod → Node Running |
| Node 용량 확장 | 서버가 부족하면 더 큰 EC2를 수동으로 준비 | Pod가 배치되지 않으면 Worker Node를 자동 생성 | Pending Pod → 새 Node → Pod Running |
| 부하 감소 | 사용하지 않는 서버와 컨테이너를 수동 정리 | Pod와 빈 Node가 자동으로 축소·제거 | 부하 종료 후 scale-in |
| 데이터 보존 | EC2 또는 host volume 장애가 DB·결과에 영향을 줄 수 있음 | AskLake Job/Run/Catalog, Airflow metadata, Iceberg JDBC Catalog의 PostgreSQL 용도를 구분해 RDS로 이전. 결과·evidence는 S3에 저장 | Pod 교체 후 DB와 S3 결과 유지, migration/rollback 기록 |
| 데이터 파이프라인 | Airflow, Spark, DB가 한 EC2 내부 주소에 의존 | 외부 fixture producer → MSK → EKS SparkApplication → S3/Iceberg → Trino 물리 검증 → Catalog 확정 | AskLake `runId`가 EKS 적재 흐름 전체에서 `success` |
| Kafka broker | Compose의 Redpanda를 직접 운영 | AWS 배포 broker는 Amazon MSK 사용. EKS에는 broker·PVC·operator를 설치하지 않음 | EKS workload에서 MSK bootstrap endpoint 인증 성공 |
| Kafka 연동 smoke | Local Redpanda fixture input 중심 | EKS 밖 fixture producer가 전용 test topic에 입력하고 EKS Spark가 전용 group으로 bounded smoke 실행 | FastAPI 재시작·확장 후에도 AskLake `runId`로 적재 상태·로그·결과 추적 |
| Kafka Continuous | 기존 EC2 FastAPI control plane과 worker가 lifecycle·checkpoint 처리 | 제어권과 상태 관리 책임 전체를 EC2에 유지하고 EKS 이전은 후속 Phase로 분리 | EKS와 EC2가 같은 Continuous runtime을 동시에 변경하지 않음 |
| Trino 검증 | 선택 profile 또는 기존 endpoint | Phase 0에서 EKS 배치 또는 기존/공용 endpoint를 선택하고 Iceberg table/snapshot/data file을 검증 | Trino physical verification 결과 |
| 배포 변경 | EC2 접속 후 Compose 재배포 | Git SHA tag는 표시용, ECR image digest는 실제 배포·rollback 기준으로 사용 | 배포 digest와 rollback digest 기록 |
| 관찰 | Docker 로그와 EC2 상태를 직접 확인 | `kubectl`, HPA, Node 상태와 CloudWatch 로그로 확인 | Pod·HPA·Node·로그 화면 |
| 롤백 | 기존 Compose 재실행 | EKS 실패 시 기존 EC2 Compose를 롤백 경로로 유지 | EKS 중단 후 EC2 서비스 복구 |

### 최종적으로 만들어져 있어야 하는 것

일요일에는 다음 구성과 검증 결과가 하나의 EKS 환경에 남아 있어야 합니다.

- EKS Cluster와 NodePool
- ECR 이미지, 표시용 Git SHA tag, 배포·rollback 기준 ECR image digest
- Frontend/FastAPI/Airflow/Spark Operator와 batch Spark용 Kubernetes workload, Service, ConfigMap, Secret reference
- ALB/Ingress를 통한 외부 URL
- Amazon MSK와 인증 방식, EKS→MSK network/IAM 검증, 격리된 test topic/group, EKS 밖 fixture producer 실행 경로
- AskLake·Airflow metadata·Iceberg JDBC Catalog의 RDS mapping과 migration/rollback 기록
- S3 연결과 필요한 경우에만 Airflow 공유 파일용 EFS 연결
- EKS 또는 기존/공용 Trino endpoint와 물리 검증 evidence
- FastAPI HPA와 Spark Job driver/executor 자원 요청
- FastAPI 확장 시 background 작업이 중복되지 않는 검증 결과
- FastAPI 재시작·확장 이후에도 AskLake Job 상태·로그·결과가 같은 `runId`로 이어지는 검증 결과
- Continuous 제어권이 EC2에만 있으며 EKS가 같은 runtime을 변경하지 않는 범위 증거
- Worker Node 자동확장·자동축소 정책
- Pod 장애 복구와 Rolling Update 검증 결과
- `runId` ↔ SparkApplication UID, driver 종료 사유·로그·heartbeat 연결 결과
- `kubectl` 및 CloudWatch 관찰 경로
- 전체 시연 순서와 실패 시 EC2 롤백 경로

즉 최종 결과는 **“AskLake 서비스가 EKS에서 자동복구·자동확장되고, EKS 밖 fixture producer가 넣은 격리된 MSK test data가 EKS Spark를 거쳐 S3/Iceberg·Trino·Catalog까지 도달하는 것이 증명된 MVP”**입니다. 기존 Kafka Continuous의 EKS 전환과 운영 전환 완료는 별도 후속 결과물입니다.

## 전체 기능 진행표

| 기능 | 화 7/14 | 수 7/15 | 목 7/16 | 금 7/17 | 토 7/18 | 일 7/19 |
| --- | --- | --- | --- | --- | --- | --- |
| EKS 클러스터/ECR | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MSK 방식·인증·Trino 위치 결정 | ✅ 결정 | ✅ | ✅ | ✅ | ✅ | ✅ |
| EKS → MSK network/IAM | ⬜ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 서비스별 Pod 분리 | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| 외부 URL 접속 | ⬜ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3개 PostgreSQL 용도별 RDS 이전/S3 보존 | ⬜ | 🟡 연결·이전 | ✅ | ✅ | ✅ | ✅ |
| Pod 자동 재생성 | ⬜ | 🟡 웹 계층 | 🟡 전체 배포 | 🟡 | ✅ 장애 검증 | ✅ |
| 외부 fixture producer → MSK → Spark → Iceberg → Trino → Catalog | ⬜ | 🟡 외부 입력 경로 확인 | ✅ | ✅ | ✅ | ✅ |
| FastAPI 재시작·확장 후 AskLake Run 상태·로그·결과 복구 | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ |
| `runId` ↔ SparkApplication UID/상태 연결 | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ |
| FastAPI 확장 시 background 중복 방지 | ⬜ | 🟡 2개 replica | 🟡 | ✅ HPA 검증 | ✅ | ✅ |
| EC2 Continuous 제어권 단일화 | ✅ 범위 결정 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 기존 Kafka Continuous EKS 전환 | 후속 | 후속 | 후속 | 후속 | 후속 | 후속 |
| FastAPI Pod 자동 증가 | ⬜ | ⬜ | ⬜ | ✅ | ✅ | ✅ |
| Spark batch driver/executor 실행 | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ |
| Worker Node 자동 증가 | 🟡 샘플 검증 | 🟡 | 🟡 | ✅ AskLake 부하 | ✅ | ✅ |
| Pod/Node 자동 감소 | 🟡 샘플 검증 | 🟡 | 🟡 | ✅ | ✅ | ✅ |
| image digest 기준 Rolling Update/rollback | ⬜ | ⬜ | ⬜ | ⬜ | ✅ | ✅ |
| kubectl/CloudWatch 관찰 | 🟡 kubectl | 🟡 | 🟡 | 🟡 | ✅ | ✅ |
| 최종 통합 시연 | ⬜ | ⬜ | ⬜ | ⬜ | 🟡 리허설 | ✅ |

## 기능 의존 관계

```text
EKS Cluster + ECR digest 규칙 + MSK/Trino/RDS 결정
        ↓
Frontend/FastAPI Pod + RDS 배치 + EKS→MSK 연결
        + FastAPI 확장 안전성 + Continuous 제어권 경계
        ↓
Airflow + Spark Operator + Trino 연결
        ↓
외부 fixture input + 재시작 가능한 AskLake Run 상태 + MSK bounded E2E 성공
        ↓
HPA로 Pod 증가
        ↓
Node 자동 증가/감소
        ↓
장애 복구 + Rolling Update + CloudWatch
        ↓
최종 시연
```

앞 단계가 통과하지 않으면 뒤 단계는 검증할 수 없습니다.

- MSK bounded E2E가 한 번도 성공하지 않았는데 Spark 동시 Job과 Node 확장부터 테스트하면 안 됩니다.
- Pod가 정상 실행되지 않는데 Node autoscaling부터 테스트하면 원인 구분이 안 됩니다.
- MVP test topic/group/output prefix를 기존 Continuous와 공유하면 smoke가 운영 데이터에 영향을 줄 수 있으므로 반드시 분리해야 합니다.
- FastAPI replica 증가가 동일 background 작업의 중복 실행으로 이어지면 HPA 완료로 인정하지 않습니다.
- FastAPI 재시작이나 replica 변경 후 AskLake Run 상태·로그·결과를 같은 `runId`로 찾을 수 없으면 bounded smoke 완료로 인정하지 않습니다.
- EKS와 EC2가 같은 Continuous runtime을 동시에 변경할 수 있으면 범위 분리가 완료된 것이 아닙니다.

---

## 7/14 화요일 — EKS가 실제로 작동하는 상태

### 전체 프로젝트 목표

AskLake를 올리기 전에 EKS 자체가 Pod와 Node를 정상적으로 만들 수 있는지 검증하고, MSK·Trino·RDS·image 식별 방식을 문서로 확정합니다.

### 이날 새로 완성되는 기능

| 담당자 A | 담당자 B |
| --- | --- |
| EKS Auto Mode Cluster와 NodePool | Frontend/FastAPI/Spark AMD64 image |
| Metrics Server와 ECR 저장소 | Kubernetes Deployment/Service/Job 기본 YAML |
| 테스트 Pod와 Node scale-out/in | ConfigMap/Secret reference 기본 구조 |
| MSK Serverless+IAM 또는 Provisioned+IAM/mTLS/SCRAM 결정 | Git SHA tag와 ECR digest 기록 규칙 |
| Trino 배치 위치 결정 | 3개 PostgreSQL 용도와 RDS 이전 순서 정의 |
| Continuous 제어권을 EC2에 유지하는 범위 확정 | FastAPI 확장·AskLake Run 재시작 안전성 완료 기준 정의 |

### Merge 후 완료 상태

| 기능 | 상태 |
| --- | --- |
| EKS 클러스터 | ✅ |
| ECR image push | ✅ |
| Kubernetes YAML 기본 구조 | ✅ |
| MSK cluster 유형·인증 방식 | ✅ 결정 완료 |
| Trino 배치 위치 | ✅ 결정 완료 |
| RDS migration/rollback 범위 | ✅ 문서화 |
| image digest 기준 | ✅ 문서화 |
| Continuous 제어권 소유 환경 | ✅ EC2로 확정 |
| 확장·재시작 안전성 원칙 | ✅ 문서화 |
| 테스트 Pod 실행 | ✅ |
| 샘플 Node 자동 증가 | ✅ |
| 실제 AskLake 배포 | ⬜ |
| 실제 ETL | ⬜ |
| AskLake HPA | ⬜ |

### 이날 확인할 수 있는 화면

```bash
kubectl get nodes
kubectl get pods -A
kubectl top nodes
```

보여야 하는 흐름:

```text
테스트 Pod 생성
→ 기존 Node 용량 부족
→ 새 Node 생성
→ Pod Running
```

### 이날 기능이 의존하는 것

- AWS 계정 권한
- VPC/Subnet
- EKS 생성 권한
- EC2/ECR/IAM/MSK 권한
- AMD64 image
- 기존 MSK가 있다면 cluster ARN/bootstrap endpoint와 network 정보
- Trino 기존/공용 endpoint 유무

### 다음 단계와의 연결

수요일의 Frontend/FastAPI는 아래 항목이 있어야 배포할 수 있습니다.

- EKS Cluster
- ECR image
- Node
- Metrics Server
- Kubernetes 기본 YAML
- 승인된 MSK 인증 방식과 test topic/group naming, EKS 밖 fixture producer 실행 경로
- RDS database/user mapping과 rollback 기준
- Trino endpoint 또는 EKS 배치 결정
- EKS와 EC2의 Continuous 제어권 경계
- FastAPI 확장과 AskLake Run 재시작 시 지킬 완료 원칙

### 화요일 Merge 통과 조건

EKS에서 테스트 Pod가 실행되고 Node 증가가 한 번 보이며, 아래 결정표가 승인되면 통과입니다.

- MSK 유형·인증 방식
- 외부 fixture producer와 Spark의 test topic 권한·입력 경계
- Trino 배치 위치
- AskLake/Airflow/Iceberg JDBC의 RDS mapping
- Git SHA tag와 ECR image digest 사용 기준
- Continuous 제어권과 상태 관리 책임이 EC2에만 있다는 범위
- background 중복 방지와 AskLake Run 상태 복구 완료 기준

AskLake가 아직 접속되지 않는 것은 정상입니다.

---

## 7/15 수요일 — AskLake 웹 화면이 EKS에서 열리는 상태

### 전체 프로젝트 목표

외부 사용자가 EKS에 배포된 AskLake Frontend와 FastAPI에 접속하고, EKS workload가 RDS·S3·MSK private endpoint에 접근할 수 있게 만듭니다. FastAPI replica가 여러 개여도 background 작업이 중복되지 않고, Continuous 제어권은 EC2에만 유지되어야 합니다.

### 이날 새로 완성되는 기능

| 담당자 A | 담당자 B |
| --- | --- |
| ALB/Ingress | Frontend Deployment/Service |
| 3개 용도별 RDS database/user와 migration/backup | FastAPI Deployment/Service |
| S3와 MSK용 workload identity | RDS endpoint/Secret reference |
| VPC subnet·security group·private DNS·egress | S3 환경변수와 readiness/liveness probe |
| EKS→MSK bootstrap endpoint 접근 검증 | IAM 인증 client smoke Pod |
| 필요 시 Airflow 공유 파일용 EFS | FastAPI replica 2개 |
| EC2/EKS Continuous 제어권 경계 검증 | FastAPI 다중 replica 실행 안전성 검증 |

### Merge 후 완료 상태

| 기능 | 상태 |
| --- | --- |
| 외부 URL로 Frontend 접속 | ✅ |
| `/api/health` 호출 | ✅ |
| Frontend/FastAPI Pod 분리 | ✅ |
| FastAPI Pod 2개 실행 | ✅ |
| FastAPI Pod 자동 재생성 | ✅ 기본 동작 |
| AskLake Job/Run/Catalog RDS 연결 | ✅ |
| Airflow metadata·Iceberg JDBC RDS mapping | ✅ 연결 또는 migration 준비 완료 |
| S3 권한 | ✅ |
| EKS → MSK network/IAM 인증 | ✅ |
| FastAPI replica 증가 시 background 중복 방지 | ✅ 2개 replica 기준 |
| Continuous 제어권·상태 관리 책임 | ✅ EC2에만 유지 |
| Airflow/Spark 일반 batch | ⬜ |
| ETL 실행 | ⬜ |
| HPA | ⬜ |
| Node 자동확장 실서비스 검증 | ⬜ |

### 이날 확인할 수 있는 화면

브라우저에서 ALB URL에 접속해 AskLake 화면이 표시되는지 확인합니다.

```bash
kubectl get pods -n asklake
```

예상 상태:

```text
frontend-xxxxx     Running
frontend-yyyyy     Running
fastapi-xxxxx      Running
fastapi-yyyyy      Running
```

자동 복구 테스트:

```text
FastAPI Pod 하나 삭제
→ 새로운 FastAPI Pod 생성
→ /api/health 계속 성공
```

MSK 연결 확인:

```text
EKS test client Pod
→ private bootstrap endpoint 연결
→ 선택한 IAM/mTLS/SCRAM 인증 성공
→ test topic metadata 조회
```

### 아직 미완성인 것

- Job 실행
- Airflow DAG
- Spark 데이터 처리
- EKS 밖 fixture producer의 test topic 입력
- Spark의 MSK consume
- S3 결과 생성
- Trino physical verification
- Catalog Dataset 생성
- FastAPI HPA
- Spark 동시 Job/Node 확장
- 실제 Node autoscaling

즉, 화면은 열리지만 데이터 파이프라인은 아직 작동하지 않습니다.

### 이날 기능이 의존하는 것

- 화요일 EKS Cluster
- 화요일 ECR image
- 정상적인 Node
- ALB가 사용할 public subnet
- FastAPI가 사용할 RDS/S3 권한
- MSK와 EKS 사이의 VPC/Subnet/Security Group/private DNS
- 외부 fixture producer와 Spark에 분리할 MSK test topic 권한
- FastAPI replica 수와 무관하게 하나의 논리 background 작업이 한 번만 실행된다는 기준
- EKS와 EC2가 같은 Continuous runtime을 동시에 변경하지 않는 범위

### 다음 단계와의 연결

Airflow는 FastAPI internal API를 호출하고, FastAPI는 SparkApplication을 생성합니다. 목요일 bounded smoke 전에 RDS/S3 연결과 EKS→MSK network/IAM 인증이 각각 독립적으로 성공해야 합니다.

### 수요일 Merge 통과 조건

외부 URL에서 AskLake와 `/api/health`가 열리고, FastAPI Pod 삭제 후 자동 복구되며, EKS test client가 MSK bootstrap endpoint에 인증되면 통과입니다. FastAPI replica가 2개여도 동일 background 작업이 중복되지 않고, Continuous runtime의 제어권이 EC2에만 있다는 것이 확인돼야 합니다. RDS 이전은 migration receipt와 EC2 rollback 기준까지 남깁니다.

---

## 7/16 목요일 — MSK 입력부터 Catalog까지 bounded E2E가 성공하는 상태

### 전체 프로젝트 목표

격리된 test data를 MSK에 넣고 EKS Spark가 처리한 뒤, S3/Iceberg commit을 Trino로 물리 검증하고 Catalog를 확정하는 흐름을 끝까지 실행합니다.

### 이날 새로 완성되는 기능

| 담당자 A | 담당자 B |
| --- | --- |
| Airflow metadata·Iceberg JDBC RDS migration 검증 | Airflow API/Scheduler/DAG Processor Pod |
| 필요한 경우 Airflow 공유 파일용 EFS | Spark Operator와 SparkApplication 연결 |
| 외부 fixture producer의 MSK test topic 접근 경로와 runbook | `runId` ↔ SparkApplication UID 연결 |
| Spark MSK consume/group·S3 권한 | Spark driver/executor resource와 MSK source boundary 연결 |
| test topic/group/output/checkpoint prefix 격리 | AskLake 실행 상태·로그·결과의 `runId` 추적 |
| Trino endpoint network/IAM/DB 권한 | Iceberg commit → Trino 검증 → Catalog materialization |

### Merge 후 완료 상태

| 기능 | 상태 |
| --- | --- |
| Frontend/FastAPI | ✅ |
| Airflow Pod 분리 | ✅ |
| Spark Operator와 driver/executor Pod 실행 | ✅ |
| AskLake Job/Airflow DAG 실행 | ✅ |
| 외부 fixture producer → MSK test topic 입력 evidence | ✅ |
| FastAPI 재시작·확장 후 AskLake Run 상태·로그·결과 추적 | ✅ |
| Spark MSK consume와 Iceberg commit | ✅ |
| Trino table/snapshot/data file 검증 | ✅ |
| Catalog Dataset materialization | ✅ |
| `runId` ↔ SparkApplication UID·상태 연결 | ✅ |
| RDS/S3 데이터 보존 | ✅ |
| Pod 자동 재생성 | 🟡 재생성되지만 장애 시나리오 미검증 |
| FastAPI HPA / Spark 동시 Job Node 확장 | ⬜ |
| 실제 Node 자동확장 | ⬜ |
| 기존 Kafka Continuous EKS 전환 | 후속 Phase |

### 이날 확인할 수 있는 흐름

```text
AskLake Job 실행
↓
Airflow DAG Running
↓
외부 fixture producer → MSK test topic
↓
SparkApplication driver/executor Running
↓
S3/Iceberg commit
↓
Trino physical verification
↓
Catalog Dataset 생성 → Run success
```

확인할 곳:

- AskLake Run History와 Airflow DAG
- MSK test topic/group
- 외부 fixture producer의 batch marker·입력 건수와 FastAPI 재시작·replica 변경 전후 동일 AskLake `runId` 상태·로그
- SparkApplication UID와 driver/executor 로그
- S3/Iceberg object·metadata
- Trino table/snapshot/data file 확인 결과
- Catalog Dataset과 RDS Run/Catalog row

### 아직 미완성인 것

- 부하에 따른 FastAPI Pod 증가
- 동시 Spark Job에 따른 executor Pod와 Node 증가
- 실제 AskLake workload 기반 Node 증가와 scale-in
- Rolling Update와 CloudWatch 통합
- 장애·재시도 검증
- 기존 EC2 Continuous worker의 EKS 전환

즉, bounded 기능 흐름은 동작하지만 확장성과 운영 검증은 아직 안 된 상태입니다.

### 이날 기능이 의존하는 것

- 수요일 Frontend/FastAPI와 RDS/S3 연결
- EKS→MSK network/IAM 인증
- 격리된 test topic/group/output/checkpoint prefix
- 외부 fixture producer와 분리된 AskLake Run 상태·로그·결과 추적 기준
- 필요한 경우에만 Airflow 공유 파일용 EFS
- Airflow와 FastAPI의 internal token
- FastAPI와 Spark Kubernetes provider 연결
- Trino endpoint

### 다음 단계와의 연결

정상 bounded Job 하나가 성공해야 부하를 늘렸을 때 실패 원인을 구분할 수 있습니다.

```text
단일 MSK bounded Job 성공
→ 여러 Job 동시 실행
→ executor Pod와 Node 용량 부족 확인
→ Node 확장
```

### 목요일 Merge 통과 조건

외부 fixture producer의 batch marker와 MSK test input이 AskLake `runId`, Airflow, SparkApplication UID, S3/Iceberg, Trino verification, Catalog에 연결되고 Job이 `success`가 되면 통과입니다. FastAPI가 재시작되거나 replica가 바뀌어도 같은 실행을 계속 조회할 수 있어야 합니다.

기존 EC2 Continuous control plane/worker와 MVP smoke는 topic, consumer group, checkpoint/output prefix를 공유하지 않습니다. EKS는 같은 Continuous runtime을 제어하지 않으며, Continuous의 EKS 전환은 이번 완료 주장에 포함하지 않습니다.

---

## 7/17 금요일 — 자동확장이 실제로 보이는 상태

### 전체 프로젝트 목표

요청과 처리량이 늘어나면 Pod와 Node가 자동으로 증가하고, 부하가 사라지면 다시 감소하게 만듭니다.

### 이날 새로 완성되는 기능

| 담당자 A | 담당자 B |
| --- | --- |
| General NodePool | FastAPI HPA |
| Spark 전용 Data NodePool | 격리된 MSK test group을 사용한 Spark 동시 Job 부하 테스트 |
| Node label/taint | FastAPI 부하 테스트 |
| Node 최대 CPU/메모리 | Spark driver/executor resource request와 동시 실행 테스트 |
| Node scale-out/scale-in | CPU/memory requests와 limits |
| Autoscaling event 수집 |  |

### Merge 후 완료 상태

| 기능 | 상태 |
| --- | --- |
| FastAPI Pod 자동 증가 | ✅ |
| FastAPI 확장 중 background 작업 중복 방지 | ✅ |
| Spark driver/executor Pod 실행 | ✅ |
| Pending Pod 발생 | ✅ |
| Worker Node 자동 증가 | ✅ |
| 부하 종료 후 Pod 감소 | ✅ |
| 빈 Node 자동 제거 | ✅ |
| ETL 동시 실행 | ✅ |
| S3/Iceberg·Trino·Catalog 결과 | ✅ |
| MSK test topic/group 격리 | ✅ |
| Rolling Update | ⬜ |
| 전체 장애 복구 검증 | ⬜ |
| CloudWatch 통합 | ⬜ |

### 이날 확인할 수 있는 흐름

**FastAPI**

```text
FastAPI 2 Pods
→ API 부하
→ FastAPI 4~6 Pods
→ 동일 background 작업의 중복 실행 없음
```

**Spark batch**

```text
동시 Job 3~4개
→ driver/executor Pod 생성
→ 기존 Node 부족 시 Pending
```

**Node**

```text
새 driver/executor Pod Pending
→ Data Node 생성
→ Pending Pod Running
```

**축소**

```text
부하 종료
→ Pod 감소
→ 빈 Node 제거
```

### 아직 미완성인 것

- 새 image의 무중단 배포
- CloudWatch에서 통합 로그 확인
- Pod/Node 장애 시나리오 반복
- 기존 EC2 rollback 검증
- 최종 시연 자동화

### 이날 기능이 의존하는 것

- 목요일 단일 MSK bounded E2E 성공
- Metrics Server
- FastAPI HPA 대상의 CPU/memory requests
- FastAPI replica 수가 바뀌어도 하나의 논리 background 작업이 중복되지 않는 기준
- NodePool의 충분한 최대 용량
- Spark driver/executor가 새 Node에서 사용할 S3 권한
- 여러 Job을 만들 테스트 데이터
- 동시 Job끼리 충돌하지 않는 test consumer group/output prefix

### 다음 단계와의 연결

토요일에는 정상 확장된 시스템을 일부러 깨뜨려 복구 여부를 확인합니다. 정상 확장이 먼저 증명되지 않으면 장애 테스트 결과도 신뢰할 수 없습니다.

### 금요일 Merge 통과 조건

FastAPI Pod 증가, 동시 Spark Job의 driver/executor Pod 실행, Node 증가, 부하 종료 후 감소가 모두 실제로 관찰되고 각 Job의 MSK group·Iceberg output이 충돌하지 않으면 통과입니다. FastAPI HPA 전 과정에서 동일 background 작업이 중복 실행되지 않아야 합니다.

---

## 7/18 토요일 — 장애·배포·관찰까지 완성된 상태

### 전체 프로젝트 목표

단순히 돌아가는 EKS가 아니라, 죽어도 복구되고 변경해도 중단되지 않으며 상태를 추적할 수 있는 EKS를 만듭니다.

### 이날 새로 완성되는 기능

| 담당자 A | 담당자 B |
| --- | --- |
| CloudWatch 로그 | Git SHA 표시 tag와 ECR image digest 기록 |
| EKS event 수집 | digest 기준 Rolling Update와 rollback |
| 비용 제한 확인 | Frontend/FastAPI Pod 삭제 테스트 |
| Node/Pod 장애 확인 | Spark driver/executor 및 MSK 인증 실패 기록 테스트 |
| 기존 EC2 rollback 경로 | Job retry |
| 운영 확인 명령 | E2E smoke script |
|  | 중복 Catalog 등록 검증 |

### Merge 후 완료 상태

| 기능 | 상태 |
| --- | --- |
| 서비스별 Pod 분리 | ✅ |
| Pod 자동 재생성 | ✅ |
| FastAPI 자동확장 | ✅ |
| Spark driver/executor Pod 실행 | ✅ |
| Node 자동확장/축소 | ✅ |
| RDS/S3 데이터 보존 | ✅ |
| FastAPI 재시작 후 AskLake Run 상태·로그·결과 복구 | ✅ |
| Continuous 제어권 단일화 | ✅ |
| Rolling Update | ✅ |
| kubectl 관찰 | ✅ |
| CloudWatch 관찰 | ✅ |
| E2E 반복 검증 | ✅ |
| 최종 발표 리허설 | 🟡 |

### 이날 확인할 수 있는 흐름

**장애 복구**

```text
Pod 삭제
→ 새로운 Pod 자동 생성
→ 서비스 다시 Ready
```

**Rolling Update**

```text
새 image 배포
→ 새 Pod Ready
→ 기존 Pod 종료
→ 외부 URL 계속 응답
```

배포 evidence에는 사람이 읽는 Git SHA tag와 실제 실행 image digest를 함께 남기며, rollback은 이전 digest를 기준으로 합니다.

**데이터 보존**

```text
FastAPI Pod 교체
→ RDS의 Job/Run 유지
→ AskLake Run 상태·로그·결과 추적 유지
→ S3 결과 유지
→ Catalog 유지
```

**관찰**

```text
kubectl
→ Pod/HPA/Node 상태 확인

CloudWatch
→ 서비스 로그와 장애 시점 확인
```

### 아직 미완성인 것

기술 기능은 대부분 완료입니다. 남은 것은 다음입니다.

- 시연 순서 고정
- 증거 화면 정리
- 발표자 역할 분담
- 실패 시 대체 시나리오
- 전체 시나리오 연속 리허설

### 이날 기능이 의존하는 것

- 금요일 HPA와 Node autoscaling 성공
- 이전/신규 ECR image digest
- readiness probe
- 최소 2개의 FastAPI replica
- RDS/S3에 상태가 외부화돼 있을 것
- 로그에 `runId`가 남을 것

### 토요일 Merge 통과 조건

전체 bounded 시나리오를 3번 연속 실행하고, Pod 삭제 및 digest 기준 Rolling Update/rollback 후에도 데이터가 유지되면 통과입니다. 외부 fixture input의 batch marker, MSK 인증 실패, Spark driver 실패와 AskLake Run 상태·로그·결과가 같은 `runId` evidence에 남아야 합니다. EKS가 EC2 소유 Continuous runtime을 변경하지 않았다는 범위도 확인합니다.

---

## 7/19 일요일 — 최종 결과를 보여주는 날

### 전체 프로젝트 목표

지금까지 완성한 기능을 추가 개발 없이 한 흐름으로 재현합니다.

### 이날 새로 개발하는 기능

없습니다. 일요일에는 배포 설정이나 코드를 새로 추가하지 않습니다.

### 최종 완료 상태

| TO-BE 항목 | 최종 증거 |
| --- | --- |
| 서비스별 Pod 분리 | `kubectl get pods` |
| Pod 자동 재생성 | Pod 삭제 후 새 Pod |
| FastAPI Pod 자동 증가 | HPA 2 → 6 |
| Background 중복 방지 | FastAPI HPA 중 동일 논리 작업이 한 번만 실행된 evidence |
| Spark batch 실행 | 동시 Job의 driver/executor Pod와 Job 상태 |
| MSK bounded 연동 | 외부 fixture producer 입력과 Spark consume evidence |
| AskLake Run 재시작 복구 | FastAPI 교체 전후 같은 `runId`의 상태·로그·결과 |
| Continuous 제어권 경계 | EC2만 runtime을 제어하고 EKS는 변경하지 않은 evidence |
| Iceberg·Trino·Catalog 정합성 | commit 후 table/snapshot/data file 검증과 Catalog row |
| Worker Node 자동 증가 | `kubectl get nodes` |
| Pod/Node 자동 감소 | 부하 종료 후 scale-in |
| RDS/S3 데이터 보존 | Pod 교체 후 Job/Catalog 유지 |
| Rolling Update/rollback | image digest 변경·복귀 중 URL 정상 |
| kubectl/CloudWatch 관찰 | Pod·HPA·Node·로그 화면 |

### 최종 시연 의존성

```text
EKS 정상
+ ALB 정상
+ RDS 정상
+ S3 정상
+ MSK network/IAM 정상
+ Airflow 정상
+ Spark 정상
+ Trino 정상
+ 부하 테스트 준비
+ 관찰 터미널 준비
+ FastAPI 확장 중 background 중복 없음
+ AskLake Run 재시작 복구와 Continuous 제어권 경계 확인
= 최종 시연 가능
```

## 매일 전체 프로젝트가 도달하는 지점

| 날짜 | 전체 프로젝트 상태 |
| --- | --- |
| 화요일 | EKS 기반과 MSK/Trino/RDS/digest 결정 완성. 하지만 AskLake는 아직 없음 |
| 수요일 | AskLake 웹 서비스와 EKS→MSK 인증 완성. FastAPI 다중 replica 안전성과 EC2 Continuous 제어권 경계 확인. 하지만 data E2E는 아직 안 됨 |
| 목요일 | 외부 fixture producer 입력과 AskLake Run 재시작 복구를 포함한 MSK→Spark→Iceberg→Trino→Catalog bounded E2E 완성. Continuous 전환과 자동확장은 아직 안 됨 |
| 금요일 | Pod/Node 자동확장 완성. 하지만 운영·장애 검증은 아직 안 됨 |
| 토요일 | 복구·배포·관찰까지 기술 완성. 발표 준비만 남음 |
| 일요일 | 전체 기능을 한 시나리오로 시연 |

## 가장 중요한 기준

각 날짜의 미완성 기능은 다음 날짜에 무작정 넘기는 작업 목록이 아니라, 그날 완료 기능을 선행 조건으로 가지는 다음 단계입니다.

그래서 목요일의 단일 MSK bounded E2E 성공 전에는 금요일 오토스케일링으로 넘어가면 안 되고, 금요일 확장 성공 전에는 토요일 장애 테스트로 넘어가면 안 됩니다.

일요일에 선언할 수 있는 것은 EKS + MSK 연동 MVP 기술 검증 완료입니다. 기존 Continuous의 EKS 이전, 운영 부하·복구·비용 기준, shadow 비교, EC2 종료 승인은 후속 Phase에서 별도로 통과해야 합니다.

이 로드맵은 구현 방법을 고정하지 않습니다. 담당자는 다음 세 가지 불변조건을 만족하는 방식을 선택하고, Merge evidence로 증명해야 합니다.

- FastAPI replica 수가 바뀌어도 하나의 논리 background 작업은 한 번만 실행됩니다.
- FastAPI가 재시작되거나 확장돼도 AskLake Run 상태·로그·결과는 같은 `runId`로 추적됩니다.
- 하나의 Continuous runtime은 EC2와 EKS 중 하나의 control plane만 변경하며, 이번 MVP에서는 EC2가 소유합니다.
