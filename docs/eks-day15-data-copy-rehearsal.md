# EKS MVP EC2 → RDS·S3 데이터 복사 리허설

## 이 페이즈를 지금 끼우는 이유

현재 기존 배포 사이트를 팀원이 사용하지 않는 시간대라면 사용자 요청으로 생기는 변경이 적어 데이터 복사 리허설을 하기 좋은 시점이다. 다만 “사용자가 접속하지 않는다”와 “데이터 쓰기가 없다”는 같은 뜻이 아니다. FastAPI background 작업, Airflow scheduler, Trino result collector, Kafka Continuous sync와 실행 중인 Job은 사용자가 없어도 PostgreSQL이나 object storage를 변경할 수 있다.

따라서 이 페이즈는 7월 15일 private network 검증 뒤, EKS Frontend/FastAPI가 새 RDS를 사용하기 전에 수행한다. 목적은 기존 데이터를 새 환경에 **복사하고 검증하는 것**이며, 기존 EC2 삭제나 운영 연결 전환은 포함하지 않는다.

```text
기존 EC2 쓰기 상태 확인
→ 짧은 복사 기준 시점 확정
→ PostgreSQL dump
→ 필요한 object만 S3에 복사 또는 기존 S3 참조 유지
→ RDS restore
→ DB와 object의 연결 검증
→ 기존 EC2 쓰기 재개
→ EKS 연결 전까지 RDS는 검증 사본으로 유지
```

## 시작 상태

- dev RDS PostgreSQL 16.14와 `asklake_app`, `airflow_metadata`, `iceberg_catalog` 전용 database/login role이 준비돼 있다.
- EKS Pod에서 RDS private DNS, TLS와 `5432/tcp` 연결이 검증됐다.
- 기존 EC2에는 AskLake application PostgreSQL과 Airflow metadata PostgreSQL이 별도 container로 실행된다.
- 기존 application database의 `public` schema에는 AskLake 테이블과 Iceberg JDBC Catalog 테이블이 함께 있다.
- 새 RDS에서는 AskLake, Airflow, Iceberg JDBC Catalog를 서로 다른 database와 role로 분리해야 한다.
- Production Compose는 AWS S3를 사용한다. Terraform으로 인수한 기존 S3 bucket은 삭제 보호 아래 유지되므로, 실제 Catalog 경로가 그 bucket을 가리키면 object를 같은 위치에서 다시 복사하지 않는다.
- 기존 EC2와 volume은 rollback 원본으로 보존한다.

## 실행 전에 확인할 것

다음 항목은 실제 복사를 시작하기 전에 관측하고 기록해야 한다. 값 자체나 credential은 Git에 남기지 않는다.

- 실행 중인 ETL Run, Airflow DAG와 Trino Query Run이 없는가
- Kafka Continuous worker와 control-plane sync가 PostgreSQL 또는 S3를 계속 변경하는가
- FastAPI background task, scheduler와 result collector가 쓰기를 수행하는가
- application PostgreSQL, Airflow PostgreSQL의 정확한 source database와 schema가 무엇인가
- Iceberg JDBC Catalog 테이블이 `iceberg_namespace_properties`, `iceberg_tables` 두 개뿐인지
- Catalog와 Run row가 참조하는 bucket, prefix, endpoint와 URI scheme은 무엇인가
- 참조 object가 Terraform으로 인수한 기존 S3에 이미 있는지, EC2 local volume이나 다른 MinIO에 있는지
- MongoDB의 Source·Connection 데이터가 EKS MVP에서 필요한지. MongoDB는 RDS 복사 대상이 아니므로 별도 이전 여부를 결정해야 한다.

하나라도 확인되지 않으면 실제 restore나 경로 변경을 시작하지 않는다.

## 복사 기준 시점 만들기

가장 안전한 방식은 짧은 쓰기 중지 구간을 만드는 것이다. 팀원이 사이트를 사용하지 않는 동안에도 자동 writer가 남아 있을 수 있으므로, 다음 순서로 처리한다.

1. 새 Job 실행과 관리 API 쓰기를 막는다.
2. 실행 중인 bounded Job, DAG와 Query Run이 끝났는지 확인한다.
3. Kafka Continuous는 checkpoint와 마지막 publication이 안정된 상태에서 일시정지할지, 이번 사본에서 제외할지 결정한다. 임의로 worker를 kill하지 않는다.
4. Airflow scheduler, FastAPI background writer와 Trino collector의 쓰기 중지 여부를 확인한다.
5. source database별 마지막 변경 시각과 source S3 object 기준 시점을 기록한다.
6. dump가 끝날 때까지 쓰기 중지를 유지한다.

전체 EC2를 먼저 내리면 dump 도구와 내부 DB 접근 경로도 잃을 수 있다. PostgreSQL과 필요한 관리 경로는 유지하고, 쓰기 주체만 통제한다.

## PostgreSQL 복사 방식

source와 target이 모두 PostgreSQL 16.14이므로 custom-format `pg_dump`와 `pg_restore`를 사용한다. 실제 host, database, user와 password는 SSM/Secrets Manager 또는 실행 시 환경에서만 전달하고 출력하지 않는다. target role은 이미 최소 권한으로 생성돼 있으므로 source role과 ACL은 복사하지 않는다.

복원 단위는 다음과 같다.

