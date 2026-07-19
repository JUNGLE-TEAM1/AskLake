# AskLake Backend API Contract

이 문서는 AskLake 프론트엔드와 실제 백엔드 API를 연결하기 위한 구현 명세입니다.
프론트 연결 지점은 `frontend/src/services/apiClient.ts`, `frontend/src/services/pipelineApi.ts`, `frontend/src/services/sourceConnectorService.ts`입니다.

## Pipeline·Snapshot·SQL·Catalog 내부 경계

### Catalog JOIN 유일키 자동 검증

`POST /api/catalog/datasets/{datasetId}/unique-keys/verify-and-register`는 `{ columns: string[] }`을 받고 Dataset `manage` 권한을 검사한 뒤 query 가능한 정적 Iceberg table에서 exact `count(*)`, invalid key count, distinct key count를 계산한다. `invalidKeyRows=0`이고 `totalRows=distinctKeys`일 때만 단일/복합 key set을 Catalog에 저장한다. 실패는 `CATALOG_UNIQUE_KEY_VERIFICATION_FAILED`와 세 count를 반환하며 추정치나 UI 선언만으로 유일성을 등록하지 않는다. Continuous SQL UI는 `CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE`의 `datasetId`와 `joinColumns`를 이용해 이 API를 자동 호출하고 validate/create/start를 재개한다.

### Catalog Dataset 전체 삭제

`GET /api/catalog/datasets/{datasetId}/deletion-impact`는 `delete` 권한을 확인하고 `canDelete`, `blockers`, `artifacts`, `retainedResources`를 반환한다. active ETL/SQL/Continuous workload, 중지되지 않은 schedule, Dataset을 source로 쓰는 Job, downstream lineage, Dashboard widget, Semantic model/metric/dimension/relationship, active RAG classification/index 작업, AskLake 소유권을 입증할 수 없는 storage path는 blocker다.

`DELETE /api/catalog/datasets/{datasetId}?confirmName={datasetName}`는 exact Dataset 이름 확인과 같은 impact를 transaction 직전에 다시 검사하고 blocker가 없을 때 `catalog_dataset_deletions` receipt를 저장한 뒤 `202`와 `{ deletionId, datasetId, status }`를 반환한다. 이름이 다르면 `422 CATALOG_DATASET_DELETE_CONFIRMATION_MISMATCH`다. `GET /api/catalog/dataset-deletions/{deletionId}`는 durable 상태와 `errorCode`/`errorMessage`를 반환한다. 성공 전에는 Dataset row를 유지하며, worker는 관리 Iceberg/ClickHouse/local/S3/RAG artifact를 먼저 멱등 삭제하고 내부 Dataset metadata를 정리한다. 감사 로그, 완료 Run 이력, 중지된 producer Job 정의와 deletion receipt는 보존한다. receipt가 존재하는 Dataset ID로의 늦은 Catalog publication은 `409 DATASET_DELETION_FENCED`다.

PR 07의 내부 리팩터링은 기존 API 계약에 additive field도 추가하지 않는다. Pipeline draft validation, persisted Job mapping, finite Snapshot command planning, Catalog payload publication을 application/domain 경계로 옮기되 다음 외부 계약을 그대로 유지한다.

- `recordParsing`, `schemaColumns`, Rule, schedule, permission, target request shape
- Job hydrate와 command response의 `job`, `run`, `dataset`, `dagSteps`
- Snapshot과 Continuous가 허용하는 command 집합 및 기존 오류 code/status
- SQL Query Run, SQL Job, derived Dataset과 Catalog payload
- 기존 DB schema, Job/Run/Catalog JSON, DuckDB compatibility mode

Catalog terminal publication은 `datasetId`, materialization version, storage location, query-engine table identity가 일치하는 재시도를 멱등으로 처리한다. 내부 모듈과 검증 명령은 [Pipeline·Snapshot·SQL·Catalog Application 경계](refactor-2026/contracts/pipeline-snapshot-sql-catalog-boundaries.md)를 따른다.

## 1. 구현 우선순위

