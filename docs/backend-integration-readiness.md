# AskLake Backend Integration Readiness

이 문서는 AskLake 프론트엔드와 백엔드 연결 상태, 남은 API 범위, 검증 기준을 정리한다. Pair A Source/Schema/Create/Run 흐름은 기본 live API mode에서 backend를 기준으로 검증하고, frontend-only QA에서만 `VITE_USE_MOCK_API=true` fallback을 사용한다.
FastAPI 전환의 공통 구조와 의사결정은 `docs/backend-fastapi-transition-plan.md`를 기준으로 한다.

상세 request/response shape는 `docs/api-contract.md`를 기준으로 한다.

2026-07-18 pair1·dev 통합은 dev의 최신 ETL/frontend/SQL 모듈 경계를 유지하면서 pair1의 EKS bounded fixture, Kubernetes Spark UID 복구, RDS owner/generation fence와 `external_ec2` 소유권 계약을 전용 adapter에 이식했다. Day 18 후속 계약은 non-terminal 동일 UID 복구와 terminal-failed attempt generation을 분리하고, 기존 EKS fixture Run에 deny-only MSK evidence를 연결한다. Python 전체 회귀 873개와 Spark Kubernetes Node 계약 18개가 통과했다. 실제 live rollout/fault/E2E 완료 여부는 [Day 18 Phase 7·8 결과](eks-day18-phase7-8-result.md)를 따른다.

## 1. 현재 연결 상태

감사 로그 신규 writer는 알려진 `AuditTargetType` enum member만 허용하고, `unknown`은 레거시 읽기 호환에만 사용한다. OpenAPI 호환성 검사는 inline enum과 local component `$ref`를 resolve한 의미 기준으로 비교하면서 enum 제거·type 변경·미해결 reference는 계속 차단한다. 프런트 재조회 실패는 마지막 성공 데이터를 stale로 유지하며 요청 순서가 역전되어도 최신 요청만 상태를 소유한다. `verify:identity-admin`은 smoke 전용 demo fixture를 명시적으로 활성화하고 admin/viewer session cookie로 관리 API를 호출하며 actor header fallback에 의존하지 않는다.

15.5 물리 조회 점검은 Iceberg Dataset rows의 Trino 오류 처리 경로에서 누락된 `ApiError` import와 enum reason 직렬화 drift를 수정했다. service 회귀 test와 실제 FastAPI TestClient endpoint test는 내부 Trino endpoint/query/token marker를 노출하지 않고 HTTP 502 `SQL_STORAGE_ERROR`와 normalized `BACKEND_TIMEOUT` reason을 유지하는지 확인한다. Issue #798에서 수정 exact revision의 AMD64 immutable image를 Backend-only rollout하고 같은 계약을 live 검증했다. 재배포 인수 기준은 [EKS 15.5 Backend image handoff](eks-day15-5-backend-image-handoff.md)를 따른다.

Issue #798 Phase 0은 현재 receipt·Deployment·두 Pod digest 일치, FastAPI 2/2, ALB/RDS·ExternalSecret·Continuous 경계와 직전 Helm/ECR rollback artifact를 읽기 전용으로 확인했다. 이 기준점은 [15.5 runtime 보완 실행 기록](eks-15-5-runtime-remediation-evidence.md)에 남기며, 새 image 배포 전 상태가 정상이라는 뜻이지 source 수정이 runtime에 반영됐다는 뜻은 아니다.

Issue #798 Phase 1 당시 source fix와 HTTP 회귀 test를 포함한 exact revision으로 Backend focused test 8개와 수동 OIDC image delivery를 통과했다. 그 시점의 새 formal receipt는 immutable `linux/amd64`이고 당시 배포 image와 달랐으며, 이후 단계에서 추가 enum 수정 receipt로 교체·배포됐다.

Issue #798 Phase 2는 당시 Helm values에서 `backend.image`만 새 receipt digest로 바꾼 candidate의 lint/render와 API server dry-run을 통과했다. dry-run 전후 Helm revision, Backend Deployment generation/image와 Pod UID는 변하지 않았고 ALB·RDS·ExternalSecret·Continuous·보존 EC2 gate도 정상이었다. 승인된 concurrent Secret 확장은 source/target 전체 hash로 검증했으며 기존 digest의 외부 Pod restart를 덮어쓰지 않았다. 실제 반영과 runtime HTTP 회귀는 후속 Phase 3~4에서 완료됐다.

Issue #798 Phase 3은 첫 새-image rollout에서 Kubernetes Ready와 ALB Healthy 사이의 간격으로 외부 502를 발견해 두 차례 rollback했다. EKS Auto Mode managed webhook의 exact namespace selector인 `eks.amazonaws.com/pod-readiness-gate-inject=enabled`를 Foundation에 반영했고 현재 새 Backend image는 `2/2`, ALB steady로 실행된다. 다만 해당 배포의 zero-failure 표본과 새 Pod readiness gate 증거는 남지 않아 다음 image rollout에서 다시 검증한다.

Issue #798 Phase 4의 live Catalog Iceberg rows 호출은 `NameError`/500이나 private marker 없이 HTTP 502 `SQL_STORAGE_ERROR`까지 확인했다. 추가로 reason이 `ErrorCode.BACKEND_TIMEOUT`으로 노출되는 enum 정규화 drift를 찾아 source와 focused test에서 `BACKEND_TIMEOUT` wire value로 수정했다. 이 추가 commit의 새 image 배포와 live 재검증 전에는 Phase 4 완료가 아니다.

Issue #798 Phase 4 보완은 enum 수정 exact revision의 새 immutable AMD64 Backend image를 readiness-gate 기반으로 배포했다. 외부 health 343개 최종 표본 실패 0, 새 Pod gate/digest `2/2`, Frontend·Secret 무변경과 ALB/RDS·Continuous·EC2 postcheck가 통과했다. live Iceberg rows는 HTTP 502 `SQL_STORAGE_ERROR`, reason `BACKEND_TIMEOUT`을 반환하며 enum 구현명과 private marker를 노출하지 않았다. Trino 미배포 오류 계약은 완료됐고 snapshot-aware HTTP 200은 Trino 배포 후 별도 gate다.

Issue #798 Phase 5는 현재 Catalog metadata에서 선택한 root 아래 non-empty exact Parquet object를 강화된 Spark runner로 다시 읽었다. `COMPLETED`, 22 columns, bounded 5 rows, width 일치와 임시 resource 잔여 0이 확인됐다. 실제 `kubectl auth can-i`의 deny exit code 1도 정상 거부로 검증하고 allow/API-error regression을 추가했다. 이 결과는 bounded object read 증거이며 Trino snapshot-aware table read나 Kafka→Iceberg 전체 E2E 증거는 아니다.

Issue #798 Phase 6 최종 감사는 현재 formal receipt와 Backend Deployment·두 Ready Pod digest, target-health gate, ALB/RDS, sanitized rows 502, `external_ec2` Continuous process 0, 보존 EC2 status와 physical read 잔여 0을 다시 대조했다. Issue #798 acceptance는 완료됐으며 Trino snapshot HTTP 200과 Kafka 전체 E2E는 후속 배포 gate로 유지한다.

Issue #798 Phase 7은 `origin/feat-#797` 대비 전체 전달 diff를 감사하고 과거 “미배포” 문구가 현재 상태처럼 남은 문서를 최종 runtime 결과에 맞췄다. branch 통합과 PR 생성은 수행하지 않았으며 현재 branch는 독립 리뷰 가능한 handoff 상태다.

FastAPI 1차 scaffold의 범위는 서버 실행, CORS, PostgreSQL 연결, 공통 error envelope, `/api/health` 확인이었다.
현재 브랜치는 ETL/Catalog/SQL live endpoint, Dashboard card/runtime, local session auth와 Phase 0 admin endpoint를 함께 포함한다.
FastAPI 공통 schema 기준은 `backend/app/schemas/common.py`에 두며, 각 Pair는 도메인별 schema 파일에서 `CamelModel`, `ErrorResponse`, pagination 관련 schema를 재사용한다.
Demo hydrate endpoint는 live ETL/Catalog API를 가리지 않도록 `/api/demo/etl/jobs`, `/api/demo/catalog/datasets`에 둔다.
Amazon review Kafka replay/ingest 병렬 개발은 `backend/fixtures/kafka/amazon-review-fixture.jsonl` 100건 mock fixture와 `npm run kafka:reviews-fixture`로 `reviews.raw` topic에 표준 JSON fixture를 넣어 시작한다. fixture를 다시 만들 때는 `npm run kafka:reviews-fixture:generate -- --count 100`을 사용한다. 실제 Amazon review JSONL/JSONL.gz 파일은 `npm run kafka:reviews-replay -- --input <path> --limit 100 --rate 100`으로 같은 메시지 계약에 맞춰 replay한다. `npm run kafka:reviews-loop -- --rate 2 --max-messages 500`는 cycle별 고유 event ID와 증가 offset을 갖는 Continuous 검증용 입력을 만든다. topic 재생성은 `--recreate-topic`을 명시한 경우에만 수행한다. 배포 환경은 `GET|POST|DELETE /api/etl/kafka/replay-producer`로 한 개의 producer subprocess를 관리하며, 대용량 파일은 `ASKLAKE_REPLAY_INPUT_DIR` mount 아래 상대 `inputPath`로만 지정한다. 이 스크립트는 Kafka 입력 계약 검증과 replay를 담당하며, Lake 적재 로직은 별도 ingest 작업 범위다.
Kafka Source Preview와 Snapshot bridge는 공통 KafkaJS Snappy codec을 등록한다. Source Preview는 최소 샘플/idle/settle bound로 실제 payload를 반환하고 consumer decode/run 오류를 metadata-only 성공으로 바꾸지 않는다. `GET /api/etl/sources/defaults`는 backend의 비밀이 아닌 Kafka broker/topic과 S3 bucket/prefix runtime 기본값을 새 Source draft에 제공한다. `ASKLAKE_VERIFY_KAFKA=true npm run verify:fastapi-sources`는 이 기본값 계약과 3건의 임시 Snappy 토픽 `event_id` schema/sample까지 검증한다.
Production Spark 공유 경로는 `spark-runtime-guard`가 매 daemon restart마다 기존 데이터를 보존하면서 초기화한다. worker는 UID 185 write/read/atomic rename/delete, backend는 report readiness read를 각각 startup probe로 확인한다. `npm run verify:spark-runtime-paths`, `npm run verify:spark-runtime-paths:container`, `npm run verify:production-spark`가 이 경계를 검증하며 실패 로그는 `runtime_storage_unwritable` 등 path·expected/actual metadata가 있는 JSON code를 사용한다. deploy 관련 PR은 GitHub Actions `Deploy Readiness`가 Node 22/Python 3.13에서 production Compose render, backend/frontend deploy image build, backend production dependency 준비, repository Spark runtime contract를 실행하고 JSON release-readiness artifact를 남긴다. 이 CI gate는 EC2 deploy 또는 long-running Spark/Kafka 실행을 수행하지 않는다.

