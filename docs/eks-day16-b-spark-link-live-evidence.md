# EKS MVP 목요일 Pair B FastAPI-Spark 연결 실환경 검증 기록

## 범위와 판정

이 문서는 `eks-roadmap.md`의 7월 16일 Pair B 범위 중 Backend와 Spark Operator/SparkApplication 연결만 기록한다. 실제 계정 ID, ECR digest, Pod/Node ID, SparkApplication UID와 환경별 endpoint는 저장소 밖 evidence에 둔다.

판정은 FastAPI-Spark 연결과 Issue #828의 S3/Iceberg 경로 완료다. 최초 연결 검증에서는 FastAPI의 실제 내부 실행 요청이 SparkApplication 하나를 만들고 기존 Spark Operator가 driver와 executor Pod를 생성했지만 AWS SDK classpath 충돌로 Iceberg commit이 실패했다. 아래 dependency alignment를 배포한 뒤 production S3 fixture Run은 같은 경로에서 Iceberg commit, Trino 물리 검증, Catalog materialization과 Airflow DAG Run 성공까지 완료했다. MSK bounded consume은 이 문서의 완료 범위가 아니다.

## 배포 전 gate

- `asklake-spark-runtime` target Secret의 JDBC URL/user/password 세 key가 ExternalSecret에서 동기화된 것을 값 노출 없이 확인했다.
- Pair B 소유 `asklake-runtime` ConfigMap에 Kubernetes provider image, namespace, ServiceAccount, runtime Secret/key, timeout, resource, S3/Iceberg warehouse 설정을 비밀 없이 반영했다.
- 기존 RDS Job 네 개는 모두 수동 실행이고 active Run은 0개임을 먼저 확인했다.
- 새 Backend image는 AMD64 단일 manifest digest로 배포했고 두 FastAPI replica의 Ready, restart 0, Frontend에서 `fastapi:8080/api/health`와 RDS health를 확인했다.

## 첫 실패와 수정

첫 실제 요청은 SparkApplication을 만들었지만 driver Pod 생성 전 Spark submitter가 Ivy cache를 `/nonexistent` 아래에 쓰려다 실패했다. 동적 provider와 정적 SparkApplication 계약에 `spark.jars.ivy=/tmp/.ivy2`를 추가해 재배포했다.

같은 경로에서 driver Pod가 없을 때 log API의 `404`가 원래 submission error를 덮는 문제도 발견했다. terminal failure에서는 missing driver log를 허용하고 SparkApplication status error를 Run 실패 원인으로 보존하도록 수정했다. 이 회귀는 Node unit test에 추가했다.

## 실제 연결 결과

- Airflow Pod의 기존 내부 인증 경로로 FastAPI Spark execution API를 호출했다.
- Backend ServiceAccount가 SparkApplication create/get/list/watch/delete와 Pod log 조회를 수행했다.
- SparkApplication spec의 driver와 executor 모두 `asklake.io/workload-class=spark`, `kubernetes.io/arch=amd64`, 전용 `NoSchedule` toleration을 사용했다.
- 실제 driver와 executor Pod가 각각 Spark 전용 AMD64 node에 배치됐다.
- 실행 중 다른 Airflow Pod가 같은 `runId`를 요청했을 때 `409 SPARK_RUN_ALREADY_EXECUTING`으로 차단됐다.
- terminal 뒤 같은 `runId`를 다시 요청했을 때 `recovered=true`와 동일 application UID가 반환됐고 label 기준 SparkApplication 수는 1개였다.

## 후속 실패 경계

격리된 2MB S3 CSV 한 개와 전용 output/warehouse/table identity를 사용했다. Spark는 파일 한 개와 10,000행을 읽었고 driver/executor 실행까지 성공했지만, Iceberg create/commit 단계에서 Hadoop S3A와 MSK IAM package가 가져온 AWS SDK jar 사이의 `NoSuchMethodError`로 실패했다.

따라서 이 결과로 주장할 수 있는 것은 FastAPI → SparkApplication → driver/executor 연결과 중복 방지뿐이다. MSK bounded consume, Iceberg commit, Trino physical verification, Catalog materialization과 전체 Job success는 후속 항목에서 AWS SDK dependency alignment를 고친 뒤 다시 검증해야 한다.

## Issue #828 dependency alignment

