# EKS MVP 수요일 Pair B 실환경 검증 기록

이 문서는 `eks-roadmap.md`의 7월 15일 Pair B 범위인 Frontend/FastAPI web workload, RDS health, 두 replica 실행 안전성, EC2 Continuous 제어권 경계를 2026-07-15~16 `dev` EKS에서 검증한 저장소용 요약이다. 실제 계정 ID, ECR digest, Pod UID/IP, node ID, RDS 접속 문자열과 실행용 private values는 Git 밖의 Pair B evidence에 둔다.

## Web workload와 내부 Service

- A가 소유하는 `asklake-web` chart 하나로 Frontend와 FastAPI Deployment/ClusterIP Service를 적용했다. B의 workload chart를 경쟁 release로 설치하지 않았다.
- Frontend와 FastAPI는 각각 desired/ready/available `2/2/2`였고 unavailable replica는 없었다.
- Frontend는 `asklake-frontend`, FastAPI는 `asklake-backend` ServiceAccount를 사용했다.
- 네 Pod 모두 immutable `repository@sha256:digest` imageID로 실행됐고 restart count는 0이었다. 실제 digest receipt는 Git 밖에 보관한다.
- Service handoff는 `frontend:80`, `fastapi:8080`이다. 두 EndpointSlice는 각각 Ready Pod IP 두 개를 가리켰다.
- Frontend Pod에서 `http://fastapi:8080/api/health`를 5회 호출해 모두 HTTP 200과 `database.ok=true`를 확인했다. `http://frontend:80/`도 HTTP 200이었다.
- FastAPI startup/readiness는 DB-aware `/api/health`, liveness는 TCP 8080으로 분리돼 있다.

2026-07-16에는 scheduled tick 경쟁 수정 commit `059d8eaa`를 Backend-only 새 immutable AMD64 image로 전달하고 기존 `asklake-web` release를 atomic upgrade했다. revision 2에서 Frontend image와 replica 수는 그대로 유지됐고, 이전 Backend ReplicaSet은 0으로 줄고 새 ReplicaSet이 ready `2/2`가 됐다. 새 두 Pod는 restart 0이었으며 각 Pod의 localhost health, Frontend→FastAPI Service health가 모두 HTTP 200과 `database.ok=true`를 반환했다. rollback 기준은 superseded revision 1과 Git 밖의 이전 Backend digest receipt다.

외부 ALB와 `/api` route의 소유권은 Pair A에 남는다. 재배포 검증 시 A의 `asklake-ingress`가 만든 internet-facing ALB는 `active`, 새 Backend target 두 개와 Frontend target 두 개는 `healthy`였고 외부 `/api/health`와 `/`가 각각 HTTP 200을 반환했다.

## Web Pod 자동복구

FastAPI Service health를 1초마다 호출하면서 replica 하나를 삭제했다. 45회 요청이 모두 성공하는 동안 ReplicaSet이 다른 UID/IP의 대체 Pod를 만들었고 Deployment는 다시 ready `2/2`가 됐다. EndpointSlice도 삭제된 IP 대신 새 Ready Pod IP를 가리켰다.

이 결과는 Pod 하나의 삭제와 Service 연속성에 대한 수요일 기본 자동복구 증거다. 검증 당시 두 FastAPI replica가 같은 node에 있었으므로 node 장애, multi-AZ 또는 multi-node 고가용성 증거로 확대 해석하지 않는다. HPA, node autoscaling, Rolling Update와 node 장애는 로드맵의 금요일·토요일 범위다.

## RDS Run lease와 두 replica 중복 방지

운영 데이터와 섞이지 않는 고유 `JOB-EKS-REPLICA-*`, `RUN-EKS-REPLICA-*` fixture를 RDS에 만들고 schedule을 `manual`로 고정했다. 두 실제 FastAPI Pod에서 같은 `runId`의 `execute_airflow_spark_run()`을 같은 시각에 호출했으며 외부 Spark 호출은 6초짜리 in-memory fake로 대체했다. 따라서 Airflow, Spark, MSK와 S3에는 접근하지 않았다.

결과는 다음과 같다.

- 한 Pod만 execution lease를 획득해 fake Spark를 정확히 1회 실행하고 `success`를 기록했다.
- 다른 Pod는 fake Spark를 한 번도 호출하지 않고 `409 SPARK_RUN_ALREADY_EXECUTING`을 받았다.
- RDS에는 해당 `runId` row가 하나만 있었고 `execution_generation=1`, `sparkExecution.status=success`, `sparkResult.status=success`였다.
- 완료 뒤 `execution_owner`와 lease 만료 시각이 해제됐다.
- 증거 확인 후 fixture Job/Run을 삭제했고 두 row count가 모두 0임을 확인했다.

