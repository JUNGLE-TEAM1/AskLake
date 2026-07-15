# EKS MVP 7월 15일 RDS 분석 결과

## 목적과 범위

이 문서는 `docs/eks-roadmap.md`의 7월 15일 담당자 A 범위인 PostgreSQL RDS 구성, 세 용도별 database/user 분리, migration·backup·rollback 준비를 위해 작성한 생성 전 분석 기록이다.

분석일은 2026-07-15이며 대상은 서울 리전의 `dev` EKS MVP다. 이 분석에서는 AWS와 EC2의 상태를 읽기 전용으로 확인하고 Terraform plan까지만 실행했다. RDS 생성, database 변경, dump·restore와 애플리케이션 전환은 수행하지 않았다.

계정 ID, instance ID, endpoint, ARN, username과 password는 기록하지 않는다.

## 결론

dev MVP의 첫 RDS는 다음 구성을 권장한다.

```text
engine: PostgreSQL 16.14
instance: db.t4g.small
deployment: Single-AZ
storage: gp3 20 GiB
storage autoscaling ceiling: 100 GiB 추가 필요
encryption: enabled
public access: disabled
master credential: RDS managed Secrets Manager secret
backup retention: 7 days
deletion protection: enabled
final snapshot: required
auto minor upgrade: enabled
logical databases: asklake_app, airflow_metadata, iceberg_catalog
```

현재 코드로 이 입력을 사용한 Terraform plan은 기존 resource 변경이나 삭제 없이 다음 네 resource만 새로 만들도록 확인됐다.

- RDS PostgreSQL instance
- DB subnet group
- RDS private security group
- EKS에서 RDS `5432/tcp`로 들어오는 security group rule

이 결과는 생성 권고이지 apply 승인 기록이 아니다. 아래 Terraform 보완과 migration 경계 확인 후에만 생성한다.

## 조사한 현재 상태

### 기존 EC2 PostgreSQL

실행 중인 AskLake EC2를 SSM read-only command로 확인했다.

AskLake application PostgreSQL은 16.14다. 현재 database 크기는 약 15.2MB, user table은 28개, 통계상 row는 약 548개, 조회 시 연결은 13개였다.

Airflow metadata PostgreSQL도 16.14다. 현재 database 크기는 약 12.6MB, user table은 71개, 통계상 row는 약 18개, 조회 시 연결은 5개였다.

두 active database를 합쳐도 약 28MB이며 현재 관찰 연결은 18개다. 용량은 매우 작지만, EKS에서는 FastAPI replica 2개, Airflow API Server·Scheduler·DAG Processor, Spark와 Trino JDBC Catalog가 같은 RDS instance를 사용하므로 크기보다 동시 connection과 순간 CPU가 sizing 기준이다.

### 현재 database 배치

기존 EC2에는 AskLake와 Airflow가 서로 다른 PostgreSQL container로 실행된다. AskLake database 안에는 application table과 Iceberg JDBC Catalog table이 함께 있다.

Application 영역에는 Job/Run/Catalog, identity, SQL, Dashboard와 Kafka Continuous 관련 table이 있다. Iceberg JDBC 영역은 `iceberg_namespace_properties`, `iceberg_tables` 두 table이며 별도 owner를 사용하지만 현재는 application database의 `public` schema에 있다.

RDS에서는 하나의 PostgreSQL instance 안에서 다음 세 database와 login role로 분리한다.

- `asklake_app` / `asklake_app`
- `airflow_metadata` / `airflow_app`
- `iceberg_catalog` / `iceberg_catalog`

저장소의 bootstrap SQL은 이 구조를 멱등 생성하고 각 role에서 superuser, database/role 생성, replication과 bypass-RLS 권한을 제거한다.

## PostgreSQL version 분석

서울 리전은 조사 시점에 PostgreSQL 14.23, 15.18, 16.14, 17.10과 18.4 등을 제공한다. 현재 EC2 application과 Airflow가 모두 PostgreSQL 16.14이고, Airflow 3.3.0은 PostgreSQL 13~17을 테스트 대상으로 명시한다.

