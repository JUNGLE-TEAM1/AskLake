# 7월 15일 A foundation / B workload 계약 대조

## 목적과 기준

이 문서는 A 인프라 PR #788(`feat-#735-day15`, `2dd44f8`)과 B workload PR #774(`feature/eks-tuesday-b-runtime`, `89fd61f`)의 계약을 대조한다. 실제 image digest 주입, runtime Secret 생성, workload rollout 또는 전체 E2E 완료를 주장하지 않는다.

현재 공통 기준은 다음과 같다.

- namespace는 `asklake-dev`다.
- MSK는 Serverless + IAM, private `9098`을 사용한다.
- RDS database는 `asklake_app`, `airflow_metadata`, `iceberg_catalog`로 분리한다.
- AWS workload identity는 dev에 적용된 EKS Pod Identity를 기준으로 한다.
- External Secrets Operator controller와 namespaced `SecretStore` 기반은 준비됐지만 실제 네 runtime `ExternalSecret`/Secret은 아직 동기화하지 않았다.
- Spark Operator는 2.5.1, SparkApplication API는 `sparkoperator.k8s.io/v1beta2`다.
- ALB는 IngressClass/IngressClassParams까지만 있고 실제 Ingress와 ALB는 아직 없다.
- 기존 EC2는 rollback 원본이며 Kafka Continuous control-plane을 계속 소유한다.

## 1. ServiceAccount 계약

| Workload | ServiceAccount | Kubernetes API token | AWS Pod Identity | 비고 |
| --- | --- | --- | --- | --- |
| Frontend | `asklake-frontend` | `false` | 없음 | AWS와 Kubernetes API를 직접 호출하지 않는다. |
| FastAPI | `asklake-backend` | `true` | Backend 전용 | S3와 namespace 안의 SparkApplication/Pod log API를 사용한다. |
| Airflow API server/scheduler/DAG processor/migration | `asklake-airflow` | `false` | 없음 | FastAPI와 RDS만 사용하고 Kubernetes API, MSK, S3를 직접 사용하지 않는다. |
| Spark driver | `asklake-spark` | `true` | Spark 전용 | executor Pod/Service/ConfigMap lifecycle을 관리한다. |
| Spark executor | `asklake-spark` | 현재 `true` | Spark 전용 | 현재 driver와 같은 ServiceAccount를 사용한다. 분리 결정은 5절을 따른다. |
| Trino coordinator | `asklake-trino` | `false` | Trino 전용 | S3 warehouse/query result만 사용한다. |

검증 전용 MSK metadata Job은 `asklake-msk-smoke`를 사용하며 API token은 `false`, MSK smoke 전용 Pod Identity를 사용한다. EKS 밖 fixture producer의 `asklake-replay-producer` ServiceAccount는 `create=false`다.

Frontend와 FastAPI의 Service 이름은 PR #788과 PR #774 원격 head가 공통으로 정한 `frontend:80`, `fastapi:8080`을 유지한다. 다른 이름을 사용하려면 Ingress values와 A handoff 문서를 같은 변경에서 함께 수정해야 한다.

## 2. MSK·S3 권한 계약

| Identity | MSK 권한 | S3 권한 |
| --- | --- | --- |
| Frontend | 없음 | 없음 |
| FastAPI / Backend | 없음 | Raw/Output/Warehouse/Query Result bucket의 승인 prefix `ListBucket`; Raw/Output/Warehouse/Query Result/Evidence `GetObject`; Query Result/Evidence `PutObject`, `DeleteObject`, `AbortMultipartUpload` |
| Airflow | 없음 | 없음 |
| Spark driver/executor | fixture cluster `Connect`; fixture topic `DescribeTopic`, `ReadData`; fixture consumer group `DescribeGroup`, `AlterGroup` | Raw/Output/Warehouse와 checkpoint/quarantine 승인 prefix `ListBucket`; Raw/Output/Warehouse/checkpoint/quarantine `GetObject`; Output/Warehouse/checkpoint/quarantine `PutObject`, `DeleteObject`, `AbortMultipartUpload` |
| Trino | 없음 | Warehouse/Query Result 승인 prefix `ListBucket`; Warehouse/Query Result `GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload` |
| MSK smoke Job | fixture cluster `Connect`; fixture topic `DescribeTopic` | 없음 |

