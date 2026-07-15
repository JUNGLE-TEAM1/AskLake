# EKS MVP 7월 15일 RDS 적용 기록

## 적용 범위

2026-07-15 서울 리전 dev 환경에 격리된 EKS MVP PostgreSQL RDS를 생성했다. 기존 EC2 PostgreSQL, Kafka Continuous 상태와 volume은 변경하거나 삭제하지 않았다. dump/restore, dual-write와 production cutover도 수행하지 않았다.

## 적용 결과

- PostgreSQL 16.14, `db.t4g.small`, Single-AZ
- encrypted gp3 20GiB, autoscaling ceiling 100GiB
- public access 비활성화
- EKS cluster security group에서 RDS private security group의 `5432/tcp`만 허용
- automated backup 7일, KST 03:00 backup window
- 월요일 KST 04:00 maintenance window
- PostgreSQL/upgrade CloudWatch log export
- deletion protection 활성화, final snapshot 필수
- RDS managed master password 사용

Terraform apply는 RDS instance, DB subnet group, private security group과 EKS ingress rule 4개를 추가했다. ESO IAM policy는 생성된 RDS master secret의 정확한 ARN을 읽도록 in-place 변경했다. 기존 resource 삭제·교체는 없었고 후속 plan은 `No changes`였다.

## 논리 database와 role

다음 세 database와 전용 login role을 생성했다.

- `asklake_app` / `asklake_app`
- `airflow_metadata` / `airflow_app`
- `iceberg_catalog` / `iceberg_catalog`

application password는 Secrets Manager의 승인된 dev prefix에 보관한다. 실제 값은 Terraform state, Git, command output과 검증 로그에 남기지 않았다. bootstrap용 Kubernetes Secret과 Job/ConfigMap은 검증 후 삭제했다.

## 검증 증거

- RDS status `available`
- public access false, encryption/deletion protection true
- EKS 내부 Job에서 RDS CA bundle과 `verify-full` TLS 사용
- 실제 RDS에서 bootstrap 반복 실행 성공
- 세 role 모두 자신의 database 실제 로그인 성공
- 각 role의 다른 application database 로그인 거부
- 세 role의 superuser, createdb, createrole, replication, bypass-RLS 권한 없음
- Secrets Manager application password source 1개만 유지
- bootstrap용 Kubernetes ExternalSecret, Secret, Job과 ConfigMap 정리

로컬 Docker 검증에서 발견되지 않았던 RDS `rds_superuser` 제약도 실제 적용 중 확인했다. RDS master는 다른 role의 SUPERUSER/REPLICATION 속성을 재설정할 수 없으므로 최초 `CREATE ROLE`에서 최소 권한을 고정하고 이후 멱등 실행은 password만 회전한다. bootstrap 자체가 최종 role flags와 접근 격리를 다시 검사한다.

## 남은 작업

- FastAPI application schema migration
- Airflow metadata migration
- Iceberg JDBC Catalog table 초기화
- 실제 workload별 ExternalSecret key mapping
- Frontend/FastAPI/Airflow/Spark/Trino에서 connection pool과 연결 검증
- CloudWatch `DatabaseConnections`, `FreeableMemory`, `CPUUtilization`, `CPUCreditBalance`, `FreeStorageSpace` 기준선 수집과 alarm 선택

이 항목이 끝나기 전에는 AskLake 전체의 RDS 전환 완료로 선언하지 않는다.

## Rollback 경계

기존 EC2 Compose, PostgreSQL과 volume을 원본 rollback 경로로 유지한다. EKS MVP 중 새로 생기는 RDS 데이터는 EC2로 역동기화하지 않는다. RDS 삭제가 필요하면 먼저 workload와 secret mapping을 제거하고, deletion protection 해제와 고유 final snapshot 이름을 별도 승인한 뒤 실행한다.