| 단계 | 우선순위 | API | 목적 |
| --- | --- | --- | --- |
| 1 | P0 | `POST /api/etl/jobs` | 새 수집/처리 생성 완료 |
| 1b | P0 | `POST /api/etl/record-parsing/preview` | 이름 없는 TXT 레코드의 구조화 Preview와 필드 개수 검증 |
| 1a | P0 | `PATCH /api/etl/jobs/{jobId}` | 생성 Job의 허용 설정 update (Issue #460) |
| 2 | P0 | `POST /api/etl/jobs/{jobId}/commands` | 즉시 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 |
| 3 | P0 | `POST /api/query/runs` | Trino 최대 100행 preview Query Run 접수 또는 DuckDB compatibility 실행 |
| 3b | P0 | `GET /api/query/runs/{runId}` | Query Run lifecycle 또는 compatibility snapshot 조회 |
| 3c | P0 | `POST /api/query/runs/{previewRunId}/full-results` | 전체 보기/CSV용 원본 SQL 전체 결과 run 시작 또는 재사용 |
| 4 | P0 | `POST /api/query/ai-suggestions` | 선택 테이블 context 기반 Query AI SQL 초안 생성 |
| 5 | P1 | `GET /api/catalog/datasets` | 카탈로그 목록 hydrate |
| 6 | P1 | `GET /api/catalog/datasets/{datasetId}` | 데이터셋 상세 hydrate |
| 6b | P1 | `GET /api/catalog/datasets/{datasetId}/rows` | 최신 성공 materialization sample page 조회 |
| 6c | P1 | `GET /api/catalog/datasets/{datasetId}/deletion-impact`, `DELETE /api/catalog/datasets/{datasetId}`, `GET /api/catalog/dataset-deletions/{deletionId}` | 목록 직접 Dataset 삭제 영향도·작업 상태 |
| 7 | P1 | `POST /api/dashboards` | 대시보드 초안 생성 |
| 8 | P1 | `GET /api/s3/buckets`, `GET /api/s3/prefixes` | Target 저장경로 S3 bucket/prefix 선택 |
| 9 | P1 | `GET /api/target/databases` | Target 기본정보 DB 선택 |
| 10 | P2 | `GET /api/admin/audit-logs` | 서버 감사 로그 조회/검색 |

현재 Source/Schema/Create/Run/Catalog/SQL 흐름과 Dashboard card/runtime 흐름은 live backend API를 호출합니다. SQL은 `TRINO_ENABLED=true`에서 canonical Trino Query Run을, `false`에서 DuckDB compatibility runtime을 사용합니다. frontend local/mock adapter는 제거되었으며 API 실패는 명시적 오류 상태로 처리합니다.

## 2. 프론트 연결 위치

- 공통 fetch client: `frontend/src/services/apiClient.ts`
- Pipeline create/run/query client: `frontend/src/services/pipelineApi.ts`
- Query AI client: `frontend/src/services/queryAiService.ts`
- Source connector client: `frontend/src/services/sourceConnectorService.ts`
- 프론트 데이터 상태: `frontend/src/hooks/useAskLakeData.ts`
- 감사 로그/토스트 상태: `frontend/src/hooks/useAuditLogs.ts`

타입 위치:

- ETL job/draft: `frontend/src/types/etl.ts`
- catalog dataset: `frontend/src/types/catalog.ts`
- SQL result: `frontend/src/types/sql.ts`
- dashboard view: `frontend/src/types/dashboard.ts`
- audit/error: `frontend/src/types/audit.ts`

## 3. 환경변수

`frontend/.env`

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant
VITE_OBJECT_STORAGE_PROVIDER=minio
VITE_S3_REGION=us-east-1
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
ASKLAKE_OBJECT_STORAGE_PROVIDER=minio
S3_ALLOWED_BUCKETS=asklake-output
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
ASKLAKE_DASHBOARD_MAX_REMOTE_BYTES=536870912
ASKLAKE_DASHBOARD_MAX_REMOTE_OBJECTS=256
ASKLAKE_DASHBOARD_QUERY_TIMEOUT_SECONDS=15
TARGET_DATABASES=asklake,asklake_gold,analytics,marketing
```

- `VITE_API_BASE_URL`: 선택적인 백엔드 base URL입니다. 생략하거나 빈 문자열이면 같은 출처의 `/api` 경로를 사용합니다.
- `VITE_DEV_PROXY_TARGET`: Vite 개발 서버가 상대 `/api` 요청을 전달할 backend origin입니다. 기본값은 `http://127.0.0.1:8080`입니다.
- `VITE_DASHBOARD_ASSISTANT_API_PATH`: 미설정 시 `/api/dashboards/assistant`를 호출합니다. 다른 Assistant API 경로 또는 origin이 필요할 때만 지정합니다.
- `DATABASE_URL`: backend metadata DB입니다. 미설정 시 `docker-compose.yml`의 local Postgres 기본값을 사용합니다.
- 로컬 object storage는 `ASKLAKE_OBJECT_STORAGE_PROVIDER=minio`, MinIO endpoint/static local credential, path-style URL을 사용합니다.
- EC2 production은 `ASKLAKE_OBJECT_STORAGE_PROVIDER=aws`, `AWS_REGION`, `S3_FORCE_PATH_STYLE=false`를 사용합니다. custom endpoint와 장기 AWS access key/secret은 설정하지 않고 EC2 instance profile IAM Role/default credential chain으로 인증합니다.
- `TRINO_ENABLED=true`이면 production은 사전 생성한 Warehouse와 Query Result S3 bucket도 같은 default credential chain으로 사용합니다. 최대 100행 preview page는 canonical `storage="postgres"`, on-demand full result page는 `storage="s3"`로 응답합니다. Browser에는 두 storage의 내부 위치나 credential을 노출하지 않습니다.
- AWS Source request는 provider, region, bucket/prefix만 받으며 frontend는 endpoint/access key/secret 입력을 노출하거나 API payload에 포함하지 않습니다.
- mock mode에서는 Source/Schema 연결 테스트도 `sourceConnectorService.ts`의 mock `SourceConnectorAnalysis`를 사용합니다.
- live mode에서는 Source/Schema/Create/Run 흐름이 실제 백엔드를 호출합니다.
- 새 Kafka/S3 Source의 비밀이 아닌 기본값은 `GET /api/etl/sources/defaults`가 반환하는 backend runtime 값이며 frontend build에 복제하지 않습니다.
- Target 저장경로 선택은 브라우저가 AWS SDK나 secret을 갖지 않고 `/api/s3/buckets`, `/api/s3/prefixes` 서버 API만 호출합니다. 서버는 `S3_ALLOWED_BUCKETS` allowlist를 검증하고 AWS SDK v3 `ListObjectsV2`로 prefix를 조회합니다.
- Dashboard 원격 widget scan은 `S3_ALLOWED_BUCKETS`, runtime 응답 전체에서 공유하는 기본 512 MiB/256 object 예산, DuckDB query당 기본 15초와 memory/temp 각 256 MiB/2 threads 경계를 사용합니다. 예산은 `ASKLAKE_DASHBOARD_MAX_REMOTE_BYTES`/`ASKLAKE_DASHBOARD_MAX_REMOTE_OBJECTS`, 실행 경계는 `ASKLAKE_DASHBOARD_QUERY_TIMEOUT_SECONDS`/`ASKLAKE_DASHBOARD_DUCKDB_MEMORY_BYTES`/`ASKLAKE_DASHBOARD_DUCKDB_TEMP_BYTES`/`ASKLAKE_DASHBOARD_DUCKDB_THREADS`로 설정합니다.
- Target DB 선택은 `/api/target/databases` 서버 API만 호출합니다. 서버는 `TARGET_DATABASES` 또는 `ASKLAKE_TARGET_DATABASES` allowlist를 사용하고, 값이 없으면 local demo 기본 DB 목록을 반환합니다.

## 4. 공통 HTTP 규칙

### Request

- 모든 request body는 JSON입니다.
- 모든 response body는 JSON입니다.
- 날짜/시간은 ISO 8601 문자열을 사용합니다.
- ID는 문자열입니다.
- 프론트는 세션 쿠키 기반 endpoint를 위해 `credentials: "include"`로 `fetch`를 호출합니다.
- SQL Query AI, Dashboard Assistant, ETL transform, 리뷰 분석 client도 공통 `apiClient` 또는 동일한 credential 규칙을 사용하며 개발 mock으로 성공 응답을 합성하지 않습니다.

권장 header:

```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer {accessToken}
X-Request-Id: req_20260703_000001
```

현재 로컬 인증은 `/api/auth/login` 또는 `/api/auth/signup`이 발급하는 httpOnly `asklake_session` 쿠키를 사용합니다. 외부 IdP/OAuth/SSO, refresh token, 비밀번호 재설정, 이메일 인증은 아직 범위 밖이며, 기존 smoke와 수동 검증을 위해 `X-AskLake-*` actor header fallback은 유지합니다. 이 fallback은 로컬 smoke/manual 검증용이며, 운영에서는 session/IdP 또는 trusted gateway 검증 없이 client-provided header만으로 role/user/group을 신뢰하면 안 됩니다.

Production startup은 기존 `auth_users.status`와 `auth_sessions`를 변경하지 않으며 재배포만으로 legacy demo 계정을 비활성화하지 않습니다. `AUTH_LEGACY_DEMO_USERS_ENABLED=false` 또는 미설정이면 알려진 demo identity를 새로 만들거나 disabled 계정을 복구하지 않고 `BOOTSTRAP_ADMIN_*` 계정만 보장합니다. 공개 demo 배포에서만 `AUTH_LEGACY_DEMO_USERS_ENABLED=true`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=true`를 함께 명시해 누락 demo 계정을 생성하고 기존 demo 계정을 active로 동기화합니다. `scripts/verify-deploy-env.sh`는 두 값의 lowercase boolean 및 일치를 검증합니다. 운영 인증은 Secure session cookie와 client header fallback 차단 계약을 계속 유지하며 계정 status 변경은 명시적인 관리 작업이 소유합니다.

운영 세션 쿠키는 기본적으로 `Secure`, `HttpOnly`, `SameSite=Lax`를 사용합니다. HTTPS가 아직 없는 제한된 dev HTTP ALB는 `AUTH_SESSION_COOKIE_SECURE=false`를 명시할 수 있지만 `HttpOnly`와 `SameSite=Lax`는 유지되며, 이 예외는 header-auth fallback, public signup, legacy demo 계정 정책을 변경하지 않습니다. HTTPS 전환 뒤에는 반드시 `true`로 복구합니다.

Frontend는 `/api/auth/session` actor 확인 이후 보호 route와 backend hydrate를 시작합니다. Session/identity/admin 계약은 `/api/auth/signup`, `/api/auth/login`, `/api/auth/session`, `/api/auth/logout`, `/api/users/me`, `/api/admin/users`, `/api/admin/groups`, `/api/admin/permissions`, `/api/admin/governance-controls`, `/api/admin/audit-logs`를 사용하며, `/api/admin/*`는 현재 ActorContext가 admin이 아니면 `403 FORBIDDEN`을 반환합니다.

### Permission/Governance Phase 0 용어

Phase 0 기준에서 identity metadata와 access control은 별도 개념입니다.

| 용어 | 현재 의미 | 후속 방향 |
| --- | --- | --- |
| `createdBy` | Job/Dataset/Dashboard에 optional 표시 metadata로 제공 | resource를 생성한 사용자 표시와 감사 로그 문맥에 사용 |
| `createdByProfile` | `displayName`, `avatarInitials` 중심의 optional 표시 metadata | profile/avatar 표시용으로 확장 가능 |
| `owner` | Job/Dataset/Dashboard 화면에 표시되는 담당자 문자열 | ETL Job에서는 표시 값이면서 전체 권한을 주는 backend fallback 기준이며 별도 grant로 저장하지 않음 |
| profile/avatar | `createdByProfile`의 optional 표시 값 | `createdBy`/`owner` 옆 표시용 identity metadata로 추가 |
| `permissionSummary` | Create Permission 단계의 요약 문구 | governance metadata로 유지 |
| `permissionRoles` | 이전 Create Permission 단계의 역할별 호환 값 | ETL Job 최초 접근 시 `legacy_permission_roles` source의 table grant로 한 번만 이관 |
| `permissionGrants` | Job/Dataset/Dashboard의 실제 resource action 허용 목록 | ETL 생성·수정 request를 `permission_grants` table에 저장하고 backend가 enforce |
| `permissions` | Job/Dataset/Dashboard에 optional response metadata로 제공 | backend가 현재 actor 기준 `canView`, `canQuery`, `canManage` 등을 계산해 내려주는 값 |

Catalog 목록/상세, SQL Query Run, Query AI, ETL job command API, Dashboard card/runtime API는 `permissionSummary`나 `permissionRoles`만으로 접근 권한을 판정하지 않습니다. 이 값들은 표시용 governance metadata이고, 실제 허용 여부는 `ActorContext`와 resource별 `permissionGrants`로 계산합니다. Dashboard 삭제 API의 `X-AskLake-User`, `X-AskLake-Role` header는 초기 dashboard 전용 입력에서 시작했지만, 이후 공통 actor header로 해석됩니다.

`permissionGrants`와 `permissions`는 UI 표시와 backend enforcement를 함께 설명하는 계약 필드입니다. `permissions.enforced=false`이면 프론트는 버튼 비활성화/경고에만 참고하고, 실제 보안 차단으로 해석하지 않습니다. `permissions.enforced=true`이면 같은 기준으로 backend가 `403 FORBIDDEN`을 반환할 수 있습니다.

Backend는 세션 쿠키가 있으면 session user를 우선 actor로 사용하고, 세션이 없을 때만 아래 임시 actor header를 공통 `ActorContext` fallback으로 해석할 수 있습니다. 공통 판정기는 Dashboard 삭제뿐 아니라 Catalog dataset 조회/lineage/materialization-run 삭제, SQL Query Run 제출·조회·취소·materialization, Query AI 생성, Job command, Dashboard runtime 편집에도 사용됩니다.

| Header | 기본값 | 설명 |
| --- | --- | --- |
| `X-AskLake-User` | `Admin User` | 요청 사용자 표시 이름 |
| `X-AskLake-Role` | `admin` | `admin`이면 모든 action 허용 |
| `X-AskLake-Groups` | 빈 값 | comma-separated group id/name 목록 |

권한 판정은 현재 allow-only 모델입니다. 명시적 deny는 아직 계약에 없고, 여러 grant는 합산됩니다.

권한 허용 우선순위:

1. `actor.role === "admin"`이면 모든 resource/action 허용
2. resource `owner`가 actor name과 같으면 허용하는 local fallback 유지
3. actor의 user principal, group principal, role principal 중 하나와 grant가 일치하고 해당 action이 포함되어 있으면 허용
4. `principalType="public"` grant에 해당 action이 포함되어 있으면 허용
5. 위 조건이 모두 아니면 `403 FORBIDDEN`

Governance control은 위 allow-only 판정 앞에서 적용됩니다. `principal_controls`에서 actor의 user id/email/display name 또는 소속 group이 `blocked`이면 grant가 있어도 `403 FORBIDDEN`입니다. `resource_locks`에서 resource가 잠겨 있으면 `view`는 유지하고 `query`, `run`, `manage`, `delete`, `share` action은 `403 FORBIDDEN`입니다. 목록 API는 blocked actor에게 해당 resource를 숨깁니다. Resource lock은 목록 노출을 막지 않고, 응답 `permissions`에서 `canQuery`, `canRun`, `canManage`, `canDelete`, `canShare`를 `false`로 내려 UI preflight와 backend enforcement가 같은 상태를 보게 합니다.

관리자 권한 편집 기능은 이 우선순위를 바꾸지 않고 독립 `permission_grants` table row를 생성/수정/삭제합니다. 운영 기본값은 group grant 중심이며, user grant는 예외 권한에 사용합니다. Admin 권한은 resource 접근 그룹이 아니라 `role=admin`으로 부여하고, 로컬 demo admin 계정의 groups는 빈 배열로 유지합니다. Group grant/block은 일반 사용자 권한 운영 단위입니다. `role`/`public` grant도 계약상 지원합니다. ETL Job은 table row를 권한 source of truth로 사용하며, 이전 `permissionRoles`는 `legacy_permission_roles` source로 한 번만 이관합니다. 다른 resource의 기존 payload grant 병합은 해당 resource 계약의 호환 범위로 유지합니다.

Resource/action 기준:

| Resource type | 주요 action | 의미 |
| --- | --- | --- |
| `dataset` | `view` | Catalog 목록/상세/lineage에서 조회 가능 |
| `dataset` | `query` | SQL Query Run, Query AI, SQL 결과 기반 후속 작업에서 dataset 사용 가능 |
| `dataset` | `manage`, `delete` | materialization-run 삭제 등 dataset metadata 변경 가능 |
| `dataset` | `delete` | dataset 삭제 가능. 별도 삭제 API 도입 시 사용 |
| `etl_job` | `view` | Job 목록/상세 조회 가능 |
| `etl_job` | `run` | Job run/retry 실행 가능 |
| `etl_job` | `manage` | Job pause/cancel/stop 등 운영 상태 변경 가능 |
| `dashboard` | `view` | Dashboard card/runtime 조회 가능 |
| `dashboard` | `manage` | draft 생성, page/widget/layout 변경, publish 가능 |
| `dashboard` | `delete` | Dashboard 삭제 가능 |
| `dashboard` | `share` | Dashboard 공유/권한 위임 UI 도입 시 사용 |

공통 enforcement 범위:

| Endpoint | 필요 action | 비고 |
| --- | --- | --- |
| `GET /api/catalog/datasets` | `view` | actor가 볼 수 있는 dataset만 목록에 포함 |
| `GET /api/catalog/datasets/{datasetId}` | `view` | 권한 없으면 `403 FORBIDDEN` |
| `GET /api/catalog/datasets/{datasetId}/rows` | `view` + `query` | 상세 열람 후 실제 row를 query하므로 두 검사를 모두 통과 |
| `GET /api/catalog/datasets/{datasetId}/lineage` | `view` | dataset detail과 같은 기준 |
| `DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}` | `manage` 또는 `delete` | materialization metadata 수정/삭제로 간주 |
| `POST /api/query/runs` | `query` | base/reference dataset 모두 검사 |
| `POST /api/query/runs/{runId}/full-results` | `query` | 성공한 preview submitter/admin과 현재 base/reference dataset 권한 재검사 |
| `GET /api/query/runs/{runId}` | `query` | 저장된 run의 base/reference dataset 모두 다시 검사 |
| `GET /api/query/runs/{runId}/results` | `query` | submitter/admin과 base/reference dataset 권한·governance 재검사 |
| `GET /api/query/runs/{runId}/exports/csv` | `query` | result page와 같은 ownership·retention·권한 검사 |
| `POST /api/query/runs/{runId}/cancel` | `query` 또는 base Dataset `manage` | queued/running run만 취소 |
| `POST /api/query/ai-suggestions` | `query` | 선택 dataset metadata를 AI context로 사용하기 전 모두 검사 |
| `POST /api/etl/jobs/{jobId}/commands` | `run` 또는 `manage` | `run`/`retry`는 `run`, pause/cancel/stop은 `manage` |
| `PATCH /api/etl/jobs/{jobId}` | `manage` | source identity와 successful target identity 보호 |
| `GET /api/dashboards`, `POST /api/dashboards/query` | `view` | actor가 볼 수 있는 dashboard만 목록에 포함 |
| `GET /api/dashboards/{dashboardId}/published` | `view` | published revision이 없어도 권한 통과 후 빈 runtime 응답 가능 |
| `GET /api/datasets/{datasetId}/freshness` | Dataset `query` | 새 S3/Catalog revision 확인 전 dataset 권한 재검사 |
| `POST /api/datasets/freshness/query` | Dataset `query` | 요청한 dataset 전체에 대해 같은 기준 적용 |
| `POST /api/dashboards/{dashboardId}/widgets/query` | published: Dashboard `view`, draft: Dashboard `manage`, 둘 다 Dataset `query` | 요청한 mode의 widget만 조회하고 물리 storage 접근 전 재검사 |
| `PATCH /api/dashboards/{dashboardId}` | `manage` | dashboard card title 수정 |
| `POST /api/dashboards/{dashboardId}/draft/ensure` | `manage` | draft revision 생성/복사 가능 여부 검사 |
| `POST/PATCH/DELETE /api/dashboards/{dashboardId}/draft/**` | `manage` | page/widget/layout draft 변경 전체 |
| `POST /api/dashboards/{dashboardId}/publish` | `manage` | draft snapshot을 published revision으로 승격 |
| `DELETE /api/dashboards/{dashboardId}` | `delete` | admin 또는 owner fallback 유지 |

Frontend 기준:

- `permissions.canQuery=false`: SQL 실행, Query AI 생성, Catalog -> SQL 이동, SQL 결과 기반 Job 생성 버튼을 비활성화합니다. Trino mode에서는 검증된 `queryEngineTable`이 없는 Dataset도 `canQuery=false`입니다.
- `permissions.canRun=false`: Job `run`/`retry` 버튼을 비활성화합니다.
- `permissions.canManage=false`: Job pause/cancel/stop 버튼을 비활성화합니다. Dataset materialization-run 삭제 버튼은 `canManage` 또는 `canDelete` 중 하나가 없으면 비활성화합니다.
- `permissions.canManage=false`: Dashboard runtime 편집 모드 진입, page/widget/layout 변경, publish 버튼을 비활성화합니다.
- `permissions.canDelete=false`: Dashboard 삭제 버튼을 비활성화합니다.
- Backend가 `403 FORBIDDEN`을 반환하면 프론트는 일반 실패가 아니라 권한 없음 메시지로 표시합니다.

Profile/Admin Console Phase 0 기준:

- 프로필 페이지와 관리 페이지는 세션 쿠키가 있으면 해당 계정 actor를 우선 사용하고, 세션이 없으면 기존 demo actor header fallback을 사용합니다.
- `POST /api/auth/login`, `POST /api/auth/signup`, `GET /api/auth/session`, `POST /api/auth/logout`은 로컬 데모 계정/session API입니다.
- `GET /api/users/me`는 현재 actor의 표시 프로필, role, group, 권한 요약을 반환합니다.
- `/api/admin/*` endpoint는 현재 ActorContext의 role이 `admin`인 actor만 호출할 수 있습니다. 권한이 없으면 `403 FORBIDDEN`을 반환합니다.
- 관리 콘솔은 사용자/그룹/감사 로그 조회, 사용자/그룹 차단, resource lock, permission grant 생성/수정/삭제를 지원합니다. 사용자/그룹 자체 생성, 멤버십 편집, deny policy, 조건부 정책은 후속 계약으로 분리합니다.
- 관리자 편집 API는 group grant를 기본 흐름으로, user grant를 예외 흐름으로 제공합니다. Admin 계정은 resource 접근 그룹에 속하지 않고 `role=admin`으로 관리 권한을 받습니다. role/public grant는 계약상 허용하지만 운영 위험이 크므로 관리 콘솔의 기본 추가 옵션으로 노출하지 않고 정책 확인 후 사용합니다. ETL Job의 owner 권한은 backend fallback으로 계산해 table grant로 저장하지 않으며, 이전 `permissionRoles`는 `legacy_permission_roles` source의 읽기 전용 table grant로 이관합니다.
- 관리 콘솔의 권한 표시는 resource별 `permissionGrants`와 현재 actor 기준 `permissions`를 설명하는 운영 화면이며, 프론트 표시만으로 보안 판정을 대체하지 않습니다.
- Auth table은 현재 repo의 기존 로컬 persistence 패턴에 맞춰 service에서 `create_all`로 보강합니다. 운영 배포의 schema source of truth는 후속 Alembic migration으로 분리해야 합니다.

```ts
type PermissionAction = "view" | "query" | "run" | "manage" | "delete" | "share";
type PermissionPrincipalType = "user" | "group" | "role" | "public";

type PermissionGrant = {
  principalType: PermissionPrincipalType;
  principalId: string;
  principalName?: string; // Review 표시용, 권한 판정에는 사용하지 않음
  actions: PermissionAction[];
  source?: string;
};

type ResourcePermissions = {
  canView: boolean;
  canQuery: boolean;
  canRun: boolean;
  canManage: boolean;
  canDelete: boolean;
  canShare: boolean;
  computedFor?: string;
  enforced?: boolean;
};
```

```ts
type IdentityProfile = {
  displayName: string;
  avatarInitials?: string;
  email?: string;
  title?: string;
};

type IdentityGroup = {
  id: string;
  name: string;
  description?: string;
};

type CurrentUserResponse = {
  id: string;
  displayName: string;
  email: string;
  role: "admin" | "editor" | "viewer" | string;
  groups: IdentityGroup[];
  profile: IdentityProfile;
  permissionsSummary: {
    canView: number;
    canQuery: number;
    canRun: number;
    canManage: number;
    canDelete: number;
    canShare: number;
  };
};

type AdminUser = CurrentUserResponse & {
  status: "active" | "invited" | "disabled";
  lastActiveAt?: string;
};

type AdminPermissionSummary = {
  resourceType: "dataset" | "etl_job" | "dashboard";
  resourceId: string;
  resourceName: string;
  owner?: string;
  createdBy?: string;
  grants: PermissionGrant[];
  currentActorPermissions?: ResourcePermissions;
};
```
### Success Envelope

P0 API는 프론트 타입과 바로 맞추기 위해 envelope 없이 아래 response shape 그대로 반환합니다.

예:

```json
{
  "job": {},
  "catalogTarget": {}
}
```

FastAPI 구현에서도 모든 성공 응답을 `{ ok, data }` 같은 단일 envelope로 강제하지 않습니다.
각 endpoint는 이 문서에 적힌 response shape를 우선하고, 목록 API처럼 pagination 정보가 필요한 경우에만 resource 배열과 page metadata를 함께 반환합니다.

목록 API처럼 확장 필드가 필요한 경우에는 아래처럼 리소스 배열을 감싸서 반환합니다.

```json
{
  "datasets": [],
  "page": {
    "cursor": null,
    "hasNext": false
  }
}
```

page 번호 기반 목록 API는 아래 필드명을 사용합니다.

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 10
}
```

FastAPI 공통 schema에서는 `PageRequest`, `PageMeta`, `PageResponse`, `CursorPageMeta`를 재사용할 수 있습니다.
단, 실제 resource key가 `items`가 아니라 `datasets`, `dashboards`처럼 정해진 endpoint는 해당 상세 계약을 우선합니다.

### Error Envelope

실패 응답은 모든 API에서 동일한 형식을 사용합니다.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "targetDataset is required",
    "details": {
      "field": "targetDataset"
    }
  }
}
```

프론트의 현재 필수 필드는 `code`, `message`입니다.
`details`는 선택입니다.
FastAPI 구현은 `backend/app/schemas/common.py`의 `ErrorResponse`와 `ErrorDetail`을 기준으로 이 envelope를 생성합니다.

### 상태 코드

| Status | 의미 | 사용 예 |
| --- | --- | --- |
| `200` | 조회/명령 성공 | 작업 명령, SQL 실행 성공 |
| `201` | 생성 성공 | ETL job 생성, 대시보드 초안 생성 |
| `202` | 비동기 작업 접수 | ETL run queue 등록 |
| `400` | validation 실패 | 필수 필드 누락, 잘못된 enum |
| `401` | 인증 없음 | access token 없음 |
| `403` | 권한 없음 | 데이터셋/작업 접근 불가 |
| `404` | 리소스 없음 | jobId, datasetId 없음 |
| `409` | 충돌 | 이미 실행 중인 job을 다시 실행 |
| `422` | 실행 불가 상태 | SQL 문법 오류, schema mismatch |
| `500` | 서버 오류 | 알 수 없는 내부 오류 |

권장 에러 코드:

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
CONFLICT
INVALID_JOB_STATE
SQL_SYNTAX_ERROR
BACKEND_TIMEOUT
INTERNAL_ERROR
```

## 5. 리소스 ID 규칙

권장 prefix:

| 리소스 | 예시 |
| --- | --- |
| ETL job | `JOB-001` 또는 `job_01HZ...` |
| ETL run | `run_01HZ...` |
| Dataset | `ds_orders_clean` |
| SQL run | `sql_01HZ...` |
| Dashboard | `dash_01HZ...` |
| Audit log | `audit_01HZ...` |
| Request | `req_01HZ...` |

프론트는 ID를 opaque string으로 취급합니다.
표시용 이름은 `name`, `jobName`, `targetDataset`을 사용합니다.
API와 frontend internal state의 상태값은 영어 canonical value를 사용합니다.
한국어 배지/버튼 문구는 프론트 UI mapper에서 변환합니다.

## 6. 데이터 모델 요약

### JobRowData

```ts
type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled" | "stopped";

type IcebergWriterTarget = {
  catalog: string;
  namespace: string;
  table: string;
  tableUri: `iceberg://${string}/${string}/${string}`;
  writeMode: "append" | "replace";
  partitionColumns: string[];
};

type JobRowData = {
  id: string;
  name: string;
  owner: string;
  createdBy?: string;
  createdByProfile?: {
    avatarInitials?: string;
    displayName: string;
    email?: string;
    role?: string;
  };
  permissionGrants?: PermissionGrant[];
  permissions?: ResourcePermissions;
  status: JobStatus;
  tag: string;
  source: string;
  target: string;
  schedule: string;
  schedulePolicy?: {
    endDate?: string;
    nextRunUtc?: string;
    overlapPolicy?: "skip_if_running" | "queue_after_current" | "allow_parallel";
    startDate?: string;
    timezone?: string;
    watermarkPolicy?: WatermarkPolicyDraft;
  };
  scheduleSummary?: string;
  sourceConfig?: Array<[string, string]>;
  sourceLabel?: string;
  sourceType?: string;
  schemaColumns?: SchemaColumnDraft[];
  schemaFingerprint?: string;
  schemaSampleRows?: string[][];
  schemaSummary?: string;
  ruleSummary?: string;
  ruleContractVersion?: "1.0";
  rules?: CanonicalRuleDraft[];
  ruleCompilation?: RuleCompilationResult;
  permissionSummary?: string;
  permissionRoles?: PermissionDraft["roles"];
  targetDatabase?: string;
  targetDescription?: string;
  targetTags?: string[];
  targetFormat?: string;
  targetLayer?: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  storageType?: "S3" | "Local" | "HDFS";
  storagePath?: string;
  icebergTarget?: IcebergWriterTarget;
  partitionColumns?: string[];
  indexColumns?: string[];
  transformOutputColumns?: Array<[string, string]>;
  transformSteps?: TransformStepDraft[];
  qualityRules?: QualityRuleDraft[];
  qualityInvalidRows?: string[][];
  qualityScore?: number;
  qualityStatus?: "idle" | "pass" | "warn" | "fail";
  lastRun: string;
  lastState: string;
  nextRun: string;
  retryPolicy?: RetryPolicyDraft;
  retryPolicySummary?: string;
  runLimitSummary?: string;
  progress?: {
    label: string;
    value: number;
  };
};
```

`icebergTarget`은 backend-owned writer destination 선언이다. create/update request에서 사용자가 보내는 값이 아니며 backend가 Dataset ID와 Trino catalog/schema 설정으로 생성한다. Kafka source와 증분 S3/Data Lake folder는 `append`, 그 외 일반 ETL source는 `replace`를 사용한다. 증분 folder의 첫 rebaseline run은 target이 append여도 실제 operation을 replace로 실행한다. `tableUri`는 논리 식별자이고 `storagePath`는 기존 Job의 읽기 호환 필드다. 이 값이 존재해도 Iceberg commit과 Trino 물리 검증 전에는 `queryEngineStatus=unavailable`이다.

`GET /api/etl/jobs/{jobId}`는 위 설정값을 편집 복원용으로 반환한다. `sourceConfig`에는 Kafka broker, topic, consumer group, batch/timeout, offset policy, authentication 같은 source identity가 포함될 수 있으므로 UI는 값을 보이되 Issue #460 수정 모드에서는 변경하지 않는다. 기존 Job에는 새 선택형 metadata가 없을 수 있으므로 해당 값은 optional로 유지한다.

`schedule`/`scheduleSummary`의 저장 기준은 `스케줄링 건너뛰기`와 `반복 실행` 두 가지다. UI의 `직접 실행` 선택은 `스케줄링 건너뛰기`로 정규화되며, 즉시 실행 command `run`으로 필요할 때 1회 Run을 만든다. 반복 실행 UI는 반복 주기, 실행 시각, IANA timezone, 겹침 처리와 실패 재시도를 노출한다. ISO date `startDate`, optional `endDate`, watermark 수집 기준은 `schedulePolicy`에 함께 보존하지만 UI에서는 기본값으로 처리한다. 빈 `endDate`는 종료일 없음으로 해석하고, `endDate`가 `startDate`보다 이르면 frontend draft에서 빈 값으로 정규화한다. 기본 겹침 처리는 `skip_if_running`이며, 이전 Run이 길어져 다음 예약 시각과 겹쳐도 다음 schedule 계산을 밀지 않고 해당 예약 Run을 건너뛰는 정책이다. `retryPolicySummary`는 재시도 횟수/2배 지수 백오프/최종 실패 처리만 담는 optional field이며, `runLimitSummary`는 hidden default `timeoutMinutes` 기반 실행 제한 표시용 optional field다. 둘 중 하나가 없으면 frontend가 fallback 문구를 사용한다.

### JobRunSummary and JobDagStep

```ts
type JobRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
type JobDagStepStatus = "pending" | "running" | "success" | "failed" | "blocked";

type JobRunSummary = {
  runId: string;
  status: JobRunStatus;
  startedAt: string;
  endedAt: string;
  duration: string;
  inputRows: string;
  outputRows: string;
  failedStage: string;
  errorSummary: string;
};

type JobDagStep = {
  completedAt?: string;
  duration?: string;
  id: string;
  title: string;
  meta: string;
  status: JobDagStepStatus;
  note?: string;
};
```

`duration`은 해당 단계의 실행 소요시간 표시값이고, `completedAt`은 단계가 성공 또는 실패로 종료된 시각이다. Backend가 아직 이 값을 수집하지 못한 경우 optional로 생략하며 frontend는 임의 시간을 계산하지 않고 미수집·진행 중·대기 상태를 표시한다.

### CatalogDataset

```ts
type CatalogDataset = {
  id: string;
  name: string;
  description: string;
  owner: string;
  createdBy?: string;
  createdByProfile?: {
    avatarInitials?: string;
    displayName: string;
    email?: string;
    role?: string;
  };
  permissionGrants?: PermissionGrant[];
  permissions?: ResourcePermissions;
  layer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  status: "available" | "approval_required";
  freshness: "latest" | "stale" | "approval";
  source: string;
  rows: string;
  size: string;
  quality: string;
  lastUpdated: string;
  nextRefresh: string;
  rag: boolean;
  tags: string[];
  schema: Array<[string, string]>;
  sampleRows: string[][];
  sourceRunId?: string;
  storageFormat?: string;
  storageLocation?: string;
  storageSizeBytes?: number;
  partition?: string;
  partitionColumns?: string[];
  indexColumns?: string[];
  materializationRuns?: Array<{
    runId: string;
    jobId: string;
    materializationMode?: "snapshot" | "delta";
    status: "queued" | "running" | "success" | "failed" | "canceled";
    createdAt: string;
    rowCount: number;
    storageSizeBytes: number;
    storageLocation?: string;
    sourceKind: "etl" | "sql" | "kafka";
    sourceLabel: string;
    sourceRanges?: Array<Record<string, unknown>>;
    publicationManifest?: string;
    sourceBoundary?: Record<string, unknown>;
    icebergCommittedAt?: string;
    icebergSnapshotId?: string;
    kafkaSnapshot?: Record<string, unknown>;
    queryEngineTable?: QueryEngineTableRef;
    storageFormat?: string;
    ruleContractVersion?: string;
    ruleFingerprint?: string;
    runtimeFingerprint?: string;
    schemaFingerprint?: string;
    transform?: Record<string, unknown>;
    quality?: Record<string, unknown>;
  }>;
  upstream: string[];
  downstream: string[];
  lineageGraph?: LineageGraph;
};
```

`size`는 화면 표시용 저장 크기 문자열입니다. 물리 저장 위치와 원시 byte 값은 `storageLocation`, `storageFormat`, `storageSizeBytes`를 사용합니다.
`materializationRuns`는 같은 Job/같은 dataset 이름으로 누적된 실행 또는 SQL materialize 결과 history입니다. 일반 ETL/SQL full refresh는 `materializationMode: "snapshot"`, Kafka 추가분은 `materializationMode: "delta"`입니다. history는 `icebergCommittedAt`, 없으면 `createdAt` 기준 newest-first로 정렬하고 snapshot ID로 멱등 갱신합니다. 늦게 복구된 과거 snapshot은 history와 합계에만 반영하며 현재 schema, sample, quality, `sourceRunId`, `queryEngineTable`을 과거 값으로 되돌리지 않습니다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 newest-first 성공 history에서 첫 snapshot까지의 active segment만 기준으로 계산합니다. mode가 없는 legacy Kafka Run은 delta, 그 외 Run은 snapshot으로 읽습니다.

### Source Connector Defaults

`GET /api/etl/sources/defaults`는 새 Source draft에 사용할 비밀이 아닌 runtime 기본값을 반환합니다.

```ts
type SourceConnectorDefaults = {
  kafkaBroker: string; // ASKLAKE_KAFKA_BROKER, fallback 127.0.0.1:19092
  kafkaTopic: string; // ASKLAKE_SOURCE_DEFAULT_KAFKA_TOPIC -> ASKLAKE_KAFKA_TOPIC -> asklake-source-events
  s3Bucket: string; // ASKLAKE_SOURCE_DEFAULT_S3_BUCKET -> ASKLAKE_RAW_BUCKET -> empty
  s3Prefix: string; // ASKLAKE_SOURCE_DEFAULT_S3_PREFIX -> empty
};
```

Frontend는 새 빈 draft에서만 이 응답을 한 번 적용합니다. 저장된 Job을 수정하거나 사용자가 값을 입력한 뒤에는 기존 `sourceConfig`를 덮어쓰지 않습니다. 응답은 비밀이 아닌 연결 위치만 제공하며 credential은 포함하지 않습니다. 실제 연결과 실행은 request에 저장된 값을 사용합니다.

### Schema Type and Source Path Contract

Source connector의 JSON/JSONL profile은 preview cell 문자열을 다시 정규식으로 추측하지 않고 원본 JSON token을 사용한다. JSON string은 내용이 숫자나 ISO timestamp 형태여도 `String`, integer number는 `Long`, real number는 `Double`, object/array는 `JSON`이다. CSV/TSV/TXT처럼 native token 정보가 없는 source만 기존 문자열 기반 추론을 사용하며 실수 결과는 `Double`로 정규화한다.

Canonical schema type은 `String`, `Integer`, `Long`, `Double`, `Boolean`, `Timestamp`, `Date`, `JSON`이다. 기존 Job과 외부 payload의 `Float`는 `Double` 호환 alias로 수용하지만 frontend가 새 draft를 생성하거나 수정 저장할 때는 `Double`을 보낸다.

`SchemaColumnDraft.sourceName`은 `raw.reviewerID` 같은 원본 source path이고 `targetName`은 `raw_reviewerID` 같은 물리 output alias다. Transform step의 `input`과 lineage는 source path를 사용하며 target write는 alias를 사용한다. Kafka Continuous는 dotted path로 nested Spark schema를 구성하고 root/nested object별 unknown field를 검사하므로 `raw` object 자체를 unknown field로 오인하지 않는다. scalar/object가 같은 path를 동시에 점유하는 모호한 schema는 worker 시작 전에 거절한다.

`nullable: false`는 output schema 제약이며 그 자체로 Quality Rule 수에 포함되지 않습니다. 사용자가 지정하는 `누락 시 기본값`은 `transform:default_value`, `필수값`은 그 다음 순서의 `transform:null_guard`로 저장합니다. 명시적 Null Guard의 `onError`는 `fail_batch`(`Fail Run`)이며 기본값 적용 뒤에도 값이 비어 있을 때 실행을 중단합니다. 필수 필드에는 중복 `quality:not_null`을 새로 만들지 않습니다. 선택형 `quality:not_null`은 필수가 아닌 필드에서 누락을 별도 품질 사건으로 다룰 때만 사용하며, 이미 NULL인 값에 `set_null`을 적용하는 조합은 UI에서 제공하지 않습니다. 사용자가 필수값을 해제하면 편집기에 남은 explicit Null Guard marker도 함께 제거합니다. `severity`는 V1 payload 호환을 위해 보존하지만 현재 runtime action 분기에는 사용하지 않습니다.

Rule compiler는 Regex의 비어 있지 않은 유효 pattern, Accepted Values의 1개 이상 값, Range의 유효한 min/max와 `min <= max`, boolean inclusive를 검증합니다. V1 mask policy는 `phone`(`keep first 3 digits` legacy alias), timestamp format은 `ISO-8601`(`UTC` legacy alias)만 허용합니다. Frontend, FastAPI, Node compiler는 같은 fixture와 `RULE_PARAMETER_REQUIRED`/`RULE_PARAMETER_INVALID` issue code를 사용하고 JSON root의 dotted input path를 동일하게 판정합니다.

### Kafka Snapshot Metadata and Iceberg Target

Kafka run은 다음 snapshot metadata를 response, Run metadata, Catalog materialization run에 보존한다. Job command 경로는 중간 RAW landing과 final JSONL data object 없이 저장된 included `schemaColumns`를 범용 JSON object 입력 계약으로 사용하고, supported transform/quality와 exact projection을 적용한 뒤 backend-owned Iceberg append target에 저장한다. Job identity가 없는 direct ingest endpoint만 fixture/debug 호환용 normalized review JSONL과 `event_id`, `offset`, `review`, `created_at` 필수 계약을 유지한다.

Job command bridge는 `schemaColumns`와 compiled `outputSchema`를 ingest runtime에 전달한다. runtime은 Rule 적용 뒤 이 계약으로 exact projection하며 rename 전 source field와 `included: false` field를 Iceberg target schema, Catalog schema, sample에 포함하지 않는다. Kafka Snapshot create/update의 `RAW/BRONZE/SILVER + JSONL`과 Kafka Continuous의 `Parquet` 조합은 기존 UI/저장 row 호환 계약이고, 실제 Job Dataset은 검증된 `storageFormat=iceberg`와 warehouse Parquet를 사용한다. review/create/update/command는 지원하지 않는 조합을 `TARGET_LAYER_UNSUPPORTED` 또는 `TARGET_FORMAT_UNSUPPORTED`로 선제 거절한다.

```ts
type KafkaPartitionSnapshot = {
  partition: number;
  startOffset: string;
  highWatermark: string;
  endOffset: string; // exclusive
};

type KafkaSnapshot = {
  snapshotId: string;
  capturedAt: string; // ISO 8601
  topic: string;
  consumerGroupId: string;
  offsetPolicy: "earliest" | "latest";
  partitions: KafkaPartitionSnapshot[];
};
```

성공한 Snapshot Job run은 `sourceKind: "kafka"`, target layer, Iceberg warehouse location, `KafkaSnapshot`, `icebergCommit.sourceBoundary`, transform/quality summary와 `queryEngineTable`을 함께 기록한다. Iceberg commit 또는 Trino/Catalog 검증이 실패하면 Kafka offset을 commit하지 않으며, quality `Fail Run`도 Iceberg commit 전에 중단한다. `Quarantine` 행은 같은 snapshot metadata prefix의 별도 JSONL object로 분리한다. 같은 `snapshotId` 재시도는 Iceberg table의 source marker를 조회해 이미 commit된 append를 `reuse`하고 Catalog materialization run도 snapshot ID로 deduplicate한다. offset은 이 모든 검증 뒤에만 `endOffset`으로 확정한다. 상세 전환 계약은 `docs/kafka-snapshot-direct-target-contract.md`를 따른다.

Kafka Job command가 실패하면 `JobRunSummary.status`는 `failed`이며 `taskStates.kafkaSnapshot`으로 captured range를, `failedStage`로 실패 위치를 유지한다. direct ingest endpoint error response의 `error.details.bridge`도 같은 snapshot diagnostic을 포함한다.

### Kafka Continuous Runtime

Issue #500 defines `executionMode: "snapshot" | "continuous"` on Kafka Job creation. Existing and migrated Kafka Jobs default to `snapshot`. `continuous` is immutable after creation and adds `continuousConfig` (`initialOffsetPolicy`, `triggerIntervalSeconds`, `maxOffsetsPerTrigger`, `schemaEvolutionPolicy`, `checkpointPath`) plus `continuousRuntime` (`status`, `desiredState`, `observedState`, `stateRevision`, `fencingToken`, heartbeat, lag, last flush, counters, Rule identity, `lastError`, `errorDetail`) to `JobRowData`. `status`와 `lastError`는 기존 client를 위한 호환 field이며 신규 상태·오류 field는 additive다. 상세 소유권과 전이 규칙은 [Continuous runtime 상태·오류 소유권](refactor-2026/contracts/runtime-state-ownership.md)을 따른다.

`startContinuous`, `pauseContinuous`, `resumeContinuous`, and `stopContinuous` are command extensions of `POST /api/etl/jobs/{jobId}/commands`. In an embedded local runtime they launch or signal a Spark Structured Streaming worker. In production web/API mode they first persist intent and return `processingResult.controlPlaneOnly=true`; the separately deployed, PostgreSQL-lease-owning Continuous worker alone performs the Spark side effect. Both modes reject conflicting active Snapshot or Continuous consumer identity with `409`, and use a durable Spark checkpoint as source-progress authority. Start/resume also passes PostgreSQL topic/partition `nextOffset` watermarks; `foreachBatch` filters older offsets before any write so a full duplicate is skipped and a partial overlap publishes only the unseen suffix. Each non-empty filtered batch derives a deterministic Run/source boundary from Job, checkpoint, consumer identity, a durable publication sequence and offset ranges, then appends `_asklake_run_id`-marked rows to the persisted Iceberg target. Spark raw batch ID is diagnostic only. A failure after Iceberg commit and before manifest/checkpoint completion reuses the same committed marker on retry instead of appending duplicates. Job hydrate verifies the exact reported snapshot and exact `_asklake_run_id` row count through Trino before Catalog cursor advancement and does this reconciliation before worker liveness failure handling. A terminal stale report window is recovered by listing completed S3 manifests after the acknowledged cursor; an incomplete last manifest never advances the ACK. An exited/missing/stale worker becomes `failed` only while active, and intentional pause/stop exits complete as `paused`/`stopped`. See [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md).

When `ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX` is an `s3://` or `s3a://` URI, runtime report, command, and Catalog ACK documents are shared S3 objects rather than local files. The API reads/writes them through the configured S3-compatible client and the Spark driver uses Hadoop S3A. The documents are status/command transport only; PostgreSQL `desiredState`, `stateRevision`, and `workerAttemptId` remain the command-order and fencing authority.

`ASKLAKE_CONTINUOUS_SPARK_RUNNER=kubernetes` changes only the Kafka Continuous runner gateway: it creates, gets, and deletes a Spark Operator `SparkApplication` and does not alter the normal finite batch `ASKLAKE_SPARK_RUNNER` contract. The Kubernetes mode rejects startup unless its runtime-document prefix, namespace, service account, and digest-pinned runtime image are configured.

Issue #567 Phase 5 compiles supported stateless `rules[]` into the Continuous worker. Every micro-batch applies canonical Transform/Quality before target publication. `_asklake_contract` checkpoint metadata and every publication signature/manifest bind `schemaFingerprint`, `ruleFingerprint`, and `runtimeFingerprint`; mismatch fails before query start. `Fail Batch` leaves the micro-batch uncommitted, while Rule quarantine stores Kafka position plus `ruleId`, `stage`, `targetColumn`, and fingerprints. Catalog `materializationRuns` retain the same execution identity and Transform/Quality result.

Frontend `DraftPipeline.source` carries optional `executionMode` and `continuousConfig`; `executionMode: "continuous"` serializes them into Job creation. `JobRowData` includes optional `continuousRuntime` for lifecycle controls and runtime display.

Snapshot Job은 기존 스케줄 단계에서 수동 또는 반복 실행 정책을 저장한다. Continuous Job은 그 단계를 건너뛰며 `scheduleLabel: "스케줄링 건너뛰기"`, stream lifecycle 설명, `continuousConfig`만 생성 request에 보낸다. Continuous의 시작 위치, trigger 간격, micro-batch 최대 메시지는 Source 단계의 접힌 고급 설정에서 지정한다.

### Kafka Replay Producer

`GET|POST|DELETE /api/etl/kafka/replay-producer`는 Continuous 적재를 수동 검증할 때만 쓰는 admin `manage` 도구다. producer 상태는 process-local이며 backend 재시작 또는 배포 교체 시 함께 종료된다. `POST` body는 아래와 같고 topic 삭제를 요청할 수 없다.

```ts
type KafkaReplayProducerRequest = {
  topic?: string; // default: reviews.raw
  inputPath?: string; // ASKLAKE_REPLAY_INPUT_DIR 아래 상대 경로
  payloadMode?: "json_envelope" | "raw_text"; // default: json_envelope
  rate?: number; // default: 10 messages/sec
  batchSize?: number; // default: 100
  progressEvery?: number; // default: 100
  loop?: boolean; // default: true
  maxCycles?: number;
  maxMessages?: number;
  cycleDelayMs?: number;
  burstMinMessages?: number;
  burstMaxMessages?: number;
  burstIntervalSeconds?: number;
};
```

`payloadMode=json_envelope`은 기존 JSONL fixture를 파싱하고 cycle별 `event_id` suffix와 전역 증가 `offset`을 보장한다. `payloadMode=raw_text`는 `inputPath`를 필수로 받고 `.txt`, `.log`, `.jsonl` 또는 gzip 파일의 비어 있지 않은 각 줄을 JSON 변환 없이 Kafka message value 그대로 전송한다. raw mode에서는 파일 확장자가 아니라 실제 줄 내용이 원문 계약이다. 따라서 `{...}`로 시작하는 기존 JSONL을 지정하면 Kafka JSON으로 계속 탐색되며 레코드 구조화가 열리지 않는다. 레코드 구조화 데모에는 공백 구분 10필드가 그대로 저장된 `click-events.log`를 지정해야 한다. burst 세 필드는 함께 지정해야 하며, loop 중 매 `burstIntervalSeconds`마다 `burstMinMessages`~`burstMaxMessages`의 랜덤 건수를 한 burst로 전송한다. `DELETE`는 SIGTERM을 보내 현재 send batch를 마친 뒤 연결을 닫도록 요청하며, 응답은 `running`, `pid`, `sentMessages`, `completedCycles`, bounded `logs`를 반환한다.

Continuous runtime operations:

```text
GET  /api/etl/jobs/{jobId}/continuous/logs?tail=200
GET  /api/etl/jobs/{jobId}/continuous/sessions
GET  /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}
GET  /api/etl/jobs/{jobId}/continuous/sessions/{sessionId}/batches?limit=100
GET  /api/etl/jobs/{jobId}/continuous/quarantine?limit=100
GET  /api/etl/jobs/{jobId}/continuous/maintenance-runs
POST /api/etl/jobs/{jobId}/continuous/quarantine/replays
POST /api/etl/jobs/{jobId}/continuous/compactions
POST /api/etl/jobs/{jobId}/continuous/iceberg-maintenance
```

`startContinuous`와 `resumeContinuous`는 각각 새 `KafkaContinuousSession`을 만들고 시작 시점의 누적 runtime counter를 baseline으로 저장한다. worker report를 읽을 때 session counter는 `현재 누적값 - baseline`으로 계산되므로 checkpoint를 이어받는 재시작에서도 이전 세션 수치가 섞이지 않는다. pause와 stop은 session을 `stopping`에서 `stopped`로, worker/container/heartbeat 실패는 `failed`로 끝내며 `endedAt`, `endReason`, `lastError`를 보존한다. `publishedBatches`는 `(sessionId, batchId)` unique key로 멱등 저장되고 시작 전 `lastBatchId` 이하의 복구 manifest는 새 session batch로 다시 기록하지 않는다.

Phase 6부터 session과 batch는 `dagSteps`로 Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, Catalog 7단계 증적을 반환한다. 각 단계는 status, input/output 근거, duration, error를 포함할 수 있다. 성공 publication의 Catalog 단계는 `catalogBatchCursor >= batchId`일 때만 `success`이고 그 전에는 `pending`이다. `Fail Batch`는 checkpoint와 manifest를 전진시키지 않지만 worker의 `lastBatchEvidence`로 `status: "failed"`, `lastError`, 실패 단계와 이후 `blocked` 단계를 DB에 남긴다. 규칙이 없는 Transform/Quality는 `meta: "pass-through"`로 표시한다.

```ts
type KafkaContinuousSession = {
  sessionId: string;
  jobId: string;
  workerAttemptId: string | null;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  failedCount: number;
  lastBatchId: string | null;
  lastFlushAt: string | null;
  lag: number | null;
  checkpointPath: string;
  lastError: string | null;
  dagSteps: JobDagStep[];
};

type KafkaContinuousBatch = {
  batchId: number;
  sessionId: string;
  status: "running" | "success" | "failed";
  publishedAt: string | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  durationMs: number | null;
  sourceRanges: Array<{ topic: string; partition: number; startOffset: number; endOffset: number }>;
  sourceBoundary: Record<string, unknown>;
  dataPath: string | null;
  icebergSnapshotId: string | null;
  icebergTableUri: string | null;
  quarantinePath: string | null;
  manifestPath: string | null;
  lastError: string | null;
  dagSteps: JobDagStep[];
};
```

`continuousRuntime` additionally exposes `desiredState`, `observedState`, `stateRevision`, `fencingToken`, `errorDetail`, `maxPartitionLag`, `laggingPartitionCount`, `lagAvailable`, `partitionProgress`, `lastBatchDurationMs`, `lastBatchInputRows`, `throughputRowsPerSecond`, `replayedCount`, `schemaVersion`, `schemaFingerprint`, `schemaStatus`, `schemaChanges`, `ruleContractVersion`, `ruleFingerprint`, `runtimeFingerprint`, `ruleMetrics`, and `lastRuleResult`. `stateRevision` is monotonic per accepted command and worker observations do not increment it. `errorDetail` contains `stage`, `code`, `message`, `retryable`, and optional redacted `context`; legacy rows derive it from `lastError` without a data migration. `ruleMetrics` contains cumulative transform/quality warn, quarantine, drop, set-null, invalid/error, and failed-batch counts. `replayedCount` prevents recovered quarantine rows from being double-counted: `storedCount + quarantinedCount - replayedCount = consumedCount`. Worker logs are limited to 1,000 lines, ANSI-stripped, and redact common key/token/password assignments.

Quarantine replay accepts optional `offsets` values in `partition:offset` form and `approveUnknownFields` (default `false`). It reads only completed quarantine sidecars, reapplies the Job's current schema evolution policy and canonical Rule set, anti-joins Kafka offsets already present in the Iceberg target, and appends recovered rows with a deterministic maintenance `_asklake_run_id`. `ruleRejectedCount` identifies rows still rejected by current Rules. `approveUnknownFields: true` requires Job `manage` permission, relaxes only unknown-field handling, and records an audit event plus `policyOverride`; it cannot bypass Transform/Quality. Replay never rewinds the Kafka consumer group. Its result includes `icebergCommit`, `sourceBoundary`, `sourceRanges`, and `catalogApplied`; successful data with pending Catalog verification is retried when maintenance history is read.

`POST /continuous/compactions` accepts `{ targetFileSizeMb?: number }` (default 256, 128~512) and executes Iceberg `rewrite_data_files`; it does not rewrite legacy `_batches` paths or mutate the streaming checkpoint. `POST /continuous/iceberg-maintenance` accepts the following body. At least one operation must be enabled.

```ts
type ContinuousIcebergMaintenanceRequest = {
  rewriteDataFiles?: boolean; // default true
  targetFileSizeMb?: number; // default 256, 128..512
  expireSnapshots?: boolean; // default false
  snapshotRetentionHours?: number; // default 168, 24..8760
  retainLastSnapshots?: number; // default 10, 1..1000
  removeOrphanFiles?: boolean; // default false
  orphanRetentionHours?: number; // default 168, 72..8760
};
```

Quarantine inspection/replay와 Iceberg maintenance는 worker가 paused/stopped일 때만 실행하며 다른 maintenance run과 직렬화한다. Worker start/resume과 maintenance 시작은 같은 Job row lock -> runtime row lock 순서로 확인하므로 서로 경합해도 한쪽만 외부 Spark 작업을 시작한다. Rewrite-only는 Job `run`, snapshot expiration/orphan cleanup은 Job `manage` 권한을 요구한다. 삭제성 작업은 기본 비활성화되고 retention cutoff를 명시해야 한다. 성공 result는 `tableUri`, `snapshotIdBefore/After`, 전후 file/byte/snapshot count, operation별 Spark 결과, Trino가 재검증한 `icebergSnapshotId`, `queryEngineTable`, `warehouseLocation`, `queryEngineVerified=true`를 포함한다. 물리 maintenance는 논리 데이터 적재가 아니므로 새 Catalog materialization run을 만들지 않는다. Each persisted run has a lease (`ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS`, default 900). Backend는 REST runner의 durable `updatedAt` heartbeat가 `ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS`(default 30) 이내이면 만료된 DB lease를 갱신한다. Runner heartbeat가 없거나 stale일 때만 고아 Spark submission/container를 한 번 정리하고 run을 실패 처리하며, 이미 terminal인 runner는 kill하지 않는다.

### LineageGraph

```ts
type LineageGraph = {
  datasetId: string;
  datasets: Array<{
    id: string;
    name: string;
    layer: "SOURCE" | "PROCESS" | "RAW" | "BRONZE" | "SILVER" | "GOLD" | "CONSUMER";
    engine: string;
    columns: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  }>;
  edges: Array<{
    fromDatasetId: string;
    fromColumnId: string;
    toDatasetId: string;
    toColumnId: string;
  }>;
};
```

`LineageGraph`는 화면 좌표나 렌더링 스타일을 포함하지 않습니다.
백엔드는 dataset/column/edge 관계만 반환하고, 프론트는 이를 React Flow node/edge와 column row handle로 변환합니다.
`CatalogDataset.upstream`과 `CatalogDataset.downstream`은 요약/fallback context로 유지할 수 있습니다.

### SqlResultDraft (legacy DuckDB compatibility)

```ts
type SqlResultDraft = {
  runId: string;
  baseDatasetId?: string;
  datasetId: string;
  datasetName: string;
  query: string;
  referenceDatasetIds?: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
  executedAt: string;
  mode?: "preview" | "run";
  previewLimit?: number;
  pageLimit: number;
  pageOffset: number;
  returnedRows: number;
  rangeStart: number;
  rangeEnd: number;
  hasNext: boolean;
  validationKey?: string;
};
```

새 Trino Query Run의 canonical type은 7.7과 [Trino Query Run Contract](trino-query-run-contract.md)를 따릅니다. 이 type은 `TRINO_ENABLED=false`의 DuckDB snapshot과 기존 consumer 호환에만 사용합니다.

### 6.8 Trino SQL Validation And Repeat Job

`POST /api/query/validate`는 SQL을 실행하지 않고 Trino dialect 기준 단일 read-only statement, 선택 Dataset mapping, 현재 actor의 `query` 권한과 governance control을 검증합니다. Frontend PostgreSQL parser는 자동완성/오타 안내용이며 이 endpoint의 성공이 Trino 실행 버튼 활성화의 canonical 조건입니다.

Request:

```ts
type TrinoQueryValidationRequest = {
  baseDatasetId: string;
  query: string;
  referenceDatasetIds: string[];
};
```

Response `200 OK`:

```ts
type TrinoQueryValidationResponse = {
  canExecute: true;
  normalizedQuery: string;
  referencedDatasetIds: string[];
};
```

`POST /api/etl/sql-jobs`는 성공한 Trino Query Run에서 반복 실행용 SQL recipe Job을 생성합니다. source Run 제출자 또는 admin만 호출할 수 있고, Dataset을 조회할 수 있더라도 다른 사용자의 Run이면 `403`을 반환합니다. request의 query/base/reference identity도 persisted Run과 정확히 일치해야 합니다.

```ts
type CreateTrinoSqlJobRequest = {
  baseDatasetId: string;
  dataset: {
    description: string;
    layer: "SILVER" | "GOLD";
    name: string;
    rag: false;
    refreshPolicy: "manual";
    tags: string[];
  };
  governance: {
    accessScope: "organization" | "private" | "project";
    owner: string;
    permissionSummary: string;
    principalId?: string;
  };
  jobName?: string;
  query: string;
  referenceDatasetIds: string[];
  schedule: {
    mode: "manual" | "daily" | "weekly";
    overlapPolicy: "skip_if_running";
    time: string;
    timezone: string;
    weekday: "월" | "화" | "수" | "목" | "금" | "토" | "일";
  };
  sourceRunId: string;
  target: {
    partitionColumn?: string;
    writeMode: "full_refresh";
  };
};
```

`governance.owner`는 현재 session actor를 기본으로 하며 공백 제거 후 비어 있으면 거부합니다. `accessScope="private"`는 owner의 자동 권한만 사용하고 별도 role을 중복 생성하지 않습니다. `organization`은 `principalType="public"`, `principalId="authenticated-users"`를 사용합니다. `project`는 현재 actor가 선택한 실제 group ID를 `principalId`로 반드시 전달해야 하며 누락하면 `422 VALIDATION_ERROR`입니다. Backend는 이 canonical principal metadata로 `permissionRoles`와 `permissionSummary`를 다시 계산하므로 client가 임의 demo 그룹명을 저장할 수 없습니다.

Response는 기존 `CreatePipelineResponse`를 재사용하며 `job.jobKind="trino_sql_materialization"`, `job.sqlRecipe`, `catalogTarget.status="pending_run"`을 포함합니다. Job 생성 자체는 Dataset을 만들지 않습니다.

이 Job의 `POST /api/etl/jobs/{jobId}/commands` 규칙:

- `run`/`retry`: 실행 시점 Dataset 권한을 다시 검사하고 저장 SQL을 고유 Iceberg table에 CTAS한다.
- `cancelRun`: collector generation을 먼저 fence하고 Trino cancel을 요청하며 공개되지 않은 target을 정리한다.
- 성공: `DESCRIBE` 검증 뒤 같은 논리 Dataset ID의 `queryEngineTable`을 새 table로 교체하고 `materializationRuns`에 run-keyed 성공 이력을 추가한다.
- 실패/취소: 기존 정상 Dataset mapping과 성공 이력을 보존한다.
- collector 재시작: terminal이지만 `finalized=true`가 없는 SQL Job Run을 다시 claim해 Catalog 확정을 멱등 수행한다.
- `schedule.mode=daily|weekly` Job은 `POST /api/etl/schedules/run-due`를 `kafkaOnly=false`로 호출해야 하며, source 권한은 `sqlRecipe.runAs` actor로 재검사한다.


## 7. P0 API

### 7.0 Source 연결 검증과 대상 선택

Source 연결 검증과 schema preview는 서로 다른 요청이다.

- `POST /api/etl/sources/assets`는 S3·PostgreSQL·MongoDB 연결 정보를 검증하고 탐색 가능한 파일·폴더·테이블·컬렉션 목록만 반환한다.
- 이 응답은 schema draft를 확정하지 않으며 특정 대상을 자동 선택하지 않는다.
- 사용자가 탐색 화면에서 단일 대상을 선택하면 frontend는 선택값을 `DATASET OR TABLE SELECTOR` 또는 `__Selected Object`에 넣어 `POST /api/etl/sources/test`를 호출한다.
- File / S3 폴더 disclosure는 하위 항목을 여는 탐색 action이다. 사용자가 별도 prefix 데이터셋 선택 action을 실행하면 frontend는 `Path / Prefix=<canonical prefix>`, `__Selection Kind=prefix`, 빈 `__Selected Object`를 저장하고 `/sources/test`를 호출한다.
- Prefix는 임의 파일 배열이 아니라 같은 데이터셋 조각이 모인 경로다. Backend는 그 아래를 재귀 조회해 `_SUCCESS`, `manifest.json`, basename이 `_` 또는 `.`으로 시작하는 객체, directory marker와 선택 형식이 아닌 객체를 제외한다. 남은 모든 파일의 bounded schema fingerprint가 같아야 성공한다.
- PostgreSQL과 MongoDB의 `/sources/test`는 선택값이 없으면 `400`을 반환한다. 첫 테이블이나 첫 컬렉션으로 자동 대체하지 않는다.

```ts
type SourceAssetsResponse = {
  assets: Array<[name: string, namespaceOrType: string, status: string]>;
  count: number;
  limit: number;
  prefix: string;
};

type SourceDatasetSummary = {
  selectionKind: "prefix";
  bucket: string;
  prefix: string;
  format: "CSV" | "TSV" | "JSON" | "JSONL" | "TXT";
  fileCount: number;
  totalBytes: number;
  excludedFileCount: number;
  representativeObject: string;
  schemaFingerprint?: string;
  schemaCompatible: boolean;
};

type SourceConnectorAnalysis = {
  actionPath: string;
  assets: Array<[string, string, string]>;
  datasetSummary?: SourceDatasetSummary;
  draftPatch: DraftPipelinePatch;
  logs: string[];
  message: string;
  previewColumns: string[];
  previewNote: string;
  previewRows: string[][];
  status: "idle" | "testing" | "success" | "failed";
  testItems: Array<[string, string]>;
};
```

성공한 Prefix Preview의 `draftPatch.source.sourceConfig`에는 `Path / Prefix`, `__Selection Kind`, `__Dataset Format`, `__Source Unit Count`, `__Source Total Bytes`, `__Sample Object`, `__Schema Fingerprint`, `__Excluded File Count`를 보존한다. Job create/hydrate는 이 목록을 그대로 저장하지만 개별 object key 배열은 저장하지 않는다. `datasetSummary`는 Preview 표시용 구조화 응답이며 credential을 포함하지 않는다.

현재 Prefix Preview의 호환성 검사는 row-oriented `CSV`, `TSV`, `JSON`, `JSONL`, `TXT` 조각을 대상으로 한다. 단일 Parquet object 선택은 기존 Spark schema inspector를 계속 사용하며, 여러 Parquet part의 footer-level 통합 schema 검증은 후속 범위다.

### 7.0.1 Record Parsing Preview

조건부 1.5단계는 이름 있는 필드가 없는 MinIO/S3 TXT와 Kafka raw text 입력에 적용한다. Source 단계에서 제한 샘플이 `line_number`, `value` 형태이고 backend가 `detectedFormat=TXT`, `requiresRecordParsing=true`를 반환하면 frontend는 `/etl/record-parsing`으로 이동한다. PostgreSQL, MongoDB JSON, Kafka JSON envelope, JSON/JSONL object, Parquet, 이름 있는 CSV는 이 단계를 건너뛴다.

`line_number`, `value`와 `draftPatch.source.rawPreviewLines`는 Source API와 다음 단계 사이의 운반 계약일 뿐 Source 탐색의 정형 스키마가 아니다. Frontend는 `detectedFormat=TXT`, `requiresRecordParsing=true`인 File/S3에서 원문만 추출해 줄바꿈 보존 text block으로 표시한다. Kafka Source는 payload 형식과 관계없이 broker에서 읽은 원래 message `value` 문자열을 `rawPreviewLines`에 순서대로 보존한다. JSON/JSONL message는 compact JSON 원문을 `Kafka JSON 원본 샘플`로 표시하고 nested field를 공백 로그로 복원하거나 레코드 구조화 입력으로 바꾸지 않는다. 이름 있는 Kafka JSON은 `requiresRecordParsing=false`로 Schema 단계로 이동하며, 실제 message value가 JSON/CSV가 아닌 raw text로 감지된 경우에만 `detectedFormat=TXT`, `requiresRecordParsing=true`로 레코드 구조화 단계를 연다.

Kafka Source API가 `draftPatch.source.requiresRecordParsing=true`와 함께 `detectedFormat`, `rawPreviewLines`를 명시적으로 반환하면 frontend는 해당 값을 보존하고 공통 Record Parsing 단계로 이동한다. Kafka Snapshot/Continuous runtime은 확정된 같은 `recordParsing` 계약을 전체 입력에 적용한다.

`POST /api/etl/record-parsing/preview`

```ts
type RecordParsingColumnDraft = {
  position: number;
  name: string;
  inferredType: "String" | "Integer" | "Float" | "Boolean" | "Timestamp";
};

type RecordParsingDraft = {
  enabled: boolean;
  delimiterKind: "whitespace";
  delimiterPattern: "\\s+";
  header: boolean;
  expectedFieldCount: number;
  columns: RecordParsingColumnDraft[];
};

type RecordParsingPreviewRequest = {
  rawLines: string[];
  recordParsing: RecordParsingDraft;
};
```

Response `200 OK`:

```ts
type RecordParsingInvalidRow = {
  lineNumber: number;
  expectedFieldCount: number;
  actualFieldCount: number;
  rawPreview: string;
};

type RecordParsingPreviewResponse = {
  canApply: boolean;
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  recordParsing: RecordParsingDraft;
  totalRows: number;
  validRows: number;
  invalidRows: RecordParsingInvalidRow[];
};
```

규칙:

- 빈 줄과 앞뒤 공백은 무시하고, 연속 공백과 tab은 하나의 구분자로 처리한다.
- `header=true`이면 첫 번째 비어 있지 않은 행을 컬럼명으로 사용하고 데이터 행에서 제외한다.
- `expectedFieldCount=0`이면 데이터 행에서 가장 많이 나타난 필드 개수를 사용한다. 최빈값이 동률이면 `canApply=false`다.
- 컬럼명은 비어 있거나 중복될 수 없고 컬럼 수는 `expectedFieldCount`와 같아야 한다.
- Preview의 invalid row는 line number, expected/actual count, 200자 이하 raw preview만 반환한다.
- 부족한 값을 null로 채우거나 초과 값을 자르거나 오류 행을 조용히 버리지 않는다.
- `CreatePipelineRequest.recordParsing`은 확정된 규칙을 저장한다. File/S3 batch, Kafka Snapshot, Kafka Continuous runtime은 전체 입력에 같은 규칙을 다시 적용한다. Snapshot은 필드 수 또는 타입 변환 불일치를 invalid record로 처리하고, Continuous는 malformed record를 기존 실패 정책에 따라 중단 또는 격리한다.
- 이번 범위의 Kafka 원문 구조화는 메시지 하나가 한 줄이고 연속 공백(`\\s+`)으로 분리되는 단일 레코드만 지원한다. 임의 정규식, 복수 구분자와 멀티라인 메시지는 지원하지 않는다.

### 7.1 Target S3 Path Picker

Target 저장경로 UI는 긴 text input 대신 서버 API로 bucket/prefix를 조회하는 선택 UI를 사용합니다. 선택 결과는 기존 `storagePath` string에 그대로 저장합니다.

`GET /api/s3/buckets`

Response `200 OK`:

```ts
type S3BucketsResponse = {
  buckets: string[];
};
```

Response 예시:

```json
{
  "buckets": ["asklake-output"]
}
```

규칙:

- 서버는 Spark writer가 사용하는 `ASKLAKE_SPARK_OUTPUT_BUCKET`을 첫 번째로 반환하고, `S3_ALLOWED_BUCKETS` allowlist의 나머지 bucket을 중복 없이 뒤에 합칩니다.
- 설정이 없으면 local MinIO demo만 `asklake-output`을 반환할 수 있습니다. AWS mode는 잘못된 기본 bucket을 반환하지 않고 `503 SERVICE_UNAVAILABLE`을 반환합니다.
- 프론트에 저장된 기본 bucket이 응답 목록에 없으면 응답의 첫 번째 output bucket으로 교정합니다. 사용자가 명시적으로 선택한 유효 bucket은 보존합니다.
- 프론트는 bucket 목록을 표시만 하며 AWS credential을 보관하지 않습니다.

`GET /api/s3/prefixes?bucket=asklake-output&prefix=pair_a/`

Response `200 OK`:

```ts
type S3PrefixesResponse = {
  bucket: string;
  files: Array<{
    key: string;
    name: string;
    type: "file";
  }>;
  folders: Array<{
    name: string;
    prefix: string;
    type: "folder";
  }>;
  nextContinuationToken: string | null;
  prefix: string;
};
```

Response 예시:

```json
{
  "bucket": "asklake-output",
  "prefix": "pair_a/",
  "folders": [
    {
      "name": "customer_review_gold",
      "prefix": "pair_a/customer_review_gold/",
      "type": "folder"
    }
  ],
  "files": [],
  "nextContinuationToken": null
}
```

보안/검증:

- `bucket`은 allowlist에 있는 값만 허용합니다.
- `prefix`는 leading slash, backslash, 중복 slash를 정규화하고 `..`, control character, 과도한 길이를 거부합니다.
- 서버는 AWS SDK v3 `ListObjectsV2`에 `Delimiter="/"`를 넣어 folder prefix를 lazy loading합니다.
- AWS access key/secret은 서버 환경변수, profile, IAM role, 또는 MinIO endpoint 설정만 사용하며 브라우저 번들에 포함하지 않습니다.
- 로컬 개발에서 S3 연결이 없으면 서버 내부 fixture fallback을 사용할 수 있고, 운영에서는 `S3_DISABLE_FIXTURE_FALLBACK=true`로 끌 수 있습니다.

선택 결과:

- prefix 선택 시 `s3a://asklake-output/pair_a_customer_review_gold/gold/`처럼 trailing slash를 유지합니다.
- 기존 값이 `s3://...`이면 같은 scheme을 유지하고, scheme이 없으면 frontend 상수 `S3_SCHEME = "s3a"`를 사용합니다.
- 최종 create payload의 `storagePath` 필드 shape는 변경하지 않습니다.

### 7.1.1 Target DB Picker

Target 기본정보 UI는 `테이블명` 입력을 노출하지 않습니다. create payload 호환을 위해 `target.tableName`과 `target.targetTableName`에는 현재 `targetDataset` 값을 사용합니다.

`GET /api/target/databases`

Response:

```ts
type TargetDatabasesResponse = {
  databases: Array<{
    name: string;
    description: string;
  }>;
};
```

Example:

```json
{
  "databases": [
    { "name": "asklake", "description": "기본 AskLake 카탈로그 DB" },
    { "name": "asklake_gold", "description": "정제 Gold 데이터셋 저장 DB" }
  ]
}
```

Rules:

- frontend는 DB 이름을 직접 입력하지 않고 선택 UI로 `target.databaseName` string을 갱신합니다.
- 서버는 `TARGET_DATABASES` 또는 `ASKLAKE_TARGET_DATABASES`에 지정된 이름만 반환할 수 있습니다.
- 환경변수가 없으면 local demo 기본값으로 `asklake`, `asklake_gold`, `analytics`, `marketing`을 반환합니다.

### 7.2 Review snapshot

`POST /api/etl/review`

Request는 `CreatePipelineRequest`에 아래 필드를 추가합니다.

```ts
type ReviewPipelineRequest = CreatePipelineRequest & {
  sourceConnectionStatus: "idle" | "testing" | "success" | "failed";
};
```

Response는 Review 화면의 모든 표시값을 아래 shape로 반환합니다.

```ts
type ReviewSnapshot = {
  basicInformation: Array<{ label: string; value: string }>;
  schema: Array<{ columnName: string; type: string; nullable: string; transform: string }>;
  destination: Array<{ label: string; value: string }>;
  permission: Array<{ label: string; value: string }>;
  ruleCompilation: RuleCompilationResult;
  validation: Array<{ label: string; status: "ready" | "warning"; value: string }>;
  canCreate: boolean;
};
```

- `targetDatabase`, `targetDescription`은 Review 표시용으로 create/review request에 함께 보냅니다.
- backend는 source connector 결과를 재확인하며 실패 시 Review를 `확인 필요`로 반환합니다. frontend fixture로 성공 상태를 대체하지 않습니다.
- 내부 `Data Lake` source는 `sourceConfig`의 `Source Dataset ID`를 기준으로 Catalog dataset을 다시 검증합니다. dataset은 `available` 상태이며 현재 actor가 조회할 수 있어야 하고, `queryEngineStatus=available`인 Iceberg `queryEngineTable`을 가져야 합니다. 실제 Snapshot Run은 이 table identity를 Spark catalog source로 읽습니다. `Data Lake Parquet`은 이 계약과 별개로 S3/S3A path connector 검증을 유지합니다.
- Review UI는 local draft를 직접 조합하지 않고 이 response를 표시합니다.
- `basicInformation`은 내부 `id`와 자동 생성용 `jobName`을 제외하고 소스, 처리 방식, 출력 데이터셋 이름, 설명을 반환합니다. `executionMode=snapshot`은 `배치 처리`, `executionMode=continuous`는 `실시간 스트리밍`으로 표시합니다.
- `permission`은 `담당자`, `로그인한 모든 사용자`, non-public 대상별 허용 action을 반환합니다. 담당자는 backend fallback으로 전체 권한을 가지며 `public:view`는 `로그인한 모든 사용자=조회 가능`으로 표시합니다. optional `principalName`이 있으면 대상 ID 대신 사람이 읽는 이름을 표시합니다.
- `validation`은 실제 생성 차단 조건인 소스 데이터, 선택형 레코드 구조화, 출력 스키마, 처리 규칙, 접근 권한, 저장 위치만 반환합니다. 스케줄과 실패 재시도는 별도 단계에서 설정하지만 `canCreate`를 막지 않으므로 준비 상태에 포함하지 않습니다.
- `ruleCompilation.status`가 `pass`일 때만 `canCreate`가 true가 될 수 있습니다. `rules`가 비어 있으면 output schema는 포함된 source schema와 같은 pass-through 결과이며 `ruleSummary`가 비어 있어도 실패하지 않습니다.

### 7.3 작업 목록 조회

`GET /api/etl/jobs`

작업 현황의 상태 버튼과 `실행 주기` 컬럼 필터는 이 endpoint를 사용한다. 목록을 프론트엔드에서 임의로 잘라내지 않고, live mode에서는 선택한 조건을 query parameter로 서버에 전달한다.

이 endpoint는 저장된 목록 상태를 읽는 read-only 경로다. 요청 중 Airflow/Kafka/Node/Spark 상태를 확인하거나 runtime/permission row를 갱신하지 않는다. Job, Job별 최신 Run 1개, Continuous runtime, permission/governance 자료는 종류별 일괄 조회한다. 목록의 각 `JobRowData.runHistory`는 비어 있거나 최신 Run 1개만 포함한다. 전체 Run history와 상세 hydrate는 `GET /api/etl/jobs/{jobId}`가 담당하며 이 상세 GET도 외부 runtime 호출과 DB write를 수행하지 않는다.

Query parameter:

- `status`: 0개 이상 반복 가능한 job status. 목록 UI 예: `?status=running&status=stopped`. 저장된 legacy `failed`, `canceled`, `paused` 상태는 목록 응답에서 `scheduled`로 정규화한다.
- `owner`: 정확히 일치하는 소유자 1명. 예: `?owner=analytics`
- `lastRunOutcome`: `success`, `failed`, `canceled` 중 하나. 최근 Run 결과로 목록을 필터링한다.
- `scheduleKind`: `daily`, `weekly`, `monthly`, `realtime`, `none`, `other` 중 하나. 서버는 저장된 schedule label을 기준으로 분류한다.

Response `200 OK`:

```ts
type GetJobsResponse = {
  jobs: JobRowData[];
  facets: {
    latestRunOutcomeCounts: Record<"success" | "failed" | "canceled", number>;
    owners: string[];
    total: number;
    statusCounts: Record<JobStatus, number>;
  };
};
```

`facets`는 현재 선택한 filter와 무관한 전체 목록 기준이다. 따라서 소유자 한 명을 선택한 뒤에도 `owners`에는 등록된 모든 소유자가 유지되고, 현황 버튼도 전체 작업의 상태 분포를 유지한다.

Jobs 화면의 실패 작업 경고와 `실패 작업 보기`는 최근 Run 결과가 아니라 현재 Job 상태를 기준으로 한다. 경고 개수는 `statusCounts.failed`, 필터 요청은 `status=failed`를 사용한다. `latestRunOutcomeCounts.failed`와 `lastRunOutcome=failed`는 Snapshot 실행 이력이 있는 작업의 최근 실행 결과를 다룰 때만 사용하며, Run 이력이 없을 수 있는 Kafka Continuous 실패 작업의 현재 상태 집계에는 사용하지 않는다.

각 `JobRowData`는 DB timestamp 기준의 optional `createdAt`, `updatedAt`을 포함한다. 목록 소유자 셀은 `updatedAt`을 우선 표시하고, legacy row처럼 수정 시각이 없을 때만 `createdAt`을 표시한다.

### 7.3.1 작업 상태 일괄 조회

`GET /api/etl/jobs/statuses?jobId={jobId}&jobId={jobId}` returns a lightweight persisted status snapshot. A Continuous Job additionally includes the additive `continuousRuntime` contract; client polling must use `stateRevision` to reject stale responses.

Jobs 화면이 실행 중인 여러 Snapshot Job의 상태를 한 번에 갱신할 때 사용한다. `jobId`는 중복을 제거한 뒤 최대 100개까지 받는다. 빈 요청은 빈 배열을 반환하고, 존재하지 않거나 현재 actor가 볼 수 없는 Job은 응답에서 제외한다. 이 endpoint는 저장된 DB 상태만 읽으며 Airflow를 호출하거나 상태를 저장하지 않는다.

Response `200 OK`:

```ts
type JobStatusSnapshot = {
  id: string;
  status: JobStatus;
  progress: { label: string; value: number } | null;
  lastRun: string;
  lastState: string;
  nextRun: string;
  updatedAt?: string;
  latestRun: JobRunSummary | null;
  dagSteps: JobDagStep[];
};

type GetJobStatusesResponse = {
  jobs: JobStatusSnapshot[];
};
```

101개 이상을 요청하면 `422 VALIDATION_ERROR`를 반환한다. 응답 순서는 허용된 Job에 한해 요청 순서를 유지한다.

### 7.4 파이프라인 생성

`POST /api/etl/jobs`

프론트 함수:

- `createPipelineDraft(draftPipeline, jobCount)`

Request:

```ts
type RetryPolicyDraft = {
  backoffMultiplier: number;
  backoffStrategy: "fixed" | "exponential";
  failureAction: "retry_then_fail" | "retry_then_quarantine" | "notify_only";
  initialRetryDelayMinutes: number;
  maxRetries: number;
  maxRetryDelayMinutes: number;
  retryIntervalMinutes: number;
  timeoutMinutes: number;
};

type WatermarkPolicyDraft = {
  column: string;
  enabled: boolean;
  lookbackMinutes: number;
  mode: "last_success_to_scheduled_at" | "last_success_to_run_started_at" | "full_refresh";
};

type CanonicalRuleDraft = {
  contractVersion: "1.0";
  id: string;
  kind: "transform" | "quality";
  operation: string;
  inputColumns: string[];
  outputColumns: string[];
  parameters: Record<string, unknown>;
  outputType?: string;
  enabled: boolean;
  onError: "fail_batch" | "quarantine" | "warn";
  failureDisposition: "keep" | "drop_row" | "set_null";
  severity?: "warning" | "error";
  label?: string;
};

type RuleCompilationResult = {
  contractVersion: "1.0";
  status: "pass" | "fail";
  rules: CanonicalRuleDraft[];
  outputSchema: Array<[string, string]>;
  issues: Array<{
    code: string;
    message: string;
    ruleId?: string;
    field?: string;
  }>;
};

type CreatePipelineRequest = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  ruleContractVersion: "1.0";
  rules: CanonicalRuleDraft[];
  transformSteps: Array<{
    canonicalParameters?: Record<string, unknown>;
    enabled: boolean;
    id: string;
    input: string;
    kind: "rename" | "cast" | "trim" | "jsonPath" | "mask" | "derive";
    label: string;
    onError: string;
    operation: string;
    output: string;
    params: string;
  }>;
  transformOutputColumns: Array<[string, string]>;
  qualityRules: Array<{
    canonicalParameters?: Record<string, unknown>;
    enabled: boolean;
    failureAction: "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";
    id: string;
    kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
    params?: string;
    severity: "Warning" | "Error";
    targetColumn: string;
    validationType: "Not Null" | "Range Check" | "Regex Match" | "Accepted Values";
  }>;
  qualityInvalidRows: string[][];
  qualityScore?: number;
  qualityStatus: "idle" | "pass" | "warn" | "fail";
  scheduleLabel: string;
  scheduleSummary: string;
  retryPolicy: RetryPolicyDraft;
  retryPolicySummary: string;
  runLimitSummary: string;
  startDate: string;
  endDate?: string;
  nextRunUtc?: string;
  overlapPolicy?: "skip_if_running" | "queue_after_current" | "allow_parallel";
  timezone: string;
  watermarkPolicy?: WatermarkPolicyDraft;
  permissionSummary: string;
  permissionGrants?: PermissionGrant[];
  createdBy?: string;
  createdByProfile?: {
    avatarInitials?: string;
    displayName: string;
    email?: string;
    role?: string;
  };
  storageType: "S3" | "Local" | "HDFS";
  partition: string;
  partitionColumns?: string[];
  indexColumns?: string[];
  compression: "Snappy" | "Gzip" | "None";
  storagePath: string;
  targetDataset: string;
  targetDatabase?: string;
  targetDescription?: string;
  targetTags?: string[];
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};
```

`permissionSummary`와 `permissionRoles`는 호환용 governance 요약이고, `createdBy`와 `createdByProfile`은 identity metadata입니다. `permissionGrants`는 실제 Job 접근 권한이며 backend가 조회·실행·관리·삭제·공유를 판정할 때 사용합니다. `owner`는 표시용 담당자이면서 전체 권한을 주는 backend fallback 기준입니다. Backend는 `asklake_session` 쿠키 actor를 우선 사용하고, 세션이 없을 때만 `X-AskLake-User` header 또는 demo actor를 `createdBy` fallback으로 사용할 수 있습니다.
Job 생성·수정 시 `permissionGrants`는 `permission_grants` table의 `permission_ui` source로 저장됩니다. `owner`는 grant로 저장하지 않고 backend의 전체 권한 fallback 기준으로 사용합니다.

Rule contract rules:

- 새 client는 `ruleContractVersion: "1.0"`과 `rules[]`를 source of truth로 함께 보냅니다. `transformSteps`, `qualityRules`와 `transformOutputColumns`는 현재 runner와 기존 Job을 위한 파생 호환 필드입니다.
- `ruleContractVersion: "1.0"`, `rules: []`는 명시적 pass-through입니다. 같은 payload나 저장 행에 legacy 규칙이 남아 있어도 다시 활성화하지 않습니다.
- version과 canonical Rule이 없는 기존 client/저장 행만 backend adapter가 legacy 규칙을 canonical Rule로 변환합니다. 호환 필드의 `canonicalParameters`는 legacy 표시 문자열로 표현할 수 없는 `0`, `false`, 빈 문자열, `null`과 operation parameter를 보존합니다.
- legacy Regex, Accepted Values, Range가 parameter를 생략한 경우에는 기존 실행 의미인 이메일 pattern, `KOR/JPN/USA/KR/US`, 최소값 `0`을 canonical parameter로 명시합니다.
- 새 create, 기존 target append, `PATCH`는 canonical version과 Rule JSON을 nullable DB 컬럼에 저장합니다. 기존 행은 backfill하지 않고 조회 시에만 legacy adapter를 사용합니다.
- `rules`, `transformSteps`, `qualityRules`가 모두 비어 있으면 pass-through로 유효합니다.
- 생성/수정 전 compiler가 contract version, kind, operation, input/output column, parameter key, severity, 오류 정책, 실행 mode와 결정된 output schema를 검증합니다.
- schema에 JSON root가 있으면 그 아래 dotted input path를 허용합니다. JSON root가 없는 dotted path나 일반 미등록 컬럼은 `RULE_INPUT_NOT_FOUND`로 거절합니다.
- `fail_batch`/`quarantine`은 `failureDisposition: "keep"`만 허용합니다. `warn`은 `keep`, `drop_row`, `set_null`을 사용할 수 있습니다.
- 실패 응답은 `400 RULE_COMPILATION_FAILED`이며 `error.details`에 `contractVersion`, `issues`, `outputSchema`를 포함합니다.
- 대표 issue code는 `RULE_CONTRACT_VERSION_REQUIRED`, `RULE_CONTRACT_VERSION_UNSUPPORTED`, `RULE_KIND_UNSUPPORTED`, `RULE_ERROR_POLICY_UNSUPPORTED`, `RULE_FAILURE_DISPOSITION_UNSUPPORTED`, `RULE_FAILURE_POLICY_CONFLICT`, `RULE_SEVERITY_UNSUPPORTED`, `RULE_PARAMETER_UNSUPPORTED`입니다.
- backend 응답은 persisted canonical Rule을 우선 반환하고, canonical 컬럼이 없는 legacy 저장 Job만 `ruleContractVersion`, `rules`, `ruleCompilation`을 재구성해 반환합니다.
- 일반 Snapshot과 Kafka Snapshot은 저장된 Rule을 실행 직전에 다시 compile합니다. 공통 operation의 `fail_batch`, `quarantine`, `drop_row`, `set_null`은 target publication 전에 실행되며, Spark `fail_batch`는 Parquet target을 만들지 않고 Kafka `fail_batch`는 consumer offset을 commit하지 않습니다.

Request 예시:

```json
{
  "id": "draft_customer_review",
  "jobName": "customer_review_daily_ingest",
  "sourceType": "Object Storage",
  "sourceLabel": "Amazon S3",
  "sourceConfig": [
    ["Storage Provider", "Amazon S3"],
    ["Bucket / Stage Name", "asklake-raw-ingest-us-east"],
    ["Path / Prefix", "data/inventory/daily/"]
  ],
  "schemaSummary": "5 columns inferred, review_id bigint primary key candidate",
  "ruleSummary": "3 quality rules enabled",
  "ruleContractVersion": "1.0",
  "rules": [
    {
      "contractVersion": "1.0",
      "id": "review-required",
      "kind": "quality",
      "operation": "not_null",
      "inputColumns": ["review"],
      "outputColumns": [],
      "parameters": {},
      "enabled": true,
      "onError": "fail_batch",
      "failureDisposition": "keep",
      "severity": "error"
    }
  ],
  "scheduleLabel": "매일 09:00",
  "scheduleSummary": "반복 실행 · 매일 09:00 · Asia/Seoul · 저장 후 다음 예약부터 시작",
  "retryPolicy": {
    "backoffMultiplier": 2,
    "backoffStrategy": "exponential",
    "failureAction": "retry_then_fail",
    "initialRetryDelayMinutes": 1,
    "maxRetries": 3,
    "maxRetryDelayMinutes": 30,
    "retryIntervalMinutes": 1,
    "timeoutMinutes": 60
  },
  "retryPolicySummary": "3회 재시도 · 1분부터 2배 지수 백오프 · 최대 30분 · 재시도 후 실패 처리",
  "runLimitSummary": "60분 초과 시 Run 실패 처리",
  "startDate": "2026-07-07",
  "nextRunUtc": "",
  "overlapPolicy": "skip_if_running",
  "timezone": "Asia/Seoul",
  "watermarkPolicy": {
    "column": "updated_at",
    "enabled": true,
    "lookbackMinutes": 5,
    "mode": "last_success_to_scheduled_at"
  },
  "permissionSummary": "Data Engineer Group / 조직 내부",
  "storageType": "S3",
  "partition": "date/category",
  "partitionColumns": ["date", "category"],
  "indexColumns": ["review_id"],
  "compression": "Snappy",
  "storagePath": "s3a://asklake-output/customer_review_silver/silver/",
  "targetDataset": "customer_review_silver",
  "targetDescription": "고객 리뷰 분석용 정제 데이터셋",
  "targetTags": ["#customer", "#review", "#silver"],
  "targetLayer": "SILVER",
  "targetFormat": "Delta",
  "owner": "Data Engineer Group",
  "rag": false
}
```

Response `201 Created`:

```ts
type CreatePipelineResponse = {
  job: JobRowData;
  catalogTarget: {
    id: string;
    name: string;
    layer: string;
    status: "pending_run";
  };
};
```

Response 예시:

```json
{
  "job": {
    "id": "JOB-001",
    "name": "customer_review_daily_ingest",
    "owner": "Data Engineer Group",
    "status": "scheduled",
    "tag": "[리뷰]",
    "source": "Object Storage / Amazon S3",
    "target": "customer_review_silver",
    "schedule": "매일 09:00",
    "scheduleSummary": "반복 실행 · 매일 09:00 · Asia/Seoul · 저장 후 다음 예약부터 시작",
    "schedulePolicy": {
      "nextRunUtc": "",
      "overlapPolicy": "skip_if_running",
      "startDate": "2026-07-07",
      "timezone": "Asia/Seoul",
      "watermarkPolicy": {
        "column": "updated_at",
        "enabled": true,
        "lookbackMinutes": 5,
        "mode": "last_success_to_scheduled_at"
      }
    },
    "retryPolicySummary": "3회 재시도 · 1분부터 2배 지수 백오프 · 최대 30분 · 재시도 후 실패 처리",
    "runLimitSummary": "60분 초과 시 Run 실패 처리",
    "lastRun": "생성됨",
    "lastState": "대기 중",
    "nextRun": "다음 예약 대기"
  },
  "catalogTarget": {
    "id": "ds_customer_review_silver",
    "name": "customer_review_silver",
    "layer": "SILVER",
    "status": "pending_run"
  }
}
```

프론트 기대 동작:

- `job`을 수집/처리 목록 최상단에 추가합니다.
- `catalogTarget`은 실행 전 대상 표시용으로만 사용합니다.
- `selectedJob`을 응답값으로 변경합니다.
- Catalog Dataset은 비동기 command 접수 응답에서 추가하지 않습니다. Airflow의 `publish_run_result`가 Catalog reconciliation까지 성공하면 DB의 Catalog source of truth에 저장되고, Catalog·SQL·AI route 진입 시 해당 domain loader가 최신 목록을 조회합니다.
- 생성 성공 감사 로그를 남깁니다.
- 생성된 pipeline Dataset은 backend Catalog에 영속화하고 `GET /api/catalog/datasets`로 다시 읽습니다. browser localStorage를 Catalog source of truth로 사용하지 않습니다.
- Spark와 Catalog reconciliation 성공 후 생성된 dataset에는 source -> job -> target 기본 `lineageGraph`가 포함되어야 합니다. Catalog lineage modal은 저장된 `lineageGraph`를 우선 사용하고, 없으면 `upstream` 기반 fallback graph를 사용합니다.
- ETL `lineageGraph`의 source node에는 실제 source/transform input 컬럼만 포함합니다. source-to-job edge는 transform step의 `input -> output` 또는 명시적 sourceName-to-targetName mapping으로 만들고, job-to-target edge는 같은 output column name으로 연결합니다. 결과 schema를 source node에 복제하거나 컬럼 순번만으로 연결하지 않습니다. `_asklake_run_id`, `_asklake_ingested_at` 같은 실행 metadata는 source가 아니라 Spark job에서 생성된 것으로 표현합니다.
- ETL source node의 engine은 파일 확장자 또는 connector type을 사용합니다. ETL job node의 layer는 dataset layer가 아닌 `PROCESS`, engine은 `SPARK`로 표현합니다. target node의 layer는 `targetLayer`, engine은 요청값이 아니라 현재 Spark runner가 실제 저장한 physical output format(`PARQUET`)을 사용합니다.

Text structuring run metadata:

- `POST /api/text-structuring/training-runs` accepts `{ columns, trainRows, evalRows? }` and stores only `one_of_values` portable models that pass the internal quality gate.
- `GET /api/catalog/models` and `GET /api/text-structuring/models` return model artifacts separately from Catalog datasets. Each model artifact includes `targetColumn`, `method`, `allowedValues`, `modelArtifact`, `metrics.accuracy`, `metrics.macroF1`, and `validationRows` when available.
- Text row transform params store per output column: `targetName`, `method`, `allowedValues`, `modelSelectionPolicy`, `modelArtifact`, `fallbackAllowed`, and `requireModel`.
- `modelSelectionPolicy: "auto"` means Spark may select a compatible model by target column and exact allowed-values set. Rule fallback is explicit through `fallbackAllowed: true` and `requireModel: false`.
- Spark result payloads include `textStructuring.definition` and `textStructuring.execution`. The same execution summary is copied to `runHistory[].textStructuringExecution`, `CatalogDataset.textStructuringExecution`, and `DatasetMaterializationRun.textStructuringExecution`.
- Column execution records use `executionMode: "selected_model" | "auto_model" | "fallback_rule" | "missing_model" | "copy" | "instruction"`. Fallback output must also set `fallbackUsed: true`.

Validation:

- `jobName`, `sourceType`, `sourceLabel`, `targetDataset`, `targetLayer`, `owner`는 필수입니다.
- `targetLayer`는 `RAW`, `BRONZE`, `SILVER`, `GOLD` 중 하나여야 합니다.
- `storageType`, `partition`, `compression`, `storagePath`는 Target 화면의 draft 값이며, 없으면 frontend는 기존 기본값을 채웁니다.
- `icebergTarget`은 create payload에 포함하지 않습니다. Backend가 새 Job에 생성해 create/list/detail response와 Spark runtime payload에 같은 값으로 반환합니다.
- Target metadata는 flat create contract를 유지하기 위해 `targetDescription`, `targetTags`, `partitionColumns`, `indexColumns`로 전달합니다. 기존 `partition`은 하위 호환용 표시/저장 문자열이며 `partitionColumns.join("/")` 값과 같아야 합니다.
- Target 화면은 `targetLayer` 선택을 노출하지 않습니다. 기존 create/update 계약 호환을 위해 frontend가 source/execution별 내부 기본값을 전송하며 backend의 조합 검증은 유지합니다. Review 저장 위치에는 중복된 테이블 이름과 내부 계층을 표시하지 않습니다.
- `rag`는 호환 필드로 유지하지만, 현재 Target 화면에서는 설정을 노출하지 않고 frontend는 기본값 `false`를 전송합니다.
- 현재 Target 화면은 저장소 선택 화면이 아니라 최종 dataset 저장 명세 화면입니다. `data` JSON 단일 컬럼 sample은 frontend에서 dot-path 컬럼으로 펼쳐 `schemaRules`와 preview를 구성하고, 원본 보존용 `raw_data`는 optional 미사용 컬럼으로 둡니다.
- 현재 Target 화면의 파티션은 실제 사용 컬럼 중 partition 가능한 컬럼을 checkbox로 여러 개 선택하며, 선택 순서를 유지해 `/`로 연결한 뒤 create request의 `partition`에 반영합니다. 예: `event_date/region`.
- backend는 `partition` 문자열을 ETL job metadata에 보존하고 Spark 실행 시 컬럼 목록으로 복원해 Parquet writer의 `partitionBy`에 전달합니다. 선택 컬럼이 Spark output schema에 없으면 실행을 실패 처리합니다.
- Spark run 성공 후 생성되는 `CatalogDataset`에는 `description`, `tags`, `partition`, `partitionColumns`, `indexColumns`가 create request의 Target metadata와 일치하게 저장되어야 합니다. 값이 없으면 backend는 기존 기본 description/tag fallback을 사용할 수 있습니다.
- backend API가 없는 Target 설정 config 저장은 frontend local fallback으로 `window.localStorage["asklake.targetConfigDraft"]`에 `{ metadata, tags, partitionColumns, indexColumns, schemaRules, previewRows, lineage, lastTestRun }` 형태를 저장합니다. 이 config는 create request contract를 대체하지 않고 화면 재확인/debug 용도입니다.
- 표시명이 정확히 같은 `targetDataset`이 이미 존재하면 기본 정책은 `409 CONFLICT`가 아니라 기존 Job/dataset 연결을 재사용해 append 대상으로 갱신하는 것입니다. append 대상 판정에 ASCII slug를 사용하지 않습니다.
- 새 `datasetId`는 `targetDataset`이 이미 안전한 소문자 ASCII 식별자이면 하위 호환 형식 `ds_<name>`을 사용합니다. 한글·공백·특수문자·대소문자 변환처럼 slug 생성 중 원문 정보가 손실되면 `ds_<slug>_<12자리 안정 해시>`를 사용합니다. backend가 기본 storage prefix/checkpoint path를 만들 때는 같은 값에서 `ds_` prefix만 뺀 key를 사용합니다. 따라서 표시명이 다른 두 target은 같은 slug가 나오더라도 같은 Job/dataset 또는 자동 저장 경로로 합쳐지지 않습니다. 기존 Job은 정확한 `targetDataset`이 일치하면 저장된 `datasetId`를 그대로 재사용합니다.

### 7.5 파이프라인 수정

`PATCH /api/etl/jobs/{jobId}`

프론트 함수:

- `updatePipelineDraft(jobId, draftPipeline)`

Request는 `CreatePipelineRequest`에서 `id`, `sourceConfig`, `sourceLabel`, `sourceType`, `createdBy`, `createdByProfile`을 제외한 `UpdatePipelineRequest`다. `permissionGrants`는 수정 가능하며 기존 `permission_ui` source grant를 교체한다. source field가 body에 포함되면 `422` validation error로 거부한다.

Response `200 OK`:

```ts
type UpdatePipelineResponse = JobRowData;
```

Rules:

- `manage` 권한이 필요하다.
- `running` Job은 `409 CONFLICT`로 수정할 수 없다.
- 성공 Run이 하나라도 있으면 `targetDataset`, `targetDatabase`, `targetLayer`, `targetFormat`, `storageType`, `storagePath` 변경을 `422`로 차단한다.
- Continuous worker가 active인 동안 schema/Rule/physical target 변경은 `409 CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`다.
- Continuous `_asklake_contract` checkpoint가 한 번이라도 초기화된 뒤 같은 변경을 요청하면 worker가 정지 상태여도 `409 CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`다. source progress를 섞지 않도록 Job copy와 새 checkpoint를 사용한다.
- source config와 Kafka consumer group offset, `kafka_snapshots` row는 update 대상이 아니다.
- 수정 request의 canonical Rule도 create와 같은 compiler를 통과해야 하며, 실패 시 기존 Job payload를 변경하지 않는다.
- 성공 시 같은 Job ID를 반환하며 새 Job이나 Catalog Dataset을 만들지 않는다.
- 실패하면 서버 Job은 변경하지 않고 frontend edit draft는 유지한다.

### 7.6 작업 명령

`POST /api/etl/jobs/{jobId}/commands`

일반 배치 `run`/`retry`는 비동기 Airflow DAG Run을 만들고 `queued` 또는 `running`을 즉시 반환한다. Airflow DAG의 `spark_process_write`는 아래 backend-only endpoint를 호출한다.

```text
POST /api/internal/airflow/spark-runs/{runId}/execute
Authorization: Bearer <AIRFLOW_EXECUTION_API_TOKEN>
```

```ts
type AirflowSparkExecutionRequest = {
  command: "run" | "retry";
  jobId: string;
};
```

이 endpoint는 브라우저용 API가 아니다. FastAPI는 path `runId`, body `jobId`, 저장된 `etl_runs.airflow_dag_run_id`가 모두 일치하는지 확인한 뒤 PySpark를 실행한다. 일반 non-Kafka Job은 실행 전에 backend-owned `icebergTarget`을 보정하고 Spark DataFrameWriterV2가 공유 JDBC catalog에 commit한다. 성공한 manifest가 이미 `taskStates.sparkResult`에 있으면 같은 Airflow task retry는 물리 출력을 다시 만들지 않고 기존 manifest를 반환한다.

PostgreSQL Snapshot source는 Source/Schema Preview와 실행 입력을 분리한다. `schemaSampleRows`, `__Schema Sample Scope`, `__Sample Row Limit`, `ASKLAKE_SPARK_RUN_ROW_LIMIT`은 PostgreSQL `run`/`retry`의 행 상한이 아니다. 실행 시 저장된 connector identity와 credential로 선택한 base table을 `REPEATABLE READ READ ONLY` transaction과 cursor batch로 끝까지 JSONL export한 뒤 Spark에 전달한다. batch 크기는 `ASKLAKE_POSTGRES_EXECUTION_BATCH_ROWS`로 조절하되 전체 행 수는 자르지 않는다. 테이블이 비어 있거나 export가 중단되면 Run을 실패시키고 Catalog materialization을 만들지 않는다.

Spark manifest에는 `status`, `runId`, `startedAt`, `endedAt`, `durationMs`, `inputFileCount`, `inputBytes`, `inputRows`, `outputFileCount`, `outputRows`, `outputPath`, `schema`, `quality`, `failedStage`, `error`가 포함될 수 있다. Prefix runtime은 Preview와 같은 객체 제외 규칙으로 실제 경로를 열거하고 이 file/byte/row 수치를 실행 증거로 기록한다. Phase 2는 이 manifest와 물리 Parquet까지 저장하지만 Catalog materialization/lineage 갱신은 수행하지 않는다.

S3A 출력은 Job의 변경 불가능한 설정값 `storagePath`를 destination root로 사용하고 그 아래에 `runId`를 붙인다. `targetPath`는 최신 Run에서 관측한 실제 `outputPath`이므로 다음 재실행의 destination root로 재사용하지 않는다.

Phase 3의 마지막 Airflow task는 Spark 실행 endpoint와 분리된 Catalog endpoint를 호출한다.

```text
POST /api/internal/airflow/spark-runs/{runId}/catalog
Authorization: Bearer <AIRFLOW_EXECUTION_API_TOKEN>
```

```ts
type AirflowCatalogReconciliationRequest = {
  jobId: string;
};

type AirflowCatalogReconciliationResponse = {
  dataset: CatalogDataset;
  reconciledAt: string;
  runId: string;
  status: "success";
};
```

이 endpoint는 DAG의 `publish_run_result` task 전용이다. backend는 request body에서 Spark 결과나 Catalog payload를 받지 않으며 다음 저장값을 다시 조회하고 검증한다.

- path의 `runId`
- body의 `jobId`
- 저장된 `ETLRunModel.job_id`, `airflow_dag_run_id`
- 저장된 `taskStates.sparkResult.status=success`
- Job에 저장된 `datasetId`와 변경 불가능한 target identity
- Spark `icebergCommit`의 Job/Run/target/snapshot/schema/rule identity
- Trino `DESCRIBE`, `$refs`, `$snapshots`와 snapshot summary로 확인한 같은 Iceberg table과 물리 data file

Catalog mapping:

| Catalog 값 | source |
| --- | --- |
| dataset id | `job.datasetId` |
| `materializationRuns[].runId` | `sparkResult.runId` |
| `materializationRuns[].jobId` | 저장된 Job id |
| `rowCount` | `sparkResult.outputRows` |
| `createdAt` | `sparkResult.endedAt` |
| `storageLocation` | 검증된 Iceberg warehouse location |
| `storageSizeBytes` | S3A prefix 또는 local output path의 실제 file byte 합계 |
| `schema` | `sparkResult.schema` |
| `quality` | `sparkResult.quality` |
| `lineageGraph` | source -> Spark Job -> target dataset |

일반 Spark batch는 logical `outputPath=iceberg://catalog/namespace/table`을 사용한다. backend는 reported snapshot ID를 Trino `$refs`의 `main` current snapshot과 대조하고, 해당 snapshot의 `$snapshots.summary`에 기록된 `total-data-files`와 `total-files-size`를 저장한다. `$files`는 current table의 보조 물리 확인에만 사용하며 rollback 이후 abandoned history의 newest snapshot을 current로 오인하지 않는다. `outputRows>0`인데 data file 또는 byte 증거가 0이면 reconciliation을 실패시킨다. 기존 non-Iceberg 호환 결과만 S3A/local path의 Parquet object를 직접 검사한다. Catalog `sampleRows`는 Spark가 제공한 제한된 transformed output sample을 사용할 수 있으며, 그런 sample이 없으면 빈 배열을 사용한다. schema나 값이 달라질 수 있는 pre-transform source sample을 output sample로 가장해서는 안 된다.

Catalog dataset upsert와 `taskStates.catalogResult` 성공 기록은 같은 PostgreSQL transaction으로 확정한다. `catalogResult`는 최소한 `status`, `runId`, `datasetId`, `reconciledAt`을 포함한다. 같은 `runId`가 다시 들어오면 기존 materialization을 교체해 하나만 유지하고, 다른 Run은 같은 dataset row에 append한다. append read-modify-write 동안 target dataset row를 lock해 동시 실행의 history 손실을 막는다. dataset이 아직 없을 때의 동시 create는 id/name unique constraint로 한 row만 허용하고, 충돌한 호출은 그 row를 다시 읽어 같은 run-keyed update를 적용한다. Airflow state sync가 Task Instance snapshot을 다시 만들 때도 `sparkResult`와 `catalogResult`를 모두 보존해야 한다.

Failure contract:

- 성공 Spark manifest가 없거나 아직 저장되지 않았으면 `409 SPARK_RESULT_NOT_READY`
- Job/Run/Airflow identity가 다르면 `409 AIRFLOW_RUN_MISMATCH`
- physical output 검증 또는 Catalog transaction이 실패하면 `500 CATALOG_RECONCILIATION_FAILED`
- 실패 시 Catalog partial update는 rollback한다. 검증된 Iceberg snapshot과 성공 `sparkResult`는 삭제하지 않는다. Spark commit 뒤 report 확정 전에 실패한 경우에는 writer가 이전 snapshot으로 rollback한다.
- rollback 후 같은 Run에 `taskStates.catalogResult={ status: "failed", ... }`와 compact error를 별도 저장해 원인을 관찰할 수 있게 한다.
- `publish_run_result`는 endpoint 실패를 Airflow task 실패로 전파한다. 따라서 Airflow DAG Run과 AskLake Run은 성공으로 표시되지 않으며 failed stage는 `Catalog reconciliation`이다.
- `publish_run_result`는 30초 간격으로 최대 2회 재시도하며, 같은 DAG Run의 성공 `sparkResult`를 재사용해 Catalog만 최대 3회 시도하고 Spark output을 다시 만들지 않는다.
- Catalog commit 뒤 HTTP response만 유실된 경우 retry는 저장된 성공 `catalogResult`와 동일 `runId` materialization을 읽어 같은 success response를 반환한다.

최종 상태 규칙은 `spark_process_write success + Catalog transaction success = publish_run_result success = Airflow DAG Run success = AskLake Run success`다. Phase 3 FastAPI Catalog endpoint와 transaction, 실제 Spark mode의 `publish_run_result` 호출 연결은 구현됐고 실제 Airflow/Spark/MinIO/Catalog 성공 및 Spark 실패 경로를 검증했다. Backend reconciliation loop는 Airflow 상태 조회 뒤 Run row를 다시 읽고 lock한 다음 task snapshot을 저장해, 동시에 commit된 `sparkResult`/`catalogResult`를 잃지 않는다. 명시적인 failed `catalogResult`는 Airflow success보다 우선해 AskLake Run을 실패로 유지하며, 성공 `catalogResult` 또는 같은 Run의 성공 materialization이 없으면 Spark 행 수·경로만으로 성공 처리하지 않는다. 독립 DAG import/status 검증용 `executionMode=smoke`만 물리 Catalog 호출을 건너뛴다. frontend의 batch status 조회는 Job/Run 상태만 반영한다. Catalog 목록은 Catalog·SQL·AI route 진입 시 별도 loader가 조회하므로 Job 상태 요청 실패와 Catalog 상태를 서로 rollback하지 않는다.

프론트 함수:

- `runJobCommand(job, command)`

Request:

```ts
type JobCommandRequest = {
  command: "run" | "retry" | "pause" | "cancelRun" | "stopSchedule" | "resumeSchedule";
};
```

Request 예시:

```json
{
  "command": "run"
}
```

Response `200 OK`:

```ts
type JobCommandResponse = {
  action: string;
  apiPath: string;
  job?: JobRowData;
  run?: JobRunSummary;
  dagSteps?: JobDagStep[];
};
```

프론트 상태 반영 계약:

```ts
type RunsByJobId = Record<string, JobRunSummary[]>;
type SelectedRunIdByJobId = Record<string, string>;
type DagStepsByRunId = Record<string, JobDagStep[]>;
```

- `job.id`는 `runsByJobId`의 key입니다.
- `run.runId`는 `selectedRunIdByJobId[job.id]`의 value이자 `dagStepsByRunId`의 key입니다.
- `run`이 있으면 `runsByJobId[job.id]`에 최신순으로 upsert합니다.
- 같은 `run.runId`가 이미 있으면 기존 Run을 교체하고 중복 row를 만들지 않습니다.
- 새 `run`이 있으면 `selectedRunIdByJobId[job.id]`는 해당 `run.runId`로 갱신합니다.
- `dagSteps`는 같은 응답의 `run.runId`에 묶어 `dagStepsByRunId[run.runId]`에 저장합니다.
- `dagSteps`에 별도 `runId` 필드를 요구하지 않습니다.
- History row 선택은 `selectRunForJob(jobId, runId)` action으로 `selectedRunIdByJobId[job.id]`만 갱신합니다.
- DAG/실행 흐름은 별도 top-level tab이 아니라 History 화면 내부의 선택 Run 상세 카드로 렌더링합니다.
- 초기 `/api/etl/jobs` hydrate에서는 `job.runHistory`를 `runsByJobId[job.id]`로 옮기고, `job.dagSteps`를 최신 Run의 `runId`에 연결합니다.
- PR1 optimistic 실행 상태는 API request에 `clientRunId`를 추가하지 않습니다. 프론트가 `client:<jobId>:<timestamp>` 형식의 temp run id를 만들고, 서버 응답의 `run.runId`가 오면 temp run을 실제 Run으로 교체합니다.

Response 예시:

```json
{
  "action": "etl.run.requested",
  "apiPath": "/api/etl/jobs/JOB-001/runs",
  "job": {
    "id": "JOB-001",
    "name": "customer_review_daily_ingest",
    "owner": "Data Engineer Group",
    "status": "running",
    "tag": "[리뷰]",
    "source": "Object Storage / Amazon S3",
    "target": "customer_review_silver",
    "schedule": "매일 09:00",
    "lastRun": "현재 실행 중",
    "lastState": "1/8 단계 · Source 연결",
    "nextRun": "-",
    "progress": {
      "label": "1/8 단계 · Source 연결",
      "value": 12
    }
  }
}
```

명령별 권장 동작:

| command | action | 상태 변경 |
| --- | --- | --- |
| `run` | `etl.run.requested` | `running` |
| `retry` | `etl.run.retry_requested` | `running` |
| `pause` | `etl.job.pause_requested` | `paused` |
| `cancelRun` | `etl.run.cancel_requested` | 현재 Run만 `canceled`, 반복 schedule은 유지 |
| `stopSchedule` | `etl.schedule.stop_requested` | 스케줄 설정을 보존한 채 `stopped`, `nextRun: "-"`. 실행 중인 실시간 Job은 현재 Run도 `canceled`로 종료하고 `실시간 수집 중지`로 기록 |
| `resumeSchedule` | `etl.schedule.resume_requested` | 보존한 스케줄 설정으로 `scheduled`, 다음 예약 재계산. 실시간 Job은 `실시간 수집 재개됨`으로 기록 |

`run`과 `retry`는 Airflow DAG Run을 제출한 뒤 non-terminal `job`/`run`을 즉시 응답한다. Airflow `spark_process_write` task는 `POST /api/internal/airflow/spark-runs/{runId}/execute`를 호출해 실제 input/output row count, Iceberg 논리 table URI와 commit evidence를 Run의 `sparkResult`에 저장한다. 다음 `publish_run_result` task가 `POST /api/internal/airflow/spark-runs/{runId}/catalog`를 호출해 Trino table/snapshot/data-file mapping을 검증하고 Catalog dataset/materialization을 transaction으로 확정한다. Backend reconciliation loop가 active Run을 기본 5초마다 Airflow와 동기화해 DB에 저장하고, 프론트는 `GET /api/etl/jobs/statuses` 한 요청으로 최종 `scheduled` 또는 `failed` 상태와 최신 Run·DAG 단계를 반영한다.

분리된 내부 endpoint는 bearer token과 backend의 `AIRFLOW_EXECUTION_API_TOKEN`을 우선 사용하며 `AIRFLOW_INTERNAL_TOKEN`을 호환 fallback으로 허용한다. `POST /api/etl/internal/airflow/jobs/{jobId}/runs/{runId}/execute`와 `X-AskLake-Airflow-Token`은 기존 단일 호출 Spark/Catalog 경로 호환용으로 유지한다. 동일 `runId`가 이미 Catalog에 materialize된 경우 기존 결과를 반환하고 Spark를 중복 실행하지 않는다. Airflow DAG가 `success`여도 해당 `runId`의 성공 Catalog evidence 또는 기존 persisted Spark result가 없으면 Run을 `failed`로 보정한다. `dag_run.conf`에는 `jobId`, `runId`, `command`, `executionMode`, 제출 시각만 전달하며 source credential과 전체 Job payload는 전달하지 않는다.

현재 `pause`는 Spark checkpoint에서 정확히 이어받는 복원을 보장하지 않는다. 목록 UI는 실행 중단과 자동 실행 중지를 구분하며, 현재 Run만 끝내는 동작은 `cancelRun`, 이후 자동 실행까지 중지하는 동작은 `stopSchedule`을 사용한다.

Validation:

- 존재하지 않는 job은 `404 NOT_FOUND`.
- 이미 실행 중인데 다시 `run`하면 `409 CONFLICT`.
- 실행 중이 아닌 job에 `pause`하면 `422 INVALID_JOB_STATE`.
- 실행 중이 아닌 job에 `cancelRun`하면 `422 INVALID_JOB_STATE`.
- 스케줄이 없는 job에 `stopSchedule`하면 `422 INVALID_JOB_STATE`.
- `stopped` 상태가 아니거나 보존된 스케줄이 없는 job에 `resumeSchedule`하면 `422 INVALID_JOB_STATE`.

### 7.6.1 작업 단건 조회

`GET /api/etl/jobs/{jobId}`

Response `200 OK`:

```ts
type GetJobResponse = JobRowData;
```

저장된 최신 `status`, 전체 `runHistory`, `dagSteps`를 포함한다. 이 endpoint는 상세 또는 실행 이력 화면 진입 시 사용하며 Airflow/Continuous runtime을 호출하거나 DB 상태를 변경하지 않는다. 주기적인 Snapshot 상태 갱신은 `GET /api/etl/jobs/statuses`를 사용한다.

### 7.7 Trino 읽기 전용 SQL 실행

상세 lifecycle, Dataset physical mapping, cursor 결과 계약, 감사 기준은 `docs/trino-query-run-contract.md`를 canonical source로 둡니다. 대용량 result page storage, collector recovery, retention 상세는 `docs/trino-query-result-storage-contract.md`를 따릅니다. `TRINO_ENABLED=false`일 때만 DuckDB bounded compatibility response를 유지하며, frontend는 이 모드에서 Trino estimate endpoint를 호출하지 않습니다.

`POST /api/query/runs`

```ts
type SubmitQueryRunRequest = {
  baseDatasetId: string;
  referenceDatasetIds?: string[];
  query: string;
  resultPageSize?: number;
  clientRequestId?: string;
  confirmationToken?: string;
  mode?: "preview"; // public SQL 분석 기본값
  limit?: number; // Trino preview는 최대 100
};

type SubmitQueryRunResponse = {
  runId: string;
  engine: "trino";
  mode: "preview";
  status: "queued" | "running" | "succeeded" | "failed";
  submittedAt: string;
  estimate?: QueryRunEstimateSnapshot;
};

type QueryRunEstimateSnapshot = {
  durationEstimateSource: "query_history" | "dataset_history" | "configured_throughput";
  estimatedBytes?: number;
  estimatedDurationSeconds?: number;
  estimatedThroughputBytesPerSecond?: number;
  estimateSource: "iceberg_metadata" | "trino_plan" | "catalog_heuristic" | "conservative_bound";
  icebergEstimatedBytes?: number;
  knownInputBytes: number;
  planEstimatedBytes?: number;
  riskLevel: "low" | "medium" | "high";
  warnings: string[];
};
```

- `202 Accepted`를 반환하고 결과 행은 반환하지 않습니다. public SQL 분석 요청은 `mode=preview`로 정규화하며 backend가 compiled SQL을 `SELECT * FROM (...) LIMIT 100`으로 감싼다. 원본 `query` field는 변경하지 않는다.
- backend는 read-only SQL, selected Dataset context, `query` 권한, user/group block, resource lock을 확인한 뒤에만 Trino에 제출합니다.
- 모든 참조 Dataset은 `catalog/schema/table` physical mapping이 있어야 합니다.
- `clientRequestId`는 현재 actor 범위의 idempotency key입니다. 동일 key와 동일한 base/reference/query/mode/previewLimit/sourceRunId/resultPageSize fingerprint는 최초 run을 반환하고 Trino에 다시 제출하지 않습니다. 동일 key를 다른 요청에 사용하면 `409 CONFLICT`입니다.
- actor별 active slot은 PostgreSQL advisory lock 안에서 reservation row를 먼저 저장해 원자적으로 계산합니다. 제한을 넘으면 Trino 제출 전에 `429`를 반환합니다.
- frontend는 같은 실행 시도의 confirmation/network retry에서 key를 재사용하고, SQL 또는 Dataset context가 바뀌면 새 key를 생성합니다.

Catalog Dataset response는 Phase 1부터 아래 optional mapping을 저장하고 응답할 수 있습니다. 이 field가 없는 기존 Dataset은 현재 DuckDB compatibility runtime과 호환되며, Phase 2 Trino Query Run service는 mapping 없는 Dataset을 실행 대상으로 허용하지 않습니다. compiler는 AST 기준으로 selected Dataset display name/ID만 `catalog.schema.table`로 치환하고 직접 physical reference와 table function을 차단합니다. Phase 3부터 `TRINO_ENABLED=true`인 backend는 `/api/query/runs` routing을 이 service로 전환합니다.

Trino preview run은 legacy `POST /api/catalog/derived-datasets` JSONL materialization input이 아니다. 반복 SQL Job 생성은 preview page나 full result page를 복사하지 않고 원본 SQL recipe와 출력 컬럼을 저장하며, 실제 Job Run에서 원본 SQL을 다시 compile해 Iceberg CTAS를 수행한다.

```ts
type QueryEngineTableRef = {
  catalog: string;
  schema: string;
  table: string;
  format: "iceberg" | "parquet";
  partitionColumns: string[];
};

type CatalogDatasetResponse = {
  // Existing fields omitted.
  queryEngineStatus: "pending" | "available" | "registration_failed" | "unavailable";
  queryEngineRequired: boolean;
  queryEngineTable?: QueryEngineTableRef;
  queryEngineError?: string;
};
```

`queryEngineTable`은 `queryEngineStatus=available`일 때만 응답한다. `queryEngineRequired`는 현재 API runtime이 Trino physical mapping을 요구하는지 나타내며 `TRINO_ENABLED`와 같다. SQL 결과 Dataset 생성은 Catalog `pending` 저장, Iceberg CTAS, `DESCRIBE` 물리 확인, `available` 전환 순서로 처리하며 사용자가 physical mapping을 입력하지 않는다. CTAS continuation은 `trino-result-collector`가 처리하고 materialization GET은 persisted state만 읽는다. CTAS는 성공했지만 확인이 실패하면 `registration_failed`와 안전한 오류 코드만 남기고 mapping을 제거하며, terminal run GET은 같은 table 확인만 안전하게 재시도할 수 있다. `TRINO_ENABLED=true`에서는 `available` mapping이 없는 Dataset의 `permissions.canQuery`를 false로 응답하고 backend compiler도 동일 Dataset을 `422 VALIDATION_ERROR`로 차단한다.

Materialization 제출과 조회는 source run submitter ID 또는 admin 여부뿐 아니라 base/reference Dataset의 현재 `query` grant, user/group block, resource lock을 다시 검사합니다. 저장된 user ID가 있는 run은 동일 display name으로 소유권을 우회할 수 없고 ID 없는 legacy run에만 name fallback을 허용합니다.

전환 전 내부 writer가 저장한 payload 중 `queryEngineTable`은 있지만 `queryEngineStatus`가 없는 row는 migration read compatibility로 `available`을 추론한다. 새 writer와 API는 이 fallback에 의존하지 않고 상태를 명시해야 하며, 사용자 입력만으로 mapping을 생성하는 endpoint는 제공하지 않는다.

일반 non-Kafka Spark ETL, Kafka Snapshot과 Kafka Continuous 결과는 Iceberg metadata와 warehouse Parquet를 생성하고 snapshot ID, 실제 warehouse location, `queryEngineVerified=true`, 완전한 `queryEngineTable`을 Trino로 재검증한 경우에만 `available`로 저장한다. Job identity가 없는 Kafka direct JSONL은 `queryEngineStatus=unavailable`이며 SQL downstream을 표시하지 않는다. Catalog row 생성이나 `icebergTarget` 선언만으로 물리 table 등록 성공을 추정해서는 안 된다. writer 전환 계약과 단계는 [Iceberg Writer Migration Plan](iceberg-writer-migration-plan.md)을 따른다.

공통 Iceberg commit evidence는 `jobId`, `runId`, `target`, `queryEngineTable`, `snapshotId`(64-bit 안전성을 위해 string), `committedAt`, `warehouseLocation`, `queryEngineVerified: true`, optional schema/rule fingerprint와 source boundary를 포함한다. Trino adapter의 `replace`는 원자적 `CREATE OR REPLACE TABLE AS`, `append`는 최초 CTAS 이후 `INSERT INTO`를 사용한다. 일반 Spark batch와 Kafka Snapshot Job은 DataFrameWriterV2 `create`/`append`/`overwrite`로 같은 JDBC catalog에 commit한다. Kafka `sourceBoundary.kind=kafka_snapshot`이면 table 내부 `_asklake_kafka_snapshot_id` marker로 같은 snapshot append 여부를 확인해 retry에서 `operation=reuse`를 반환한다. 서비스는 commit 뒤 `$refs`의 `main`, exact `$snapshots`, snapshot summary와 `DESCRIBE`가 모두 성공한 경우에만 evidence를 확정하며 writer가 보고한 expected snapshot ID와 실제 current snapshot이 다르면 mapping을 저장하지 않는다. 시간상 가장 새로운 historical snapshot은 rollback으로 abandoned될 수 있으므로 current 판정에 사용하지 않는다.

```ts
type TrinoMaterializationRunResponse = {
  datasetId: string;
  datasetName: string;
  materializationId: string;
  sourceRunId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  queryEngineStatus: "pending" | "available" | "registration_failed" | "unavailable";
  trinoQueryId?: string;
};
```

Validation:

- `datasetId`, `query`는 필수입니다.
- `mode: "preview"`일 때 백엔드는 원본 SQL을 저장/변경하지 않고 서버 쪽에서 preview row limit을 적용해야 합니다.
- `TRINO_ENABLED=true`이고 Dataset이 query engine mapping을 요구하면 Trino Query Run 계약을 사용합니다. `TRINO_ENABLED=false`인 bounded compatibility mode에서만 DuckDB table context로 projection/filter/group/order/limit/JOIN을 실행합니다.
- `baseDatasetId`와 `referenceDatasetIds`는 접근 권한 검증과 SQL table context 검증에 사용합니다.
- frontend preflight는 PostgreSQL parser로 `SELECT` 단일 문장, CTE, `FROM`/`JOIN` table context를 검사합니다. backend는 같은 기준을 서버에서 다시 검증해야 합니다.
- 선택 테이블 UI 변경은 SQL text를 자동 재작성하지 않습니다. SQL이 `baseDatasetId`/`referenceDatasetIds`에 포함되지 않은 table을 참조하면 preview 전 검증에서 실패해야 합니다.
- live backend는 DuckDB in-memory connection을 query runtime으로 사용합니다. 선택된 Catalog dataset과 `referenceDatasetIds` dataset을 DuckDB table/view로 등록한 뒤 projection, filter, order, limit, selected-context JOIN을 실행합니다.
- Catalog payload에 로컬 `storageLocation`과 `storageFormat`(`jsonl`, `parquet`)이 있으면 DuckDB가 해당 물리 파일을 우선 읽고, 로컬 파일이 없거나 읽을 수 없으면 `schema`/`sampleRows` 기반 임시 table로 fallback합니다.
- `storageLocation`이 `s3://` 또는 `s3a://`인 Parquet dataset은 backend가 `S3_ENDPOINT`/`MINIO_ENDPOINT`, server-side credential, path-style 설정으로 object 목록을 검사한 뒤 query-scoped 임시 디렉터리에 내려받고 DuckDB `read_parquet` view로 등록합니다. 임시 파일은 Preview 응답 또는 실패 직후 삭제하며 원격 object는 읽기만 합니다.
- 한 Preview의 원격 Parquet 합계가 `ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES`(기본 512 MiB)를 넘으면 다운로드 전에 `422 VALIDATION_ERROR`로 차단합니다. 원격 인증·연결 실패 또는 Parquet object 부재는 `502 SQL_STORAGE_ERROR`로 반환하며 빈 `sampleRows` table로 조용히 fallback하지 않습니다.
- 한국어, 공백, 특수문자가 포함된 dataset/column 표시명은 금지하지 않습니다. frontend가 기본 쿼리, 자동완성, 컬럼 삽입, JOIN 초안을 만들 때 SQL text에는 double-quoted identifier(`"월별 매출 데이터"`, `"주문 ID"`)를 사용해야 합니다. 사용자가 따옴표 없이 한글/공백 table reference를 직접 입력한 경우 frontend preflight는 실행 전에 감지하고 quoted identifier 자동 보정을 제안합니다.
- DuckDB compatibility run과 Trino preview/full run 모두 같은 quoted identifier 정책을 따릅니다. 실행 context 검증은 quoted 표시명만이 아니라 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 기준으로 재검증합니다.
- 읽기 전용 SQL만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 `403 FORBIDDEN` 또는 `422 VALIDATION_ERROR`를 권장합니다.
- SQL 문법 오류는 `422 SQL_SYNTAX_ERROR`.
- DuckDB compatibility 결과는 최대 500행 이하를 권장한다. Trino preview는 최대 100행 inline page이고, on-demand 전체 결과는 cursor object-page storage 계약을 사용한다.

프론트 기대 동작:

- `columns`, `rows`를 SQL 결과 테이블에 표시합니다.
- SQL 화면의 로컬 차트는 bounded `SqlResultDraft`를 사용하며, Trino 원격 결과 한 page를 persistent downstream source로 저장하지 않습니다.
- 실패 시 `analysis.query.preview_failed` 감사 로그를 남깁니다.

#### 7.7.1 SQL 실행 snapshot 조회

`GET /api/query/runs/{runId}`

`result.storage*`와 page count field는 Query Result 계약이다. `mode=preview`는 최대 100행을 PostgreSQL page(`storage=postgres`)에 저장하고, `mode=run`은 private S3-compatible page storage(`storage=s3`)를 사용한다.

```ts
type GetQueryRunResponse = {
  runId: string;
  engine: "trino";
  mode: "preview" | "run";
  sourceRunId?: string; // run mode가 파생된 preview run
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  trinoQueryId?: string;
  query: string;
  baseDatasetId: string;
  referenceDatasetIds: string[];
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  // Submit 시점의 실행 전 평가 snapshot. confirmation token은 절대 저장/반환하지 않는다.
  estimate?: QueryRunEstimateSnapshot;
  stats?: {
    elapsedMs?: number;
    queuedMs?: number;
    cpuMs?: number;
    processedRows?: number;
    processedBytes?: number;
    peakMemoryBytes?: number;
    completedDrivers?: number;
    completedSplits?: number;
    totalDrivers?: number;
    totalSplits?: number;
    // Trino가 제공하면 사용하고, 없으면 split 비율을 사용한다. 알 수 없으면 생략한다.
    progressPercentage?: number;
    progressObservedAt?: string;
    queryCompletedAt?: string;
    queryState?: string;
    outputRows?: number;
    outputBytes?: number;
  };
  result?: {
    storage: "postgres" | "s3";
    storageStatus: "collecting" | "available" | "expired" | "unavailable";
    columns: string[];
    pageCount: number;
    availablePageCount: number;
    rowCount?: number;
    collectedRowCount?: number;
    expectedRowCount?: number;
    collectionProgressPercentage?: number;
    collectionStartedAt?: string;
    firstPageAvailableAt?: string;
    collectionCompletedAt?: string;
    firstPageElapsedMs?: number;
    collectionElapsedMs?: number;
    totalReadyMs?: number;
    nextCursor?: string | null;
    retentionExpiresAt?: string;
  };
  error?: { code: string; message: string };
};
```

`queryCompletedAt`, `collectionStartedAt`, `firstPageAvailableAt`, `collectionCompletedAt`은 UTC ISO 8601 optional timestamp다. 최초 관측값을 유지하므로 collector retry, 프로세스 재시작, lease takeover가 기존 시각을 덮어쓰지 않는다. `firstPageElapsedMs`는 `submittedAt -> firstPageAvailableAt`, `collectionElapsedMs`는 `collectionStartedAt -> 현재/collectionCompletedAt`, `totalReadyMs`는 `submittedAt -> collectionCompletedAt`의 서버 측 경과다. 기존 payload에 이 field가 없으면 frontend는 사용 가능한 timestamp로 보완 계산하거나 값을 생략해야 한다.

`POST /api/query/runs/{previewRunId}/full-results`

```ts
type CreateFullResultRequest = {
  clientRequestId?: string;
};
```

- source는 `mode=preview`, `status=succeeded`, `storageStatus=available`이어야 한다.
- 성공하면 원본 SQL 전체를 실행하는 `mode=run`, `sourceRunId=previewRunId` Query Run을 `202`로 반환한다.
- 같은 preview source의 active run 또는 retention 안의 성공·available run이 있으면 새 Trino query를 만들지 않고 재사용한다.
- 이 endpoint 호출 자체가 전체 결과 생성에 대한 명시적 사용자 action이다. estimate hard limit과 현재 권한은 다시 검사한다.
- 전체 보기 UI는 준비된 첫 cursor page부터 열 수 있고, 아직 없는 다음 page는 collector가 저장한 뒤 lazy 조회한다.
- CSV UI는 같은 full run을 재사용하고 `storageStatus=available` 뒤 export endpoint를 호출한다.

`GET /api/query/runs?limit=10`

```ts
type ListQueryRunsResponse = {
  items: Array<{
    runId: string;
    baseDatasetId: string;
    query: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    submittedAt: string;
    completedAt?: string;
    result?: { storageStatus?: "collecting" | "available" | "expired" | "unavailable"; rowCount?: number };
    stats?: { processedBytes?: number };
  }>;
};
```

- 현재 세션 사용자가 제출한 Trino Query Run만 `submittedAt` 내림차순으로 반환합니다. `limit` 기본값은 10이며 최대 50입니다.
- 현재 actor에 user ID가 있으면 `submittedByUserId`가 일치하는 run만 반환한다. ID가 없는 legacy run만 동일 display name fallback을 허용한다.
- 이력 목록은 과거 실행을 찾는 용도이며, 항목을 다시 열 때 `GET /api/query/runs/{runId}`가 현재 Dataset `query` 권한, 차단, 리소스 잠금을 다시 검증합니다.
- 다른 사용자의 실행과 Trino continuation URL, object storage 위치는 반환하지 않습니다. 조회 자체는 `query_run.history.view` 감사 로그로 남습니다.

`GET /api/query/runs/{runId}/results?cursor=<opaque>`

```ts
type QueryRunResultPage = {
  runId: string;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  pageSize: number;
  nextCursor: string | null;
  rowCount?: number;
};
```

- 결과 행은 이 endpoint에서만 cursor page로 조회합니다.
- `GET /api/query/runs/{runId}`는 durable collector state만 반환하며 Trino continuation URL이나 QueryInfo를 직접 fetch하지 않습니다. Collector는 `nextUri` 대기 중 별도 읽기 전용 QueryInfo sampler가 저장한 progress/driver와 elapsed/queued/CPU time, processed input bytes/rows, peak memory를 응답에 병합합니다. QueryInfo와 statement page는 같은 단조 증가 병합 규칙을 사용하므로 누적 지표와 `FINISHING`/`FINISHED` state는 stale sample로 감소하거나 되돌아가지 않습니다. 결과 retention이 만료되어도 run의 SQL, 상태, 통계, 완료 milestone, `storageStatus=expired` metadata는 조회할 수 있습니다.
- `nextCursor`는 storage page index와 그 안의 row offset을 노출하지 않는 signed opaque token이다. token은 해당 `runId`와 `retentionExpiresAt`에만 유효하며 변조, 다른 run 재사용, 만료 후 사용은 거절한다.
- submit 시 정한 `resultPageSize`는 results endpoint에서 바꿀 수 없습니다. Trino가 더 큰 storage page를 반환해도 backend가 고정 크기 API page로 나누며 마지막 page만 작을 수 있습니다.
- frontend는 현재 page row와 이전/다음 cursor history만 유지하고 전체 결과를 memory에 적재하거나 offset SQL을 생성하지 않습니다.
- preview result page는 PostgreSQL inline row에서, full result page는 private S3-compatible object에서 backend가 읽어 반환한다. 어느 경우에도 browser에 storage URL 또는 credential을 노출하지 않는다.
- requested page가 아직 수집되지 않았으면 `409 RESULT_PAGE_NOT_READY`, retention 만료면 `410 RESULT_EXPIRED`, storage 장애면 `503 RESULT_STORAGE_UNAVAILABLE`을 반환합니다.
- 결과 retention 또는 cursor가 만료되면 명시적 오류를 반환하고, 사용자에게 재실행 또는 materialization을 안내합니다.
- cleanup worker는 terminal run을 keyset batch로 끝까지 순회하므로 최근 N건만 정리하지 않습니다. 실행 중 run과 durable materialized Dataset은 cleanup 대상이 아닙니다.

`GET /api/query/runs/{runId}/exports/csv`는 `mode=run`, `status=succeeded`, `storageStatus=available`인 전체 결과만 stream한다. preview run에 직접 요청하면 `409 RESULT_PAGE_NOT_READY`다.

`POST /api/query/runs/{runId}/cancel`은 `queued` 또는 `running` run만 취소합니다. `POST /api/query/estimates`는 SQL을 실행하지 않고 Iceberg 참조 컬럼의 물리 스캔량과 최근 실행 기반 예상 시간을 반환합니다. 예상값은 실제 Query Run stats를 대체하지 않습니다. 제출 시점에 계산한 예상값은 run response에 snapshot으로 남겨 실행 이력을 다시 열어도 비교할 수 있지만, 재실행 승인용 `confirmationToken`은 persistence와 Query Run response에 포함하지 않습니다.

`POST /api/query/estimates`

```ts
type QueryEstimateRequest = {
  baseDatasetId: string;
  referenceDatasetIds?: string[];
  query: string;
};

type QueryEstimateResponse = {
  durationEstimateSource: "query_history" | "dataset_history" | "configured_throughput";
  estimatedBytes?: number;
  estimatedDurationSeconds?: number;
  estimatedThroughputBytesPerSecond?: number;
  estimateSource: "iceberg_metadata" | "trino_plan" | "catalog_heuristic" | "conservative_bound";
  icebergEstimatedBytes?: number;
  knownInputBytes: number;
  planEstimatedBytes?: number;
  riskLevel: "low" | "medium" | "high";
  warnings: string[];
  confirmationRequired: boolean;
  confirmationToken?: string;
};
```

- Iceberg Dataset은 SQL AST가 참조한 컬럼을 찾고 `$files.readable_metrics`의 컬럼별 `column_size`를 합산해 `icebergEstimatedBytes`를 계산한다. 모든 컬럼을 읽는 쿼리는 Catalog의 실제 `storageSizeBytes`를 하한으로 사용하며 `estimateSource="iceberg_metadata"`를 반환한다.
- Iceberg metadata를 얻지 못한 경우에만 `EXPLAIN (TYPE DISTRIBUTED)`의 `planEstimatedBytes`와 Catalog `storageSizeBytes` 기반 heuristic으로 fallback한다. Catalog 기반 값이 Plan보다 크면 `conservative_bound`, Plan이 크거나 같으면 `trino_plan`, Catalog 값만 있으면 `catalog_heuristic`이다.
- 예상 시간은 실행 이력을 보정에 사용하지 않고, 현재 SQL의 `estimatedBytes / TRINO_QUERY_ESTIMATED_THROUGHPUT_BYTES_PER_SECOND`를 0.1초 단위로 계산해 `durationEstimateSource="configured_throughput"`으로 반환한다. 적용한 기준 처리속도는 `estimatedThroughputBytesPerSecond`로 응답한다. 과거 run의 실제 시간과 처리량은 실행 이력 화면에서만 조회한다.
- `estimatedBytes`는 warning, confirmation, hard limit에 사용한다. 실제 처리량과 시간은 완료 Query Run의 `stats.processedBytes`, `stats.elapsedMs`가 source of truth다.
- `TRINO_QUERY_WARNING_BYTES` 이상이면 `confirmationRequired=true`와 query/actor/dataset/TTL-bound signed token을 반환한다.
- Catalog 크기가 없어도 Trino plan byte estimate가 있으면 그 estimate로 threshold를 판정한다. plan과 Catalog 크기를 모두 얻지 못한 경우에만 불확실성 확인용 `confirmationRequired=true`를 반환한다.
- 같은 조건에서 `POST /api/query/runs`는 `confirmationToken` 없이는 `409 QUERY_CONFIRMATION_REQUIRED`를 반환한다. token은 다른 SQL, 다른 사용자, 다른 Dataset에 재사용할 수 없다.
- `TRINO_QUERY_MAX_ESTIMATED_BYTES`가 0보다 크고 estimate를 넘으면 확인 여부와 무관하게 `409 CONFLICT`로 실행을 차단한다.

프론트 기대 동작:

- `실행` 클릭은 최대 100행 Trino preview를 제출하고 status polling을 시작한다. preview가 성공하면 표·차트와 처리 Job 생성 action을 즉시 사용할 수 있다.
- SQL 분석 화면은 유효한 SQL을 자동 평가하되 editor 높이·toolbar·textarea scroll을 바꾸지 않습니다. 현재 Query Run의 평가와 timeline은 결과 panel의 `실행 정보` view에서 표시합니다. `GET /api/query/runs`의 사용자별 실행 이력 조회·재열기 계약은 유지하지만, 이번 화면에는 별도 최근 실행 선택 목록을 노출하지 않습니다.
- preview 결과 table은 inline page를 요청해 렌더링한다. `전체 보기`는 별도 full run의 server cursor page를 100행씩 lazy 조회한다.
- 결과 panel의 세 번째 `실행 정보` view는 preview의 `쿼리 실행 -> 첫 결과 준비`를 순서대로 렌더링한다. 요청 접수와 Trino 대기는 첫 단계의 phase label로 표현하고, full run의 준비 상태를 preview 진행률과 합치지 않는다.
- 쿼리 진행 bar는 active 상태가 2초 이상이고 Trino `progressPercentage` 또는 완료 driver/split 비율이 있을 때만 표시한다. 둘 다 없으면 숫자/bar를 생략한다. Dataset 물리 크기나 frontend timer로 중간 퍼센트를 만들지 않으며 estimate risk는 `대용량 처리 예상` 안내에만 사용한다.
- `첫 결과 준비`는 서버의 preview page 준비 시간과 브라우저의 첫 page 요청·렌더링 시간을 보여 주되 퍼센트를 표시하지 않는다. 조회 가능한 최초 page 자동 조회는 현재 page가 없을 때 한 번만 수행한다. 조회 실패는 단계 실패와 재시도 action으로 표시하며, 재시도 성공 시 화면 표시 시간을 다시 측정한다. `expired`/`unavailable` 이력은 page를 자동 재요청하지 않고 저장된 첫 결과 milestone을 유지한다.
- Preview 완료 시 가능한 경우 `Trino 실행 · 첫 결과` 시간을 상단에 요약한다. Full run의 전체 저장 진행은 전체 보기/CSV 준비 상태로 별도 표시하고 preview timeline과 합치지 않는다. API timing field가 없는 legacy run은 가능한 timestamp 차이만 사용하고 알 수 없는 시간은 만들지 않는다.
- Trino 원격 결과 현재 page는 SQL 화면의 임시 차트 source로만 사용할 수 있고 persistent Dashboard source로 저장하지 않습니다. publish 또는 반복 사용은 materialized Dataset을 source로 사용합니다.
- 실패·취소·권한 차단은 Query Run 상태와 admin audit log에 기록합니다.

### 7.8 Query AI SQL 초안 생성

`POST /api/query/ai-suggestions`

프론트 함수:

- `generateQueryAiSuggestion({ baseDataset, selectedDatasets, prompt, query })`

Request:

```ts
type QueryAiSuggestionRequest = {
  baseDatasetId?: string;
  currentQuery?: string;
  mode?: "draft_sql";
  prompt: string;
  semanticModelId?: string;
  selectedDatasetIds: string[];
};
```

Request 예시:

```json
{
  "baseDatasetId": "ds_orders_clean",
  "currentQuery": "SELECT order_id, customer_id FROM orders_clean LIMIT 100;",
  "mode": "draft_sql",
  "prompt": "고객별 주문과 클릭 이벤트를 조인해서 보고 싶다",
  "semanticModelId": "semantic_customer_orders_v3",
  "selectedDatasetIds": ["ds_orders_clean", "ds_clickstream_events"]
}
```

Response `200 OK`:

```ts
type QueryAiSuggestionResponse = {
  body: string;
  generationAttempts: number;
  regenerationCount: number;
  generatorVersion: string;
  promptVersion: string;
  mode: "draft_sql";
  requestId: string;
  model?: string | null;
  provider?: string | null;
  notices: string[];
  retrieval?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  sql: string;
  title: string;
  usedEvidenceIds: string[];
};
```

Response 예시:

```json
{
  "body": "orders_clean에서 customer_id별 total_amount 합계를 조회하는 읽기 전용 SQL 초안입니다.",
  "generationAttempts": 1,
  "regenerationCount": 0,
  "generatorVersion": "query-ai-service-v2",
  "promptVersion": "cost-aware-v2",
  "mode": "draft_sql",
  "requestId": "85afbfc4-e3ac-4b3d-9281-c8beaa0fe020",
  "model": "gpt-4.1-mini",
  "provider": "openai",
  "notices": [
    "AI가 생성한 초안입니다. 실행 전 기존 점검 결과를 확인해 주세요."
  ],
  "retrieval": {
    "provenance": "semantic_layer_rag",
    "status": "ready",
    "resultCount": 1
  },
  "sources": [{"documentId": "rag_doc_orders_17", "datasetId": "ds_orders_clean"}],
  "sql": "SELECT customer_id, SUM(total_amount) AS total_amount_sum\nFROM orders_clean\nGROUP BY customer_id\nORDER BY total_amount_sum DESC\nLIMIT 100;",
  "title": "고객별 주문 금액 SQL 초안",
  "usedEvidenceIds": ["rag_doc_orders_17"]
}
```

Validation:

- `prompt`와 최소 1개 이상의 `selectedDatasetIds`가 필수입니다.
- frontend는 선택한 dataset id만 전달합니다. backend가 현재 actor의 권한·governance를 확인한 뒤 Catalog에서 최신 metadata와 schema를 다시 읽으므로 client metadata는 신뢰하거나 provider에 전달하지 않습니다.
- backend는 Query AI provider key를 읽지 않고 private AI Gateway에 service token과 dataset-scoped signed context만 전달합니다. provider key는 `AI_PROVIDER_API_KEY`로 AI Gateway 컨테이너에만 주입하며 브라우저에 노출하지 않습니다.
- AI 응답 SQL도 backend에서 read-only guard를 다시 통과해야 합니다.
- AI 응답 SQL은 선택된 dataset context 밖의 table을 참조하면 `422 VALIDATION_ERROR`로 실패해야 합니다.
- 평균, 합계, 개수, 그룹화처럼 prompt에 명시된 분석 의도가 SQL select/group/aggregation에 반영됐는지 검증합니다. 위반하면 위반 목록을 포함해 Gateway에 한 번만 교정 재요청하고 두 번째 응답도 위반하면 `422 VALIDATION_ERROR`를 반환합니다.
- backend가 Catalog의 schema/type, storage bytes, partition column, estimated rows, key/role hint와 Trino scan 경계를 cost-aware context로 제공한다. 응답 SQL은 `SELECT *`, CROSS JOIN/key 없는 JOIN, partition column 함수, untyped temporal literal, 허가되지 않은 approximate aggregation을 정적으로 검사합니다.
- intent 위반과 cost 위반은 하나의 공통 retry budget을 사용하며 전체 교정은 최대 1회입니다. `generationAttempts`, `regenerationCount`, `generatorVersion`, `promptVersion`은 benchmark lineage와 운영 분석을 위한 additive metadata입니다.
- 선택된 dataset 중 하나라도 현재 actor에게 `query` 권한이 없으면 dataset metadata를 AI context로 보내기 전에 `403 FORBIDDEN`을 반환합니다.
- 선택된 reference dataset이 있으면 Query AI는 선택 dataset context 안에서 JOIN SQL 초안을 만들 수 있습니다.
- frontend는 Gateway가 검증된 SQL 초안을 반환하지 않으면 오류를 표시하며 로컬 SQL 초안을 대신 만들지 않습니다.
- `SELECT` 또는 `WITH ... SELECT` 기반 단일 statement만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 허용하지 않습니다.
- AI 응답이 `LIMIT`을 생략하거나 100을 초과하면 backend가 preview 기준 `LIMIT 100`으로 보정한 뒤 검증합니다.
- private AI Gateway 또는 Semantic RAG 호출 실패는 공통 error envelope로 반환하고, 프론트는 기존 Query AI 오류 문구를 표시합니다.
- `sources`는 검색 후보 전체가 아니라 `usedEvidenceIds`와 정확히 일치하는 실제 사용 근거만 포함합니다.
- `usedEvidenceIds`는 검색 후보 ID의 부분집합이어야 한다. Backend는 후보·실사용 ID, actor, provider/model, context/output fingerprint를 `ai_generation_usage`에 저장하며 검증되지 않은 ID나 mock/fallback provenance는 `502`로 거부합니다.
- Gateway의 내부 Catalog 조회는 request-scoped signed context token을 한 번만 소비한다. token 재사용, 만료, Dataset 범위 이탈은 context를 반환하기 전에 거부하며 MCP projection은 schema/sample 수를 제한하고 PII·credential 값을 redaction합니다.

프론트 기대 동작:

- Query AI 제안은 자동 실행하지 않고 SQL editor 적용 버튼을 통해서만 반영합니다.
- 한 번에 하나의 cancellable 요청만 소유하며 prompt, 선택 Dataset, editor query 또는 dialog context가 바뀌면 이전 요청을 무효화하고 늦게 도착한 응답을 적용하지 않습니다.
- editor에 반영된 SQL은 기존 preflight와 `POST /api/query/runs` 검증을 다시 통과해야 실행됩니다.
- provider 실패나 RAG 선행 조건 부족을 가짜 SQL·근거로 대체하지 않습니다.

### 7.8.1 ETL transform AI 생성

`POST /api/ai/generate-sql`

```ts
type AiSqlGenerationRequest = {
  question: string;
  promptType?: "query_page" | "field_transform" | "sql_transform" | "partition" | "general";
  metadata?: Record<string, unknown>;
  context?: string;
  engine?: string;
};

type AiSqlGenerationResponse = {
  sql: string;
  schemaContext: string;
  model?: string | null;
  provider?: string | null;
};
```

FastAPI는 private Gateway의 `etl_transform` mode만 호출한다. `field_transform`은 supplied metadata column만 참조하는 scalar expression이어야 하고, `sql_transform` 또는 SELECT 결과는 `input`과 자체 CTE만 참조하는 단일 read-only query여야 한다. Wildcard field transform, Spark script transform, `reflect`, `java_method`, input 밖 relation/column은 `502 SQL_SYNTAX_ERROR`로 거부한다. Provider key는 Gateway에만 있고 Gateway 실패·mock/fallback provenance·invalid SQL은 성공 응답으로 대체하지 않는다.

### 7.9 DuckDB compatibility SQL 결과 기반 Lake Dataset 생성

이 section은 `TRINO_ENABLED=false` compatibility path와 기존 client를 위한 계약입니다. Trino 결과 screen은 이 API의 1회성 Dataset action을 노출하지 않고 server CSV와 `POST /api/etl/sql-jobs` 반복 Job만 제공합니다. Trino의 1회성 Iceberg CTAS API는 7.7의 별도 운영 경로로 유지합니다.

`POST /api/catalog/derived-datasets`

프론트 함수:

- `createDerivedDatasetFromSql({ request, sourceDataset, sqlResult })`
- 현재 SQL 화면의 `처리 Job 생성` UI는 `SqlJobWizardDialog`에서 기본 정보, 스케줄, 거버넌스, 저장 설정을 순차 입력한다. 최종 제출 시 `createSqlDatasetJob(request)`가 SQL Result metadata와 설정을 명시적인 ETL `DraftPipeline`으로 변환해 `POST /api/etl/jobs`를 호출하며 `/etl/review`로 이동하지 않는다.

Request:

```ts
type CreateDerivedDatasetRequest = {
  dataset: {
    description: string;
    layer: "SILVER" | "GOLD";
    name: string;
    rag: boolean;
    refreshPolicy: "manual";
    tags: string[];
  };
  job?: {
    accessScope: "organization" | "private" | "project";
    compression: "Gzip" | "None" | "Snappy";
    owner: string;
    principalId?: string;
    overlapPolicy: "skip_if_running" | "queue_after_current" | "allow_parallel";
    partitionColumn?: string;
    permissionSummary: string;
    scheduleLabel: string;
    scheduleMode: "manual" | "repeat";
    scheduleSummary: string;
    storagePath: string;
    timezone?: string;
  };
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  sourceDatasetId: string;
  sourceRunId: string;
  validationKey?: string;
};
```

Compatibility Job의 `job.principalId`도 같은 정책을 따릅니다. private은 owner fallback만, organization은 인증 사용자 public principal, project는 선택한 실제 group principal을 `permission.roles`에 보존하며 `Data Engineer Group` 같은 고정 demo 역할을 만들지 않습니다.

Request 예시:

```json
{
  "dataset": {
    "description": "일별 매출 SQL Preview 결과로 생성한 분석 데이터셋",
    "layer": "GOLD",
    "name": "sales_daily_summary_analysis",
    "rag": false,
    "refreshPolicy": "manual",
    "tags": ["commerce", "daily"]
  },
  "job": {
    "accessScope": "organization",
    "compression": "Snappy",
    "databaseName": "asklake",
    "fileFormat": "parquet",
    "owner": "data-team-01",
    "overlapPolicy": "skip_if_running",
    "partitionColumn": "order_date",
    "partitionColumns": ["order_date", "channel"],
    "permissionSummary": "Data Engineer Group · 조직 내부 · 승인 검토",
    "scheduleLabel": "매일 09:00",
    "scheduleMode": "repeat",
    "scheduleSummary": "반복 실행 · 매일 09:00 · Asia/Seoul · 실행 중이면 다음 예약 건너뜀",
    "storagePath": "s3a://asklake-output/sales_daily_summary_analysis/gold/",
    "tags": ["commerce", "daily"],
    "timezone": "Asia/Seoul"
  },
  "previewLimit": 100,
  "query": "SELECT ...",
  "referenceDatasetIds": ["ds_product_master"],
  "sourceDatasetId": "ds_sales_daily_summary",
  "sourceRunId": "sql_preview_01J1Z8W2V7KX",
  "validationKey": "frontend-generated-context-key"
}
```

Response `201 Created`:

```ts
type CreateDerivedDatasetResponse = CatalogDataset;
```

프론트 기대 동작:

- DuckDB compatibility 화면의 materialize UX는 생성 대상 이름/설명과 `sourceRunId`, `query`, `referenceDatasetIds`를 보존하고, 같은 모달에서 스케줄·거버넌스·DB·파일 포맷·압축·다중 파티션·태그·저장 경로를 설정한다. SQL 간편 생성에서는 레이어 선택과 RAG 설정을 노출하지 않고 내부 기본값 `GOLD`, `false`를 사용한다. `partitionColumn`은 첫 선택값을 담는 하위 호환 필드이고 `partitionColumns`가 전체 선택 순서의 source of truth다.
- 마지막 `처리 Job 생성`을 누르면 기존 `POST /api/etl/jobs` 경로로 처리 Job이 생성되고, 실행 성공 후 Catalog dataset 등록 흐름을 따른다.
- 생성된 dataset을 Catalog 목록 맨 앞에 추가합니다. SQL 작성 화면이 리셋되지 않도록 현재 선택 dataset은 유지할 수 있습니다.
- 저장 화면에서 입력한 `name`, `description`, 스케줄, owner, permission summary, DB, 파일 포맷, 압축, 다중 파티션, 태그, 저장 경로를 생성 Job metadata에 반영합니다.
- SQL 결과의 처리 Job은 ETL 생성 경로를 통해 backend Catalog Dataset으로 영속화합니다. browser localStorage에 derived Dataset을 만들지 않습니다.
- live API mode에서는 localStorage fallback을 사용하지 않고 `POST /api/catalog/derived-datasets` 응답과 이후 `GET /api/catalog/datasets` hydrate를 신뢰합니다.
- `sampleRows`, `schema`, `upstream`에는 SQL Preview 결과와 `sourceRunId` 연결 정보가 포함되어야 합니다.
- `lineageGraph`가 있으면 카탈로그의 데이터 흐름도 확인에서 원본 dataset -> SQL derived dataset 관계를 표시합니다.
- 응답 dataset에 `lineageGraph`가 있으면 Catalog lineage modal은 이를 우선 사용합니다.
- `lineageGraph`에는 source dataset의 기존 upstream graph와 새 derived dataset node, source column -> derived column edge가 포함되어야 합니다.
- 실패 시 `analysis.derived_dataset.create_failed` 감사 로그와 Toast를 남깁니다.

## 8. P1 API

### 8.1 데이터셋 목록

`GET /api/catalog/datasets`

Query parameter 권장:

| 이름 | 타입 | 설명 |
| --- | --- | --- |
| `q` | string | 검색어 |
| `tag` | string | 태그 필터 |
| `layer` | string | `RAW`, `BRONZE`, `SILVER`, `GOLD` |
| `owner` | string | 소유자 |
| `cursor` | string | 다음 페이지 cursor |
| `limit` | number | 기본 20 |

Response `200 OK`:

```json
{
  "datasets": [
    {
      "id": "ds_customer_review_silver",
      "name": "customer_review_silver",
      "description": "고객 리뷰 정제 데이터셋",
      "owner": "Data Engineer Group",
      "layer": "SILVER",
      "status": "available",
      "freshness": "latest",
      "source": "customer_review_daily_ingest",
      "rows": "128,420 rows",
      "size": "2.1 GB",
      "quality": "98%",
      "lastUpdated": "2026-07-03T11:30:00.000Z",
      "nextRefresh": "매일 09:00",
      "rag": true,
      "tags": ["#customer", "#review", "#silver"],
      "schema": [["review_id", "bigint"], ["rating", "int"]],
      "sampleRows": [["10001", "5"], ["10002", "3"]],
      "upstream": ["Amazon S3"],
      "downstream": ["SQL 분석", "대시보드"]
    }
  ],
  "page": {
    "cursor": null,
    "hasNext": false
  }
}
```

프론트 연결 시점:

- 앱 초기 로딩 때 `GET /api/catalog/datasets`로 hydrate합니다.
- 생성 직후에는 Catalog에 추가하지 않습니다.
- 비동기 `POST /api/etl/jobs/{jobId}/commands` 응답은 Catalog dataset을 포함하지 않습니다. `publish_run_result`가 저장한 dataset과 materialization history는 Catalog·SQL·AI route 진입 시 Catalog domain loader가 `GET /api/catalog/datasets`로 반영합니다.
- Spark run 결과 dataset과 SQL derived dataset은 모두 `catalog_datasets.payload`를 Catalog API의 source of truth로 저장합니다. 기존 컬럼 기반 row는 읽기 호환 fallback으로만 사용합니다.
- 검증된 Spark/Iceberg publication은 같은 payload와 `catalog_datasets.source_manifest`에 RAG source contract를 저장합니다. `sourceManifest`는 `manifestVersion=1`, Dataset/Run identity, Spark-readable Iceberg table path, source fingerprint, expiry, exact `icebergSnapshotId`를 포함합니다. RAG Spark parent stage는 이 snapshot을 `snapshot-id` option으로 읽으며 최신 table head로 조용히 이동하지 않습니다. Iceberg snapshot 증적이 없으면 manifest를 발급하지 않고 RAG dispatch가 fail-closed 합니다.
- Spark run 결과 dataset과 SQL derived dataset은 모두 `size`를 표시용 저장 크기로 내려주고, 물리 위치/포맷/byte 크기는 `storageLocation`, `storageFormat`, `storageSizeBytes`에 담습니다.
- Spark run 결과 dataset과 SQL derived dataset은 같은 `dataset.id`의 `materializationRuns` history를 idempotent하게 갱신합니다. 같은 `runId`가 다시 처리되면 기존 항목을 교체하고 중복 추가하지 않습니다. 일반 full-refresh 결과는 snapshot이므로 새 성공 Run이 현재 Dataset을 교체하고, 과거 Run은 history로만 남습니다.
- Spark run 결과 dataset은 source -> Spark job -> target 기본 `lineageGraph`를 payload에 저장합니다. SQL derived dataset은 source dataset lineage를 이어받아 source -> derived column edge를 저장합니다.
- SQL derived dataset 생성은 `CatalogService`와 `CatalogRepository.saveDatasetPayload` 경로만 사용합니다. ETL service는 pipeline/job/run 생성과 Spark 결과 dataset 저장만 소유합니다.
- pipeline 생성 Dataset과 SQL 결과 처리 Job Dataset은 같은 backend Catalog persistence와 권한 계약을 사용합니다.

### 8.2 데이터셋 상세

`GET /api/catalog/datasets/{datasetId}`

Response `200 OK`:

```ts
type DatasetDetailResponse = CatalogDataset;
```

상세 보조 API:

```text
GET /api/catalog/datasets/{datasetId}/schema
GET /api/catalog/datasets/{datasetId}/rows?offset=0&limit=100
GET /api/catalog/datasets/{datasetId}/lineage
```

#### 8.2.1 데이터셋 실제 row page

`GET /api/catalog/datasets/{datasetId}/rows?offset={offset}&limit={limit}`

Catalog 상세와 `전체 스키마 상세보기` modal은 payload의 제한 `sampleRows`가 아닌 이 endpoint로 실제 materialized row를 탐색합니다.

Query parameter:

| 이름 | 타입 | 기본/제한 | 설명 |
| --- | --- | --- | --- |
| `offset` | number | 기본 0, 0 이상 | 0-base 시작 위치 |
| `limit` | number | 기본 100, `1..500` | 반환할 page 행 수 |

Response `200 OK`:

```json
{
  "datasetId": "ds_customer_review_silver",
  "datasetName": "customer_review_silver",
  "columns": ["review_id", "rating"],
  "rows": [["10101", "4"], ["10102", "5"]],
  "rowCount": 10000,
  "returnedRows": 2,
  "offset": 100,
  "limit": 2,
  "hasNext": true
}
```

Runtime/permission:

- Dataset 상세 `view` 권한과 row 조회 `query` 권한을 모두 검사하며, 없으면 `403 FORBIDDEN`을 반환합니다.
- Iceberg Dataset은 `storageFormat=iceberg`, `queryEngineStatus=available`, 완전한 `queryEngineTable`을 검증한 뒤 `$refs`의 `main` snapshot ID를 한 번 고정합니다. `COUNT(*)`와 bounded `LIMIT`/`OFFSET`은 모두 그 snapshot을 `FOR VERSION AS OF`로 읽으므로 한 응답 안에서 count/page가 서로 다른 commit을 보지 않습니다. warehouse의 Parquet object를 직접 glob하지 않습니다.
- Iceberg row projection은 Catalog schema의 사용자 컬럼만 명시적으로 선택합니다. `_asklake_*` 같은 내부 idempotency/ingest marker는 물리 table에 남아도 API `columns`와 `rows`에 노출하지 않습니다.
- 전환 전 CSV/JSON/JSONL/Parquet Dataset은 성공 materialization history와 dataset storage metadata에서 active segment를 계산해 기존 DuckDB compatibility reader를 사용합니다. 물리 위치가 없거나 읽을 수 없으면 실제 row 조회 실패를 반환합니다.
- 어느 reader도 response/DOM에 전체 row를 적재하지 않습니다.
- `rowCount`는 고정한 snapshot의 전체 행 수, `returnedRows`는 현재 page 행 수입니다. `offset == rowCount`이면 빈 `rows`와 `hasNext=false`를 반환합니다. 이 API는 preview용 offset pagination이며 정렬 key를 받지 않으므로 서로 다른 요청 사이의 안정적인 row order는 보장하지 않습니다.
- 스키마 상세 modal은 스키마와 row page를 함께 표시하고, 새로고침·첫/이전/다음/마지막 page·수평 스크롤·고정 header를 제공합니다. modal을 닫아도 Catalog 검색/필터 상태는 유지합니다.

`GET /api/catalog/datasets/{datasetId}/lineage` Response `200 OK`:

```ts
type DatasetLineageResponse = LineageGraph;
```

Response 예시:

```json
{
  "datasetId": "ds_customer_orders_gold",
  "datasets": [
    {
      "id": "source-commerce-orders",
      "name": "commerce.orders",
      "layer": "SOURCE",
      "engine": "POSTGRESQL",
      "columns": [
        { "id": "order_id", "name": "order_id", "type": "string" }
      ]
    },
    {
      "id": "ds_customer_orders_gold",
      "name": "orders_clean",
      "layer": "GOLD",
      "engine": "ICEBERG",
      "columns": [
        { "id": "order_id", "name": "order_id", "type": "string" }
      ]
    }
  ],
  "edges": [
    {
      "fromDatasetId": "source-commerce-orders",
      "fromColumnId": "order_id",
      "toDatasetId": "ds_customer_orders_gold",
      "toColumnId": "order_id"
    }
  ]
}
```

현재 프론트는 `CatalogDataset` 하나에 schema, sampleRows, upstream, downstream을 포함해서 표시하고, lineage modal은 `LineageGraph`를 우선 사용합니다.
Lineage API가 unavailable이면 화면은 오류와 재시도를 표시하며 `CatalogDataset.upstream` fixture로 실제 lineage를 가장하지 않습니다.

### 8.3 데이터셋 materialization 결과 삭제

`DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}`

이 API는 dataset 전체를 삭제하지 않고, dataset 안의 특정 snapshot/delta materialization metadata만 제거합니다. 현재 범위에서는 물리 lake 파일 삭제나 compaction을 수행하지 않습니다. Iceberg-backed Dataset은 metadata history만 삭제하면 실제 table snapshot과 불일치하므로 `422 ICEBERG_MATERIALIZATION_DELETE_UNAVAILABLE`로 거절합니다. 아래 재계산 동작은 legacy file-backed Dataset에만 적용합니다.

Response `200 OK`:

```ts
type DeleteMaterializationRunResponse = {
  deletedRunId: string;
  dataset: CatalogDataset;
};
```

서버는 삭제 후 남아 있는 성공 `materializationRuns` 중 최신 snapshot과 그 이후 delta를 기준으로 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`, `storageLocation`을 재계산합니다. 현재 snapshot을 삭제하면 직전 성공 snapshot이 다시 active 기준점이 됩니다. active 결과를 모두 삭제하면 dataset shell은 남고 합산 값은 `0 rows`, `0B`가 됩니다. 전체 dataset 삭제는 별도 API/UX로 분리합니다.

### 8.4 Dashboard FastAPI 구현 경계

Dashboard FastAPI 전환은 `dashboard card`와 `dashboard runtime`을 분리해서 구현한다.
목록 화면은 card metadata만 사용하고, 대시보드 내부 화면은 draft/published revision snapshot을 사용한다.
공통 Pydantic schema skeleton은 `backend/app/schemas/dashboard.py`를 기준으로 한다.

#### 8.2.1 작업 lane

| Lane | 담당 범위 | 주요 schema | 주요 endpoint |
| --- | --- | --- | --- |
| Dashboard card/list | 랜딩 페이지 목록, 검색/필터/정렬, 생성, 제목 수정, 삭제 | `DashboardCard`, `DashboardListQuery`, `DashboardListResponse`, `CreateDashboardRequest`, `UpdateDashboardRequest` | `GET /api/dashboards`, `POST /api/dashboards/query`, `POST /api/dashboards`, `PATCH /api/dashboards/{dashboardId}`, `DELETE /api/dashboards/{dashboardId}` |
| Dashboard runtime | 내부 조회/편집 화면, draft/published revision, page, widget, layout, publish | `DashboardRuntimeResponse`, `DashboardRuntimeWidget`, `CreateDraftWidgetRequest`, `SaveDraftLayoutsRequest`, `PublishDashboardResponse` | `GET /api/dashboards/{dashboardId}/published`, `POST /api/dashboards/{dashboardId}/draft/ensure`, page/widget/layout/publish APIs |

Card/list lane은 `dashboards`와 `dashboard_tags` 중심으로 작업한다.
Runtime lane은 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets` 중심으로 작업한다.
두 lane은 `dashboardId`와 `publishedRevisionId`만 공유하고, 서로의 DB 쿼리를 직접 수정하지 않는다.

#### 8.2.2 DB table 방향

초기 FastAPI 구현의 table 방향은 아래처럼 둔다.
정식 migration 파일은 후속 PR에서 작성하되, repository/service는 이 소유 경계를 기준으로 나눈다.

| Table | 소유 lane | 역할 | 핵심 필드 |
| --- | --- | --- | --- |
| `dashboards` | card/list | 목록 card의 source of truth | `id`, `name`, `owner`, `status`, `dataset_id`, `source_run_id`, `published_revision_id`, `has_published_revision`, `created_at`, `updated_at`, `payload` |
| `dashboard_tags` | card/list | 목록 필터용 tag normalize | `dashboard_id`, `tag` |
| `dashboard_revisions` | runtime | draft/published snapshot 단위 | `id`, `dashboard_id`, `kind`, `version`, `published_at`, `created_at`, `updated_at` |
| `dashboard_pages` | runtime | revision 안의 page | `id`, `revision_id`, `title`, `order_index`, `created_at`, `updated_at` |
| `dashboard_widgets` | runtime | page 안의 widget snapshot | `id`, `page_id`, `type`, `title`, `dataset_id`, `query_id`, `layout`, `config`, `data`, `created_at`, `updated_at` |
| `dataset_freshness` | live runtime | dataset별 최신 공개 revision과 권장 polling 시간 | `dataset_id`, `latest_revision`, `latest_run_id`, `next_check_after_ms`, `updated_at` |
| `dataset_revision_commits` | live runtime | revision과 S3 batch/Kafka offset 근거 연결 | `dataset_id`, `revision`, `run_id`, `storage_location`, `storage_format`, `materialization_mode`, `commit_kind`, `row_count`, `source_ranges`, `source_fingerprint`, `manifest_location`, `committed_at` |
| `dataset_kafka_partition_cursors` | live runtime | 과거 commit 전체 조회 없이 stream offset 순서·중복 검사 | `dataset_id`, `commit_kind`, `topic`, `partition`, `next_offset`, `updated_revision`, `updated_at` |
| `dashboard_widget_results` | live runtime | widget 계산 버전별 최신 결과와 merge state | `widget_id`, `calculation_version`, `dataset_id`, `applied_revision`, `result_payload`, `calculation_state`, `calculation_mode`, `calculated_at` |

`layout`, `config`, `data`, dashboard card의 보조 payload는 PostgreSQL JSONB 후보로 둔다.
API response field는 `camelCase`, DB column은 `snake_case`를 사용한다.

#### 8.2.3 publish 규칙

Published 조회는 published revision만 읽는다.
Draft 변경은 published revision을 직접 수정하지 않는다.

```text
위젯 편집 진입
↓
POST /api/dashboards/{dashboardId}/draft/ensure
↓
draft revision/page/widget 수정
↓
POST /api/dashboards/{dashboardId}/publish
↓
draft snapshot을 새 published revision으로 복사
↓
dashboards.published_revision_id, has_published_revision, status, updated_at, payload 갱신
```

published revision이 없는 dashboard의 published 조회는 오류가 아니라 빈 runtime 응답으로 처리한다.
즉 `revision: null`, `pages: []`, `widgetsByPageId: {}`를 반환한다.

#### 8.2.4 PR 순서

1. Dashboard 계약/schema skeleton 정리
2. Dashboard card/list API 구현
3. Published 조회와 draft ensure API 구현
4. Draft page API 구현
5. Draft widget/layout/publish API 구현
6. Frontend API adapter와 FastAPI E2E 확인

### 8.3 대시보드 목록 조회

`POST /api/dashboards/query`

첫 진입은 `GET /api/dashboards`가 기본 정렬 기준으로 10개만 반환합니다.
검색, 필터, 정렬, 다음 page 요청은 프론트가 JSON body를 보내고 서버가 SQL 조건을 구성해 조회합니다.

Request body:

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `search` | string | no | dashboard 이름, 소유자, 태그 검색어 |
| `searchQuery` | string | no | local API 호환 검색어. `search`와 같은 의미 |
| `owner` | string | no | 특정 소유자 필터 |
| `tags` | string[] | no | 선택된 태그 목록. 예: `["Marketing", "ROI"]` |
| `sort` | string | yes | `name-asc`, `name-desc`, `updated-asc`, `updated-desc`, `created-asc`, `created-desc` |
| `page` | number | yes | 1부터 시작하는 page 번호 |
| `pageSize` | number | yes | 한 page에 표시할 dashboard 개수 |

Request 예시:

```json
{
  "searchQuery": "roi",
  "owner": "Jane Doe",
  "tags": ["Marketing", "ROI"],
  "sort": "updated-desc",
  "page": 1,
  "pageSize": 10
}
```

Response `200 OK`:

```ts
type DashboardListResponse = {
  items: SavedDashboardCard[];
  total: number;
  page: number;
  pageSize: number;
  filterOptions: {
    owners: string[];
    tags: string[];
  };
};
```

`SavedDashboardCard`도 optional `createdBy`, `createdByProfile`, `permissionGrants`, `permissions`를 포함할 수 있습니다. Dashboard 생성 API는 현재 actor를 만든 사람 metadata로 저장합니다. Dashboard 목록/수정/삭제/runtime 권한 검사는 공통 `ActorContext`/`can()` 코어를 사용하며, 현재 호환성을 위해 admin 또는 dashboard owner fallback이면 해당 action을 수행할 수 있습니다.

`items`는 이미 서버에서 검색, 필터, 정렬, pagination이 적용된 현재 page 목록입니다.
서버는 actor 기준 `view` 권한이 있는 dashboard만 `items`에 포함합니다. 프론트 숨김은 UX 보조이며, 직접 URL/API 접근은 backend 권한 검사에서 다시 차단됩니다.
프론트는 `items`를 그대로 표시하고, `total`, `page`, `pageSize`로 pagination UI를 계산합니다.
`filterOptions`는 현재 page에 보이는 값이 아니라 actor가 볼 수 있는 전체 dashboard 목록 기준으로 선택 가능한 소유자와 태그를 내려줍니다.

### 8.4 대시보드 삭제

`DELETE /api/dashboards/{dashboardId}`

대시보드 목록에서 삭제 버튼을 누르면 프론트가 먼저 사용자 확인 모달을 띄우고, 확인 후 이 API를 호출합니다.
서버는 삭제 전에 해당 dashboard가 존재하는지 확인하고, 공통 permission check로 `delete` 권한을 검사합니다.
삭제가 성공하면 card/list row와 함께 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets` runtime snapshot row도 정리합니다.

Request body는 없습니다.

Actor 입력:

| Header | 기본값 | 설명 |
| --- | --- | --- |
| `asklake_session` cookie | 없음 | 세션이 있으면 session user를 actor로 우선 사용 |
| `X-AskLake-User` | `Admin User` | 세션이 없을 때 fallback 요청 사용자 이름 |
| `X-AskLake-Role` | `admin` | 세션이 없을 때 fallback role. `admin`이면 모든 dashboard 삭제 가능 |
| `X-AskLake-Groups` | 빈 값 | 세션이 없을 때 fallback group 목록 |

권한 허용 기준은 `admin 전체 허용 -> owner fallback -> permissionGrants delete action -> 403` 순서입니다. `permissionGrants`에는 dashboard payload의 legacy grant와 `permission_grants` table row가 병합됩니다.

Response `200 OK`:

```json
{
  "deletedDashboardId": "dash_sales_analytics_demo"
}
```

Error:

| Status | Code | 상황 |
| --- | --- | --- |
| `403` | `FORBIDDEN` | 삭제 권한이 없는 사용자 |
| `404` | `NOT_FOUND` | 존재하지 않는 dashboard |

삭제 성공 후 프론트는 dashboard 목록을 다시 조회합니다.

### 8.5 대시보드 초안 생성

`POST /api/dashboards`

대시보드 랜딩 페이지의 `새 대시보드 생성` 버튼에서 호출한다.
생성 즉시 `dashboards` 테이블에 `status: "draft"` 카드 정보를 저장하고, 프론트는 응답받은 `dashboard.id`로 `/dashboards/{dashboardId}` 조회 화면에 진입한다.
실제 편집용 draft revision/page/widget은 사용자가 내부 화면에서 `위젯 편집`을 눌렀을 때 `POST /api/dashboards/{dashboardId}/draft/ensure`로 준비한다.
`게시` 동작은 `POST /api/dashboards/{dashboardId}/publish`를 호출하며, 이때 목록 status가 `published`로 바뀐다.

Request:

```ts
type CreateDashboardDraftRequest = {
  title?: string;
  source?: "manual" | "sql" | "catalog";
  datasetId?: string;
  sqlRunId?: string;
};
```

Request 예시:

```json
{
  "title": "새 대시보드 2026-07-05 16:42",
  "source": "manual"
}
```

Response `201 Created`:

```json
{
  "dashboard": {
    "id": "dash_1751710920000_ab12cd34",
    "name": "새 대시보드 2026-07-05 16:42",
    "owner": "Admin User",
    "meta": "0개 위젯 · 수동 생성",
    "status": "draft",
    "tags": "초안 · Dashboard",
    "createdAt": "2026-07-05 16:42",
    "createdAtValue": "2026-07-05T07:42:00.000Z",
    "updated": "방금 전",
    "updatedAtValue": "2026-07-05T07:42:00.000Z",
    "hasPublishedRevision": false,
    "widgets": []
  }
}
```

현재 프론트 동작:

- 랜딩 페이지에서 새 대시보드 생성 시 빈 dashboard card를 `draft`로 생성합니다.
- 생성 응답의 `dashboard.id`를 사용해 `/dashboards/{dashboardId}` 조회 화면으로 이동합니다.
- 위젯 추가와 draft revision 생성은 내부 화면의 `위젯 편집` 이후 별도 runtime API에서 처리합니다.

### 8.5.0 대시보드 제목 수정

`PATCH /api/dashboards/{dashboardId}`

대시보드 내부 draft 편집 화면에서 상단 제목을 수정할 때 사용합니다.
서버는 기존 dashboard card payload를 유지하고 `name`, `title`, `updated`, `updatedAtValue`만 갱신합니다.

Request:

```json
{
  "title": "월별 물류비 대시보드"
}
```

Response `200 OK`:

```json
{
  "dashboard": {
    "id": "dash_...",
    "name": "월별 물류비 대시보드",
    "updated": "방금 전",
    "updatedAtValue": "2026-07-05T07:42:00.000Z"
  }
}
```

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- 빈 제목이면 `400 VALIDATION_ERROR`.

### 8.5 대시보드 revision runtime

Phase 02 dashboard runtime은 기존 dashboard card 저장과 별도로 draft/published revision snapshot을 저장합니다.
현재 demo API는 PostgreSQL JSONB 기반 서버 스타일에 맞춰 `dashboard_revisions`, `dashboard_pages`, `dashboard_widgets`, `dashboard_tags` 테이블을 idempotent하게 생성합니다.

공통 response:

```ts
type DashboardRuntimeWidgetType =
  | "metric"
  | "table"
  | "bar_chart"
  | "line_chart"
  | "area_chart"
  | "donut_chart"
  | "pie_chart"
  | "radial_bar_chart"
  | "heatmap_chart"
  | "treemap_chart";
type DashboardWidgetAggregation = "sum" | "avg" | "count" | "min" | "max";
type DashboardWidgetDateUnit = "day" | "month" | "year";
type DashboardWidgetFormat = "number" | "currency" | "percent";
type DashboardWidgetSortDirection = "asc" | "desc";

type DashboardWidgetColorConfig = {
  colors: string[];
};

type DashboardWidgetConfigBase = {
  body?: string;
  description?: string;
  error?: string;
  errorMessage?: string;
  placeholderKind?: "visualization_request" | "text";
  prompt?: string;
};

type MetricWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  format?: DashboardWidgetFormat;
  valueKey: string;
};

type TableWidgetConfig = DashboardWidgetConfigBase & {
  columns: string[];
  limit?: number;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
};

type BarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  groupKey?: string;
  orientation?: "vertical" | "horizontal";
  xKey: string;
  yKey: string;
};

type LineChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  curve?: "smooth" | "straight" | "stepline";
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  xKey: string;
  yKey: string;
};

type AreaChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  stacked?: boolean;
  xKey: string;
  yKey: string;
};

type DonutChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  centerLabel?: string;
  labelKey: string;
  valueKey: string;
};

type PieChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

type RadialBarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  format?: DashboardWidgetFormat;
  labelKey?: string;
  max?: number;
  min?: number;
  valueKey: string;
};

type HeatmapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  valueKey: string;
  xKey: string;
  yKey: string;
};

type TreemapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

type DashboardRuntimeWidgetConfigByType = {
  area_chart: AreaChartWidgetConfig;
  metric: MetricWidgetConfig;
  table: TableWidgetConfig;
  bar_chart: BarChartWidgetConfig;
  line_chart: LineChartWidgetConfig;
  donut_chart: DonutChartWidgetConfig;
  pie_chart: PieChartWidgetConfig;
  radial_bar_chart: RadialBarChartWidgetConfig;
  heatmap_chart: HeatmapChartWidgetConfig;
  treemap_chart: TreemapChartWidgetConfig;
};

type DashboardRuntimeWidget = {
  [Type in DashboardRuntimeWidgetType]: {
    id: string;
    pageId: string;
    type: Type;
    title: string | null;
    layout: {
      x: number;
      y: number;
      w: number;
      h: number;
      minW?: number;
      minH?: number;
    };
    config: DashboardRuntimeWidgetConfigByType[Type];
    data: Array<Record<string, unknown>>;
    dataStatus?: "pending" | "ready" | "error";
    dataError?: string | null;
    queryId?: string | null;
    datasetId?: string | null;
    appliedRevision?: number | null;
    calculationVersion?: string | null;
    calculatedAt?: string | null;
    liveRefresh?: boolean;
  };
}[DashboardRuntimeWidgetType];

type DashboardRuntimeResponse = {
  dashboard: {
    id: string;
    title: string;
    status: "draft" | "published";
    permissionGrants?: PermissionGrant[];
    permissions?: ResourcePermissions;
    hasPublishedRevision: boolean;
    updatedAt: string;
  };
  mode: "published" | "draft";
  revision: {
    id: string;
    kind: "published" | "draft";
    version: number;
    publishedAt?: string | null;
  } | null;
  pages: Array<{
    id: string;
    title: string;
    orderIndex: number;
  }>;
  widgetsByPageId: Record<string, DashboardRuntimeWidget[]>;
  filters: Array<{ id: string; label: string; value: unknown }>;
};
```

#### 8.5.1 Published 조회

`GET /api/dashboards/{dashboardId}/published?includeData=false`

Response `200 OK`:

- published revision이 있으면 해당 revision의 pages/widgets를 반환합니다.
- published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`로 정상 응답합니다.
- `includeData` 기본값은 `true`로 기존 호출을 보존합니다. Frontend 최초 진입은 `false`를 보내 shell만 먼저 받습니다.
- shell의 Dataset widget은 layout/config를 유지하고 `data: []`, `dataStatus: "pending"`를 반환하며 물리 storage를 열지 않습니다. explicit text/snapshot widget은 `dataStatus: "ready"`입니다.

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- dashboard `view` 권한이 없으면 `403 FORBIDDEN`.

#### 8.5.2 Draft 조회/생성

`POST /api/dashboards/{dashboardId}/draft/ensure?includeData=false`

동작:

1. draft revision이 있으면 그대로 반환합니다.
2. draft가 없고 published revision이 있으면 published revision을 복사해 draft를 만듭니다.
3. 둘 다 없으면 빈 draft revision과 기본 page 1개를 만듭니다.

`includeData` 계약은 Published 조회와 같습니다. Frontend는 shell을 먼저 받은 뒤 선택 page의 pending widget만 별도 조회합니다.

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- dashboard `manage` 권한이 없으면 `403 FORBIDDEN`.

#### 8.5.3 Draft page 추가

`POST /api/dashboards/{dashboardId}/draft/pages`

Request:

```json
{
  "title": "제목 없는 페이지"
}
```

Response `201 Created`:

```json
{
  "id": "dashpage_...",
  "title": "제목 없는 페이지",
  "orderIndex": 1
}
```

#### 8.5.4 Draft page 이름 수정

`PATCH /api/dashboards/{dashboardId}/draft/pages/{pageId}`

현재 draft revision에 속한 page의 표시 이름을 수정합니다.
Published revision의 page 이름은 이 API로 직접 수정하지 않고, 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 draft snapshot이 published로 복사됩니다.

Request:

```json
{
  "title": "월별 비용"
}
```

Response `200 OK`:

```json
{
  "id": "dashpage_...",
  "title": "월별 비용",
  "orderIndex": 0
}
```

실패:

- dashboard, draft revision, page가 없으면 `404 NOT_FOUND`.
- 빈 제목이면 `400 VALIDATION_ERROR`.

#### 8.5.5 Draft page 삭제

`DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`

동작:

1. 현재 draft revision에 속한 page만 삭제합니다.
2. 해당 page의 widgets는 cascade로 함께 삭제합니다.
3. 마지막 page를 삭제했다면 빈 draft가 되지 않도록 기본 page를 하나 만듭니다.

Response `200 OK`:

```json
{
  "ok": true,
  "replacementPage": null
}
```

마지막 page를 삭제한 경우 `replacementPage`에는 새 기본 page의 `id`, `title`, `orderIndex`가 들어갑니다. 그 외에는 `null`입니다.

실패:

- dashboard, draft revision, page가 없으면 `404 NOT_FOUND`.

#### 8.5.6 Draft widget 추가

`POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`

Request:

```json
{
  "datasetId": "gold_logistics_cost_overview",
  "type": "bar_chart",
  "title": "월별 물류비",
  "layout": { "x": 0, "y": 0, "w": 6, "h": 5, "minW": 3, "minH": 3 },
  "config": {
    "xKey": "month",
    "yKey": "total_cost",
    "aggregation": "sum",
    "color": { "colors": ["#2563eb"] },
    "description": "월 기준 총 물류비 추이"
  }
}
```

`data`는 optional입니다. Catalog에 존재하는 `datasetId`를 보내면 backend는 browser가 보낸 `data`와 Catalog `sampleRows`를 widget snapshot으로 저장하지 않습니다. SQL result처럼 Catalog payload가 없는 bounded query snapshot만 explicit `data`를 최대 500행까지 저장할 수 있습니다.

Catalog widget runtime 조회는 actor의 dataset `query` permission과 governance lock을 storage 접근 전에 검사합니다. 명시적인 `materializationMode`가 우선이며, mode가 없는 Kafka run은 `delta`, 그 외 run은 `snapshot`입니다. Iceberg widget은 Catalog `icebergSnapshotId`에 `FOR VERSION AS OF`를 적용하고 Catalog 사용자 schema와 Trino `DESCRIBE`의 교집합만 query 대상으로 허용해 `_asklake_*` 내부 marker를 일반 집계/표시에 노출하지 않습니다. revision delta 계산에서만 서버가 검증한 `_asklake_run_id`를 내부 filter로 사용합니다. Trino 요청은 전체 wall-clock timeout을 공유하고 deadline이 지나면 진행 중인 `nextUri`를 취소합니다. 전환 전 CSV/JSON/JSONL/Parquet segment만 DuckDB에서 `UNION ALL BY NAME`으로 읽고, 원격 S3 segment는 allowlist와 runtime 응답 전체의 누적 byte/object 예산을 먼저 통과해야 합니다. DuckDB `httpfs`는 backend image build에서 준비하고 runtime은 `LOAD`만 수행하며, query는 memory/thread/temp/timeout 경계 안에서 실행합니다. metric/chart는 type config 기준 최대 500개 그룹으로 집계하며 table은 정렬 후 최대 500행만 반환합니다. `config.dataMode`는 `server_aggregated` 또는 `server_preview`, `config.sourceConfig`는 편집 가능한 원본 설정입니다. count 집계처럼 renderer용 config가 변환되어도 수정 화면은 `sourceConfig`를 복원해야 합니다.

Response `201 Created`:

```json
{
  "id": "dashwidget_...",
  "widget": {
    "id": "dashwidget_...",
    "pageId": "dashpage_...",
    "type": "bar_chart",
    "title": "월별 물류비",
    "datasetId": "gold_logistics_cost_overview",
    "queryId": null,
    "layout": { "x": 0, "y": 0, "w": 6, "h": 5, "minW": 3, "minH": 3 },
    "config": { "xKey": "month", "yKey": "total_cost", "aggregation": "sum" },
    "data": []
  }
}
```

서버는 `type`을 runtime widget enum으로 정규화하고, layout이 없으면 widget type별 기본 layout을 적용합니다.
`widget`은 저장 직후의 전체 `DashboardRuntimeWidget`입니다. Frontend는 이 값만 현재 page에 합치며 전체 draft runtime을 다시 요청하지 않습니다.
기존 기본 위젯 추가 흐름을 위해 `datasetId`와 `config`는 optional이지만, 데이터셋 기반 위젯 생성 UI와 API는 `type`별 config 계약을 사용합니다. 색상 계약은 문자열이나 팔레트 이름이 아니라 `color: { colors: string[] }` 객체입니다. `metric`과 `table`은 색상 설정을 보내지 않습니다. 단일 색상 차트는 `colors`에 1개 색상을 보내고, 도넛/파이/트리맵처럼 여러 요소 색상이 필요한 차트는 요소 순서대로 여러 색상을 보냅니다. `metric`은 `valueKey`, `aggregation`, optional `format`; `table`은 `columns`, optional `limit`, optional `sortKey`, optional `sortDirection`; `bar_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `groupKey`, optional `orientation`; `line_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `dateUnit`, optional `seriesKey`, optional `curve`; `area_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `dateUnit`, optional `seriesKey`, optional `stacked`; `donut_chart`와 `pie_chart`는 `labelKey`, `valueKey`, `aggregation`, `color`; `radial_bar_chart`는 `valueKey`, `aggregation`, `color`, optional `labelKey`, optional `min`, optional `max`, optional `format`; `heatmap_chart`는 `xKey`, `yKey`, `valueKey`, `aggregation`, `color`; `treemap_chart`는 `labelKey`, `valueKey`, `aggregation`, `color`를 보냅니다. 향후 AI widget 생성 기능은 이 type/config 계약을 그대로 재사용합니다.
생성 후 draft runtime 조회 응답의 widget에는 `datasetId`, runtime `config`, bounded `data`가 유지되어야 합니다. dataset query 권한 또는 governance가 거부되면 storage를 열지 않고 해당 widget에 `error: "DASHBOARD_DATA_FORBIDDEN"`, `errorMessage`, `data: []`를 반환합니다. Catalog dataset이 삭제되었거나 물리 위치/읽기/설정 오류가 있으면 `error: "DASHBOARD_DATA_UNAVAILABLE"`, `errorMessage`, `data: []`를 반환합니다. 단, `queryId`가 있는 bounded SQL snapshot은 Catalog payload가 없어도 최대 500행을 유지합니다. 어느 경우에도 다른 widget까지 포함한 전체 runtime 응답 shape는 유지합니다.

#### 8.5.7 Draft widget 수정

`PATCH /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`

Request:

```json
{
  "datasetId": "gold_logistics_cost_overview",
  "type": "line_chart",
  "title": "월별 물류비 추이",
  "config": {
    "xKey": "month",
    "yKey": "total_cost",
    "aggregation": "sum",
    "dateUnit": "month",
    "color": { "colors": ["#2563eb"] },
    "description": "월 기준 총 물류비 추이"
  }
}
```

동작:

1. 현재 draft revision에 속한 widget만 수정합니다.
2. `type`, `title`, `datasetId`, `config`를 갱신합니다.
3. published revision의 widget은 직접 수정하지 않습니다.
4. 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 수정된 draft snapshot이 published로 복사됩니다.

Response `200 OK`:

```json
{
  "id": "dashwidget_...",
  "widget": {
    "id": "dashwidget_...",
    "pageId": "dashpage_...",
    "type": "line_chart",
    "title": "월별 물류비 추이",
    "datasetId": "gold_logistics_cost_overview",
    "queryId": null,
    "layout": { "x": 0, "y": 0, "w": 6, "h": 5, "minW": 3, "minH": 3 },
    "config": { "xKey": "month", "yKey": "total_cost", "aggregation": "sum" },
    "data": []
  }
}
```

`widget`은 수정된 한 widget의 최신 runtime 표현이며, 다른 page/widget을 포함하지 않습니다.

실패:

- dashboard, draft revision, widget이 없거나 현재 draft revision에 속하지 않으면 `404 NOT_FOUND`.

#### 8.5.8 Draft widget 삭제

`DELETE /api/dashboards/{dashboardId}/draft/widgets/{widgetId}`

동작:

1. 현재 draft revision에 속한 widget만 삭제합니다.
2. published revision의 widget은 직접 삭제하지 않습니다.
3. 이후 `POST /api/dashboards/{dashboardId}/publish` 시점에 삭제된 draft snapshot이 published로 복사됩니다.

Response `200 OK`:

```json
{ "ok": true, "deletedWidgetId": "dashwidget_..." }
```

실패:

- dashboard, draft revision, widget이 없거나 현재 draft revision에 속하지 않으면 `404 NOT_FOUND`.

#### 8.5.9 Draft layout batch 저장

`PATCH /api/dashboards/{dashboardId}/draft/layouts`

Request:

```json
{
  "pageId": "dashpage_...",
  "layouts": [
    { "widgetId": "dashwidget_...", "x": 0, "y": 0, "w": 6, "h": 4, "minW": 2, "minH": 2 }
  ]
}
```

Response `200 OK`:

```json
{ "ok": true }
```

서버는 `x`, `y`, `w`, `h`, `minW`, `minH`를 유한 숫자로 정규화하고, 음수 좌표나 1보다 작은 크기를 보정합니다.

#### 8.5.10 Publish

`POST /api/dashboards/{dashboardId}/publish`

동작:

1. 현재 draft revision을 깊은 복사합니다.
2. 새 revision을 `kind = "published"`로 저장합니다.
3. dashboard card payload의 `publishedRevisionId`, `hasPublishedRevision`, `status`, `updated`, `updatedAtValue`와 `dashboards.updated_at`를 갱신합니다.

Draft editor에서 page를 추가/삭제하거나 widget layout을 바꾼 뒤 이 endpoint를 호출하면, 그 시점의 draft pages/widgets가 published viewer의 `GET /api/dashboards/{dashboardId}/published` 응답에 반영됩니다.

Response `200 OK`:

```json
{
  "dashboardId": "dash_...",
  "publishedRevisionId": "dashrev_published_...",
  "publishedAt": "2026-07-04T12:00:00.000Z"
}
```

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- draft revision이 없으면 `422 NO_DRAFT_REVISION`.
- dashboard `manage` 권한이 없으면 `403 FORBIDDEN`.

### 8.5.11 Kafka Continuous widget freshness·result 조회

이 계약은 기존 Kafka Continuous → Spark micro-batch → S3/MinIO Iceberg(물리 data file은 Parquet) → Catalog 경로 뒤에 대시보드 revision/result만 연결합니다. 원본 event를 PostgreSQL에 복사하거나 새 Consumer를 만들지 않습니다.

#### Revision commit 규칙

Backend는 Spark worker가 Iceberg commit 뒤 게시한 immutable manifest를 기준으로 처리합니다. `manifestPath`의 실제 `_SUCCESS`, 유효한 Kafka `[startOffset, endOffset)` `sourceRanges`, 일치하는 `sourceBoundary`, exact Iceberg snapshot/table과 batch/run identity가 모두 있어야 합니다. Backend가 그 snapshot을 Trino로 검증한 뒤 Catalog와 revision을 한 PostgreSQL transaction으로 저장합니다.

1. `dataset_revision_commits`에 `(dataset_id, revision)` commit 추가
2. 같은 commit에 `run_id`, S3·manifest 위치, 행 수, `commit_kind`, canonical Kafka `source_ranges`와 SHA-256 `source_fingerprint` 저장
3. `dataset_freshness.latest_revision`, `latest_run_id`, `updated_at` 갱신

`run_id`는 unique이며 같은 `run_id`가 다른 게시 근거로 재사용되면 오류입니다. 이미 Catalog와 revision에 있는 stream run도 현재 worker report의 Iceberg commit·manifest·offset을 다시 비교한 뒤 ACK합니다. manifest가 비어 있던 upgrade commit은 검증된 현재 manifest를 한 번만 보강합니다. `(dataset_id, commit_kind, source_fingerprint)`도 unique이므로 같은 stream offset을 다른 `run_id`로 다시 reconcile해도 revision은 한 번만 증가합니다. `dataset_kafka_partition_cursors`의 topic·partition별 `next_offset`보다 과거이거나 일부 겹치는 새 stream 범위는 거절하므로 검사 시간은 전체 commit 개수에 비례하지 않습니다. 기존 `legacy` stream/backfill 범위는 current worker report의 manifest `_SUCCESS`, exact Iceberg commit과 source range를 다시 확인하고 version marker가 없는 첫 시작에서만 cursor로 옮깁니다. 저장된 행이 0개인 batch는 revision을 만들지 않지만 committed manifest를 확인한 뒤 consumed offset watermark는 전진시킵니다. absent Catalog row의 동시 첫 publication은 PostgreSQL dataset advisory transaction lock으로 직렬화하며 잠금 순서는 Catalog 다음 freshness입니다. quarantine replay는 한 번에 최대 1,000행을 처리해 자체 manifest/source range를 만들고 `commit_kind=replay` 별도 namespace에서 멱등 처리합니다. manifest 도입 전 replay는 Catalog에 성공 run으로 등록된 ID만 maintenance migration 입력으로 신뢰합니다. replay worker result file과 DB pending result는 Catalog보다 먼저 복구 경계로 저장합니다. replay Iceberg 저장 뒤 Catalog만 실패하거나 backend가 종료되어도 terminal runtime을 포함한 background refresh가 같은 결과를 재조정하고, Catalog 성공 후에만 stored/replayed 카운터를 한 번 더합니다. 로컬 result file이 없어도 backend는 `run_id`의 S3 replay `_SUCCESS`와 payload를 직접 읽어 publication ID/type, data path, source range/boundary, Iceberg boundary를 모두 확인한 뒤 복구합니다. 명시적인 object 404만 missing으로 처리하고 S3 접근·파싱·identity 오류는 fail-closed 합니다. `startContinuous`/`resumeContinuous`는 pending replay를 먼저 재조정하며 아직 Catalog/카운터 반영이 끝나지 않았으면 `409`를 반환합니다.

이미 Catalog에 존재하던 legacy run을 처음 revision으로 backfill할 때는 `materialization_mode=snapshot`으로 기록합니다. revision 0의 전체 계산이 그 run을 이미 포함했더라도 다음 계산은 full rebaseline을 수행하므로 중복 합산하지 않습니다.

`source_ranges` JSONB 예:

```json
[
  {
    "topic": "reviews.raw",
    "partition": 0,
    "startOffset": 120,
    "endOffset": 145
  }
]
```

#### GET /api/datasets/{datasetId}/freshness

Response `200 OK`:

```json
{
  "datasetId": "clickstream_events",
  "isContinuous": true,
  "latestRevision": 105,
  "updatedAt": "2026-07-14T12:00:05+00:00",
  "nextCheckAfterMs": 1000
}
```

- Dataset이 없으면 `404 NOT_FOUND`입니다.
- Dataset `query` 권한이 없거나 governance가 차단하면 `403 FORBIDDEN`입니다.
- Continuous Job이 아니면 `isContinuous=false`입니다.

#### POST /api/datasets/freshness/query

Request:

```json
{
  "datasetIds": ["clickstream_events", "commerce_orders"]
}
```

`datasetIds`는 `1..100`개이며 서버는 입력 순서를 유지하면서 중복 ID를 한 번만 처리합니다.

Response `200 OK`:

```json
{
  "datasets": [
    {
      "datasetId": "clickstream_events",
      "isContinuous": true,
      "latestRevision": 105,
      "updatedAt": "2026-07-14T12:00:05+00:00",
      "nextCheckAfterMs": 1000
    }
  ]
}
```

`nextCheckAfterMs`는 `clamp(triggerIntervalSeconds × 500, 1,000, 60,000)`입니다. 1~2초 trigger는 1초, 10초 trigger는 5초, 30초 trigger는 15초, 5분 trigger는 60초를 반환합니다. Frontend는 동시에 몰리는 요청을 줄이기 위해 dataset ID로 정한 0~10% deterministic jitter를 더합니다.

묶음 조회는 각 dataset의 권한과 metadata를 독립적으로 검사합니다. 한 dataset이 `403`, `404`, `503` 조건이면 해당 항목만 응답에서 제외하고 나머지 정상 dataset을 반환합니다. 단건 GET의 오류 계약은 바뀌지 않습니다.

#### POST /api/dashboards/{dashboardId}/widgets/query

Request:

```json
{
  "mode": "published",
  "widgetIds": ["dashwidget_click_count"]
}
```

`mode`는 `published`가 기본값이며 `draft`도 지원합니다. `widgetIds`는 `1..100`개이고 해당 mode의 현재 revision에 속한 widget만 요청할 수 있습니다. 없는 widget ID가 포함되면 `404 NOT_FOUND`입니다. Published는 Dashboard `view`, draft는 Dashboard `manage` 권한이 필요하며 연결된 Dataset `query` 권한을 물리 storage 접근 전에 다시 검사합니다.

Response `200 OK`:

```json
{
  "widgets": [
    {
      "id": "dashwidget_click_count",
      "pageId": "dashpage_main",
      "type": "metric",
      "title": "실시간 클릭 수",
      "datasetId": "clickstream_events",
      "liveRefresh": true,
      "appliedRevision": 105,
      "calculationVersion": "64-character-sha256",
      "calculatedAt": "2026-07-14T12:00:07+00:00",
      "dataStatus": "ready",
      "dataError": null,
      "layout": { "x": 0, "y": 0, "w": 3, "h": 2 },
      "config": {
        "aggregation": "sum",
        "valueKey": "__asklake_widget_value",
        "dataMode": "server_aggregated",
        "sourceConfig": { "aggregation": "count", "valueKey": "event_id" }
      },
      "data": [{ "__asklake_widget_value": 12540 }]
    }
  ]
}
```

일반 batch/snapshot widget의 성공 결과는 PostgreSQL `dashboard_batch_widget_results`에서 재사용합니다. Cache key는 `datasetId`, `icebergSnapshotId`/성공 run·물리 위치를 포함한 Dataset version hash, widget type, 편집 `sourceConfig` hash, 계산 계약 version, actor의 user/role/group scope hash로 구성합니다. Cache를 읽기 전에 현재 요청 actor의 Dataset `query` 권한과 governance를 항상 다시 확인합니다. Dataset version, widget config, actor scope 중 하나라도 달라지면 cache miss이며 새로 계산합니다. 계산 실패와 권한 오류는 cache에 저장하지 않습니다. 7일보다 오래된 batch cache row는 새 결과 저장 시 정리합니다.

Continuous widget은 이 batch cache를 거치지 않습니다. 기존 `dashboard_widget_results`, `appliedRevision`, `calculationVersion` 계약이 유일한 결과 재사용 경계입니다.

#### 계산 버전과 재계산

`calculationVersion`은 다음 canonical JSON의 SHA-256입니다.

```json
{
  "contractVersion": 2,
  "datasetId": "clickstream_events",
  "widgetType": "metric",
  "sourceConfig": { "aggregation": "count", "valueKey": "event_id" },
  "schemaIdentity": "catalog-schema-fingerprint-or-full-schema"
}
```

- 같은 calculation version의 `appliedRevision >= latestRevision`이면 PostgreSQL의 저장 결과를 반환하고 S3를 다시 읽지 않습니다.
- 저장 결과가 없는 새 widget은 Catalog의 `icebergSnapshotId`에 고정한 전체 데이터로 최초 `calculation_state`를 만듭니다.
- 이후 전체 누적 기준 `count`/`sum`/`avg`는 revision 한 개씩 `_asklake_run_id = commit.run_id`인 행만 Trino 집계해 `calculation_state`에 합치고, 실제로 처리한 revision까지만 같은 transaction으로 저장합니다. row가 존재하는 commit의 delta 집계가 비어 있으면 revision만 전진시키지 않고 같은 Catalog snapshot 전체 재계산으로 fallback합니다. 다음 요청은 그 다음 revision부터 이어갑니다.
- backfill/legacy/non-delta revision, `min`/`max`, table, revision gap, 내부 run ID가 없는 과거 table, 10,000개 초과 group은 Catalog snapshot 전체를 재계산합니다. snapshot commit의 누적 table을 단일 delta처럼 state에 더하거나 기존 state를 부분 결과로 reset하지 않습니다.
- Iceberg full 계산은 Trino query timeout 경계를 적용합니다. 매우 큰 최초 baseline은 후속 aggregate snapshot/bootstrap이 필요합니다. 전환 전 file-backed full 계산은 기본 256 objects, 512 MiB, 15초 원격 scan 경계를 적용하며, 미게시 batch를 포함할 수 있는 raw `_batches` wildcard로 우회하지 않습니다.
- 최근 N분·슬라이딩 시간창과 만료 행 차감은 이 계산 계약에 포함하지 않습니다.
- 결과와 `applied_revision`은 한 transaction으로 저장합니다.
- 계산 시작 시 Catalog row를 먼저, freshness row를 다음으로 잠급니다. ETL commit과 같은 순서이고 full query를 Catalog Iceberg snapshot에 고정하므로 물리 데이터와 revision이 서로 다른 시점으로 섞이지 않습니다.
- 계산이 실패하면 이전 `result_payload`/`applied_revision`을 유지합니다. 새 calculation version 계산이 실패한 경우에도 같은 widget·같은 dataset의 직전 성공 버전만 표시 fallback으로 사용합니다. 다른 dataset의 과거 결과는 반환하지 않습니다.
- 집계 응답은 최대 500 group입니다. table의 backend 안전 상한은 500행이며 현재 frontend 위젯 설정은 기본 10행, 최대 100행입니다.
- 새 calculation version 결과 저장이 성공하면 같은 widget의 이전 calculation version 결과는 삭제하고 현재 버전 한 건만 유지합니다.

Frontend는 published `/dashboards/{dashboardId}`에서 Continuous dataset만 polling합니다. 같은 dataset의 freshness는 한 번만 조회하고 `latestRevision > appliedRevision`인 widget만 재요청합니다. 응답 revision이 실제로 전진했지만 아직 최신보다 뒤면 250ms 뒤 다음 revision을 이어서 요청하고, 전진하지 않았으면 빠른 재시도를 멈추고 backend 권장 주기로 돌아갑니다. 일반 주기에는 dataset ID 기반 0~10% deterministic jitter를 더하며, hidden tab에서는 중지하고 route unmount 시 timer/request를 정리하며, 실패 시 기존 widget을 그대로 보여줍니다.

실제 event-to-screen 지연은 `다음 Spark trigger까지 남은 시간 + Spark/S3 + backend reconciliation 0~1초 + polling 0~nextCheckAfterMs(+ jitter) + widget 계산`입니다. 2~5초를 항상 보장하지 않습니다.

상세 운영·검증·제한은 `docs/kafka-postgresql-dashboard-sync.md`를 따릅니다.

### 8.5.12 Dashboard Assistant UI Hook

대시보드 draft editor의 AskLake 보조 패널과 `placeholderKind: "visualization_request"` 위젯은 `POST /api/dashboards/assistant` FastAPI endpoint를 통해 private AI Gateway 응답을 요청한다.
이 endpoint는 `get_actor_context`로 인증된 actor만 허용한다. 요청에 `dashboardId`가 있으면 Assistant context 또는 Gateway 호출 전에 해당 dashboard의 `view` 권한을 검사하며, 운영 환경의 익명 요청은 `401 UNAUTHORIZED`, dashboard 접근 권한이 없는 요청은 `403 FORBIDDEN`이다.
Provider key는 `ai-server`에만 주입하고 FastAPI는 Gateway service token과 request-scoped MCP context token만 사용한다.
서버는 `dashboardId`/`pageId`를 기준으로 DB에서 draft revision을 우선 조회하고, 없으면 published revision을 조회한다.
그 다음 actor의 dataset `query` permission과 governance를 통과한 available catalog dataset, 그 dataset에 연결된 현재 page widget, 지원 가능한 widget type/config option만 Gateway 컨텍스트로 전달한다. 제외된 dataset의 `sampleRows`와 연결 widget의 `dataSample`은 provider request에 포함하지 않는다.
단, `selectedWidgetId` 또는 `widgetId`가 있으면 해당 위젯 하나만 context/수정 후보로 제한한다.
Gateway 응답은 backend guard를 통과해야 하며, 없는 datasetId, 없는 widgetId, 없는 column, 지원하지 않는 widget type/config field는 action에서 제외하고 `warnings`에 이유를 담는다.
채팅형 패널은 후속 실행 표현이 최근 사용자 발화의 Dataset/field/column 단서를 참조할 때만 최근 사용자 발화 최대 2건을 현재 `prompt`에 구분해 결합한다. assistant 메시지와 장기 대화 기록은 전송하지 않는다. 단서 없는 모호한 입력은 local input guard가 action 없이 구체화를 요청한다. Gateway의 502 provider contract 오류는 mode별 strict action 지침으로 한 번만 교정 재시도하고, 재실패 시 기존 fail-closed 응답을 유지한다.
SQL Query AI와 Dashboard Assistant는 요청별 RAG source `documentId` allowlist를 provider schema에 적용한다. Source가 없으면 `usedEvidenceIds`는 빈 배열만 허용하며, provider가 범위 밖 ID를 반환하면 해당 citation만 제거하고 경고를 추가한다. Dashboard 최상위 목록은 검증된 action별 evidence의 합집합으로 다시 계산한다. 이 정규화는 SQL read-only/scope 또는 widget action의 dataset, column, type, config 검증을 완화하지 않는다.
Private AI Gateway 설정이 없거나 provider 호출이 실패하면 명시적인 unavailable/error 응답과 빈 action을 반환한다.
프론트는 `VITE_DASHBOARD_ASSISTANT_API_PATH`가 미설정이거나 빈 Docker build arg이면 기본 경로 `/api/dashboards/assistant`로 `POST` 요청을 보낸다.
값을 지정하면 해당 경로로 요청하며, `/api/...` 상대 경로 또는 `https://...` 절대 URL을 모두 허용한다.

Request:

```ts
type DashboardAssistantRequest = {
  dashboardId?: string;
  mode: "dashboard_question" | "visualization_request";
  pageId?: string | null;
  prompt: string;
  selectedWidgetId?: string | null;
  widgetId?: string | null;
  semanticModelId?: string | null;
  currentDatasetId?: string | null;
  surface?: "dashboard" | "catalog" | "semantic";
  widgets: Array<{
    id: string;
    title: string;
    type: DashboardRuntimeWidgetType;
    datasetId: string | null;
    layout: DashboardWidgetLayout;
    config: Record<string, unknown>;
    dataSample: Array<Record<string, unknown>>;
  }>;
};
```

`mode: "dashboard_question"`은 오른쪽 AskLake 보조 패널에서 사용한다.
`mode: "visualization_request"`는 시각화 요청 위젯 내부 입력창에서 사용한다.
`widgets`는 현재 등록된 위젯의 title/type/datasetId/config/layout 및 최대 5개 샘플 row를 포함한다. Backend DB context를 구성할 때는 actor가 query할 수 있는 dataset에 연결된 widget만 provider에 전달한다.
단, `dashboardId`가 있으면 backend DB runtime 컨텍스트가 우선이며 `widgets`는 구버전/테스트 호환 fallback payload로 사용한다.
`selectedWidgetId` 또는 `widgetId`가 있으면 서버는 해당 위젯만 `update_widget` 대상에 포함한다.

Response:

```ts
type DashboardAssistantResponse = {
  message: string;
  requestId?: string | null;
  actions: Array<
    | {
        type: "create_widget";
        widget: {
          title: string;
          type: DashboardRuntimeWidgetType;
          datasetId: string;
          config: DashboardRuntimeWidgetConfig;
        };
        usedEvidenceIds: string[];
      }
    | {
        type: "update_widget";
        widgetId: string;
        patch: {
          title?: string | null;
          type?: DashboardRuntimeWidgetType;
          datasetId?: string | null;
          config?: Record<string, unknown>;
        };
        usedEvidenceIds: string[];
      }
    | {
        type: "report";
        markdown: string;
        usedEvidenceIds: string[];
      }
  >;
  warnings: string[];
  model?: string | null;
  provider?: string | null;
  sources: Array<Record<string, unknown>>;
  retrieval?: Record<string, unknown> | null;
  usedEvidenceIds: string[];
  // 현재 visualization request 위젯 호환용 임시 필드.
  configPatch?: Record<string, unknown>;
  widgetPatch?: {
    title?: string | null;
    type?: DashboardRuntimeWidgetType;
    datasetId?: string | null;
    config?: Record<string, unknown>;
  };
};
```

현재 프론트 적용 범위:

- `message`는 사용자에게 요청 결과 안내로 표시한다.
- `actions.type: "report"`는 AskLake 보조 패널의 분석/리포트 응답에 사용한다.
- `actions.type: "create_widget"`와 `actions.type: "update_widget"`는 시각화 요청 위젯에서 실제 위젯 생성/수정 적용 흐름에 사용한다.
- `currentDatasetId`는 현재 선택 Dataset context를 고정하며 명시적인 생성/수정 의도만 mutation action으로 보낸다.
- create/update persistence callback이 `true`를 반환한 경우에만 적용 성공으로 표시한다. 실패 또는 `false`이면 기존 draft와 편집 입력을 유지하고 오류를 표시한다.
- `configPatch` 또는 `widgetPatch.config`는 현재 시각화 요청 위젯의 기존 config에 병합한다.
- `widgetPatch.title`, `widgetPatch.type`, `widgetPatch.datasetId`는 시각화 요청 위젯을 실제 차트로 변환할 때 자동 적용한다.
- provider/model과 실제 사용 근거 ID가 없는 응답은 AI 생성 성공으로 취급하지 않는다.

Assistant guard는 Gateway 응답을 그대로 신뢰하지 않고 catalog schema/sample rows 기준으로 검증한다. 없는 컬럼은 alias로 보정하고, 차원 컬럼만 제시된 막대/선/면 차트 요청은 `count` 집계로 보정한다. 각 action의 `usedEvidenceIds`는 검색 후보의 부분집합이어야 하고 공개 `sources`는 실제 사용 ID와 정확히 일치해야 한다. 적용 가능한 action, provider/model provenance 또는 검증된 evidence가 없으면 기본 차트나 성공 결과를 합성하지 않는다.

### 8.5.13 Review Analysis Gateway와 model publication

공개 endpoint:

| Method | Endpoint | Contract |
| --- | --- | --- |
| `POST` | `/api/review-analysis/schema-suggestion` | 최대 40개 source column과 3개 sample row를 `review_schema` mode로 분석 |
| `POST` | `/api/review-analysis/preview` | 최대 10개 row/64개 output column을 `review_row` mode로 분석 |
| `POST` | `/api/review-analysis/runs` | persisted run을 `202 queued`로 생성 |
| `GET` | `/api/review-analysis/runs/latest` | 현재 actor의 최신 run 조회 |
| `GET` | `/api/review-analysis/runs/{runId}` | 소유 actor 또는 admin의 지정 run 조회 |
| `GET` | `/api/catalog/models` | published manifest와 digest를 재검증한 portable artifact 조회 |

```ts
type ReviewAnalysisRunRequest = {
  limit?: number; // default 25
  schemaColumns?: Array<Record<string, unknown>>;
  full?: false;
  runtime?: "gateway";
  source?: { bucket: string; key: string };
  trainModels?: boolean;
};

type ReviewAnalysisRunResponse = {
  runId: string;
  status: "queued" | "running" | "success" | "failed";
  source: { bucket: string; key: string };
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};
```

Run state는 `review_analysis_runs`에 저장한다. Background Task와 `REVIEW_ANALYSIS_WORKER_INTERVAL_SECONDS` 주기의 recovery tick은 같은 atomic claim으로 allow-list versioned Node bridge를 호출하므로 재시작 뒤 남은 `queued` run도 재개되고, stale `running` lease는 실패로 종결된다. 일반 actor는 설정된 review source만 사용할 수 있고 다른 `source.bucket`/`source.key`는 `403`이며, admin만 운영 목적으로 명시 source를 선택할 수 있다. `full=true`, `limit=0`, `ASKLAKE_REVIEW_AI_MAX_ROWS` 초과 요청은 `422`로 거부한다. Preview와 Run의 `one_of_values` 결과는 요청 `allowedValues` 밖의 값을 허용하지 않고 provider/model이 없는 row도 실패한다. `/api/review-analysis/cellphones`와 `/api/review-analysis/cellphones/run`은 deprecated compatibility alias이며, 기존 POST alias는 `200 OK` 응답 계약을 유지한다. 신규 frontend 호출에는 이 alias를 사용하지 않는다.

`trainModels=true`인 run은 AI Gateway label provenance를 포함한 분류형 row만 학습에 사용한다. 최소 8개 row, class별 최소 row, holdout accuracy·macro-F1 기준, 모든 allowed class validation coverage를 통과해야 한다. 성공 artifact는 SHA-256 digest와 source/provider model provenance를 포함한 manifest와 함께 latest registry에 atomic replace하며, 일부 target이라도 gate를 실패하면 새 manifest를 게시하지 않는다.

## 9. P2 API

### 9.1 인증 세션

`POST /api/auth/login`

아래 demo request는 local mode 또는 위 legacy demo opt-in이 활성화된 배포에서만 사용할 수 있습니다. 기본 production에서는 `BOOTSTRAP_ADMIN_EMAIL`로 생성된 관리자 계정을 사용합니다.

Request:

```json
{
  "email": "admin.user@asklake.local",
  "password": "asklake-admin"
}
```

Response `200 OK`:

- `Set-Cookie: asklake_session=...; HttpOnly; Max-Age=604800; Path=/; SameSite=lax`
- body는 `{ "user": CurrentUserResponse }`

`POST /api/auth/signup`

Request:

```json
{
  "displayName": "Kim Analyst",
  "email": "kim.analyst@example.com",
  "password": "minimum8"
}
```

Response `201 Created`:

- 새 viewer 계정을 만들고 로그인과 동일하게 `asklake_session` 쿠키를 발급합니다.
- body는 `{ "user": CurrentUserResponse }`

`GET /api/auth/session`

Response:

```json
{
  "authenticated": true,
  "user": {
    "id": "admin-user",
    "displayName": "Admin User",
    "email": "admin.user@asklake.local",
    "role": "admin",
    "groups": [],
    "profile": {
      "displayName": "Admin User",
      "avatarInitials": "AU",
      "email": "admin.user@asklake.local"
    },
    "permissionsSummary": {
      "canView": 0,
      "canQuery": 0,
      "canRun": 0,
      "canManage": 0,
      "canDelete": 0,
      "canShare": 0
    }
  }
}
```

세션 쿠키가 없거나 만료되면 `{ "authenticated": false, "user": null }`을 반환합니다.

`POST /api/auth/logout`

Response `200 OK`:

```json
{
  "ok": true
}
```

서버 session row를 삭제하고 `asklake_session` 쿠키를 제거합니다.

현재 session token은 서버 DB에 저장된 opaque token이며 bearer/JWT가 아닙니다. 비밀번호는 plaintext로 저장하지 않고 salt + PBKDF2 hash로 저장합니다. 이 구현은 로컬 데모 세션 범위이며 운영 인증 전 단계입니다.

### 9.2 현재 사용자 프로필 조회

`GET /api/users/me`

Actor 결정 순서:

1. `asklake_session` 쿠키가 유효하면 session user를 actor로 사용합니다.
2. 세션이 없으면 아래 임시 actor header를 사용합니다.

| Header | 기본값 | 설명 |
| --- | --- | --- |
| `X-AskLake-User` | `Admin User` | 현재 actor 표시 이름 |
| `X-AskLake-Role` | `admin` | 현재 actor role |
| `X-AskLake-Groups` | 빈 값 | comma-separated group id/name 목록 |

Response `200 OK`:

```json
{
  "id": "admin-user",
  "displayName": "Admin User",
  "email": "admin.user@asklake.local",
  "role": "admin",
  "groups": [
    {
      "id": "data-platform",
      "name": "Data Platform Team",
      "description": "Lake platform administrators"
    }
  ],
  "profile": {
    "displayName": "Admin User",
    "avatarInitials": "AU",
    "email": "admin.user@asklake.local",
    "title": "Platform Admin"
  },
  "permissionsSummary": {
    "canView": 12,
    "canQuery": 8,
    "canRun": 5,
    "canManage": 7,
    "canDelete": 4,
    "canShare": 6
  }
}
```

프로필 API는 session actor 또는 header actor를 demo identity로 정규화해 반환합니다. 사용자를 찾을 수 없으면 actor 값에서 deterministic fallback profile을 생성할 수 있습니다.

### 9.3 관리자 사용자 목록 조회

`GET /api/admin/users`

권한:

- `X-AskLake-Role=admin` 필요.
- admin이 아니면 `403 FORBIDDEN`.

Response `200 OK`:

```json
{
  "users": [
    {
      "id": "admin-user",
      "displayName": "Admin User",
      "email": "admin.user@asklake.local",
      "role": "admin",
      "status": "active",
      "lastActiveAt": "2026-07-09T06:30:00.000Z",
      "groups": [
        {
          "id": "data-platform",
          "name": "Data Platform Team"
        }
      ],
      "profile": {
        "displayName": "Admin User",
        "avatarInitials": "AU",
        "email": "admin.user@asklake.local"
      },
      "permissionsSummary": {
        "canView": 12,
        "canQuery": 8,
        "canRun": 5,
        "canManage": 7,
        "canDelete": 4,
        "canShare": 6
      }
    }
  ]
}
```

### 9.3 관리자 그룹 목록 조회

`GET /api/admin/groups`

권한:

- `X-AskLake-Role=admin` 필요.
- admin이 아니면 `403 FORBIDDEN`.

Response `200 OK`:

```json
{
  "groups": [
    {
      "id": "data-platform",
      "name": "Data Platform Team",
      "description": "Lake platform administrators",
      "memberCount": 2
    }
  ]
}
```

### 9.4 관리자 권한 요약 조회

`GET /api/admin/permissions`

권한:

- `X-AskLake-Role=admin` 필요.
- admin이 아니면 `403 FORBIDDEN`.

Response `200 OK`:

```json
{
  "resources": [
    {
      "resourceType": "dataset",
      "resourceId": "ds_customer_orders_gold",
      "resourceName": "Customer Orders Gold",
      "owner": "Data Platform Team",
      "createdBy": "Admin User",
      "grants": [
        {
          "id": "grant_abc123",
          "principalType": "group",
          "principalId": "data-platform",
          "actions": ["view", "query", "manage"],
          "source": "owner"
        }
      ],
      "currentActorPermissions": {
        "canView": true,
        "canQuery": true,
        "canRun": true,
        "canManage": true,
        "canDelete": true,
        "canShare": true,
        "computedFor": "Admin User",
        "enforced": true
      }
    }
  ]
}
```

관리 콘솔은 resource별 grant와 현재 actor 권한을 설명하며, admin actor는 별도 편집 endpoint로 `permission_grants` table row를 생성/수정/삭제할 수 있습니다.

Backend 저장 기준:

- 기존 Job/Dataset/Dashboard payload의 `permissionGrants`는 호환을 위해 계속 읽습니다.
- 새 `permission_grants` table은 `resource_type`, `resource_id`, `principal_type`, `principal_id`, `actions`, `source`, `created_by`를 저장합니다.
- `GET /api/admin/permissions`는 payload grant와 table grant를 합산해 반환합니다.
- 로컬 demo seed는 table이 비어 있을 때 대표 dataset/job/dashboard에 `source="admin_seed"` grant를 생성할 수 있습니다.

`POST /api/admin/permissions`

권한:

- admin role 필요.
- admin이 아니면 `403 FORBIDDEN`.

Request:

```json
{
  "resourceType": "dataset",
  "resourceId": "ds_customer_orders_gold",
  "principalType": "group",
  "principalId": "analytics",
  "actions": ["view", "query"]
}
```

Response `201 Created`:

- 수정 후 `GET /api/admin/permissions`와 같은 `AdminPermissionsResponse`를 반환합니다.
- 없는 resource면 `404 NOT_FOUND`.
- action이 비어 있거나 지원하지 않는 값이면 `400 VALIDATION_ERROR`.

`PATCH /api/admin/permissions/{grantId}`

Request:

```json
{
  "principalType": "user",
  "principalId": "kim.analyst@asklake.local",
  "actions": ["view"]
}
```

Response `200 OK`:

- 수정 후 `AdminPermissionsResponse`를 반환합니다.
- 없는 grant면 `404 NOT_FOUND`.

`DELETE /api/admin/permissions/{grantId}`

Response `200 OK`:

- 삭제 후 `AdminPermissionsResponse`를 반환합니다.
- 없는 grant면 `404 NOT_FOUND`.

### 9.5 관리자 감사 로그 조회

`GET /api/admin/audit-logs`

권한:

- `X-AskLake-Role=admin` 필요.
- admin이 아니면 `403 FORBIDDEN`.

Query:

- `q?: string`: action, actor, api path, target, metadata text 검색.
- `actorId?: string`: actor id/name 부분 검색.
- `resourceType?: "etl_job" | "dataset" | "dashboard" | "query_run" | "ai_module" | "admin_module" | "ui" | "auth" | "user" | "group" | "unknown"`.
  - `unknown`은 현재 계약에 없는 레거시 저장 타입과 명시적인 `unknown` 행을 함께 조회합니다.
- `result?: "success" | "failed" | "forbidden"`.
- `from?: ISO datetime`.
- `to?: ISO datetime`.
- `limit?: number`: 기본 100, 최대 500.

Response `200 OK`:

```json
{
  "logs": [
    {
      "action": "admin.permission_grant.created",
      "actor_id": "admin-user",
      "actor_name": "Admin User",
      "actor_role": "admin",
      "actor_groups": ["data-platform", "analytics", "ops"],
      "api_path": "/api/admin/permissions",
      "created_at": "2026-07-09T06:30:00.000Z",
      "http_method": "POST",
      "metadata": {
        "grantId": "grant_abc123",
        "principalId": "temporary.editor@asklake.local",
        "principalType": "user",
        "actions": ["view"]
      },
      "request_id": "req_01J1Z8W8EFGH",
      "result": "success",
      "status_code": 201,
      "target_id": "ds_customer_orders_gold",
      "target_name": "Customer Orders Gold",
      "target_type": "dataset"
    }
  ]
}
```

Backend 저장 기준:

- 서버 감사 로그는 `audit_events` table에 저장합니다.
- 현재 기록 범위는 admin permission grant 생성/수정/삭제, governance control 변경, auth login/logout/login 실패, Dataset 상세/SQL query/materialization 삭제 403, Job command/update 403, Dashboard runtime/편집/삭제 403입니다.
- 감사 저장 실패는 주요 사용자 액션을 막지 않고 서버 transaction rollback 후 액션 응답을 유지합니다.
- Topbar의 local audit log는 별도 UI 상태로 유지하며, `/api/admin/audit-logs` 응답과 합치지 않습니다.

### 9.6 관리자 Governance Controls

`GET /api/admin/governance-controls`

- admin이 아니면 `403 FORBIDDEN`.
- 사용자/그룹 차단 상태와 resource lock 상태를 반환합니다.
- 관리 콘솔 UI는 user 차단을 사용자 탭에, group 차단을 그룹 탭에, resource lock을 권한 탭의 선택 resource action에 표시합니다.
- `reason`은 관리자 내부 표시와 감사 로그용입니다. 일반 사용자-facing 오류 메시지에는 차단/잠금 사유를 그대로 노출하지 않습니다.

Response:

```json
{
  "principalControls": [
    {
      "id": "principal_control_...",
      "principalType": "group",
      "principalId": "analytics",
      "status": "blocked",
      "reason": "incident response",
      "updatedBy": "Admin User",
      "updatedAt": "2026-07-10T00:00:00Z"
    }
  ],
  "resourceLocks": [
    {
      "id": "resource_lock_...",
      "resourceType": "dataset",
      "resourceId": "ds_orders_clean",
      "locked": true,
      "reason": "schema freeze",
      "updatedBy": "Admin User",
      "updatedAt": "2026-07-10T00:00:00Z"
    }
  ]
}
```

`PATCH /api/admin/governance/principals`

```json
{
  "principalType": "user",
  "principalId": "demo-user",
  "status": "blocked",
  "reason": "temporary investigation"
}
```

`principalType`은 `user` 또는 `group`, `status`는 `active` 또는 `blocked`입니다. 성공 시 `admin.principal_control.updated` audit event를 저장합니다. 운영자 계정은 UI에서 차단 action을 노출하지 않으며, 일반 사용자에게는 내부 `reason` 대신 중립적인 접근 제한 메시지만 보여줍니다.

`PATCH /api/admin/governance/resource-locks`

```json
{
  "resourceType": "dataset",
  "resourceId": "ds_orders_clean",
  "locked": true,
  "reason": "schema freeze"
}
```

`resourceType`은 `dataset`, `etl_job`, `dashboard`입니다. 성공 시 `admin.resource_lock.updated` audit event를 저장합니다. 잠긴 resource는 `view`를 제외한 `query/run/manage/delete/share` action에서 backend가 `403 FORBIDDEN`을 반환하고 `*.governance_forbidden` audit event를 저장합니다.

### 9.7 Frontend 최근 호출 로그

서버 감사 로그와 별도로 frontend는 사용자 피드백용 최근 호출 로그를 브라우저 안에 저장합니다. 현재 `POST /api/audit-logs` endpoint는 구현하지 않습니다.

현재 프론트 내부 저장 위치:

- `window.__asklakeAuditLogs`
- `window.localStorage["asklake.auditLogs"]`
- Topbar 최근 API 호출 패널

Request:

```ts
type AuditEntry = {
  action: string;
  actor_id: string;
  api_path: string;
  created_at: string;
  request_id: string;
  result: "success" | "failed" | "forbidden";
  target_id: string;
  target_type: "etl_job" | "dataset" | "dashboard" | "query_run" | "ai_module" | "admin_module" | "ui" | "auth" | "user" | "group" | "unknown";
};
```

계약 밖의 레거시 `target_type`은 응답에서 `unknown`으로 투영하고 원래 값은 해당 로그의 `metadata.rawTargetType`에 보존합니다. 신규 감사 이벤트 writer는 `AuditTargetType`의 알려진 enum member만 전달해야 하며 문자열이나 `unknown` 쓰기는 거부합니다. `unknown`은 레거시 읽기 호환 전용이고 신규 오타를 숨기는 저장값으로 사용하지 않습니다.

OpenAPI에서 이 타입이 inline enum 또는 local component `$ref`로 표현될 수 있으므로 하위 호환성 판정은 reference를 resolve한 뒤 primitive type과 enum 값의 의미를 비교합니다. 기존 enum 제거와 type 변경은 breaking이며 값 추가는 additive입니다.

## 10. 백엔드 구현 체크리스트

- P0 API 3개를 먼저 구현합니다.
- CORS에서 `http://localhost:5173`을 허용합니다.
- 모든 response에 `Content-Type: application/json`을 설정합니다.
- 실패 응답은 `error.code`, `error.message`를 반드시 포함합니다.
- SQL 실행은 read-only guard를 반드시 둡니다.
- ETL job command는 상태 전이를 서버에서 검증합니다.
- `request_id`를 서버 로그에 남깁니다.
- 날짜는 ISO 8601 UTC 문자열로 내려줍니다.
- ID는 프론트에서 그대로 저장/표시할 수 있는 문자열로 내려줍니다.

## 11. 프론트 전환 순서

1. 백엔드 서버와 필수 내부 서비스를 실행합니다.
2. `frontend/.env`에 `VITE_API_BASE_URL`을 설정합니다.
3. 실제 Dataset으로 Source/Schema 연결 테스트와 생성 플로우를 확인합니다.
4. 프론트 dev 서버를 재시작합니다.
5. `POST /api/etl/sources/assets`로 연결 검증과 대상 탐색을 확인한 뒤, 선택값을 포함한 `POST /api/etl/sources/test`로 Source/Schema live preview 흐름을 확인합니다.
6. `POST /api/etl/jobs` 생성 플로우를 확인합니다.
7. `POST /api/etl/jobs/{jobId}/commands` 버튼 흐름과 Spark 실행 흐름 갱신을 확인합니다.
8. `POST /api/query/runs` SQL 실행 흐름을 확인합니다.
9. P1 API를 붙인 뒤 남은 정적 초기 데이터를 서버 hydrate로 교체합니다.

## 12. 열린 결정 사항

백엔드 구현 전에 팀에서 결정하면 좋은 항목입니다.

- 인증 방식: 운영 IdP/OAuth/SSO, refresh token, 비밀번호 재설정, 이메일 인증.
- Auth/session table의 Alembic migration.
- 권한 모델: deny policy, 조건부 정책, dataset 생성/삭제 전체 enforcement, group membership 편집 범위.
- 실제 ETL 실행 엔진 운영화: 현재 Airflow + Spark 기준에서 standalone/Kubernetes 배포 방식과 worker autoscaling 정책 결정.
- SQL 실행 엔진: Trino, Spark SQL, DuckDB, warehouse API 중 선택.
- dataset row count/size 표기: 문자열로 내려줄지 숫자와 단위를 분리할지.
- audit log 저장 실패 시 사용자에게 노출할지 여부.
- dashboard widget 저장 모델을 `dashboards`, `dashboard_widgets`로 분리할지 여부.
## ETL Permission create-flow contract

ETL Permission 화면은 더 이상 하드코딩 사용자 목록을 source of truth로 사용하지 않는다. 다만 그룹 후보는 현재 backend의 `DEMO_GROUPS` 고정 정의이며, 사용자 후보만 `auth_users` table을 우선 사용한다.

1. 화면 진입 시 `GET /api/etl/permission-options`로 그룹과 사용자 후보를 조회한다. 새 작업은 `jobId` 없이 호출하고, 기존 작업 수정은 `jobId`를 query로 전달한다.
2. 그룹 또는 사용자를 권한 대상으로 추가한다. 대상 추가만으로는 identity가 결정되고, 실제 action은 프리셋 또는 직접 설정으로 지정한다.
3. `조회 전용`, `실행 가능`, `운영 가능` 프리셋은 선택된 모든 대상에 공통 action 집합을 적용한다. `직접 설정`은 대상별 action을 편집한다.
4. `query`, `run`, `manage`, `delete`, `share` 중 하나를 부여하면 기본 조회가 가능하도록 `view`도 포함해 정규화한다.
5. `모든 사용자에게 조회 허용`을 켜면 `public` principal의 `view` grant를 추가한다. 이는 비로그인 공개가 아니라 로그인한 모든 actor의 조회 허용을 뜻한다.
6. 담당자(owner)는 backend fallback으로 전체 권한을 자동 보유한다. owner grant는 저장하지 않고 최종 확인 화면에서 읽기 전용으로 표시한다.
7. 생성 또는 수정 request의 `permissionGrants`를 `permission_grants` table에 `source=permission_ui`로 저장한다.
8. 동일 resource 수정은 `permission_ui` source만 교체하고 `admin`, `admin_seed` 등 다른 source는 보존한다.
9. 이전 Job의 `permissionRoles`는 최초 접근 시 `legacy_permission_roles` source의 table grant로 한 번만 이관한다.

```ts
type PermissionGrant = {
  actions: Array<"view" | "query" | "run" | "manage" | "delete" | "share">;
  principalId: string;
  principalName?: string;
  principalType: "user" | "group" | "role" | "public";
  source?: string;
};
```

빈 `principalId` 또는 action이 없는 grant는 `400 VALIDATION_ERROR`다. `public` principal은 `principalId`를 `public`으로 정규화한다. `principalName`은 Review 표시용 optional metadata이며 저장 identity와 권한 판정은 `principalType + principalId`만 사용한다. backend는 client가 보낸 `id`와 `source`를 신뢰하지 않고 새 ID와 `permission_ui` source를 부여한다.

새 작업의 권한 옵션 조회는 인증된 actor에게 허용한다. 기존 작업은 admin, 생성자, 담당자(owner), 또는 `manage` grant를 가진 actor만 조회할 수 있고, 그 외 actor는 `403 FORBIDDEN`을 받는다. live frontend는 API 오류 시 권한 화면 안에 재시도 경로를 표시하고 다음 단계 이동을 막는다. `VITE_USE_MOCK_API=true`에서는 동일 response shape의 fixture를 사용하되 최종 Job request shape는 live와 동일하다. Review 응답의 `permission`은 담당자 자동 권한을 첫 항목으로 표시하고, 이어서 실제 저장 예정 grant를 대상별로 나열한다.

현재 그룹 후보는 backend의 `DEMO_GROUPS` 고정 정의이고 사용자 후보는 `auth_users` table을 우선한다. `permissionTemplate`은 과거 request 호환용 요약이며 권한 판정에는 사용하지 않는다.

## Realtime 2026 전환 계약

### GET /api/realtime/config

인증된 frontend가 서버의 effective realtime mode를 읽는 진단 endpoint다. response field는 camelCase다.

| 필드 | 타입 | 계약 |
|---|---|---|
| dashboardSyncMode | polling \| hybrid \| sse | invalid 값 또는 event 비활성 조합은 polling |
| realtimeEventsEnabled | boolean | durable event/SSE kill switch |
| continuousSqlJoinEnabled | boolean | Continuous SQL create/start kill switch |
| clickhouseContinuousJoinEnabled | boolean | Continuous SQL과 ClickHouse flag가 모두 켜졌을 때만 true인 ClickHouse serving opt-in |
| clickhouseRealtimeV2Enabled | boolean | V2 application kill switch의 effective 값. backend intrinsic 기본은 false이고 Production Compose는 true를 주입 |
| kafkaConnectSinkEnabled | boolean | Kafka Connect V2 sink의 effective 값. backend intrinsic 기본은 false이고 Production Compose는 true를 주입 |
| clickhouseRealtimeConsumerOwner | disabled \| kafka_engine_v1 \| kafka_connect_v2 | deployment의 단일 consumer owner 설정. readiness나 실제 claim을 뜻하지 않음 |
| latestStaticPerBatchEnabled | boolean | Continuous SQL이 켜진 경우에만 true |
| staticChangeBackfillEnabled | boolean | Continuous SQL이 켜진 경우에만 true |
| featureScope | deployment | 현재 저장소에는 tenant model이 없으므로 고정 |
| fallbackReason | string or null | invalid_dashboard_sync_mode, realtime_events_disabled |
| heartbeatSeconds | integer | stream heartbeat seconds, 기본 15 |
| reconnectRetryMs | integer | EventSource retry hint, 현재 3000 |
| safetyPollAfterMs | integer | hybrid open 상태의 safety refresh 하한, 현재 60000 |

이 API는 Connect URL, connector name, 설정 원문, credential, secret을 반환하지 않는다. 기능 off 상태는 기존 Dashboard adaptive polling, 정적 SQL, Kafka Continuous ingestion 계약과 동일하다.

### GET /api/realtime/events

인증된 published Dashboard용 SSE change-notification stream이다.

| 입력 | 타입 | 계약 |
|---|---|---|
| `dashboardId` | query string | 필수, Dashboard `view` permission 검사 |
| `datasetIds` | comma-separated query string | 1~100개, 각 Dataset `query` permission/governance 검사 |
| `cursor` | non-negative integer | optional initial snapshot cursor |
| `Last-Event-ID` | header | optional reconnect cursor; query cursor와 함께 있으면 큰 값 사용 |

성공 response content type은 `text/event-stream`이다. domain event는 `dataset.revision.committed`, `dashboard.published`이고 control event는 `stream.ready`, `system.heartbeat`, `system.resync_required`, `system.authorization_changed`다. resource ACL은 연결 전과 heartbeat마다 다시 확인한다. actor별 기본 연결 한도는 5이며 초과는 `429`, 권한 없음은 `403`, 기능 비활성은 `409`, dispatcher 초기화·복구 중에는 `503`이다.

### GET /api/realtime/status

인증된 actor에게 effective mode, `ready`, `eventCursor`, `minAvailableCursor`, process-local connection/replay/overflow/lag metric을 반환한다. raw env나 credential은 반환하지 않는다.

### GET /api/health/realtime

기능이 꺼져 있으면 `200 disabled`, 켜져 있으면 DB와 dispatcher readiness를 기준으로 `200 ready` 또는 `503 unavailable`을 반환한다. 무한 stream을 healthcheck로 사용하지 않는다.

PR02는 기존 top-level health에 다음 secret-free object를 항상 추가한다.

```json
{
  "v2": {
    "enabled": false,
    "ready": false,
    "status": "disabled",
    "consumerOwner": "disabled",
    "connector": {"enabled": false, "configured": false}
  }
}
```

`v2.status`는 `disabled | configuration_validated`다. PR02의 `v2.ready`는 항상 false이며 V2가 enabled이면 endpoint 자체도 HTTP `503`으로 fail closed한다. realtime event backbone이 disabled면 top-level `status=not_ready`, enabled면 `status=unavailable`이다. `connector.configured`는 sink flag, Connect origin과 connector name의 설정 여부만 합성한다. Connect REST, plugin, connector task, ClickHouse write와 Kafka lag probe는 PR03 전에는 이 response에 포함하지 않는다. V2가 disabled면 기존 top-level health 의미를 유지한다.

### Dashboard snapshot cursor

`GET /api/dashboards/{dashboardId}/published`의 `DashboardRuntimeResponse`에 non-negative `eventCursor`가 추가된다. 값은 snapshot 계산 전에 읽은 durable event high watermark다. 기존 `revision`, `pages`, `widgetsByPageId`, `filters` 의미는 바뀌지 않는다.

SSE event envelope와 wire/rollback 상세 계약은 docs/realtime-2026/contracts/realtime-event-v1.md, docs/realtime-2026/sse-operations.md에 있고 Continuous SQL 계약은 docs/realtime-2026/adr/002-continuous-stream-static-join.md와 docs/realtime-2026/contracts/continuous-sql-v1.md에 고정한다.

### Continuous SQL Job API

- `POST /api/query/continuous-jobs/validate`: `query`, `relationDatasetIds`, `staticBindingPolicy`, `triggerIntervalSeconds`를 받아 `normalizedSql`, `runtimeSql`, `planVersion`, `planHash`, relation/JOIN/output schema와 compiled plan을 반환한다.
- `POST /api/query/continuous-jobs`: validate request에 `name`, mode별 `output`, optional `checkpointPath`, `clientRequestId`를 추가해 stopped Job을 생성한다. 동일 owner의 같은 idempotency key와 fingerprint는 같은 Job을 반환하고 다른 payload는 `409`다.
- `GET /api/query/continuous-jobs`, `GET /api/query/continuous-jobs/{jobId}`: owner/admin 범위 Job과 active Run을 반환한다. Run은 fencing token 원문 대신 `fencingTokenHash`를 반환한다.
- `POST /api/query/continuous-jobs/{jobId}/commands`: `{command, commandId}`를 받고 start/pause/resume/stop/recover desired/observed state를 전이한다. 같은 commandId 재전송은 외부 worker action을 반복하지 않는다.
- `GET /api/query/continuous-jobs/{jobId}/batches`: input offset, static snapshot, output commit, Dataset revision과 `output_committed|catalog_ready|dashboard_ready` stage를 반환한다.

`output.servingMode`의 기본값은 `iceberg`다. 기존 mode는 `storagePath`, append `icebergTarget`, optional S3 `checkpointPath`를 그대로 요구한다. `clickhouse` mode는 `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true`일 때만 허용하며 output shape는 다음과 같다.

```json
{
  "datasetId": "ds_live_customer_join",
  "datasetName": "live_customer_join",
  "layer": "GOLD",
  "servingMode": "clickhouse",
  "clickhouseTarget": {
    "engine": "clickhouse",
    "database": "asklake",
    "table": "live_customer_join"
  }
}
```

ClickHouse mode에는 `storagePath`, `icebergTarget`, `checkpointPath`를 보내지 않으며 `staticBindingPolicy`는 `PINNED_AT_START`만 허용한다. 실행 시작 시 정적 Catalog relation의 exact S3/Iceberg snapshot에서 SQL 참조 열만 Trino page로 적재하고 snapshot identity가 포함된 ClickHouse local static table에 고정한다. source exact count와 local count가 같으면 같은 snapshot table을 resume/recover에서 재사용하고 다르면 truncate 후 재적재한다. 적재 뒤 compiled static JOIN key의 null·빈 값·`uniqExact` count를 다시 비교하며 불일치는 `CLICKHOUSE_STATIC_KEY_NOT_UNIQUE`로 시작을 실패시킨다.

Kafka Engine table은 source payload를 `JSONEachRow`로 추정하지 않고 메시지 전체를 `_raw_message String`의 `RawBLOB`으로 소비한다. ingest materialized view는 Catalog streaming source의 `recordParsing`이 활성화된 경우 exact `expectedFieldCount`와 `\\s+` 위치 계약을 검사하고, 그렇지 않으면 `schemaColumns.sourceName`의 nested JSON path를 사용한다. timestamp는 timezone offset을 포함한 값을 `parseDateTime64BestEffortOrNull`로 변환한다. malformed JSON이나 field count mismatch는 offset을 조용히 건너뛰지 않고 Kafka consumer exception으로 노출한다.

typed raw `ReplacingMergeTree(partition, offset)`는 JOIN 성공 여부와 무관하게 입력과 offset을 보존하고, JOIN materialized view가 매칭된 row만 output `ReplacingMergeTree(partition, offset)`에 기록한다. JOIN SELECT의 사용자 projection은 compiled `outputSchema` 이름으로 명시적으로 alias되어 ClickHouse target column과 정확히 일치한다. worker는 runtime table 존재와 `system.kafka_consumers`의 active 상태/exception을 함께 검사하며 consumer가 아직 등록되지 않았으면 `starting`, parser/consumer 오류가 있으면 `failed`와 `lastErrorCode/lastErrorMessage`를 반환한다. 이 순서 때문에 INNER JOIN에서 매칭되지 않은 메시지도 소비 진도에서 사라지지 않는다.

pause는 Kafka table과 ingest/JOIN materialized view만 제거하고 안정적인 consumer group 이름, raw/output/static table을 보존한다. pause 중 topic에 쌓인 event는 resume에서 같은 consumer group offset 뒤부터 처리한다. Catalog Dataset은 raw offset과 query 가능한 output row가 확인된 첫 publication 이후에만 생성되며, start 응답이나 빈 table 생성만으로 게시 완료로 간주하지 않는다.

ClickHouse Job 응답은 `servingMode=clickhouse`, `outputTarget`의 `engine/database/table/tableUri`를 반환한다. Catalog Dataset은 `storageFormat=clickhouse`, `clickhouseTable`, input offset과 별도인 output row count를 보존한다. Dataset row와 Dashboard widget physical query는 `FINAL`을 사용해 같은 `(partition, offset)` retry 중복을 제거한다. 일반 Trino query mapping은 만들지 않으므로 이 Dataset을 범용 SQL editor source로 사용하지 않는다. worker가 실패한 같은 Run을 Spark/Iceberg로 자동 전환하지 않으며 rollback은 새 실행 전에 flag를 끄고 기존 Iceberg mode로 Job을 생성하는 방식이다.

`triggerIntervalSeconds`는 1~3,600초이고 새 Continuous SQL validate/create request에서 생략하면 5초다. 기존 persisted Job의 주기와 일반 Kafka Continuous 기본값은 변경하지 않는다. 이 값은 micro-batch 시작 주기이며 end-to-end 반영 시간에는 Spark JOIN, Iceberg commit, Trino exact-count, Catalog/Dashboard publication이 추가된다.

compiled plan은 `staticCacheMaxRows`와 relation별 서버 계산 `cacheHint`를 포함한다. `estimatedRowCount` 통계가 있고 `CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS` 이하인 static relation만 exact `(datasetId, snapshotId, schemaFingerprint)` identity로 cache한다. 같은 snapshot·JOIN key의 유일성 검증은 한 번만 재사용하고 snapshot 변경 시 frame과 검증 identity를 폐기한다. 통계가 없거나 한도를 넘는 relation은 cache하지 않으며, 0은 cache 비활성이다.

새 Continuous SQL output Iceberg table의 partition spec에는 사용자 schema에 노출하지 않는 `_asklake_run_id` identity partition을 추가한다. publication의 exact snapshot row-count와 Dashboard revision delta는 이 partition을 조건으로 해당 batch file만 가지치기할 수 있다. 이미 생성된 output table은 자동으로 partition evolution하지 않고 기존 spec을 유지하며, 이 경우에도 exact `_asklake_run_id` 검증 계약은 그대로 유지된다.

기존 `/api/query/runs` 및 Kafka Continuous ETL API는 변경하지 않는다. Continuous SQL feature flag가 꺼져 있으면 validate/create/start/resume/recover는 `409 CONTINUOUS_SQL_DISABLED`로 fail closed한다.

## Internal runtime compatibility contract

Spark/Kafka production entrypoint 경로, 기존 CLI/environment 입력, exit 의미와 public ETL API shape는 유지한다. runtime report에는 optional `runtimeReportSchemaVersion`, Continuous checkpoint contract에는 optional `contractSchemaVersion`, batch manifest에는 optional `manifestSchemaVersion`이 추가된다. 필드가 없는 기존 문서는 version 0으로 읽으며 기존 consumer는 새 필드를 무시할 수 있다.

Review analysis API request/response는 변경하지 않는다. 내부 Python→Node 호출만 `version/requestId/idempotencyKey/operation/payload` envelope로 전환하며 bridge 오류는 기존 `BACKEND_TIMEOUT`, `REVIEW_ANALYSIS_FAILED`, `REVIEW_ANALYSIS_INVALID_RESPONSE` public 오류로 변환한다.

## Refactor persisted compatibility and legacy visibility

리팩토링은 baseline API 83 paths/95 operations, 23개 persisted table model, 기존 Job·session·checkpoint shape를 하위 호환 기준으로 사용한다. `KafkaContinuousRuntime.desiredState`, `observedState`와 `ContinuousRuntimeErrorDetail`은 응답 전용 additive field/schema이며 기존 `status`, `lastError`를 제거하지 않는다.

version field가 없는 runtime report/checkpoint/manifest는 version 0 reader로 읽고, 미래 version은 거절한다. `runtimeContract`가 없는 DB row는 기존 status/error로 투영한다. 구버전 Job의 `permissionRoles`, legacy transform/quality rule, dashboard scalar color와 lineage payload 부재는 제한된 compatibility adapter를 사용하며 활성화 시 `compatibility.path.used` warning/counter가 기록된다.

frontend mock API는 개발 빌드에서만 허용한다. production build에서 `VITE_USE_MOCK_API=true`이면 실제 backend 대신 mock을 사용하지 않고 즉시 실패한다. 전체 owner·제거 조건은 `docs/refactor-2026/legacy-path-register.json`에 고정한다.

## ClickHouse Realtime Serving V2 additive migration contract

이 계약은 누적 PR01~09 branch의 구현 상태다. [9-PR 실행 매핑](codex-clickhouse-realtime-pr-pack/STACKED_PR_PLAN.md)의 각 PR이 `dev`에 순서대로 merge될 때 field별로 활성화하며 기존 client request의 required field를 늘리지 않는다.

### Persisted state 확장

- PR02의 Alembic revision `0016_clickhouse_realtime_v2_foundation`은 `0015_ai_generation_evidence_audit` 다음에 `realtime_pipelines`, `realtime_pipeline_versions`, `realtime_pipeline_deployments`, `realtime_partition_checkpoints`, `realtime_materializations`, `realtime_partition_receipt_ranges`, `realtime_ingest_exceptions`, `realtime_dimension_versions`, `realtime_unmatched_events`, `realtime_routing_assignments`를 expand-only로 추가한다.
- PR02는 기존 publication table을 변경하지 않았다. PR06의 `0017_catalog_realtime_publication`이 `dataset_freshness`, `dataset_revision_commits`, `realtime_event_log`를 additive 확장하며 `dataset_serving_revisions`를 만들지 않는다.
- PR09의 `0018_realtime_archive_recovery`는 immutable `realtime_parity_checks`와 idempotent `realtime_recovery_operations`를 추가한다. sticky routing은 0016의 `realtime_routing_assignments`를 재사용한다.
- 신규 metadata table은 runtime startup `create_all`이 아니라 Alembic이 schema authority다. production downgrade는 지원하지 않고 disabled-mode rollback에서 table을 보존한다.
- 공개 Dataset revision은 기존 `dataset_freshness.latest_revision`과 `dataset_revision_commits`를 확장한다. 별도 public revision table을 만들지 않는다.
- `dataset_freshness`에는 optional `binding_epoch`, active serving/archive version과 latest source boundary/checksum/mutation type을 추가한다.
- `dataset_revision_commits`에는 optional materialization ID, serving engine/version, binding epoch, dimension version set, source boundary, mutation type과 checksum을 추가한다.
- durable change event는 기존 `realtime_event_log`를 확장한다. event idempotency key는 Dataset revision/binding event와 1:1이어야 한다.
- pointer switch와 rollback은 `dataset_freshness` row lock 안에서 새 global revision과 더 큰 binding epoch를 함께 할당한다.

### Catalog 하위 호환

- `queryEngineTable`은 검증된 archive Iceberg/Trino mapping으로 유지한다.
- `clickhouseTable`은 기존 V1 reader 호환 field로 유지한다.
- V2는 optional `physicalBindings[]`를 추가하고 `role=serving|archive`, engine, status, physical identity, pipeline/dimension version, boundary, revision/epoch를 명시한다.
- ClickHouse-only V1 또는 아직 Gold parity가 없는 Dataset은 archive binding이 없거나 `status=pending`일 수 있다. 검증된 Gold projection이 없으면 `queryEngineTable`을 합성하거나 Trino fallback 가능으로 표시하지 않는다.
- V2 writer는 migration window 동안 호환 field와 `physicalBindings`를 함께 쓰며 reader 전환 근거 없이 기존 field를 제거하지 않는다.
- ClickHouse physical identifier를 `queryEngineTable`로 저장하지 않는다.

### Revision·Dashboard 하위 호환

- V2 revision은 `mutationType=append|upsert|replace|retract`를 갖는다. field가 없는 기존 revision은 현재 규칙대로 append/delta 또는 full fallback을 추론한다.
- Dashboard widget query의 optional `clientKnownRevisions`는 목표 extension이며 현재 public request schema에는 아직 노출하지 않는다. 현재 browser는 SSE event와 `/api/datasets/freshness/query`의 Dataset cursor를 조합한다.
- 현재 widget response는 기존 `appliedRevision`, `calculatedAt`, `dataStatus`, `dataError`를 유지한다. `bindingEpoch`, engine, boundary와 mutation metadata는 freshness/Catalog/SSE 응답에서 additive하게 제공한다.
- append만 delta merge 후보이며 upsert/replace/retract와 late dimension repair는 canonical current serving 결과를 다시 계산한다.
- SSE Dataset event는 기존 `dataset.revision.committed` 이름을 유지하고 schema version 2 payload에 binding epoch, mutation type, pipeline/materialization version identity를 작은 allowlist metadata로 추가한다. `dashboard.published`와 `system.*` control event도 rename하지 않으며 row, widget result, credential은 금지한다.

### Consumer·publication 불변식

- 같은 Job generation의 Kafka Engine V1과 Kafka Connect V2 동시 ownership을 거부한다.
- checkpoint는 Kafka read-committed expected position과 raw/quarantine/audited-skip position이 일치하는 contiguous receipt range까지만 전진한다.
- 같은 source boundary retry는 같은 materialization ID, source fingerprint와 ClickHouse insert token을 사용한다.
- ClickHouse count/checksum/widget/parity는 base ReplacingMergeTree가 아니라 canonical current view를 사용한다.
- external ClickHouse/Kafka/S3 I/O 중 PostgreSQL transaction이나 row lock을 유지하지 않는다.
- final publication transaction은 freshness lock, checkpoint CAS, materialization commit, revision commit, freshness update, durable event insert 순서로 원자화한다.

### Archive parity·rebuild·binding switch

- hot/archive parity는 동일 partition boundary vector와 pipeline/dimension version을 먼저 확인한 뒤 row count/checksum, distinct source position, schema fingerprint, null/error count, numeric sum과 sample hash를 모두 비교한다.
- mismatch evidence도 원장에 남지만 rebuild/cutover 입력으로 사용할 수 없다. mismatch가 Dashboard의 마지막 성공 result를 즉시 삭제하지는 않는다.
- rebuild operation은 고정 boundary B와 partition별 `nextOffset=B[p]+1`을 기록한다. 같은 target/report retry는 같은 deterministic operation/idempotency identity를 사용한다.
- cutover는 10만 건 fixture, 72시간 shadow, P95, restart/chaos, security, rollback drill, 운영 dashboard/runbook evidence가 전부 승인돼야 한다. rollback은 matched parity와 expected current pointer를 요구하되 긴 관찰 시간을 장애 복구의 선행 조건으로 삼지 않는다.
- switch transaction은 freshness/Catalog expected pointer를 잠근 뒤 Catalog binding, sticky routing assignment, revision commit, freshness와 schema v2 event를 함께 갱신한다. cutover와 rollback 모두 `mutationType=replace`이고 매번 더 큰 public `bindingEpoch`/global revision을 만든다.
- 현재 이 경계는 `ArchiveRecoveryService` 내부 application API다. 별도 외부 cutover HTTP route는 없으며 raw SQL pointer 변경은 지원하지 않는다.

상세 endpoint와 error code는 구현 PR마다 `docs/03-api-reference.md`, OpenAPI와 함께 활성화한다. 문서에 target field가 있다는 이유만으로 merge 전 production client가 전송해서는 안 된다.