EKS 밖 fixture producer만 fixture topic `WriteData`를 가진다. 어느 runtime Secret에도 static AWS access key를 넣지 않는다.

## 3. runtime Secret, key, env/file mapping

Frontend는 runtime Secret을 사용하지 않는다. 나머지 workload 계약은 다음과 같다.

### `asklake-backend-runtime`

다음 key는 동일한 이름의 FastAPI env로 주입한다.

```text
DATABASE_URL
BOOTSTRAP_ADMIN_PASSWORD
AI_GATEWAY_SERVICE_TOKEN
AI_MCP_SERVICE_TOKEN
AI_CONTEXT_SIGNING_SECRET
OPENAI_API_KEY
AIRFLOW_API_TOKEN
AIRFLOW_PASSWORD
AIRFLOW_EXECUTION_API_TOKEN
AIRFLOW_INTERNAL_TOKEN
TRINO_AUTH_USERNAME
TRINO_AUTH_PASSWORD
TRINO_MATERIALIZER_USERNAME
TRINO_MATERIALIZER_PASSWORD
TRINO_RESULT_CURSOR_SECRET
TRINO_QUERY_CONFIRMATION_SECRET
```

`trino-ca.pem`은 env가 아니라 `/var/run/asklake/secrets/trino-ca.pem`에 read-only mount한다.

### `asklake-airflow-runtime`

| Secret key | Airflow env | B consumer |
| --- | --- | --- |
| `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` | 같은 이름 | API server, scheduler, DAG processor, migration |
| `AIRFLOW_EXECUTION_API_TOKEN` | `ASKLAKE_EXECUTION_API_TOKEN` | API server, scheduler, DAG processor |
| `AIRFLOW_INTERNAL_TOKEN` | 같은 이름 | API server, scheduler, DAG processor |
| `AIRFLOW__CORE__FERNET_KEY` | 같은 이름 | API server, scheduler, DAG processor, migration |
| `AIRFLOW__API_AUTH__JWT_SECRET` | 같은 이름 | API server, scheduler, DAG processor, migration |

A의 정적 JSON은 migration에 execution/internal token을 주입하고 JWT는 주입하지 않는 것으로 적혀 있어 B manifest와 다르다. DB migration은 Backend 호출을 하지 않으므로 최소 권한 기준으로 B의 execution/internal token 미주입을 유지한다. JWT가 `airflow db migrate`에 실제로 불필요하다는 import/migration 검증을 추가한 뒤 B에서 JWT도 제거하고, A의 consumer 목록을 `DB URL + Fernet`만 남도록 정정하는 것이 목표 계약이다.

### `asklake-spark-runtime`

```text
ASKLAKE_SPARK_ICEBERG_JDBC_URL
ASKLAKE_SPARK_ICEBERG_JDBC_USER
ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD
```

B SparkApplication은 세 key를 같은 이름의 driver env로 주입하고 executor에는 주입하지 않는다. A의 정적 JSON은 driver와 executor 모두를 consumer로 적고 있어 불일치한다. JDBC Catalog 제어가 driver에만 필요하다는 Spark 검증을 통과하면 A consumer를 driver-only로 좁힌다. 검증 전에는 실제 Spark `ExternalSecret` mapping을 완료로 표시하지 않는다.

### `asklake-trino-runtime`

다섯 key는 같은 이름의 coordinator env로 주입한다.

```text
TRINO_ICEBERG_JDBC_URL
TRINO_ICEBERG_JDBC_USER
TRINO_ICEBERG_JDBC_PASSWORD
TRINO_TLS_KEYSTORE_PASSWORD
TRINO_INTERNAL_SHARED_SECRET
```

`trino-keystore.jks`는 `/etc/trino/tls/keystore.jks`, `trino-password.db`는 `/etc/trino/auth/password.db`에 read-only mount한다.