- AskLake application table은 source application database에서 dump해 RDS `asklake_app`에 복원한다.
- Airflow metadata는 source Airflow database에서 dump해 RDS `airflow_metadata`에 복원한다.
- Iceberg JDBC Catalog의 `iceberg_namespace_properties`, `iceberg_tables`는 source application database에서 별도 dump해 RDS `iceberg_catalog`에 복원한다.
- source database owner, login role, password, ACL과 장기 credential은 복사하지 않는다.
- RDS에서 지원되지 않는 extension이나 superuser 설정은 restore 전에 inventory하고 제외한다.

application dump에서 Iceberg 두 테이블을 제외하고, Iceberg dump에는 두 테이블만 포함해야 한다. 같은 source database 전체를 두 target database에 중복 restore하지 않는다. restore는 `--no-owner --no-acl` 경계를 사용하고, target database마다 해당 전용 application role이 object를 소유하도록 확인한다.

기존 RDS에 bootstrap 외 데이터가 생겼다면 덮어쓰지 않는다. 먼저 target row와 schema version을 확인하고, 비어 있지 않으면 target snapshot 또는 별도 임시 database를 만든 뒤 restore 방식을 다시 승인한다.

## Object storage 처리 방식

PostgreSQL row만 복사하면 화면에는 Dataset이 보이지만 실제 Parquet/Iceberg 파일을 읽지 못할 수 있다. 반대로 현재 배포가 이미 Terraform으로 인수한 AWS S3 bucket을 사용하고 URI가 그대로 유효하다면, 대규모 object 재복사는 불필요하고 오히려 중복과 경로 불일치를 만든다.

object는 다음 기준으로 분류한다.

- 기존 S3의 같은 bucket/key를 EKS에서도 계속 사용한다면 **복사하지 않고** versioning, 권한, object 존재와 checksum만 검증한다.
- EC2 local volume이나 MinIO object를 참조한다면 승인된 EKS S3 bucket/prefix로 복사한다.
- bucket 또는 prefix를 변경해야 한다면 DB row와 Iceberg metadata 내부 경로를 함께 조사한다. DB 문자열만 일괄 치환하지 않는다.
- Raw, ETL output, warehouse, checkpoint, quarantine, evidence, query result 중 실제로 보존할 prefix를 분류한다.
- cache, lock, 실행 중 임시 파일, 만료 session과 재생성 가능한 transient result는 복사 대상에서 제외한다.

특히 Iceberg metadata와 manifest 내부에 이전 endpoint나 경로가 저장돼 있으면 object copy만으로 해결되지 않는다. 이 경우 기존 S3 경로 유지가 가능한지 우선 검토하고, 불가능하면 Iceberg table 단위의 안전한 relocation 절차를 별도 페이즈로 분리한다.

## 검증 기준

복사가 끝나면 다음 증거를 민감값 없이 남긴다.

- source와 target의 schema/table 목록 비교
- 주요 application table과 Airflow table의 row count 비교
- primary key, foreign key와 sequence 최댓값 비교
- Iceberg namespace/table row 비교
- Catalog Dataset과 최신 materialization의 storage URI 표본 확인
- 참조된 object의 존재, size, version 또는 checksum 확인
- EKS test client에서 각 RDS role의 자기 database TLS 로그인 성공
- 다른 application database 접근 거부 유지
- EKS Spark와 Trino가 복사된 기존 Dataset 하나 이상을 실제로 읽을 수 있는지 확인
- 기존 Job/Run/Catalog가 API와 화면에서 같은 ID로 보이는지 확인
- restore log에 무시한 오류가 없는지 확인

단순 row count 일치만으로 완료하지 않는다. DB row가 가리키는 실제 object를 Spark 또는 Trino가 읽어야 데이터 복사 리허설이 통과한다.

## 종료 상태와 rollback

이 페이즈가 끝나도 운영 연결은 기존 EC2를 유지한다. EKS FastAPI, Airflow와 Trino의 Secret을 RDS로 바꾸는 것은 B workload 배포와 함께 수행하는 별도 cutover다. 복사 뒤 기존 EC2에 쓰기가 재개되면 RDS 사본은 곧 뒤처지므로, 실제 cutover 전에 마지막 delta 재복사 또는 두 번째 짧은 전체 복사 방식을 정해야 한다.

rollback 원본인 기존 EC2 PostgreSQL, S3/volume과 Compose는 삭제하지 않는다. RDS 사본 검증이 실패하면 EKS workload에 RDS endpoint를 주입하지 않고, 실패 원인과 target 정리 여부를 기록한다. dual-write와 자동 역동기화는 이 리허설 범위에 포함하지 않는다.

## 완료 조건

- 자동 writer를 포함한 source 쓰기 상태를 확인하고 dump 기준 시점을 기록했다.
- AskLake, Airflow와 Iceberg JDBC Catalog가 각각 올바른 RDS database로 복원됐다.
- 기존 S3 유지와 실제 object 복사 범위가 근거와 함께 구분됐다.
- DB row와 object 연결을 Spark 또는 Trino로 실제 검증했다.
- 기존 EC2가 변경 없이 rollback 원본으로 남아 있다.
- migration receipt에 실행 시각, dump 식별용 checksum, row/object 비교와 실패 항목이 기록됐다.
- 실제 EKS cutover가 이 복사 리허설과 별도 단계라는 점이 유지됐다.