Continuous publication은 `output -> manifest -> Catalog -> Dashboard` 단계로 분리되어 있다. output/manifest 외부 검증 뒤 Catalog를 독립 commit하고 Dashboard revision 또는 zero-row progress를 별도 commit한다. 같은 batch/run/manifest fingerprint의 재시도는 기존 Iceberg output과 Catalog Run을 재사용하며, Dashboard 실패는 적재 성공을 data loss로 바꾸지 않는다. 최신 단계 진단은 기존 runtime metrics의 bounded `publicationWorkflow`에 저장되고 공개 API·DB schema는 그대로 유지한다. 구현·복구 기준은 [Continuous Materialization·Catalog·Dashboard 발행 계약](./refactor-2026/contracts/continuous-publication-workflow.md)을 따른다.

배포 readiness의 현재 관찰 기준은 [배포 파이프라인 Phase 0 기준선](./deployment-phase-0-baseline.md)에 기록한다. Compose health와 API JSON health, Spark driver 상태, Kafka Continuous session heartbeat는 별개로 확인한다. request/worker hot path의 schema DDL 경쟁 제거와 자동 release gate는 아직 후속 Phase 범위다.

Rule/target 변경의 빠른 검증은 `npm run verify:dataset-identity`, `npm run verify:rule-compiler`, `npm run verify:snapshot-rule-conformance`, `npm run verify:spark-schema-contract`, `npm run verify:snapshot-spark-pipeline`, `npm run verify:kafka-target-projection`, `npm run verify:target-mode-contract` 순서로 실행한다. `verify:dataset-identity`는 서로 다른 한글/slug-collision target의 Job·dataset ID 분리와 정확히 같은 target의 append 재사용을 격리 SQLite metadata DB에서 확인한다. `verify:snapshot-rule-conformance`는 같은 JSON fixture를 Node Kafka runtime과 실제 Spark 4 DataFrame runtime에 적용해 실행 의미의 동등성을 확인한다. Spark schema contract는 필수 컬럼별로 원본을 다시 읽지 않고 하나의 집계 action으로 input row count와 모든 null/cast 실패 컬럼을 함께 식별한다. JSON/JSONL runtime은 승인된 source path로 명시적 reader schema를 구성해 schema inference scan을 만들지 않고 dotted nested path를 target alias로 펼친다. projected source와 지원되는 row-preserving transform 선두 prefix는 run 전용 Parquet에 한 번 기록하고, schema, Rule/Quality, sample, write는 그 staged DataFrame을 기준으로 실행한다. 전체 frame은 executor cache에 persist하지 않으며 `sparkResources.cacheStorageLevel=NONE`, `materializationMode=run_scoped_parquet_staging`, `outputFrameCacheMode=staged_parquet_reuse`를 기록한다. 같은 Spark type의 identity cast·copy·rename과 승인된 row-preserving SQL 선두 prefix는 staging 전에 적용하고 `preMaterializedTransformCount`로 남긴다. 현재 Snapshot의 raw source read 예산은 전체 pipeline에서 정확히 1회이며 `verify:snapshot-spark-pipeline`이 실제 JSONL `FileScanRDD` 로그, staged file 생성, success·quality failure·schema exception cleanup을 회귀 검증한다. 실제 AWS 개발 S3 smoke는 `ASKLAKE_VERIFY_S3_STAGING_LIVE=true`, `ASKLAKE_VERIFY_S3_STAGING_BUCKET`, `AWS_REGION`을 명시한 `npm run verify:spark-s3-staging`으로 opt-in한다. 이 smoke는 고유 `asklake-validation/issue-931/<run>/`에서 같은 Spark runtime의 S3A read/materialize/publish를 확인하고 현재 객체와 version/delete marker를 모두 residue 0으로 정리하지만 EKS SparkApplication 실행을 대신하지 않는다. 직접 컬럼 복사와 `TRIM(CAST(<input> AS STRING))`으로 한정한 row-preserving SQL transform은 이전 row count를 재사용해 규칙별 validation `count()`를 만들지 않으며, conformance test가 9개 규칙에서도 추가 count action 0을 확인한다. type-changing transform과 일반 SQL은 기존 검증을 유지한다. legacy Quality rule도 rule별 `filter().count()` 대신 전체/규칙별/union 실패 수를 하나의 aggregate action으로 계산한다. Kafka Snapshot Job bridge는 확정 schema와 compiler output schema를 전달하고 Iceberg target/Catalog schema를 동일 projection으로 생성한다. `npm run verify:kafka-review-scheduled-ingest`는 실제 Job create/command와 direct JSONL compatibility를 end-to-end로 검증하고, 실제 Job의 Iceberg/Catalog/offset 및 retry idempotency는 `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg`로 검증한다.

canonical Quality가 보존한 evaluated/drop/quarantine counter가 유효하면 최종 `outputRows`도 같은 근거에서 계산하고 중복 final `count()`를 생략한다. counter가 누락·손상되면 기존 Spark count로 돌아가되 raw source lineage가 아니라 staged Parquet를 다시 읽는다. `quality.outputRowCountSource`가 실제 선택 경로를 durable manifest에 남긴다.

## 2. Pair A Live Contract

Pair A 생성 요청은 nested `draftPipeline`을 submit 직전에 flat `CreatePipelineRequest`로 변환한다.

Frontend baseline은 `VITE_USE_MOCK_API`가 미설정이면 live mode로 동작한다. frontend-only mock QA가 필요할 때는 `VITE_USE_MOCK_API=true`를 명시하며, 이때 `frontend/src/services/sourceConnectorService.ts`는 backend 호출 없이 source type별 mock `SourceConnectorAnalysis`를 반환한다.

필수 create payload:

- Source: `sourceType`, `sourceLabel`, `sourceConfig`
- Schema: `schemaColumns`, `schemaSampleRows`, `schemaSummary`, `schemaFingerprint`
- Rule: `ruleContractVersion`, canonical `rules`, compiler `transformOutputColumns`
- Snapshot runtime: canonical Rule 재compile, Spark/Kafka 공통 disposition, write 전 Fail Batch, physical quarantine evidence
- Legacy execution compatibility: `transformSteps`, `qualityRules`, `qualityScore`, `qualityStatus`, `qualityInvalidRows`
- Schedule/Permission/Target: `scheduleLabel`, `scheduleSummary`, `startDate`, optional `endDate`, `nextRunUtc`, `overlapPolicy`, `timezone`, `watermarkPolicy`, `retryPolicy`, `retryPolicySummary`, `runLimitSummary`, `owner`, `permissionSummary`, `targetDataset`, optional `targetDatabase`, `targetDescription`, `targetTags`, `targetLayer`, `targetFormat`, `storageType`, `storagePath`, `partition`, `partitionColumns`, `indexColumns`, `compression`

Schema type은 새 payload에서 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON`을 사용한다. 기존 `Float`는 읽기 호환하며 새 draft에서는 `Double`로 canonicalize한다. `sourceName`은 dotted source path를 그대로 유지하고 `targetName`만 물리 alias로 정규화한다. 사용자가 target 타입을 바꾸면 optional `sourceType`이 원본 타입을 보존하며, 기존 payload는 `sourceType`이 없을 때 `type`으로 fallback한다.

Schedule UI는 `직접 실행`, `반복 실행`을 사용하며 `직접 실행`을 payload의 `스케줄링 건너뛰기`로 저장한다. 즉시 실행은 스케줄 생성 옵션이 아니라 기존 Job command API의 `run` action으로 분리한다. 반복 실행을 선택한 때만 반복 주기, 실행 시각, IANA `timezone`, 겹침 처리를 노출하고, 재시도 설정은 사용 여부에 따라 상세 필드를 표시한다. `startDate`, 빈 값이면 종료일 없음으로 처리하는 `endDate`, watermark 수집 기준, 2배 지수 백오프 재시도 정책은 생성 payload와 Job hydrate 응답에 보존한다. 기본 겹침 처리는 `skip_if_running`이다. 현재 배치 Run 취소는 `cancelRun`으로 분리한다. 반복 예약 일시중지는 스케줄 설정을 보존하는 `stopSchedule`, 복원은 `resumeSchedule`을 사용한다. 실행 중인 실시간 Job의 `stopSchedule`은 UI에서 `수집 중지`로 표시하고 현재 Run을 `canceled`로 종료한다. 실시간 Job의 `수집 시작`은 `run` 또는 실패 후 `retry`로 실제 새 Run을 시작한다.

Target metadata는 Review에서 보이는 값과 create payload, Spark run 성공 후 Catalog dataset metadata가 같은 값을 사용해야 한다. `partition`은 기존 호환 문자열로 유지하고, 실제 선택 컬럼 목록은 `partitionColumns`에 보존한다.

새 ETL Job의 `icebergTarget`은 frontend payload가 아니라 backend가 생성한다. `etl_jobs.iceberg_target` JSON은 `catalog`, `namespace`, stable `table`, `writeMode`, `partitionColumns`, 계산된 `tableUri`를 보존하고 Job response와 Spark payload에 전달한다. 기존 row의 null 값과 `storagePath`는 읽기 호환하며 첫 일반 batch 실행 전에 target을 backfill한다. 일반 Spark, Kafka Snapshot과 Kafka Continuous writer는 native Iceberg commit과 `$snapshots`/`$files`/`DESCRIBE` 검증 뒤 Catalog를 `available`로 확정한다. Job identity가 없는 direct ingest만 legacy object 계약을 유지한다.

Backend create response:

```ts
type CreateJobResponse = {
  job: JobRowData;
  catalogTarget: {
    id: string;
    name: string;
    layer: string;
    status: "pending_run";
  };
};
```

Job append identity는 저장된 `targetDataset` 표시명의 정확한 일치를 기준으로 판정한다. 새 dataset의 내부 ID는 안전한 소문자 ASCII 이름에는 `ds_<name>`을 유지하고, 한글·공백·특수문자·대소문자 변환처럼 ASCII slug에서 정보가 손실되면 원문 기반 12자리 안정 해시 suffix를 붙인다. 자동 storage prefix/checkpoint도 같은 충돌 방지 key를 사용한다. 서로 다른 표시명이 같은 slug로 축약돼도 기존 Job이나 자동 저장 경로를 공유하지 않아야 하며, frontend는 create/polling 응답을 `job.id` 기준으로 upsert해 동일 ID를 여러 목록 행으로 보존하지 않는다.

Backend command response:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job: JobRowData;
  run?: JobRunSummary;
  dagSteps?: JobDagStep[];
};
```

Backend update response:

```ts
type UpdatePipelineResponse = JobRowData;
```

수정 API는 source config를 받지 않으며 `manage` 권한을 확인한다. 실행 중인 Job과 성공 Run 이후의 target identity 변경을 차단하고, Kafka offset/snapshot state를 변경하지 않는다.

## 3. Metadata Persistence

Local backend metadata source of truth는 `DATABASE_URL`이 가리키는 Postgres다. 기본값은 `docker-compose.yml`의 `postgres://asklake:asklake_dev@127.0.0.1:54328/asklake`이다.

현재 backend는 API response shape를 유지하기 위해 아래 테이블에 JSONB payload를 저장한다.

- `etl_jobs(id, payload, created_at, updated_at)`
- `catalog_datasets(id, payload, created_at, updated_at)`
- `sql_runs(id, dataset_id, query, payload, created_at)`