Backend/Airflow의 execution/internal token과 Spark/Trino의 Iceberg JDBC URL/user/password는 각각 같은 논리값을 공유해야 한다. A 계약의 `airflowApiAuth`와 `aiRuntime` 결정은 아직 `learning-required`이므로 네 runtime Secret의 실제 동기화와 전체 workload enablement는 아직 완료 상태가 아니다.

## 4. SparkApplication 계약

- namespace: `asklake-dev`
- API version: `sparkoperator.k8s.io/v1beta2`
- kind: `SparkApplication`
- mode: `cluster`
- driver ServiceAccount: `asklake-spark`
- executor ServiceAccount: `asklake-spark`
- Spark Operator: 2.5.1, `asklake-dev` namespace만 감시

FastAPI의 `asklake-backend` Role은 `SparkApplication` create/get/list/watch/delete와 Pod/Pod log/Event read만 가진다. `asklake-spark` Role은 Pod create/get/list/watch/delete와 Service/ConfigMap create/get/delete만 가진다. Secret read나 cluster-wide 권한은 없다.

이 Role/RoleBinding은 A foundation이 단독 소유한다. B workload chart의 중복 RBAC는 제거한다. 특히 Spark driver Role 이름은 양쪽 모두 `asklake-spark-driver`라 Helm 소유권 충돌이 나며, Backend Role은 이름이 다르더라도 같은 권한을 중복 부여한다.

## 5. Spark driver/executor 분리 결정

15일차 MVP에서는 A에 이미 적용된 계약대로 driver와 executor가 `asklake-spark`를 공유한다. 따라서 PR #788 종료를 위해 새 ServiceAccount와 Pod Identity association을 추가하지 않는다.

다만 executor가 Kubernetes API를 호출하지 않는데도 driver token과 lifecycle RBAC을 함께 받는 잔여 과권한이 있다. 운영 전에는 다음처럼 분리한다.

```text
asklake-spark-driver
  Kubernetes API token: true
  Kubernetes RBAC: executor lifecycle
  AWS data-plane permission: Spark MSK/S3

asklake-spark-executor
  Kubernetes API token: false
  Kubernetes RBAC: 없음
  AWS data-plane permission: Spark MSK/S3
```

즉 Kubernetes API token/RBAC은 분리하지만 driver와 executor 모두 실제 data read/write를 수행할 수 있으므로 Spark MSK/S3 Pod Identity 권한은 유지한다. 이 잔여 위험을 수용하지 않으면 PR #788을 닫기 전에 A foundation과 B SparkApplication을 함께 바꿔야 한다.

## 6. EKS FastAPI의 EC2 Continuous 차단 범위

`ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`에서 오류 코드는 `409 CONTINUOUS_CONTROL_OWNED_BY_EC2`다.

- `executionMode=continuous` Job 생성은 DB 접근 전에 거절한다.
- 일반 Job 목록에서 Continuous Job을 숨기고 runtime refresh를 하지 않는다.
- Continuous Job 상세, 수정, 삭제를 거절한다.
- `startContinuous`, `pauseContinuous`, `resumeContinuous`, `stopContinuous`와 Continuous Job에 대한 일반 command를 모두 거절한다.
- Continuous logs, sessions, batches, quarantine, maintenance-run 조회를 거절한다.
- quarantine replay, compaction, Iceberg maintenance 요청을 거절한다.
- Continuous dataset의 단건 freshness와 published dashboard widget data 조회를 거절한다. 다건 freshness query는 전체 요청을 실패시키지 않고 해당 dataset을 결과에서 제외한다.
- FastAPI lifespan은 Continuous runtime sync loop를 시작하지 않고, `sync_active_kafka_continuous_runtimes()`도 DB를 열기 전에 return한다.
- 일반 scheduled tick은 계속 실행되지만 현재 control-plane에서 보이지 않는 Continuous Job을 필터링한다.
- scheduled tick은 FastAPI replica마다 시작된다. 같은 due Snapshot/Batch Job을 두 tick이 동시에 읽어도 `command_job()`이 Job row를 잠근 뒤 첫 Run reservation과 `job.status=running`을 먼저 commit한다. 따라서 다음 tick은 Run을 하나 더 만들지 않는다. `test_two_scheduler_ticks_reserve_one_airflow_run`은 두 tick이 같은 초기 Job 목록을 읽도록 강제해도 Airflow trigger와 `etl_runs` row가 각각 정확히 하나임을 확인한다.
- 같은 `runId`의 Spark/Catalog 실행은 RDS Run row의 owner, live lease, generation으로 fence한다. live lease의 두 번째 실행은 `409 SPARK_RUN_ALREADY_EXECUTING`이고, lease가 만료되어 generation을 넘긴 이전 replica는 결과 commit 전에 `409 SPARK_RUN_LEASE_LOST`로 막힌다.

