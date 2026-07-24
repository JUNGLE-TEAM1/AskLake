# System Guardrails

> 2026-07-20 제품 결정: RAG/OpenSearch/embedding worker는 폐기했다. 배포 Compose는 해당 service·secret·health dependency를 포함해서는 안 되며, 기존 volume은 별도 승인 없이는 삭제하지 않는다.

- Production keeps `STARTUP_SCHEMA_MANAGEMENT_ENABLED=false`; API and worker repositories must not run schema DDL at request time. Metadata schema changes are applied by the explicit deployment migration before services start.

AI service guardrails, secret isolation, private Compose networking, and deployment health checks are defined in [ai-gateway-mcp-rollout.md](./ai-gateway-mcp-rollout.md).

이 문서는 하네스가 직접 강제하지 않고 GitHub, CI, repository settings, platform, 또는 repo-local automation이 강제하거나 감지해야 하는 안전장치를 추적한다.

하네스는 작업 상태, 판단 근거, 검증 결과, 복구 경로를 공유하는 협업 프로토콜이다.
기계가 안정적으로 막거나 감지할 수 있는 안전장치는 가능한 한 시스템에 둔다.

## 1) Responsibility Split

| Category | Responsibility |
| --- | --- |
| System Guardrails | 기계가 감지하거나 차단할 수 있고, 어기면 피해가 큰 항목을 실제로 막거나 경고한다. |
| Harness Protocol | 사람이 판단해야 하는 맥락, 작업 범위, 증거, 보류 사유, 복구 경로를 기록한다. |
| Team Agreement | 자동화가 다루기 어려운 리뷰 문화, 책임 귀속 방식, 예외 허용 기준을 합의한다. |

## 2) Guardrail Inventory

`Current Status` 값:

- `enabled`: 현재 repository 또는 workflow에서 실제로 동작한다.
- `partial`: 일부는 동작하지만 hard gate나 coverage가 부족하다.
- `deferred`: 지금은 적용하지 않기로 보류했다.
- `planned`: 구현 후보이며 아직 동작하지 않는다.
- `requires-admin`: repository/project/platform 관리자 설정이 필요하다.
- `unknown`: 현재 상태 확인이 필요하다.