`npm run verify`와 `npm run verify:spark-run`은 격리된 검증을 위해 spawned backend에 `ASKLAKE_RESET_METADATA_ON_START=true`를 주고 ETL/Catalog/SQL metadata를 비운 뒤 시작한다. 일반 `npm run dev`는 이 값을 주지 않으므로 생성한 Job과 Dataset이 서버 재시작 후에도 유지된다.

현재 demo에서는 Spark 재실행을 위해 job payload에 `sourceConfig`를 함께 저장한다. 실제 credential 저장 정책은 아직 별도 secret manager로 분리되지 않았으므로, 운영 전에는 credential redaction/secret reference 모델을 확정해야 한다.

## 4. Source Credential Handling

Backend connector 응답은 secret field를 redacted value로 내려준다. 프론트는 응답 metadata, schema, sampleRows는 반영하되 브라우저 세션에 사용자가 입력한 credential 값은 다음 connector 호출을 위해 유지해야 한다.

적용 기준:

- 첫 연결 테스트 성공 후 Schema 단계의 다시 확인이 credential 없이 실패하면 안 된다.
- 샘플 범위 변경 재호출도 같은 credential을 유지해야 한다.
- PR 본문, 로그, 문서에는 실제 credential 값을 쓰지 않는다.

## 5. Airflow-Orchestrated Run Path

`POST /api/etl/jobs/{jobId}/commands`는 run/retry 요청을 Airflow DAG Run으로 제출하고, `queued` 또는 `running` 상태의 run을 즉시 저장/응답한다. Backend는 기본 5초마다 active Snapshot Run을 Airflow와 동기화해 DB에 저장한다. PostgreSQL advisory lock으로 여러 backend process 중 하나만 한 cycle을 실행하고, Job별 transaction으로 오류를 격리한다. 프론트는 명령 응답을 먼저 Run History와 DAG modal에 반영한 뒤 `GET /api/etl/jobs/statuses` 한 요청으로 모든 active Snapshot Job의 저장된 상태를 확인한다. Terminal 상태(`success`, `failed`, `canceled`)가 되면 해당 Job은 다음 요청 대상에서 제외된다. Jobs 화면을 닫아도 backend 동기화는 계속된다.

현재 local `docker-compose.yml`에는 Postgres/MinIO와 함께 Airflow API server, scheduler, DAG processor, Airflow metadata Postgres가 포함되어 있다. `airflow/dags/asklake_etl_job.py`는 독립 smoke mode와 실제 Spark execution mode를 함께 지원한다. Airflow 설정이 없으면 backend는 `AIRFLOW_CONFIG_MISSING` 503 error envelope로 실패한다.

필수 Airflow 환경변수:

- `AIRFLOW_API_BASE_URL`: Airflow public API base URL, 예: `http://127.0.0.1:8081`
- `AIRFLOW_DAG_ID`: stable DAG id, 기본값 `asklake_etl_job`
- `AIRFLOW_UI_BASE_URL`: Airflow UI link 생성용 optional base URL
- `AIRFLOW_API_TOKEN` 또는 `AIRFLOW_USERNAME`/`AIRFLOW_PASSWORD`: Airflow API 인증
- `AIRFLOW_REQUEST_TIMEOUT_SECONDS`: API timeout, 기본값 `10`
- `AIRFLOW_RUN_SYNC_INTERVAL_SECONDS`: backend가 active Snapshot Airflow Run을 DB에 동기화하는 간격, 기본값 `5`, 허용 범위 `1~60`
- `AIRFLOW_EXECUTION_API_TOKEN`: Airflow task가 FastAPI internal Spark endpoint를 호출할 때 사용하는 shared bearer token. Airflow/FastAPI 양쪽 값이 같아야 한다.
- `AIRFLOW_INTERNAL_BASE_URL`, `AIRFLOW_INTERNAL_TOKEN`, `AIRFLOW_INTERNAL_TIMEOUT_SECONDS`: 기존 단일 호출 internal endpoint 호환 설정. 신규 DAG는 execution bearer endpoint를 우선 사용한다.

일반 배치 `run`/`retry`는 `executionMode=spark`로 DAG를 시작한다. `spark_process_write`가 FastAPI internal endpoint를 호출하면 FastAPI가 persisted Job/Run/Airflow identity를 확인하고 PySpark runner를 실행한다. Airflow에는 Docker socket과 MinIO credential을 직접 제공하지 않는다. Production backend도 Docker socket/CLI 없이 Spark Standalone REST create/status/kill API를 사용하며, `APP_ENV=production`에서 Docker runner 설정은 configuration error로 차단한다. `executionMode=smoke`는 backend 없이 DAG 성공/강제 실패만 검증할 때 사용한다.
`publish_run_result`는 성공 Spark manifest와 실제 Parquet를 검증한 뒤 Catalog dataset/materialization을 transaction으로 저장한다. Airflow terminal state만 성공이고 같은 `runId`의 Catalog evidence 또는 기존 persisted Spark result가 없으면 backend가 Run을 실패로 보정한다.

Spark runner 입력:

- File / S3 단일 파일과 Data Lake: object path를 Spark source로 직접 사용
- File / S3 prefix: 저장된 canonical prefix를 Spark 실행 시 재귀 열거하고 Preview와 같은 규칙으로 비데이터 파일을 제외한 모든 호환 파일을 읽는다. Job에는 개별 파일 배열을 저장하지 않는다.
- CSV source와 source inspect: Spark reader에 `quote="`, `escape="`를 명시해 quoted comma와 doubled quote를 RFC 4180 field로 보존
- Target S3 picker: `ASKLAKE_SPARK_OUTPUT_BUCKET`과 `S3_ALLOWED_BUCKETS`를 합친 bucket만 선택 가능하며 writer output bucket을 첫 번째로 반환한다. prefix 조회는 backend AWS SDK v3 `ListObjectsV2`에서 처리한다. AWS mode에서 두 설정이 모두 비면 local fallback을 쓰지 않고 `503`으로 실패한다. 프론트에는 AWS credential을 넣지 않는다.
- Object storage mode: local root Compose는 MinIO endpoint/static local credential/path-style을 사용한다. EC2 prod Compose는 실제 AWS S3만 사용하고 MinIO service나 static AWS key를 포함하지 않는다. Backend/Spark/DuckDB/Trino result storage가 EC2 instance profile IAM Role/default credential chain을 공유한다. 일반 ETL `spark_job_run.py`를 포함한 Spark entrypoint는 공통 provider-aware S3A builder를 사용한다. AWS Spark REST 실행은 MinIO credential resolution을 호출하지 않으며, MinIO REST 실행에서만 worker가 상속한 application credential 일치를 검증한다. `TRINO_ENABLED=false`에서는 Raw/Output readiness만 필요하고, `true`에서는 사전 생성한 Warehouse와 Query Result bucket의 read/write/delete readiness도 통과해야 backend와 Trino worker가 시작된다. Production frontend Target 기본값은 `ASKLAKE_SPARK_OUTPUT_BUCKET`에서 주입하며, 저장된 legacy `s3a://asklake-output/...` 경로는 실행과 Catalog 확정 시 현재 Output bucket으로 정규화하되 명시적인 custom bucket은 보존한다.
- Target DB picker: `TARGET_DATABASES` 또는 `ASKLAKE_TARGET_DATABASES` allowlist를 서버에서 읽어 허용 DB만 내려준다.
- PostgreSQL Snapshot connector: Preview scope와 무관하게 선택 base table 전체를 repeatable-read cursor로 배치 export한 Run 전용 JSONL을 Spark source로 사용. `ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS`는 메모리 batch 크기이며 전체 행 상한이 아니다.
- REST/MongoDB 등 나머지 connector source: bounded schema sample rows를 JSONL로 기록한 뒤 Spark source로 사용
- connector sample JSONL은 `ASKLAKE_SPARK_REPORT_DIR`에 쓰고 Spark submit/master/worker 모두 `ASKLAKE_SPARK_REPORT_CONTAINER_DIR` 기본값 `/work/reports`로 같은 host directory를 mount해야 한다. worktree가 바뀌면 Spark container는 mount source가 달라지므로 자동 재생성되어야 한다.
- `ASKLAKE_SPARK_TRANSFORM_STEPS`: create payload의 transform steps
- `ASKLAKE_SPARK_QUALITY_RULES`: create payload의 quality rules
- `ASKLAKE_SPARK_PARTITION_COLUMNS`: Target에서 선택한 다중 파티션 컬럼을 `/` 구분 문자열로 전달하며 Spark writer가 순서대로 `partitionBy`에 적용

Spark runner 결과:

- Text structuring `one_of_values` execution must record whether each column used `selected_model`, `auto_model`, `fallback_rule`, or `missing_model`. Model artifacts stay in the model registry (`/api/catalog/models`), while transformed rows stay as Catalog datasets/materialization runs.

- transformed Parquet output
- 선택된 컬럼이 있을 때 다중 partition directory를 포함한 Parquet output
- output schema
- input/output file count와 byte/row count
- quality summary
- run status
- DAG step status

Airflow sync 결과:

- `JobRunSummary.airflowDagId`, `airflowDagRunId`, `airflowRunUrl`, `airflowState`
- `JobRunSummary.taskStates`, `lastSyncedAt`, `syncError`
- `JobRunSummary.taskStates.sparkResult`: input/output rows, logical Iceberg outputPath, `icebergCommit`, schema, quality, Spark failure stage/error manifest
- selected run 기준 `dagStepsByRunId`

### Phase 3 Catalog reconciliation target

Status: contract, FastAPI backend implementation, real-mode Airflow DAG call, Catalog route-owned hydrate, and live end-to-end verification are complete on the current branch.

`publish_run_result`는 `POST /api/internal/airflow/spark-runs/{runId}/catalog`를 호출한다. FastAPI는 bearer token과 저장된 Job/Run/Airflow identity를 다시 검증하고 `taskStates.sparkResult`에서만 실행 결과를 읽는다. 일반 Spark batch는 persisted target과 reported snapshot/fingerprint가 Trino table/snapshot/data-file evidence와 일치한 경우에만 Catalog dataset을 create/upsert한다. EKS bounded fixture는 같은 Iceberg 검증 경로에서 RDS Run의 `expectedCount`와 exact snapshot의 `_asklake_run_id=runId` 행 수까지 비교한다.

Transaction boundary:

- target dataset id는 `job.dataset_id`를 사용한다.
- 같은 `runId`의 `materializationRuns` 항목은 append가 아니라 replace되어 하나만 남는다.
- 서로 다른 성공 Run은 같은 dataset row의 history에 누적한다. 일반 full-refresh Run은 snapshot, Kafka 추가분은 delta로 기록하고 rows/bytes/latest/sourceRunId는 최신 snapshot과 그 이후 delta만 기준으로 다시 계산한다.
- target dataset row를 lock한 상태에서 payload를 read-modify-write한다.
- first create race는 dataset id/name unique constraint로 한 row만 허용하고 충돌한 요청이 그 row를 다시 읽어 run-keyed update를 적용한다.
- Catalog payload와 성공 `taskStates.catalogResult`를 같은 transaction으로 commit한다.
- physical output 또는 Catalog 저장 실패 시 partial Catalog write를 rollback한다.

