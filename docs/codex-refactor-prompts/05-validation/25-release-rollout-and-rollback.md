# 25 — Production Rollout·관찰·Rollback Codex 프롬프트

## 목표

리팩토링 release를 한 번에 덮어쓰지 않고, DB/API/runtime/frontend 순서를 지키며 관찰 가능한 단계로 배포하고 되돌릴 수 있는 실행 runbook을 만든다.

## Codex에 전달할 프롬프트

최종 감사에서 Go 판정이 난 경우에만 이 단계를 수행하라. 현재 세션에서 production deploy 권한이 명시되지 않으면 배포는 실행하지 말고 검증 가능한 runbook과 script만 작성한다.

### 수행 작업

1. release 범위를 commit/PR/migration/feature flag 단위로 고정한다.
2. backup과 복구 지점을 정의한다.
   - metadata DB
   - checkpoint/report/manifest
   - Compose/env/config
   - frontend/backend image tag
3. expand migration → backward-compatible backend → runtime worker → frontend → flag rollout → contract cleanup 순서를 작성한다.
4. old/new backend 또는 worker가 동시에 존재할 수 있는 기간의 호환성을 명시한다.
5. canary 대상과 관찰 window를 정한다.
6. 최소 관찰 지표를 gate로 사용한다.
   - command failure/duplicate
   - reconcile unknown/stale
   - report missing/storage unwritable
   - Spark failure
   - materialization/Catalog/Dashboard failure
   - fallback usage
   - frontend error/stale poll
7. clean reboot smoke를 production cutover checklist에 포함한다.
8. rollback trigger와 최대 판단 시간을 정한다.
9. rollback 시 DB/data contract가 old code에 호환되는지 검증 명령을 포함한다.
10. feature flag와 compatibility adapter의 제거 release를 별도로 계획한다.
11. `docs/04-development-guide.md`, `docs/system-guardrails.md`, 운영 runbook을 갱신한다.

### 필수 산출물

- pre-deploy checklist
- deploy 순서와 명령 template
- smoke test
- metric/log query
- rollback decision table
- rollback 명령 template
- post-deploy verification
- 24h/72h follow-up checklist
- flag/adapter cleanup issue 목록

### 완료 기준

- production에서 수동 DB 편집이나 수동 chown이 필요 없다.
- 각 단계가 중단·재개·rollback 가능하다.
- reboot 복구가 release gate에 있다.
- rollback이 data contract를 깨지 않는 증거가 있다.
- 관찰 없이 “배포 성공”으로 종료하지 않는다.