| Guardrail | Enforced By | Current Status | Failure Behavior | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| Frontend UI checks before merge | GitHub Actions workflow running `cd frontend && npm run verify:ui-regressions && npm run build` | `enabled` | block merge when required check is enabled and the workflow fails | maintainer | PR에서 compact workspace header, SQL action/section marker와 방향성 panel toggle, Catalog PROCESS projection, Dashboard panel toggle, Vite build를 함께 확인 |
| Nessie SQL deterministic benchmark | `.github/workflows/nessie-sql-benchmark.yml` and `backend npm run verify:nessie-benchmark` | `enabled` | fixture/schema/repository/runner/comparator drift 또는 고정 baseline 대비 정확성·성능 policy 실패 시 matching PR check 실패 | data-platform | CI는 provider credential과 live Trino 없이 비교기만 재현한다. Live provider campaign과 baseline 승격은 bounded 수동 승인이고 tracked artifact에 SQL·endpoint·row·credential을 저장하지 않는다. |
| Deploy readiness record | `.github/workflows/deploy-readiness.yml` running `scripts/verify-deploy-readiness.sh` | `enabled` | matching PR/manual workflow fails when production Compose render, deploy image build, backend production dependencies, or repository Spark runtime contract fails | maintainer | uses Node 22/Python 3.13 and uploads a JSON release-readiness artifact; never connects to EC2 or injects production secrets |
| Unified deploy source ref | `.github/workflows/eks-image-delivery.yml` + `scripts/verify-eks-image-source-ref.sh` + `scripts/deploy.sh` | `enabled` | EKS `environment=dev` delivery와 EC2 start/deploy/restart는 source branch가 정확히 `dev`가 아니면 실패한다. EC2 deploy는 dirty/untracked remote tree를 거부하고 checkout이 exact `origin/dev`인지 양방향 ancestor로 확인한다. | maintainer | 각 환경 release는 실제 배포한 SHA를 별도 receipt에 고정한다. 배포 시점이 다르면 EKS/EC2 SHA는 다를 수 있다. staging은 explicit ref를 허용하지만 빈 ref는 거부한다. |
| Deploy readiness required check | GitHub repository ruleset | `requires-admin` | block merge only after repository admin marks `Deploy Readiness / deploy-readiness` as required | repo admin | workflow implementation does not change GitHub repository settings |
| Dashboard schema preparation | backend startup plus `backend npm run migrate:dashboard-schema` and `npm run verify:dashboard-storage` | `enabled` | versioned Dashboard schema preparation fails before Dashboard API requests are served; request paths must not issue Dashboard DDL | data-platform | `dashboard_schema_migrations` records Dashboard card/runtime and batch-result-cache versions; a PostgreSQL advisory lock serializes multi-instance startup. This is not a repository-wide Alembic policy. |
| Metadata schema bootstrap | backend startup plus `backend npm run migrate:metadata-schema` and EC2 deploy pre-bootstrap | `enabled` | block application startup/deploy when ETL, Catalog, SQL, Dashboard, Continuous, or Realtime metadata preparation fails | data-platform | repository schema helpers remain idempotent for local/test compatibility, but deployed API and control-plane processes prepare their bind before request or worker loops start. Repository-wide Alembic adoption remains separate. |
| Legacy Dashboard binding schema removal | Alembic `0022_remove_dashboard_job_bindings` + `backend npm run verify:dashboard-job-binding-schema-removal` | `enabled` | populated binding/delivery table 삭제는 명시적 확인 없으면 migration을 중단 | data-platform | 모든 Phase 3 backend/worker replica 교체와 두 table backup 뒤 migration process에만 `ASKLAKE_CONFIRM_DROP_DASHBOARD_JOB_BINDINGS=true`를 설정한다. downgrade는 빈 schema만 복원하므로 row rollback은 backup이 필요하다. |
| Catalog Dataset hard-delete fence | Catalog deletion impact/service/worker + `tests.test_catalog_dataset_deletion` | `enabled` | block on active/dependent resources or unmanaged paths; retain Catalog metadata when physical purge fails; reject late publication for a deletion receipt | data-platform | list action requires explicit name confirmation; only AskLake-managed Iceberg/ClickHouse/local/S3/RAG artifacts are purgeable; audit and completed Run history remain |
| Deployed UI no-reactivation | `frontend npm run test:deployed-ui-boundary` inside `verify:ui-regressions` | `enabled` | compatibility façade를 source가 다시 import하거나 production mock/legacy 기본값이 활성화되면 실패 | analytics-experience | `App.tsx`는 modular Job/workspace module을 직접 사용하며 route·DOM·CSS·API 동작은 유지 |
| Admin audit contract and failure isolation | `Refactor Quality Gates / backend-contracts` running `verify:admin-audit-contract` + `Frontend UI Checks` running `test:admin-console-load` | `enabled` | 신규 writer의 enum-only 계약, `query_run`/레거시 `unknown` HTTP·OpenAPI·frontend type drift, 한 admin endpoint 실패에 따른 section 초기화, stale/race 상태 회귀 시 PR check 실패 | data-platform | EC2 rollout 후 admin session으로 `query_run`/`unknown` 필터 200과 section별 metric을 수동 확인하며 배포 자동화는 이 test가 수행하지 않음 |
| ETL CSS reviewed cascade | `frontend npm run test:css-catalog-boundary` | `enabled` | URL/shared façade 순서, feature CSS hash, 정확한 selector inventory, retired selector 또는 `.s3-tree-panel` declaration 순서가 drift하면 실패 | analytics-experience | 배포 소스 미참조 legacy rule 제거 후 3,108 rule LOC, 429 definitions/409 unique/중복 20개. 남은 반응형 중복은 visual·computed-style evidence 없이 제거 금지 |
| Prod compose config check | `Realtime Quality Gates / realtime-contracts`, `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet`, `backend/scripts/verify-production-spark-contract.mjs`, and Spark runtime path verifiers | `enabled` | matching realtime PR의 config render 실패 또는 배포 전 Spark REST·UID 185 mount·Docker socket 계약 실패 시 중단 | maintainer | GitHub required check 등록은 repo admin 확인 필요. `npm run verify:spark-runtime-paths:container`는 clean mount, owner/mode repair, guard restart와 data 보존을 실제 container에서 확인 |
| Airflow execution-token parity | `scripts/deploy.sh start\|deploy\|restart` + deploy script regression | `enabled` | backend와 Airflow scheduler 컨테이너의 token hash가 다르거나 하나라도 비어 있으면 중단 | data-platform | 배포는 backend/Airflow execution control-plane을 강제 재생성하고 SHA-256 값만 비교한다. shared token 자체는 출력하지 않는다. |
| Refactor release execution gate | `npm run verify:refactor-release-execution` + `docs/refactor-2026/final/release-gates.json` | `enabled` | exit 2 and block production execution until isolated nightly, clean reboot, backup/restore evidence are passed | maintainer | plan validation is read-only; changing a manual gate to passed requires release-record evidence and operator review |
| ETL Job query ownership | `Refactor Quality Gates` + `tests.test_etl_job_queries` | `enabled` | read-only 목록·상태·상세 hydrate/permission/facet 또는 404/403 audit 계약이 바뀌면 실패 | data-platform | `etl_service.list_jobs/list_job_statuses/get_job`은 façade로 유지하고 application module이 조회 정책을 소유 |
| Snapshot Airflow reconciliation owner | `tests.test_snapshot_status_reconciliation` + frontend `test:snapshot-status-polling` | `enabled` | GET에 Airflow/write가 재결합되거나 multi-process 중복 sync, Job별 오류 격리, batch polling·stale/backoff 계약이 바뀌면 실패 | data-platform | backend 5초 loop + PostgreSQL advisory lock이 저장을 소유하고 frontend는 active Job 최대 100개를 한 요청으로 읽음 |
| Retired RAG runtime boundary | production Compose/EKS profile + deploy preflight | `enabled` | `opensearch`, `embedding-worker`, `rag-artifact-cleanup` service가 production render에 다시 나타나면 실패 | data-platform | RAG/OpenSearch/embedding worker와 전용 CI/test/script는 제거했다. 기존 migration·모델·deletion receipt·외부 volume/object는 복구 이력이며 물리 삭제에는 별도 승인이 필요하다. |
| ETL Job delete transaction | `Refactor Quality Gates` + `tests.test_etl_job_commands` + `tests.test_etl_job_delete` | `enabled` | permission보다 workload identity를 먼저 조회하거나 active workload 차단, 종속 삭제 순서, audit·commit/rollback이 바뀌면 실패 | data-platform | `etl_service.delete_job`은 façade로 유지하고 application command가 transaction을 소유 |
| ETL Pipeline write ownership | `Refactor Quality Gates` + `tests.test_etl_job_write_commands` + create/update contract verifiers | `enabled` | new/append/continuous identity, Rule validation, permission, immutable target/runtime/checkpoint 또는 projection 순서가 바뀌면 실패 | data-platform | `etl_service.create_pipeline/update_pipeline`은 façade로 유지하고 application command가 write orchestration을 소유 |
| Airflow finite execution/publication ownership | `Refactor Quality Gates` + `tests.test_airflow_execution_commands` + Airflow/Catalog integration verifier | `enabled` | persisted Run identity, Spark lease claim/finalize, 성공 멱등성, physical verification, Catalog commit/failure evidence 순서가 바뀌면 실패 | data-platform | `etl_service.execute_airflow_spark_run/reconcile_airflow_catalog`은 façade로 유지하고 application command가 transaction 순서를 소유 |
| ETL service module boundary | `tests.test_etl_service_module_boundaries` | `enabled` | façade 2,500줄 또는 추출 모듈 budget 초과, 함수 재정의, 역방향 façade import, re-export/runtime-binding drift 시 실패 | data-platform | 최신 `dev` 8,389줄에서 2,198줄로 축소하고 application projection·policy와 API·snapshot·Airflow·source runtime·Continuous·replay orchestration을 책임 모듈로 분리 |
| Source connector Python/Node ownership | `Refactor Quality Gates` + `tests.test_source_connector_gateway` + source connector verifiers | `enabled` | Python schema boundary 또는 Node script·marker·payload·timeout mapping이 바뀌면 실패 | data-platform | Python application이 use case를, typed gateway 뒤 Node adapter가 기존 connector runtime transport를 소유 |
| EKS·EC2 Continuous control-plane owner | `Refactor Quality Gates / structural-ratchet` + `deploy/control-plane-ownership.json` + `scripts/refactor_audit/control_plane_ownership.py` | `enabled` | required control plane의 active owner 누락·중복, inactive/unknown claim, repository evidence drift 시 실패 | data-platform | 현재 EKS Realtime V1 worker가 Kafka Continuous·Continuous SQL reconciliation을 claim하고 EC2 worker는 rollback standby다. EC2 프로필로 owner를 옮길 때는 EKS fence와 manifest/evidence를 같은 변경에 포함한다. |
| Continuous runtime document storage | `ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX` | required for split API/Spark volumes | EKS/API/worker/Spark가 서로 다른 local filesystem을 볼 때 local report path 사용 금지 | data-platform | private S3 prefix만 허용; command/report/ACK object 권한을 dataset warehouse와 분리 |
| EKS Continuous Spark gateway | `ASKLAKE_CONTINUOUS_SPARK_RUNNER=kubernetes` + Spark Operator RBAC | required when enabling EKS Continuous | mutable image tag, missing runtime S3 prefix, worker role without SparkApplication CRUD, SparkApplication에 JDBC secret 평문 삽입, 또는 제출 preflight 전 기존 application 삭제 금지 | data-platform | image digest, worker `sparkapplications` CRUD, driver/executor S3 access와 `secretKeyRef`를 rollout 전 확인. `desiredState=running`에서 resource가 사라지면 마지막 report 반영 후 동일 fence로 자동 재생성해야 한다. |
| EKS Continuous worker manifest | `deploy/kubernetes/continuous-worker.yaml.template` + `npm run verify:kubernetes-continuous-worker` | required before owner transfer | EC2 owner가 active인 상태에서 EKS template apply 금지 | data-platform | render/dry-run/RBAC 점검은 transfer 승인 전 준비 단계이며 owner 변경 자체는 아님 |
| Production legacy removal evidence | `Refactor Quality Gates / structural-ratchet` + `legacy-removal-evidence.json` | `enabled` | production register와 evidence가 어긋나거나 30일 미만/non-zero 관찰, evidence·승인 없는 제거 가능 상태면 실패 | maintainer | 현재 10경로 모두 관찰 미시작·승인 미요청, eligible 0개. runtime path 삭제·활성화는 하지 않음 |
| Continuous runtime contract | `backend npm run verify:continuous-runtime-contract` | `manual` | block Continuous control-plane changes when transition, revision/fencing, legacy hydration, structured error, or frontend stale-response guards fail | maintainer | CI required check 전환 전까지 Continuous 관련 PR에서 수동 실행. Spark REST의 `UNKNOWN`은 마지막 확정 상태가 terminal일 때만 재시작 후보이며, 제출/실행 중 `UNKNOWN`은 중복 worker를 만들지 않는다. |
| Deployment readiness evidence | [deployment-phase-0-baseline.md](./deployment-phase-0-baseline.md) Phase 0 record | `partial` | Compose health만으로 deploy success를 선언할 수 없음; public JSON health, Spark state, Continuous heartbeat를 분리 확인 | maintainer | Phase 0은 관찰 기준만 기록한다. redirect-aware probe, session heartbeat gate, release record 자동화는 후속 Phase 대상 |
| Runtime schema DDL ownership | `scripts/deploy.sh` start/deploy/restart bootstrap + focused concurrency verification | `enabled` | request 또는 Continuous worker hot path에서 schema preparation DDL이 경쟁하면 release gate 후보로 실패 처리 | data-platform | metadata schema bootstrap은 backend application service 전 start/deploy/restart 경로에서 수행한다. request/worker hot path는 DDL을 소유하지 않는다. |
| Additive migration/bootstrap compatibility | Alembic additive migration regression | `enabled` | metadata bootstrap이 먼저 만든 additive column 때문에 Alembic revision upgrade가 duplicate-column으로 중단되면 배포 중단 | data-platform | PostgreSQL additive migration은 `ADD COLUMN IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`를 사용하고, SQLite migration test는 pre-existing bootstrap column 상태를 재현한다. |
| Deploy public health redirect | `tests/deploy/deploy-scripts-regression.sh` | `enabled` | public HTTP URL이 canonical HTTPS URL로 redirect되는 경우 final frontend/backend/AI health를 확인하고, redirect 미해결 또는 JSON readiness 불일치는 실패 | maintainer | Compose health만으로 public deploy success를 선언하지 않는다. Spark/Continuous runtime readiness는 별도 gate |
| Backend deploy image build | CI/deploy workflow candidate running `docker build -t asklake-backend-deploy-check:local backend` | `planned` | catch Python/package incompatibility before EC2 compose rebuild | maintainer | FastAPI backend uses `python:3.13-slim` and `backend/requirements.txt` |
| EC2 deploy diagnostic record | `scripts/deploy.sh diagnose` and `scripts/write-deploy-diagnostic.py` | `enabled` | record bounded `passed`/`failed`/`skipped` observations and exit non-zero when the deployment is not ready | maintainer | read-only observation only; records no server env, SSH key path, credential, or raw remote log |
| Secret scanning / push protection | GitHub repository setting | `unknown` | block or warn on secret push | repo admin | repository admin 확인 필요 |
| Protected integration branches | GitHub repository ruleset on `main`, `dev`, and `pair` | `enabled` | block direct push or force push; require changes through PR | repo admin | ruleset: `Push 금지` |
| PR source branch policy | GitHub Actions check required by ruleset on `main` and `dev` | `enabled` | block PR merge when source branch does not match the allowed chain or linked issue target | repo admin | `main <- dev`; `dev <- pair1/2/3` 또는 지원 work/`<type>-#<issue>` 브랜치 + linked issue `Target Branch: dev` |
| Current refactor stacked merge order | `Refactor Quality Gates / structural-ratchet` + `stacked-pr-merge-plan.json` | `enabled` | count/order/base/branch/dependency 또는 one-at-a-time·green check·no-deploy 규칙 drift 시 실패 | maintainer | 정확히 10개 PR. 실제 review/merge와 merge 후 next diff 재검증은 수동 gate이며 production execution과 분리 |
| PR merge / Issue lifecycle sync | `.github/workflows/notion-issue-sync.yml` and lifecycle smoke checks | `enabled` | fail before remote mutation when lifecycle contracts break; recover missed merge events on the next scheduled/manual dispatch | maintainer | explicit `Closes/Fixes/Resolves #N` merge closes Issue and sets Project/Notion `Done`; reopen after merge is preserved |
| Default PR and issue templates | GitHub `.github` templates | `enabled` | prompt contributors to document scope, verification, impact, and acceptance criteria | maintainer | advisory template, not a hard gate |
| Deployment env files ignored | `.gitignore`, review checklist | `enabled` | prevent committing server `.env` and local EC2 env values | maintainer | `deploy/.env` and `deploy/ec2.env` are ignored; only examples are committed. MinIO access key/secret and `AIRFLOW_EXECUTION_API_TOKEN` stay in server `.env` or secret storage. The Airflow and backend token values must match. Kafka replay input은 `ASKLAKE_REPLAY_HOST_INPUT_DIR`의 읽기 전용 mount만 사용하며 arbitrary host path API 입력은 금지한다. |
| Production legacy demo auth | backend startup + `scripts/verify-deploy-env.sh` | `enabled` | default production does not seed or reactivate legacy identities; redeploy preserves durable account/session state; explicit demo deployment requires matching backend/frontend opt-in flags | maintainer | paired `true` opt-in은 누락 계정을 만들고 disabled demo 계정을 복구한다. 기본값 false, Bootstrap admin 요구와 production header-auth 차단은 유지한다. |
| Session cookie transport | backend auth tests + `asklake-runtime-config` | `enabled` | production and HTTPS deployments keep `AUTH_SESSION_COOKIE_SECURE=true`; only an explicitly approved HTTP dev ALB may set it to `false` | maintainer | HTTP dev exception is owned by the private `asklake-runtime` values and keeps `HttpOnly`, `SameSite=Lax`, production auth mode, header-auth blocking, and public signup blocking. Restore `true` when HTTPS is available. |
| API contract drift check | repo-local script or review checklist | `planned` | warn or block when API docs and code drift | maintainer | backend 구현 후 후보 |
| Realtime SSE proxy contract | `Realtime Quality Gates / realtime-contracts`, `backend/scripts/verify-realtime-proxy-contract.py`, Caddy/NGINX container parser | `enabled` | buffering·compression·timeout, env 전달 또는 parser drift 시 matching PR check 실패 | maintainer | 실제 ALB heartbeat와 rolling restart는 operator gate |
| Realtime feature rollback | `DASHBOARD_SYNC_MODE`, `REALTIME_EVENTS_ENABLED`, `CONTINUOUS_SQL_JOIN_ENABLED` plus config contract tests | `enabled` | invalid/disabled 조합은 polling과 기존 runtime으로 fail closed; rollout 중 오류 시 env 변경 후 재배포 | maintainer | Production Compose 기본값은 SSE/true이며 polling/false 조합을 즉시 rollback 값으로 유지한다. |
| ClickHouse Kafka Engine V1 rollback | `CLICKHOUSE_CONTINUOUS_JOIN_ENABLED`, `scripts/verify-deploy-env.sh`, focused unit/E2E | `enabled` | V2 owner와 V1 flag가 동시에 켜지면 배포 또는 startup 중단 | data-platform | Production Compose 기본값은 V1 false이며 명시적 rollback generation에서만 단일 owner로 전환한다. |
| ClickHouse Realtime Serving V2 opt-in | backend startup/live probe, `/api/health/realtime`, deploy preflight 62 checks, 57-test V2 release suite·Alembic 0016~0018 lifecycle·실제 Kafka/TLS ClickHouse E2E·PostgreSQL fencing·frontend regression·Compose render | `enabled` | 모순된 owner와 receipt gap/parity mismatch/stale pointer/incomplete cutover gate는 fail closed; 동일 switch retry는 한 epoch/revision/event만 허용 | data-platform | Production Compose 기본 owner는 Spark/Iceberg이며 V2/Kafka Connect는 명시적 profile과 flag가 있을 때만 사용한다. secret·TLS·immutable image와 worker/reader readiness가 없으면 opt-in 배포를 차단한다. |
| Continuous SQL contract | `backend npm run verify:continuous-sql-contract`, execution-tree migration/unit suite, ClickHouse unit/E2E, `npm run verify:realtime-stack`, `Realtime Quality Gates` | `enabled` | unsupported SQL, exact 검증 없는 static key, 중복 refresh claim, malformed Kafka parser contract, stale generation/fence, invalid lifecycle/publication identity면 matching PR check 실패 | maintainer | Dataset-revision Trino refresh는 `CONTINUOUS_SQL_REFRESH_CLAIM_SECONDS` 내 단일 owner만 허용하고 실패 시 마지막 published Gold를 유지한다. Dashboard는 수동 Widget query만 사용한다. 실제 Kafka/Spark/Iceberg fault·restart는 scheduled/manual tier |
| Realtime architecture regression | `backend/scripts/verify-realtime-quality-gates.py` | `enabled` | silent polling interval, direct in-memory event publish, SQL matrix 유실, God-file 신규 결합을 실패 처리 | maintainer | allowlist 없는 `refetchInterval`/`setInterval` 추가 금지 |