따라서 PostgreSQL 16.14가 가장 낮은 migration 위험을 갖는다.

- 현재 EC2와 major/minor version이 같다.
- dump/restore와 schema migration에서 major version 차이를 만들지 않는다.
- Airflow 3.3.0 지원 범위 안이다.
- Spark JDBC driver와 Trino JDBC Catalog가 이미 PostgreSQL 16 local runtime에서 검증됐다.
- PostgreSQL 17/18로 올려 얻는 MVP 이익보다 호환성 확인 범위가 더 크다.

참고:

- [Amazon RDS for PostgreSQL release versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html)
- [Airflow 3.3.0 prerequisites](https://airflow.apache.org/docs/apache-airflow/stable/installation/prerequisites.html)

## Instance class 분석

### `db.t4g.micro`를 제외하는 이유

`db.t4g.micro`는 2 vCPU와 1GiB memory를 제공하지만, 하나의 RDS에서 FastAPI, Airflow, Spark와 Trino Catalog 연결을 함께 받기에는 memory 여유가 작다. 로컬의 작은 데이터 크기만 보면 동작할 수 있으나 connection 증가와 migration, Airflow schema 작업이 겹치면 memory 압박과 burst credit 의존이 커진다.

초기 비용은 낮지만 MVP 시연 중 database가 병목이 되면 EKS·MSK·Spark 문제와 구분하기 어렵기 때문에 사용하지 않는다.

### `db.t4g.small`을 권장하는 이유

`db.t4g.small`은 2 vCPU와 2GiB memory다. 현재 데이터가 약 28MB이고 관찰 connection이 18개인 dev 환경에서는 초기 검증에 충분한 여유를 제공한다. Single-AZ on-demand 기준 서울 리전 조사 가격은 시간당 USD 0.051, 월 730시간 기준 약 USD 37.23이다.

FastAPI와 Airflow의 connection pool 상한을 명시하고 실제 connection·CPU credit·FreeableMemory를 관찰한다는 조건으로 선택한다.

### `db.t4g.medium`으로 올리는 조건

`db.t4g.medium`은 2 vCPU와 4GiB memory이며 월 730시간 기준 약 USD 74.46이다. 다음 중 하나가 반복되면 변경한다.

- FreeableMemory가 지속해서 512MiB 아래로 내려감
- database connection이 허용치의 70%를 반복해서 넘음
- CPU credit가 소진되거나 surplus CPU credit 비용이 지속 발생
- migration이나 Airflow scheduling 중 DB latency가 완료 기준을 위반
- 동시에 실행하는 Spark/Trino Catalog 작업이 증가

RDS instance class 변경은 storage migration보다 단순하므로, dev 첫 생성부터 두 배 비용을 고정하는 것보다 측정 후 medium으로 올리는 편이 적절하다.

서울 리전의 T4g surplus CPU credit는 조사 시점에 vCPU-hour당 USD 0.075다. 지속 부하가 발생하면 burstable class를 계속 키우는 대신 M 계열과 비교한다.

## Availability 분석

dev MVP는 Single-AZ를 권장한다.

- 기존 EC2가 rollback 경로로 유지된다.
- 7월 15일 목표는 운영 HA가 아니라 EKS 연결과 복구 검증이다.
- `db.t4g.small` Multi-AZ instance 비용은 월 약 USD 74.46으로 Single-AZ의 두 배다.
- application 수준의 Pod 복구와 database AZ 장애 복구는 별도 문제이므로 이번 검증에서 섞지 않는다.

staging 또는 운영 전환에서는 Multi-AZ를 다시 결정해야 한다. Single-AZ RDS 장애 중에는 EKS Pod가 살아 있어도 AskLake가 정상 동작하지 않는다는 제한을 완료 보고에 명시한다.

## Storage 분석

gp3 20GiB를 권장한다. AWS 문서상 PostgreSQL gp3는 20~399GiB 구간에서 기본 3,000 IOPS와 125MiB/s를 제공한다. 현재 약 28MB의 metadata에는 충분하며 별도 IOPS provisioning이 필요하지 않다.

서울 리전 조사 가격은 GB-month당 USD 0.131이므로 20GiB는 월 약 USD 2.62다. `db.t4g.small` Single-AZ와 합친 기본 추정은 월 약 USD 39.85다.

이 추정에는 다음이 포함되지 않는다.

- 부가세와 환율
- 무료 backup 허용량을 초과한 snapshot
- CloudWatch Logs
- AZ 또는 인터넷 data transfer
- T4g surplus CPU credit
- Secrets Manager와 KMS의 별도 사용량

현재 Terraform에는 storage autoscaling ceiling이 없다. 생성 전 `max_allocated_storage=100`에 해당하는 명시적 입력을 추가한다. 자동 증가는 허용하되 자동 축소는 되지 않으므로 CloudWatch alarm과 비용 검토를 함께 둔다.

참고: [Amazon RDS DB instance storage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html)

## Connection 분석

현재 EC2 관찰 connection은 application 13개, Airflow 5개다. EKS에서는 다음 경로가 추가된다.

- FastAPI replica 2개의 SQLAlchemy pool
- Airflow API Server
- Airflow Scheduler
- Airflow DAG Processor
- migration/bootstrap Job
- Spark Iceberg JDBC Catalog
- Trino Iceberg JDBC Catalog

FastAPI는 현재 SQLAlchemy 기본 QueuePool을 사용한다. 기본값을 그대로 두면 replica당 기본 pool 5개와 overflow 연결이 추가될 수 있다. Airflow도 여러 component가 metadata DB를 사용한다.

첫 배포에서는 다음을 요구한다.

- FastAPI pool size와 max overflow를 명시
- Airflow SQLAlchemy pool 상한을 명시
- bootstrap/migration Job은 완료 후 connection을 종료
- `DatabaseConnections` alarm 설정
- connection이 허용치의 70%를 반복하면 pool 조정 또는 RDS Proxy 분석

현재 규모에서는 RDS Proxy를 먼저 추가하지 않는다. Proxy 비용과 장애 지점을 추가하기 전에 두 replica와 Airflow의 실제 connection을 측정한다.

## Backup과 삭제 보호

다음 기준을 권장한다.

- automated backup retention 7일
- deletion protection 활성화
- `skip_final_snapshot=false`
- destroy 전에 명시적 final snapshot
- storage encryption 활성화
- RDS managed master password 사용
- application password는 별도 Secret으로 공급
- production 전환 전 restore rehearsal 수행

AWS CLI/API로 backup retention을 지정하지 않으면 기본이 1일일 수 있으므로 Terraform에서 7일을 명시한다. RDS automated backup은 retention 안에서 point-in-time restore에 사용할 수 있고, final snapshot은 instance 삭제 후의 장기 복구 기준으로 남긴다.

참고:

- [RDS backup retention period](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html)
- [RDS automated backups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)

## Migration 경계 분석

### 가장 중요한 위험

기존 AskLake database에는 일반 Job/Run/Catalog와 Kafka Continuous 상태 table이 함께 있다. 로드맵은 Continuous control plane과 worker를 EC2에 유지하도록 요구한다.

EC2 database를 RDS로 한 번 복사한 뒤 EC2 Continuous를 기존 database에서 다시 실행하면 두 database가 즉시 갈라진다. 반대로 EC2 Continuous까지 RDS에 연결하면 A의 RDS 작업이 Continuous runtime 동작을 바꾸게 된다. 어느 쪽도 단순한 dump/restore로 결정하면 안 된다.

따라서 7월 15일에는 운영 데이터의 완전 cutover를 완료 조건으로 두지 않고, 다음의 **격리된 EKS MVP RDS** 방식을 권장한다.

### 권장 migration 방식

1. RDS instance와 세 database/user를 bootstrap한다.
2. `asklake_app`에는 application schema migration을 실행하고 EKS MVP에 필요한 최소 fixture만 넣는다.
3. 기존 Kafka Continuous runtime/session/batch/maintenance 상태는 RDS로 운영 이전하지 않는다.
4. `airflow_metadata`는 Airflow 3.3.0 migration Job으로 새 schema를 만들고 MVP DAG 실행부터 기록한다.
5. `iceberg_catalog`는 전용 database로 bootstrap하고 EKS MVP가 생성하는 Iceberg table부터 기록한다.
6. 기존 EC2 PostgreSQL과 volume은 변경하거나 삭제하지 않는다.
7. EKS 실패 시 ALB/DNS를 기존 EC2 경로로 되돌리고 RDS는 증거 보존을 위해 유지한다.

이 방식은 기존 EC2 데이터를 EKS에서 그대로 보여 주는 운영 migration이 아니다. 대신 Continuous 제어권 충돌 없이 EKS bounded MVP를 검증한다. 기존 Job/Run/Catalog 전체 이관이 반드시 필요하다면 A 단독 작업을 멈추고 Continuous DB topology와 cutover window를 별도 공동 결정해야 한다.

### Rollback 기준

- 기존 EC2 Compose와 PostgreSQL volume을 그대로 유지한다.
- migration 중 dual-write를 사용하지 않는다.
- EKS external URL을 기존 EC2 URL로 되돌리는 절차를 기록한다.
- 실패한 RDS는 즉시 삭제하지 않고 final snapshot과 evidence를 남긴다.
- EKS MVP 중 새로 생긴 RDS 데이터는 EC2로 역동기화하지 않는다.
- 이 데이터 손실 경계는 dev MVP에만 허용하며 운영 전환에서는 허용하지 않는다.

## 생성 전 Terraform 보완

현재 Terraform은 private subnet, private security group, encryption, RDS managed master secret, backup retention, deletion protection과 final snapshot을 이미 구현한다.

apply 전에 다음을 보완한다.

- storage autoscaling ceiling 입력과 `max_allocated_storage`
- preferred backup window
- preferred maintenance window
- PostgreSQL/upgrade CloudWatch log export 여부
- final snapshot identifier 재사용 충돌 방지 방식
- instance class 변경 alarm 기준
- `DatabaseConnections`, `FreeableMemory`, `CPUUtilization`, `CPUCreditBalance`, `FreeStorageSpace` 관찰 runbook

Performance Insights/CloudWatch Database Insights 유료 선택은 dev 첫 생성의 blocker로 두지 않는다. 기본 CloudWatch metric으로 첫 smoke를 수행한 뒤 별도 관측 페이즈에서 결정한다.

## 승인할 Terraform 입력 권고안

```hcl
rds_mode                  = "create"
rds_engine_version        = "16.14"
rds_instance_class        = "db.t4g.small"
rds_allocated_storage_gib = 20
rds_backup_retention_days = 7
rds_multi_az              = false
```

추가 구현 후 다음 값도 명시한다.

```text
max allocated storage: 100 GiB
backup window: 서비스 저사용 KST 시간대
maintenance window: backup과 겹치지 않는 주간 KST 시간대
```

## Go/No-Go 기준

다음 조건을 모두 만족할 때만 RDS apply로 넘어간다.

- Terraform 보완 항목이 구현되고 정적 검증을 통과함
- plan이 RDS 관련 신규 resource만 생성하고 기존 EKS/MSK/VPC를 변경·교체·삭제하지 않음
- Single-AZ 제한과 예상 월 비용을 승인함
- private subnet과 EKS→RDS `5432` source가 확인됨
- RDS CA bundle과 `verify-full` bootstrap 경로가 준비됨
- 세 application password가 저장소 밖 Secret 전달 경로에 준비됨
- 기존 EC2 database와 volume을 보존함
- 격리된 EKS MVP RDS 방식을 승인하거나, 전체 migration이 필요하면 별도 cutover 결정을 완료함
- rollback 담당자와 실행 순서를 기록함

## 분석 완료 판정

RDS engine, 첫 instance class, AZ, storage, backup과 비용 권고안은 도출됐다. Terraform plan도 생성 4건, 변경·삭제 0건으로 확인했다.

RDS 생성 전 남은 핵심은 Terraform 운영 보완과 **기존 데이터를 옮기지 않는 격리 MVP 방식의 승인**이다. 이 두 항목을 해결하지 않고 apply하지 않는다.