Failure/recovery boundary:

- Spark failure는 `spark_process_write`에서 DAG를 실패시키며 Catalog endpoint를 호출하지 않는다.
- Catalog 실패는 검증된 Iceberg snapshot과 `sparkResult`를 남긴 채 `publish_run_result`를 실패시킨다. Spark commit 직후 report 확정 실패는 이전 snapshot으로 rollback한다. 실패 `catalogResult`에는 `runId`, `datasetId`, compact error, failed timestamp를 남긴다.
- `publish_run_result`는 30초 간격으로 최대 2회 재시도하며, 같은 Airflow DAG Run의 persisted manifest로 Catalog만 최대 3회 시도하고 Spark를 다시 실행하지 않는다.
- commit 뒤 response가 유실돼도 retry는 기존 성공 `catalogResult`를 읽어 같은 success를 반환한다.
- Catalog commit 전에는 Airflow DAG Run과 AskLake Run을 최종 `success`로 간주하지 않는다.
- polling sync는 Airflow 응답 뒤 Run row를 refresh/lock하고 task snapshot을 저장해 동시 commit된 Spark/Catalog evidence 유실을 막는다.
- Job status poller는 Catalog를 조회하지 않는다. Catalog·SQL·AI route의 domain loader가 진입 시 `GET /api/catalog/datasets`를 조회한다.

Phase 3 acceptance checks:

- real Spark success 뒤 dataset row 1개, materialization 1개, exact outputPath, Parquet format, positive byte size, manifest schema/quality, 3-node lineage
- 같은 reconciliation 2회 호출 뒤 같은 `runId` history 1개
- 두 번째 성공 Run 뒤 dataset row 1개와 서로 다른 history 2개
- Spark failure 뒤 Catalog 무변경
- injected Catalog failure 뒤 physical output 유지, `publish_run_result`/AskLake failure, partial Catalog 무변경
- failed final task retry 뒤 Spark output 추가 생성 없이 Catalog success
- browser에서 전체 새로고침 없이 Catalog 목록/lineage 확인

## 6. 검증 명령

Backend:

```powershell
cd backend
npm run verify
npm run verify:airflow-catalog-wiring
npm run verify:airflow-smoke
npm run verify:airflow-spark
PYTHONPATH=. .venv/bin/python scripts/verify-airflow-catalog-reconciliation.py
npm run verify:fastapi-pair2
npm run verify:permission-dataset
npm run verify:permission-job-dashboard
npm run verify:fastapi-etl-catalog
npm run verify:rule-compiler
npm run verify:trino-query-foundation
npm run verify:query-engine-registration
npm run verify:trino-query-history
npm run verify:trino-result-storage
npm run verify:trino-collector-resilience
npm run verify:trino-submission-guard
npm run verify:continuous-runtime-contract
npm run verify:kafka-continuous-contract
npm run verify:kafka-continuous-rules
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py
PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_commands tests.test_etl_job_delete -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_write_commands -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_airflow_execution_commands -v
PYTHONPATH=. .venv/bin/python -m unittest tests.test_source_connector_gateway -v
npm run verify:sources
npm run verify:spark-run
npm run verify:record-parsing
npm run verify:record-parsing:e2e
```

FastAPI Pair2 smoke:

- `npm run verify:fastapi-pair2`는 `orders_clean` demo dataset을 seed한 뒤 별도 포트에서 FastAPI를 띄운다.
- Catalog 목록/상세/lineage, legacy DuckDB compatibility snapshot, SQL read-only guard, derived dataset 생성/재조회/lineage를 한 번에 확인한다. Trino 전용 lifecycle은 `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`가 분리 검증한다.
- 기본 포트는 `18084`이며 `ASKLAKE_FASTAPI_SMOKE_PORT`로 바꿀 수 있다.
- 이미 실행 중인 FastAPI를 대상으로 볼 때는 `ASKLAKE_FASTAPI_SMOKE_START_SERVER=false`와 `ASKLAKE_FASTAPI_SMOKE_BASE_URL`을 지정한다.
- `npm run verify:permission-dataset`는 권한 없는 viewer의 dataset 목록/상세/legacy DuckDB 실행 차단, user grant에 따른 view/query 허용, group grant에 따른 detail 허용, `delete` grant의 materialization-run 삭제 허용을 검증한다. Trino Query Run에도 같은 `query` enforcement를 적용한다. 기본 포트는 `18087`이며 `ASKLAKE_PERMISSION_DATASET_PORT`로 바꿀 수 있다.
- `npm run verify:trino-query-history`는 현재 user ID/name filter가 다른 사용자의 run을 반환하지 않는지 확인한다. `verify:trino-submission-guard`는 actor별 idempotency와 concurrent slot reservation을 실제 PostgreSQL session 경합으로 검증한다.
- `npm run verify:trino-production-readiness`는 `TRINO_ENABLED=true` production 배포에서 TLS/auth, query identity의 read-only 정책, materializer CTAS/`DESCRIBE`/drop, AWS S3 Warehouse/Query Result bucket round trip을 instance profile로 확인한다.
- `npm run verify:permission-job-dashboard`는 권한 없는 viewer의 Job command, Dashboard 목록/runtime/title/draft/delete 차단과 user grant 변경 후 즉시 허용되는 흐름을 검증한다. 기본 포트는 `18088`이며 `ASKLAKE_PERMISSION_JOB_DASHBOARD_PORT`로 바꿀 수 있다.
- `npm run verify:airflow-smoke`는 실행 중인 Airflow API에서 `asklake_etl_job` 발견, import error 0건, smoke 성공 Run의 4개 task 성공, `forceFail` Run의 `spark_process_write` 실패를 확인한다. 기본 API는 `http://127.0.0.1:8081`이며 `AIRFLOW_*`와 `ASKLAKE_AIRFLOW_SMOKE_*` 환경변수로 바꿀 수 있다.
- `npm run verify:airflow-catalog-wiring`은 Airflow runtime 없이 실제 mode의 Catalog endpoint 경로, bearer token, `jobId` body, 최소 XCom 결과, smoke 우회, Run identity mismatch, Catalog HTTP 실패 전파를 확인한다.
- `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:spark-iceberg-batch`는 고유 일반 batch table의 최초 replace, 재실행 replace, 기존 snapshot 위 Quality `Fail Run`의 commit 부재와 snapshot 수/row 불변, commit 후 강제 실패 rollback, rollback 뒤 재commit, current main ref와 exact historical snapshot의 file/byte summary를 실제 Spark 4/MinIO/PostgreSQL/Trino로 확인한다.
- `ASKLAKE_VERIFY_ICEBERG_LIVE=true npm run verify:kafka-snapshot-iceberg`는 격리 Redpanda topic의 fixed offset range를 고유 Iceberg table에 append하고, Catalog 뒤 offset 직전 강제 실패, 같은 snapshot retry/reuse, 단일 materialization, 후속 0건 Run을 확인한다.
- `npm run verify:airflow-spark`는 ETL Job 생성, Airflow 비동기 접수, authenticated FastAPI internal execution, 실제 PySpark 2행 처리, MinIO Parquet object, terminal Run/task/Spark manifest 동기화를 확인한다. `ASKLAKE_FASTAPI_ETL_EXPECT_SPARK_FAILURE=true`를 주면 Quality `Fail Run`의 Spark/Airflow/AskLake 실패 전파를 검사한다.
- `npm run verify:fastapi-etl-catalog`는 같은 script의 기존 호환 이름이다. Airflow URL이 없으면 내장 mock 계약을 확인하고, 실제 Airflow URL을 사용하면 Spark 성공 뒤 `catalogResult`, Catalog dataset, materialization, physical size, lineage까지 검사한다.
- `npm run verify:etl-lineage`는 text source 하나가 `text`, `sentiment`, `severity`로 파생되는 경우 source node가 `text`만 갖고 one-to-many transform edge를 만들며 `_asklake_*` metadata에 가짜 source edge를 만들지 않는지 확인한다. 또한 Parquet source를 `SOURCE · PARQUET`, Spark Job을 `PROCESS · SPARK`, 현재 Spark physical output을 요청 포맷과 무관하게 실제 `PARQUET` engine으로 표시하는지 검증한다.
- `npm run verify:rule-compiler`는 공통 JSON fixture로 Python FastAPI와 local Node backend의 version/policy/parameter 판정을 비교하고, canonical Rule 생성·수정·조회 영속성 및 legacy fallback까지 확인한다. 프론트는 `cd frontend && npm run verify:rule-compiler`로 같은 fixture와 falsy/null parameter 왕복을 검증한다.
- `npm run verify:continuous-runtime-contract`는 Continuous command 전이, desired/observed/public 상태 projection, command revision, active worker fencing, legacy row hydrate와 구조화된 단계 오류를 backend/frontend에서 함께 검증한다. canonical owner와 복구 근거는 `docs/refactor-2026/contracts/runtime-state-ownership.md`에 고정한다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_continuous_application_use_cases -v`는 command intent가 worker side effect보다 먼저 commit되는지, start 응답 유실을 중복 submission 없이 복구하는지, 재부팅·report 지연·terminal intent·stale worker report를 동일 reconciliation policy로 판정하는지 검증한다. 공개 endpoint와 DB shape는 유지하며 application 경계는 `docs/refactor-2026/contracts/continuous-command-reconciliation.md`에 고정한다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_runtime_io_ports -v`는 Node bridge timeout/error, runtime JSON 상태·atomic write, object manifest pagination과 fake adapter 주입을 실제 Node/Docker/S3 없이 검증한다. ETL service는 기존 facade를 유지하며 상세 경계는 `docs/refactor-2026/contracts/runtime-io-ports.md`에 고정한다.
- `npm run verify:kafka-continuous-contract`는 Continuous config/runtime, Rule payload/fingerprint, Catalog 근거와 checkpoint 불변 정책을 프로젝트 가상환경에서 검증한다. `npm run verify:kafka-continuous-rules`는 Docker Spark 4에서 Transform/Quality, Rule quarantine, replay 재검증, final projection과 checkpoint fingerprint mismatch를 실행한다.
- `ASKLAKE_VERIFY_DASHBOARD_POSTGRES=true npm run verify:dashboard-live-postgres`는 `DATABASE_URL`의 실제 PostgreSQL에 임시 Catalog dataset, revision commit, partition cursor, freshness, widget result를 저장한다. 같은 `run_id` 멱등성, manifest 위치, canonical source range/fingerprint/watermark, 다른 `run_id`의 같은 offset 중복 방지, 부분 겹침 거절, 계산 result/state 재조회를 확인한 뒤 fixture를 삭제한다. repository 테스트는 stream/replay namespace 분리도 확인한다.
- `PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-hydrate-contract.py`는 저장된 Kafka source/schema/rule/permission/target metadata가 `JobRowData` hydrate 응답에서 손실되지 않는지, explicit canonical empty가 legacy Rule을 되살리지 않는지 확인한다.
- `PYTHONPATH=. .venv/bin/python scripts/verify-etl-job-update-contract.py`는 실제 DB session에서 canonical Rule 저장을 확인하고 source config 보존, 성공 Run 뒤 target identity 변경 `422`, 실행 중 update `409`를 검증한다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_commands tests.test_etl_job_delete -v`는 Job 삭제의 권한 선행, active Run·Continuous 보호, 종속 레코드 삭제 순서, audit·commit/rollback과 Airflow/Kafka reservation 동시성을 검증한다. application 경계는 `docs/refactor-2026/contracts/etl-job-command-boundary.md`에 고정한다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_job_write_commands -v`는 일반 Pipeline create의 new/append/continuous 분기와 update의 governance·permission·validation·immutability·projection 순서를 검증한다. 실제 Rule·permission·identity persistence는 인접한 update/create verifier와 함께 확인하며 상세 경계는 `docs/refactor-2026/contracts/etl-job-write-boundary.md`를 따른다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_airflow_execution_commands -v`는 성공 Spark 결과 재사용, active execution lease, runner 실패/finalize, Catalog 멱등성, physical evidence 이후 단일 transaction과 실패 evidence 보존을 외부 runtime 없이 검증한다. 공개 façade와 실제 PostgreSQL reconciliation은 `docs/refactor-2026/contracts/airflow-execution-publication-boundary.md`를 따른다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_source_connector_gateway -v`는 Python request/response schema use case와 Node script·marker·payload·timeout adapter parity를 외부 connector 없이 검증한다. 실제 connector 구현과 기존 오류 transport는 유지하며 상세 권위는 `docs/refactor-2026/contracts/source-connector-authority-boundary.md`를 따른다.
- `npm run verify:record-parsing`은 공백 구분 규칙의 10필드 추론, 타입 추론, 사용자 컬럼명 반영, 필드 개수가 다른 행의 line/count 오류 계약을 FastAPI service 수준에서 확인한다.
- `PYTHONPATH=. .venv/bin/python -m unittest tests.test_etl_service_module_boundaries tests.test_scheduling -v`는 `etl_service.py` 2,500줄 상한, application projection·policy와 API·snapshot·Airflow·source runtime·Continuous·replay fragment의 파일 budget, 역방향 façade import 금지, 기존 공개 함수 re-export/runtime-binding identity와 schedule 동작을 검증한다. 상세 경계는 `docs/refactor-2026/contracts/etl-service-module-layout.md`를 따른다.
- `npm run verify:record-parsing:e2e`는 `s3://m3-raw/asklake-fixtures/txt/click-events-whitespace-100.log`를 실제 Source API로 읽고 Preview 100/100, Job 계약 저장, Airflow/Spark input/output 100행, MinIO Parquet, Catalog의 10개 사용자 컬럼을 확인한다. 실행 중인 FastAPI/Airflow와 올바른 `ASKLAKE_DOCKER_NETWORK`가 필요하다.