Snapshot/batch Job과 그 scheduler path는 EKS에 남는다. EC2와 EKS가 같은 Continuous worker, command, runtime sync 또는 stale Continuous dashboard materialization을 동시에 소유하는 shared mode는 허용하지 않는다.

이 코드 증거는 file-backed SQLite 동시성 fixture와 PostgreSQL dialect의 `SELECT ... FOR UPDATE` 생성 검사로 유지한다. 실제 RDS에서도 FastAPI Pod 두 개가 같은 `runId`를 동시에 claim하도록 해 한 Pod만 실행하고 다른 Pod는 `409 SPARK_RUN_ALREADY_EXECUTING`을 받으며 generation 1의 최종 row 하나만 남는 것을 확인했다. 상세 결과와 cleanup은 [EKS MVP 수요일 Pair B 실환경 검증 기록](eks-day15-b-live-evidence.md)을 따른다.

## 7. Airflow storage/executor 결정

이번 MVP의 Airflow는 `LocalExecutor`가 맞으며 EFS/PVC를 사용하지 않는다.

- DAG `asklake_etl_job.py`는 Airflow image에 bake한다.
- metadata는 RDS의 `airflow_metadata` database에 저장한다.
- API server, scheduler, DAG processor는 각각 1 replica다.
- workload manifest에는 PVC, EFS, shared DAG volume 또는 shared log volume이 없다.
- Airflow task는 Kubernetes API를 사용하지 않아 `asklake-airflow` token도 `false`다.

따라서 Pod-local task log는 재시작 뒤 보존되거나 다른 Pod에서 공유된다는 보장이 없다. 이 제한은 MVP에서 수용하되 durable/shared log, scheduler HA 또는 동적 DAG 배포가 필요해지는 시점에는 remote logging이나 별도 storage/executor 설계를 추가한다.

## 8. PR #774와 공식 문서 반영 사항

다음은 PR #788 종료 전에 계약상 확인하거나 PR #774에 반영해야 하는 항목이다.

1. B workload chart는 A foundation이 소유하는 Backend/Spark Role·RoleBinding을 만들지 않는다.
2. B 문서의 `IRSA` 표현은 현재 dev 실제 선택인 EKS Pod Identity 또는 중립적인 workload identity로 바꾼다.
3. `asklake-spark` token, Backend/Spark RBAC, Spark Operator, RDS/MSK/S3/Pod Identity가 아직 A 입력 대기라는 PR #774의 오래된 checklist는 실제 적용 완료로 갱신한다.
4. 수요일 web 범위의 Frontend/Backend image digest와 Backend runtime Secret reference는 적용됐다. Airflow/Spark/Trino image와 runtime Secret은 목요일 이후 범위이며 web 배포 완료와 섞어 표현하지 않는다.
5. Airflow migration과 Spark executor의 Secret consumer 불일치는 3절의 최소 권한 목표로 정정하고 검증 전 실제 mapping을 완료 처리하지 않는다.
6. Spark driver/executor 단일 ServiceAccount는 15일차 MVP 예외로 기록하고 운영 전 분리 follow-up을 남긴다.
7. Airflow는 LocalExecutor + image-baked DAG + no EFS/PVC이며 Pod-local log 비영속 제한을 기록한다.
8. Continuous 오류 코드의 공식 표기는 `CONTINUOUS_CONTROL_OWNED_BY_EC2`다. PR 본문의 `CONTINUOUS_CONTROL_PLANE_EXTERNAL` 표기는 수정해야 한다.
9. Service는 현재 합의된 `frontend:80`, `fastapi:8080`을 사용한다. 다른 이름을 선택하면 A Ingress와 handoff도 같은 변경에서 갱신한다.
10. A의 ALB 상태는 class/params만 적용됐고 Ingress/ALB는 0개다. RDS 복사는 rehearsal이며 EC2 rollback 원본과 cutover 전 delta gate가 남아 있다.
11. 두 원격 head의 3-way merge에서 `docs/system-guardrails.md`는 실제 text conflict가 난다. `docs/02-architecture.md`와 `docs/04-development-guide.md`도 양쪽이 함께 수정했으므로 자동 merge 여부와 별개로 A의 실제 foundation evidence와 B의 runtime 계약을 문단 단위로 모두 보존해 검토한다.

