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
| Backend deploy image build | `.github/workflows/eks-b-workload-checks.yml` Buildx matrix | `enabled` | fail matching PR when the backend runtime cannot build for `linux/amd64` | maintainer | the same matrix builds Frontend, Spark runtime, and Airflow; Trino mirror remains an A/foundation input |
| EKS B workload contract | `.github/workflows/eks-b-workload-checks.yml` plus `scripts/verify-eks-workloads.sh` | `enabled` | fail matching PR on Helm schema/render, Secret/foundation-owned RBAC boundary, mutable image, MSK/Spark contract, focused backend tests, or AMD64 image build failure | maintainer | live AWS smoke remains deploy-time because CI has no RDS/MSK/S3/Pod Identity runtime fixture |
| EKS/MSK resource creation gate | Phase 0 contract review before Terraform/Helm/AWS mutation | `manual` | block paid resource creation while inventory, ownership, network, workload IAM, or destroy boundary is unknown | Pair A | [EKS + MSK MVP Phase 0 환경·인수 계약](eks-msk-mvp-phase-0-contract.md)의 미완료 항목이 있으면 EKS cluster, MSK Serverless, RDS, NAT Gateway를 생성하지 않는다. |
| EKS foundation contract check | `scripts/verify-eks-foundation.sh` | `manual` | block Pair A/B handoff when EKS Auto Mode/IAM/access-entry contract, Terraform/Helm files, exact ServiceAccount token policy, namespace RBAC, Replay exclusion, Trino handoff, runtime boundary, or credential scan fails | Pair A | Backend/Spark만 Kubernetes API token을 사용하고 다른 application SA는 mount를 금지한다. dev foundation revision 3, Pod Identity mode와 Spark Operator 2.5.1을 적용했으며 Spark cleanup RBAC와 B web workload를 별도 검증했다. |
| EKS Phase 11 network creation gate | Terraform checks, foundation verifier and runtime network smoke | `manual` | block VPC creation without MVP ownership, 2+ unique AZs, deterministic non-overlapping subnet netnums, explicit NAT/endpoint egress and minimum endpoint set; verify private Pod placement, DNS, exact service ports, wrong-port/external denial and Auto Mode NetworkPolicy enforcement | Pair A | dev uses single NAT and `DefaultAllow` during transition. Private network smoke와 최종 web ALB route를 검증했으며 세부 증거는 [Private Network evidence](eks-day15-private-network-evidence.md)와 [Pair B live evidence](eks-day15-b-live-evidence.md)를 따른다. |
| EKS Phase 12 NodePool selection gate | `scripts/verify-eks-auto-mode-node-pools.sh`, Terraform checks and Helm schema | `manual` | render zero custom resources by default; reject missing IAM access ownership, subnet/security-group selectors, capacity/instance limits or disruption choices | Pair A/B | Test fixture values are not deployment recommendations. General/Spark placement, negative taint test, scale/cost evidence and actual AWS apply remain environment work. |
| EKS AWS inventory redaction | `scripts/inspect-eks-aws-inventory.sh` and Phase 2 read-only IAM policy | `manual` | report access state and counts without printing account IDs, resource names, ARN, endpoint, IP, or secret values | Pair A | `AccessDenied`는 빈 환경으로 해석하지 않으며 [Phase 2 AWS Inventory](eks-phase-2-inventory.md)의 gate가 닫힐 때까지 유료 resource를 생성하지 않는다. |
| EKS data-plane safe defaults | Terraform mode checks and mock-provider tests | `manual` | keep MSK/RDS/S3 disabled by default; reject create for shared/external lifecycle, missing private network inputs, broad Kafka/S3 actions, incomplete KMS reference or missing RDS final snapshot identifier; imported S3 buckets require `managed-existing`, `shared-preserved`, and destroy protection | Pair A | dev RDS는 20→100GiB autoscaling, 7일 backup, explicit windows/log export와 deletion protection으로 적용했다. 다른 환경 apply는 [Phase 3 Data Plane 계약](eks-phase-3-data-plane.md)의 별도 승인이 필요하다. |
| EKS workload identity selection | Terraform mode checks, pure policy module, Helm/mock tests and runtime STS/S3 smoke | `manual` | keep identity disabled until IRSA OIDC provider or Auto Mode Pod Identity readiness is confirmed; keep resource keys plan-known and create four isolated roles only with exact MSK/S3 boundaries | Pair A | Frontend/Airflow와 외부 fixture producer를 EKS role에 섞지 않는다. dev는 Pod Identity STS·S3 경계와 MSK private `9098` IAM metadata smoke를 검증했다. [Phase 4 identity 계약](eks-phase-4-identity-rds-bootstrap.md)을 따른다. |
| EKS RDS logical bootstrap | host/TLS/confirmation-gated script, isolated Docker verification and temporary EKS Job | `manual` | fail before DB mutation when expected host mismatches, verify-full CA/admin/three role passwords, postgres maintenance DB, confirmation, or psql is missing; verify role flags, own-database TLS login and cross-database denial | Pair A | dev actual bootstrap and repeated run passed. ESO target/Job/ConfigMap are removed after use; Secrets Manager application source remains. schema migration and EC2 data migration remain separate. |
| EKS EC2 data copy rehearsal | writer inventory, PostgreSQL dump/restore receipt, DB/object cross-check and rollback audit | `manual` | block restore when active writers, source/target mapping, target emptiness, object path ownership, backup or rollback source is unknown | Pair A/B | dev split restore and 368 S3-reference checks passed; temporary dump versions were permanently removed and EC2 returned healthy. Representative EKS Spark Parquet read passed, but Trino snapshot read and final delta remain gates because copy is not cutover. [Data copy rehearsal](eks-day15-data-copy-rehearsal.md), [receipt](eks-day15-data-copy-receipt.md). |
| EKS delivery handoff gate | `scripts/verify-eks-delivery-handoff.sh` and deploy-time `--ready` validation | `manual` | reject contract drift during planning and block deployment until immutable images, data-plane references, platform decisions and exact network allowlist are complete | Pair A | 실제 값이 들어간 `*.handoff.json`은 Git에 커밋하지 않는다. Continuous external-EC2 ownership, Replay exclusion and secret-reference-only delivery are mandatory. |
| EKS immutable image delivery | manual `eks-image-delivery.yml`, GitHub Environment approval, OIDC and receipt validation | `manual` | fail before build when environment variables or repositories are absent; never create ECR repositories; reject mutable/non-AMD64 receipt | Pair A | no push/PR trigger and no long-lived AWS keys. Actual execution stores images and can incur ECR/network cost. [Phase 6 image delivery](eks-phase-6-image-delivery.md) applies. |
| EKS Auto Mode ALB decision/apply gate | Terraform checks, `scripts/verify-eks-network-ingress.sh`, `scripts/verify-eks-day15-alb-runtime.sh` and confirmation-gated deploy/destroy scripts | `manual` | render zero resources by default; reject partial exposure/target/address/listener/subnet inputs, reject HTTP with DNS/ACM values and HTTPS without them, preserve Helm field ownership in server dry-run; steady mode requires draining 0 and exact EndpointSlice/healthy-target equality, rollout mode permits only healthy/draining while preserving the two-target floor | Pair A | dev HTTP class/params and two Ingress share one active ALB; listener route, target port/health path, `/`, `/api/health`, exact Ready target set and RDS health passed. Application SAs receive no Ingress mutation; Ingress/finalizer cleanup must precede cluster destroy. [Evidence](eks-day15-alb-runtime-evidence.md). |
| EKS Day 15 integration baseline | `scripts/capture-eks-day15-integration-baseline.sh` and redacted evidence review | `manual` | before ALB/ExternalSecret mutation, require Frontend/FastAPI 2/2, two Ready endpoints per Service, RDS health, zero Ingress/ExternalSecret, manual Backend Secret ownership, Ready AWS SecretStore and Ready AMD64 General node without printing identifiers, digests or values | Pair A | `--expect-pre-change` is a one-time pre-change gate; use `--capture` after mutation. [Baseline](eks-day15-integration-baseline.md). |
| EKS Day 15 Backend runtime Secret | `infra/eks/secrets/backend-runtime-external-secret.yaml`, `scripts/migrate-eks-backend-runtime-secret.sh` and `scripts/verify-eks-day15-backend-secret-runtime.sh` | `manual` | require exact two-key source/target mapping and equal value hash, staged ESO match before an explicitly confirmed handover, idempotent verification of an existing Ready owner, and fail-closed manual restoration; rollback must verify recreated key/hash/owner, FastAPI 2/2, steady ALB and RDS-aware health and must surface cleanup/delete/apply/rollout failure | Pair A | never delete the manual target until a staged ESO target matches; credential value rotation is separate from refresh/rollout wiring smoke. |
| EKS Day 15 Backend S3 boundary | bucket-isolated Terraform statements and `scripts/run-eks-backend-s3-smoke.sh` | `manual` | require one Backend association/policy, immutable current image, allowed three-prefix reads and two-prefix writes, denied read-only writes, denied existing out-of-prefix object read/list and denied bucket metadata; purge exact versions/DeleteMarkers and temporary Pod/ConfigMap on every path; pass consecutive runs | Pair A | never share prefix conditions across bucket resources. Spark/Trino policy isolation is static until their own runtime smoke passes. [Evidence](eks-day15-backend-s3-runtime-evidence.md). |
| EKS Day 15 final integration gate | `scripts/verify-eks-day15-final-integration.sh`, `scripts/test-eks-day15-validation-hardening.sh`, Terraform no-change plan and redacted evidence | `manual` | require a private verified Phase 6 receipt, reviewed full Git SHA and exact Deployment/Pod digest, two Ready zero-restart Pods, exact steady ALB/Secret/RDS, Backend S3 boundary plus global approved-prefix Version/DeleteMarker and Kubernetes label/name residue zero, `external_ec2` with zero EKS worker/maintenance processes, and the exact private EC2 instance running with both status checks ok | Pair A/B | EC2 instance health does not prove the Continuous service health. This gate does not approve Airflow/Spark/Trino E2E, production cutover or EC2 deletion. [Evidence](eks-day15-final-integration-evidence.md). |
| EKS 15.5 Backend image handoff | Backend Catalog rows service and TestClient HTTP tests, Phase 6 formal image receipt, provenance check and atomic Backend-only rollout | `source ready / runtime pending` | reject a receipt whose full revision does not contain the Iceberg rows fix, reject mutable/non-AMD64 image or Deployment/Pod digest mismatch, and roll back when two-replica health, ALB/RDS or Continuous ownership drifts; before Trino deployment require sanitized HTTP 502 `SQL_STORAGE_ERROR` without private endpoint/query/token leakage instead of `NameError`/generic 500 | Pair A/B | Current deployed Backend image predates the source fix. A new image must come from the workload image owner; Trino snapshot HTTP 200 remains a separate gate. [Handoff](eks-day15-5-backend-image-handoff.md). |
| EKS Phase 14 web workload gate | `scripts/verify-eks-web-workloads.sh`, `scripts/run-eks-day15-backend-rollout-smoke.sh` and receipt/context-gated deploy/destroy scripts | `manual` | render zero resources by default; require immutable frontend/backend digests, two replicas, explicit resources, runtime ConfigMap/Secret, General placement and B runtime-boundary approval; final same-digest rollout requires the formal receipt/full SHA and exact preserved EC2 status, keeps every sampled external health request successful, and restores two Ready zero-restart Pods with the same imageID, exact single-target ALB routing, steady Secret/RDS health and zero EKS worker/maintenance processes | Pair A/B | dev rollout evidence predates the strengthened receipt/exact-EC2 gate and remains historical until private inputs are supplied for rerun. Backend S3 boundary passed; Spark/Trino runtime verification is later scope. Deploy workloads before Ingress; destroy Ingress before Services. |
| EKS Spark Operator install gate | `scripts/verify-eks-spark-operator.sh`, `scripts/verify-eks-spark-rbac.sh` and confirmation-gated deploy/destroy scripts | `manual` | verify official chart archive SHA-256 before local render/install; pin image digests; watch only `asklake-dev`; require admission fixture server dry-run and explicit RBAC allow/deny matrix without creating a workload; uninstall preserves CRDs unless a separate ownership-and-empty confirmation is supplied | Pair A | dev 2.5.1 revision 3 is deployed. Representative Spark physical read passed and the full deletecollection/PVC cleanup allow/deny matrix passed actual API authorization. All three workload kinds must be globally empty before uninstall or CRD deletion. [Evidence](eks-day15-spark-operator-evidence.md). |
| EKS 15.5 bounded S3 Parquet physical read | `scripts/run-eks-catalog-physical-read-smoke.sh`, `scripts/test-eks-catalog-physical-read-smoke.sh` and private Git-ignored inputs | `static ready / live rerun pending` | use canonical `ASKLAKE_IMAGE_RECEIPT`; reject tracked input, non-AMD64/mutable receipt, unsafe URI/namespace/region/time bounds, object outside root, failed CRD/operator/capacity/Pod Identity preflight or server dry-run, malformed result, private marker, fail-open cleanup/audit, and label/exact-prefix residue; never print URI or rows | Pair A/B | Earlier operator-selected representative live read remains evidence. The reusable runner proves only a bounded exact S3 Parquet object read, not Catalog provenance. Its strengthened static/fake scenarios passed; no new live run was performed. [Receipt](eks-day15-data-copy-receipt.md). |
| EKS Day 14 Metrics/scale gate | Terraform checks, `scripts/verify-eks-metrics-scale.sh`, confirmation-gated scale runner | `manual` | keep add-on and smoke workload disabled until exact compatible version, owner, Metrics API, immutable backend image, General placement and explicit resource values are reviewed | Pair A | community add-on has no workload IAM policy. Kubelet `10250`, `kubectl top`, node scale-out, cleanup and later scale-in need runtime evidence; test fixture sizing is not a recommendation. |
| EKS runtime Secret delivery gate | canonical JSON, Terraform checks, Helm render and runtime/combined verifiers | `manual` | reject Secret/env/file/shared-binding drift, incomplete delivery metadata and Phase 5/8 selection mismatch; scope ESO to `asklake-dev`; allow its Pod Identity only three read actions on `asklake/dev/*`; keep full-service contract closed while Airflow/AI decisions are unresolved | Pair A/B | Secret values never enter Git/Terraform/output. Static AWS keys, cluster-wide store/PushSecret and application SA Secret read RBAC are forbidden. Backend runtime Secret injection은 web 배포에서 검증했고 Airflow/Spark/Trino mapping은 후속 gate다. |
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
| Live AWS integration CI | RDS/MSK/S3/EKS/IRSA fixture를 일반 PR에 제공하지 않는다. |

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
| Backend deploy image build | yes on matching PR paths | `backend/Dockerfile`, `backend/requirements.txt` | backend Docker image builds for `linux/amd64` with production Python base image |
| EKS foundation contract | no, local/manual until CI exists | `infra/eks/terraform`, `infra/eks/helm`, Phase 1/10 handoff | `scripts/verify-eks-foundation.sh` passes EKS Auto Mode capability/IAM/access-entry and fail-closed existing-cluster mock tests, rejects legacy Managed Node Group resources, and passes Helm/RBAC/Replay/Trino/runtime-boundary/credential checks without AWS mutation |
| EKS Phase 11 network foundation | no, local/manual until actual environment apply | external/create VPC ownership, paired public/private subnets, NAT/endpoints, EKS/MSK/RDS placement and service SGs | Terraform tests cover single/per-AZ NAT, endpoint-only minimums, deterministic subnet derivation, external public subnet handoff, exact MSK/RDS ports and failure gates without AWS mutation |
| EKS Phase 12 Auto Mode NodePools | no, local/manual until actual environment apply | dedicated custom node IAM/access entry, two NodeClasses/NodePools and workload placement | disabled render is empty; enabled render requires explicit capacity/cost/disruption selectors, isolates Spark with a `NoSchedule` taint and passes Terraform ownership failure tests without AWS mutation |
| EKS delivery handoff | no, local/manual until CI exists | `infra/eks/delivery`, Phase 5 deployment input | planning contract passes locally and deploy-time `--ready` fails closed until five immutable ECR digests, AWS references and required decisions are present |
| EKS image delivery | manual workflow only | five ECR repositories and image receipt | OIDC-authenticated workflow publishes one AMD64 digest per component and uploads a validated 30-day receipt; no automatic trigger or repository creation |
| EKS Auto Mode ALB ingress | runtime applied | Phase 13 handoff, IngressClassParams/Class, two Ingress rules and external runtime verifier | dev class/params and two Ingress share one active internet-facing IPv4 ALB across 2 AZs; `/`, `/api/health`, group별 healthy Pod target와 RDS health가 통과했고 hostname/ARN은 Git에 저장하지 않는다 |
| EKS Phase 14 web workloads | no, local/manual until actual environment apply | Frontend/FastAPI Helm chart, Phase 6 receipt and Phase 5/8 references | default renders nothing; enabled fixture renders two digest-pinned Deployments and matching ClusterIP Services; unsafe readiness, replica, image and port overrides fail |
| EKS Spark Operator | dev foundation and representative read applied; full application pending | verified Kubeflow 2.5.1 chart checksum/image digests, owned `v1beta2` CRDs, controller/webhook and namespace-scoped admission | revision 3 controller/webhook Ready, CRD Established, repo fixture server dry-run, representative Parquet read and cleanup pass; all three workload kinds remain zero while Kafka→Iceberg E2E is pending; General node cost continues while operator runs |
| EKS Day 14 Metrics/scale | no, local/manual until actual environment apply | `metrics-server` EKS add-on contract and temporary scale-smoke chart | disabled defaults create nothing; exact version/owner and three readiness gates are mandatory; Terraform mock tests and Helm negative cases pass before cost-bearing runtime smoke |
| EKS runtime Secret contract | no, manual environment apply | `infra/eks/secrets`, scoped ESO Helm values, Terraform Phase 8 Pod Identity handoff and combined Phase 5/8 verifier | exact Secret names/keys, env injection, shared bindings and read-only mounts pass contract scenarios; dev Backend runtime Secret is synced while Airflow/Spark/Trino mappings remain gated; default examples remain planning-only |
| Deploy dependency verification | manual | deploy Compose/env, health JSON readiness, Spark REST create/status contract, backend/frontend/Spark/Trino images, Airflow DAG import | `tests/deploy/deploy-scripts-regression.sh`, `backend/scripts/verify-production-spark-contract.mjs`, and `scripts/verify-deploy-dependencies.sh` pass before deploy |
| Trino contract verification | matching backend/frontend paths | Query Run, registration, result storage, collector fencing, actor reservation, timeline state | `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`, `test:trino-timeline` pass |
| Trino production readiness | deploy-time when `TRINO_ENABLED=true` | TLS/auth, read-only query identity, materializer CTAS/describe/drop, AWS S3 Warehouse/Query Result bucket round trip through EC2 instance profile | `verify:trino-production-readiness` passes after Compose health |
| AWS S3 startup readiness | every production Compose startup | Raw bucket list, Output bucket put/head/delete with EC2 instance role | `aws-s3-readiness` completes before backend starts; bucket auto-create and static AWS keys are forbidden |
| AWS S3 output identity | frontend build and every Spark run/Catalog publish | Target UI bucket, Spark writer bucket, Catalog storage location | production frontend receives `ASKLAKE_SPARK_OUTPUT_BUCKET`; only legacy `asklake-output` roots are normalized and explicit custom buckets remain unchanged |
| EKS application workload | yes on matching PR paths | Frontend/FastAPI/Airflow/Trino Helm schema, digest image, ClusterIP, probe, ConfigMap/Secret refs, foundation-owned RBAC dependency, Kubernetes Spark recovery, MSK IAM, EC2-owned Continuous boundary | `scripts/verify-eks-workloads.sh`, Node provider tests, focused FastAPI tests and four B-owned AMD64 image builds pass; chart contains no Role/RoleBinding, Secret, static AWS key, replay producer, LoadBalancer, StatefulSet, PVC/EFS, or mutable image tag |
| Production legacy demo restart | focused auth tests + deploy preflight | backend startup account/session state and frontend login hint | default production disables/revokes legacy demo identities; matching opt-in flags preserve existing status/session without reactivating an explicitly disabled account |
| PR event checks | partial | frontend and EKS B matching paths | configured deterministic checks pass; repository admin separately decides whether each check is required |
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