Frontend:

```powershell
cd frontend
npm run build
```

Browser smoke:

- backend server를 켠다.
- frontend dev server를 켠다.
- 수집/처리 목록이 처음에는 비어 있는지 확인한다.
- 새 수집/처리 생성에서 Source 연결, Schema 확인, Rule 적용, Review, Create를 진행한다.
- Airflow API가 연결된 상태에서 생성된 Job을 실행한다.
- Run History에 새 run이 즉시 보이고, 선택 Run 실행 흐름이 Airflow DAG Run/Task Instance 상태를 반영하는지 확인한다.
- Airflow terminal 상태 도달 후 polling이 멈추는지 확인한다.

Live Airflow verification through 2026-07-11:

- Airflow metadata database, scheduler, DAG processor health: pass
- `asklake_etl_job` discovery and DAG import error 0건: pass
- `npm run verify:airflow-smoke`: pass, success and forced-failure DAG Runs verified
- live `npm run verify:fastapi-etl-catalog`: pass, queued submit through terminal success and four task states verified
- `npm run verify:airflow-spark`: pass, real PySpark input/output 2 rows and MinIO Parquet verified
- expected Spark Quality failure: pass, `sparkResult`, Airflow DAG Run, AskLake Run/Job all failed
- invalid internal execution token: pass, `401 AIRFLOW_EXECUTION_UNAUTHORIZED`
- FastAPI Catalog reconciliation contract: pass in local PostgreSQL with cleaned unique fixtures, including idempotent same-Run retry, second Snapshot Run replacement, missing output, transaction rollback, stale polling concurrency, and preserved failure evidence
- Python S3 physical inspection against `s3a://asklake-output/customer_review_gold/gold/<run-redacted>`: pass, Parquet 1 object / 3,882 bytes
- Airflow `publish_run_result` -> Catalog endpoint: pass, real Spark/MinIO output published with matching Run id/path, positive bytes, one materialization, and 3-node lineage
- concurrent polling evidence preservation: pass, stale session could not erase committed `sparkResult`
- Catalog route-owned hydrate: Job status 요청과 독립된 Catalog loader 경로 pass. Snapshot 재실행의 현재 행 수는 `verify:materialization-projection`과 갱신된 Catalog reconciliation fixture에서 최신 snapshot 기준으로 검증한다.

## 7. 완료 기준

- ETL/Catalog 초기 목록은 서버가 비어 있으면 빈 상태로 표시된다.
- Source/Schema/Create/Run 흐름에서 seed나 fixture job을 사용자 화면에 표시하지 않는다.
- Source credential은 connector 응답의 redacted config로 덮어쓰이지 않는다.
- Transform/Quality는 summary 문자열만이 아니라 실행 가능한 payload로 create request에 들어간다.
- 일반 Spark Snapshot과 Kafka Snapshot은 같은 canonical fixture 결과를 만들고, `Fail Batch`는 Iceberg target publication 또는 Kafka offset commit 전에 중단된다. Kafka Snapshot은 Iceberg/Catalog 성공 후에만 offset을 확정하며 같은 durable snapshot retry가 table row와 materialization을 중복시키지 않는다.
- Airflow run 후 선택 Run 실행 흐름은 Airflow DAG Run 접수와 Task Instance 상태를 selected run 기준으로 표시한다.
- 실패 상태는 실제 실패 단계와 원인을 표시하고, 고정된 fake failed flow를 보여주지 않는다.

## 8. Catalog/SQL 연결 범위

### Catalog

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 | live mode에서는 `GET /api/catalog/datasets`, mock mode에서는 fixture 표시 | `GET /api/catalog/datasets` |
| 검색/태그/필터 | 프론트 이벤트 로그 중심 | `GET /api/catalog/datasets?q=&tag=&layer=` |
| 상세 | selectedDataset 표시 | `GET /api/catalog/datasets/{datasetId}` |
| 스키마 | dataset.schema 표시 | 상세 포함 또는 `/schema` |
| 샘플 row | 최신 성공 materialization의 실제 row를 총행 수/현재 범위와 함께 page로 표시. 스키마 상세 modal에서도 같은 viewer 사용 | `GET /api/catalog/datasets/{datasetId}/rows?offset=&limit=` |
| 리니지 | `LineageGraph` contract를 React Flow로 렌더링, 없으면 upstream fallback | `GET /api/catalog/datasets/{datasetId}/lineage` |
| SQL로 열기 | SQL 화면 이동 | 없음, datasetId 유지 |

### SQL 분석

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| SQL 점검 | frontend parser는 빠른 오타/식별자 안내를 담당하고, Trino Dataset은 debounced `POST /api/query/validate` 성공 전 실행을 비활성화한다. Trino 확장 문법은 backend parser/compiler가 최종 판정한다. | `POST /api/query/validate` |
| SQL 실행 | `TRINO_ENABLED=true`이면 최대 100행 preview Query Run을 접수하고 durable 상태를 polling한다. `false`/mock만 DuckDB compatibility result를 사용한다. | `POST /api/query/runs`, `GET /api/query/runs/{runId}` |
| 실행 정보 | SQL editor는 기존 높이와 단일 scroll을 유지한다. 평가와 preview의 `쿼리 실행`, `첫 결과 준비` timeline을 결과 panel의 세 번째 view에서 표시한다. 실제 분자/분모가 없으면 progress를 만들지 않는다. | `POST /api/query/estimates`, Query Run response |
| Query AI 생성 | frontend는 선택 Dataset ID와 prompt만 전달하고 context 변경 시 이전 요청을 취소해 stale 응답을 적용하지 않는다. FastAPI가 권한/governance를 확인하고 단일 사용 signed MCP context와 Semantic RAG를 private Gateway에 전달한다. SQL·근거는 검증된 Gateway 응답만 사용하며 명시적 분석 의도 위반은 한 번만 교정 재요청하고 로컬 fallback은 없다. | `POST /api/query/ai-suggestions` |
| ETL transform AI | frontend 공통 credential client가 상대 API 경로로 호출한다. field/SQL transform을 private Gateway에서 생성한 뒤 input relation·metadata column·read-only·위험 함수 guard를 통과한 SQL만 반환하며 mock 성공은 없다. | `POST /api/ai/generate-sql` |
| Base Dataset 변경 | SQL 화면 내부 base dataset 상태를 바꾸고 query/result를 해당 dataset 기준으로 reset | 없음, `datasetId` 유지 또는 SQL context API |
| 참조 테이블 | SQL 화면 내부에서 여러 참조 dataset id를 선택하고 editor context에 표시 | `POST /api/query/runs` payload에 `baseDatasetId`, `referenceDatasetIds`, `query` 포함 |
| 테이블 검색/자동완성 | 검색 사이드바는 접근 가능한 mock dataset을 보여주고, editor autocomplete는 base/reference context의 table/column과 SQL keyword만 후보로 표시 | `GET /api/catalog/datasets?q=` 또는 권한 필터링된 SQL context API |
| SQL 저장 | 현재 SQL 화면에서는 제외 | `POST /api/query/saved` |
| 전체 보기 | 성공한 preview에서 full run을 시작하거나 재사용하고, 준비된 page부터 cursor로 100행씩 조회한다. | `POST /api/query/runs/{previewRunId}/full-results`, `GET /api/query/runs/{runId}/results` |
| 결과 Lake 저장 | DuckDB compatibility는 기존 ETL Job handoff를 유지한다. Trino 결과 화면은 preview에서 SQL recipe만 저장하는 반복 full-refresh SQL Job을 노출하며 full result 저장을 요구하지 않는다. 두 경로 모두 현재 session owner와 선택한 실제 project group ID를 전달하고 고정 demo 그룹을 만들지 않는다. 1회성 Iceberg CTAS API는 별도 운영 경로로 유지한다. | `POST /api/etl/jobs`, `POST /api/etl/sql-jobs`, `POST /api/catalog/trino-runs/{runId}/materializations` |
| CSV 다운로드 | 필요하면 full run을 먼저 시작하고, 완료된 private object page를 backend가 SQL 재실행 없이 stream한다. | `POST /api/query/runs/{previewRunId}/full-results`, `GET /api/query/runs/{runId}/exports/csv` |
| 대시보드 생성 | 후속 Pair C handoff에서 재연결 | `POST /api/dashboards` |
| 새 Lake Dataset 저장 | compatibility 결과만 Preview row 기반 기존 경로를 유지한다. Trino 결과는 page row를 복사하지 않고 반복 `trino_sql_materialization` Job으로 분리한다. | `POST /api/etl/jobs`, `POST /api/etl/sql-jobs` |

