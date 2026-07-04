# System Guardrails

This document tracks repository, CI, platform, and workflow guardrails.

## 1. Guardrail Inventory

| Guardrail | Enforced By | Current Status | Failure Behavior | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| Protected default branch | GitHub ruleset on `main` | enabled | Direct push and force push are blocked | repo admin | Use PRs |
| PR and issue templates | GitHub templates | enabled | Contributors are prompted for scope and verification | maintainer | Advisory |
| Frontend build check | Local now, CI candidate | planned | Build failure should block merge after CI exists | maintainer | `cd frontend && npm run build` |
| Backend verification check | Local now, CI candidate | planned | Endpoint/source regressions should block merge after CI exists | maintainer | `cd backend && npm run verify` |
| Secret scanning | GitHub repository setting | unknown | Block or warn on secret push | repo admin | Needs admin confirmation |
| API contract drift check | Review checklist or script | planned | Warn or block when docs and code drift | maintainer | Candidate follow-up |

## 2. Required Local Checks By Change Type

| Change | Required check |
| --- | --- |
| Frontend TypeScript/UI | `cd frontend && npm run build` |
| Backend endpoint | `cd backend && npm run verify` |
| Source connector | `cd backend && npm run sources:fixtures && npm run verify:sources` |
| Kafka connector | `ASKLAKE_VERIFY_KAFKA=true npm run verify:sources` |
| MinIO/Spark harness | `npm run minio:prepare-samples && npm run spark:start && npm run spark:validate` |
| API contract | Update `docs/03-api-reference.md` and `docs/api-contract.md` |

## 3. Common Failure And Fix

| Failure | How to fix |
| --- | --- |
| Frontend build failed | Read TypeScript/Vite output and fix the exact file |
| Backend health failed | Check `PORT`, backend process, and route handler |
| Source test failed | Check fixture containers, MinIO credentials, connector config, and error envelope |
| Kafka verification warning | Confirm Redpanda container is healthy and topic exists |
| Spark validation failed | Re-run `minio:prepare-samples`, recreate Spark containers, inspect Spark output |
| API contract mismatch | Update types, backend response, and docs together |

## 4. PR Readiness

- Branch is not `main`.
- Issue is linked.
- Scope is clear.
- Verification commands are included.
- Known limitations are listed.
- No secrets or real credentials are committed.

## 5. Follow-Up Candidates

- Add CI for frontend build and backend verification.
- Add API contract drift check.
- Add durable metadata persistence.
- Add Data Lake physical schema endpoint.
- Add Kafka payload sampling.
