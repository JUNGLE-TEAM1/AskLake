# System Guardrails

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
| Frontend UI checks before merge | GitHub Actions workflow running `cd frontend && npm run verify:ui-regressions && npm run build` | `enabled` | block merge when required check is enabled and the workflow fails | maintainer | PR에서 SQL/Catalog/Dashboard UI regression contract와 Vite build를 함께 확인 |
| Spark Runtime contract | `cd backend && npm run verify:spark-runtime-contract` | `partial` | fail when canonical/legacy selection, production guard, capability, or operation dispatch drifts | maintainer | repo verifier는 동작하며 CI required check 연결은 후속. `batch`, `sourceInspect`, `continuous`, `maintenance` 네 경로를 확인 |
| Storage Layout V1 contract | `cd backend && npm run verify:storage-layout-contract && npm run verify:target-metadata && npm run verify:kafka-continuous-contract` | `partial` | fail when Node/Python canonical paths, Batch dataset identity, legacy checkpoint recovery, checkpoint isolation, retention, or production URI guard drifts | maintainer | repo verifier는 동작하며 실제 bucket lifecycle 적용과 CI required check 연결은 후속 |
| Amazon MSK connection contract | `cd backend && npm run verify:msk-connection-contract` | `partial` | fail when local fallback, MSK IAM/TLS, topic namespace/policy, bounded roundtrip, or safe error masking drifts | maintainer | fake client verifier는 동작한다. 실제 VPC/MSK/IAM roundtrip과 CI required check 연결은 배포 환경에서 후속 |
| EMR Continuous contract | `cd backend && npm run verify:emr-serverless-continuous-contract && npm run verify:kafka-consumer-identity-lock && npm run verify:kafka-continuous-graceful-shutdown` | `partial` | fail when EMR 7.9+/Spark preflight, STREAMING mode, cancel state, ack isolation, shared consumer identity, micro-batch drain, pause/resume, or secret guard drifts | maintainer | fake EMR/S3와 실제 PostgreSQL 경쟁 verifier는 동작한다. 실제 VPC/MSK/EMR pause/resume 및 CI required check 연결은 후속 |
| EMR admission contract | `cd backend && npm run verify:emr-admission && npm run verify:emr-serverless-contract && npm run verify:emr-serverless-continuous-contract` | `partial` | fail when resource estimate, application/scheduler preflight, durable slot/queue decision, quota, terminal release, cost projection, or UI contract drifts | maintainer | repo verifier와 file DB race 검증은 동작한다. 실제 PostgreSQL 다중 process, AWS queue/비용 실측과 CI required check는 후속 |
| AWS staging Phase 0/1 contract | `cd backend && npm run verify:aws-staging-contract && npm run verify:aws-staging-terraform` | `partial` | fail when staging region, network isolation, Terraform state, OIDC/IAM, budget/TTL, EMR cap, functional smoke, module resource, provider schema, or lifecycle boundary drifts | maintainer | versioned contract, Terraform module, provider lock, static negative verifier와 credential 없는 mock plan은 동작한다. 실제 AWS plan/apply, GitHub workflow, smoke와 TTL sweep은 후속이며 일반 deploy에는 연결하지 않는다 |
| Streaming load/fault/cost evidence | `cd backend && npm run verify:streaming-load-plan && npm run verify:streaming-performance-contract` | `partial` | fail on missing scenario/safety gate, integrity mismatch, environment/region drift, unobserved fault, incomparable repeats, invalid CloudWatch/SLO/cost evidence, or secret-shaped evidence key; report `insufficient-evidence` rather than pass for missing approval/metrics | maintainer | config-only verifier는 Docker/AWS를 변경하지 않는다. 실제 local fault는 이중 opt-in, AWS staging 부하·장애·비용은 별도 승인과 예산이 필요하다 |
| Runtime promotion evidence | `cd backend && npm run verify:runtime-cutover-contract`, `scripts/verify-deploy-env.sh` | `enabled` | reject production EMR/MSK selection unless the Phase 8 report is `promotion-ready`, every gate passed, approval and target match env/current commit, and the exact approved Phase 7 file SHA matches; default rollback remains available | maintainer | verifier는 AWS를 변경하지 않는다. 실제 staging/운영 증거와 승인 파일은 repo 밖에 보관하며 자동 promotion은 없다 |
| Prod compose config check | `cd backend && npm run verify:production-spark-contract` | `manual` | block operator deploy when Compose, canonical `spark-rest`, Spark REST, UID 185 mounts, or Docker-socket contract is invalid | maintainer | CI required check 전환 전까지 PR과 배포 직전에 수동 실행 |
| Backend deploy image build | CI/deploy workflow candidate running `docker build -t asklake-backend-deploy-check:local backend` | `planned` | catch Python/package incompatibility before EC2 compose rebuild | maintainer | FastAPI backend uses `python:3.13-slim` and `backend/requirements.txt` |
| Secret scanning / push protection | GitHub repository setting | `unknown` | block or warn on secret push | repo admin | repository admin 확인 필요 |
| Protected integration branches | GitHub repository ruleset on `main`, `dev`, and `pair` | `enabled` | block direct push or force push; require changes through PR | repo admin | ruleset: `Push 금지` |
| PR source branch policy | GitHub Actions check required by ruleset on `main` and `dev` | `enabled` | block PR merge when source branch does not match the allowed chain or linked issue target | repo admin | `main <- dev`; `dev <- pair1/2/3` 또는 지원 work/`<type>-#<issue>` 브랜치 + linked issue `Target Branch: dev` |
| PR merge / Issue lifecycle sync | `.github/workflows/notion-issue-sync.yml` and lifecycle smoke checks | `enabled` | fail before remote mutation when lifecycle contracts break; recover missed merge events on the next scheduled/manual dispatch | maintainer | explicit `Closes/Fixes/Resolves #N` merge closes Issue and sets Project/Notion `Done`; reopen after merge is preserved |
| Default PR and issue templates | GitHub `.github` templates | `enabled` | prompt contributors to document scope, verification, impact, and acceptance criteria | maintainer | advisory template, not a hard gate |
| Deployment env files ignored | `.gitignore`, review checklist | `enabled` | prevent committing server `.env` and local EC2 env values | maintainer | `deploy/.env` and `deploy/ec2.env` are ignored; only examples are committed. MinIO access key/secret and `AIRFLOW_EXECUTION_API_TOKEN` stay in server `.env` or secret storage. The Airflow and backend token values must match. Kafka replay input은 `ASKLAKE_REPLAY_HOST_INPUT_DIR`의 읽기 전용 mount만 사용하며 arbitrary host path API 입력은 금지한다. |
| API contract drift check | repo-local script or review checklist | `planned` | warn or block when API docs and code drift | maintainer | backend 구현 후 후보 |

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