한국어 identifier UX는 frontend에서 먼저 방어한다. Dataset/column 표시명은 한국어와 공백을 허용하되, 기본 쿼리·자동완성·컬럼 삽입·JOIN 초안은 double-quoted identifier를 사용한다. 사용자가 따옴표 없이 한글/공백 table reference를 입력하면 preflight가 실행 전에 감지하고 자동 보정 액션을 제공한다. Backend는 이후에도 selected dataset id context를 기준으로 SQL table scope를 재검증한다.

Mock mode에서는 수집/처리 pipeline 생성 dataset과 backend direct SQL derived dataset이 같은 stored catalog dataset fallback(`asklake.catalogDatasets`)을 사용합니다. 현재 SQL 화면의 처리 Job 생성 UI는 direct dataset write 대신 ETL Review draft를 만들고, Review 생성 이후 pipeline 생성 dataset 경로를 사용합니다. SQL Result source로 생성된 mock dataset은 Preview schema, sample rows, sourceRunId, query summary를 Catalog metadata에 보존합니다. 기존 `asklake.derivedDatasets`는 읽기 호환만 유지합니다. Live API mode에서는 localStorage fallback을 쓰지 않고 backend catalog persistence와 `GET /api/catalog/datasets` hydrate를 source of truth로 둡니다. SQL Result 처리 Job은 생성 직후 Job 목록에 먼저 반영되고, run 성공 후 backend가 반환/저장한 Catalog dataset이 hydrate됩니다.

FastAPI Catalog persistence는 `catalog_datasets.payload`를 canonical dataset 계약으로 사용합니다. Spark run 성공으로 생성된 ETL dataset과 SQL derived dataset은 같은 payload shape로 저장하며, payload가 없는 기존 컬럼 기반 row는 목록/상세 조회에서 payload shape로 변환해 읽기 호환만 유지합니다. 두 생성 경로 모두 `size`는 표시용 저장 크기 문자열로 사용하고, 물리 저장 정보는 `storageLocation`, `storageFormat`, `storageSizeBytes`에 둡니다. ETL dataset은 source -> Spark job -> target 기본 `lineageGraph`를 저장하고, SQL derived dataset은 source dataset lineage를 이어받아 source -> derived column edge를 저장합니다. 같은 Job 또는 같은 `targetDataset` 결과는 새 Catalog row를 만들지 않고 `materializationRuns` history에 idempotent하게 누적합니다. 일반 full-refresh는 `snapshot`, Kafka 추가분은 `delta`로 기록하며 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 최신 성공 snapshot과 그 이후 성공 delta만 기준으로 계산합니다.

SQL 실행 백엔드는 반드시 read-only guard를 둬야 합니다. frontend preflight는 사용성 보조이며 backend가 Trino 제출 전에 AST, selected Dataset mapping, 권한과 governance를 재검증합니다. Query Run은 `baseDatasetId`/`referenceDatasetIds`의 검증된 `queryEngineTable`만 physical table로 치환하고 직접 physical reference와 table function을 차단합니다. 결과 행 전체를 frontend에 적재하지 않고 submit 시 고정한 signed-cursor page로 조회합니다. Query AI SQL도 같은 guard와 scope 검증을 통과해야 합니다. lifecycle, retention, materialization 기준은 [Trino Query Run Contract](trino-query-run-contract.md)를 따릅니다.

`TRINO_ENABLED=false` DuckDB compatibility mode는 전체 결과를 `backend/tmp/spark-output/sql-runs/{runId}.parquet`(또는 `LOCAL_LAKE_STORAGE_DIR` 하위)에 저장하고 기존 `offset`/`limit` pagination을 유지한다. 이 snapshot은 Trino full Query Run이나 S3 cursor storage로 해석하지 않는다.

Trino 기본 preview result는 최대 100행을 PostgreSQL inline page로 저장해 S3 업로드를 기다리지 않는다. `전체 보기` 또는 `CSV 다운로드`로 생성한 full run만 private S3-compatible gzip object에 저장하고 PostgreSQL에는 metadata/checksum/manifest를 둔다. 로컬은 MinIO, production은 사전 생성한 AWS S3 Query Result bucket과 EC2 instance profile을 사용한다. collector는 API request와 분리된 lease/generation worker이며 cancel/takeover 뒤 stale worker가 page나 run state를 덮어쓰지 못한다. frontend는 preview page와 full run의 현재 page/cursor history만 유지한다.

Catalog row viewer는 `GET /api/catalog/datasets/{datasetId}/rows?offset=&limit=`로 최신 성공 materialization의 물리 dataset을 DuckDB `COUNT(*)`/`LIMIT`/`OFFSET`로 읽는다. 한 page는 최대 500행이고, dataset `view`와 `query` 권한을 모두 검사한다. Catalog 상세와 스키마 상세 modal은 같은 page viewer를 사용한다.

MinIO/S3-backed Parquet Preview의 query-scoped cache/byte limit은 DuckDB compatibility 경로로만 유지한다. Trino mode는 검증된 Iceberg physical mapping을 사용하며 Spark/Kafka writer가 mapping을 증명하지 못한 Dataset은 `queryEngineStatus=unavailable`로 차단한다.

Pair2 FastAPI 5단계 완료 기준:

## 9. 대시보드

| 기능 | 현재 동작 | 필요한 백엔드 |
| --- | --- | --- |
| 목록 조회 | DB-backed dashboard card 목록 조회, 검색/소유자/태그/정렬/pagination 서버 처리 | `GET /api/dashboards`, `POST /api/dashboards/query` |
| 새 대시보드 생성 | `draft` 상태 dashboard card를 DB에 먼저 저장하고 조회 화면으로 이동 | `POST /api/dashboards` |
| 목록 삭제 | 확인 후 dashboard와 runtime snapshot 삭제 API 호출 | `DELETE /api/dashboards/{id}` |
| Dashboard title 수정 | dashboard card title 수정 | `PATCH /api/dashboards/{id}` |
| Published 조회 | published revision snapshot을 조회. 없으면 빈 runtime 응답 표시 | `GET /api/dashboards/{id}/published` |
| Draft 조회/생성 | 편집 진입 시 draft revision/page 준비 | `POST /api/dashboards/{id}/draft/ensure` |
| Page 추가 | DB-backed draft page 추가 | `POST /api/dashboards/{id}/draft/pages` |
| Page 이름 수정 | DB-backed draft page title 수정 | `PATCH /api/dashboards/{id}/draft/pages/{pageId}` |
| Page 삭제 | DB-backed draft page와 하위 widgets 삭제 | `DELETE /api/dashboards/{id}/draft/pages/{pageId}` |
| 위젯 추가 | selected dataset과 type별 config로 draft widget 생성 | `POST /api/dashboards/{id}/draft/pages/{pageId}/widgets` |
| 위젯 수정 | draft widget title/type/datasetId/config 수정 | `PATCH /api/dashboards/{id}/draft/widgets/{widgetId}` |
| 위젯 삭제 | draft widget 삭제 | `DELETE /api/dashboards/{id}/draft/widgets/{widgetId}` |
| Layout 저장 | drag/resize 종료 시 layout batch 저장 | `PATCH /api/dashboards/{id}/draft/layouts` |
| Publish | 현재 draft revision을 published revision으로 복사 | `POST /api/dashboards/{id}/publish` |
| Dashboard Assistant | DB runtime/catalog 권한 context와 Semantic RAG를 private Gateway에 전달한다. 현재 Dataset을 고정하고 명시적인 시각화 의도 또는 최근 사용자 field/dataset 단서를 참조하는 bounded 후속 실행만 create/update로 분류한다. 502 contract 오류는 mode별 지침으로 한 번 교정 재시도한다. 검증된 action도 draft persistence가 실제 성공해야 적용 성공으로 표시하며, 실패 시 편집 상태를 보존한다. 모델이 실제 사용한 evidence만 반환하고 Gateway/RAG 재실패 시 빈 action의 unavailable/error를 반환한다. | `POST /api/dashboards/assistant` |
| Review analysis | frontend는 deprecated cellphones alias 대신 canonical latest/run/preview endpoint를 사용한다. Gateway schema/row preview, persisted bounded run, provenance·holdout quality gate를 통과한 portable model publication을 제공한다. | `POST /api/review-analysis/schema-suggestion`, `POST /api/review-analysis/preview`, `POST /api/review-analysis/runs`, `GET /api/review-analysis/runs/latest`, `GET /api/catalog/models` |
| Share | 프론트에서 runtime 링크 복사 feedback 표시 | 별도 share API는 현재 없음 |
| 내보내기 | local snapshot JSON 다운로드와 감사 로그 기록 | `GET /api/dashboards/{id}/export` |
| 전체화면/차트 확대 | 프론트 모달 표시 | 백엔드 불필요 |

프론트 dashboard adapter는 FastAPI가 404를 반환하는 이전 backend에서도 화면을 깨지 않도록 local/mock fallback을 유지한다. 현재 병합 기준에서는 FastAPI dashboard endpoint가 우선 source of truth다.

Dataset 기반 widget 생성 API는 `metric`, `table`, `bar_chart`, `line_chart`, `donut_chart` runtime type만 받는다. Backend save/read response는 `frontend/src/types/dashboard.ts`의 type별 config 계약을 보존해야 한다. `datasetId`가 있고 명시적 `data`가 없으면 catalog dataset의 rows 또는 sample rows를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다.

Dashboard runtime service는 실제 `catalog_datasets.payload`를 우선 조회해 `datasetId -> widget.data snapshot`을 만든다. demo catalog는 오래된 demo dataset id 또는 로컬 seed가 빠진 smoke 상황을 위한 fallback으로만 유지한다. 새 ETL/SQL derived dataset은 catalog `schema`와 `sampleRows`를 column name 기반 object row로 변환해 widget `data` snapshot에 저장한다. 로컬 PostgreSQL에서 대시보드 사이드바와 Assistant가 같은 demo 데이터를 보려면 `app.seed.seed_dashboard_demo`로 demo dataset을 `catalog_datasets`에 저장한다.

