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
| Secret scanning / push protection | GitHub repository setting | `unknown` | block or warn on secret push | repo admin | repository admin 확인 필요 |
| Protected integration branches | GitHub repository ruleset on `main`, `dev`, and `pair` | `enabled` | block direct push or force push; require changes through PR | repo admin | ruleset: `Push 금지` |
| PR source branch policy | GitHub Actions check required by ruleset on `main` and `dev` | `enabled` | block PR merge when source branch does not match the allowed chain or linked issue target | repo admin | `main <- dev`; `dev <- pair1/2/3` 또는 지원 work/`<type>-#<issue>` 브랜치 + linked issue `Target Branch: dev` |
| PR merge / Issue lifecycle sync | `.github/workflows/notion-issue-sync.yml` and lifecycle smoke checks | `enabled` | fail before remote mutation when lifecycle contracts break; recover missed merge events on the next scheduled/manual dispatch | maintainer | explicit `Closes/Fixes/Resolves #N` merge closes Issue and sets Project/Notion `Done`; reopen after merge is preserved |
| Default PR and issue templates | GitHub `.github` templates | `enabled` | prompt contributors to document scope, verification, impact, and acceptance criteria | maintainer | advisory template, not a hard gate |
| Deployment env files ignored | `.gitignore`, review checklist | `enabled` | prevent committing server `.env` and local EC2 env values | maintainer | `deploy/.env` and `deploy/ec2.env` are ignored; only examples are committed. MinIO access key/secret and `AIRFLOW_EXECUTION_API_TOKEN` stay in server `.env` or secret storage. The Airflow and backend token values must match. Kafka replay input은 `ASKLAKE_REPLAY_HOST_INPUT_DIR`의 읽기 전용 mount만 사용하며 arbitrary host path API 입력은 금지한다. |
| Production legacy demo auth | backend startup + `scripts/verify-deploy-env.sh` | `enabled` | legacy demo users are disabled by default; an explicit demo deployment must set matching backend/frontend opt-in flags | maintainer | `AUTH_LEGACY_DEMO_USERS_ENABLED`와 `VITE_AUTH_LEGACY_DEMO_USERS_ENABLED`가 모두 `true`일 때만 재시작 시 기존 status/session을 보존한다. Bootstrap admin과 production header-auth 차단은 유지한다. |
| API contract drift check | repo-local script or review checklist | `planned` | warn or block when API docs and code drift | maintainer | backend 구현 후 후보 |
| Realtime feature rollback | `DASHBOARD_SYNC_MODE`, `REALTIME_EVENTS_ENABLED`, `CONTINUOUS_SQL_JOIN_ENABLED` plus config contract tests | `partial` | invalid/disabled 조합은 polling과 기존 runtime으로 fail closed; rollout 중 오류 시 env 변경 후 재배포 | maintainer | SSE와 Continuous SQL 구현 전 기본값은 polling/false이며 advanced static mode도 기본 false |

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
| Deploy dependency verification | manual | deploy Compose/env, health JSON readiness, Spark REST create/status contract, backend/frontend/Spark/Trino images, Airflow DAG import | `tests/deploy/deploy-scripts-regression.sh`, `backend/scripts/verify-production-spark-contract.mjs`, and `scripts/verify-deploy-dependencies.sh` pass before deploy |
| Trino contract verification | matching backend/frontend paths | Query Run, registration, result storage, collector fencing, actor reservation, timeline state | `verify:trino-query-foundation`, `verify:query-engine-registration`, `verify:trino-result-storage`, `verify:trino-collector-resilience`, `verify:trino-submission-guard`, `test:trino-timeline` pass |
| Trino production readiness | deploy-time when `TRINO_ENABLED=true` | TLS/auth, read-only query identity, materializer CTAS/describe/drop, AWS S3 Warehouse/Query Result bucket round trip through EC2 instance profile | `verify:trino-production-readiness` passes after Compose health |
| AWS S3 startup readiness | every production Compose startup | Raw bucket list, Output bucket put/head/delete with EC2 instance role | `aws-s3-readiness` completes before backend starts; bucket auto-create and static AWS keys are forbidden |
| AWS S3 output identity | frontend build, Target browser API, and every Spark run/Catalog publish | Target UI bucket, `GET /api/s3/buckets` first item, Spark writer bucket, Catalog storage location | production frontend and backend receive the same `ASKLAKE_SPARK_OUTPUT_BUCKET`; AWS mode forbids a silent local `asklake-output` fallback; only legacy `asklake-output` roots are normalized and explicit custom buckets remain unchanged |
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