### What Is Deferred

| Deferred item | Reason |
| --- | --- |
| CODEOWNERS review | ownership 기준이 아직 정해지지 않았다. |
| Backend integration CI | backend scaffold가 아직 없다. |

### Common Failure And Fix

| Failure | How to fix |
| --- | --- |
| `npm run verify:ui-regressions` failed | SQL 분석의 editor 불변 높이·Nessie Popover/Bubble/Collapsible·Dashboard WidgetConfigPanel 재사용·차트/데이터/실행 정보 전환·Trino timeline/cursor pagination/server CSV·Job wizard, Catalog wide button, Dashboard 목록, ApexCharts 위젯의 최근 회귀 방지 계약을 확인하고 관련 파일을 수정한다. |
| `npm run build` failed | TypeScript error와 Vite build output을 확인하고 관련 파일을 수정한다. |
| Live API mode failed | `VITE_API_BASE_URL`, backend server 상태, `docs/api-contract.md` response shape를 확인한다. |
| Spark Runtime contract failed | `ASKLAKE_SPARK_RUNTIME`, legacy `ASKLAKE_SPARK_RUNNER`, `backend/src/sparkRuntime.mjs`의 capability와 operation adapter 등록을 확인한다. `emr-serverless`는 Batch/MSK Continuous만 허용하며 서로 다른 Runtime으로 묵시적 fallback하지 않는다. |
| EMR Serverless contract failed | enabled/application/role/S3 URI/region, executor 범위, default AWS credential chain, PySpark artifact checksum, persisted Job Run state를 확인한다. static credential을 env·payload·state·log에 추가하지 않는다. |
| EMR Continuous contract failed | Continuous feature flag, `SPARK`/`emr-7.9.0` 이상과 `GetApplication` 권한, MSK Runtime/IAM bootstrap/VPC reachability, streaming entry/helper artifact, execution role의 S3·Kafka 권한, S3 checkpoint/report, `maxFailedAttemptsPerHour` 1~10, graceful cancel 15~1800초를 확인한다. `packages` mode는 NAT/Maven egress 명시 승인이 필요하고, egress가 없으면 immutable S3 JAR mode를 사용한다. Streaming 제출에 Batch timeout이나 static AWS key를 추가하지 않는다. |
| EMR admission contract failed | admission flag와 workload별 application ID, driver/executor disk·memory overhead·max executors, maximumCapacity, scheduler concurrent/queue timeout, auto-stop, Job cost allocation을 확인한다. DB reservation을 우회해 StartJobRun을 직접 호출하거나 priority metadata를 AWS FIFO 우선순위처럼 설명하지 않는다. |
| AWS staging Phase 0 contract failed | `infra/contracts/aws-staging-smoke.v1.json`의 서울 리전, 전용 private VPC/CIDR, S3 lockfile/versioning/KMS, OIDC/IAM, 30 USD 예산과 8시간 TTL, application별 16 vCPU cap, 100만 건 기능 smoke와 수동 apply/증거 export/destroy 경계를 확인한다. 실제 account 값이나 static AWS key를 계약에 넣어 통과시키지 않는다. |
| AWS staging Terraform verification failed | Terraform `1.7+`, AWS provider lock, `infra/terraform/bootstrap`과 `environments/staging`의 `init -backend=false`/`validate`, mock plan assertion을 확인한다. NAT/Internet Gateway/public CIDR/static key를 추가하거나 mock을 실제 AWS 성공 근거로 사용하지 않는다. |
| Streaming performance contract failed | plan의 8개 부하·8개 장애 시나리오와 safety gate, evidence schema/민감 key, produced-consumed-sink 정합성, environment/region, 장애 주입·기대 결과·failure code, 실제 CloudWatch 자원 표본, SLO profile approval/threshold, 같은 설정 fingerprint, EMR billed resource 세 필드·같은 region price snapshot을 확인한다. `insufficient-evidence`를 성공으로 바꾸지 않는다. |
| Runtime promotion contract failed | 고정 plan과 approved policy/operational evidence/Phase 7 원본의 바이트 SHA, 정확한 report gate 집합, baseline `spark-rest + redpanda`, 분리된 consumer group/output/checkpoint, stored 결과와 checksum, 단계 artifact/시간 순서, 16개 Phase 7 scenario/run gate, 관측 임계치, rollback commit/owner/runbook을 확인한다. 배포 실패 시 보고서를 고치거나 우회하지 말고 기본 Runtime으로 롤백한다. |
| Amazon MSK connection contract failed | `ASKLAKE_KAFKA_RUNTIME`, MSK feature flag, IAM bootstrap brokers, region, IAM/TLS, environment topic prefix와 partition/retention 기대값을 확인한다. static credential 또는 bootstrap broker 원문을 오류 로그에 추가하지 않는다. |
| Prod compose config failed | `deploy/.env.example`의 필수 env key, `deploy/docker-compose.prod.yml`, 기본 `ASKLAKE_SPARK_RUNTIME=spark-rest` 또는 승인된 `emr-serverless`/`msk` opt-in, Phase 8 report/policy/evidence/Phase 7 절대 경로, Dockerfile path를 확인한다. |
| API contract mismatch | `docs/03-api-reference.md`, `docs/api-contract.md`, frontend types/API adapter를 함께 맞춘다. |
| PR branch policy failed | base/head 조합, 지원 브랜치 패턴, linked issue의 `Target Branch`를 확인한다. `main <- dev`; `dev <- pair1|pair2|pair3|지원 work branch|<type>-#issue`가 허용된다. |
| Merged PR did not close its issue | PR footer가 `Closes/Fixes/Resolves #N`인지, base branch에 최신 Notion Issue Sync가 있는지, lifecycle smoke가 통과했는지 확인한다. 정기 복구는 기본 브랜치 `main`의 workflow를 사용하므로 자동화 변경은 `dev -> main`까지 반영한다. |
| EC2 deploy script failed | `source deploy/ec2.env`, AWS auth, SSH key, instance state, server `deploy/.env`, Compose logs를 순서대로 확인한다. |

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