Kafka Continuous dataset의 published widget은 PostgreSQL `dataset_freshness`, `dataset_revision_commits`, `dataset_kafka_partition_cursors`, `dashboard_widget_results`를 사용한다. Worker는 시작/재개 시 cursor를 받아 쓰기 전에 이미 처리한 offset을 제거하고, partial overlap은 새 suffix만 게시한다. backend는 완료 manifest와 실제 Iceberg commit/source boundary, exact snapshot의 Run 행 수를 Trino로 검증한 뒤 revision을 올린다. topic·partition watermark로 같은 stream offset의 재반영과 부분 겹침을 최종 거절한다. 0행 batch는 revision 없이 watermark만 전진시키며, 종료 report가 축약되거나 ack된 과거 window만 남았으면 S3 완료 manifest 목록으로 publication을 복구한다. stream과 최대 1,000행 단위 quarantine replay는 별도 commit 종류로 관리한다. replay manifest 게시 실패는 새 Iceberg snapshot을 rollback하며, replay의 Catalog 반영 실패 결과는 일반 runtime refresh에서 재조정하고 Catalog 성공 후에만 runtime 카운터를 더한다. 로컬 replay result가 유실돼도 S3 완료 manifest를 `runId`로 직접 복구하고, 미반영 replay가 남으면 start/resume을 `409`로 차단한다. 주기 동기화는 Job별 DB transaction으로 격리한다. `count`/`sum`/`avg` 위젯은 최초 한 번 현재 Iceberg 전체를 baseline으로 계산하고, 이후에는 revision 한 개씩 `_asklake_run_id`로 이번 commit 행만 Trino 조회해 기존 state에 병합한다. legacy/backfill, non-delta commit, revision gap, 내부 run ID가 없는 과거 테이블, 10,000 group 초과에서는 active data 전체 재계산으로 fallback한다. 최근 N분·슬라이딩 시간창은 이번 범위에서 지원하지 않는다. published `/dashboards/{dashboardId}`는 일반적으로 backend 권장값 `clamp(triggerIntervalSeconds * 500, 1000, 60000)`에 dataset ID 기반 0~10% deterministic jitter를 더해 polling한다. partial 계산이 실제 전진했을 때만 250ms catch-up을 사용하고, 무진전·실패 시 일반 주기로 돌아가며 hidden tab에서는 중지하고 이전 결과를 유지한다.
Catalog ACK가 바뀔 때 worker는 전체 manifest 이력을 반복 조회하지 않고 bounded report window에서 승인된 batch를 제거한 뒤 부족한 다음 구간만 채운다. 재시작 복구는 committed manifest bulk read 한 번으로 수행한다. Backend의 S3 manifest 복구는 Spark가 만든 0-byte `part-*` 파일을 건너뛰고 실제 JSON row가 있는 part를 읽는다. 작은 Continuous micro-batch는 `ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS=4`, `ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL=WARN`을 기본으로 사용하며 일반 batch의 shuffle 설정은 유지한다.
Continuous SQL은 새 Job에서 5초 trigger를 기본으로 사용하고, `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS` 이하의 통계가 있는 불변 static snapshot을 Spark memory/disk에 재사용한다. 같은 snapshot·JOIN key의 유일성 scan은 한 번만 수행하고 snapshot 변경 시 cache와 검증 identity를 폐기한다. 새 output table은 `_asklake_run_id` partition으로 exact-count와 Dashboard delta scan을 가지치기하며 기존 table은 기존 partition spec을 유지한다. Trino exact snapshot/행 수 검증은 성능 최적화 후에도 publication 필수 gate다.
`seed_dashboard_demo`에는 커머스 데모용 원본 dataset 2개(`commerce_orders_daily`, `commerce_marketing_spend_daily`)와 조인 결과처럼 보이는 `gold_commerce_channel_roi` GOLD dataset이 포함된다.

Runtime table 보강 코드는 Alembic migration 도입 전까지 로컬 PostgreSQL smoke를 막지 않기 위한 임시 안전장치다. `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`에 `created_at`, `updated_at`, JSON snapshot 컬럼이 빠져 있으면 repository에서 `ADD COLUMN IF NOT EXISTS`로 보강하지만, 장기 운영 기준의 source of truth는 후속 Alembic migration으로 옮겨야 한다.

Dashboard FastAPI 구현은 아래 순서와 파일 경계로 유지한다.

1. Dashboard 계약/schema skeleton 정리: `backend/app/schemas/dashboard.py`
2. Card/List API: 목록, 검색/필터/정렬, 생성, 제목 수정, 삭제
3. Runtime 조회 API: published 조회, draft ensure
4. Draft page API: page 추가/이름 수정/삭제
5. Draft widget/layout/publish API: widget 생성/수정/삭제, layout 저장, publish
6. Frontend adapter E2E: `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts`

Card/List API는 `dashboards`, `dashboard_tags`를 우선 소유한다.
Runtime API는 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`를 우선 소유한다.
두 흐름은 `dashboardId`와 `publishedRevisionId`만 공유하고, published 화면은 draft revision을 직접 읽지 않는다.
Dashboard 삭제 API는 card/list row 삭제와 함께 runtime revision/page/widget snapshot도 삭제한다.

Catalog dataset materialization 보완 기준:

## 10. 아직 실제 저장되지 않는 기능

아래 기능은 현재 UI 반응과 감사 로그만 있고, 서버 저장은 없습니다.

| 영역 | 기능 |
| --- | --- |
| 수집/처리 | 삭제, 상세 수정 저장, 필터 조건 저장 |
| 생성 플로우 | Source 중간 테스트 결과, Schema 승인, Rule 추가/검증 |
| 카탈로그 | 상세/lineage 고도화, 저장소 보관 기준 확정, 태그/필터 서버 검색 |
| SQL | 쿼리 저장, CSV 다운로드 |
| 대시보드 | 권한 기반 공유, 내보내기 API, 장기 운영용 권한/감사 로그 |
| 공통 | 운영 IdP/SSO 연동, session hardening, 외부 감사 저장소 연동 |

Permission/Governance 기준으로, 프로필/만든 사람 표시는 identity metadata 작업이고 실제 권한 판정은 `ActorContext`와 resource별 grant 작업이다. 현재 로컬 auth/session은 계정 actor를 결정하기 위한 demo-grade 구현이며, 외부 IdP/SSO, refresh token, 비밀번호 재설정, 이메일 인증, deny/조건부 정책, auth/permission table Alembic migration은 후속 범위다. ETL Job은 `permission_grants` table을 source of truth로 사용하고 owner에게 자동 전체 권한 fallback을 제공한다. 이름 변경, 그룹 소유, 대리 생성 등 owner 문자열 fallback의 장기 edge case는 운영 identity 연동 시 보완해야 한다.

## 11. 백엔드 팀에 넘길 최소 구현 범위

최소 데모 연동만 목표라면 아래 5개면 충분합니다.

1. `POST /api/etl/jobs`
2. `POST /api/etl/jobs/{jobId}/commands`
3. `GET /api/etl/jobs`
4. `GET /api/etl/jobs/{jobId}`
5. `GET /api/catalog/datasets`
6. `POST /api/query/runs`

대시보드 실제 저장 API는 현재 병합 기준에서 추가되어 있으며 아래 endpoint를 유지합니다.

1. `GET /api/dashboards`
2. `POST /api/dashboards/query`
3. `POST /api/dashboards`
4. `PATCH /api/dashboards/{dashboardId}`
5. `DELETE /api/dashboards/{dashboardId}`
6. `GET /api/dashboards/{dashboardId}/published`
7. `POST /api/dashboards/{dashboardId}/draft/ensure`
8. `POST /api/dashboards/{dashboardId}/draft/pages`
9. `PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`
10. `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
11. `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
12. `PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
13. `DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`
14. `PATCH /api/dashboards/{dashboardId}/draft/layouts`
15. `POST /api/dashboards/{dashboardId}/publish`
16. `POST /api/dashboards/assistant`

## 12. 프론트에서 다음에 할 작업

백엔드 API가 준비되기 전 프론트에서 미리 할 수 있는 작업입니다.

| 순서 | 작업 | 파일 |
| --- | --- | --- |
| 1 | `getJobs`, `getDatasets`, `getDatasetLineageGraph` API adapter 추가 | `frontend/src/services/mockApi.ts` |
| 2 | 초기 hydrate loading/error 상태 추가 | `frontend/src/hooks/useAskLakeData.ts` |
| 3 | dashboard list/runtime adapter와 FastAPI fallback 경로 확인 | `frontend/src/services/mockApi.ts`, `frontend/src/services/dashboardApi.ts`, `frontend/src/services/dashboardRuntimeApi.ts` |
| 4 | audit export/retention 정책 정의 | docs/admin console |
| 5 | 삭제/저장/게시 실패 시 rollback 처리 | `frontend/src/hooks/useAskLakeData.ts`, dashboard page |

## 13. 인수 기준

백엔드 연결이 끝났다고 판단하려면 아래를 통과해야 합니다.

- `.env`에서 `VITE_USE_MOCK_API=false`로 실행해도 앱이 정상 로딩됩니다.
- AI client 요청은 같은 출처 `/api`와 Vite/Nginx proxy를 통해 backend에 도달하고 `VITE_USE_MOCK_API`의 영향을 받지 않습니다.
- 새 수집/처리 생성 후 목록과 카탈로그에 서버 응답 데이터가 표시됩니다.
- 즉시 실행/재실행/일시정지/현재 Run 취소/스케줄 중지 버튼이 서버 상태 전이를 반영합니다.
- SQL 실행 결과는 compatibility mode의 current snapshot page 또는 Trino signed-cursor current page 그대로 표시됩니다.
- Trino 실행 정보는 editor 아래로 튀어나오지 않고 결과 panel의 세 번째 view에서 평가와 timeline을 표시합니다.
- Trino 결과 page를 전체 Query Run 또는 persistent Dashboard source로 저장하지 않습니다.
- 새로고침 후에도 저장된 대시보드/작업/데이터셋이 유지됩니다.
- 실패 응답은 토스트와 감사 로그에 남습니다.
- 콘솔에 React key/layout 관련 error가 없어야 합니다.

## Review Snapshot 연결

- `/etl/review`는 `POST /api/etl/review` 응답을 source of truth로 사용한다.
- live mode는 source 연결 성공 상태를 backend connector로 재검증하고, 실제 생성 차단 조건인 source/record parsing/schema/rules/permission/target 값을 하나의 snapshot으로 반환한다.
- mock mode는 같은 `ReviewSnapshot` 계약을 fixture로 반환해 화면과 API 타입이 갈라지지 않게 한다.
- Review 생성 버튼은 snapshot의 `canCreate`가 true일 때만 활성화한다.

## 14. 남은 작업

- Kafka schema evolution approval/restart workflow
- 다중 Parquet 파일의 통합 스키마 추론
- Worker log 장기 object storage 및 metric alerting
- 삭제/수정 API persistence
- Trino 운영 quota/old table retention 고도화
- Dashboard 권한/공유/export API
- Audit log server persistence

## Spark/Kafka runtime·Node bridge readiness

- [x] 배포가 참조하는 Spark/Kafka entrypoint 경로를 얇은 compatibility façade로 유지
- [x] typed Spark/Kafka 환경 config와 Spark 없는 validation test
- [x] Spark text analysis·classifier 책임을 별도 runtime 모듈로 분리
- [x] Kafka partition cursor 정규화를 순수 state 모듈로 분리
- [x] runtime report atomic rename과 additive schema version
- [x] checkpoint contract와 batch manifest additive schema version 및 legacy field-less reader
- [x] primary runtime error와 secondary report-write error 분리
- [x] Python/Node use case authority matrix와 compatibility 종료 조건 문서화
- [x] review analysis의 allow-list versioned JSON bridge 적용
- [x] timeout/start/process/protocol 오류 분류, bounded diagnostic, secret redaction
- [x] Spark REST `UNKNOWN` 상태는 terminal last-known state가 있을 때만 새 Continuous worker attempt로 복구하고, non-terminal `UNKNOWN`은 duplicate start로 차단
- [x] deployment/startup metadata schema bootstrap으로 ETL, Catalog, SQL request/control-plane hot path 이전에 DDL 준비
- [ ] live Spark/Kafka integration과 long-running soak는 opt-in 운영 환경에서 확인
- [ ] connector·Spark/Kafka launcher compatibility의 Python 전환은 authority matrix 종료 조건 충족 후 별도 진행
## ETL Permission create-flow readiness

