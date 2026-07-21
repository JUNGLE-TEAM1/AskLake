# 7/16 Pair B Spark·MSK bounded CP3·CP4 실환경 검증 기록

## 목적과 판정

`eks-roadmap.md` 목요일 Pair B의 `Spark driver/executor resource와 MSK source boundary 연결`, 단일 bounded Job의 **MSK → Spark → Iceberg commit**, 같은 `runId` 재시도 중복 방지 구간을 검증한다.

2026-07-16 dev 최종 판정은 **CP3·CP4·CP8·CP9 성공**이다. 외부 producer가 넣은 한 fixture batch 100건을 하나의 AskLake `runId`로 Airflow와 동적 SparkApplication에 전달했고, Spark가 exact batch 100건만 읽어 Iceberg snapshot을 commit했다. 같은 성공 Run 재호출은 새 lease, SparkApplication, Iceberg snapshot을 만들지 않았다. 이후 같은 snapshot을 Trino에서 exact 100행으로 검증하고 Catalog materialization과 AskLake Run 5/5 성공까지 확정했으며, FastAPI rolling update 뒤에도 동일한 실행 식별자와 결과를 복구했다. 실행 중 강제 Pod 삭제와 반복 장애 주입은 아래에 명시한 토요일 작업으로 이관한다.

## 고정한 경계

- topic: `asklake.eks-mvp.fixture.v1`
- consumer group: `asklake-eks-mvp-spark-v1`
- fixture batch: `<fixture-batch-redacted>`
- producer expected count: `100`
- output: `s3a://<output-bucket>/eks-mvp/output/<runId>`
- checkpoint: `s3a://<output-bucket>/eks-mvp/checkpoints/<runId>`
- authentication: MSK IAM, bootstrap port `9098`, `asklake-spark` Pod Identity
- Iceberg target: `iceberg.asklake.eks_mvp_fixture`, `replace`

별도 S3 producer receipt object는 찾지 못했지만 read-only IAM consumer로 topic offset `0..100`과 100개 message의 단일 `raw.fixture_batch_id`, 모든 message의 `raw.expected_count=100`을 확인했다. 검사 consumer는 auto commit을 끄고 실행했으며 완료 뒤 임시 Pod 두 개를 삭제했다.

## CP3 구현 gate

- fixture Kafka Job만 전용 Iceberg target을 RDS Job에 고정한다. 기존 Kafka Snapshot과 EC2 Continuous target은 바꾸지 않는다.
- Spark는 `raw.fixture_batch_id` filter 뒤 실제 count를 `expectedCount`와 비교한다. 다르면 Iceberg commit 전에 실패한다.
- 성공 report도 FastAPI가 RDS 성공으로 저장하기 전에 아래 값을 다시 대조한다.
  - persisted `sourceBoundary` = Spark result boundary = Iceberg commit boundary
  - `inputRows` = `outputRows` = producer `expectedCount`
  - Job/Run identity와 Iceberg target 일치
  - 비어 있지 않은 Iceberg snapshot ID
- 불일치는 `EKS_MVP_FIXTURE_RESULT_INVALID`로 fail-closed한다.

CP3 관련 로컬 검증은 Python 40개(1 skip), Kafka fixture boundary 8개, Spark Kubernetes 10개와 Airflow DAG wiring을 통과했다.

## 배포 증거

- CP3 Backend: `sha256:<redacted>`
- CP4 Backend: `sha256:<redacted>`
- Airflow: `sha256:<redacted>`
- CP3 Spark runtime: `sha256:<redacted>`
- CP4 Spark runtime: `sha256:<redacted>`
- FastAPI 2/2, Airflow API Server/Scheduler/DAG Processor 각 1/1 Ready
- 새 FastAPI에서 CP1/CP2/CP3 marker와 `/api/health`의 RDS `ok=true` 확인
- CP4 Backend는 기존 `asklake-web` release revision 21로 rolling update했고 Spark digest는 Pair B 소유 `asklake-runtime` ConfigMap에 반영했다. FastAPI 2/2와 DB-aware health를 확인했다.