## 3) Team Guide

이 섹션은 팀원이 현재 적용된 시스템 룰을 빠르게 이해하기 위한 요약이다.

### What Is Blocked

| Rule | What it means for people |
| --- | --- |
| Direct push to `main` and `dev` | `main`과 `dev` 변경은 직접 push하지 않고 PR로 병합한다. |
| Force push to protected branches | protected branch history rewrite는 차단한다. |
| Invalid PR source branch | `main` PR은 `dev`에서만 병합한다. `dev` PR은 pair 브랜치 또는 지원되는 issue-linked 작업 브랜치여야 하고 이슈의 target branch가 `dev`와 일치해야 한다. |

### What Is Warning Only

| Rule | What it means for people |
| --- | --- |
| API contract drift | endpoint, response shape, env var가 바뀌면 docs를 같이 고친다. |
| Frontend build risk | UI/API adapter 변경 후 `npm run verify:ui-regressions`와 `npm run build`를 실행한다. |
| PR/Issue template completion | GitHub 기본 템플릿을 채워 scope, 검증, 영향도, 완료 기준을 남긴다. |
| Spark direct-cache threshold | process 기본값과 rollback은 0이다. dev 활성값 10GiB는 10GB direct-cache와 100GB staging의 raw read 1회·OOM·executor replacement·residue 0 근거가 있는 동일 Backend/Spark image receipt에만 적용한다. 임의 다른 값, active Spark가 있는 apply, ConfigMap만 바꾸고 FastAPI/Collector revision을 갱신하지 않는 부분 활성화를 금지한다. ALB steady 검증은 정상 rollout의 draining·EndpointSlice·healthy floor 수렴만 최대 10분까지 bounded retry하고 15초 간격 3회 연속 steady를 요구하며, 그 밖의 계약 위반이나 제한 시간 초과는 전체 활성화를 rollback한다. |