- [x] `GET /api/etl/permission-options` 그룹·사용자 경량 조회
- [x] 새 작업의 인증 actor 조회와 기존 작업의 생성자·담당자·`manage`·admin guard
- [x] 그룹/사용자 대상 추가, 프리셋, 대상별 action 직접 편집 UI
- [x] 담당자 자동 전체 권한과 `public:view` 최종 확인 표시
- [x] Review에서 실제 저장 권한과 생성 준비 상태를 분리하고 실제 `canCreate` 조건만 첫 카드에 표시
- [x] Review 권한 대상은 표시 이름과 대상 유형, 허용 작업을 함께 표시하고 권한 판정은 ID를 유지
- [x] Target 계층·형식을 숨은 기본값이 아닌 명시적 선택값으로 표시
- [x] create/update `permissionGrants` validation
- [x] 강한 action의 `view` 포함 정규화
- [x] `permission_ui` grant 저장 및 교체
- [x] admin source grant 보존
- [x] 이전 `permissionRoles`의 `legacy_permission_roles` 일회성 이관
- [x] 생성·수정 응답과 접근 판정에 persisted grant 병합
- [x] `backend/scripts/verify-permission-create-flow-contract.py` 생성·교체 계약 검증
- [ ] 그룹·사용자 디렉터리는 현재 demo group과 auth user fallback을 사용하며 운영 IdP/group membership 연동이 필요
- [ ] 명시적 deny, 조건부 권한, 그룹 멤버십 편집은 미지원
- [ ] Docker/PostgreSQL 기반 `verify:permission-job-dashboard` 전체 스모크는 metadata DB가 응답 가능한 환경에서 실행
- [ ] 그룹 후보를 `DEMO_GROUPS` 고정 정의가 아닌 운영 조직/그룹 디렉터리와 연동
- [ ] owner 이름 일치 fallback을 안정적인 principal id 기반 정책으로 교체
- [ ] deny/조건부 정책과 공개 범위 정책 고도화
- [ ] 민감 데이터 판정이 필요하면 frontend 컬럼명 정규식이 아닌 별도 backend 분류 결과 계약 추가

## EKS MVP backend readiness

- [x] EKS control-plane, lease heartbeat, Kubernetes identity와 fenced progress persistence 전용 모듈 및 직접 단위 테스트
- [x] Frontend/FastAPI `Deployment` 2 replica와 내부 `ClusterIP` `Service` Helm chart
- [x] FastAPI와 같은 immutable image/runtime identity를 쓰는 EKS `trino-result-collector` 1-replica Deployment 계약
- [x] Collector의 Service/Ingress/HTTP port/Kubernetes API token 부재와 exact Backend digest 검증
- [x] AWS 사전 생성 Query Result bucket에서 bucket-wide `HeadBucket` 없이 prefix-scoped object write/checksum으로 가용성 검증
- [x] Airflow API server/scheduler/DAG processor/migration Job과 Trino HTTPS coordinator Helm workload
- [x] ECR digest-only image, ConfigMap 일반 설정, 기존 Secret key 참조 계약
- [x] A Secret contract의 backend/Airflow/Spark/Trino exact key와 file mount 반영
- [x] FastAPI `/api/health` startup/readiness와 DB 장애에서 재시작하지 않는 TCP liveness probe
- [x] dev ALB 300초 deregistration을 포함하는 FastAPI `preStop` 310초와 termination grace 360초 계약
- [x] EKS의 Kafka Continuous 생성·조회·변경·freshness/widget read·background sync fail-closed 경계
- [x] `etl_runs` owner/expiry/generation 기반 singleton lease와 중복 요청 `409`
- [x] 기본 60초 lease와 20초 heartbeat를 Spark run timeout에서 분리
- [x] deterministic `SparkApplication` 제출·상태 조회·driver result 수집·timeout 삭제 provider
- [x] create 응답 유실/중복 create의 runId identity 복구와 mismatch fencing test
- [x] MSK IAM KafkaJS adapter와 metadata-only smoke Job
- [x] bounded Kafka fixture → RDS JDBC catalog/S3 warehouse Iceberg commit `SparkApplication` smoke manifest
- [x] 설정 부재 시 기존 단일 fixture slot만 허용하고, 설정 시 기본 slot + 최대 4개 exact group/table mapping만 허용하는 fail-closed parser
- [x] PostgreSQL group별 advisory transaction lock으로 같은 fixture slot의 두 번째 active Run을 Airflow 호출 전에 차단
- [x] 서로 다른 세 fixture group의 Run 예약, Run별 boundary와 고유 Iceberg target 정적 회귀 테스트
- [x] Day 17 HPA same-run 검증기가 기본 bounded consumer group만 선택하고 multi-Spark scale group 3개를 fixture 후보에서 제외하는 교차 회귀 테스트
- [x] Node runner와 Spark driver가 canonical slot JSON, persisted group과 manifest target mapping을 각각 재검증
- [x] FastAPI와 Spark driver least-privilege Kubernetes RBAC 계약 소비(리소스 소유자는 EKS foundation chart)
- [x] `scripts/verify-eks-workloads.sh` Helm schema/lint/render 계약 검증
- [x] PR에서 B-owned Frontend/Backend/Spark/Airflow image `linux/amd64` build와 focused runtime test workflow
- [ ] 실제 ECR repository/digest와 네 runtime Secret을 workload에 주입
- [x] A가 RDS/MSK/S3, 격리 fixture topic, EKS Pod Identity와 Spark Operator 2.5.1 준비
- [x] A foundation의 `asklake-spark` ServiceAccount token 자동 mount를 `true`로 적용
- [ ] Airflow migration과 Spark executor의 최소 runtime Secret consumer 범위 검증 후 A/B 정적 계약 정렬
- [ ] 운영 전 Spark driver/executor ServiceAccount와 Kubernetes API token/RBAC 분리
- [ ] 통합 환경에서 MSK metadata → bounded Spark output → Trino query live smoke
- [ ] A가 승인한 3~4개 MSK group을 private runtime-config values에 반영하고 동시 MSK → Iceberg → Trino → Catalog 결과의 pairwise isolation 검증
- [ ] 실제 EKS 2-replica FastAPI에서 Pod 종료 후 같은 runId recovery/takeover 검증
- [x] 실제 EKS Collector 1/1, 기존 stuck Run 안전 종료, bounded SQL 100행 terminal 성공과 Collector Pod 재생성 검증 ([live evidence](eks-day17-trino-result-collector-evidence.md))
## Realtime 2026 foundation readiness

- [x] 현재 Dashboard publication/polling과 Kafka Continuous 경로 조사
- [x] SSE notification + REST refetch, durable cursor, resync ADR
- [x] Continuous SQL V1과 PINNED_AT_START 기본 의미 확정
- [x] deployment scope feature flag와 invalid value fail-closed
- [x] 인증된 GET /api/realtime/config 및 frontend adapter
- [x] backend/deploy example env와 production Compose 전달
- [x] durable event log, transactional producer와 process당 PostgreSQL NOTIFY listener/cursor catch-up
- [x] Dashboard/Dataset ACL을 적용한 SSE replay/heartbeat/resync/overflow endpoint
- [x] Dashboard hybrid/SSE typed client, targeted REST refetch, bounded coalescing과 polling fallback
- [x] Caddy/NGINX streaming 설정, realtime status/readiness와 proxy contract verification
- [x] Continuous SQL AST planner, persisted Job/Run/Batch/command와 owner/idempotency contract
- [x] PINNED_AT_START/LATEST_PER_BATCH durable static binding, generation/fencing과 Spark adapter
- [x] bounded static snapshot cache·유일키 검증 재사용·신규 output Run partition 지연 경로
- [x] exact Iceberg snapshot 검증 후 Catalog revision/durable Dashboard event publication
- [x] `npm run verify:continuous-sql-contract` focused contract gate
- [x] realtime recovery/security focused suite와 polling/direct-publish/God-file 정적 quality gate
- [x] PR용 disposable PostgreSQL event log/NOTIFY·publication concurrency와 Caddy/NGINX parser workflow
- [x] scheduled/manual Kafka/Spark/Iceberg fault·restart workflow tier
- [ ] 실제 Kafka/MinIO/Spark/Iceberg/Trino Continuous SQL E2E와 fault/restart 검증
- [ ] production PostgreSQL multi-worker·실제 proxy/ALB·Spark 통합 및 rolling restart 검증

## Legacy removal evidence readiness

- [x] production legacy register 10경로와 evidence manifest ID·owner 1:1 검증
- [x] 누락·중복·unknown path와 owner drift fail-closed
- [x] 30일 미만 zero-call window, non-zero call, evidence·approval 누락 fail-closed
- [x] 현재 10경로 모두 `not_started`/`not_requested`, removal eligible 0개
- [ ] production log drain/dashboard에서 path별 30일 관찰 시작
- [ ] 실제 0-call evidence와 owner 승인 후 경로별 제거 PR 생성

이 readiness는 기존 compatibility activation, API/DB/runtime, UI와 배포 설정을 바꾸지 않는다. validator의 pass는 manifest 정합성만 뜻하며 제거 승인으로 해석하지 않는다.

## Current 10-PR merge readiness

- [x] issue/PR/branch/base/직전 PR dependency를 machine-readable manifest로 고정
- [x] 정확히 10개, contiguous order, strict sequential merge와 no-deploy 규칙 검증
- [x] backend/frontend deterministic regression과 release plan 검증 command 연결
- [ ] PR 01부터 PR 10까지 각 단계의 review·green CI 확인 후 `dev` 순차 merge
- [ ] 각 merge 뒤 다음 PR changed files·conflict·CI를 새 `dev` 기준으로 재검증
- [ ] 실제 EKS/EC2 control-plane owner, isolated nightly, clean reboot, backup/restore 수동 evidence

정적 plan 통과는 merge나 production 실행을 수행하지 않는다. 마지막 PR까지 merge된 뒤에도 release execution은 모든 production manual gate가 passed 되기 전 exit 2로 차단되어야 한다.

## Full-stack E2E·recovery readiness

- [x] PR/release/nightly 누적 profile과 선언형 fault matrix
- [x] source→Job→Continuous publication→Catalog→Dashboard application/API evidence 재사용
- [x] duplicate start, submission response loss, stale report/worker, maintenance race, partial publication 계약
- [x] 실제 Node Spark REST process와 Docker UID 185 runtime path release check
- [x] JSON/JUnit/Markdown artifact와 correlation ID, bounded secret-redacted output
- [x] frontend reversed polling과 stable browser selector 계약
- [x] nightly의 isolated loopback·credential fail-closed guard
- [ ] 실제 Kafka/Spark/object storage/browser nightly는 `self-hosted + asklake-e2e` runner에서 배포 후보마다 실행

## Kafka Job engine routing readiness (#1073)

## EKS Realtime V1-only profile readiness (#1101)