## 단일 Run 연결표

```text
fixtureBatchId  <fixture-batch-redacted> / expected 100
→ jobId         <job-redacted>
→ runId         <run-redacted>
→ Airflow       asklake_etl_job / <run-redacted>
→ SparkApplication <spark-application-redacted>
→ UID           <uid-redacted>
→ driver        <driver-pod-redacted> / Succeeded / exit 0
→ input/output  100 / 100
→ target        iceberg://iceberg/asklake/eks_mvp_fixture
→ snapshot      <snapshot-redacted>
→ Trino         exact Run 100 rows / data file 1 / 5,505 bytes / metadata present
→ Catalog       <dataset-redacted> / materialization 1
→ final status  Airflow success / AskLake Run success
```

Airflow `receive_asklake_run`, `validate_spark_request`, `spark_process_write`가 같은 `runId`로 성공했다. RDS `etl_runs.task_states.sparkResult`에는 SparkApplication UID, driver terminal 상태, exact source boundary, input/output 100건, commit target과 snapshot이 함께 저장됐다.

동적 SparkApplication은 driver `1 core, 2g + 512m`, executor 1개 `2 cores, 4g + 1g`로 실행됐다. 현재 Pair B `asklake-runtime`은 별도 CPU limit key를 제공하지 않아 실제 core request/limit은 driver `1/1`, executor `2/2`였다. 정적 Helm smoke 기본값 `1/2`, `2/3`과의 차이는 후속 runtime tuning 항목이며 이번 100건 bounded commit을 막지 않았다.

## CP4 같은 Run 재시도와 중복 방지

구현한 복구 규칙은 다음과 같다.

- RDS에 이전 `sparkExecution.kubernetesExecution`이 있으면 namespace/name/UID를 Node provider까지 전달한다.
- provider는 재시도에서 Kubernetes `POST`보다 `GET`을 먼저 실행한다. object 부재나 UID 교체 시 replacement를 만들지 않는다.
- progress watcher가 별도 DB transaction으로 저장한 UID는 예외 확정 세션이 RDS를 다시 읽고 보존한다.
- 이미 `sparkResult.status=success`인 같은 `runId`는 lease generation을 올리거나 Kubernetes를 호출하지 않고 저장된 manifest를 반환한다.
- 동일 persisted Kafka boundary가 Iceberg target에 있으면 `append`뿐 아니라 CP3의 `replace` target도 writer를 호출하지 않고 기존 snapshot을 `reuse`한다.

Node provider 13개와 Python RDS/fixture boundary 64개, Airflow wiring 검증을 통과했다. 테스트에는 persisted UID의 GET-only 복구, object 부재/UID drift에서 POST 0회, FastAPI interruption 뒤 같은 UID 전달, terminal success short-circuit, replace target의 기존 snapshot reuse가 포함된다.

dev에서는 Airflow에 저장된 같은 boundary로 `<run-redacted>` internal execute API를 다시 호출했다. 재호출 전후 결과는 다음과 같다.

```text
RDS execution_generation  4 → 4
SparkApplication count    1 → 1
SparkApplication UID      <uid-redacted> → 동일
Iceberg main snapshot     <snapshot-redacted> → 동일
returned runId/status     <run-redacted> / success
```

따라서 이 비파괴 live retry에서는 새 `runId`, 새 SparkApplication, 새 Iceberg snapshot이 생기지 않았다. 실행 중 FastAPI 강제 종료 직후 takeover를 일으키는 파괴적 fault injection은 수행하지 않았으며, 그 중간 상태 복구 경계는 위 interruption/UID/reuse 단위 테스트로 검증했다.

## CP4 당시 남은 경계

Spark와 FastAPI의 CP3 결과 확정 뒤 Airflow `publish_run_result`는 `Catalog reconciliation`에서 `Spark output path does not match the persisted Job destination.`으로 재시도에 들어갔다. 원인은 fixture Iceberg result를 아직 일반 Kafka/S3 path 분기로 검사하는 Catalog 단계다.

