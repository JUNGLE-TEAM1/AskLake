# EKS Day 17 Spark Runtime Dependency Gate

Day 17 multi-Spark 실행은 같은 immutable Spark image를 사용하더라도 driver 시작 시
Maven package를 내려받으면 Node별 네트워크·캐시 상태에 따라 결과가 달라질 수 있다.
실제 3-run campaign에서 한 Run은 성공하고 두 Run은 입력 처리 전에 Maven dependency
resolution으로 실패했으므로, 재실행 전 runtime dependency를 image에 고정한다.

## Runtime contract

- `backend/Dockerfile`의 `spark-runtime-dependencies` stage가 다음 root dependency와
  runtime transitive JAR을 `/opt/spark/jars`에 포함한다.
  - Spark SQL Kafka `4.0.1`
  - Hadoop AWS `3.4.1`
  - Iceberg Spark Runtime `1.11.0`
  - PostgreSQL JDBC `42.7.7`
- 기존 AskLake MSK IAM shaded JAR은 그대로 유지한다.
- EKS runtime ConfigMap은 아래 값을 `none`으로 설정해 SparkApplication의
  `deps.packages`를 비우고 Maven/Ivy 원격 resolution을 실행하지 않는다.
  - `ASKLAKE_SPARK_KAFKA_PACKAGE`
  - `ASKLAKE_SPARK_HADOOP_AWS_PACKAGE`
  - `ASKLAKE_SPARK_ICEBERG_PACKAGE`
  - `ASKLAKE_SPARK_POSTGRES_PACKAGE`
- Spark image는 ECR immutable digest로만 배포한다.
- IAM, NodePool, RBAC와 runtime Secret은 이 변경 범위가 아니다.

## Gates before retry

1. Spark runtime AMD64 image build가 root JAR과 Kafka/AWS transitive JAR 검사를 통과한다.
2. image receipt의 Spark digest와 private runtime candidate의 image가 정확히 일치한다.
3. rendered ConfigMap 변경은 fixture slot, Spark image, 네 package-disable key로 제한한다.
4. FastAPI restart 뒤 새 SparkApplication의 `deps.packages`가 비어 있음을 확인한다.
5. active fixture Run이 0이고 기존 partial receipt가 보존된 상태에서 새 receipt를 사용한다.

현재 live ConfigMap을 private base로 다시 캡처한 뒤 candidate는 다음 두 script로 만든다.
두 파일은 Git에서 제외하고 mode `0600`을 유지하며 값 자체는 터미널에 출력하지 않는다.

```bash
ASKLAKE_RUNTIME_CONFIG_VALUES=infra/eks/values/workloads/dev.runtime-config-values.json \
  ./scripts/prepare-eks-runtime-config-values.sh

ASKLAKE_IMAGE_RECEIPT=infra/eks/delivery/dev-day17-multi-spark.image-receipt.json \
  ./scripts/prepare-eks-day17-baked-spark-runtime-values.sh
```
