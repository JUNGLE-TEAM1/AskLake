# EKS 16일차 Pair A Phase 1 runtime Secret 입력 준비

## 결과

Issue #812 Phase 1에서 Spark와 Trino가 사용할 실제 dev runtime 입력을 로컬 Git 제외 파일로 준비하고 검증했다. AWS Secrets Manager source, ExternalSecret, Kubernetes Secret과 실행 중 workload는 이 단계에서 변경하지 않았다.

비공개 입력은 `infra/eks/secrets/dev.runtime-secret-input.json`에 있으며 `.gitignore`의 `*.runtime-secret-input.json` 규칙으로 제외되고 권한은 `0600`이다. 문서와 명령 출력에는 RDS endpoint, password, 인증서 원문, JKS, password hash, Secret value를 남기지 않는다.

## 기존 계약과 실환경 대조

Airflow는 이미 healthy하게 실행되고 source/target 전체 hash도 일치한다. 정적 계약보다 추가된 `AIRFLOW_PASSWORD`는 Phase 0의 알려진 drift로 유지하며 Phase 1에서 읽기·수정·삭제하지 않았다.

Spark와 Trino의 Iceberg JDBC 논리값은 다음 한 묶음이다.

```text
RDS database/user: iceberg_catalog / iceberg_catalog
Spark Secret:      asklake-spark-runtime의 JDBC URL/user/password 3개
Trino Secret:      asklake-trino-runtime의 같은 JDBC URL/user/password
```

`iceberg_catalog` 비밀번호는 RDS bootstrap 때 이미 생성해 보존한 `asklake/dev/rds/application-databases` source에서 재사용한다. 새 DB 비밀번호를 만들거나 PostgreSQL role을 회전하지 않았다. available dev RDS가 정확히 하나인지 확인한 뒤 credential을 포함하지 않는 JDBC URL을 구성했다.

Trino는 HTTPS와 file password 인증을 사용한다. 입력 준비기는 다음 자료를 새로 생성했다.

- `asklake-api`, `asklake-materializer`의 서로 다른 장문 password
- 두 identity만 포함하고 bcrypt cost 12를 사용하는 password database
- `asklake-trino` Service와 namespace FQDN을 SAN에 포함한 3072-bit RSA 인증서와 JKS
- JKS password와 Trino internal shared secret
- Backend result cursor와 destructive query confirmation용 서로 다른 signing secret

Backend가 Trino에 HTTPS/password로 연결하려면 query/materializer identity, signing secret과 같은 인증서의 CA가 필요하다. 그래서 private 입력은 Spark·Trino source뿐 아니라 기존 Backend source에 안전하게 병합할 `backendPatch`도 함께 가진다. 이는 Phase 1에서 Backend source를 이미 변경했다는 뜻이 아니다. Phase 2에서 기존 Backend key를 보존하는 merge와 staged hash 검증을 통과한 뒤에만 반영한다.

## 비공개 입력 구조

입력은 다음 세 source 단위로 나뉜다. 실제 값은 Git에 저장하지 않는다.

```text
sources.backendPatch
  Trino query/materializer identity와 password
  cursor/confirmation signing secret
  trino-ca.pem

sources.spark
  ASKLAKE_SPARK_ICEBERG_JDBC_URL
  ASKLAKE_SPARK_ICEBERG_JDBC_USER
  ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD

sources.trino
  TRINO_ICEBERG_JDBC_URL
  TRINO_ICEBERG_JDBC_USER
  TRINO_ICEBERG_JDBC_PASSWORD
  TRINO_TLS_KEYSTORE_PASSWORD
  TRINO_INTERNAL_SHARED_SECRET
  base64 JKS와 password database
```

JKS와 password database는 AWS JSON source에 안전하게 담기 위해 base64로 보관한다. Phase 2의 ExternalSecret은 이 두 property에만 Base64 decoding을 적용해야 한다. 일반 문자열 key에 decoding을 적용하거나 base64 문자열을 그대로 volume mount하면 안 된다.

## 검증

`scripts/verify-eks-day16-runtime-secret-input.mjs`는 value를 출력하지 않고 다음을 fail-closed로 확인한다.

- private file이 group/other에 공개되지 않고 정확한 source/key 집합만 가짐
- placeholder와 static AWS/MinIO credential key가 없음
- Spark와 Trino의 JDBC URL/user/password가 동일하고 isolated database를 가리킴
- query/materializer identity가 ACL과 일치하고 password/signing secret 최소 길이와 분리를 만족함
- password database가 정확히 두 bcrypt identity만 가지며 cost가 8 이상임
- JKS alias/password가 유효하고 Backend CA와 JKS certificate fingerprint가 같음
- certificate SAN이 short Service와 cluster-local FQDN을 포함함

로컬 macOS에 Java runtime이 없으면 준비기와 검증기는 digest로 고정한 Eclipse Temurin 21 Docker image의 keytool을 사용한다. JDK 도구 선택만 달라지고 생성 형식과 검증 기준은 같다.

```bash
bash scripts/prepare-eks-day16-runtime-secret-input.sh
node scripts/verify-eks-day16-runtime-secret-input.mjs \
  infra/eks/secrets/dev.runtime-secret-input.json
```

준비기는 유효한 기존 입력이 있으면 회전하지 않고 재검증만 한다. 새 Trino 인증 자료 회전은 source 반영, Backend/Trino rollout과 rollback을 함께 계획하는 별도 작업으로 수행해야 한다.

## Phase 1 완료 경계

Phase 1은 완료됐다. 실제 dev credential과 TLS/auth 파일은 Phase 2가 소비할 수 있는 상태다. 하지만 다음은 아직 완료가 아니다.

- Backend source 확장
- Spark·Trino Secrets Manager source 생성
- Spark·Trino ExternalSecret/target 동기화
- Trino Pod의 RDS/S3/HTTPS smoke
- SparkApplication 실제 실행
- Kafka fixture 생산과 MSK → Spark → Iceberg → Trino E2E

Phase 2는 기존 Backend/Airflow runtime을 먼저 보존하고, staged source-target hash와 rollback 입력을 확보한 뒤 Spark·Trino source와 ExternalSecret을 적용해야 한다.