따라서 이 문서로 주장하는 완료 범위는 **MSK bounded consume, Iceberg commit, RDS 증거 저장, 같은 성공 Run의 멱등 재호출**까지다. Trino table row/snapshot/data file 물리 검증, Catalog Dataset 확정과 최종 AskLake Run `success`는 다음 체크포인트에서 처리한다.

## CP8 Trino 물리 검증과 Catalog 확정

기존 실패는 fixture Job이 `icebergTarget`을 가지고도 Kafka라는 이유로 legacy S3 output path 검증에 들어간 것이 원인이었다. EKS bounded fixture만 일반 Iceberg reconciliation 분기로 보내고, RDS Run에 고정한 `expectedCount`를 exact snapshot의 `_asklake_run_id=runId` 행 수와 비교하도록 수정했다. 기존 Kafka Snapshot/Continuous 경로와 Spark 실행 경로는 변경하지 않았다.

Backend image `sha256:<redacted>`를 `asklake-web` revision 22에 배포했고 FastAPI 2/2 Ready를 확인했다. Spark를 다시 실행하지 않고 기존 Run의 Catalog endpoint를 호출한 결과는 다음과 같다.

```text
jobId                 <job-redacted>
runId                 <run-redacted>
Iceberg table         iceberg.asklake.eks_mvp_fixture
snapshotId            <snapshot-redacted>
exact Run row count   100
data file count       1
storage size          5,505 bytes
metadata file         present, s3a scheme
Catalog datasetId     <dataset-redacted>
materialization count 1 for the same runId
```

Trino `eks_mvp_fixture$metadata_log_entries`에서도 같은 snapshot의 metadata file이 S3A 위치에 존재했다. Airflow v2 clear API의 dry-run은 실패한 `publish_run_result` 하나만 선택했다. `only_failed=true`로 그 task만 재실행했고 upstream `spark_process_write`는 다시 실행하지 않았다. 이후 네 task와 DAG Run이 모두 `success`가 됐고, 로그인된 AskLake `/jobs` 화면을 새로고침해 같은 Run이 5/5 성공, input/output 100행으로 표시되는 것을 확인했다. RDS에서도 `runStatus=success`, `airflowState=success`, `sparkResult.status=success`, `catalogResult.status=success`와 같은 snapshot ID를 확인했다.

따라서 CP8에서는 **같은 `runId`의 persisted Spark success → Trino exact snapshot/row/file 검증 → Catalog Dataset transaction → Airflow/AskLake final success**가 연결됐다. 새 SparkApplication, 새 Iceberg snapshot 또는 새 Run을 만들지 않았다.

로컬 회귀 검증은 fixture Catalog routing, 일반 Kafka legacy routing 유지, exact snapshot Run row count, Kafka fixture boundary, Airflow Run concurrency를 포함한 Python 48개 테스트가 통과했다. `npm run verify:airflow-catalog-wiring`도 통과했다. `npm run verify`는 로컬 MinIO `127.0.0.1:9000`이 실행 중이지 않아 기존 S3 fixture 단계에서 중단됐으며 코드 실패로 판정하지 않았다.

## CP9 목요일 재시작 복구와 Continuous 소유권 경계

`eks-roadmap.md`의 목요일 Merge 조건은 FastAPI가 재시작되거나 replica가 바뀐 뒤에도 같은 실행을 계속 조회할 수 있는 것이다. 실행 중 Pod를 강제로 죽여 자동 retry를 검증하는 전체 장애 시나리오는 토요일 범위다.

목요일에는 `<run-redacted>`의 Spark 성공 증거를 RDS에 둔 상태에서 CP4 Backend rolling update와 CP8 `asklake-web` revision 22 rolling update로 FastAPI Pod가 교체됐다. 교체 뒤에도 다음 식별자는 그대로 조회됐고 최종 Catalog/Run 성공까지 이어졌다.

```text
runId                 <run-redacted>
SparkApplication UID  <uid-redacted>
Iceberg snapshot      <snapshot-redacted>
Catalog materialization for runId  1
final Run status      success
```