### What Is Deferred

| Deferred item | Reason |
| --- | --- |
| CODEOWNERS review | ownership 기준이 아직 정해지지 않았다. |
| Live AWS integration CI | RDS/MSK/S3/EKS/IRSA fixture를 일반 PR에 제공하지 않는다. |

### Common Failure And Fix

| Failure | How to fix |
| --- | --- |
| `npm run verify:ui-regressions` failed | 주요 workspace의 compact header, SQL action/탭의 텍스트 label, SQL section marker·좌우 panel 화살표, editor 불변 높이·Nessie Popover/Bubble/Collapsible·Dashboard WidgetConfigPanel 재사용·차트/데이터/실행 정보 전환·Trino timeline/cursor pagination/server CSV·Job wizard, Source/Catalog 밀도, Catalog PROCESS projection, Dashboard panel toggle, Dashboard 목록, ApexCharts 위젯의 최근 회귀 방지 계약을 확인하고 관련 파일을 수정한다. |
| `npm run build` failed | TypeScript error와 Vite build output을 확인하고 관련 파일을 수정한다. |
| Live API mode failed | Browser Network에서 상대 `/api` 요청인지 확인한 뒤 Vite의 `VITE_DEV_PROXY_TARGET` 또는 container Nginx의 `backend:8080` 해석, `/api/realtime/events`의 SSE buffering 비활성화, backend 상태, `docs/api-contract.md` response shape를 확인한다. 로컬 HTTP 로그인은 proxy에서 Secure cookie를 제거하지 말고 local backend의 `AUTH_SESSION_COOKIE_SECURE=false`만 사용한다. |
| Prod compose config failed | `deploy/.env.example`의 필수 env key, `deploy/docker-compose.prod.yml`, Dockerfile path를 확인한다. |
| Deploy readiness failed | GitHub Actions artifact의 JSON record와 실패한 `compose_config`, `backend_image`, `backend_dependencies`, `backend_python_dependencies`, `backend_runtime_contract`, `frontend_image` step을 확인한다. 로컬 재현은 `bash scripts/verify-deploy-readiness.sh`로 한다. |
| API contract mismatch | `docs/03-api-reference.md`, `docs/api-contract.md`, frontend types/API adapter를 함께 맞춘다. |
| Spark direct cache was skipped or failed | Spark result의 `source.inputBytes`, `directCacheMaxSourceBytes`, `directCacheDecisionReason`, `directCacheInitializationStatus`, `directCacheFallbackCount`를 확인한다. 크기 미확인이나 한도 초과를 우회해 강제 cache하지 않으며, 초기화 실패를 staging fallback으로 바꿔 원본 재읽기를 숨기지 않는다. |
| Spark Planner가 AWS S3 입력을 `input_size_unavailable`로 기록 | FastAPI workload identity의 직접 `HEAD`와 `S3_ALLOWED_BUCKETS`를 먼저 확인한다. AWS native S3는 custom endpoint를 저장하거나 `S3_ALLOWED_ENDPOINTS`를 요구하지 않으며, custom endpoint를 쓰는 Source만 endpoint allowlist를 가져야 한다. |
| Admin audit contract failed | `cd backend && npm run verify:admin-audit-contract`로 `query_run`, 레거시 `unknown`, OpenAPI inline/local-ref 의미 호환성과 frontend 타입 집합을 확인한다. session 기반 실제 HTTP 흐름은 `npm run verify:identity-admin`, 부분 실패 UI는 `cd frontend && npm run test:admin-console-load`로 확인한다. |
| PR branch policy failed | base/head 조합, 지원 브랜치 패턴, linked issue의 `Target Branch`를 확인한다. `main <- dev`; `dev <- pair1|pair2|pair3|지원 work branch|<type>-#issue`가 허용된다. |
| Merged PR did not close its issue | PR footer가 `Closes/Fixes/Resolves #N`인지, base branch에 최신 Notion Issue Sync가 있는지, lifecycle smoke가 통과했는지 확인한다. 정기 복구는 기본 브랜치 `main`의 workflow를 사용하므로 자동화 변경은 `dev -> main`까지 반영한다. |
| EC2 deploy script failed | `source deploy/ec2.env`, AWS auth, SSH key, instance state, server `deploy/.env`, Compose logs를 순서대로 확인한다. |
| EC2 deployment diagnostic failed | `ASKLAKE_DEPLOY_DIAGNOSTIC_PATH`의 JSON에서 failed check를 확인한 뒤 `scripts/deploy.sh logs` 또는 운영 runbook의 해당 readiness 절차를 따른다. diagnostic은 관찰만 수행하므로 자동 restart나 rollback을 기대하지 않는다. |

