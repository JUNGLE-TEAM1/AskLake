# AskLake Backend API Contract

이 문서는 AskLake 프론트엔드와 실제 백엔드 API를 연결하기 위한 구현 명세입니다.
프론트 연결 지점은 `frontend/src/services/apiClient.ts`, `frontend/src/services/pipelineApi.ts`, `frontend/src/services/sourceConnectorService.ts`입니다.

## 1. 구현 우선순위

| 단계 | 우선순위 | API | 목적 |
| --- | --- | --- | --- |
| 1 | P0 | `POST /api/etl/jobs` | 새 수집/처리 생성 완료 |
| 1a | P0 | `PATCH /api/etl/jobs/{jobId}` | 생성 Job의 허용 설정 update (Issue #460) |
| 2 | P0 | `POST /api/etl/jobs/{jobId}/commands` | 즉시 실행, 재실행, 일시정지, 현재 Run 취소, 스케줄 중지 |
| 3 | P0 | `POST /api/query/runs` | 읽기 전용 SQL 실행 |
| 4 | P0 | `POST /api/query/ai-suggestions` | 선택 테이블 context 기반 Query AI SQL 초안 생성 |
| 5 | P1 | `GET /api/catalog/datasets` | 카탈로그 목록 hydrate |
| 6 | P1 | `GET /api/catalog/datasets/{datasetId}` | 데이터셋 상세 hydrate |
| 7 | P1 | `POST /api/dashboards` | 대시보드 초안 생성 |
| 8 | P1 | `GET /api/s3/buckets`, `GET /api/s3/prefixes` | Target 저장경로 S3 bucket/prefix 선택 |
| 9 | P1 | `GET /api/target/databases` | Target 기본정보 DB 선택 |
| 10 | P2 | `GET /api/admin/audit-logs` | 서버 감사 로그 조회/검색 |

현재 Pair A Source/Schema/Create/Run/Catalog/SQL preview 흐름과 Dashboard card/runtime 흐름은 live backend API를 호출합니다.
Dashboard adapter는 FastAPI 응답을 우선하고, 이전 backend 호환을 위해 404 local/mock fallback을 유지합니다.

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
VITE_USE_MOCK_API=false
VITE_DASHBOARD_ASSISTANT_API_PATH=/api/dashboards/assistant
DATABASE_URL=postgres://asklake:asklake_dev@127.0.0.1:54328/asklake
S3_ALLOWED_BUCKETS=asklake-output
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
TARGET_DATABASES=asklake,asklake_gold,analytics,marketing
```

- `VITE_API_BASE_URL`: 백엔드 base URL입니다.
- `VITE_USE_MOCK_API`: `false` 또는 미설정이면 live backend를 호출합니다. frontend mock mode는 `true`를 명시합니다.
- `VITE_DASHBOARD_ASSISTANT_API_PATH`: 미설정 시 `/api/dashboards/assistant`를 호출합니다. 다른 Assistant API 경로 또는 origin이 필요할 때만 지정합니다.
- `DATABASE_URL`: backend metadata DB입니다. 미설정 시 `docker-compose.yml`의 local Postgres 기본값을 사용합니다.
- mock mode에서는 Source/Schema 연결 테스트도 `sourceConnectorService.ts`의 mock `SourceConnectorAnalysis`를 사용합니다.
- live mode에서는 Source/Schema/Create/Run 흐름이 실제 백엔드를 호출합니다.
- Target 저장경로 선택은 브라우저가 AWS SDK나 secret을 갖지 않고 `/api/s3/buckets`, `/api/s3/prefixes` 서버 API만 호출합니다. 서버는 `S3_ALLOWED_BUCKETS` allowlist를 검증하고 AWS SDK v3 `ListObjectsV2`로 prefix를 조회합니다.
- Target DB 선택은 `/api/target/databases` 서버 API만 호출합니다. 서버는 `TARGET_DATABASES` 또는 `ASKLAKE_TARGET_DATABASES` allowlist를 사용하고, 값이 없으면 local demo 기본 DB 목록을 반환합니다.

## 4. 공통 HTTP 규칙

### Request

- 모든 request body는 JSON입니다.
- 모든 response body는 JSON입니다.
- 날짜/시간은 ISO 8601 문자열을 사용합니다.
- ID는 문자열입니다.
- 프론트는 세션 쿠키 기반 endpoint를 위해 `credentials: "include"`로 `fetch`를 호출합니다.

권장 header:

```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer {accessToken}
X-Request-Id: req_20260703_000001
```

현재 로컬 인증은 `/api/auth/login` 또는 `/api/auth/signup`이 발급하는 httpOnly `asklake_session` 쿠키를 사용합니다. 외부 IdP/OAuth/SSO, refresh token, 비밀번호 재설정, 이메일 인증은 아직 범위 밖이며, 기존 smoke와 수동 검증을 위해 `X-AskLake-*` actor header fallback은 유지합니다. 이 fallback은 로컬 smoke/manual 검증용이며, 운영에서는 session/IdP 또는 trusted gateway 검증 없이 client-provided header만으로 role/user/group을 신뢰하면 안 됩니다.

### Permission/Governance Phase 0 용어

Phase 0 기준에서 identity metadata와 access control은 별도 개념입니다.

| 용어 | 현재 의미 | 후속 방향 |
| --- | --- | --- |
| `createdBy` | Job/Dataset/Dashboard에 optional 표시 metadata로 제공 | resource를 생성한 사용자 표시와 감사 로그 문맥에 사용 |
| `createdByProfile` | `displayName`, `avatarInitials` 중심의 optional 표시 metadata | profile/avatar 표시용으로 확장 가능 |
| `owner` | Job/Dataset/Dashboard 화면에 표시되는 소유자 문자열 | 표시/책임자 metadata로 유지하고 권한 판정의 단일 근거로 쓰지 않음 |
| profile/avatar | `createdByProfile`의 optional 표시 값 | `createdBy`/`owner` 옆 표시용 identity metadata로 추가 |
| `permissionSummary` | Create Permission 단계의 요약 문구 | governance metadata로 유지 |
| `permissionRoles` | Create Permission 단계의 역할별 설정 값 | 후속 `permissionGrants` 계약으로 승격 전까지 enforce하지 않음 |
| `permissionGrants` | Job/Dataset/Dashboard에 optional response/request metadata로 제공 | user/group/role/public별 resource action 허용 목록 |
| `permissions` | Job/Dataset/Dashboard에 optional response metadata로 제공 | backend가 현재 actor 기준 `canView`, `canQuery`, `canManage` 등을 계산해 내려주는 값 |

Catalog 목록/상세, SQL preview, Query AI, ETL job command API, Dashboard card/runtime API는 `permissionSummary`나 `permissionRoles`만으로 접근 권한을 판정하지 않습니다. 이 값들은 표시용 governance metadata이고, 실제 허용 여부는 `ActorContext`와 resource별 `permissionGrants`로 계산합니다. Dashboard 삭제 API의 `X-AskLake-User`, `X-AskLake-Role` header는 초기 dashboard 전용 입력에서 시작했지만, 이후 공통 actor header로 해석됩니다.

`permissionGrants`와 `permissions`는 UI 표시와 backend enforcement를 함께 설명하는 계약 필드입니다. `permissions.enforced=false`이면 프론트는 버튼 비활성화/경고에만 참고하고, 실제 보안 차단으로 해석하지 않습니다. `permissions.enforced=true`이면 같은 기준으로 backend가 `403 FORBIDDEN`을 반환할 수 있습니다.

Backend는 세션 쿠키가 있으면 session user를 우선 actor로 사용하고, 세션이 없을 때만 아래 임시 actor header를 공통 `ActorContext` fallback으로 해석할 수 있습니다. 공통 판정기는 Dashboard 삭제뿐 아니라 Catalog dataset 조회/lineage/materialization-run 삭제, SQL preview 실행, Query AI 생성, Job command, Dashboard runtime 편집에도 사용됩니다.

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

관리자 권한 편집 기능은 이 우선순위를 바꾸지 않고 독립 `permission_grants` table row를 생성/수정/삭제하는 API로 확장합니다. 운영 기본값은 group grant 중심이며, user grant는 예외 권한에 사용합니다. Admin 권한은 resource 접근 그룹이 아니라 `role=admin`으로 부여하고, 로컬 demo admin 계정의 groups는 빈 배열로 유지합니다. Group grant/block은 일반 사용자 권한 운영 단위입니다. `role`/`public` grant는 계약상 지원하지만 운영 위험이 크므로 정책 확인 후 사용합니다. 현재 backend는 resource payload 안의 legacy `permissionGrants`와 독립 `permission_grants` table row를 병합해 같은 `grants` 응답과 permission check 입력으로 사용합니다.

Resource/action 기준:

| Resource type | 주요 action | 의미 |
| --- | --- | --- |
| `dataset` | `view` | Catalog 목록/상세/lineage에서 조회 가능 |
| `dataset` | `query` | SQL Preview, Query AI, SQL 결과 기반 후속 작업에서 dataset 사용 가능 |
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
| `GET /api/catalog/datasets/{datasetId}/lineage` | `view` | dataset detail과 같은 기준 |
| `DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}` | `manage` 또는 `delete` | materialization metadata 수정/삭제로 간주 |
| `POST /api/query/runs` | `query` | base/reference dataset 모두 검사 |
| `POST /api/query/ai-suggestions` | `query` | 선택 dataset metadata를 AI context로 사용하기 전 모두 검사 |
| `POST /api/etl/jobs/{jobId}/commands` | `run` 또는 `manage` | `run`/`retry`는 `run`, pause/cancel/stop은 `manage` |
| `PATCH /api/etl/jobs/{jobId}` | `manage` | source identity와 successful target identity 보호 |
| `GET /api/dashboards`, `POST /api/dashboards/query` | `view` | actor가 볼 수 있는 dashboard만 목록에 포함 |
| `GET /api/dashboards/{dashboardId}/published` | `view` | published revision이 없어도 권한 통과 후 빈 runtime 응답 가능 |
| `PATCH /api/dashboards/{dashboardId}` | `manage` | dashboard card title 수정 |
| `POST /api/dashboards/{dashboardId}/draft/ensure` | `manage` | draft revision 생성/복사 가능 여부 검사 |
| `POST/PATCH/DELETE /api/dashboards/{dashboardId}/draft/**` | `manage` | page/widget/layout draft 변경 전체 |
| `POST /api/dashboards/{dashboardId}/publish` | `manage` | draft snapshot을 published revision으로 승격 |
| `DELETE /api/dashboards/{dashboardId}` | `delete` | admin 또는 owner fallback 유지 |

Frontend 기준:

- `permissions.canQuery=false`: SQL Preview 실행, Query AI 생성, Catalog -> SQL 이동, SQL 결과 기반 Job 생성 버튼을 비활성화합니다.
- `permissions.canRun=false`: Job `run`/`retry` 버튼을 비활성화합니다.
- `permissions.canManage=false`: Job pause/cancel/stop 버튼을 비활성화합니다. Dataset materialization-run 삭제 버튼은 `canManage` 또는 `canDelete` 중 하나가 없으면 비활성화합니다.
- `permissions.canManage=false`: Dashboard runtime 편집 모드 진입, page/widget/layout 변경, publish 버튼을 비활성화합니다.
- `permissions.canDelete=false`: Dashboard 삭제 버튼을 비활성화합니다.
- Backend가 `403 FORBIDDEN`을 반환하면 프론트는 일반 실패가 아니라 권한 없음 메시지로 표시합니다.

Profile/Admin Console Phase 0 기준:

- 프로필 페이지와 관리 페이지는 세션 쿠키가 있으면 해당 계정 actor를 우선 사용하고, 세션이 없으면 기존 demo actor header fallback을 사용합니다.
- `POST /api/auth/login`, `POST /api/auth/signup`, `GET /api/auth/session`, `POST /api/auth/logout`은 로컬 데모 계정/session API입니다.
- `GET /api/users/me`는 현재 actor의 표시 프로필, role, group, 권한 요약을 반환합니다.
- `/api/admin/*` endpoint는 `X-AskLake-Role=admin` actor만 호출할 수 있습니다. 권한이 없으면 `403 FORBIDDEN`을 반환합니다.
- 관리 콘솔은 사용자/그룹/감사 로그 조회, 사용자/그룹 차단, resource lock, permission grant 생성/수정/삭제를 지원합니다. 사용자/그룹 자체 생성, 멤버십 편집, deny policy, 조건부 정책은 후속 계약으로 분리합니다.
- 관리자 편집 API는 group grant를 기본 흐름으로, user grant를 예외 흐름으로 제공합니다. Admin 계정은 resource 접근 그룹에 속하지 않고 `role=admin`으로 관리 권한을 받습니다. role/public grant는 계약상 허용하지만 운영 위험이 크므로 관리 콘솔의 기본 추가 옵션으로 노출하지 않고 정책 확인 후 사용합니다. payload에서 유래한 owner/permissionRoles grant는 원본 resource metadata로 남기며, 관리 콘솔에서는 읽기 전용으로 표시합니다.
- 관리 콘솔의 권한 표시는 resource별 `permissionGrants`와 현재 actor 기준 `permissions`를 설명하는 운영 화면이며, 프론트 표시만으로 보안 판정을 대체하지 않습니다.
- Auth table은 현재 repo의 기존 로컬 persistence 패턴에 맞춰 service에서 `create_all`로 보강합니다. 운영 배포의 schema source of truth는 후속 Alembic migration으로 분리해야 합니다.

```ts
type PermissionAction = "view" | "query" | "run" | "manage" | "delete" | "share";
type PermissionPrincipalType = "user" | "group" | "role" | "public";

type PermissionGrant = {
  principalType: PermissionPrincipalType;
  principalId: string;
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
  permissionSummary?: string;
  permissionRoles?: PermissionDraft["roles"];
  targetDatabase?: string;
  targetDescription?: string;
  targetTags?: string[];
  targetFormat?: string;
  targetLayer?: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  storageType?: "S3" | "Local" | "HDFS";
  storagePath?: string;
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

`GET /api/etl/jobs/{jobId}`는 위 설정값을 편집 복원용으로 반환한다. `sourceConfig`에는 Kafka broker, topic, consumer group, batch/timeout, offset policy, authentication 같은 source identity가 포함될 수 있으므로 UI는 값을 보이되 Issue #460 수정 모드에서는 변경하지 않는다. 기존 Job에는 새 선택형 metadata가 없을 수 있으므로 해당 값은 optional로 유지한다.

`schedule`/`scheduleSummary`의 화면 문구는 `수동/자동/1회 실행`이 아니라 `스케줄링 건너뛰기`와 `반복 실행` 두 기준으로 표현한다. 스케줄링을 건너뛰면 즉시 실행 command `run`으로 1회 Run을 만들며, `1회 실행`은 schedule 값으로 저장하지 않는다. 반복 실행 UI는 반복 주기, 실행 시각, IANA timezone, 실패 재시도만 노출한다. ISO date `startDate`, optional `endDate`, 겹침 처리, watermark 수집 기준은 `schedulePolicy`에 함께 보존하지만 UI에서는 기본값으로 처리한다. 빈 `endDate`는 종료일 없음으로 해석하고, `endDate`가 `startDate`보다 이르면 frontend draft에서 빈 값으로 정규화한다. 기본 겹침 처리는 `skip_if_running`이며, 이전 Run이 길어져 다음 예약 시각과 겹쳐도 다음 schedule 계산을 밀지 않고 해당 예약 Run을 건너뛰는 정책이다. `retryPolicySummary`는 재시도 횟수/2배 지수 백오프/최종 실패 처리만 담는 optional field이며, `runLimitSummary`는 hidden default `timeoutMinutes` 기반 실행 제한 표시용 optional field다. 둘 중 하나가 없으면 frontend가 fallback 문구를 사용한다.

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
    status: "queued" | "running" | "success" | "failed" | "canceled";
    createdAt: string;
    rowCount: number;
    storageSizeBytes: number;
    storageLocation?: string;
    sourceKind: "etl" | "sql" | "kafka";
    sourceLabel: string;
  }>;
  upstream: string[];
  downstream: string[];
  lineageGraph?: LineageGraph;
};
```

`size`는 화면 표시용 저장 크기 문자열입니다. 물리 저장 위치와 원시 byte 값은 `storageLocation`, `storageFormat`, `storageSizeBytes`를 사용합니다.
`materializationRuns`는 같은 Job/같은 dataset 이름으로 누적된 실행 또는 SQL materialize 결과 history입니다. 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`는 삭제되지 않은 성공 run 기준으로 계산합니다.

### Kafka Snapshot Metadata and Direct Target

Issue #455 Phase 3부터 Kafka run은 다음 snapshot metadata를 response, Run metadata, Catalog materialization run에 보존하고, 중간 RAW landing 없이 direct target object를 저장한다. Current direct bridge applies supported configured transforms and quality actions before writing normalized review JSONL.

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

Direct target write의 성공 run은 `sourceKind: "kafka"`, target layer, target storage location, `KafkaSnapshot`, transform/quality summary를 함께 기록한다. target write 또는 Catalog 등록이 실패하면 Kafka offset을 commit하지 않으며, quality `Fail Run`도 target write 전에 같은 방식으로 중단한다. `Quarantine` 행은 같은 snapshot directory의 별도 object로 분리한다. 같은 `snapshotId` 재시도는 target과 materialization run을 idempotent하게 갱신한다. 상세 전환 계약은 `docs/kafka-snapshot-direct-target-contract.md`를 따른다.

Kafka Job command가 실패하면 `JobRunSummary.status`는 `failed`이며 `taskStates.kafkaSnapshot`으로 captured range를, `failedStage`로 실패 위치를 유지한다. direct ingest endpoint error response의 `error.details.bridge`도 같은 snapshot diagnostic을 포함한다.

### Kafka Continuous Runtime

Issue #500 defines `executionMode: "snapshot" | "continuous"` on Kafka Job creation. Existing and migrated Kafka Jobs default to `snapshot`. `continuous` is immutable after creation and adds `continuousConfig` (`initialOffsetPolicy`, `triggerIntervalSeconds`, `maxOffsetsPerTrigger`, `schemaEvolutionPolicy`, `checkpointPath`) plus `continuousRuntime` (`status`, heartbeat, lag, last flush, counters, last error) to `JobRowData`.

`startContinuous`, `pauseContinuous`, `resumeContinuous`, and `stopContinuous` are command extensions of `POST /api/etl/jobs/{jobId}/commands`. They launch or signal a Spark Structured Streaming worker, reject conflicting active Snapshot or Continuous consumer identity with `409`, and use a durable Spark checkpoint as source-progress authority. Each batch publishes `batch_id=<id>` Parquet paths with `_SUCCESS` plus a hidden count/offset signature, then writes an immutable full-batch manifest. A pre-manifest retry may reuse an output only when its signature matches; a committed manifest may be reused only when its batch ID and source ranges match. Job hydrate reconciles all reported publication manifests into Catalog before worker liveness failure handling. An exited/missing/stale worker becomes `failed` only while active, and the same container attempt increments `failedCount` once. An intentional exit after `pauseContinuous` or `stopContinuous` completes as `paused` or `stopped`. See [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md).

Frontend `DraftPipeline.source` carries optional `executionMode` and `continuousConfig`; `executionMode: "continuous"` serializes them into Job creation. `JobRowData` includes optional `continuousRuntime` for lifecycle controls and runtime display.

Snapshot Job은 기존 스케줄 단계에서 수동 또는 반복 실행 정책을 저장한다. Continuous Job은 그 단계를 건너뛰며 `scheduleLabel: "스케줄링 건너뛰기"`, stream lifecycle 설명, `continuousConfig`만 생성 request에 보낸다. Continuous의 시작 위치, trigger 간격, micro-batch 최대 메시지는 Source 단계의 접힌 고급 설정에서 지정한다.

### Kafka Replay Producer

`GET|POST|DELETE /api/etl/kafka/replay-producer`는 Continuous 적재를 수동 검증할 때만 쓰는 admin `manage` 도구다. producer 상태는 process-local이며 backend 재시작 또는 배포 교체 시 함께 종료된다. `POST` body는 아래와 같고 topic 삭제를 요청할 수 없다.

```ts
type KafkaReplayProducerRequest = {
  topic?: string; // default: reviews.raw
  inputPath?: string; // ASKLAKE_REPLAY_INPUT_DIR 아래 상대 경로
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

loop는 cycle별 `event_id` suffix와 전역 증가 `offset`을 보장한다. burst 세 필드는 함께 지정해야 하며, loop 중 매 `burstIntervalSeconds`마다 `burstMinMessages`~`burstMaxMessages`의 랜덤 건수를 한 burst로 전송한다. `DELETE`는 SIGTERM을 보내 현재 send batch를 마친 뒤 연결을 닫도록 요청하며, 응답은 `running`, `pid`, `sentMessages`, `completedCycles`, bounded `logs`를 반환한다.

Continuous runtime operations:

```text
GET  /api/etl/jobs/{jobId}/continuous/logs?tail=200
GET  /api/etl/jobs/{jobId}/continuous/quarantine?limit=100
GET  /api/etl/jobs/{jobId}/continuous/maintenance-runs
POST /api/etl/jobs/{jobId}/continuous/quarantine/replays
POST /api/etl/jobs/{jobId}/continuous/compactions
```

`continuousRuntime` additionally exposes `maxPartitionLag`, `laggingPartitionCount`, `lagAvailable`, `partitionProgress`, `lastBatchDurationMs`, `lastBatchInputRows`, `throughputRowsPerSecond`, `replayedCount`, `schemaVersion`, `schemaFingerprint`, `schemaStatus`, and `schemaChanges`. `replayedCount` prevents recovered quarantine rows from being double-counted: `storedCount + quarantinedCount - replayedCount = consumedCount`. Worker logs are limited to 1,000 lines, ANSI-stripped, and redact common key/token/password assignments.

Quarantine replay accepts optional `offsets` values in `partition:offset` form and `approveUnknownFields` (default `false`). It reads only `_SUCCESS` batch paths, reapplies the Job's current schema evolution policy, anti-joins target Kafka offsets, and appends recovered rows under the same `batch_id=replay_<runId>` partition layout. `approveUnknownFields: true` requires Job `manage` permission, relaxes only unknown-field handling, and records an audit event plus `policyOverride`. It never rewinds the Kafka consumer group. Compaction accepts `targetFileSizeMb` from 128 to 512, calculates partitions from completed Parquet bytes, and writes a run-specific staged result without deleting source batches. Quarantine inspection/replay and compaction serialize on the runtime row, require an idle worker, and return `409` while another maintenance run is active. Each persisted run has a lease (`ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS`, default 900); expiry marks it failed and removes its named Docker container.

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

### SqlResultDraft

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
  validationKey?: string;
};
```

## 7. P0 API

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

- 서버는 `S3_ALLOWED_BUCKETS` allowlist를 우선 사용합니다.
- allowlist가 없으면 local demo 기본값으로 `asklake-output`을 반환할 수 있습니다.
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
  validation: Array<{ label: string; status: "ready" | "warning"; value: string }>;
  canCreate: boolean;
};
```

- `targetDatabase`, `targetDescription`은 Review 표시용으로 create/review request에 함께 보냅니다.
- live mode는 source connector 결과를 재확인하고, mock mode는 동일한 response shape를 fixture로 반환합니다.
- Review UI는 local draft를 직접 조합하지 않고 이 response를 표시합니다.

### 7.3 작업 목록 조회

`GET /api/etl/jobs`

작업 현황의 상태 버튼과 `실행 주기` 컬럼 필터는 이 endpoint를 사용한다. 목록을 프론트엔드에서 임의로 잘라내지 않고, live mode에서는 선택한 조건을 query parameter로 서버에 전달한다.

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

각 `JobRowData`는 DB timestamp 기준의 optional `createdAt`, `updatedAt`을 포함한다. 목록 소유자 셀은 `updatedAt`을 우선 표시하고, legacy row처럼 수정 시각이 없을 때만 `createdAt`을 표시한다.

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

type CreatePipelineRequest = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  transformSteps: Array<{
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
    enabled: boolean;
    failureAction: "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";
    id: string;
    kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
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

`permissionSummary`, `permissionRoles`, `permissionGrants`, `owner`, `createdBy`, `createdByProfile`은 현재 생성 결과를 설명하고 표시하기 위한 governance/identity metadata입니다. 이 값만으로 dataset 조회, SQL 실행, job command 권한을 허용하거나 거부하지 않습니다. Backend는 `asklake_session` 쿠키 actor를 우선 사용하고, 세션이 없을 때만 `X-AskLake-User` header 또는 demo actor를 `createdBy` fallback으로 사용할 수 있습니다.

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
- Catalog Dataset은 비동기 command 접수 응답에서 추가하지 않습니다. Airflow의 `publish_run_result`가 Catalog reconciliation까지 성공한 뒤 frontend polling이 terminal success를 관찰하면 Catalog 목록을 재조회해 추가합니다.
- 생성 성공 감사 로그를 남깁니다.
- mock mode에서는 생성된 pipeline dataset을 `window.localStorage["asklake.catalogDatasets"]`에 저장하고 앱 로드시 mock catalog dataset 앞에 병합합니다.
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
- Target metadata는 flat create contract를 유지하기 위해 `targetDescription`, `targetTags`, `partitionColumns`, `indexColumns`로 전달합니다. 기존 `partition`은 하위 호환용 표시/저장 문자열이며 `partitionColumns.join("/")` 값과 같아야 합니다.
- 현재 Target 화면에서는 layer 선택 버튼을 노출하지 않고 기존 draft/default `targetLayer` 값을 사용합니다.
- `rag`는 호환 필드로 유지하지만, 현재 Target 화면에서는 설정을 노출하지 않고 frontend는 기본값 `false`를 전송합니다.
- 현재 Target 화면은 저장소 선택 화면이 아니라 최종 dataset 저장 명세 화면입니다. `data` JSON 단일 컬럼 sample은 frontend에서 dot-path 컬럼으로 펼쳐 `schemaRules`와 preview를 구성하고, 원본 보존용 `raw_data`는 optional 미사용 컬럼으로 둡니다.
- 현재 Target 화면의 파티션은 실제 사용 컬럼 중 partition 가능한 컬럼을 checkbox로 여러 개 선택하며, 선택 순서를 유지해 `/`로 연결한 뒤 create request의 `partition`에 반영합니다. 예: `event_date/region`.
- backend는 `partition` 문자열을 ETL job metadata에 보존하고 Spark 실행 시 컬럼 목록으로 복원해 Parquet writer의 `partitionBy`에 전달합니다. 선택 컬럼이 Spark output schema에 없으면 실행을 실패 처리합니다.
- Spark run 성공 후 생성되는 `CatalogDataset`에는 `description`, `tags`, `partition`, `partitionColumns`, `indexColumns`가 create request의 Target metadata와 일치하게 저장되어야 합니다. 값이 없으면 backend는 기존 기본 description/tag fallback을 사용할 수 있습니다.
- backend API가 없는 Target 설정 config 저장은 frontend local fallback으로 `window.localStorage["asklake.targetConfigDraft"]`에 `{ metadata, tags, partitionColumns, indexColumns, schemaRules, previewRows, lineage, lastTestRun }` 형태를 저장합니다. 이 config는 create request contract를 대체하지 않고 화면 재확인/debug 용도입니다.
- 같은 `targetDataset`이 이미 존재하면 기본 정책은 `409 CONFLICT`가 아니라 기존 Job/dataset 연결을 재사용해 append 대상으로 갱신하는 것입니다. 같은 dataset 이름의 결과가 새 Catalog row를 만들지 않도록 합니다.

### 7.5 파이프라인 수정

`PATCH /api/etl/jobs/{jobId}`

프론트 함수:

- `updatePipelineDraft(jobId, draftPipeline)`

Request는 `CreatePipelineRequest`에서 `id`, `sourceConfig`, `sourceLabel`, `sourceType`, `createdBy`, `createdByProfile`, `permissionGrants`를 제외한 `UpdatePipelineRequest`다. source field가 body에 포함되면 `422` validation error로 거부한다.

Response `200 OK`:

```ts
type UpdatePipelineResponse = JobRowData;
```

Rules:

- `manage` 권한이 필요하다.
- `running` Job은 `409 CONFLICT`로 수정할 수 없다.
- 성공 Run이 하나라도 있으면 `targetDataset`, `targetDatabase`, `targetLayer`, `targetFormat`, `storageType`, `storagePath` 변경을 `422`로 차단한다.
- source config와 Kafka consumer group offset, `kafka_snapshots` row는 update 대상이 아니다.
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

이 endpoint는 브라우저용 API가 아니다. FastAPI는 path `runId`, body `jobId`, 저장된 `etl_runs.airflow_dag_run_id`가 모두 일치하는지 확인한 뒤 PySpark를 실행한다. 성공한 manifest가 이미 `taskStates.sparkResult`에 있으면 같은 Airflow task retry는 물리 출력을 다시 만들지 않고 기존 manifest를 반환한다.

Spark manifest에는 `status`, `runId`, `startedAt`, `endedAt`, `durationMs`, `inputRows`, `outputRows`, `outputPath`, `schema`, `quality`, `failedStage`, `error`가 포함될 수 있다. Phase 2는 이 manifest와 물리 Parquet까지 저장하지만 Catalog materialization/lineage 갱신은 수행하지 않는다.

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
- Spark `outputPath` 아래의 실제 Parquet object

Catalog mapping:

| Catalog 값 | source |
| --- | --- |
| dataset id | `job.datasetId` |
| `materializationRuns[].runId` | `sparkResult.runId` |
| `materializationRuns[].jobId` | 저장된 Job id |
| `rowCount` | `sparkResult.outputRows` |
| `createdAt` | `sparkResult.endedAt` |
| `storageLocation` | `sparkResult.outputPath` |
| `storageSizeBytes` | S3A prefix 또는 local output path의 실제 file byte 합계 |
| `schema` | `sparkResult.schema` |
| `quality` | `sparkResult.quality` |
| `lineageGraph` | source -> Spark Job -> target dataset |

S3A output은 정확한 bucket/prefix를 list해 Parquet object가 하나 이상 있는지 확인하고 byte를 합산한다. local output은 directory를 재귀 확인한다. 물리 output을 확인할 수 없으면 size를 `0`으로 성공 저장하지 않고 reconciliation을 실패시킨다. Catalog `sampleRows`는 Spark가 제공한 제한된 transformed output sample을 사용할 수 있으며, 그런 sample이 없으면 빈 배열을 사용한다. schema나 값이 달라질 수 있는 pre-transform source sample을 output sample로 가장해서는 안 된다.

Catalog dataset upsert와 `taskStates.catalogResult` 성공 기록은 같은 PostgreSQL transaction으로 확정한다. `catalogResult`는 최소한 `status`, `runId`, `datasetId`, `reconciledAt`을 포함한다. 같은 `runId`가 다시 들어오면 기존 materialization을 교체해 하나만 유지하고, 다른 Run은 같은 dataset row에 append한다. append read-modify-write 동안 target dataset row를 lock해 동시 실행의 history 손실을 막는다. dataset이 아직 없을 때의 동시 create는 id/name unique constraint로 한 row만 허용하고, 충돌한 호출은 그 row를 다시 읽어 같은 run-keyed update를 적용한다. Airflow state sync가 Task Instance snapshot을 다시 만들 때도 `sparkResult`와 `catalogResult`를 모두 보존해야 한다.

Failure contract:

- 성공 Spark manifest가 없거나 아직 저장되지 않았으면 `409 SPARK_RESULT_NOT_READY`
- Job/Run/Airflow identity가 다르면 `409 AIRFLOW_RUN_MISMATCH`
- physical output 검증 또는 Catalog transaction이 실패하면 `500 CATALOG_RECONCILIATION_FAILED`
- 실패 시 Catalog partial update는 rollback한다. Parquet와 성공 `sparkResult`는 삭제하지 않는다.
- rollback 후 같은 Run에 `taskStates.catalogResult={ status: "failed", ... }`와 compact error를 별도 저장해 원인을 관찰할 수 있게 한다.
- `publish_run_result`는 endpoint 실패를 Airflow task 실패로 전파한다. 따라서 Airflow DAG Run과 AskLake Run은 성공으로 표시되지 않으며 failed stage는 `Catalog reconciliation`이다.
- `publish_run_result`는 30초 간격으로 최대 2회 재시도하며, 같은 DAG Run의 성공 `sparkResult`를 재사용해 Catalog만 최대 3회 시도하고 Spark output을 다시 만들지 않는다.
- Catalog commit 뒤 HTTP response만 유실된 경우 retry는 저장된 성공 `catalogResult`와 동일 `runId` materialization을 읽어 같은 success response를 반환한다.

최종 상태 규칙은 `spark_process_write success + Catalog transaction success = publish_run_result success = Airflow DAG Run success = AskLake Run success`다. Phase 3 FastAPI Catalog endpoint와 transaction, 실제 Spark mode의 `publish_run_result` 호출 연결은 구현됐고 실제 Airflow/Spark/MinIO/Catalog 성공 및 Spark 실패 경로를 검증했다. polling sync는 Airflow 상태 조회 뒤 Run row를 다시 읽고 lock한 다음 task snapshot을 저장해, 동시에 commit된 `sparkResult`/`catalogResult`를 잃지 않는다. 명시적인 failed `catalogResult`는 Airflow success보다 우선해 AskLake Run을 실패로 유지하며, 성공 `catalogResult` 또는 같은 Run의 성공 materialization이 없으면 Spark 행 수·경로만으로 성공 처리하지 않는다. 독립 DAG import/status 검증용 `executionMode=smoke`만 물리 Catalog 호출을 건너뛴다. frontend는 동일 Run id를 queued/running으로 관찰한 뒤 success가 됐을 때만 `GET /api/catalog/datasets`를 한 번 호출한다. 낙관적 실행 직후 서버가 돌려준 이전 성공 Run은 refresh trigger가 아니다. 재조회 실패는 성공 Run을 rollback하지 않고 기존 Catalog 화면을 유지하며 수동 새로고침 안내를 표시한다.

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

`run`과 `retry`는 Airflow DAG Run을 제출한 뒤 non-terminal `job`/`run`을 즉시 응답한다. Airflow `spark_process_write` task는 `POST /api/internal/airflow/spark-runs/{runId}/execute`를 호출해 실제 input/output row count와 output path를 Run의 `sparkResult`에 저장한다. 다음 `publish_run_result` task가 `POST /api/internal/airflow/spark-runs/{runId}/catalog`를 호출해 물리 Parquet를 검증하고 Catalog dataset/materialization을 transaction으로 확정한다. 프론트는 `GET /api/etl/jobs/{jobId}`를 polling해 최종 `scheduled` 또는 `failed` 상태와 `runHistory`, `dagSteps`를 다시 반영한다.

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

실행 중인 job은 최신 `status`, `runHistory`, `dagSteps`를 포함한다. `run`/`retry` 완료 polling은 이 endpoint를 사용한다.

### 7.7 읽기 전용 SQL 실행

`POST /api/query/runs`

프론트 함수:

- `executeQueryPreview(dataset, query, { limit, validationKey })`
- `executeQueryDraft(dataset, query)`는 기존 화면 연결을 위한 호환 wrapper로 유지

Request:

```ts
type ExecuteQueryRequest = {
  baseDatasetId?: string;
  datasetId: string;
  mode?: "preview" | "run";
  limit?: number;
  query: string;
  referenceDatasetIds?: string[];
  validationKey?: string;
};
```

Request 예시:

```json
{
  "baseDatasetId": "ds_customer_review_silver",
  "datasetId": "ds_customer_review_silver",
  "mode": "preview",
  "limit": 100,
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver",
  "referenceDatasetIds": ["ds_product_master"],
  "validationKey": "frontend-generated-context-key"
}
```

Response `200 OK`:

```ts
type ExecuteQueryResponse = SqlResultDraft;
```

Response 예시:

```json
{
  "runId": "sql_01J1Z8W2V7KX",
  "baseDatasetId": "ds_customer_review_silver",
  "datasetId": "ds_customer_review_silver",
  "datasetName": "customer_review_silver",
  "query": "SELECT review_id, rating, sentiment FROM customer_review_silver",
  "referenceDatasetIds": ["ds_product_master"],
  "mode": "preview",
  "previewLimit": 100,
  "columns": ["review_id", "rating", "sentiment"],
  "rows": [
    ["10001", "5", "positive"],
    ["10002", "3", "neutral"],
    ["10003", "1", "negative"]
  ],
  "rowCount": 3,
  "executedAt": "2026-07-03T11:35:00.000Z",
  "validationKey": "frontend-generated-context-key"
}
```

Validation:

- `datasetId`, `query`는 필수입니다.
- `mode: "preview"`일 때 백엔드는 원본 SQL을 저장/변경하지 않고 서버 쪽에서 preview row limit을 적용해야 합니다.
- Preview runtime은 선택된 catalog dataset을 DuckDB table context로 등록하고 projection/filter/group/order/limit/JOIN을 실제 SQL로 실행합니다.
- `baseDatasetId`와 `referenceDatasetIds`는 접근 권한 검증과 SQL table context 검증에 사용합니다.
- frontend preflight는 PostgreSQL parser로 `SELECT` 단일 문장, CTE, `FROM`/`JOIN` table context를 검사합니다. backend는 같은 기준을 서버에서 다시 검증해야 합니다.
- 선택 테이블 UI 변경은 SQL text를 자동 재작성하지 않습니다. SQL이 `baseDatasetId`/`referenceDatasetIds`에 포함되지 않은 table을 참조하면 preview 전 검증에서 실패해야 합니다.
- live backend는 DuckDB in-memory connection을 query runtime으로 사용합니다. 선택된 Catalog dataset과 `referenceDatasetIds` dataset을 DuckDB table/view로 등록한 뒤 projection, filter, order, limit, selected-context JOIN을 실행합니다.
- Catalog payload에 로컬 `storageLocation`과 `storageFormat`(`jsonl`, `parquet`)이 있으면 DuckDB가 해당 물리 파일을 우선 읽고, 파일이 없거나 읽을 수 없으면 `schema`/`sampleRows` 기반 임시 table로 fallback합니다.
- 한국어, 공백, 특수문자가 포함된 dataset/column 표시명은 금지하지 않습니다. frontend가 기본 쿼리, 자동완성, 컬럼 삽입, JOIN 초안을 만들 때 SQL text에는 double-quoted identifier(`"월별 매출 데이터"`, `"주문 ID"`)를 사용해야 합니다. 사용자가 따옴표 없이 한글/공백 table reference를 직접 입력한 경우 frontend preflight는 실행 전에 감지하고 quoted identifier 자동 보정을 제안합니다.
- DuckDB preview와 향후 Trino full run 모두 같은 quoted identifier 정책을 따른다. 실행 context 검증은 quoted 표시명만이 아니라 `baseDatasetId`와 `referenceDatasetIds`로 선택된 dataset 범위를 기준으로 재검증합니다.
- 읽기 전용 SQL만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 `403 FORBIDDEN` 또는 `422 VALIDATION_ERROR`를 권장합니다.
- SQL 문법 오류는 `422 SQL_SYNTAX_ERROR`.
- 결과 row는 데모 단계에서 최대 500행 이하를 권장합니다.

프론트 기대 동작:

- `columns`, `rows`를 SQL 결과 테이블에 표시합니다.
- 대시보드 생성 시 같은 `SqlResultDraft`를 전달합니다.
- 실패 시 `analysis.query.preview_failed` 감사 로그를 남깁니다.

#### 7.7.1 SQL 실행 snapshot 조회

`GET /api/query/runs/{runId}`

Response `200 OK`:

```ts
type GetQueryRunResponse = SqlResultDraft;
```

Validation:

- 존재하지 않는 `runId`는 `404 NOT_FOUND`.
- 응답은 `POST /api/query/runs`가 저장한 SQL Preview snapshot과 같은 shape를 반환합니다.

프론트 기대 동작:

- SQL 결과 기반 dashboard route가 직접 열리거나 새로고침되어 메모리의 `SqlResultDraft`가 없으면 이 endpoint로 snapshot을 복구합니다.
- 복구에 실패하면 일반 dashboard로 fallback하지 않고 SQL 분석에서 Preview를 다시 실행하라는 안내를 표시합니다.

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
  selectedDatasetIds: string[];
  selectedDatasets?: Array<{
    id: string;
    name: string;
    description: string;
    layer: string;
    schema: Array<[name: string, type: string]>;
  }>;
};
```

Request 예시:

```json
{
  "baseDatasetId": "ds_orders_clean",
  "currentQuery": "SELECT order_id, customer_id FROM orders_clean LIMIT 100;",
  "mode": "draft_sql",
  "prompt": "고객별 주문과 클릭 이벤트를 조인해서 보고 싶다",
  "selectedDatasetIds": ["ds_orders_clean", "ds_clickstream_events"],
  "selectedDatasets": [
    {
      "id": "ds_orders_clean",
      "name": "orders_clean",
      "description": "전체 채널 통합 고객 주문 정제 데이터",
      "layer": "GOLD",
      "schema": [["order_id", "string"], ["customer_id", "string"], ["total_amount", "decimal"]]
    },
    {
      "id": "ds_clickstream_events",
      "name": "clickstream_events",
      "description": "웹/모바일 앱 실시간 클릭 스트림 이벤트",
      "layer": "SILVER",
      "schema": [["event_id", "string"], ["user_id", "string"], ["event_time", "timestamp"]]
    }
  ]
}
```

Response `200 OK`:

```ts
type QueryAiSuggestionResponse = {
  body: string;
  mode: "draft_sql";
  model?: string | null;
  notices: string[];
  sql: string;
  title: string;
};
```

Response 예시:

```json
{
  "body": "orders_clean에서 customer_id별 total_amount 합계를 조회하는 읽기 전용 SQL 초안입니다.",
  "mode": "draft_sql",
  "model": "gpt-4.1-mini",
  "notices": [
    "AI가 생성한 초안입니다. 실행 전 기존 점검 결과를 확인해 주세요."
  ],
  "sql": "SELECT customer_id, SUM(total_amount) AS total_amount_sum\nFROM orders_clean\nGROUP BY customer_id\nORDER BY total_amount_sum DESC\nLIMIT 100;",
  "title": "고객별 주문 금액 SQL 초안"
}
```

Validation:

- `prompt`와 최소 1개 이상의 `selectedDatasetIds`가 필수입니다.
- frontend는 사용자가 선택한 모든 dataset metadata를 `selectedDatasets`로 함께 전달합니다.
- backend는 `OPENAI_API_KEY`를 서버 env에서만 읽고 브라우저에 노출하지 않습니다.
- AI 응답 SQL도 backend에서 read-only guard를 다시 통과해야 합니다.
- AI 응답 SQL은 선택된 dataset context 밖의 table을 참조하면 `422 VALIDATION_ERROR`로 실패해야 합니다.
- 선택된 dataset 중 하나라도 현재 actor에게 `query` 권한이 없으면 dataset metadata를 AI context로 보내기 전에 `403 FORBIDDEN`을 반환합니다.
- 선택된 reference dataset이 있으면 Query AI는 선택 dataset context 안에서 JOIN SQL 초안을 만들 수 있습니다.
- frontend는 live 응답이 선택 reference JOIN을 포함하지 않는 경우 동일한 선택 metadata로 JOIN SQL 초안 fallback을 적용할 수 있습니다.
- `SELECT` 또는 `WITH ... SELECT` 기반 단일 statement만 허용합니다.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE` 등 변경 쿼리는 허용하지 않습니다.
- AI 응답이 `LIMIT`을 생략하거나 100을 초과하면 backend가 preview 기준 `LIMIT 100`으로 보정한 뒤 검증합니다.
- OpenAI 호출 실패는 공통 error envelope로 반환하고, 프론트는 기존 Query AI 오류 문구를 표시합니다.

프론트 기대 동작:

- Query AI 제안은 자동 실행하지 않고 SQL editor 적용 버튼을 통해서만 반영합니다.
- editor에 반영된 SQL은 기존 preflight와 `POST /api/query/runs` 검증을 다시 통과해야 실행됩니다.
- mock mode에서는 같은 request shape를 유지하면서 프론트 로컬 SQL 초안 fallback을 사용합니다.

### 7.9 SQL 결과 기반 Lake Dataset 생성

`POST /api/catalog/derived-datasets`

프론트 함수:

- `createDerivedDatasetFromSql({ request, sourceDataset, sqlResult })`
- 현재 SQL 화면의 `처리 Job 생성` UI는 `prepareSqlDatasetJobDraft(request)`로 같은 metadata를 ETL `DraftPipeline`에 주입한 뒤 Review 화면에서 `POST /api/etl/jobs`를 호출한다.

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
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  sourceDatasetId: string;
  sourceRunId: string;
  validationKey?: string;
};
```

Request 예시:

```json
{
  "dataset": {
    "description": "일별 매출 SQL Preview 결과로 생성한 분석 데이터셋",
    "layer": "GOLD",
    "name": "sales_daily_summary_analysis",
    "rag": true,
    "refreshPolicy": "manual",
    "tags": ["#sql-derived", "#sales", "#dw"]
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

- SQL 화면의 기본 materialize UX는 생성 대상 이름/설명/태그/레이어/RAG 여부와 `sourceRunId`, `query`, `referenceDatasetIds`를 보존한 ETL Review draft를 만든다.
- Review에서 `파이프라인 생성`을 누르면 기존 `POST /api/etl/jobs` 경로로 처리 Job이 생성되고, 실행 성공 후 Catalog dataset 등록 흐름을 따른다.
- 생성된 dataset을 Catalog 목록 맨 앞에 추가합니다. SQL 작성 화면이 리셋되지 않도록 현재 선택 dataset은 유지할 수 있습니다.
- 저장 화면에서 입력한 `name`, `description`, `tags`, `layer`, `rag` 값을 생성된 `CatalogDataset` metadata에 반영합니다.
- mock mode에서는 생성된 derived dataset을 pipeline 생성 dataset과 같은 `window.localStorage["asklake.catalogDatasets"]`에 저장하고, 앱 로드시 mock catalog dataset 앞에 병합합니다. 기존 `asklake.derivedDatasets`는 읽기 호환만 유지합니다.
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
- 비동기 `POST /api/etl/jobs/{jobId}/commands` 응답은 Catalog dataset을 포함하지 않습니다. frontend polling이 `publish_run_result`까지 끝난 terminal success를 처음 관찰한 시점에 `GET /api/catalog/datasets`를 다시 호출해 dataset과 append history를 반영합니다.
- Spark run 결과 dataset과 SQL derived dataset은 모두 `catalog_datasets.payload`를 Catalog API의 source of truth로 저장합니다. 기존 컬럼 기반 row는 읽기 호환 fallback으로만 사용합니다.
- Spark run 결과 dataset과 SQL derived dataset은 모두 `size`를 표시용 저장 크기로 내려주고, 물리 위치/포맷/byte 크기는 `storageLocation`, `storageFormat`, `storageSizeBytes`에 담습니다.
- Spark run 결과 dataset과 SQL derived dataset은 같은 `dataset.id`에 대해 `materializationRuns`를 idempotent하게 append합니다. 같은 `runId`가 다시 처리되면 기존 항목을 교체하고 중복 추가하지 않습니다.
- Spark run 결과 dataset은 source -> Spark job -> target 기본 `lineageGraph`를 payload에 저장합니다. SQL derived dataset은 source dataset lineage를 이어받아 source -> derived column edge를 저장합니다.
- SQL derived dataset 생성은 `CatalogService`와 `CatalogRepository.saveDatasetPayload` 경로만 사용합니다. ETL service는 pipeline/job/run 생성과 Spark 결과 dataset 저장만 소유합니다.
- mock mode에서는 pipeline 생성 dataset과 SQL derived dataset이 같은 stored catalog dataset fallback(`asklake.catalogDatasets`)을 사용합니다.

### 8.2 데이터셋 상세

`GET /api/catalog/datasets/{datasetId}`

Response `200 OK`:

```ts
type DatasetDetailResponse = CatalogDataset;
```

추가 상세 API를 분리할 경우 권장 endpoint:

```text
GET /api/catalog/datasets/{datasetId}/schema
GET /api/catalog/datasets/{datasetId}/sample-rows
GET /api/catalog/datasets/{datasetId}/lineage
```

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
Lineage API나 `lineageGraph` fixture가 없으면 mock adapter가 `CatalogDataset.upstream`으로 fallback graph를 생성합니다.

### 8.3 데이터셋 append 결과 삭제

`DELETE /api/catalog/datasets/{datasetId}/materialization-runs/{runId}`

이 API는 dataset 전체를 삭제하지 않고, dataset 안의 특정 append/materialize 결과 metadata만 제거합니다. 현재 범위에서는 물리 lake 파일 삭제나 compaction을 수행하지 않습니다.

Response `200 OK`:

```ts
type DeleteMaterializationRunResponse = {
  deletedRunId: string;
  dataset: CatalogDataset;
};
```

서버는 삭제 후 남아 있는 성공 `materializationRuns` 기준으로 부모 dataset의 `rows`, `size`, `storageSizeBytes`, `lastUpdated`, `sourceRunId`를 재계산합니다. 마지막 append 결과까지 삭제되면 dataset shell은 남고 합산 값은 `0 rows`, `0B`가 됩니다. 전체 dataset 삭제는 별도 API/UX로 분리합니다.

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
    queryId?: string | null;
    datasetId?: string | null;
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

`GET /api/dashboards/{dashboardId}/published`

Response `200 OK`:

- published revision이 있으면 해당 revision의 pages/widgets를 반환합니다.
- published revision이 없으면 `revision: null`, `pages: []`, `widgetsByPageId: {}`로 정상 응답합니다.

실패:

- dashboard가 없으면 `404 NOT_FOUND`.
- dashboard `view` 권한이 없으면 `403 FORBIDDEN`.

#### 8.5.2 Draft 조회/생성

`POST /api/dashboards/{dashboardId}/draft/ensure`

동작:

1. draft revision이 있으면 그대로 반환합니다.
2. draft가 없고 published revision이 있으면 published revision을 복사해 draft를 만듭니다.
3. 둘 다 없으면 빈 draft revision과 기본 page 1개를 만듭니다.

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
3. 남은 page의 `orderIndex`를 다시 정렬합니다.

Response `200 OK`:

```json
{ "ok": true }
```

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

`data`는 optional입니다. 호출자가 `data`를 명시하지 않고 `datasetId`를 보내면 서버는 catalog dataset의 rows 또는 sample rows를 찾아 `Array<Record<string, unknown>>` 형태로 변환한 뒤 widget `data` snapshot으로 저장합니다.
현재 FastAPI backend는 `catalog_datasets.payload.sampleRows`와 `schema`를 우선 사용하고, 오래된 demo dataset id에 대해서만 demo catalog fallback을 사용해 column name 기반 object row를 만듭니다.
예를 들어 `sampleRows: [["2026-01", "KR", "FastShip", "4200000"]]`, `schema: [["month", "date"], ["region", "string"], ["carrier", "string"], ["transport_cost", "decimal"]]`는 `[{ "month": "2026-01", "region": "KR", "carrier": "FastShip", "transport_cost": 4200000 }]`로 저장됩니다.

Response `201 Created`:

```json
{ "id": "dashwidget_..." }
```

서버는 `type`을 runtime widget enum으로 정규화하고, layout이 없으면 widget type별 기본 layout을 적용합니다.
기존 기본 위젯 추가 흐름을 위해 `datasetId`와 `config`는 optional이지만, 데이터셋 기반 위젯 생성 UI와 API는 `type`별 config 계약을 사용합니다. 색상 계약은 문자열이나 팔레트 이름이 아니라 `color: { colors: string[] }` 객체입니다. `metric`과 `table`은 색상 설정을 보내지 않습니다. 단일 색상 차트는 `colors`에 1개 색상을 보내고, 도넛/파이/트리맵처럼 여러 요소 색상이 필요한 차트는 요소 순서대로 여러 색상을 보냅니다. `metric`은 `valueKey`, `aggregation`, optional `format`; `table`은 `columns`, optional `limit`, optional `sortKey`, optional `sortDirection`; `bar_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `groupKey`, optional `orientation`; `line_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `dateUnit`, optional `seriesKey`, optional `curve`; `area_chart`는 `xKey`, `yKey`, `aggregation`, `color`, optional `dateUnit`, optional `seriesKey`, optional `stacked`; `donut_chart`와 `pie_chart`는 `labelKey`, `valueKey`, `aggregation`, `color`; `radial_bar_chart`는 `valueKey`, `aggregation`, `color`, optional `labelKey`, optional `min`, optional `max`, optional `format`; `heatmap_chart`는 `xKey`, `yKey`, `valueKey`, `aggregation`, `color`; `treemap_chart`는 `labelKey`, `valueKey`, `aggregation`, `color`를 보냅니다. 향후 AI widget 생성 기능은 이 type/config 계약을 그대로 재사용합니다.
생성 후 draft runtime 조회 응답의 widget에는 `datasetId`, `config`, `data`가 유지되어야 합니다.
dataset을 찾지 못하거나 rows/sample rows가 없으면 서버는 기존 생성 흐름을 깨지 않고 `data: []` fallback을 저장합니다.

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
{ "id": "dashwidget_..." }
```

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

### 8.5.11 Dashboard Assistant UI Hook

대시보드 draft editor의 AskLake 보조 패널과 `placeholderKind: "visualization_request"` 위젯은 `POST /api/dashboards/assistant` FastAPI endpoint를 통해 OpenAI 기반 응답을 요청한다.
이 endpoint는 `OPENAI_API_KEY`가 설정되어 있고 `OPENAI_ASSISTANT_ENABLED=true`이면 OpenAI Responses API를 호출한다.
서버는 `dashboardId`/`pageId`를 기준으로 DB에서 draft revision을 우선 조회하고, 없으면 published revision을 조회한다.
그 다음 현재 page widget, 대시보드에서 사용할 수 있는 available catalog dataset, 지원 가능한 widget type/config option을 OpenAI 컨텍스트로 전달한다.
단, `selectedWidgetId` 또는 `widgetId`가 있으면 해당 위젯 하나만 context/수정 후보로 제한한다.
OpenAI 응답은 backend guard를 통과해야 하며, 없는 datasetId, 없는 widgetId, 없는 column, 지원하지 않는 widget type/config field는 action에서 제외하고 `warnings`에 이유를 담는다.
OpenAI 설정이 없거나 호출이 실패하면 응답 `message`/`warnings`에 `mock fallback`을 명시한 fallback 응답을 반환한다.
프론트는 `VITE_DASHBOARD_ASSISTANT_API_PATH`가 비어 있으면 기본 경로 `/api/dashboards/assistant`로 `POST` 요청을 보낸다.
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
`widgets`는 현재 등록된 위젯의 title/type/datasetId/config/layout 및 최대 5개 샘플 row를 포함한다.
단, `dashboardId`가 있으면 backend DB runtime 컨텍스트가 우선이며 `widgets`는 구버전/테스트 호환 fallback payload로 사용한다.
`selectedWidgetId` 또는 `widgetId`가 있으면 서버는 해당 위젯만 `update_widget` 대상에 포함한다.

Response:

```ts
type DashboardAssistantResponse = {
  message: string;
  actions: Array<
    | {
        type: "create_widget";
        widget: {
          title: string;
          type: DashboardRuntimeWidgetType;
          datasetId: string;
          config: DashboardRuntimeWidgetConfig;
        };
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
      }
    | {
        type: "report";
        markdown: string;
      }
  >;
  warnings: string[];
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
- `configPatch` 또는 `widgetPatch.config`는 현재 시각화 요청 위젯의 기존 config에 병합한다.
- `widgetPatch.title`, `widgetPatch.type`, `widgetPatch.datasetId`는 시각화 요청 위젯을 실제 차트로 변환할 때 자동 적용한다.
- `warnings`에 `mock fallback`이 포함되면 OpenAI 실제 응답이 아니라 서버 fallback 응답으로 봐야 한다.

Assistant guard는 OpenAI 응답을 그대로 신뢰하지 않고 catalog schema/sample rows 기준으로 검증한다. 없는 컬럼은 alias로 보정하고, 차원 컬럼만 제시된 막대/선/면 차트 요청은 `count` 집계로 보정한다. 그래도 적용 가능한 action이 없으면 `visualization_request`에 한해 요청 문장과 available dataset 기준의 기본 막대 차트 action을 생성할 수 있다.

## 9. P2 API

### 9.1 인증 세션

`POST /api/auth/login`

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
- `resourceType?: "etl_job" | "dataset" | "dashboard" | "ai_module" | "admin_module" | "ui" | "auth" | "user" | "group"`.
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
  target_type: "etl_job" | "dataset" | "dashboard" | "ai_module" | "admin_module" | "ui" | "auth" | "user" | "group";
};
```

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

1. mock mode에서 backend 없이 Source/Schema 연결 테스트, 생성 플로우, Catalog/SQL 화면이 깨지지 않는지 확인합니다.
2. 백엔드 서버를 실행합니다.
3. `frontend/.env`에 `VITE_API_BASE_URL`과 `VITE_USE_MOCK_API=false`를 설정합니다.
4. 프론트 dev 서버를 재시작합니다.
5. `POST /api/etl/sources/test` Source/Schema live 연결 흐름을 확인합니다.
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
