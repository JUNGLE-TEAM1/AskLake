# EKS MVP EC2 → RDS·S3 데이터 복사 리허설 기록

## 결과

2026-07-15 dev 환경에서 기존 EC2의 AskLake application PostgreSQL과 Airflow metadata PostgreSQL을 새 RDS의 세 논리 database로 분리 복원했다. 기존 배포 endpoint, EC2, PostgreSQL volume과 운영 S3 경로는 변경하거나 삭제하지 않았다. 복사 구간 종료 후 기존 배포의 writer를 다시 시작했고 Frontend, Backend, Caddy, Airflow API/Scheduler와 Trino health를 확인했다.

이번 결과는 **검증용 사본 생성 성공**이며 EKS workload cutover가 아니다. 기존 EC2가 다시 쓰기를 시작했으므로 실제 cutover 전에 마지막 delta 또는 두 번째 전체 복사가 필요하다.

## 복사 전 안전 조건

- 실행 중인 ETL Run 0건
- active Trino result collector lease 0건
- queued/running Airflow DAG Run 0건
- Kafka Continuous runtime 1개는 `stopped`
- source application/Airflow PostgreSQL과 target RDS 모두 PostgreSQL 16.14
- target `asklake_app`, `airflow_metadata`, `iceberg_catalog` 사용자 테이블 0개
- 빈 RDS 상태의 수동 pre-copy snapshot 생성 및 `available` 확인
- snapshot 실제 이름 대신 참조 SHA-256만 비공개 실행 기록에 보존

사용자 요청이 없다는 사실만으로 쓰기 부재를 가정하지 않았다. Caddy, Frontend, Backend, Airflow API/Scheduler/DAG Processor, Trino/collector와 Spark runtime을 중지하고 두 PostgreSQL은 dump를 위해 유지했다. 방치 시 기존 서비스를 자동 재개하는 20분 timer를 함께 만들었고 정상 복원 뒤 timer를 제거했다.

## 분리 복원 결과

source application database는 사용자 테이블 28개였다. 이 중 AskLake application 테이블 26개는 RDS `asklake_app`에, `iceberg_namespace_properties`와 `iceberg_tables` 두 테이블은 RDS `iceberg_catalog`에 복원했다. source Airflow 사용자 테이블 71개는 RDS `airflow_metadata`에 복원했다.

source owner, login role, password와 ACL은 복사하지 않았다. RDS bootstrap에서 만든 `asklake_app`, `airflow_app`, `iceberg_catalog` 최소 권한 role을 그대로 사용했고 restore는 `--no-owner --no-acl --exit-on-error`로 실행했다.

dump artifact는 다음 SHA-256으로 검증했다.

- AskLake application: `c456efd3c539143de2f6db01db2f542ac01cd9767153ba32497930a22c645b64`
- Airflow metadata: `af2720a9fc88aef21131cae8e728e5b7ecd688360e3c68929c248febeaf71aa0`
- Iceberg JDBC Catalog: `ec1998d426b4954f471cd7cac3017e33ab47784529241be11d9cc8f80b5e98ac`

## 데이터 검증

- source 기준점과 RDS의 모든 사용자 테이블별 row count 비교 통과
- AskLake 26개, Airflow 71개, Iceberg Catalog 2개 테이블 확인
- Airflow dump `SEQUENCE SET` 30개와 target sequence 30개 일치
- AskLake foreign key 11개, Airflow foreign key 72개 확인
- 세 database 모두 unvalidated constraint 0개
- restore 중 무시한 오류 없음
- EKS 내부에서 RDS `verify-full` TLS 연결 사용

application과 Iceberg Catalog에는 sequence가 없었다. ID는 기존 문자열/UUID 계약을 그대로 보존했다.

## S3 처리와 검증

기존 배포는 AWS 기본 S3 endpoint와 Raw/Output/Warehouse/Query Result 네 bucket 역할을 사용하고 있었다. RDS에 복원한 URI도 같은 관리 S3 경로를 계속 가리키므로 Dataset object를 다른 bucket으로 중복 복사하지 않았다.

EKS Spark Pod Identity로 다음 368개 참조를 검증했다.

- Iceberg current/previous metadata의 정확한 object 22개
- `dataset_revision_commits`의 manifest prefix별 `_SUCCESS` 346개

초기 exact-object 검사에서 `manifest_location`을 파일로 해석하면 346개가 누락처럼 보이지만, 코드 계약상 해당 값은 `_batch-manifests/batch_id=...` directory다. 따라서 directory 자체를 `HeadObject`하지 않고 각 prefix의 `_SUCCESS`를 검증했다. 최종 결과는 존재 368개, 누락 0개, list 실패 0개다.

## 민감 artifact 정리

dump 전달에는 기존 private/versioned output bucket의 격리 prefix와 SSE-S3를 사용했다. restore와 검증 직후 다음을 정리했다.

- 임시 S3 object version 7개 영구 삭제 및 잔여 version/delete marker 0개 확인
- EC2 임시 dump·count·checksum 파일 삭제
- EKS 임시 ExternalSecret, Kubernetes Secret, ConfigMap, restore/validation Job과 Pod 삭제
- 임시 RDS CA ConfigMap 삭제

RDS의 pre-copy snapshot은 rollback 증거로 유지한다. 실제 snapshot 이름, endpoint, bucket, account/instance ID와 credential은 Git에 기록하지 않는다.

## 기존 배포 환경 상태

복사 뒤 기존 배포의 Caddy, Frontend, Backend, Airflow API Server/Scheduler와 Trino는 모두 `running/healthy`다. 기존 PostgreSQL, S3, EC2 volume, MongoDB와 Redpanda는 삭제하거나 RDS/EKS로 전환하지 않았다. Terraform 최종 plan도 `No changes`였다.

## 남은 경계

- EKS FastAPI/Airflow/Trino/Spark의 최종 RDS Secret·endpoint 연결
- B의 workload가 준비된 뒤 기존 Dataset 하나를 EKS Spark 또는 Trino로 실제 조회
- 실제 cutover 직전 delta 또는 두 번째 전체 복사 방식 선택
- cutover maintenance window에서 writer 재중지와 최종 기준점 생성
- MongoDB Source·Connection 데이터의 별도 이전/외부 유지 결정
- EKS 검증과 안정화가 끝날 때까지 기존 EC2 rollback 원본 유지

따라서 RDS·S3 **구조 복사 리허설은 성공**했지만, EKS application-level physical read와 사용자 traffic cutover는 완료되지 않았다.