## 4) Lifecycle Guardrails

| Lifecycle Step | Primary Responsibility | System Candidate | Harness Record |
| --- | --- | --- | --- |
| Branch/workspace start | developer | branch naming check | task notes or PR description |
| PR open | developer / GitHub | PR checklist, linked issue candidate | PR body |
| PR review/merge readiness | CI / reviewer | frontend UI checks, API contract checks | PR checks and docs updates |
| PR merge/finalize | maintainer | protected branch ruleset, PR source branch policy, required checks when available | merge summary |
| Drift recovery | maintainer | read-only audit or manual review | follow-up issue or docs update |

## 5) Follow-Up Candidates

- Repository admin이 secret scanning 상태를 확인한다.
- Repository admin이 `Frontend UI Checks / frontend-ui-checks`를 required check로 등록한다.
- 배포 workflow가 추가되면 prod compose config check를 required pre-deploy check 후보로 등록한다.
- 백엔드 scaffold가 생기면 backend test/build check를 추가한다.
- API adapter가 늘어나면 contract drift check script를 검토한다.

## 6) Scenario Audit Plan

Scenario audit은 새 hard rule을 추가하는 절차가 아니다.
목적은 현재 시스템 가드레일과 협업 하네스 기록이 실제 PR/Issue/workspace 흐름에서 어긋나는 지점을 찾는 것이다.

