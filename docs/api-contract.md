Warning: truncated output (original token count: 65118)
Total output lines: 4298

# AskLake Backend API Contract

이 문서는 AskLake 프론트엔드와 실제 백엔드 API를 연결하기 위한 구현 명세입니다.
프론트 연결 지점은 `frontend/src/services/apiClient.ts`, `frontend/src/services/pipelineApi.ts`, `frontend/src/services/sourceConnectorService.ts`입니다.

## Pipeline·Snapshot·SQL·Catalog 내부 경계

### Catalog JOIN 유일키 자동 검증

`POST /api/catalog/datasets/{datasetId}/unique-keys/verify-and-register`는 `{ columns: string[] }`을 받고 Dataset `manage` 권한을 검사한 뒤 query 가능한 정적 Iceberg table에서 exact `count(*)`, invalid key count, distinct key count를 계산한다. `invalidKeyRows=0`이고 `totalRows=distinctKeys`일 때만 단일/복합 key set을 Catalog에 저장한다. 실패는 `CATALOG_UNIQUE_KEY_VERIFICATION_FAILED`와 세 count를 반환하며 추정치나 UI 선언만으로 유일성을 등록하지 않는다. Continuous SQL UI는 `CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE`의 `datasetId`와 `joinColumns`를 이용해 이 API를 자동 호출하고 validate/create/start를 재개한다.

### Catalog Dataset 전체 삭제

`GET /api/catalog/datasets/{datasetId}/deletion-impact`는 `delete` 권한을 확인하고 `canDelete`, `blockers`, `artifacts`, `retainedResources`를 반환한다. active ETL/SQL/Continuous workload, 중지되지 않은 schedule, Dataset을 source로 쓰는 Job, downstream lineage, Dashboard widget, Semantic model/metric/dimension/relationship, active RAG classification/index 작업, AskLake 소유권을 입증할 수 없는 storage path는 blocker다.

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
| 6d | P1 | `POST /api/catalog/datasets/{datasetId}/filter-values/query` | Dashboard 위젯 필터의 bounded distinct 값 조회 |
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
- AWS native S3 Source는 custom endpoint가 없으므로 `S3_ALLOWED_ENDPOINTS`를 요구하지 않습니다. Source가 MinIO 등 custom endpoint를 명시할 때만 그 origin이 `S3_ALLOWED_ENDPOINTS`, `S3_ENDPOINT`, 또는 `MINIO_ENDPOINT` allowlist에 있어야 합니다. bucket은 두 경우 모두 `S3_ALLOWED_BUCKETS` 경계를 따릅니다.
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
| `POST /api/catalog/datasets/{datasetId}/filter-values/query` | `view` + `query` | Dataset schema와 물리 데이터에서 필터 후보값을 조회 |
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
  status: "preparing" | "available" | "approval_required";
  freshness: "latest" | "realtime" | "stale" | "approval";
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

EKS MVP bounded fixture routing은 기존 Snapshot direct target의 예외이며 다음 저장 필드를 사용한다.

```ts
type EksMvpFixtureSourceConfig = [
  ["Broker / Endpoint", `${string}:9098`],
  ["TOPIC / QUEUE NAME", "asklake.eks-mvp.fixture.v1"],
  ["CONSUMER GROUP ID", string], // exact configured slot; default is asklake-eks-mvp-spark-v1
  ["__EKS MVP Fixture Batch ID", string],
  ["__EKS MVP Expected Count", string],
];
```

Snapshot Kafka Job에서 exact fixture topic/default group 또는 두 내부 receipt field 중 하나가 보이면 backend는 fixture 실행 의도로 분류한다. consumer group은 `ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON`에 등록된 exact slot이어야 하며 설정이 없으면 기존 default group/table 한 쌍만 허용한다. 네 값, positive expected count(최대 100,000), IAM `9098` endpoint와 Kubernetes Spark runner가 모두 유효하면 기존 Kafka bridge 대신 Airflow Run을 예약하고 `AirflowDagRun.dagRunId=JobRunSummary.runId`를 유지한다. fixture 의도는 있지만 계약이 틀리면 executor를 하나도 호출하지 않고 fail-closed한다. fixture 표시가 없는 Kafka Snapshot은 기존 direct bridge, `executionMode=continuous`는 기존 Continuous control-plane 계약을 그대로 사용한다.

