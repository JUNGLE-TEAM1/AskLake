# System Guardrails

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
| Frontend UI checks before merge | GitHub Actions workflow running `cd frontend && npm run verify:ui-regressions && npm run build` | `enabled` | block merge when required check is enabled and the workflow fails | maintainer | PR에서 SQL/Catalog/Dashboard UI regression contract와 Vite build를 함께 확인 |
| Prod compose config check | `docker compose --env-file deploy/.env.example -f deploy/docker-compose.prod.yml config --quiet` and `backend/scripts/verify-production-spark-contract.mjs` | `manual` | block operator deploy when Compose, Spark REST, UID 185 mounts, or Docker-socket contract is invalid | maintainer | CI required check 전환 전까지 PR과 배포 직전에 수동 실행 |
| Backend deploy image build | CI/deploy workflow candidate running `docker build -t asklake-backend-deploy-check:local backend` | `planned` | catch Python/package incompatibility before EC2 compose rebuild | maintainer | FastAPI backend uses `python:3.13-slim` and `backend/requirements.txt` |
| EKS/MSK resource creation gate | Phase 0 contract review before Terraform/Helm/AWS mutation | `manual` | block paid resource creation while inventory, ownership, network, workload IAM, or destroy boundary is unknown | Pair A | [EKS + MSK MVP Phase 0 환경·인수 계약](eks-msk-mvp-phase-0-contract.md)의 미완료 항목이 있으면 EKS cluster, MSK Serverless, RDS, NAT Gateway를 생성하지 않는다. |
| EKS foundation contract check | `scripts/verify-eks-foundation.sh` | `manual` | block Pair A/B handoff when EKS Auto Mode/IAM/access-entry contract, Terraform/Helm files, service accounts, namespace RBAC, Replay exclusion, Trino handoff, runtime boundary, or credential scan fails | Pair A | Existing cluster는 외부 Auto Mode 확인 없이는 실패하고 신규 cluster는 명시적 admin principal 없이는 실패한다. Terraform CLI가 없는 환경은 documented Docker validation을 추가 실행한다. 실제 AWS apply는 수행하지 않는다. |
| EKS Phase 11 network creation gate | Terraform checks and foundation verifier | `manual` | block VPC creation without MVP ownership, 2+ unique AZs, deterministic non-overlapping subnet netnums, explicit NAT/endpoint egress and minimum endpoint set | Pair A | External/shared network is reference-only. NAT and interface endpoints incur cost. Static plan is not runtime connectivity evidence; ALB remains a later phase and custom NodePool runtime evidence belongs to Phase 12. |
| EKS Phase 12 NodePool selection gate | `scripts/verify-eks-auto-mode-node-pools.sh`, Terraform checks and Helm schema | `manual` | render zero custom resources by default; reject missing IAM access ownership, subnet/security-group selectors, capacity/instance limits or disruption choices | Pair A/B | Test fixture values are not deployment recommendations. General/Spark placement, negative taint test, scale/cost evidence and actual AWS apply remain environment work. |
| EKS AWS inventory redaction | `scripts/inspect-eks-aws-inventory.sh` and Phase 2 read-only IAM policy | `manual` | report access state and counts without printing account IDs, resource names, ARN, endpoint, IP, or secret values | Pair A | `AccessDenied`는 빈 환경으로 해석하지 않으며 [Phase 2 AWS Inventory](eks-phase-2-inventory.md)의 gate가 닫힐 때까지 유료 resource를 생성하지 않는다. |
| EKS data-plane safe defaults | Terraform mode checks and mock-provider tests | `manual` | keep MSK/RDS/S3 disabled by default; reject create for shared/external lifecycle, missing private network inputs, broad Kafka/S3 actions, or incomplete KMS reference; imported S3 buckets require `managed-existing`, `shared-preserved`, and destroy protection | Pair A | [Phase 3 Data Plane 계약](eks-phase-3-data-plane.md) 검증은 AWS를 변경하지 않으며 실제 apply는 Phase 2 gate와 별도 승인이 필요하다. |
| EKS workload identity selection | Terraform mode checks, pure policy module, Helm/mock tests and runtime STS/S3 smoke | `manual` | keep identity disabled until IRSA OIDC provider or Auto Mode Pod Identity readiness is confirmed; keep resource keys plan-known and create four isolated roles only with exact MSK/S3 boundaries | Pair A | Frontend/Airflow와 외부 fixture producer를 EKS role에 섞지 않는다. dev는 Pod Identity STS·S3 경계를 검증했으며 MSK IAM data-plane smoke는 client handoff 뒤 수행한다. [Phase 4 identity 계약](eks-phase-4-identity-rds-bootstrap.md)을 따른다. |
| EKS RDS logical bootstrap | host/TLS/confirmation-gated script and isolated Docker verification | `manual` | fail before DB mutation when expected host mismatches, verify-full CA/admin/three role passwords, postgres maintenance DB, confirmation, or psql is missing | Pair A | Docker 검증은 2회 멱등 실행, role flag와 cross-database CONNECT 격리를 확인한다. schema migration, EC2 데이터 이전과 rollback 승인은 별도다. |
| EKS delivery handoff gate | `scripts/verify-eks-delivery-handoff.sh` and deploy-time `--ready` validation | `manual` | reject contract drift during planning and block deployment until immutable images, data-plane references, platform decisions and exact network allowlist are complete | Pair A | 실제 값이 들어간 `*.handoff.json`은 Git에 커밋하지 않는다. Continuous external-EC2 ownership, Replay exclusion and secret-reference-only delivery are mandatory. |
| EKS immutable image delivery | manual `eks-image-delivery.yml`, GitHub Environment approval, OIDC and receipt validation | `manual` | fail before build when environment variables or repositories are absent; never create ECR repositories; reject mutable/non-AMD64 receipt | Pair A | no push/PR trigger and no long-lived AWS keys. Actual execution stores images and can incur ECR/network cost. [Phase 6 image delivery](eks-phase-6-image-delivery.md) applies. |
| EKS Auto Mode ALB decision/apply gate | Terraform checks, `scripts/verify-eks-network-ingress.sh` and confirmation-gated deploy/destroy scripts | `manual` | render zero resources by default; reject partial exposure/target/address/subnet/DNS/ACM inputs and self-managed controller annotations; require server-side dry-run before paid ALB creation | Pair A | application SAs receive no Ingress mutation. IngressClassParams restricts namespace labels. DNS remains externally owned and Ingress/finalizer cleanup must precede cluster destroy. |
| EKS Phase 14 web workload gate | `scripts/verify-eks-web-workloads.sh` and receipt/context-gated deploy/destroy scripts | `manual` | render zero resources by default; require immutable frontend/backend digests, two replicas, explicit resources, runtime ConfigMap/Secret, General placement and B runtime-boundary approval | Pair A/B | test resources are fixtures, not sizing recommendations. Deploy workloads before Ingress; destroy Ingress before Services. Runtime restart/Continuous isolation remains required evidence. |
| EKS Day 14 Metrics/scale gate | Terraform checks, `scripts/verify-eks-metrics-scale.sh`, confirmation-gated scale runner | `manual` | keep add-on and smoke workload disabled until exact compatible version, owner, Metrics API, immutable backend image, General placement and explicit resource values are reviewed | Pair A | community add-on has no workload IAM policy. Kubelet `10250`, `kubectl top`, node scale-out, cleanup and later scale-in need runtime evidence; test fixture sizing is not a recommendation. |
| EKS runtime Secret delivery gate | canonical JSON, Terraform checks, Helm render and runtime/combined verifiers | `manual` | reject Secret/env/file/shared-binding drift, incomplete delivery metadata and Phase 5/8 selection mismatch; scope ESO to `asklake-dev`; allow its Pod Identity only three read actions on `asklake/dev/*`; keep full-service contract closed while Airflow/AI decisions are unresolved | Pair A/B | Secret values never enter Git/Terraform/output. Static AWS keys, cluster-wide store/PushSecret and application SA Secret read RBAC are forbidden. Dev foundation sync/rotation smoke passed and its dummy source/target were deleted; actual workload mapping/injection remains. |
| Secret scanning / push protection | GitHub repository setting | `unknown` | block or warn on secret push | repo admin | repository admin 확인 필요 |
| Protected integration branches | GitHub repository ruleset on `main`, `dev`, and `pair` | `enabled` | block direct push or force push; require changes through PR | repo admin | ruleset: `Push 금지` |
| PR source branch policy | GitHub Actions check required by ruleset on `main` and `dev` | `enabled` | block PR merge when source branch does not match the allowed chain or linked issue target | repo admin | `main <- dev`; `dev <- pair1/2/3` 또는 지원 work/`<type>-#<issue>` 브랜치 + linked issue `Target Branch: dev` |
| PR merge / Issue lifecycle sync | `.github/workflows/notion-issue-sync.yml` and lifecycle smoke checks | `enabled` | fail before remote mutation when lifecycle contracts break; recover missed merge events on the next scheduled/manual dispatch | maintainer | explicit `Closes/Fixes/Resolves #N` merge closes Issue and sets Project/Notion `Done`; reopen after merge is preserved |
| Default PR and issue templates | GitHub `.github` templates | `enabled` | prompt contributors to document scope, verification, impact, and acceptance criteria | maintainer | advisory template, not a hard gate |
| Deployment env files ignored | `.gitignore`, review checklist | `enabled` | prevent committing server `.env` and local EC2 env values | maintainer | `deploy/.env` and `deploy/ec2.env` are ignored; only examples are committed. MinIO access key/secret and `AIRFLOW_EXECUTION_API_TOKEN` stay in server `.env` or secret storage. The Airflow and backend token values must match. Kafka replay input은 `ASKLAKE_REPLAY_HOST_INPUT_DIR`의 읽기 전용 mount만 사용하며 arbitrary host path API 입력은 금지한다. |
| Production legacy demo auth | backend startup + `scripts/verify-deploy-env.sh` | `enabled` | legacy demo users are disabled by default; an explicit demo deployment must set matching backend/frontend opt-in flags | maintainer | `AUTH_LEGACY_DEMO_USERS_ENABLED`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED`가 모두 `true`일 때만 재시작 시 기존 status/session을 보존한다. Bootstrap admin과 production header-auth 차단은 유지한다. |
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
| Prod compose config failed | `deploy/.env.example`의 필수 env key, `deploy/docker-compose.prod.yml`, Dockerfile path를 확인한다. |
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
| EKS foundation contract | no, local/manual until CI exists | `infra/eks/terraform`, `infra/eks/helm`, Phase 1/10 handoff | `scripts/verify-eks-foundation.sh` passes EKS Auto Mode capability/IAM/access-entry and fail-closed existing-cluster mock tests, rejects legacy Managed Node Group resources, and passes Helm/RBAC/Replay/Trino/runtime-boundary/credential checks without AWS mutation |
| EKS Phase 11 network foundation | no, local/manual until actual environment apply | external/create VPC ownership, paired public/private subnets, NAT/endpoints, EKS/MSK/RDS placement and service SGs | Terraform tests cover single/per-AZ NAT, endpoint-only minimums, deterministic subnet derivation, external public subnet handoff, exact MSK/RDS ports and failure gates without AWS mutation |
| EKS Phase 12 Auto Mode NodePools | no, local/manual until actual environment apply | dedicated custom node IAM/access entry, two NodeClasses/NodePools and workload placement | disabled render is empty; enabled render requires explicit capacity/cost/disruption selectors, isolates Spark with a `NoSchedule` taint and passes Terraform ownership failure tests without AWS mutation |
| EKS delivery handoff | no, local/manual until CI exists | `infra/eks/delivery`, Phase 5 deployment input | planning contract passes locally and deploy-time `--ready` fails closed until five immutable ECR digests, AWS references and required decisions are present |
| EKS image delivery | manual workflow only | five ECR repositories and image receipt | OIDC-authenticated workflow publishes one AMD64 digest per component and uploads a validated 30-day receipt; no automatic trigger or repository creation |
| EKS Auto Mode ALB ingress | no, local/manual until actual environment apply | Phase 13 handoff, IngressClassParams/Class and two Ingress rules | default renders nothing; reviewed fixture uses the EKS-managed ALB controller with namespace/subnet/ACM constraints and distinct FastAPI/Frontend health paths; apply/destroy require exact confirmations |
| EKS Phase 14 web workloads | no, local/manual until actual environment apply | Frontend/FastAPI Helm chart, Phase 6 receipt and Phase 5/8 references | default renders nothing; enabled fixture renders two digest-pinned Deployments and matching ClusterIP Services; unsafe readiness, replica, image and port overrides fail |
| EKS Day 14 Metrics/scale | no, local/manual until actual environment apply | `metrics-server` EKS add-on contract and temporary scale-smoke chart | disabled defaults create nothing; exact version/owner and three readiness gates are mandatory; Terraform mock tests and Helm negative cases pass before cost-bearing runtime smoke |
| EKS runtime Secret contract | no, manual environment apply | `infra/eks/secrets`, scoped ESO Helm values, Terraform Phase 8 Pod Identity handoff and combined Phase 5/8 verifier | exact Secret names/keys, env injection, shared bindings and read-only mounts pass contract scenarios; dev SecretStore is valid and dummy sync/rotation passed without retaining values; default examples remain planning-only and actual workload mappings are still gated |
| Deploy dependency verification | manual | deploy Compose/env, health JSON readiness, Spark REST create/status contract, backend/frontend/Spark/Trino images, Airflow DAG import | `tests/deploy/deploy-scripts-regression.sh`, `backend/scripts/verify-production-spark-contract.mjs`, and `scripts/verify-deploy-dependencies.sh` pass before deploy |
| Trino contract verification | matching backend/frontend paths | Query Run, registration, result storage, collector fencing, actor reservation, timeline state | `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`, `test:trino-timeline` pass |
| Trino production readiness | deploy-time when `TRINO_ENABLED=true` | TLS/auth, read-only query identity, materializer CTAS/describe/drop, AWS S3 Warehouse/Query Result bucket round trip through EC2 instance profile | `verify:trino-production-readiness` passes after Compose health |
| AWS S3 startup readiness | every production Compose startup | Raw bucket list, Output bucket put/head/delete with EC2 instance role | `aws-s3-readiness` completes before backend starts; bucket auto-create and static AWS keys are forbidden |
| AWS S3 output identity | frontend build and every Spark run/Catalog publish | Target UI bucket, Spark writer bucket, Catalog storage location | production frontend receives `ASKLAKE_SPARK_OUTPUT_BUCKET`; only legacy `asklake-output` roots are normalized and explicit custom buckets remain unchanged |
| Production legacy demo restart | focused auth tests + deploy preflight | backend startup account/session state and frontend login hint | default production disables/revokes legacy demo identities; matching opt-in flags preserve existing status/session without reactivating an explicitly disabled account |
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