### Mock Scenario Matrix

| Scenario | System Layer Expectation | Harness Layer Expectation | Suggested Test Form | Blocker? |
| --- | --- | --- | --- | --- |
| Frontend API response type changes | build or type check should fail when types drift | API docs updated with the same shape | local build / future CI | conditional |
| Backend live mode returns error envelope | UI shows toast/audit failure | readiness doc records expected failure handling | manual smoke | no |
| Secret accidentally added to env file | secret scanning should block or warn when enabled | docs mention no real credentials | GitHub setting audit | yes when enabled |

### Automation Boundary

- Every PR should eventually keep deterministic local checks in CI.
- Read-only scenario audit can be manual until the team accepts automation noise.
- Remote-changing E2E tests do not run in normal CI without human approval.
- Warning-only rules should not become hard gates until the team accepts the override policy.
# 리팩토링 CI guardrail (2026-07-16)

- `Refactor Quality Gates`는 `dev`/`main` PR에서 구조 ratchet과 API/persisted/bridge/legacy 계약을 검사한다.
- 기존 1,000줄 file과 100줄 Python·JavaScript/TypeScript function은 `docs/refactor-2026/quality-gate-baseline.json`을 넘겨 키울 수 없다.
- 2026-07-21 기준표는 `feat-#1106`의 필터 기능 이식 전 상태(`18fb51f`)에서 다시 수집했다. 기존 브랜치의 구조 부채만 현재 상한으로 기록했으며, 이번 변경으로 커진 `dashboard_physical_data.py`는 공통 헬퍼로 분리해 기준보다 작게 유지했다. 현재 크기를 넘는 추가 증가는 계속 차단하며, 기준 갱신을 기능 PR의 검사 우회 수단으로 사용하지 않는다.
- Issue #1139의 `dev`/`pair1` 통합은 `origin/dev`에서 그대로 상속되거나 줄어든 구조 부채와 결합 트리에서만 커진 항목을 구분하고, 필요한 path/function만 정확한 현재 줄 수와 2026-08-31 만료일로 예외 처리한다. `origin/pair1`의 기존 예외는 유지하며 전체 기준 재생성, wildcard, 미사용 성장 여유는 허용하지 않는다.
- 새 import cycle과 문서 없는 API/schema·CI/deploy 변경을 금지한다.
- baseline 예외는 owner, reason, expiresAt 없이 추가할 수 없고 만료되면 CI가 실패한다.
- frontend 변경은 별도 `Frontend UI Checks`의 전체 UI regression과 production build를 계속 필수로 한다.
- release 전에는 수동 slow suite로 production Spark와 Continuous runtime contract를 실행한다.