이 실증은 실제 두 Pod와 실제 RDS row lock/lease/generation fence를 사용한다. 실제 SparkApplication 또는 데이터 결과의 중복 방지는 목요일 bounded E2E에서 같은 `runId`로 별도 검증한다.

## EC2 Continuous 제어권 경계

두 FastAPI Pod에서 각각 다음을 확인했다.

- `ASKLAKE_CONTINUOUS_CONTROL_PLANE=external_ec2`
- `sync_active_kafka_continuous_runtimes()`가 DB session을 열기 전에 반환
- `kafka_continuous_stream.py`, maintenance runner와 manager process 0개

따라서 EKS FastAPI는 Snapshot/Batch scheduler만 유지하고 Kafka Continuous worker·command·runtime sync를 시작하지 않는다. Continuous 제어권과 상태 변경 책임은 수요일 범위에서 EC2에 남는다.

## MSK IAM client smoke

첫 일회성 Job `asklake-msk-iam-smoke-8c73664b`는 `asklake-msk-smoke` ServiceAccount와 현재 Backend immutable image에서 `verify-msk-iam-metadata.mjs`를 실행했다.

- Pod에는 EKS Pod Identity credential endpoint와 projected identity token이 자동 주입됐다. static AWS access key는 사용하지 않았다.
- client는 private bootstrap `9098`에 TLS/OAUTHBEARER IAM 방식으로 연결했다. `admin.connect()` 뒤 test topic metadata 요청까지 broker가 처리했으므로 private network와 IAM 인증 경로는 통과했다.
- 첫 metadata 요청은 `This server does not host this topic-partition`으로 fail-closed 종료돼 요청한 `asklake.eks-mvp.fixture.v1` topic이 bootstrap되지 않은 것을 확인했다.
- 별도 일회성 bootstrap Job `asklake-msk-topic-bootstrap-74092403`에 exact topic의 `kafka-cluster:CreateTopic`만 임시로 허용했다. message produce/consume, topic alter/delete 권한은 주지 않았고 1 partition topic을 생성한 뒤 Job `Complete 1/1`과 `created=true`를 확인했다.
- bootstrap 직후 임시 inline policy를 삭제하고 role의 inline policy 목록이 비어 있음을 확인했다. Terraform 관리 managed policy의 `Connect`와 exact topic `DescribeTopic` 계약은 변경하지 않았다.
- 원래 Describe-only 권한으로 `asklake-msk-iam-smoke-74092403`을 다시 실행했다. Pod는 restart 0의 `Succeeded`, Job은 `Complete 1/1`이었고 로그는 topic, region, `partitionCount=1`, `status=success`를 기록했다.

`docs/eks-phase-3-data-plane.md`가 요구한 별도 승인 admin bootstrap은 exact temporary permission, 1 partition, MSK Serverless 기본 replication/retention으로 수행했다. 두 완료 Job은 1시간 TTL로 자동 정리되며 test topic은 목요일 bounded fixture 입력에 사용한다.

## B 검증 당시 남았던 수요일 통합 gate

- Backend Pod가 EKS Pod Identity로 `asklake-dev-backend` role을 획득하는 것은 확인했다. 첫 Raw S3 목록 검증은 요청에 `Prefix`가 없어 IAM `s3:prefix` 조건과 맞지 않아 `AccessDenied`였으며 object 생성 전 실패했다. S3 positive smoke는 완료하지 않았다.

그러므로 이 기록 자체는 B web workload, RDS health, Pod 자동복구, 두 replica 안전성, Continuous 경계, 외부 ALB web/API route와 EKS→MSK network/IAM·test topic metadata의 완료 증거다. 이 기록을 작성한 시점에는 S3 positive smoke를 완료로 선언하지 않았다.

후속 Issue #794에서 A runner가 Raw/Output/Warehouse 읽기, Query Result/Evidence 쓰기와 계약 밖 Get/List·bucket metadata 거절을 실제 Backend Pod Identity로 반복 검증했고 version/DeleteMarker까지 정리했다. 따라서 현재 수요일 S3 gate의 기준은 [Backend S3 최소 권한 검증 기록](eks-day15-backend-s3-runtime-evidence.md)이며, 위 최초 실패는 당시 이력으로만 남긴다. PR #774는 `pair1`에 머지됐고 Phase 3.5에서 Backend source commit `059d8eaa`, immutable ECR digest와 현재 FastAPI 두 Pod imageID의 일치도 재확인했다.