driver Ivy resolution과 공식 POM을 대조한 결과 `hadoop-aws:3.4.1`은 AWS SDK v2 bundle `2.24.6`, `aws-msk-iam-auth:2.3.6`은 개별 AWS SDK v2 module `2.38.3`을 가져왔다. bundle의 `SdkDefaultClientBuilder`와 개별 module의 `AwsDefaultClientBuilder`가 한 classpath에 섞인 것이 `NoSuchMethodError`와 `IllegalAccessError`의 원인이었다.

수정은 Hadoop이 컴파일된 SDK bundle을 교체하지 않는다. MSK IAM과 그 AWS SDK/Netty를 Spark image 안의 별도 namespace로 shading하고 Kafka source에만 image-local JAR를 추가한다. S3-only source에는 MSK JAR를 추가하지 않는다. 로컬 AMD64 Spark image build에서 MSK callback, relocated AWS SDK/Netty 존재와 공개 AWS SDK/Netty 부재를 검사했다. Kafka source manifest/unit test는 shaded callback JAR와 IAM auth 설정이 유지되는지 확인하고, S3 source test는 MSK Maven package와 JAR가 모두 빠지는지 확인한다.

## Issue #828 live 완료 증거

- 검토한 immutable Backend/Spark image digest를 dev에 배포했고 Run `run_cccd77cef912`의 driver image ID가 배포한 Spark digest와 일치했다. 실제 digest와 Pod UID는 저장소 밖 배포 evidence에 둔다.
- S3 source Ivy resolution에는 `hadoop-aws:3.4.1`, AWS SDK bundle `2.24.6`, Iceberg와 PostgreSQL만 있었고 MSK IAM package는 없었다.
- 해당 SparkApplication driver가 exit code 0으로 `Succeeded`했다. Spark 결과는 input/output 3,112,448행, data file 8개, snapshot `3643594365567232461`과 같은 `runId`를 기록했다.
- Trino coordinator를 EKS에 단일 replica로 배포하고 FastAPI에서 CA 검증과 Basic 인증을 사용한 `SELECT 1`을 통과했다. `iceberg.asklake.click_events_1gb_hg_3065f2af5f92531f`의 물리 행 수는 3,112,448, 현재 data file은 8개다.
- Trino `$snapshots` history에서 `3643594365567232461`가 2026-07-16 10:58:09 UTC의 3,112,448행 overwrite로 확인됐다. 4분 뒤 정기 Run `run_daef0546a20f`가 같은 table에 새 snapshot `4171358761748327678`을 commit했으므로 원래 snapshot은 history evidence로 대조하고 최신 snapshot이라고 주장하지 않는다. 이 정기 Run도 기존 Spark task를 다시 실행하지 않고 Catalog/publish만 복구해 snapshot `4171358761748327678`, 3,112,448행으로 최종 성공했다.
- 실패했던 `publish_run_result`만 Airflow v2 clear API의 dry-run으로 선택한 뒤 재실행했다. 기존 Spark task를 다시 실행하지 않았고, Catalog reconciliation은 같은 `runId`, dataset `ds_click_events_1gb_hg_1b0a6e6f2044`, snapshot `3643594365567232461`, 3,112,448행으로 멱등 확정됐다. 최종 Airflow 네 task, DAG Run과 AskLake Run 상태는 모두 `success`다.
- `/jobs`를 새로고침해 최신 정기 Run이 5/5 성공, input/output 3,112,448행, `Spark 실행 결과 확정 success`로 표시되는 것을 확인했다.
- live ExternalSecret에 Trino key mapping을 적용할 cluster-wide 권한은 사용하지 않았다. AWS Secrets Manager 원본에서 필요한 Trino 인증 여섯 key와 CA만 복사한 임시 `asklake-backend-trino-runtime` Secret을 FastAPI가 추가 참조한다. 저장소의 정식 ExternalSecret mapping을 권한 있는 배포 주체가 적용하면 이 임시 Secret을 제거하고 기본 단일 `asklake-backend-runtime` 참조로 되돌린다.

## 정리와 회귀 검증

- 임시 SparkApplication과 driver/executor Pod를 삭제했다.
- 임시 RDS Run을 먼저 삭제·commit한 뒤 Job을 삭제했고 두 row의 부재를 확인했다.
- 전용 output/warehouse prefix에 남은 object가 없음을 확인했다.
- `npm run test:spark-kubernetes`: 10/10 통과
- `ASKLAKE_HELM_BIN=<reviewed-helm> bash scripts/verify-eks-workloads.sh`: 통과
- `PATH=<reviewed-helm>:$PATH bash scripts/verify-eks-web-workloads.sh`: 통과