# ETL E2E·복구 gate (2026-07-16)

- `Refactor E2E Recovery / pr-contract`는 backend/frontend/deploy 관련 PR에서 deterministic `pr` profile을 실행하고 JSON/JUnit/Markdown artifact를 항상 보존한다.
- `release` profile은 수동 dispatch로 실제 Node process와 Docker Spark runtime UID 185 경계를 검사한다.
- `nightly` profile은 `self-hosted + asklake-e2e` 격리 runner에서만 실행하며 `ASKLAKE_E2E_ISOLATED_ENV=true`와 loopback API/frontend URL을 강제한다.
- runner는 static AWS/MinIO credential을 child process에 전달하지 않으며 non-loopback nightly target을 실행 전에 차단한다.
- recovery check의 timeout, missing artifact, duplicate/loss/checkpoint rollback, non-convergent reconcile은 release No-Go다.
- production fault injection, 공유 consumer group/topic/table/dashboard 사용, runtime data 포괄 삭제는 금지한다.

# 리팩토링 release gate (2026-07-16)

- 최종 정량 artifact는 `npm run verify:refactor-final-audit`로 재생한다.
- `npm run verify:refactor-release-plan`은 runbook 구조, P1 owner/date, bounded rollback 결정을 검사한다.
- `npm run verify:refactor-release-execution`은 격리 nightly fault, production canary clean reboot, backup/restore drill이 모두 증명되기 전 exit 2로 차단한다.
- production 배포, EC2 reboot, traffic promotion은 별도 명시적 승인과 release owner가 필요하다.
- rollback은 DB 수동 편집, checkpoint 삭제, 수동 chown을 정상 절차로 사용하지 않는다.