Airflow 호출 전 같은 transaction에 다음 immutable Run state를 저장한다.

```ts
type EksMvpFixtureRunState = {
  capturedAt: string;
  contractVersion: 2;
  icebergTable: string;
  runId: string;
  sourceBoundary: {
    broker: `${string}:9098`;
    checkpointPath: `s3a://${string}/eks-mvp/checkpoints/${string}`;
    consumerGroup: string;
    expectedCount: number;
    fixtureBatchId: string;
    kind: "kafka_snapshot";
    outputPath: `s3a://${string}/eks-mvp/output/${string}`;
    snapshotId: string;
    topic: "asklake.eks-mvp.fixture.v1";
  };
};
```

`taskStates.eksMvpFixture.runId`, `sourceBoundary.snapshotId`, Airflow `dagRunId`는 모두 `JobRunSummary.runId`와 같다. Airflow conf와 internal Spark execute body는 RDS의 `sourceBoundary`를 그대로 운반하며 FastAPI는 exact match 후에만 Spark lease/submission을 시작한다. Spark payload와 동적 SparkApplication manifest/env는 mutable Job source field가 아니라 이 persisted boundary를 사용한다. 실행 target은 consumer group에 대응하는 승인된 slot table이고 write mode는 `replace`로 고정한다. slot 목록은 기본 쌍을 반드시 포함하고 최대 5개이며 group/table 각각 유일해야 한다. PostgreSQL에서는 group별 advisory transaction lock으로 active Run 예약을 직렬화한다. 같은 slot의 두 번째 active Run은 `EKS_MVP_FIXTURE_SLOT_ACTIVE`, 잘못된 runtime slot 설정은 `EKS_MVP_FIXTURE_SLOTS_INVALID`다. Spark는 batch filter 후 실제 count가 `expectedCount`와 다르면 commit 전에 실패한다. FastAPI는 성공 result의 `sourceBoundary`, `inputRows`, `outputRows`, `icebergCommit.target/sourceBoundary/jobId/runId/snapshotId`를 RDS boundary와 mapped target에 재검증하며 불일치는 `EKS_MVP_FIXTURE_RESULT_INVALID`다.

contract version 2는 예약 시 선택된 `icebergTable`을 RDS state에 함께 고정하므로 예약 뒤 runtime slot mapping이 바뀌면 Spark 제출 전에 `EKS_MVP_FIXTURE_RUN_BOUNDARY_INVALID`로 실패한다. 기존 version 1 state는 목요일 default group/table 한 쌍에 한해서만 읽기 호환한다.

같은 fixture Run 재호출의 멱등 기준은 RDS다. `sparkResult.status=success`면 새 lease나 외부 실행 없이 같은 result를 반환한다. 미완료 상태에서 `sparkExecution.kubernetesExecution`의 namespace/name/UID가 있으면 Node provider에 expected identity로 전달하고, provider는 create 전에 결정적 이름의 SparkApplication을 조회해 UID와 run/job/image annotation을 모두 대조한다. object가 없거나 UID가 바뀌면 replacement를 만들지 않는다. Spark driver가 동일 persisted `kafka_snapshot` boundary를 다시 처리하는 최악의 복구 경로에서도 target table의 boundary marker를 먼저 조회하며, 이미 존재하면 `replace` target도 writer를 호출하지 않고 기존 snapshot ID를 `operation: "reuse"`로 반환한다. 성공 재호출은 동일 `runId`, 동일 SparkApplication UID, 동일 Iceberg snapshot ID를 유지해야 한다.

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

`continuousRuntime` additionally exposes `desiredState`, `observedState`, `stateRevision`, `fencingToken`, `errorDetail`, `maxPartitionLag`, `laggingPartitionCount`, `lagAvailable`, `partitionProgress`, `lastBatchDurationMs`, `lastBatchInputRows`, `throughputRowsPerSecond`, `replayedCount`, `schemaVersion`, `schemaFingerprint`, `schemaStatus`, `schemaChanges`, `ruleContractVersion`, `ruleFingerprint`, `runtimeFingerprint`, `ruleMetrics`, and `lastRuleResult`. `stateRevision` is monotonic per accepted command and worker observations do not increment it. `errorDetail` contains `stage`, `code`, `message`, `retryable`, and optional redacted `context`; legacy rows derive it from `lastError` wi…35118 tokens truncated…며 잠금 순서는 Catalog 다음 freshness입니다. quarantine replay는 한 번에 최대 1,000행을 처리해 자체 manifest/source range를 만들고 `commit_kind=replay` 별도 namespace에서 멱등 처리합니다. manifest 도입 전 replay는 Catalog에 성공 run으로 등록된 ID만 maintenance migration 입력으로 신뢰합니다. replay worker result file과 DB pending result는 Catalog보다 먼저 복구 경계로 저장합니다. replay Iceberg 저장 뒤 Catalog만 실패하거나 backend가 종료되어도 terminal runtime을 포함한 background refresh가 같은 결과를 재조정하고, Catalog 성공 후에만 stored/replayed 카운터를 한 번 더합니다. 로컬 result file이 없어도 backend는 `run_id`의 S3 replay `_SUCCESS`와 payload를 직접 읽어 publication ID/type, data path, source range/boundary, Iceberg boundary를 모두 확인한 뒤 복구합니다. 명시적인 object 404만 missing으로 처리하고 S3 접근·파싱·identity 오류는 fail-closed 합니다. `startContinuous`/`resumeContinuous`는 pending replay를 먼저 재조정하며 아직 Catalog/카운터 반영이 끝나지 않았으면 `409`를 반환합니다.

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
- 날짜 차원의 `windowDays`는 최신 bucket 기준으로 만료 aggregate bucket을 상태에서 제거합니다. 행 단위 임의 슬라이딩 window는 지원하지 않습니다.
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

## EKS MVP execution and Continuous ownership contract

- `ASKLAKE_SPARK_RESOURCE_PLANNER_MODE=shadow`는 File/S3 입력 metadata로
  `taskStates.sparkExecution.resourcePlan`을 최초 제출 전에 저장한다.
- `shadow`의 `appliedExecutors`는 기존 executor 수를 유지하며 같은 Run의 retry는
  Plan을 재사용한다. Plan hash drift는 `SPARK_EXECUTION_IDENTITY_MISMATCH`로 실패한다.
- policy V3 `history-sla-cost-v1`은 `standard-v1`(cores 2, CPU request/limit 2/3,
  heap/overhead 4g/1g) profile을 고정하고 executor 수만 `1`, `2`, `4` 중 선택한다.
  같은 Job의 성공 이력으로 후보별 Spark duration과 executor-seconds를 계산해 30분을
  만족하는 최소 비용 후보를 선택한다. 비교 가능한 이력이 없으면 입력 크기 seed를
  사용하고, 입력 크기가 없거나 profile이 다르면 `enforce`에서도 baseline을 유지한다.
- candidate evaluation, decision basis와 history count는 Plan hash에 포함된다. policy
  V1/V2 Plan은 기존 Run retry/recovery에서만 호환된다.

## Realtime 2026 전환 계약

### GET /api/realtime/config

인증된 frontend가 서버의 effective realtime mode를 읽는 진단 endpoint다. response field는 camelCase다.

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

### Dashboard snapshot cursor

`GET /api/dashboards/{dashboardId}/published`의 `DashboardRuntimeResponse`에 non-negative `eventCursor`가 추가된다. 값은 snapshot 계산 전에 읽은 durable event high watermark다. 기존 `revision`, `pages`, `widgetsByPageId`, `filters` 의미는 바뀌지 않는다.

SSE event envelope와 wire/rollback 상세 계약은 docs/realtime-2026/contracts/realtime-event-v1.md, docs/realtime-2026/sse-operations.md에 있고 Continuous SQL 계약은 docs/realtime-2026/adr/002-continuous-stream-static-join.md와 docs/realtime-2026/contracts/continuous-sql-v1.md에 고정한다.

### Continuous SQL Job API

- `POST /api/query/continuous-jobs/validate`: `query`, `relationDatasetIds`, `staticBindingPolicy`, `triggerIntervalSeconds`를 받아 `normalizedSql`, `runtimeSql`, `planVersion`, `planHash`, relation/JOIN/output schema와 compiled plan을 반환한다.
- `POST /api/query/continuous-jobs`: validate request에 `name`, mode별 `output`, optional `checkpointPath`, `clientRequestId`를 추가해 stopped Job을 생성한다. 동일 owner의 같은 idempotency key와 fingerprint는 같은 Job을 반환하고 다른 payload는 `409`다.
- `GET /api/query/continuous-jobs`, `GET /api/query/continuous-jobs/{jobId}`: owner/admin 범위 Job과 active Run을 반환한다. Run은 fencing token 원문 대신 `fencingTokenHash`를 반환한다.
- `POST /api/query/continuous-jobs/{jobId}/commands`: `{command, commandId}`를 받고 start/pause/resume/stop/recover desired/observed state를 전이한다. 같은 commandId 재전송은 외부 worker action을 반복하지 않는다.
- `GET /api/query/continuous-jobs/{jobId}/batches`: input offset, static snapshot, output commit, Dataset revision과 `output_committed|catalog_ready|dashboard_ready` stage를 반환한다.

Kafka Engine table은 source payload를 `JSONEachRow`로 추정하지 않고 메시지 전체를 `_raw_message String`의 `RawBLOB`으로 소비한다. ingest materialized view는 Catalog streaming source의 `recordParsing`이 활성화된 경우 exact `expectedFieldCount`와 `\\s+` 위치 계약을 검사하고, 그렇지 않으면 `schemaColumns.sourceName`의 nested JSON path를 사용한다. timestamp는 timezone offset을 포함한 값을 `parseDateTime64BestEffortOrNull`로 변환한다. malformed JSON이나 field count mismatch는 offset을 조용히 건너뛰지 않고 Kafka consumer exception으로 노출한다.

pause는 Kafka table과 ingest/JOIN materialized view만 제거하고 안정적인 consumer group 이름, raw/output/static table을 보존한다. pause 중 topic에 쌓인 event는 resume에서 같은 consumer group offset 뒤부터 처리한다. Catalog Dataset은 raw offset과 query 가능한 output row가 확인된 첫 publication 이후에만 생성되며, start 응답이나 빈 table 생성만으로 게시 완료로 간주하지 않는다.

`triggerIntervalSeconds`는 1~3,600초이고 새 Continuous SQL validate/create request에서 생략하면 10초다. 기존 persisted Job의 주기와 일반 Kafka Continuous 기본값은 변경하지 않는다. 이 값은 micro-batch 시작 주기이며 end-to-end 반영 시간에는 Spark JOIN, Iceberg commit, Trino exact-count, Catalog/Dashboard publication이 추가된다.

새 Continuous SQL output Iceberg table의 partition spec에는 사용자 schema에 노출하지 않는 `_asklake_run_id` identity partition을 추가한다. publication의 exact snapshot row-count와 Dashboard revision delta는 이 partition을 조건으로 해당 batch file만 가지치기할 수 있다. 이미 생성된 output table은 자동으로 partition evolution하지 않고 기존 spec을 유지하며, 이 경우에도 exact `_asklake_run_id` 검증 계약은 그대로 유지된다.

기존 `/api/query/runs` 및 Kafka Continuous ETL API는 변경하지 않는다. Continuous SQL feature flag가 꺼져 있으면 validate/create/start/resume/recover는 `409 CONTINUOUS_SQL_DISABLED`로 fail closed한다.

## Internal runtime compatibility contract

Spark/Kafka production entrypoint 경로, 기존 CLI/environment 입력, exit 의미와 public ETL API shape는 유지한다. runtime report에는 optional `runtimeReportSchemaVersion`, Continuous checkpoint contract에는 optional `contractSchemaVersion`, batch manifest에는 optional `manifestSchemaVersion`이 추가된다. 필드가 없는 기존 문서는 version 0으로 읽으며 기존 consumer는 새 필드를 무시할 수 있다.

Review analysis API request/response는 변경하지 않는다. 내부 Python→Node 호출만 `version/requestId/idempotencyKey/operation/payload` envelope로 전환하며 bridge 오류는 기존 `BACKEND_TIMEOUT`, `REVIEW_ANALYSIS_FAILED`, `REVIEW_ANALYSIS_INVALID_RESPONSE` public 오류로 변환한다.

일반 Snapshot Spark runtime은 source inventory의 exact `inputBytes`와 `ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES`를 staging 전에 비교한다. file metadata를 하나라도 읽지 못하면 성공한 file의 부분 byte 합계를 버리고 cache 의사결정 크기를 unavailable로 둔다. 기본 0, source byte 미확인·0·한도 초과는 `materializationMode=run_scoped_parquet_staging`, `cacheStorageLevel=NONE`, `outputFrameCacheMode=staged_parquet_reuse`다. 양수 한도 이하 source는 `materializationMode=direct_source_cache`, `MEMORY_AND_DISK`, `direct_source_memory_and_disk`로 실행하고 run-scoped Parquet materialization을 만들지 않는다. `sparkResources`는 `executionStrategyPolicy=max_source_bytes`, `directCacheMaxSourceBytes`, `directCacheEligible`, `directCacheDecisionReason`, `directCacheFailureMode=fail_run`, `directCacheFallbackCount=0`을 보존한다. direct cache 준비 실패는 원본을 조용히 다시 읽는 staging fallback 없이 `failedStage=Direct Cache Initialization`로 실패한다. 정상 실행의 raw physical full-read 예산은 두 경로 모두 1회지만 executor/cache block 손실 후 direct-cache lineage 재계산은 원본을 다시 읽을 수 있다. staging 경로의 `materializationBytes`는 전략 판정에 사용하지 않아 nullable이고 `materializationSizeStatus=not_measured_by_strategy`다.

## Refactor persisted compatibility and legacy visibility

리팩토링은 baseline API 83 paths/95 operations, 23개 persisted table model, 기존 Job·session·checkpoint shape를 하위 호환 기준으로 사용한다. `KafkaContinuousRuntime.desiredState`, `observedState`와 `ContinuousRuntimeErrorDetail`은 응답 전용 additive field/schema이며 기존 `status`, `lastError`를 제거하지 않는다.

version field가 없는 runtime report/checkpoint/manifest는 version 0 reader로 읽고, 미래 version은 거절한다. `runtimeContract`가 없는 DB row는 기존 status/error로 투영한다. 구버전 Job의 `permissionRoles`, legacy transform/quality rule, dashboard scalar color와 lineage payload 부재는 제한된 compatibility adapter를 사용하며 활성화 시 `compatibility.path.used` warning/counter가 기록된다.

frontend mock API는 개발 빌드에서만 허용한다. production build에서 `VITE_USE_MOCK_API=true`이면 실제 backend 대신 mock을 사용하지 않고 즉시 실패한다. 전체 owner·제거 조건은 `docs/refactor-2026/legacy-path-register.json`에 고정한다.