PR #788은 위 불일치와 MVP 예외를 계약으로 기록한 상태에서 infrastructure foundation 완료로 닫을 수 있다. Frontend/FastAPI workload rollout과 내부 live smoke는 이후 완료됐다. MSK IAM client는 private `9098` 연결과 IAM 인증 뒤 metadata 요청까지 도달했지만 test topic이 없어 fail-closed로 종료됐다. 따라서 Ingress/ALB, S3 positive smoke와 MSK test topic metadata까지 완료했다는 표현은 사용하지 않는다.

## 9. `asklake-web` 정식 release probe·AMD64 gate (2026-07-15 B 검토)

`asklake-web`은 A가 소유하는 Frontend/FastAPI application release chart다. B는 이 chart를 새로 만들지 않았고, 실제 dev 값으로 `helm lint`와 `helm template`을 실행해 다음 결과를 확인한 뒤 같은 A-owned chart를 단일 web release로 적용했다.

- Service는 합의된 `frontend:80`, `fastapi:8080`이고 Frontend/FastAPI image는 immutable ECR digest 형식이다.
- Backend는 `asklake-runtime` ConfigMap과 `asklake-backend-runtime` Secret을 `envFrom`으로 참조한다.
- 그러나 Backend `startupProbe`, `readinessProbe`, **`livenessProbe` 모두** `/api/health` HTTP probe다. `/api/health`는 DB-aware endpoint이므로 liveness로 사용하면 RDS의 일시 장애가 FastAPI container 재시작으로 이어진다.
- Frontend와 Backend의 `placement.nodeSelector`는 `asklake.io/workload-class: general`만 렌더하며 `kubernetes.io/arch: amd64`를 강제하지 않는다.

초기 렌더 불일치는 사용자 승인 후 B가 아래처럼 수정했고, `scripts/verify-eks-web-workloads.sh`의 Helm lint/template 및 unsafe override 검사까지 통과했다.

1. Backend liveness는 `tcpSocket`의 `http` port(8080) 검사로 바꿨고, `/api/health`는 startup/readiness에만 유지한다.
2. 공통 placement selector에 `kubernetes.io/arch: amd64`를 추가해 Frontend와 Backend 모두 AMD64 node에만 스케줄한다. 기존 `asklake.io/workload-class: general` selector는 유지한다.

Verifier는 ARM64 selector override를 schema에서 거절하고, render에 AMD64 selector가 두 번·`/api/health`가 두 번(startup/readiness)·TCP liveness가 한 번만 나오는지 검사한다. runtime Secret reference, immutable Frontend/Backend image, Ready AMD64 General node와 ownership gate를 확인한 뒤 `asklake-web` revision 1을 적용했고 내부 Service/RDS health와 두 replica를 검증했다. 실제 결과는 [EKS MVP 수요일 Pair B 실환경 검증 기록](eks-day15-b-live-evidence.md)을 따른다.