EKS runtime의 `ASKLAKE_CONTINUOUS_CONTROL_PLANE`은 `external_ec2`이고 FastAPI의 runtime 판정도 `externalEc2=true`였다. `asklake-dev`에는 Kafka Continuous Pod가 없고 FastAPI Pod 내부에도 `kafka_continuous_stream`, Continuous manager 또는 maintenance process가 없었다. 이번 변경 diff에는 Continuous lifecycle/worker/checkpoint 구현 변경이 없으며 fixture 전용 topic `asklake.eks-mvp.fixture.v1`, group `asklake-eks-mvp-spark-v1`, `eks-mvp/output`, `eks-mvp/checkpoints`만 사용했다. 따라서 EKS가 EC2 소유 Continuous worker/topic/group/checkpoint를 시작하거나 변경하지 않았다는 목요일 경계를 유지했다.

### 토요일 작업으로 명시적으로 이관

다음 항목은 목요일 Merge 조건에 포함하지 않고 `eks-roadmap.md`의 7/18 장애·재시도 검증에서 수행한다.

- 새 bounded Run의 `spark_process_write` 실행 중 실제 요청을 처리하는 FastAPI Pod 강제 삭제
- 대체 Pod 생성과 lease 만료 뒤 같은 `runId`의 수동/자동 task 재시도 검증
- SparkApplication UID, Iceberg snapshot, Catalog materialization 중복이 없는지 재확인
- Spark driver 실패, MSK IAM 인증 실패, digest Rolling Update/rollback을 포함한 반복 장애 시나리오

현재 `spark_process_write`는 Airflow task retry가 0이고 `publish_run_result`만 30초 간격으로 2회 재시도한다. 따라서 실행 중 FastAPI 강제 종료는 별도 복구 절차와 함께 설계해야 하며, 목요일 빠른 확인에 섞지 않는다.

## CP10 Pair B handoff

### 실행 완료

- fixture batch marker 1개와 expected 100건을 RDS Run boundary에 고정
- Airflow → FastAPI → SparkApplication driver/executor → Iceberg → Trino → Catalog의 단일 bounded E2E 성공
- 같은 성공 Run 재호출에서 generation, SparkApplication 수/UID와 snapshot 불변 확인
- FastAPI rolling update 뒤 같은 Run 상태·결과 조회와 최종 5/5 성공 확인
- EKS의 EC2 Continuous control-plane 차단 상태 확인
- Backend CP8 digest 배포와 FastAPI 2/2 Ready 확인
- 최종 회귀 검증: Spark Kubernetes Node 13개, 관련 Python 76개(1 skip), Airflow Catalog wiring과 EKS image delivery contract 통과

### 미실행·한계

- 실행 중 FastAPI 강제 삭제 takeover, Spark/MSK 실패 주입과 반복 장애 검증은 위 토요일 항목으로 이관했다.
- `npm run verify` 전체는 로컬 MinIO 미기동으로 S3 fixture 단계에서 중단됐다. 변경 인접 Python 48개와 Airflow Catalog wiring, dev live E2E는 통과했다.
- Airflow Pod local log는 EFS/PVC가 없는 현재 MVP에서 Pod 교체 시 영속 보존되지 않는다. RDS Run/task state, SparkApplication identity와 S3/Iceberg/Catalog가 복구 source of truth다.

### 정리와 rollback

- CP8/CP9는 새 임시 Kubernetes Job, test object 또는 새 SparkApplication을 만들지 않았고 기존 성공 Run만 사용했다.
- Backend rollback 기준은 이전 CP4 digest `sha256:<redacted>`와 `asklake-web` revision 21이다.
- Catalog reconciliation은 같은 `runId` materialization을 하나로 유지한다. rollback 시 검증된 Iceberg snapshot과 RDS Spark evidence를 삭제하지 않고 Backend image만 이전 digest로 되돌린다.
- Secret 값, token, database URL, private key와 static AWS credential은 이 문서와 PR에 넣지 않는다.
