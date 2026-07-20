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
| `npm run verify:ui-regressions` failed | 주요 workspace의 compact header, SQL action/탭의 텍스트 label, SQL section marker·좌우 panel 화살표, editor 불변 높이·Nessie Popover/Bubble/Collapsible·Dashboard WidgetConfigPanel 재사용·차트/데이터/실행 정보 전환·Trino timeline/cursor pagination/server CSV·Job wizard, Source/Catalog 밀도, Catalog PROCESS projection, Dashboard panel toggle, Dashboard 목록, ApexCharts 위젯의 최근 회귀 방지 계약을 확인하고 관련 파일을 수정한다. |
| `npm run build` failed | TypeScript error와 Vite build output을 확인하고 관련 파일을 수정한다. |
| Live API mode failed | Browser Network에서 상대 `/api` 요청인지 확인한 뒤 Vite의 `VITE_DEV_PROXY_TARGET` 또는 container Nginx의 `backend:8080` 해석, `/api/realtime/events`의 SSE buffering 비활성화, backend 상태, `docs/api-contract.md` response shape를 확인한다. 로컬 HTTP 로그인은 proxy에서 Secure cookie를 제거하지 말고 local backend의 `AUTH_SESSION_COOKIE_SECURE=false`만 사용한다. |
| Prod compose config failed | `deploy/.env.example`의 필수 env key, `deploy/docker-compose.prod.yml`, Dockerfile path를 확인한다. |
| Deploy readiness failed | GitHub Actions artifact의 JSON record와 실패한 `compose_config`, `backend_image`, `backend_dependencies`, `backend_python_dependencies`, `backend_runtime_contract`, `frontend_image` step을 확인한다. 로컬 재현은 `bash scripts/verify-deploy-readiness.sh`로 한다. |
| API contract mismatch | `docs/03-api-reference.md`, `docs/api-contract.md`, frontend types/API adapter를 함께 맞춘다. |
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

- 신규 Kafka Continuous Job의 `runtimeEngine`은 `spark_structured_streaming`만 허용한다.
- EKS realtime worker는 `CONTINUOUS_WORKER_SCOPE=all`이며 Kafka와 Continuous SQL control
  plane을 하나의 owner claim으로 소유한다.
- 동일 broker/topic/group/generation/checkpoint identity의 active owner는 정확히 하나다.
- owner fence, 승인, 새 generation, MSK IAM, S3 runtime document/checkpoint가 하나라도
  없으면 workload 활성화를 거부한다.
- rollback은 새 generation과 보존된 checkpoint를 사용하며 checkpoint 삭제·rewind,
  dual-run, 다른 엔진으로 자동 전환을 금지한다.

# EKS Spark Resource Planner promotion guardrail

- 기본 mode는 `off`이며 입력 metadata 부재, unsupported executor profile,
  Plan hash 또는 runtime ConfigMap revision drift에서는 baseline executor를 유지한다.
- V1은 `standard-v1` profile에서 executor 수만 `1`, `2`, `4` 중 선택한다.
- private runtime 후보는 Planner 관련 key만, Web 후보는
  `backend.runtimeConfigRevision`만 변경해야 한다.
- 10/100GB `shadow` evidence와 `off/1` 복구가 검증되기 전에는 `enforce`로
  승격하지 않는다.
- image rollout, runtime/Web Helm mutation과 비용 발생 Spark Run은 각각 별도
  승인을 요구한다.