# EKS Realtime V1-only guardrail (#1101)

Backend immutable image preflight와 rollout은 live `asklake-web` profile을 먼저 읽고
`standard`와 `realtime-v1-only`를 서로 다른 경계로 검증한다. `standard`에서는
FastAPI 2개가 `external_ec2`이고 내부 Continuous process가 0이어야 하며 보존된
외부 EC2 owner 검증도 통과해야 한다. `realtime-v1-only`에서는 FastAPI 2개가
`local` control plane과 승인된 동일 owner generation을 사용하고 내부 Continuous
process는 0이어야 한다. 이때 전용 `asklake-realtime-v1-worker`가 fenced previous
owner와 같은 generation으로 Ready 1/1이어야 하며 구형 external EC2 owner 검증을
강제하지 않는다. 알 수 없는 profile, generation drift, worker 부재 또는 FastAPI
내 중복 worker process는 image apply 전에 실패한다.

- 신규 Kafka Continuous Job의 `runtimeEngine`은 `spark_structured_streaming`만 허용한다.
- EKS realtime worker는 `CONTINUOUS_WORKER_SCOPE=all`이며 Kafka와 Continuous SQL control
  plane을 하나의 owner claim으로 소유한다.
- 동일 broker/topic/group/generation/checkpoint identity의 active owner는 정확히 하나다.
- owner fence, 승인, 새 generation, MSK IAM, S3 runtime document/checkpoint가 하나라도
  없으면 workload 활성화를 거부한다.
- rollback은 새 generation과 보존된 checkpoint를 사용하며 checkpoint 삭제·rewind,
  dual-run, 다른 엔진으로 자동 전환을 금지한다.
- EKS V1-only 전환 전 Catalog JSONB의 `serving/clickhouse` physical binding은 원본을 삭제하지
  않고 비활성 profile의 read normalization에서 제외한다. 현재 유효한 `archive/trino` binding과
  Dataset metadata는 보존하며, legacy 또는 malformed entry 하나가 Catalog 목록 전체를 500으로
  만들면 rollout No-Go다. 이 EKS guard는 EC2 opt-in ClickHouse V2/Kafka Connect profile과 관련
  배포 자산을 삭제하거나 비활성화하지 않는다.

# EKS Spark Resource Planner promotion guardrail

- 기본 mode는 `off`이며 입력 metadata 부재, unsupported executor profile,
  Plan hash 또는 runtime ConfigMap revision drift에서는 baseline executor를 유지한다.
- V1은 `standard-v1` profile에서 executor 수만 `1`, `2`, `4` 중 선택한다. 같은
  Job의 성공·입력 byte·Plan hash·실제 executor가 일치하는 이력만 사용하고 다른
  Job의 결과나 실패 Run은 학습 근거로 섞지 않는다.
- policy V3는 30분 Spark duration 목표를 만족하는 후보 중 `executor-seconds`가 가장
  작은 값을 선택한다. 실제 청구액이나 전체 wall-clock으로 과장하지 않는다.
- private runtime 후보는 Planner 관련 key만, Web 후보는
  `backend.runtimeConfigRevision`만 변경해야 한다.
- 같은 immutable Backend/Spark image의 10GB·100GB `shadow` evidence와 `off/1`
  복구가 검증되기 전에는 `enforce`로 승격하지 않는다.
- image rollout, runtime/Web Helm mutation과 비용 발생 Spark Run은 각각 별도
  승인을 요구한다.