| Test Layer | Runs By Default | Scope | Expected Result |
| --- | --- | --- | --- |
| Frontend UI checks | yes on matching PR paths | `frontend` | UI regression contracts and TypeScript/Vite build pass |
| Prod compose config | no, local/manual until CI exists | `deploy/docker-compose.prod.yml` | `TRINO_ENABLED=false` excludes every Trino-profile service without Trino secrets/files/buckets; `true` plus `COMPOSE_PROFILES=trino` renders the coordinator/bootstrap/workers with internal + outbound networks |
| Backend deploy image build | no, local/manual until CI exists | `backend/Dockerfile`, `backend/requirements.txt` | backend Docker image builds with production Python base image |
| Deploy dependency verification | manual | deploy Compose/env, health JSON readiness, Spark Runtime selection, Spark REST create/status contract, backend/frontend/Spark/Trino images, Airflow DAG import | `tests/deploy/deploy-scripts-regression.sh`, `cd backend && npm run verify:production-spark-contract`, and `scripts/verify-deploy-dependencies.sh` pass before deploy |
| Trino contract verification | matching backend/frontend paths | Query Run, registration, result storage, collector fencing, actor reservation, timeline state | `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`, `test:trino-timeline` pass |
| Trino production readiness | deploy-time when `TRINO_ENABLED=true` | TLS/auth, read-only query identity, materializer CTAS/describe/drop, AWS S3 Warehouse/Query Result bucket round trip through EC2 instance profile | `verify:trino-production-readiness` passes after Compose health |
| AWS S3 startup readiness | every production Compose startup | Raw bucket list, Output bucket put/head/delete with EC2 instance role | `aws-s3-readiness` completes before backend starts; bucket auto-create and static AWS keys are forbidden |
| AWS S3 output identity | frontend build and every Spark run/Catalog publish | Target UI bucket, Spark writer bucket, Catalog storage location | production frontend receives `ASKLAKE_SPARK_OUTPUT_BUCKET`; only legacy `asklake-output` roots are normalized and explicit custom buckets remain unchanged |
| Storage Layout identity | matching backend/deploy paths | Batch/Continuous data, checkpoint, manifest, quarantine, log reference | shared fixture keeps Node/Python percent encoding equal; target metadata verifies persisted dataset identity; Continuous contract restores legacy checkpoint roots and rejects mismatches; lifecycle enforcement remains operator-owned |
| PR event checks | no | future GitHub Actions | changed code satisfies required checks |
| Read-only lifecycle audit | manual | docs, PR, branch status | drift is reported without changing remote state |
| Admin setting audit | manual | branch protection, secrets, rulesets | actual settings match inventory or gap is recorded |

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
